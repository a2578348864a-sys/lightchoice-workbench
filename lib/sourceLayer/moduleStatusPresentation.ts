/** Product-facing states projected from one module's persisted V3 evidence. */
export const PRODUCT_MODULE_STATUSES = [
  "COMPLETE",
  "CAPTURED_PARTIAL",
  "NO_DATA_WITH_EVIDENCE",
  "AVAILABLE_WITH_LIMITATION",
  "BLOCKED_WITH_EVIDENCE",
  "FAILED_HUMAN",
  "LOGIN_REQUIRED",
  "EXTENSION_REQUIRED",
  "PLAN_LIMITED",
  "HUMAN_ACTION_REQUIRED",
  "NOT_COLLECTED",
] as const;

export type ProductModuleStatus = (typeof PRODUCT_MODULE_STATUSES)[number];

/** Receipt-only outcomes describe a recent attempt; they never manufacture a COMPLETE state. */
export function projectOrchestratorReceiptStatus(status: string | undefined, errorCode?: string | null): ProductModuleStatus | null {
  const code = errorCode?.toUpperCase() ?? "";
  if (/LOGIN_REQUIRED|SIGN_IN_REQUIRED|AUTH_REQUIRED/u.test(code)) return "LOGIN_REQUIRED";
  if (/EXTENSION_REQUIRED|EXTENSION_NOT_FOUND/u.test(code)) return "EXTENSION_REQUIRED";
  if (/PLAN_LIMITED|PLAN_LIMITATION/u.test(code)) return "PLAN_LIMITED";
  switch (status) {
    case "human_action_required":
    case "failed_human": return "HUMAN_ACTION_REQUIRED";
    case "login_required": return "LOGIN_REQUIRED";
    case "extension_required": return "EXTENSION_REQUIRED";
    case "plan_limited": return "PLAN_LIMITED";
    case "failed_retryable":
    case "failed_permanent":
    case "blocked_with_evidence": return "BLOCKED_WITH_EVIDENCE";
    case "source_input_required":
    case "not_attempted": return "HUMAN_ACTION_REQUIRED";
    default: return null;
  }
}

export type V3ModuleEvidenceStatus =
  | "VALIDATED_AVAILABLE"
  | "AVAILABLE_WITH_LIMITATION"
  | "PLAN_LIMITATION"
  | "BLOCKED_WITH_EVIDENCE"
  | "HUMAN_ACTION_REQUIRED"
  | "UNVERIFIED";

/**
 * 每个已填充字段的真实供给证据。`evidenceId/evidenceVersion/contentHash/capturedAt`
 * 描述的是**最近一次补齐运行**，不能代表历史字段；字段级来源以 `fieldProvenance` 为准。
 */
export type ProductBatchDetailFieldProvenance = {
  field: string;
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
  capturedAt: string;
};

export type ProductBatchDetailEnrichment = {
  status: "enriched" | "captured_partial";
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
  capturedAt: string;
  captureOrigin?: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE";
  fields: string[];
  /**
   * G-03：跨多次补齐累积的字段级来源。缺省表示持久化数据早于该契约（legacy），
   * 读取方不得据此推断字段来源，也不得回退成「用 evidenceId 代表所有字段」。
   */
  fieldProvenance?: ProductBatchDetailFieldProvenance[];
};

