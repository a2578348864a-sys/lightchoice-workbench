/**
 * SellerSprite Preview → Candidate Import contract.
 *
 * Pure server module (no Prisma, no sandbox file I/O). Defines the frozen
 * rowHash format, the single-row candidate source snapshot schema, and the
 * pure validation steps that must all pass BEFORE any Candidate write.
 *
 * No "server-only" guard: the rowHash helper is also used by the upstream
 * SellerSprite Preview parser so both sides hash rows identically.
 */
import { createHash } from "node:crypto";
import {
  sellerSpritePreviewImportSubjectScopeHash,
  verifySellerSpritePreviewImportToken,
  type SellerSpritePreviewImportTokenPayload,
} from "@/lib/server/sellerSpritePreviewImportToken";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";

export const SELLERSPRITE_IMPORT_FIELDS = [
  "file",
  "previewToken",
  "selectedRowHashesJson",
  "confirmed",
  "warningsAccepted",
] as const;

export const SELLERSPRITE_IMPORT_MAX_SELECTED_ROWS = 20;
export const SELLERSPRITE_IMPORT_MAX_TOKEN_UTF8_BYTES = 2048;
export const SELLERSPRITE_IMPORT_ROW_HASH_SCHEMA = "sellersprite_row_hash_v1";
export const SELLERSPRITE_IMPORT_SOURCE_SCHEMA = "sellersprite_candidate_source_v1";
export const SELLERSPRITE_IMPORT_MARKETPLACE = "Amazon US";
export const SELLERSPRITE_IMPORT_MAX_SOURCE_META_UTF8_BYTES = 16 * 1024;

/**
 * SellerSprite Plugin 捕获附加字段（可选，仅插件链路写入）。
 * 面板 22 列中未进入基础字段的插件特有指标 + 来源子类型标记。
 * 该对象整体随 sourceMeta 的 `plugin` 键落库；缺省字段一律为 null。
 */
export type SellerSpritePluginCapture = {
  /** 来源子类型：SellerSprite 浏览器插件（Reverse ASIN / 搜索结果面板）确定性捕获 */
  subtype: "sellersprite_plugin";
  /** 面板捕获时刻（ISO 8601）；XLSX 链路为 null */
  capturedAt: string | null;
  bsr: number | null;
  subCategoryBsr: number | null;
  variationCount: number | null;
  reviewRate: number | null;
  grossMargin: number | null;
  listingDate: string | null;
  sellerCount: number | null;
  fulfillment: string | null;
  seller: string | null;
};

/**
 * Product Source Layer V1.2：来源证据引用（可选，仅来源层交接链路写入）。
 *
 * 语义边界（不可协商）：
 * - 这是「证据引用」，不是商品事实。`factAuthority: "evidence_only"` 是契约的一部分；
 * - 消费者（AI 研究 / Listing / Image）不得把它当作已确认事实；
 * - 既有解析器按需读取，缺失该键时行为完全不变（向后兼容）。
 */
export type SellerSpriteSourceLayerCapture = {
  /** 来源层采集包 id（可在来源证据库中回放） */
  captureId: string;
  /** 采集包版本号（同一商品多次采集严格递增） */
  version: number;
  /** 采集包内容指纹（SHA-256），用于比对证据是否被替换 */
  contentHash: string;
  /** 采集来源类型（如 sellersprite_xlsx / manual_entry） */
  sourceType: string;
  /** 采集时刻（ISO 8601） */
  capturedAt: string;
  /** 采集时的风险标记（来自来源层 Validator 的确定性映射） */
  riskFlags: string[];
  /** 固定声明：本条记录只能作为证据使用 */
  factAuthority: "evidence_only";
  /** 来源层采集的关键词列表（可选） */
  keywords?: string[];
};

