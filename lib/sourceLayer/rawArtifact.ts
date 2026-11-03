import { createHash } from "node:crypto";
import { extname } from "node:path";

import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";

/**
 * V3 原始下载/导出文件契约。
 *
 * 原文件与 CapturePackage 一样属于 EvidenceStore 的证据，不是第二事实库：
 * 解析器可以从它投影结构化 Evidence，但任何下游都必须保留这个 hash/ref。
 */
export const SOURCE_RAW_ARTIFACT_SCHEMA = "source-raw-artifact.v1" as const;
export const RAW_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

export const RAW_ARTIFACT_KINDS = [
  "workbook",
  "market_export",
  "keyword_export",
  "reverse_asin_export",
  "variation_export",
  "review_export",
  "timeseries_export",
  "other",
] as const;
export type RawArtifactKind = (typeof RAW_ARTIFACT_KINDS)[number];

export const RAW_ARTIFACT_ACQUISITION_MODES = [
  "browser_download",
  "file_upload",
  "manual_export",
  "browser_dom",
  "api_response",
  "dom_direct",
  "extension_rendered",
  "page_network_observed",
  "visible_chart",
  "screenshot_evidence",
  "user_assisted_session",
  "local_file_replay",
] as const;
export type RawArtifactAcquisitionMode = (typeof RAW_ARTIFACT_ACQUISITION_MODES)[number];

export const RAW_ARTIFACT_FORMATS = ["xlsx", "xls", "csv", "tsv", "json", "zip", "txt", "png"] as const;
export type RawArtifactFormat = (typeof RAW_ARTIFACT_FORMATS)[number];

export type RawArtifactProvenance = {
  provider: string;
  sourceSurface: string;
  sourceUrl: string | null;
  sourceRecordRef: string | null;
  providerUpdatedAt: string | null;
  acquisitionMode: RawArtifactAcquisitionMode;
  parserVersion: string;
};

export type SourceRawArtifact = {
  schemaVersion: typeof SOURCE_RAW_ARTIFACT_SCHEMA;
  artifactId: string;
  subjectKey: string;
  sourceType: CaptureSourceType;
  kind: RawArtifactKind;
  capturedAt: string;
  fileName: string;
  contentType: string | null;
  format: RawArtifactFormat;
  byteLength: number;
  sha256: string;
  /** 同一 subject 目录内的确定性文件名，不接受调用方提供路径。 */
  storageFileName: string;
  provenance: RawArtifactProvenance;
};

