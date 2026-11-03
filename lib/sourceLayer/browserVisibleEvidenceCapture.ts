import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  computeSellerSpriteRowHash,
  type SellerSpriteImportRow,
} from "@/lib/server/sellerSpriteImportContract";
import {
  captureEvidenceAttachmentThroughGateway,
  captureThroughGateway,
  type CaptureGatewayAttachmentResult,
  type CaptureGatewayResult,
} from "@/lib/sourceLayer/server/captureGateway";
import {
  createEvidenceStore,
  type EvidenceSubjectRecord,
} from "@/lib/sourceLayer/server/evidenceStore";
import { persistRawArtifact } from "@/lib/sourceLayer/server/rawArtifactIntake";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { sha256OfRawArtifact } from "@/lib/sourceLayer/rawArtifact";
import {
  attachmentKindForV3Module,
  buildV3ModuleEvidence,
  type V3ModuleEvidence,
} from "@/lib/sourceLayer/v3ModuleEvidence";

export const BROWSER_VISIBLE_SELLERSPRITE_SCHEMA =
  "sellersprite-browser-visible-dom.v1" as const;
export const BROWSER_VISIBLE_SELLERSPRITE_PARSER_VERSION =
  "sellersprite-visible-dom.v1" as const;

export type BrowserVisibleKeywordRow = {
  rank: number;
  keyword: string;
  translation: string | null;
  rawText: string;
};

export type BrowserVisibleResultTable = {
  headers: string[];
  rows: Array<Array<string | null>>;
};

export type BrowserVisibleSellerSpriteEvidence = {
  schemaVersion: typeof BROWSER_VISIBLE_SELLERSPRITE_SCHEMA;
  sourceUrl: string;
  sourceSurface: "v3/keyword-reverse";
  marketplace: "US";
  capturedAt: string;
  asin: string;
  pageTitle: string;
  product: {
    title: string;
    amazonUrl: string;
    seller: string | null;
    category: string | null;
    bsr: number | null;
    priceUsd: number | null;
    rating: number | null;
    reviewCount: number | null;
    listingDate: string | null;
  };
  visibleKeywordRows: BrowserVisibleKeywordRow[];
  highFrequencyTerms: string[];
  visibleResultTable: BrowserVisibleResultTable | null;
  extraction: {
    method: "dom";
    capturedFromVisibleDom: true;
    productRootSelector: string;
    productSummarySelector: string;
    keywordRowSelector: string;
    highFrequencySelector: string;
  };
};