export type V3ModuleFailurePresentation = {
  outcome: string | null;
  errorCode: string | null;
  retryable: boolean | null;
  limitations: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prefer an explicit page identity diagnostic over a stale/contradictory retry
 * flag. This is a projection only; the immutable EvidenceStore payload remains
 * unchanged and traceable by its attachment ID and content hash.
 */
export function projectV3ModuleFailure(input: {
  data: unknown;
  limitations?: unknown;
}): V3ModuleFailurePresentation {
  const data = isRecord(input.data) ? input.data : {};
  const error = isRecord(data.error) ? data.error : {};
  const diagnostics = isRecord(data.captureDiagnostics) ? data.captureDiagnostics : {};
  const limitations = Array.isArray(input.limitations)
    ? input.limitations.filter((value): value is string => typeof value === "string")
    : [];

  if (diagnostics.bindingReason === "page_asin_anchor_mismatch") {
    return {
      outcome: "FAILED_PERMANENT",
      errorCode: "ASIN_PAGE_ANCHOR_MISMATCH",
      retryable: false,
      limitations: ["page_asin_anchor_mismatch"],
    };
  }

  return {
    outcome: typeof data.outcome === "string" ? data.outcome : null,
    errorCode: typeof error.code === "string"
      ? error.code
      : typeof data.errorCode === "string" ? data.errorCode : null,
    retryable: typeof error.retryable === "boolean" ? error.retryable : null,
    limitations,
  };
}

/** Read only a persisted Detail Enrichment Worker result with its evidence binding intact. */
export function readProductBatchDetailEnrichment(value: unknown): ProductBatchDetailEnrichment | null {
  let product = value;
  if (typeof product === "string") {
    try {
      product = JSON.parse(product) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(product) || !isRecord(product.enrichment)) return null;
  const enrichment = product.enrichment;
  if (enrichment.schemaVersion !== "amazon-batch-detail-enrichment.v1" || enrichment.module !== "amazon_detail") return null;
  if (enrichment.status !== "enriched" && enrichment.status !== "captured_partial") return null;
  if (typeof enrichment.evidenceId !== "string" || !enrichment.evidenceId.trim()) return null;
  if (typeof enrichment.evidenceVersion !== "number" || !Number.isInteger(enrichment.evidenceVersion) || enrichment.evidenceVersion < 1) return null;
  if (typeof enrichment.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(enrichment.contentHash)) return null;
  if (typeof enrichment.capturedAt !== "string" || !Number.isFinite(Date.parse(enrichment.capturedAt))) return null;
  if (typeof product.asin === "string" && /^[A-Z0-9]{10}$/iu.test(product.asin)
    && typeof enrichment.asin === "string" && enrichment.asin.toUpperCase() !== product.asin.toUpperCase()) return null;
  if (enrichment.subjectKey !== undefined
    && (typeof product.asin !== "string" || enrichment.subjectKey !== `amazon:US:${product.asin.toUpperCase()}`)) return null;
  const fields = Array.isArray(enrichment.fields)
    ? [...new Set(enrichment.fields.filter((field): field is string => typeof field === "string" && field.trim().length > 0))]
    : [];
  // G-03：字段级来源只在完全通过证据完整性校验时透出；否则整块缺省（不猜测、不回退）。
  const provenanceRaw = isRecord(enrichment.fieldProvenance) && Array.isArray(enrichment.fieldProvenance.entries)
    ? enrichment.fieldProvenance
    : null;
  const fieldProvenance: ProductBatchDetailFieldProvenance[] = [];
  if (provenanceRaw) {
    for (const raw of provenanceRaw.entries as unknown[]) {
      if (!isRecord(raw)) continue;
      if (typeof raw.field !== "string" || !raw.field.trim()) continue;
      if (typeof raw.evidenceId !== "string" || !raw.evidenceId.trim()) continue;
      if (typeof raw.evidenceVersion !== "number" || !Number.isInteger(raw.evidenceVersion) || raw.evidenceVersion < 1) continue;
      if (typeof raw.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(raw.contentHash)) continue;
      if (typeof raw.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.capturedAt))) continue;
      fieldProvenance.push({
        field: raw.field,
        evidenceId: raw.evidenceId,
        evidenceVersion: raw.evidenceVersion,
        contentHash: raw.contentHash,
        capturedAt: raw.capturedAt,
      });
    }
  }
  return {
    status: enrichment.status,
    evidenceId: enrichment.evidenceId,
    evidenceVersion: enrichment.evidenceVersion,
    contentHash: enrichment.contentHash,
    capturedAt: enrichment.capturedAt,
    ...(enrichment.captureOrigin === "CAPTURED_NOW" || enrichment.captureOrigin === "REUSED_VALID_EVIDENCE"
      ? { captureOrigin: enrichment.captureOrigin }
      : {}),
    fields,
    ...(fieldProvenance.length > 0 ? { fieldProvenance } : {}),
  };
}