export type SellerSpriteImportRow = {
  rowHash: string;
  rowNumber: number;
  asin: string;
  parentAsin: string | null;
  title: string;
  amazonUrl: string;
  imageUrl: string | null;
  priceUsd: number | null;
  rating: number | null;
  reviewCount: number | null;
  brand: string | null;
  category: string | null;
  /**
   * 大类 BSR（类目排名）。来源层交接链路写入本字段；
   * 旧链路（仅 searchRank）保持兼容：缺失时读取方回退到 searchRank。
   */
  rootCategoryBsr?: number | null;
  searchRank: number | null;
  subCategoryBsr?: number | null;
  estimatedMonthlySales: number | null;
  estimatedMonthlyRevenueUsd: number | null;
  /** 来源关键词（可选，来源层交接时透传） */
  keyword?: string | null;
  /** SellerSprite Source Fact Projection：详细参数（Key: Value | ...）原始文本 */
  detailAttributesRaw?: string | null;
  /** SellerSprite Source Fact Projection：SKU（Color: X | Size: Y）原始文本 */
  skuRaw?: string | null;
  /** SellerSprite Source Fact Projection：产品卖点原文（内容候选提取源） */
  sellingPointsRaw?: string | null;
  /** SellerSprite Plugin 捕获（可选）：存在时 sourceMeta 记录 subtype 与插件附加指标 */
  pluginCapture?: SellerSpritePluginCapture | null;
  /** 来源语义：Browser Visible DOM 与手工 TSV / 官方 XLSX 必须可审计区分。 */
  sourceMethod?: "sellersprite_page_visible_dom" | "sellersprite_page_manual_tsv" | "sellersprite_official_xlsx" | string;
  /** Product Source Layer V1.2 证据引用（可选，向后兼容） */
  sourceLayerCapture?: SellerSpriteSourceLayerCapture | null;
  /** Product Fact 结构投影（可选，旧 Candidate 元数据兼容）。 */
  productFact?: ProductFact | null;
};

export type SellerSpriteSelectedRowSource = {
  rowHash: string;
  rowNumber: number;
  facts: {
    asin: string;
    parentAsin?: string;
    title: string;
    amazonUrl: string;
    imageUrl?: string;
    priceUsd?: number;
    rating?: number;
    reviewCount?: number;
    brand?: string;
    category?: string;
    sku?: string;
    detailAttributes?: string;
    sellingPoints?: string;
  };
  estimates: {
    searchRank?: number;
    estimatedMonthlySales?: number;
    estimatedMonthlyRevenueUsd?: number;
  };
};

export class SellerSpriteImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SellerSpriteImportError";
  }
}

export type SellerSpriteImportSummary = {
  created: Array<{ rowHash: string; candidateId: string }>;
  skipped: Array<{ rowHash: string; candidateId: string; reason: "already_imported" }>;
  conflicts: Array<{ rowHash: string; candidateId: string; reason: "candidate_exists_with_different_snapshot" }>;
};

/** Frozen per-row hash. Deterministic from the row identity and physical row number. */
export function computeSellerSpriteRowHash(input: {
  rowNumber: number;
  asin: string;
  title: string;
  amazonUrl: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schema: SELLERSPRITE_IMPORT_ROW_HASH_SCHEMA,
      rowNumber: input.rowNumber,
      asin: input.asin,
      title: input.title,
      amazonUrl: input.amazonUrl,
    }))
    .digest("hex")
    .toLowerCase();
}

export function isSellerSpriteRowHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sellerSpriteImportRowFromPreview(row: SellerSpriteSelectedRowSource): SellerSpriteImportRow {
  return {
    rowHash: row.rowHash,
    rowNumber: row.rowNumber,
    asin: row.facts.asin,
    parentAsin: row.facts.parentAsin ?? null,
    title: row.facts.title,
    amazonUrl: row.facts.amazonUrl,
    imageUrl: row.facts.imageUrl ?? null,
    priceUsd: finiteOrNull(row.facts.priceUsd),
    rating: finiteOrNull(row.facts.rating),
    reviewCount: finiteOrNull(row.facts.reviewCount),
    brand: row.facts.brand ?? null,
    category: row.facts.category ?? null,
    searchRank: finiteOrNull(row.estimates.searchRank),
    estimatedMonthlySales: finiteOrNull(row.estimates.estimatedMonthlySales),
    estimatedMonthlyRevenueUsd: finiteOrNull(row.estimates.estimatedMonthlyRevenueUsd),
    detailAttributesRaw: row.facts.detailAttributes ?? null,
    skuRaw: row.facts.sku ?? null,
    sellingPointsRaw: row.facts.sellingPoints ?? null,
  };
}

