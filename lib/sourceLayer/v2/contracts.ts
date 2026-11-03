/** Source Layer V2 additive contracts. V1 CapturePackage/Evidence remain readable. */
import { contentHashOf } from "@/lib/sourceLayer/sourceAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";

export const CAPTURE_EVENT_SCHEMA = "capture-event.v1" as const;
export const CONTENT_VERSION_SCHEMA = "content-version.v1" as const;
export const TREND_OBSERVATION_SCHEMA = "trend-observation.v1" as const;
export const RESEARCH_INPUT_BUNDLE_SCHEMA = "research-input-bundle.v1" as const;

export type CaptureEvent = {
  schemaVersion: typeof CAPTURE_EVENT_SCHEMA;
  eventId: string;
  traceId: string;
  captureId: string;
  subjectKey: string;
  sourceType: CaptureSourceType;
  capturedAt: string;
  pageTemplateHash: string | null;
  recipeVersion: string | null;
  status: "received" | "succeeded" | "failed" | "blocked" | "human_required";
  contentHash: string | null;
  evidenceRefs: string[];
  errorCode: string | null;
};

export type ContentVersion = {
  schemaVersion: typeof CONTENT_VERSION_SCHEMA;
  contentVersionId: string;
  subjectKey: string;
  sourceType: CaptureSourceType;
  capturedAt: string;
  version: number;
  semanticContentHash: string;
  content: Record<string, unknown>;
  evidenceRefs: string[];
};

export type TrendObservationValue = string | number | boolean | null;

export type TrendObservation = {
  schemaVersion: typeof TREND_OBSERVATION_SCHEMA;
  observationId: string;
  subjectKey: string;
  field: string;
  value: TrendObservationValue;
  valueKind: "observed" | "estimated" | "derived" | "missing";
  sourceType: CaptureSourceType;
  capturedAt: string;
  capturedDate: string;
  contentHash: string;
  dedupeKey: string;
  evidenceRefs: string[];
};

export type ResearchInputBundleEvidenceRef = {
  readonly refId: string;
  readonly kind: "product_evidence" | "attachment" | "trend_observation";
  readonly subjectKey: string;
  readonly evidenceId: string;
  readonly captureId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly attachmentId?: string;
};

/* ── PH3：第三方 Provider 结构化字段的只读研究输入 ───────────────────── */

export const PROVIDER_METRIC_EVIDENCE_SCHEMA = "provider-metric-evidence.v1" as const;

/** Provider 指标单位语义；不得与 Amazon 实测单位混用。 */
export type ProviderMetricUnit = "count" | "ratio" | "percent" | "currency" | "unknown";

/** 单条 Provider 指标。metricNature 只允许 provider_estimate / provider_observed。 */
export type ResearchProviderMetric = {
  readonly metric: string;
  readonly value: number | null;
  readonly unit: ProviderMetricUnit;
  readonly metricNature: "provider_estimate" | "provider_observed";
  readonly status: "parsed" | "unknown";
  readonly raw: string | null;
};

export type ResearchProviderKeywordRow = {
  readonly rowKey: string;
  readonly keyword: string;
  readonly status: "valid" | "partial";
  readonly metrics: readonly ResearchProviderMetric[];
};

/**
 * 已持久化 SellerSprite 结构化字段的研究输入。
 *
 * 铁律：
 * - 来源身份绑定到**具体 EvidenceStore 附件**（`evidenceRefId` 必须存在于
 *   `ResearchInputBundle.sourceEvidenceRefs`），**不借用当前 Evidence 的 ID 包装第三方字段**；
 * - 指标性质恒为 provider_estimate / provider_observed，**绝不等同 Amazon confirmed**；
 * - 证据未声明的 `observedAt` / `metricPeriod` 保持 null，不推断；
 * - 缺失数值保持 null，不转成 0。
 */
