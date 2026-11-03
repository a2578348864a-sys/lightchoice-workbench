import "server-only";

import { createHash } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  captureSellerSpriteVisibleQuery,
  sellerSpriteProductMarketQuerySubjectKey,
  sellerSpriteQueryFingerprint,
  type SellerSpriteQueryInput,
} from "@/lib/server/sellerSpriteVisibleQuery";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { createEvidenceStore, type EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { attachmentKindForV3Module } from "@/lib/sourceLayer/v3ModuleEvidence";
import { sourceEvidenceAttachmentContentHash } from "@/lib/sourceLayer/evidenceAttachment";
import { captureContentHashOf, type CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import type { BatchCaptureProductMarketQueryUnit } from "@/lib/server/batchCaptureRun";

const PRODUCT_RESEARCH_URL = "https://www.sellersprite.com/v3/product-research/";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type ProductMarketBaseEvidence = {
  evidenceId: string;
  version: number;
  contentHash: string;
};

export type ProductMarketQueryExecution = {
  status: "captured" | "partial" | "blocked" | "human_required" | "failed";
  navigationPerformed: boolean;
  querySubjectKey: string | null;
  evidenceAttachmentId: string | null;
  evidenceContentHash: string | null;
  rowsObserved: number;
  productAssociations: BatchCaptureProductMarketQueryUnit["productAssociations"];
  errorCode: string | null;
};

export type ProductMarketPreflight = {
  ready: boolean;
  evidenceByAsin: ReadonlyMap<string, ProductMarketBaseEvidence>;
  missingAsins: readonly string[];
};

type ProductMarketWorkerDeps = {
  getSubject?: (subjectKey: string) => Promise<EvidenceSubjectRecord | null>;
  captureQuery?: typeof captureSellerSpriteVisibleQuery;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSellerSpriteProductMarketBcrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOCAL_ACQUISITION_ENABLED === "true"
    && env.SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED === "true";
}

function verifiedBaseEvidence(subjectKey: string, record: EvidenceSubjectRecord | null, asin: string): ProductMarketBaseEvidence | null {
  if (!record || record.subjectKey !== subjectKey || record.integrityIssues?.length) return null;
  const latest = record.versions.at(-1) as CaptureEvidenceRecord | undefined;
  if (!latest || latest.subjectKey !== subjectKey || latest.pkg?.subjectKey !== subjectKey
    || latest.pkg?.fields?.asin?.toUpperCase() !== asin
    || latest.validation?.verdict !== "passed"
    || latest.factAuthority !== "evidence_only"
    || !latest.evidenceId?.trim()
    || !Number.isSafeInteger(latest.version) || latest.version < 1
    || !HASH_PATTERN.test(latest.contentHash)
    || captureContentHashOf(latest.pkg) !== latest.contentHash) return null;
  return { evidenceId: latest.evidenceId, version: latest.version, contentHash: latest.contentHash };
}

async function resolveSubjectReader(context: AccessContext, deps: ProductMarketWorkerDeps) {
  if (deps.getSubject) return deps.getSubject;
  const store = createEvidenceStore(sourceLayerOperator(context));
  return (subjectKey: string) => store.getSubject(subjectKey);
}

export async function preflightSellerSpriteProductMarketBaseEvidence(input: {
  context: AccessContext;
  authorizedAsins: readonly string[];
}, deps: ProductMarketWorkerDeps = {}): Promise<ProductMarketPreflight> {
  const getSubject = await resolveSubjectReader(input.context, deps);
  const evidenceByAsin = new Map<string, ProductMarketBaseEvidence>();
  const normalizedAsins = [...new Set(input.authorizedAsins.map((asin) => asin.trim().toUpperCase()))];
  const missingAsins: string[] = [];
  for (const asin of normalizedAsins) {
    if (!ASIN_PATTERN.test(asin)) {
      missingAsins.push(asin);
      continue;
    }
    const subjectKey = `amazon:US:${asin}`;
    let subject: EvidenceSubjectRecord | null;
    try {
      subject = await getSubject(subjectKey);
    } catch {
      missingAsins.push(asin);
      continue;
    }
    let evidence: ProductMarketBaseEvidence | null = null;
    try {
      evidence = verifiedBaseEvidence(subjectKey, subject, asin);
    } catch {
      evidence = null;
    }
    if (!evidence) missingAsins.push(asin);
    else evidenceByAsin.set(asin, evidence);
  }
  return { ready: normalizedAsins.length > 0 && missingAsins.length === 0, evidenceByAsin, missingAsins };
}

function normalizedHeader(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function uniqueColumn(headers: readonly string[], names: readonly string[]): number | null {
  const accepted = new Set(names.map(normalizedHeader));
  const matches = headers.flatMap((header, index) => accepted.has(normalizedHeader(header)) ? [index] : []);
  return matches.length === 1 ? matches[0] : null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function asinRowKey(asin: string): string {
  return `asin:${createHash("sha256").update(asin).digest("hex")}`;
}

function productRowsFromSnapshot(value: unknown): Map<string, { rowKey: string; rowContentHash: string }> {
  if (!isRecord(value) || !Array.isArray(value.tables)) return new Map();
  const rowsByAsin = new Map<string, { rowKey: string; rowContentHash: string } | null>();
  for (const rawTable of value.tables) {
    if (!isRecord(rawTable) || !Array.isArray(rawTable.headers) || !Array.isArray(rawTable.rows)
      || !rawTable.headers.every((header) => typeof header === "string")) continue;
    const headers = rawTable.headers as string[];
    const asinIndex = uniqueColumn(headers, ["ASIN", "商品ASIN", "产品ASIN"]);
    const titleIndex = uniqueColumn(headers, ["Title", "Product Title", "Product Name", "商品名称", "商品标题", "产品名称"]);
    if (asinIndex === null || titleIndex === null) continue;
    for (const rawRow of rawTable.rows) {
      if (!Array.isArray(rawRow)) continue;
      const row = rawRow as Array<string | null>;
      const asin = String(row[asinIndex] ?? "").normalize("NFKC").trim().toUpperCase();
      const title = String(row[titleIndex] ?? "").trim();
      if (!ASIN_PATTERN.test(asin) || !title) continue;
      const rowContentHash = sha256({ headers, row });
      const rowKey = asinRowKey(asin);
      if (!rowsByAsin.has(asin)) rowsByAsin.set(asin, { rowKey, rowContentHash });
      else if (rowsByAsin.get(asin)?.rowContentHash !== rowContentHash) rowsByAsin.set(asin, null);
    }
  }
  return new Map([...rowsByAsin].flatMap(([asin, row]) => row ? [[asin, row] as const] : []));
}

function verifiedQueryAttachment(input: {
  subject: EvidenceSubjectRecord | null;
  subjectKey: string;
  category: string;
  filters: Record<string, string>;
  attachmentId: string;
  contentHash: string;
}): boolean {
  const attachment = input.subject?.attachments?.find((entry) => entry.attachmentId === input.attachmentId);
  if (!attachment || attachment.subjectKey !== input.subjectKey
    || attachment.kind !== attachmentKindForV3Module("sellersprite_product_market")
    || attachment.sourceType !== "sellersprite_plugin"
    || attachment.contentHash !== input.contentHash
    || !HASH_PATTERN.test(attachment.contentHash)
    || sourceEvidenceAttachmentContentHash({
      kind: attachment.kind,
      sourceType: attachment.sourceType,
      subjectKey: attachment.subjectKey,
      payload: attachment.payload,
    }) !== attachment.contentHash) return false;
  const payload = attachment.payload;
  if (payload.module !== "sellersprite_product_market" || payload.subjectKey !== input.subjectKey) return false;
  const identity = isRecord(payload.identity) ? payload.identity : null;
  const data = isRecord(payload.data) ? payload.data : null;
  const queryContract = data && isRecord(data.queryContract) ? data.queryContract : null;
  const rawQueryInput = queryContract && isRecord(queryContract.queryInput) ? queryContract.queryInput : null;
  if (!rawQueryInput || rawQueryInput.module !== "sellersprite_product_market"
    || typeof rawQueryInput.category !== "string" || rawQueryInput.marketplace !== "US"
    || !isRecord(rawQueryInput.filters)
    || !Object.values(rawQueryInput.filters).every((value) => typeof value === "string")) return false;
  const queryInput = rawQueryInput as Extract<SellerSpriteQueryInput, { module: "sellersprite_product_market" }>;
  return identity?.category === input.category
    && queryContract?.module === "sellersprite_product_market"
    && queryContract.marketplace === "US"
    && queryInput.category === input.category
    && JSON.stringify(queryInput.filters) === JSON.stringify(input.filters)
    && queryContract.queryFingerprint === sellerSpriteQueryFingerprint(queryInput, "bcr")
    && sellerSpriteProductMarketQuerySubjectKey(queryInput) === input.subjectKey
    && isRecord(data?.visibleSnapshot);
}

function emptyExecution(
  status: ProductMarketQueryExecution["status"],
  errorCode: string,
  navigationPerformed = false,
): ProductMarketQueryExecution {
  return {
    status,
    navigationPerformed,
    querySubjectKey: null,
    evidenceAttachmentId: null,
    evidenceContentHash: null,
    rowsObserved: 0,
    productAssociations: [],
    errorCode,
  };
}

/**
 * BCR Product Market 只写查询级 V3 Evidence。只有 Query Evidence 和商品基础
 * Evidence 均经过身份/哈希复核后，才生成独立行关联；不会完成任何 ASIN×module cell。
 */
export async function captureSellerSpriteProductMarketQueryForBatch(input: {
  context: AccessContext;
  query: Pick<BatchCaptureProductMarketQueryUnit, "category" | "filters">;
  authorizedAsins: readonly string[];
  shouldStop?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}, deps: ProductMarketWorkerDeps = {}): Promise<ProductMarketQueryExecution> {
  if (!isSellerSpriteProductMarketBcrEnabled(input.env)) {
    return emptyExecution("blocked", "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED");
  }
  const category = input.query.category.normalize("NFC").trim();
  const queryInput = {
    module: "sellersprite_product_market" as const,
    category,
    marketplace: "US" as const,
    filters: input.query.filters,
  };
  const subjectKey = sellerSpriteProductMarketQuerySubjectKey(queryInput);
  const preflight = await preflightSellerSpriteProductMarketBaseEvidence({
    context: input.context,
    authorizedAsins: input.authorizedAsins,
  }, deps);
  if (!preflight.ready) return emptyExecution("blocked", "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING");
  if (await input.shouldStop?.()) return emptyExecution("blocked", "SELLERSPRITE_CAPTURE_JOB_STOPPED");

  const getSubject = await resolveSubjectReader(input.context, deps);
  const captureQuery = deps.captureQuery ?? captureSellerSpriteVisibleQuery;
  let result: Awaited<ReturnType<typeof captureSellerSpriteVisibleQuery>>;
  try {
    result = await captureQuery({
      context: input.context,
      module: "sellersprite_product_market",
      sourceUrl: PRODUCT_RESEARCH_URL,
      subjectKey,
      identity: { category },
      queryInput,
      accountAccessFingerprint: "bcr",
      shouldStop: input.shouldStop,
    });
  } catch {
    return emptyExecution("failed", "SELLERSPRITE_PRODUCT_MARKET_QUERY_FAILED", true);
  }
  if (result.status === "human_required") return emptyExecution("human_required", result.errorCode ?? "SELLERSPRITE_LOGIN_REQUIRED", true);
  if (result.status !== "captured" || !result.capture || !result.snapshot) {
    const code = result.errorCode ?? "SELLERSPRITE_PRODUCT_MARKET_QUERY_FAILED";
    const human = /LOGIN|CAPTCHA|STOP|HUMAN/iu.test(code);
    return emptyExecution(human ? "human_required" : "failed", code, true);
  }

  const capture = result.capture;
  const attachmentId = capture.attachment.attachmentId;
  const contentHash = capture.attachment.contentHash;
  if (capture.moduleEvidence.module !== "sellersprite_product_market"
    || capture.moduleEvidence.subjectKey !== subjectKey
    || capture.moduleEvidence.metricNature !== "provider_estimate"
    || !HASH_PATTERN.test(contentHash)
    || capture.attachment.subjectKey !== subjectKey
    || capture.attachment.sourceType !== "sellersprite_plugin"
    || capture.downstream.subjectKey !== subjectKey
    || capture.downstream.attachmentId !== attachmentId) {
    return emptyExecution("failed", "SELLERSPRITE_PRODUCT_MARKET_EVIDENCE_IDENTITY_INVALID", true);
  }

  let storedSubject: EvidenceSubjectRecord | null;
  try {
    storedSubject = await getSubject(subjectKey);
  } catch {
    return emptyExecution("failed", "SELLERSPRITE_PRODUCT_MARKET_EVIDENCE_READBACK_FAILED", true);
  }
  if (!verifiedQueryAttachment({ subject: storedSubject, subjectKey, category, filters: input.query.filters, attachmentId, contentHash })) {
    return emptyExecution("failed", "SELLERSPRITE_PRODUCT_MARKET_EVIDENCE_READBACK_INVALID", true);
  }

  const payload = storedSubject?.attachments?.find((entry) => entry.attachmentId === attachmentId)?.payload;
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  const visibleSnapshot = data && isRecord(data.visibleSnapshot) ? data.visibleSnapshot : null;
  const rows = productRowsFromSnapshot(visibleSnapshot);
  const currentBaseEvidence = await preflightSellerSpriteProductMarketBaseEvidence({
    context: input.context,
    authorizedAsins: input.authorizedAsins,
  }, deps);
  const authorized = new Set(input.authorizedAsins.map((asin) => asin.trim().toUpperCase()));
  const productAssociations = [...rows].flatMap(([asin, row]) => {
    const evidence = currentBaseEvidence.evidenceByAsin.get(asin);
    if (!authorized.has(asin) || !evidence) return [];
    const original = preflight.evidenceByAsin.get(asin);
    if (!original || original.evidenceId !== evidence.evidenceId
      || original.version !== evidence.version || original.contentHash !== evidence.contentHash) return [];
    return [{
      asin,
      rowKey: row.rowKey,
      rowContentHash: row.rowContentHash,
      baseEvidenceId: evidence.evidenceId,
      baseEvidenceVersion: evidence.version,
      baseEvidenceContentHash: evidence.contentHash,
    }];
  });
  return {
    status: "captured",
    navigationPerformed: true,
    querySubjectKey: subjectKey,
    evidenceAttachmentId: attachmentId,
    evidenceContentHash: contentHash,
    rowsObserved: rows.size,
    productAssociations,
    errorCode: null,
  };
}