// ── Single-row candidate source snapshot (frozen schema v1) ────────────────

export type SellerSpriteCandidateSourceMeta = {
  schema: "sellersprite_candidate_source_v1";
  source: {
    provider: "SellerSprite";
    type: "sellersprite_xlsx";
    /** 可选子类型标记：插件确定性捕获链路（XLSX 链路无此键，向后兼容） */
    subtype?: "sellersprite_plugin";
    marketplace: "Amazon US";
    reportType: "SellerSprite Search Results";
    capturedAt: null;
    importedAt: string;
    sourceFileSha256: string;
    rowHash: string;
  };
  identity: {
    asin: string;
    parentAsin: string | null;
    productUrl: string;
  };
  snapshot: {
    title: string;
    imageUrl: string | null;
    priceUsd: number | null;
    rating: number | null;
    reviewCount: number | null;
    brand: string | null;
    category: string | null;
  };
  /** SellerSprite Source Fact Projection：原始商品资料列（可选，向后兼容） */
  sourceRaw?: {
    detailAttributes?: string | null;
    sku?: string | null;
    sellingPoints?: string | null;
  };
  /** SellerSprite Plugin 捕获附加指标（可选，仅插件链路） */
  plugin?: SellerSpritePluginCapture;
  /**
   * Product Source Layer V1.2 证据引用（可选，仅来源层交接链路）。
   * 与 `snapshot` / `estimates` 语义不同：这里是「来源证据指针」，不是事实。
   */
  sourceLayerCapture?: SellerSpriteSourceLayerCapture;
  /** Product Fact 结构投影（可选，旧 Candidate 元数据兼容）。 */
  productFact?: ProductFact;
  estimates: {
    /**
     * 大类 BSR（类目排名）。来源层交接链路显式写入。
     * 旧数据没有本字段：读取方必须先读 rootCategoryBsr，缺失时回退 searchRank
     * （旧链路把大类 BSR 错写进 searchRank，语义靠 fallback 保持兼容）。
     */
    rootCategoryBsr?: number | null;
    searchRank: number | null;
    subCategoryBsr?: number | null;
    estimatedMonthlySales: number | null;
    estimatedMonthlyRevenueUsd: number | null;
    disclaimer: "third_party_estimate_point_in_time";
  };
};

export function buildSellerSpriteCandidateSourceMeta(
  row: SellerSpriteImportRow,
  sourceFileSha256: string,
  importedAt: string,
): string {
  const meta: SellerSpriteCandidateSourceMeta = {
    schema: "sellersprite_candidate_source_v1",
    source: {
      provider: "SellerSprite",
      type: "sellersprite_xlsx",
      ...(row.pluginCapture ? { subtype: row.pluginCapture.subtype } : {}),
      marketplace: "Amazon US",
      reportType: "SellerSprite Search Results",
      capturedAt: null,
      importedAt,
      sourceFileSha256,
      rowHash: row.rowHash,
    },
    identity: {
      asin: row.asin,
      parentAsin: row.parentAsin,
      productUrl: row.amazonUrl,
    },
    snapshot: {
      title: row.title,
      imageUrl: row.imageUrl,
      priceUsd: row.priceUsd,
      rating: row.rating,
      reviewCount: row.reviewCount,
      brand: row.brand,
      category: row.category,
    },
    ...(row.detailAttributesRaw || row.skuRaw || row.sellingPointsRaw ? {
      sourceRaw: {
        ...(row.detailAttributesRaw ? { detailAttributes: row.detailAttributesRaw } : {}),
        ...(row.skuRaw ? { sku: row.skuRaw } : {}),
        ...(row.sellingPointsRaw ? { sellingPoints: row.sellingPointsRaw } : {}),
      },
    } : {}),
    ...(row.pluginCapture ? { plugin: row.pluginCapture } : {}),
    ...(row.sourceLayerCapture ? { sourceLayerCapture: row.sourceLayerCapture } : {}),
    ...(row.productFact ? { productFact: row.productFact } : {}),
    estimates: {
      // 大类 BSR 显式落在自己的字段上，不再借用 searchRank；
      // 缺失（旧链路）时写 null，读取方按 fallback 规则回退 searchRank。
      rootCategoryBsr: row.rootCategoryBsr ?? null,
      searchRank: row.searchRank,
      subCategoryBsr: row.subCategoryBsr ?? null,
      estimatedMonthlySales: row.estimatedMonthlySales,
      estimatedMonthlyRevenueUsd: row.estimatedMonthlyRevenueUsd,
      disclaimer: "third_party_estimate_point_in_time",
    },
  };
  return JSON.stringify(meta);
}