export type ResearchProviderMetricEvidence = {
  readonly schemaVersion: typeof PROVIDER_METRIC_EVIDENCE_SCHEMA;
  readonly provider: string;
  readonly module: string;
  readonly subjectKey: string;
  readonly queryIdentity: {
    readonly subjectKey: string;
    readonly marketplace: string;
    readonly asin: string | null;
  };
  readonly sourceType: string;
  readonly sourceSurface: string;
  readonly sourceUrl: string | null;
  /** 必须存在于 bundle.sourceEvidenceRefs；否则该条整体不进入 bundle。 */
  readonly evidenceRefId: string;
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  /** Provider 自身更新时间；证据未提供时保持 null。 */
  readonly observedAt: string | null;
  /** 指标周期；证据未声明时保持 null。 */
  readonly metricPeriod: string | null;
  readonly metricNature: "provider_estimate" | "provider_observed";
  readonly limitations: readonly string[];
  readonly rows: readonly ResearchProviderKeywordRow[];
};

export type CustomerVoiceResearchEvidence = {
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly source: "amazon_review" | "reddit_post" | "reddit_comment" | "manual_voc";
  readonly observationCount: number;
  readonly omittedCount: number;
  readonly observations: readonly {
    readonly refId: string;
    readonly externalContentId: string;
    readonly contentHash: string;
    readonly source: "amazon_review" | "reddit_post" | "reddit_comment" | "manual_voc";
    readonly evidenceRefs: readonly string[];
    /** Source attachment sampling/access limits retained through canonical normalization. */
    readonly limitations?: readonly string[];
    readonly parentContentId: string | null;
    readonly threadId: string | null;
    readonly subreddit: string | null;
    readonly depth: number | null;
    readonly contentType: "review" | "post" | "comment" | "social_post";
    readonly title: string | null;
    readonly text: string;
    readonly rating: number | null;
    readonly verifiedPurchase: boolean | null;
    readonly publishedAt: string | null;
    readonly engagement: { readonly score: number | null; readonly commentCount: number | null } | null;
    readonly authorRef: string | null;
    readonly provenance: {
      readonly provider: "amazon_dom" | "reddit_browser" | "manual_import";
      readonly method: "capture_v3_amazon_review" | "public_reddit_browser" | "manual_import";
      readonly accessBasis: "first_party_visible_page" | "public_visible_page" | "user_supplied_file" | "user_supplied_text";
      readonly sourceAttachmentId: string | null;
      readonly rawArtifactId: string | null;
      readonly providerTermsVersion: string | null;
    };
    readonly identityMatch: "EXACT" | "VARIANT" | "FAMILY" | "PROBABLE" | "UNRESOLVED";
    readonly ownerExperience: {
      readonly claimedOwnership: boolean | null;
      readonly ownershipDuration: string | null;
      readonly useCase: string | null;
      readonly failureMode: string | null;
      readonly timeToFailure: string | null;
      readonly replacementProduct: string | null;
      readonly switchReason: string | null;
    } | null;
  }[];
};

export type ResearchVariationEvidenceProjection = {
  readonly schemaVersion: "variation-evidence-projection.v1";
  readonly subjectKey: string;
  readonly subjectAsin: string;
  readonly outcome: "complete" | "partial" | "no_variation_with_evidence" | "human_required"
    | "retryable_failure" | "missing" | "unknown" | "identity_conflict" | "status_conflict";
  readonly completeness: "complete" | "partial" | "none" | "unavailable";
  readonly parentAsin: string | null;
  readonly memberAsins: readonly string[];
  readonly members: readonly {
    readonly asin: string;
    readonly options: readonly { readonly dimensionKey: string; readonly label: string | null; readonly value: string }[];
    readonly evidenceRefs: readonly ResearchInputBundleEvidenceRef[];
  }[];
  readonly relations: readonly {
    readonly fromAsin: string;
    readonly toAsin: string;
    readonly relation: "parent" | "child" | "peer";
    readonly evidenceRefs: readonly ResearchInputBundleEvidenceRef[];
  }[];
  readonly evidenceRefs: readonly ResearchInputBundleEvidenceRef[];
  readonly limitation: string | null;
};

