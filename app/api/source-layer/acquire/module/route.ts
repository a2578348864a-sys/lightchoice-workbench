import { NextRequest, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import {
  captureV3ModuleEvidence,
  readV3ModuleEvidence,
  V3_ACQUISITION_MODES,
  V3_METRIC_NATURES,
  V3_MODULE_IDS,
  V3_MODULE_STATUSES,
  type V3ModuleId,
} from "@/lib/sourceLayer/v3ModuleEvidence";
import {
  isSellerSpriteScoped,
  SELLERSPRITE_PROVIDER_NAME,
  sellerSpriteProviderContractViolation,
} from "@/lib/sourceLayer/v3ModuleRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && isSameOriginRequest(new URL(referer).origin, request)
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  const subjectKey = request.nextUrl.searchParams.get("subjectKey")?.trim() ?? "";
  const moduleValue = request.nextUrl.searchParams.get("module");
  const moduleId = moduleValue === null || moduleValue === ""
    ? undefined
    : V3_MODULE_IDS.includes(moduleValue as V3ModuleId) ? moduleValue as V3ModuleId : null;
  if (!subjectKey) return errorResponse(400, "subject_key_required", "subjectKey 必填。");
  if (moduleId === null) return errorResponse(400, "module_invalid", "V3 模块标识无效。");
  try {
    const result = await readV3ModuleEvidence({ context: auth.context, subjectKey, module: moduleId });
    return NextResponse.json({
      ok: true,
      data: {
        subjectKey: result.subjectKey,
        modules: result.modules,
        attachmentCount: result.evidenceStore?.attachments?.length ?? 0,
        rawArtifactCount: result.evidenceStore?.rawArtifacts?.length ?? 0,
        downstream: { readable: true, evidenceOnly: result.modules.every((item) => item.evidenceOnly) },
      },
    });
  } catch (error) {
    return errorResponse(400, "v3_module_read_failed", error instanceof Error ? error.message : "V3 Evidence 读取失败。");
  }
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (!isRecord(body)) return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");
  const moduleId = body.module;
  const sourceType = body.sourceType;
  const acquisitionMode = body.acquisitionMode;
  const metricNature = body.metricNature;
  const status = body.status;
  if (!V3_MODULE_IDS.includes(moduleId as V3ModuleId)) return errorResponse(400, "module_invalid", "V3 模块标识无效。");
  if (!SOURCE_TYPES.includes(sourceType as CaptureSourceType)) return errorResponse(400, "source_type_invalid", "来源类型无效。");
  if (!["amazon_dom", "sellersprite_plugin", "sellersprite_xlsx", "keepa_export", "manual_entry"].includes(String(sourceType))) {
    return errorResponse(422, "source_type_not_allowed", "该来源类型不在 V3 合法采集范围内。");
  }
  if (!V3_ACQUISITION_MODES.includes(acquisitionMode as (typeof V3_ACQUISITION_MODES)[number])) {
    return errorResponse(400, "acquisition_mode_invalid", "采集方式无效。");
  }
  if (!V3_METRIC_NATURES.includes(metricNature as (typeof V3_METRIC_NATURES)[number])) {
    return errorResponse(400, "metric_nature_invalid", "指标来源性质无效。");
  }
  if (!V3_MODULE_STATUSES.includes(status as (typeof V3_MODULE_STATUSES)[number])) {
    return errorResponse(400, "module_status_invalid", "模块状态无效。");
  }
  if (typeof body.subjectKey !== "string" || !body.subjectKey.trim()) {
    return errorResponse(400, "subject_key_required", "subjectKey 必填。");
  }
  if (!isRecord(body.identity) || !isRecord(body.data)) {
    return errorResponse(400, "module_payload_invalid", "identity 与 data 必须是 JSON object。");
  }
  /**
   * provider 写入契约（fail-closed，先于任何写入）：
   * SellerSprite 来源/模块的 provider 必须复用规范常量 `SellerSprite`；
   * 缺失、空串或错误拼写（历史事故：`SellerSphere`）一律 422 拒绝，不落库。
   */
  const submittedProvider = optionalText(body.provider);
  const sellerSpriteScoped = isSellerSpriteScoped({ module: String(moduleId), sourceType: String(sourceType) });
  const providerViolation = sellerSpriteProviderContractViolation({
    module: String(moduleId),
    sourceType: String(sourceType),
    provider: submittedProvider,
  });
  if (providerViolation) {
    return errorResponse(
      422,
      providerViolation,
      `SellerSprite 来源或模块的 provider 必须为 "${SELLERSPRITE_PROVIDER_NAME}"；当前提交值不符合该模块契约，已拒绝写入（未产生任何证据文件）。`,
    );
  }
  // SellerSprite 证据统一落规范名，消除大小写/空白变体；其他来源保持提交值或既有回退。
  const provider = sellerSpriteScoped ? SELLERSPRITE_PROVIDER_NAME : (submittedProvider ?? "unknown-provider");
  const limitations = Array.isArray(body.limitations)
    ? body.limitations.filter((value): value is string => typeof value === "string")
    : [];
  try {
    const result = await captureV3ModuleEvidence({
      context: auth.context,
      sourceType: sourceType as CaptureSourceType,
      sourceFingerprint: optionalText(body.sourceFingerprint),
      moduleEvidence: {
        module: moduleId as V3ModuleId,
        subjectKey: body.subjectKey,
        marketplace: optionalText(body.marketplace) ?? "US",
        capturedAt: optionalText(body.capturedAt) ?? new Date().toISOString(),
        provider: provider ?? "unknown-provider",
        sourceSurface: optionalText(body.sourceSurface) ?? "unknown-visible-surface",
        sourceUrl: optionalText(body.sourceUrl),
        providerUpdatedAt: optionalText(body.providerUpdatedAt),
        freshnessMetricKey: optionalText(body.freshnessMetricKey),
        freshnessNow: optionalText(body.freshnessNow) ?? undefined,
        acquisitionMode: acquisitionMode as (typeof V3_ACQUISITION_MODES)[number],
        metricNature: metricNature as (typeof V3_METRIC_NATURES)[number],
        status: status as (typeof V3_MODULE_STATUSES)[number],
        limitations,
        identity: body.identity,
        data: body.data,
        evidenceOnly: body.evidenceOnly !== false,
      },
    });
    return NextResponse.json({
      ok: true,
      data: {
        module: result.moduleEvidence.module,
        status: result.moduleEvidence.status,
        limitations: result.moduleEvidence.limitations,
        acquisitionMode: result.moduleEvidence.acquisitionMode,
        metricNature: result.moduleEvidence.metricNature,
        attachment: result.attachment,
        rawArtifact: result.rawArtifact.artifact,
        downstream: result.downstream,
        evidenceStore: {
          subjectKey: result.evidenceStore.subjectKey,
          versions: result.evidenceStore.versions.map((item) => item.version),
          attachments: result.evidenceStore.attachments?.length ?? 0,
          rawArtifacts: result.evidenceStore.rawArtifacts?.length ?? 0,
        },
      },
    }, { status: result.gateway?.created ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "V3 模块证据未能进入 EvidenceStore。";
    const statusCode = message.includes("EVIDENCE_STORE") || message.includes("evidence_subject") ? 422 : 400;
    return errorResponse(statusCode, "v3_module_capture_failed", message);
  }
}