export function sellerSpriteCandidateSourceMetaUtf8Bytes(meta: SellerSpriteCandidateSourceMeta | string): number {
  const value = typeof meta === "string" ? meta : JSON.stringify(meta);
  return new TextEncoder().encode(value).length;
}

export function parseSellerSpriteCandidateSourceMeta(sourceMetaJson: string): SellerSpriteCandidateSourceMeta | null {
  try {
    const parsed = JSON.parse(sourceMetaJson) as SellerSpriteCandidateSourceMeta;
    if (parsed?.schema !== "sellersprite_candidate_source_v1") return null;
    if (parsed.source?.marketplace !== "Amazon US") return null;
    if (typeof parsed.source?.sourceFileSha256 !== "string" || !isSellerSpriteRowHash(parsed.source.rowHash)) return null;
    if (typeof parsed.identity?.asin !== "string" || !/^[A-Z0-9]{10}$/.test(parsed.identity.asin)) return null;
    if (typeof parsed.snapshot?.title !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sellerSpriteCandidateIdentityKey(meta: SellerSpriteCandidateSourceMeta): string {
  return `${meta.source.marketplace}:${meta.identity.asin}`;
}

/**
 * 候选来源图片引用：公网 https 直链，或来源层 Validator 已放行的内嵌图片。
 *
 * 内嵌图片（`data:image/jpeg|png;base64,…`）不是「放宽要求」：它的字节已经在
 * 采集侧做过魔数与大小校验（XLSX 内嵌图 / ProductBatch 缓存主图），
 * 是图片本身而不是随时失效的外链。其它协议与其它 MIME 一律拒绝。
 */
export const INLINE_IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** 是否为来源层放行的内嵌图片引用。 */
export function isInlineImageReference(value: unknown): value is string {
  return typeof value === "string" && INLINE_IMAGE_DATA_URL_PATTERN.test(value);
}

/** 是否为可交给下游抓取的公网 https 图片直链。 */
export function isHttpsImageReference(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

/**
 * 内嵌图片引用是否「完整可用」。
 *
 * 只看前缀格式不足以放行：上游字符串归一化会给字段加长度上限，一旦内嵌图片
 * 被截断，前缀仍然合法（`data:image/jpeg;base64,/9j/...`），但字节已经不完整，
 * 浏览器解码必然失败（实测 naturalWidth=0）。放行这种引用等于把一张坏图写进
 * 候选主图，因此这里做字节级完整性校验：
 *
 * - JPEG：以 SOI(FFD8FF) 开头，且结尾附近出现 EOI(FFD9)；
 * - PNG：以 PNG 签名开头，且结尾附近出现 IEND 块签名；
 * - 其余 MIME：一律不放行。
 *
 * 结尾允许 16 字节余量（部分编码器会补尾部数据），误判方向是 fail-closed：
 * 拿不准就不放行，候选保持「没有主图」，不把损坏图片交给用户。
 */
export function isCompleteInlineImageReference(value: unknown): value is string {
  if (!isInlineImageReference(value)) return false;
  const separator = value.indexOf(",");
  if (separator < 0) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.slice(separator + 1), "base64");
  } catch {
    return false;
  }
  if (bytes.length < 16) return false;
  const tail = bytes.subarray(Math.max(0, bytes.length - 16));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) return tail.includes(Buffer.from([0xff, 0xd9]));
  const isPng = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) {
    return tail.includes(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  }
  return false;
}

// ── Token consumption (reuses the existing signature module) ───────────────

export function verifySellerSpritePreviewTokenForImport(
  token: string,
  subjectScope: string,
):
  | { ok: true; payload: SellerSpritePreviewImportTokenPayload }
  | { ok: false; code: string } {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, code: "malformed_preview_token" };
  }
  if (new TextEncoder().encode(token).length > SELLERSPRITE_IMPORT_MAX_TOKEN_UTF8_BYTES) {
    return { ok: false, code: "malformed_preview_token" };
  }
  const result = verifySellerSpritePreviewImportToken(token);
  if (!result.ok) {
    const code = result.reason === "malformed_preview_token" ? "malformed_preview_token"
      : result.reason === "invalid_preview_token_signature" ? "invalid_preview_token_signature"
      : result.reason === "preview_token_expired" ? "preview_token_expired"
      : result.reason === "preview_token_not_yet_valid" ? "preview_token_not_yet_valid"
      : "preview_token_contract_mismatch";
    return { ok: false, code };
  }
  const expectedScopeHash = sellerSpritePreviewImportSubjectScopeHash(subjectScope);
  if (result.payload.subjectScopeHash !== expectedScopeHash) {
    return { ok: false, code: "preview_token_subject_mismatch" };
  }
  return { ok: true, payload: result.payload };
}