export type ResearchInputBundle = {
  schemaVersion: typeof RESEARCH_INPUT_BUNDLE_SCHEMA;
  taskId: string;
  candidateId: string;
  subjectKey: string;
  productFact: ProductFact | null;
  sourceEvidenceRefs: readonly ResearchInputBundleEvidenceRef[];
  keywordEvidence: readonly SourceEvidenceAttachment[];
  reviewEvidence: readonly SourceEvidenceAttachment[];
  /** Canonical EvidenceStore-only buyer voice projection; it never writes ProductFact. */
  customerVoiceEvidence?: readonly CustomerVoiceResearchEvidence[];
  /** Latest identity-bound variation projection; unknown and failure outcomes stay explicit. */
  variationEvidence?: ResearchVariationEvidenceProjection;
  trendObservations: readonly TrendObservation[];
  /**
   * PH3：已持久化第三方 Provider 结构化字段（SellerSprite typed rows）。
   * 只读、带附件级来源绑定；缺省表示该 subject 没有可绑定的 typed provider 证据。
   */
  providerMetricEvidence?: readonly ResearchProviderMetricEvidence[];
  missingFields: readonly string[];
  conflicts: readonly string[];
  freshness: { latestCapturedAt: string | null; ageDays: number | null };
  traceId: string | null;
};

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableClone(object[key])]));
}

/** 语义内容指纹不包含 capturedAt/captureId/version 等事件元数据。 */
export function semanticContentHash(content: unknown): string {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return contentHashOf(stableClone(content));
  }
  const record = { ...(content as Record<string, unknown>) };
  delete record.capturedAt;
  delete record.captureId;
  delete record.version;
  delete record.contentVersionId;
  return contentHashOf(stableClone(record));
}

export function capturedDateOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("TREND_CAPTURED_AT_INVALID");
  return date.toISOString().slice(0, 10);
}

export function buildTrendObservation(input: Omit<TrendObservation, "schemaVersion" | "capturedDate" | "contentHash" | "dedupeKey">): TrendObservation {
  const capturedDate = capturedDateOf(input.capturedAt);
  const contentHash = semanticContentHash({
    subjectKey: input.subjectKey,
    field: input.field,
    value: input.value,
    valueKind: input.valueKind,
    sourceType: input.sourceType,
    evidenceRefs: input.evidenceRefs,
  });
  const dedupeKey = contentHashOf({
    subjectKey: input.subjectKey,
    field: input.field,
    capturedDate,
    contentHash,
  });
  return {
    ...input,
    schemaVersion: TREND_OBSERVATION_SCHEMA,
    capturedDate,
    contentHash,
    dedupeKey,
    evidenceRefs: [...new Set(input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))].slice(0, 32),
  };
}

export function parseTrendObservation(value: unknown): TrendObservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TREND_OBSERVATION_SCHEMA
    || typeof record.observationId !== "string"
    || typeof record.subjectKey !== "string"
    || typeof record.field !== "string"
    || !SOURCE_TYPES.includes(record.sourceType as CaptureSourceType)
    || typeof record.capturedAt !== "string"
    || Number.isNaN(Date.parse(record.capturedAt))
    || typeof record.capturedDate !== "string"
    || typeof record.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(record.contentHash)
    || typeof record.dedupeKey !== "string"
    || !/^[a-f0-9]{64}$/.test(record.dedupeKey)
    || !["observed", "estimated", "derived", "missing"].includes(String(record.valueKind))
    || !Array.isArray(record.evidenceRefs)
    || record.evidenceRefs.some((ref) => typeof ref !== "string")) {
    return null;
  }
  return record as unknown as TrendObservation;
}
