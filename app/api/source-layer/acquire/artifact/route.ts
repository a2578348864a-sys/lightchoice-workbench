import { NextRequest, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  SOURCE_TYPES,
  type CaptureSourceType,
} from "@/lib/sourceLayer/capturePackage";
import {
  RAW_ARTIFACT_ACQUISITION_MODES,
  RAW_ARTIFACT_KINDS,
  RAW_ARTIFACT_MAX_BYTES,
  inspectRawArtifact,
  type RawArtifactAcquisitionMode,
  type RawArtifactKind,
} from "@/lib/sourceLayer/rawArtifact";
import {
  SourceLayerServiceError,
  ingestSourceCapture,
} from "@/lib/sourceLayer/server/sourceLayerService";
import { persistRawArtifact } from "@/lib/sourceLayer/server/rawArtifactIntake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } }, { status });
}

function textField(form: FormData, name: string, fallback = ""): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalTextField(form: FormData, name: string): string | null {
  const value = textField(form, name);
  return value || null;
}

function parseEnum<T extends readonly string[]>(value: string, values: T): T[number] | null {
  return values.includes(value) ? value as T[number] : null;
}

function sourceTypeOf(value: string): CaptureSourceType | null {
  return parseEnum(value, SOURCE_TYPES);
}

function isProductWorkbook(kind: RawArtifactKind, parseProduct: string): boolean {
  return parseProduct === "true" || kind === "workbook" || kind === "market_export";
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  try {
    return referer !== null && isSameOriginRequest(new URL(referer).origin, request);
  } catch {
    return false;
  }
}

/**
 * 统一文件入口：multipart 文件先经过容器预检；SellerSprite 商品/市场 workbook
 * 再进入既有 Adapter → EvidenceStore 链路；原文件始终写入同一个 subject 的
 * EvidenceStore 目录。此 Route 不下载 URL、不提交凭据、不调用付费 Provider。
 */
export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, "invalid_multipart", "请求必须是 multipart/form-data 文件上传。");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(400, "file_required", "缺少来源文件。");
  if (file.size <= 0) return errorResponse(400, "file_empty", "来源文件为空。");
  if (file.size > RAW_ARTIFACT_MAX_BYTES) return errorResponse(413, "raw_artifact_oversized", "来源文件超过 32 MiB 上限。");

  const sourceType = sourceTypeOf(textField(form, "sourceType"));
  const kind = parseEnum(textField(form, "kind", "other"), RAW_ARTIFACT_KINDS) as RawArtifactKind | null;
  const acquisitionMode = parseEnum(textField(form, "acquisitionMode", "file_upload"), RAW_ARTIFACT_ACQUISITION_MODES) as RawArtifactAcquisitionMode | null;
  const subjectKey = optionalTextField(form, "subjectKey");
  const provider = textField(form, "provider");
  const sourceSurface = textField(form, "sourceSurface");
  const parserVersion = textField(form, "parserVersion", "raw-artifact-intake.v1");
  const capturedAt = textField(form, "capturedAt", new Date().toISOString());
  if (!sourceType || !kind || !acquisitionMode || !provider || !sourceSurface || !parserVersion) {
    return errorResponse(400, "artifact_provenance_invalid", "sourceType、kind、provider、sourceSurface、acquisitionMode 和 parserVersion 必填且必须来自允许清单。");
  }
  if (!isProductWorkbook(kind, textField(form, "parseProduct")) && !subjectKey) {
    return errorResponse(400, "subject_key_required", "非商品 workbook 原始文件必须先绑定到一个 Source Layer subjectKey。");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return errorResponse(400, "file_read_failed", "来源文件无法读取。");
  }
  let inspection: ReturnType<typeof inspectRawArtifact>;
  try {
    inspection = inspectRawArtifact({ fileName: file.name, bytes, contentType: file.type || null });
  } catch (error) {
    const code = error instanceof Error ? error.message : "RAW_ARTIFACT_MALFORMED";
    return errorResponse(code === "RAW_ARTIFACT_OVERSIZED" ? 413 : 422, code.toLowerCase(), "来源文件预检失败，未写入 EvidenceStore。", { code });
  }

  const sourceUrl = optionalTextField(form, "sourceUrl");
  const sourceRecordRef = optionalTextField(form, "sourceRecordRef");
  const providerUpdatedAt = optionalTextField(form, "providerUpdatedAt");
  const provenance = {
    provider,
    sourceSurface,
    sourceUrl,
    sourceRecordRef,
    providerUpdatedAt,
    acquisitionMode,
    parserVersion,
  };

  try {
    let capture = null;
    const subjectKeys = new Set<string>(subjectKey ? [subjectKey] : []);
    if (sourceType === "sellersprite_xlsx" && isProductWorkbook(kind, textField(form, "parseProduct"))) {
      capture = await ingestSourceCapture({
        context: auth.context,
        sourceType,
        payload: bytes,
        sourceUrl,
        sourceFingerprint: inspection.sha256,
        subjectKey,
        now: new Date(capturedAt),
      });
      for (const item of capture.items) subjectKeys.add(item.subjectKey);
      if (subjectKeys.size === 0) {
        return errorResponse(422, "no_capturable_records", "workbook 没有通过实体绑定和格式校验的商品记录；原文件未写入。");
      }
    }

    const artifacts = [];
    for (const targetSubjectKey of subjectKeys) {
      const persisted = await persistRawArtifact({
        context: auth.context,
        subjectKey: targetSubjectKey,
        sourceType,
        kind,
        fileName: file.name,
        contentType: file.type || null,
        bytes,
        capturedAt,
        provenance,
      });
      artifacts.push({
        artifact: persisted.artifact,
        created: persisted.created,
        duplicate: persisted.duplicate,
      });
    }
    return NextResponse.json({
      ok: true,
      data: {
        inspection,
        capture,
        artifacts,
        evidenceStore: "canonical-v1",
      },
    }, { status: artifacts.some((item) => item.created) ? 201 : 200 });
  } catch (error) {
    if (error instanceof SourceLayerServiceError) {
      return errorResponse(422, error.code, error.message);
    }
    return errorResponse(409, "raw_artifact_persist_failed", error instanceof Error ? error.message : "来源文件未能进入 EvidenceStore。");
  }
}