export type BrowserVisibleEvidenceCaptureResult = {
  strategy: "browser_visible_evidence_capture";
  subjectKey: string;
  sourceUrl: string;
  rawArtifact: Awaited<ReturnType<typeof persistRawArtifact>>;
  gateway: CaptureGatewayResult;
  moduleEvidence: V3ModuleEvidence;
  moduleAttachment: CaptureGatewayAttachmentResult;
  evidenceStore: EvidenceSubjectRecord;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`BROWSER_VISIBLE_EVIDENCE_INVALID:${message}`);
}

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (typeof value !== "string") {
    if (required) invalid(`${field}_required`);
    return null;
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    if (required) invalid(`${field}_required`);
    return null;
  }
  if (normalized.length > maxLength) invalid(`${field}_too_long`);
  return normalized;
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${field}_invalid`);
  return value;
}

function integerOrNull(value: unknown, field: string): number | null {
  const normalized = numberOrNull(value, field);
  if (normalized !== null && !Number.isSafeInteger(normalized)) invalid(`${field}_invalid`);
  return normalized;
}

function assertHttpsHost(value: string, field: string, allowedHost: RegExp): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid(`${field}_invalid`);
  }
  if (parsed.protocol !== "https:" || !allowedHost.test(parsed.hostname.toLowerCase())) {
    invalid(`${field}_invalid`);
  }
  return parsed;
}

function parseKeywordRows(value: unknown): BrowserVisibleKeywordRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    invalid("visible_keyword_rows_invalid");
  }
  const rows = value.map((item, index) => {
    if (!isRecord(item)) invalid(`visible_keyword_rows_${index}_invalid`);
    const rank = integerOrNull(item.rank, `visible_keyword_rows_${index}_rank`);
    if (rank === null || rank < 1) invalid(`visible_keyword_rows_${index}_rank_invalid`);
    return {
      rank,
      keyword: text(item.keyword, `visible_keyword_rows_${index}_keyword`, 240) as string,
      translation: text(item.translation, `visible_keyword_rows_${index}_translation`, 240, false),
      rawText: text(item.rawText, `visible_keyword_rows_${index}_raw_text`, 2000) as string,
    };
  });
  const unique = new Set(rows.map((row) => row.rank));
  if (unique.size !== rows.length) invalid("visible_keyword_rows_duplicate_rank");
  return rows;
}

function parseVisibleResultTable(value: unknown): BrowserVisibleResultTable | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !Array.isArray(value.headers) || !Array.isArray(value.rows)) {
    invalid("visible_result_table_invalid");
  }
  if (value.headers.length > 64 || value.rows.length > 25) invalid("visible_result_table_too_large");
  const headers = value.headers.map((item, index) =>
    text(item, `visible_result_table_header_${index}`, 200, false) ?? "",
  );
  const rows = value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length > 64) invalid(`visible_result_table_row_${rowIndex}_invalid`);
    return row.map((cell, cellIndex) =>
      text(cell, `visible_result_table_${rowIndex}_${cellIndex}`, 1000, false),
    );
  });
  return { headers, rows };
}

function parseExtraction(value: unknown): BrowserVisibleSellerSpriteEvidence["extraction"] {
  if (!isRecord(value) || value.method !== "dom" || value.capturedFromVisibleDom !== true) {
    invalid("extraction_invalid");
  }
  return {
    method: "dom",
    capturedFromVisibleDom: true,
    productRootSelector: text(value.productRootSelector, "product_root_selector", 240) as string,
    productSummarySelector: text(value.productSummarySelector, "product_summary_selector", 240) as string,
    keywordRowSelector: text(value.keywordRowSelector, "keyword_row_selector", 240) as string,
    highFrequencySelector: text(value.highFrequencySelector, "high_frequency_selector", 240) as string,
  };
}

export function parseBrowserVisibleSellerSpriteEvidence(
  value: unknown,
): BrowserVisibleSellerSpriteEvidence {
  if (!isRecord(value) || value.schemaVersion !== BROWSER_VISIBLE_SELLERSPRITE_SCHEMA) {
    invalid("schema_version_invalid");
  }
  const sourceUrl = text(value.sourceUrl, "source_url", 2048) as string;
  const source = assertHttpsHost(sourceUrl, "source_url", /(^|\.)sellersprite\.com$/);
  if (source.pathname !== "/v3/keyword-reverse/" && source.pathname !== "/v3/keyword-reverse") {
    invalid("source_surface_invalid");
  }
  const asin = text(value.asin, "asin", 10)?.toUpperCase() as string;
  if (!/^[A-Z0-9]{10}$/.test(asin) || source.searchParams.get("q")?.toUpperCase() !== asin) {
    invalid("asin_binding_invalid");
  }
  if (value.sourceSurface !== "v3/keyword-reverse" || value.marketplace !== "US") {
    invalid("source_context_invalid");
  }
  const capturedAt = text(value.capturedAt, "captured_at", 64) as string;
  if (Number.isNaN(Date.parse(capturedAt))) invalid("captured_at_invalid");
  const pageTitle = text(value.pageTitle, "page_title", 300) as string;
  if (!isRecord(value.product)) invalid("product_invalid");
  const productTitle = text(value.product.title, "product_title", 1000) as string;
  const amazonUrl = text(value.product.amazonUrl, "amazon_url", 2048) as string;
  const amazon = assertHttpsHost(amazonUrl, "amazon_url", /(^|\.)amazon\.com$/);
  if (!new RegExp(`/dp/${asin}(?:/|$)`, "i").test(amazon.pathname)) {
    invalid("amazon_url_asin_mismatch");
  }
  const product = {
    title: productTitle,
    amazonUrl,
    seller: text(value.product.seller, "seller", 240, false),
    category: text(value.product.category, "category", 240, false),
    bsr: integerOrNull(value.product.bsr, "bsr"),
    priceUsd: numberOrNull(value.product.priceUsd, "price_usd"),
    rating: numberOrNull(value.product.rating, "rating"),
    reviewCount: integerOrNull(value.product.reviewCount, "review_count"),
    listingDate: text(value.product.listingDate, "listing_date", 32, false),
  };
  if (product.listingDate !== null && Number.isNaN(Date.parse(product.listingDate))) {
    invalid("listing_date_invalid");
  }
  if (!Array.isArray(value.highFrequencyTerms) || value.highFrequencyTerms.length === 0) {
    invalid("high_frequency_terms_invalid");
  }
  const highFrequencyTerms = value.highFrequencyTerms.map((item, index) =>
    text(item, `high_frequency_term_${index}`, 240) as string,
  );
  const extraction = parseExtraction(value.extraction);
  return {
    schemaVersion: BROWSER_VISIBLE_SELLERSPRITE_SCHEMA,
    sourceUrl,
    sourceSurface: "v3/keyword-reverse",
    marketplace: "US",
    capturedAt,
    asin,
    pageTitle,
    product,
    visibleKeywordRows: parseKeywordRows(value.visibleKeywordRows),
    highFrequencyTerms,
    visibleResultTable: parseVisibleResultTable(value.visibleResultTable),
    extraction,
  };
}

function sellerSpriteRowFromVisibleEvidence(
  evidence: BrowserVisibleSellerSpriteEvidence,
): SellerSpriteImportRow {
  const rowNumber = 1;
  return {
    rowHash: computeSellerSpriteRowHash({
      rowNumber,
      asin: evidence.asin,
      title: evidence.product.title,
      amazonUrl: evidence.product.amazonUrl,
    }),
    rowNumber,
    asin: evidence.asin,
    parentAsin: null,
    title: evidence.product.title,
    amazonUrl: evidence.product.amazonUrl,
    imageUrl: null,
    priceUsd: evidence.product.priceUsd,
    rating: evidence.product.rating,
    reviewCount: evidence.product.reviewCount,
    brand: null,
    category: evidence.product.category,
    rootCategoryBsr: evidence.product.bsr,
    searchRank: null,
    subCategoryBsr: null,
    estimatedMonthlySales: null,
    estimatedMonthlyRevenueUsd: null,
    sourceMethod: "sellersprite_page_visible_dom",
    pluginCapture: {
      subtype: "sellersprite_plugin",
      capturedAt: evidence.capturedAt,
      bsr: evidence.product.bsr,
      subCategoryBsr: null,
      variationCount: null,
      reviewRate: null,
      grossMargin: null,
      listingDate: evidence.product.listingDate,
      sellerCount: null,
      fulfillment: null,
      seller: evidence.product.seller,
    },
  };
}

function rawArtifactBytes(evidence: BrowserVisibleSellerSpriteEvidence): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    schemaVersion: BROWSER_VISIBLE_SELLERSPRITE_SCHEMA,
    acquisitionMode: "browser_dom",
    sourceSurface: evidence.sourceSurface,
    capturedAt: evidence.capturedAt,
    evidence,
  }, null, 2)}\n`);
}