/** Completeness of a review_voc evidence payload, counted from the persisted review cards. */
export type ReviewEvidenceCounts = {
  reviewCount: number;
  fullReviewCount: number;
  partialReviewCount: number;
};

function asTextValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Count review completeness from a review_voc evidence payload. Only a review
 * card with `completeness: "full"` and a real body is a full review; public
 * Top-Reviews snippets are partial evidence.
 */
export function countReviewEvidence(data: unknown): ReviewEvidenceCounts {
  const record = isRecord(data) ? data : {};
  const reviews = Array.isArray(record.reviews) ? record.reviews.filter(isRecord) : [];
  return {
    reviewCount: reviews.length,
    fullReviewCount: reviews.filter((item) => item.completeness === "full" && asTextValue(item.reviewText) !== null).length,
    partialReviewCount: reviews.filter((item) => item.completeness === "partial" && asTextValue(item.reviewText) !== null).length,
  };
}

/**
 * Translate a module-specific V3 result into the states shown to product users.
 *
 * Pass `reviewEvidence` for the review_voc module. A review module that only
 * captured public Top-Reviews snippets (no full review body) can never be
 * COMPLETE, even when the stored capture recorded `outcome: "COMPLETE"`.
 */
export function projectV3ModuleStatus(input: {
  status: V3ModuleEvidenceStatus;
  outcome?: string | null;
  errorCode?: string | null;
  detailEnrichmentStatus?: ProductBatchDetailEnrichment["status"] | null;
  reviewEvidence?: ReviewEvidenceCounts | null;
}): ProductModuleStatus {
  if (input.reviewEvidence && input.reviewEvidence.reviewCount > 0 && input.reviewEvidence.fullReviewCount === 0) {
    return "CAPTURED_PARTIAL";
  }
  if (input.status === "VALIDATED_AVAILABLE" && input.detailEnrichmentStatus === "captured_partial") {
    return "CAPTURED_PARTIAL";
  }
  if (input.outcome === "COMPLETE") return "COMPLETE";
  if (input.outcome === "CAPTURED_PARTIAL") return "CAPTURED_PARTIAL";
  if (input.outcome === "NO_DATA_WITH_EVIDENCE") return "NO_DATA_WITH_EVIDENCE";
  const code = input.errorCode?.toUpperCase() ?? "";
  if (/LOGIN_REQUIRED|SIGN_IN_REQUIRED|AUTH_REQUIRED/u.test(code)) return "LOGIN_REQUIRED";
  if (/EXTENSION_REQUIRED|EXTENSION_NOT_FOUND/u.test(code)) return "EXTENSION_REQUIRED";
  if (input.status === "PLAN_LIMITATION" || /PLAN_LIMITED|PLAN_LIMITATION/u.test(code)) return "PLAN_LIMITED";
  if (input.outcome === "FAILED_HUMAN") return "HUMAN_ACTION_REQUIRED";

  switch (input.status) {
    case "VALIDATED_AVAILABLE": return "COMPLETE";
    case "AVAILABLE_WITH_LIMITATION":
      return "AVAILABLE_WITH_LIMITATION";
    case "BLOCKED_WITH_EVIDENCE": return "BLOCKED_WITH_EVIDENCE";
    case "HUMAN_ACTION_REQUIRED": return "HUMAN_ACTION_REQUIRED";
    case "UNVERIFIED": return "CAPTURED_PARTIAL";
  }
  return "CAPTURED_PARTIAL";
}