// ── Re-parse digest reconciliation ──────────────────────────────────────────

export type SellerSpriteReconciledPreview = {
  sourceFileSha256: string;
  acceptedRowsDigest: string;
  acceptedRowCount: number;
  warningDigest: string;
  warningCount: number;
  acceptedRowHashes: string[];
};

export function reconcileSellerSpritePreviewAgainstToken(
  reParsed: {
    sourceFileSha256: string;
    acceptedRowsDigest?: string;
    acceptedRowCount: number;
    warningDigest?: string;
    warnings: unknown[];
    acceptedRowHashes: string[];
  },
  payload: SellerSpritePreviewImportTokenPayload,
): { ok: true; value: SellerSpriteReconciledPreview } | { ok: false; code: string } {
  const warningCount = reParsed.warnings.length;
  if (reParsed.sourceFileSha256 !== payload.sourceFileSha256) {
    return { ok: false, code: "preview_token_file_mismatch" };
  }
  if (!reParsed.acceptedRowsDigest || reParsed.acceptedRowsDigest !== payload.acceptedRowsDigest) {
    return { ok: false, code: "preview_token_rows_mismatch" };
  }
  if (reParsed.acceptedRowCount !== payload.acceptedRowCount) {
    return { ok: false, code: "preview_token_rows_mismatch" };
  }
  if (!reParsed.warningDigest || reParsed.warningDigest !== payload.warningDigest) {
    return { ok: false, code: "preview_token_warning_mismatch" };
  }
  if (warningCount !== payload.warningCount) {
    return { ok: false, code: "preview_token_warning_mismatch" };
  }
  return {
    ok: true,
    value: {
      sourceFileSha256: reParsed.sourceFileSha256,
      acceptedRowsDigest: reParsed.acceptedRowsDigest,
      acceptedRowCount: reParsed.acceptedRowCount,
      warningDigest: reParsed.warningDigest,
      warningCount,
      acceptedRowHashes: reParsed.acceptedRowHashes,
    },
  };
}

// ── Selection validation ────────────────────────────────────────────────────

export function parseSelectedRowHashes(raw: string): string[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0 || parsed.length > SELLERSPRITE_IMPORT_MAX_SELECTED_ROWS) return null;
  if (parsed.some((value) => !isSellerSpriteRowHash(value))) return null;
  if (new Set(parsed).size !== parsed.length) return null;
  return parsed as string[];
}

export function selectedRowHashesAreSubset(selected: readonly string[], acceptedRowHashes: readonly string[]): boolean {
  const accepted = new Set(acceptedRowHashes);
  return selected.every((hash) => accepted.has(hash));
}

export function confirmedIsTrue(value: string): boolean {
  return value === "true";
}

export function warningsAcceptedOk(value: string, warningCount: number): boolean {
  return warningCount > 0 ? value === "true" : true;
}

export function checkDuplicateAsin(rows: readonly SellerSpriteImportRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.asin)) return row.asin;
    seen.add(row.asin);
  }
  return null;
}