/**
 * 将同一份 Browser DOM 结构化提取结果送入 V3 Gateway，并在 Gateway 建立
 * 商品 Evidence 后把不可变 RawArtifact 附着到同一 EvidenceStore 主体。
 *
 * 这里不访问 SellerSprite 网络、不点击 Export，也不调用任何私有接口。
 */
export async function captureBrowserVisibleSellerSpriteEvidence(input: {
  context: AccessContext;
  evidence: unknown;
}): Promise<BrowserVisibleEvidenceCaptureResult> {
  const evidence = parseBrowserVisibleSellerSpriteEvidence(input.evidence);
  const subjectKey = `amazon:US:${evidence.asin}`;
  const bytes = rawArtifactBytes(evidence);
  const sourceFingerprint = sha256OfRawArtifact(bytes);
  const row = sellerSpriteRowFromVisibleEvidence(evidence);
  const now = new Date(evidence.capturedAt);
  const gateway = await captureThroughGateway({
    context: input.context,
    source: "sellersprite_plugin",
    payload: { rows: [row] },
    now,
    sourceUrl: evidence.sourceUrl,
    sourceFingerprint,
    subjectKey,
    marketplace: evidence.marketplace,
    shadowAudit: { enabled: false },
  });
  const rawArtifact = await persistRawArtifact({
    context: input.context,
    subjectKey,
    sourceType: "sellersprite_plugin",
    kind: "other",
    fileName: `sellersprite-reverse-asin-${evidence.asin}-browser-visible.json`,
    contentType: "application/json",
    bytes,
    capturedAt: evidence.capturedAt,
    provenance: {
      provider: "SellerSprite",
      sourceSurface: evidence.sourceSurface,
      sourceUrl: evidence.sourceUrl,
      sourceRecordRef: evidence.asin,
      providerUpdatedAt: null,
      acquisitionMode: "browser_dom",
      parserVersion: BROWSER_VISIBLE_SELLERSPRITE_PARSER_VERSION,
    },
  });
  const moduleEvidence = buildV3ModuleEvidence({
    module: "reverse_asin",
    subjectKey,
    marketplace: evidence.marketplace,
    capturedAt: evidence.capturedAt,
    provider: "SellerSprite",
    sourceSurface: evidence.sourceSurface,
    sourceUrl: evidence.sourceUrl,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_observed",
    status: "AVAILABLE_WITH_LIMITATION",
    limitations: ["export:PLAN_LIMITATION"],
    identity: { asin: evidence.asin },
    data: {
      pageTitle: evidence.pageTitle,
      product: evidence.product,
      visibleKeywordRows: evidence.visibleKeywordRows,
      highFrequencyTerms: evidence.highFrequencyTerms,
      visibleResultTable: evidence.visibleResultTable,
      extraction: evidence.extraction,
    },
    evidenceOnly: true,
  });
  const moduleAttachment = await captureEvidenceAttachmentThroughGateway({
    context: input.context,
    subjectKey,
    source: "sellersprite_plugin",
    kind: attachmentKindForV3Module(moduleEvidence.module),
    payload: moduleEvidence as unknown as Record<string, unknown>,
    sourceUrl: evidence.sourceUrl,
    sourceFingerprint,
    capturedAt: now,
    traceId: gateway.traceId,
  });
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const evidenceStore = await store.getSubject(subjectKey);
  if (!evidenceStore
    || evidenceStore.versions.length === 0
    || !evidenceStore.rawArtifacts?.some((item) => item.sha256 === rawArtifact.artifact.sha256)) {
    throw new Error("BROWSER_VISIBLE_EVIDENCE_STORE_VERIFICATION_FAILED");
  }
  return {
    strategy: "browser_visible_evidence_capture",
    subjectKey,
    sourceUrl: evidence.sourceUrl,
    rawArtifact,
    gateway,
    moduleEvidence,
    moduleAttachment,
    evidenceStore,
  };
}