export type RawArtifactInspection = {
  fileName: string;
  contentType: string | null;
  format: RawArtifactFormat;
  byteLength: number;
  sha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, maxLength: number, required = false): string | null {
  if (typeof value !== "string") {
    if (required) throw new Error(`RAW_ARTIFACT_${field.toUpperCase()}_REQUIRED`);
    return null;
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    if (required) throw new Error(`RAW_ARTIFACT_${field.toUpperCase()}_REQUIRED`);
    return null;
  }
  if (normalized.length > maxLength) throw new Error(`RAW_ARTIFACT_${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function assertTimestamp(value: unknown, field: string, required = true): string | null {
  const timestamp = boundedText(value, field, 64, required);
  if (timestamp === null) return null;
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`RAW_ARTIFACT_${field.toUpperCase()}_INVALID`);
  return timestamp;
}

function isZipHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function isOleCompoundHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0
    && bytes[4] === 0xa1
    && bytes[5] === 0xb1
    && bytes[6] === 0x1a
    && bytes[7] === 0xe1;
}

function isPngHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function formatOfFileName(fileName: string): RawArtifactFormat {
  const extension = extname(fileName).toLowerCase();
  const format = extension.slice(1);
  if (!RAW_ARTIFACT_FORMATS.includes(format as RawArtifactFormat)) {
    throw new Error("RAW_ARTIFACT_EXTENSION_UNSUPPORTED");
  }
  return format as RawArtifactFormat;
}

function assertFileName(fileName: unknown): string {
  const normalized = boundedText(fileName, "filename", 180, true) as string;
  if (normalized.includes("\0") || normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    throw new Error("RAW_ARTIFACT_FILENAME_INVALID");
  }
  return normalized;
}

export function sha256OfRawArtifact(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 只做确定性的容器/编码预检；完整的 SellerSprite/Keepa/Review 语义校验仍由对应 parser 完成。
 * 预检失败时不允许把原文件伪装成已采集证据。
 */
export function inspectRawArtifact(input: {
  fileName: string;
  bytes: Uint8Array;
  contentType?: string | null;
}): RawArtifactInspection {
  const fileName = assertFileName(input.fileName);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new Error("RAW_ARTIFACT_EMPTY");
  }
  if (input.bytes.byteLength > RAW_ARTIFACT_MAX_BYTES) {
    throw new Error("RAW_ARTIFACT_OVERSIZED");
  }
  const format = formatOfFileName(fileName);
  const validContainer = format === "xlsx" || format === "zip"
    ? isZipHeader(input.bytes)
    : format === "xls"
      ? isOleCompoundHeader(input.bytes)
      : format === "png"
        ? isPngHeader(input.bytes)
      : isUtf8(input.bytes);
  if (!validContainer) throw new Error("RAW_ARTIFACT_MALFORMED");
  return {
    fileName,
    contentType: boundedText(input.contentType, "content_type", 160),
    format,
    byteLength: input.bytes.byteLength,
    sha256: sha256OfRawArtifact(input.bytes),
  };
}

export function rawArtifactIdFor(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("RAW_ARTIFACT_HASH_INVALID");
  return `raw-${sha256.slice(0, 24)}`;
}

export function rawArtifactStorageFileNameFor(sha256: string, format: RawArtifactFormat): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("RAW_ARTIFACT_HASH_INVALID");
  if (!RAW_ARTIFACT_FORMATS.includes(format)) throw new Error("RAW_ARTIFACT_FORMAT_INVALID");
  return `r-${sha256}.${format}`;
}

export function rawArtifactMetadataFileNameFor(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("RAW_ARTIFACT_HASH_INVALID");
  // JSON 原件本体已经使用 r-<sha>.json；元数据必须使用独立文件名，
  // 否则 appendRawArtifact 的第二次写入会覆盖原件本体。
  return `r-${sha256}.meta.json`;
}

export function buildSourceRawArtifact(input: {
  subjectKey: string;
  sourceType: CaptureSourceType;
  kind: RawArtifactKind;
  capturedAt: string;
  fileName: string;
  contentType?: string | null;
  bytes: Uint8Array;
  provenance: RawArtifactProvenance;
}): SourceRawArtifact {
  if (!input.subjectKey.trim()) throw new Error("RAW_ARTIFACT_SUBJECT_REQUIRED");
  if (!SOURCE_TYPES.includes(input.sourceType)) throw new Error("RAW_ARTIFACT_SOURCE_TYPE_INVALID");
  if (!RAW_ARTIFACT_KINDS.includes(input.kind)) throw new Error("RAW_ARTIFACT_KIND_INVALID");
  const capturedAt = assertTimestamp(input.capturedAt, "captured_at") as string;
  const inspection = inspectRawArtifact({
    fileName: input.fileName,
    bytes: input.bytes,
    contentType: input.contentType,
  });
  const provenance = input.provenance;
  const provider = boundedText(provenance?.provider, "provider", 120, true) as string;
  const sourceSurface = boundedText(provenance?.sourceSurface, "source_surface", 160, true) as string;
  const sourceUrl = boundedText(provenance?.sourceUrl, "source_url", 2048);
  if (sourceUrl !== null) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "https:") throw new Error("not_https");
    } catch {
      throw new Error("RAW_ARTIFACT_SOURCE_URL_INVALID");
    }
  }
  const sourceRecordRef = boundedText(provenance?.sourceRecordRef, "source_record_ref", 240);
  const providerUpdatedAt = assertTimestamp(provenance?.providerUpdatedAt, "provider_updated_at", false);
  if (!RAW_ARTIFACT_ACQUISITION_MODES.includes(provenance?.acquisitionMode)) {
    throw new Error("RAW_ARTIFACT_ACQUISITION_MODE_INVALID");
  }
  const parserVersion = boundedText(provenance?.parserVersion, "parser_version", 120, true) as string;
  return {
    schemaVersion: SOURCE_RAW_ARTIFACT_SCHEMA,
    artifactId: rawArtifactIdFor(inspection.sha256),
    subjectKey: input.subjectKey.trim(),
    sourceType: input.sourceType,
    kind: input.kind,
    capturedAt,
    fileName: inspection.fileName,
    contentType: inspection.contentType,
    format: inspection.format,
    byteLength: inspection.byteLength,
    sha256: inspection.sha256,
    storageFileName: rawArtifactStorageFileNameFor(inspection.sha256, inspection.format),
    provenance: {
      provider,
      sourceSurface,
      sourceUrl,
      sourceRecordRef,
      providerUpdatedAt,
      acquisitionMode: provenance.acquisitionMode,
      parserVersion,
    },
  };
}

export function parseSourceRawArtifact(value: unknown): SourceRawArtifact | null {
  if (!isRecord(value)
    || value.schemaVersion !== SOURCE_RAW_ARTIFACT_SCHEMA
    || typeof value.artifactId !== "string"
    || !/^raw-[a-f0-9]{24}$/.test(value.artifactId)
    || typeof value.subjectKey !== "string"
    || !value.subjectKey.trim()
    || !SOURCE_TYPES.includes(value.sourceType as CaptureSourceType)
    || !RAW_ARTIFACT_KINDS.includes(value.kind as RawArtifactKind)
    || typeof value.capturedAt !== "string"
    || Number.isNaN(Date.parse(value.capturedAt))
    || typeof value.fileName !== "string"
    || typeof value.contentType !== "string" && value.contentType !== null
    || !RAW_ARTIFACT_FORMATS.includes(value.format as RawArtifactFormat)
    || typeof value.byteLength !== "number"
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || value.byteLength > RAW_ARTIFACT_MAX_BYTES
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || value.artifactId !== rawArtifactIdFor(value.sha256)
    || value.storageFileName !== rawArtifactStorageFileNameFor(value.sha256, value.format as RawArtifactFormat)
    || !isRecord(value.provenance)) return null;
  const provenance = value.provenance;
  if (typeof provenance.provider !== "string"
    || !provenance.provider.trim()
    || typeof provenance.sourceSurface !== "string"
    || !provenance.sourceSurface.trim()
    || (provenance.sourceUrl !== null && typeof provenance.sourceUrl !== "string")
    || (provenance.sourceRecordRef !== null && typeof provenance.sourceRecordRef !== "string")
    || (provenance.providerUpdatedAt !== null && (typeof provenance.providerUpdatedAt !== "string" || Number.isNaN(Date.parse(provenance.providerUpdatedAt))))
    || !RAW_ARTIFACT_ACQUISITION_MODES.includes(provenance.acquisitionMode as RawArtifactAcquisitionMode)
    || typeof provenance.parserVersion !== "string"
    || !provenance.parserVersion.trim()) return null;
  return value as unknown as SourceRawArtifact;
}
