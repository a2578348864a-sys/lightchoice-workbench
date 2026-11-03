/**
 * V3.4 — Review Evidence（review-evidence.v1）Dataset 层
 *
 * 真实 Review 样本的规范化 / 去重 / 有界存储 / 统计。
 * 铁律：一条评论 ≠ 市场事实；Review 是用户观点证据（nature=source_snapshot/review_observation），
 * 永不升级为 human_confirmed_product_fact；实体绑定（ASIN + sourceProductRole）无法证明 → 不保存。
 */
import { createHash, randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import {
  TaskResultJsonMutationError,
  mutateTaskResultJson,
  type TaskResultJsonStorageVersionInput,
} from "@/lib/server/taskResultJsonMutation";
import { isSandboxTaskId, getSandboxTask } from "@/lib/server/demoSandbox";
import { prisma } from "@/lib/server/db";
import { getResearchTaskCandidateId } from "@/lib/productResearchImage";
import { parseSourceEvidenceRefs, type SourceEvidenceRef } from "@/lib/sourceLayer/evidenceRefs";
import {
  captureEvidenceAttachmentThroughGateway,
  type CaptureGatewaySource,
} from "@/lib/sourceLayer/server/captureGateway";
import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { newSpanId, newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";

export const REVIEW_EVIDENCE_SCHEMA = "review-evidence.v1" as const;
export const REVIEW_EVIDENCE_NAMESPACE = "reviewEvidence" as const;
export const VOC_ANALYSIS_NAMESPACE = "vocAnalysis" as const;
export const REVIEW_IMPORTER_VERSION = "review-importer.v1" as const;

/* ── 有界存储（bounded dataset） ── */
export const REVIEW_DATASET_MAX_REVIEWS = 300;
export const REVIEW_DATASET_MAX_PER_ASIN = 100;
export const REVIEW_TEXT_MAX_CHARS = 2000;
export const REVIEW_ITEM_MAX_BYTES = 4 * 1024;
export const REVIEW_DATASET_MAX_BYTES = 256 * 1024;

export type ReviewSourceProductRole = "current_candidate" | "competitor";
export type ReviewNature = "source_snapshot" | "review_observation";
export type ReviewBindingKind = "manual_confirmed" | "browser_verified" | "source_declared";

export type ReviewItem = {
  evidenceId: string;
  reviewId: string | null;
  productAsin: string;
  sourceProductRole: ReviewSourceProductRole;
  sourceType: "manual_import" | "browser";
  sourceSite: "amazon" | null;
  sourceUrl: string | null;
  sourceRef: string | null;
  reviewTitle: string | null;
  reviewText: string;
  rating: number | null;
  reviewDate: string | null;
  verifiedPurchase: boolean | null;
  locale: string | null;
  language: string | null;
  capturedAt: string;
  importerVersion: string;
  collectorVersion: string | null;
  entityBindingProof: {
    asin: string;
    sourceProductRole: ReviewSourceProductRole;
    binding: ReviewBindingKind;
    note: string | null;
  };
  contentHash: string;
  duplicateKey: string;
  nature: ReviewNature;
};

export type DatasetStats = {
  totalReviews: number;
  reviewsUsed: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  ratingDistribution: Array<{ rating: 1 | 2 | 3 | 4 | 5; count: number }>;
  capturePeriod: { from: string | null; to: string | null };
  sourceProductCount: number;
  currentCandidateCount: number;
  competitorCount: number;
};

export type ReviewEvidenceV1 = {
  schema: typeof REVIEW_EVIDENCE_SCHEMA;
  version: 1;
  candidateId: string | null;
  dataset: {
    reviews: ReviewItem[];
    stats: DatasetStats;
    sampling: {
      method: "manual_selected" | "browser_assisted" | "source_order";
      note: string | null;
      reviewsAvailable: number | null;
    };
    updatedAt: string;
  };
  /** 原始评论 attachment 在同一 Source Layer 中的只读引用。 */
  sourceEvidenceRefs?: SourceEvidenceRef[];
};

export type ReviewImportInput = {
  asin: string;
  sourceProductRole: ReviewSourceProductRole;
  reviewText: string;
  rating?: number | null;
  reviewTitle?: string | null;
  reviewId?: string | null;
  reviewDate?: string | null;
  verifiedPurchase?: boolean | null;
  locale?: string | null;
  language?: string | null;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  bindingNote?: string | null;
  /** Package C：浏览器采集标记（半自动 Review Collector）；缺省人工导入 */
  sourceType?: "browser" | "manual_import";
  bindingKind?: "browser_verified" | "manual_confirmed";
  collectorVersion?: string;
};

export class ReviewEvidenceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

/** 规范化评论文本（去重用）：trim + 压缩空白 + 小写；原文保留在 reviewText */
export function normalizeReviewText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildReviewContentHash(reviewText: string): string {
  return createHash("sha256").update(normalizeReviewText(reviewText), "utf8").digest("hex");
}

export function buildReviewDuplicateKey(input: {
  reviewId: string | null;
  asin: string;
  contentHash: string;
  rating: number | null;
  reviewDate: string | null;
}): string {
  if (input.reviewId) return `rid:${input.reviewId}`;
  return `key:${input.asin}|${input.contentHash}|${String(input.rating ?? "")}|${input.reviewDate ?? ""}`;
}

export function isValidAsin(value: string): boolean {
  return /^[A-Z0-9]{10}$/.test(value);
}

/* ── parse（read fail-soft：坏/未知旧记录安全忽略） ── */

export function parseReviewEvidence(value: unknown): ReviewEvidenceV1 | null {
  if (!isRecord(value)) return null;
  if (value.schema !== REVIEW_EVIDENCE_SCHEMA || value.version !== 1) return null;
  const dataset = isRecord(value.dataset) ? value.dataset : null;
  if (!dataset || !Array.isArray(dataset.reviews) || dataset.reviews.length > REVIEW_DATASET_MAX_REVIEWS) return null;
  const reviews: ReviewItem[] = [];
  for (const raw of dataset.reviews) {
    const review = parseReviewItem(raw);
    if (!review) return null;
    reviews.push(review);
  }
  const stats = isRecord(dataset.stats) ? dataset.stats : null;
  if (!stats) return null;
  const sampling = isRecord(dataset.sampling) ? dataset.sampling : null;
  if (!sampling) return null;
  const candidateId = value.candidateId == null ? null : text(value.candidateId, 120);
  if (value.candidateId != null && candidateId === null) return null;
  const sourceEvidenceRefs = value.sourceEvidenceRefs === undefined
    ? undefined
    : parseSourceEvidenceRefs(value.sourceEvidenceRefs);
  if (value.sourceEvidenceRefs !== undefined && sourceEvidenceRefs === null) return null;
  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    version: 1,
    candidateId,
    dataset: {
      reviews,
      stats: stats as unknown as DatasetStats,
      sampling: {
        method: sampling.method === "browser_assisted" || sampling.method === "source_order" ? sampling.method : "manual_selected",
        note: sampling.note === null ? null : text(sampling.note, 300),
        reviewsAvailable: typeof sampling.reviewsAvailable === "number" && sampling.reviewsAvailable > 0 ? sampling.reviewsAvailable : null,
      },
      updatedAt: text(dataset.updatedAt, 40) ?? "",
    },
    ...(sourceEvidenceRefs ? { sourceEvidenceRefs } : {}),
  };
}

function parseReviewItem(value: unknown): ReviewItem | null {
  if (!isRecord(value)) return null;
  const evidenceId = text(value.evidenceId, 64);
  if (!evidenceId || !/^[a-z0-9-]{8,64}$/i.test(evidenceId)) return null;
  const productAsin = text(value.productAsin, 16);
  if (!productAsin || !isValidAsin(productAsin)) return null;
  if (value.sourceProductRole !== "current_candidate" && value.sourceProductRole !== "competitor") return null;
  if (value.nature !== "source_snapshot" && value.nature !== "review_observation") return null;
  const reviewText = text(value.reviewText, REVIEW_TEXT_MAX_CHARS);
  if (!reviewText) return null;
  const rating = value.rating;
  if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)) return null;
  const binding = isRecord(value.entityBindingProof) ? value.entityBindingProof : null;
  if (!binding) return null;
  if (binding.asin !== productAsin || binding.sourceProductRole !== value.sourceProductRole) return null;
  if (binding.binding !== "manual_confirmed" && binding.binding !== "browser_verified" && binding.binding !== "source_declared") return null;
  const contentHash = text(value.contentHash, 64);
  const duplicateKey = text(value.duplicateKey, 200);
  if (!contentHash || !duplicateKey) return null;
  const capturedAt = text(value.capturedAt, 40);
  if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return null;
  const reviewId = value.reviewId === null ? null : text(value.reviewId, 120);
  if (value.reviewId !== null && reviewId === null) return null;
  return {
    evidenceId,
    reviewId,
    productAsin,
    sourceProductRole: value.sourceProductRole as ReviewSourceProductRole,
    sourceType: value.sourceType === "browser" ? "browser" : "manual_import",
    sourceSite: value.sourceSite === "amazon" ? "amazon" : null,
    sourceUrl: value.sourceUrl === null ? null : text(value.sourceUrl, 2048),
    sourceRef: value.sourceRef === null ? null : text(value.sourceRef, 300),
    reviewTitle: value.reviewTitle === null ? null : text(value.reviewTitle, 200),
    reviewText,
    rating: rating as number | null,
    reviewDate: value.reviewDate === null ? null : text(value.reviewDate, 40),
    verifiedPurchase: value.verifiedPurchase === null || value.verifiedPurchase === undefined ? null : value.verifiedPurchase === true,
    locale: value.locale === null ? null : text(value.locale, 40),
    language: value.language === null ? null : text(value.language, 40),
    capturedAt,
    importerVersion: text(value.importerVersion, 60) ?? "",
    collectorVersion: value.collectorVersion === null ? null : text(value.collectorVersion, 60),
    entityBindingProof: {
      asin: binding.asin,
      sourceProductRole: binding.sourceProductRole as ReviewSourceProductRole,
      binding: binding.binding as ReviewBindingKind,
      note: binding.note === null ? null : text(binding.note, 200),
    },
    contentHash,
    duplicateKey,
    nature: value.nature as ReviewNature,
  };
}

/* ── Dataset 统计（deterministic） ── */

export function computeDatasetStats(reviews: readonly ReviewItem[]): DatasetStats {
  const ratingDistribution = ([1, 2, 3, 4, 5] as const).map((rating) => ({
    rating,
    count: reviews.filter((review) => review.rating === rating).length,
  }));
  const dates = reviews
    .map((review) => review.reviewDate)
    .filter((date): date is string => !!date && !Number.isNaN(Date.parse(date)))
    .sort();
  const asins = new Set(reviews.map((review) => review.productAsin));
  return {
    totalReviews: reviews.length,
    reviewsUsed: reviews.length,
    positiveCount: reviews.filter((review) => (review.rating ?? 0) >= 4).length,
    negativeCount: reviews.filter((review) => (review.rating ?? 0) <= 2).length,
    neutralCount: reviews.filter((review) => review.rating === 3).length,
    ratingDistribution,
    capturePeriod: {
      from: dates.length > 0 ? dates[0] : null,
      to: dates.length > 0 ? dates[dates.length - 1] : null,
    },
    sourceProductCount: asins.size,
    currentCandidateCount: reviews.filter((review) => review.sourceProductRole === "current_candidate").length,
    competitorCount: reviews.filter((review) => review.sourceProductRole === "competitor").length,
  };
}

/* ── 构建单条 Review（import 时） ── */

export function buildReviewItem(input: ReviewImportInput, capturedAt: string): ReviewItem {
  const asin = input.asin.trim().toUpperCase();
  if (!isValidAsin(asin)) {
    throw new ReviewEvidenceError("invalid_asin", 400, "ASIN 格式无效（应为 10 位大写字母数字）。");
  }
  const reviewText = input.reviewText.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!reviewText) {
    throw new ReviewEvidenceError("invalid_review_text", 400, "评论内容为空。");
  }
  if (reviewText.length > REVIEW_TEXT_MAX_CHARS) {
    throw new ReviewEvidenceError(
      "review_text_too_long",
      413,
      `单条评论超过 ${REVIEW_TEXT_MAX_CHARS} 字符上限，已拒绝。`,
    );
  }
  const rating = input.rating === null || input.rating === undefined
    ? null
    : input.rating;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new ReviewEvidenceError("invalid_rating", 400, "星级无效（应为 1-5 整数）。");
  }
  const contentHash = buildReviewContentHash(reviewText);
  const sourceType = input.sourceType === "browser" ? "browser" : "manual_import";
  const item: ReviewItem = {
    evidenceId: randomUUID(),
    reviewId: input.reviewId?.trim() ? input.reviewId.trim().slice(0, 120) : null,
    productAsin: asin,
    sourceProductRole: input.sourceProductRole,
    sourceType,
    sourceSite: input.sourceUrl && /amazon\.com/i.test(input.sourceUrl) ? "amazon" : null,
    sourceUrl: input.sourceUrl?.trim() ? input.sourceUrl.trim().slice(0, 2048) : null,
    sourceRef: input.sourceRef?.trim() ? input.sourceRef.trim().slice(0, 300) : null,
    reviewTitle: input.reviewTitle?.trim() ? input.reviewTitle.trim().slice(0, 200) : null,
    reviewText,
    rating,
    reviewDate: input.reviewDate?.trim() ? input.reviewDate.trim().slice(0, 40) : null,
    verifiedPurchase: input.verifiedPurchase ?? null,
    locale: input.locale?.trim() ? input.locale.trim().slice(0, 40) : null,
    language: input.language?.trim() ? input.language.trim().slice(0, 40) : null,
    capturedAt,
    importerVersion: REVIEW_IMPORTER_VERSION,
    collectorVersion: sourceType === "browser"
      ? (input.collectorVersion?.trim() ? input.collectorVersion.trim().slice(0, 60) : "unknown-browser-collector")
      : null,
    entityBindingProof: {
      asin,
      sourceProductRole: input.sourceProductRole,
      binding: input.bindingKind === "browser_verified" ? "browser_verified" : "manual_confirmed",
      note: input.bindingNote?.trim() ? input.bindingNote.trim().slice(0, 200) : null,
    },
    contentHash,
    duplicateKey: buildReviewDuplicateKey({
      reviewId: input.reviewId?.trim() ? input.reviewId.trim() : null,
      asin,
      contentHash,
      rating,
      reviewDate: input.reviewDate?.trim() ? input.reviewDate.trim() : null,
    }),
    nature: "review_observation",
  };
  return item;
}

/* ── 读取（fail-soft） ── */

export async function readReviewEvidenceSnapshot(
  context: AccessContext,
  taskId: string,
): Promise<{ updatedAt: Date | string; resultJson: string; candidateId: string | null }> {
  if (context.mode === "demo") {
    if (!isSandboxTaskId(taskId)) {
      throw new ReviewEvidenceError("not_found", 404, "任务不存在。");
    }
    const task = getSandboxTask(context.demoAccessId, taskId);
    if (!task) {
      throw new ReviewEvidenceError("not_found", 404, "任务不存在。");
    }
    return {
      updatedAt: task.updatedAt,
      resultJson: task.resultJson,
      candidateId: getResearchTaskCandidateId(parseResultJson(task.resultJson)),
    };
  }
  if (isSandboxTaskId(taskId)) {
    throw new ReviewEvidenceError("not_found", 404, "任务不存在。");
  }
  const task = await prisma.viralAnalysisRecord.findFirst({
    where: { id: taskId },
    select: { id: true, updatedAt: true, resultJson: true },
  });
  if (!task) {
    throw new ReviewEvidenceError("not_found", 404, "任务不存在。");
  }
  return {
    updatedAt: task.updatedAt,
    resultJson: task.resultJson,
    candidateId: getResearchTaskCandidateId(parseResultJson(task.resultJson)),
  };
}

function parseResultJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function authoritativeReviewAsin(resultJson: string): string | null {
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    const browserEvidence = parsed.browserEvidence as Record<string, unknown> | undefined;
    if (browserEvidence && typeof browserEvidence.targetAsin === "string" && /^[A-Z0-9]{10}$/i.test(browserEvidence.targetAsin)) return browserEvidence.targetAsin.toUpperCase();
    const cac = parsed.candidateAnalysisContext as Record<string, unknown> | undefined;
    const facts = cac ? cac.facts as Record<string, unknown> | undefined : undefined;
    if (facts && typeof facts.asin === "string" && /^[A-Z0-9]{10}$/i.test(facts.asin)) return facts.asin.toUpperCase();
    const v5 = parsed.v5Research as Record<string, unknown> | undefined;
    const report = v5 ? v5.report as Record<string, unknown> | undefined : undefined;
    if (report && typeof report.asin === "string" && /^[A-Z0-9]{10}$/i.test(report.asin)) return report.asin.toUpperCase();
  } catch {
    return null;
  }
  return null;
}

export async function getReviewEvidence(
  context: AccessContext,
  taskId: string,
): Promise<ReviewEvidenceV1 | null> {
  const snapshot = await readReviewEvidenceSnapshot(context, taskId);
  const result = parseResultJson(snapshot.resultJson);
  const raw = result[REVIEW_EVIDENCE_NAMESPACE];
  if (raw !== undefined) {
    const parsed = parseReviewEvidence(raw);
    if (parsed) return parsed;
  }

  // 证据回退投影：当 resultJson 尚未保存 reviewEvidence 节点时，从 EvidenceStore 附件只读提取
  try {
    const asin = authoritativeReviewAsin(snapshot.resultJson);
    if (!asin) return null;
    const { createEvidenceStore } = await import("@/lib/sourceLayer/server/evidenceStore");
    const { sourceLayerOperator } = await import("@/lib/sourceLayer/server/sourceLayerService");
    const store = createEvidenceStore(sourceLayerOperator(context));
    const subject = await store.getSubject(`amazon:US:${asin}`);
    if (!subject || !subject.attachments) return null;
    const reviewAttachments = subject.attachments.filter((a) => a.kind === "review_evidence" || a.kind === "v3_review_voc_v1");
    if (reviewAttachments.length === 0) return null;

    const allReviews: ReviewItem[] = [];
    for (const att of reviewAttachments) {
      const payload = att.payload as Record<string, unknown>;
      const rawList = Array.isArray(payload.reviews)
        ? payload.reviews
        : (isRecord(payload.data) && Array.isArray((payload.data as any).reviews)
            ? (payload.data as any).reviews
            : (isRecord(payload.dataset) && Array.isArray((payload.dataset as any).reviews)
                ? (payload.dataset as any).reviews
                : []));
      for (const item of rawList) {
        if (!isRecord(item)) continue;
        const reviewText = text(item.reviewText ?? item.body ?? item.text, REVIEW_TEXT_MAX_CHARS);
        if (!reviewText) continue;
        const reviewId = text(item.reviewId ?? item.id, 120) ?? `rev-${att.attachmentId.slice(0, 12)}-${allReviews.length}`;
        const rating = typeof item.rating === "number" && item.rating >= 1 && item.rating <= 5 ? item.rating : null;
        allReviews.push({
          evidenceId: reviewId,
          reviewId,
          productAsin: asin,
          sourceProductRole: "current_candidate",
          sourceType: att.sourceType === "amazon_dom" ? "browser" : "manual_import",
          sourceSite: "amazon",
          sourceUrl: att.sourceUrl,
          sourceRef: att.sourceUrl,
          reviewTitle: text(item.reviewTitle ?? item.title, 200),
          reviewText,
          rating,
          reviewDate: text(item.reviewDate ?? item.publishedAt ?? item.date, 40),
          verifiedPurchase: typeof item.verifiedPurchase === "boolean" ? item.verifiedPurchase : null,
          locale: "en_US",
          language: "en",
          capturedAt: att.capturedAt,
          importerVersion: "v5-store-projection",
          collectorVersion: null,
          contentHash: att.contentHash,
          duplicateKey: `${asin}:${reviewId}`,
          nature: "review_observation",
          entityBindingProof: {
            asin,
            sourceProductRole: "current_candidate",
            binding: att.sourceType === "amazon_dom" ? "browser_verified" : "manual_confirmed",
            note: null,
          },
        });
      }
    }
    if (allReviews.length === 0) return null;
    return {
      schema: REVIEW_EVIDENCE_SCHEMA,
      version: 1,
      candidateId: asin,
      dataset: {
        reviews: allReviews,
        stats: {
          totalReviews: allReviews.length,
          reviewsUsed: allReviews.length,
          positiveCount: allReviews.filter((r) => (r.rating ?? 0) >= 4).length,
          negativeCount: allReviews.filter((r) => (r.rating ?? 0) <= 2).length,
          neutralCount: allReviews.filter((r) => r.rating === 3).length,
          ratingDistribution: [1, 2, 3, 4, 5].map((stars) => ({ rating: stars as any, count: allReviews.filter((r) => r.rating === stars).length })),
          capturePeriod: { from: null, to: null },
          sourceProductCount: 1,
          currentCandidateCount: allReviews.length,
          competitorCount: 0,
        },
        sampling: {
          method: "source_order",
          note: "由 EvidenceStore 评论附件只读投影",
          reviewsAvailable: allReviews.length,
        },
        updatedAt: new Date().toISOString(),
      },
      sourceEvidenceRefs: reviewAttachments.map((a) => ({
        subjectKey: subject.subjectKey,
        captureId: "store-projection",
        evidenceId: a.attachmentId,
        version: (subject as any).evidenceVersion ?? 1,
        contentHash: a.contentHash,
        attachmentId: a.attachmentId,
        attachmentHash: a.contentHash,
      })),
    };
  } catch {
    return null;
  }
}

/* ── 写入（import / clear） ── */

export type ReviewImportOutcome = {
  kind: "saved" | "duplicate";
  evidence: ReviewEvidenceV1;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
};

/**
 * Active Source Layer 任务的评论证据绑定目标。
 *
 * 历史/演示任务可能还没有 ProductFact；这些任务保留旧 namespace 兼容路径。
 * 一旦任务已有正式 ProductFact，评论附件必须先经 Capture Gateway 落到同一
 * EvidenceStore，再把只读引用写入 reviewEvidence，避免出现第二套证据存储。
 */
async function resolveReviewAttachmentTarget(
  context: AccessContext,
  taskId: string,
): Promise<{
  subjectKey: string;
  source: CaptureGatewaySource;
  sourceUrl: string | null;
  sourceFingerprint: string;
} | null> {
  try {
    const input = await buildResearchEngineInput({ context, taskId });
    return {
      subjectKey: input.productFact.subjectKey,
      source: input.productFact.sourceProof.source,
      sourceUrl: input.productFact.sourceProof.sourceUrl,
      sourceFingerprint: input.productFact.sourceProof.contentHash,
    };
  } catch {
    // 保留既有历史/演示任务的兼容行为；没有 ProductFact 就不能伪造
    // Source Layer 绑定，也不从标题、ASIN 或旧 fixture 推导 subjectKey。
    return null;
  }
}

async function recordReviewDiagnostic(input: {
  context: AccessContext;
  traceId: string;
  taskId: string;
  sourceEvidenceRefs?: SourceEvidenceRef[];
  status: "succeeded" | "failed";
  reason: string;
  errorCode?: string | null;
}): Promise<void> {
  const ref = input.sourceEvidenceRefs?.[0];
  if (!ref) return;
  await recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId: input.traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: input.taskId,
      captureId: ref.captureId,
      subjectKey: ref.subjectKey,
      module: "REVIEW_EVIDENCE",
      phase: "persist",
      eventType: input.status === "succeeded" ? "review_evidence_saved" : "review_evidence_save_failed",
      severity: input.status === "failed" ? "error" : "info",
      statusBefore: null,
      statusAfter: input.status,
      status: input.status,
      errorCode: input.errorCode ?? null,
      reason: input.reason,
      retryable: input.status === "failed",
      humanRequired: input.status === "failed",
      sourceType: "amazon_dom",
      recipeVersion: "review-evidence.v1",
      pageTemplateHash: null,
      evidenceRefs: [ref.attachmentId, `evidence:${ref.evidenceId}`],
      contentHash: ref.attachmentHash,
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: null,
      attempt: 1,
    },
  }).catch(() => undefined);
}

export async function importReviews(input: {
  context: AccessContext;
  taskId: string;
  expectedStorageVersion: TaskResultJsonStorageVersionInput;
  reviews: ReviewImportInput[];
  sourceEvidenceRefs?: SourceEvidenceRef[];
  traceId?: string;
}): Promise<ReviewImportOutcome> {
  if (input.reviews.length === 0) {
    throw new ReviewEvidenceError("empty_import", 400, "没有可导入的评论。");
  }
  const capturedAt = new Date().toISOString();
  const traceId = input.traceId ?? newTraceId();
  const preparedItems = input.reviews.map((raw) => buildReviewItem(raw, capturedAt));
  for (const item of preparedItems) {
    if (JSON.stringify(item).length > REVIEW_ITEM_MAX_BYTES) {
      throw new ReviewEvidenceError(
        "review_item_too_large",
        413,
        "单条评论超过大小上限（4KB），已拒绝本次导入。请缩小评论内容后重试。",
      );
    }
  }

  const attachmentTarget = await resolveReviewAttachmentTarget(input.context, input.taskId);
  let sourceEvidenceRefs = input.sourceEvidenceRefs;
  if (attachmentTarget) {
    try {
      const attachment = await captureEvidenceAttachmentThroughGateway({
        context: input.context,
        subjectKey: attachmentTarget.subjectKey,
        source: attachmentTarget.source,
        kind: "review_evidence",
        sourceUrl: attachmentTarget.sourceUrl,
        sourceFingerprint: attachmentTarget.sourceFingerprint,
        payload: {
          schemaVersion: "review-evidence-source-attachment.v1",
          importerVersion: REVIEW_IMPORTER_VERSION,
          reviews: preparedItems,
        },
        capturedAt: new Date(capturedAt),
        traceId,
      });
      // 评论证据是商品级附件：没有商品 Evidence 引用即不成立，fail-closed。
      if (!attachment.sourceEvidenceRef) {
        throw new Error("REVIEW_EVIDENCE_SOURCE_REF_MISSING");
      }
      sourceEvidenceRefs = [attachment.sourceEvidenceRef];
      await recordReviewDiagnostic({
        context: input.context,
        traceId,
        taskId: input.taskId,
        sourceEvidenceRefs,
        status: "succeeded",
        reason: "Review source attachment persisted through Capture Gateway.",
      });
    } catch (error) {
      await recordReviewDiagnostic({
        context: input.context,
        traceId,
        taskId: input.taskId,
        sourceEvidenceRefs,
        status: "failed",
        reason: "Review source attachment could not be persisted; task namespace was not updated.",
        errorCode: "PERSISTENCE_FAILED",
      });
      throw new ReviewEvidenceError(
        "source_evidence_persist_failed",
        502,
        error instanceof Error ? `评论来源证据写入失败：${error.message}` : "评论来源证据写入失败。",
      );
    }
  }
  try {
    const outcome = await mutateTaskResultJson({
      context: input.context,
      taskId: input.taskId,
      writer: "review-evidence",
      expectedStorageVersion: input.expectedStorageVersion,
      mutate: (current) => {
        const prior = parseReviewEvidence(current[REVIEW_EVIDENCE_NAMESPACE]);
        const existing = prior?.dataset.reviews ?? [];
        let importedCount = 0;
        let duplicateCount = 0;
        let rejectedCount = 0;
        const seenKeys = new Set(existing.map((review) => review.duplicateKey));
        const nextReviews = [...existing];
        for (const item of preparedItems) {
          // dedupe（reviewId 或 asin+hash+rating+date）
          if (seenKeys.has(item.duplicateKey)) {
            duplicateCount += 1;
            continue;
          }
          // per-ASIN 上限
          const perAsin = nextReviews.filter((review) => review.productAsin === item.productAsin).length;
          if (perAsin >= REVIEW_DATASET_MAX_PER_ASIN) {
            rejectedCount += 1;
            continue;
          }
          seenKeys.add(item.duplicateKey);
          nextReviews.push(item);
          importedCount += 1;
        }
        // 总上限：明确拒绝超限部分（不静默截断），并整体校验 payload 大小
        if (nextReviews.length > REVIEW_DATASET_MAX_REVIEWS) {
          throw new ReviewEvidenceError(
            "review_dataset_limit",
            409,
            `评论数据集已达上限（${REVIEW_DATASET_MAX_REVIEWS} 条），本次导入将超出。请删除部分评论或缩小样本后重试。`,
          );
        }
        const next: ReviewEvidenceV1 = {
          schema: REVIEW_EVIDENCE_SCHEMA,
          version: 1,
          candidateId: prior?.candidateId ?? getResearchTaskCandidateId(current),
          dataset: {
            reviews: nextReviews,
            stats: computeDatasetStats(nextReviews),
            sampling: prior?.dataset.sampling ?? { method: "manual_selected", note: null, reviewsAvailable: null },
            updatedAt: new Date().toISOString(),
          },
          ...(sourceEvidenceRefs
            ? { sourceEvidenceRefs }
            : prior?.sourceEvidenceRefs
              ? { sourceEvidenceRefs: prior.sourceEvidenceRefs }
              : {}),
        };
        if (JSON.stringify(next).length > REVIEW_DATASET_MAX_BYTES) {
          throw new ReviewEvidenceError(
            "review_dataset_too_large",
            413,
            `评论数据集超过大小上限（${REVIEW_DATASET_MAX_BYTES / 1024}KB），请缩小样本后重试。`,
          );
        }
        return {
          result: { ...current, [REVIEW_EVIDENCE_NAMESPACE]: next },
          value: { importedCount, duplicateCount, rejectedCount, next },
        };
      },
    });
    const value = outcome.value as { importedCount: number; duplicateCount: number; rejectedCount: number; next: ReviewEvidenceV1 };
    await recordReviewDiagnostic({
      context: input.context,
      traceId,
      taskId: input.taskId,
      sourceEvidenceRefs: value.next.sourceEvidenceRefs,
      status: "succeeded",
      reason: "ReviewEvidence namespace saved after source attachment binding.",
    });
    return {
      kind: value.importedCount > 0 ? "saved" : "duplicate",
      evidence: value.next,
      importedCount: value.importedCount,
      duplicateCount: value.duplicateCount,
      rejectedCount: value.rejectedCount,
    };
  } catch (error) {
    await recordReviewDiagnostic({
      context: input.context,
      traceId,
      taskId: input.taskId,
      sourceEvidenceRefs,
      status: "failed",
      reason: "ReviewEvidence namespace mutation failed; no unverified result was returned.",
      errorCode: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "PERSISTENCE_FAILED",
    });
    if (error instanceof ReviewEvidenceError) throw error;
    if (error instanceof TaskResultJsonMutationError) {
      throw new ReviewEvidenceError(error.code, error.status, error.message);
    }
    throw error;
  }
}

export async function clearReviews(input: {
  context: AccessContext;
  taskId: string;
  expectedStorageVersion: TaskResultJsonStorageVersionInput;
}): Promise<{ cleared: boolean }> {
  try {
    const outcome = await mutateTaskResultJson({
      context: input.context,
      taskId: input.taskId,
      writer: "review-evidence",
      expectedStorageVersion: input.expectedStorageVersion,
      mutate: (current) => {
        const prior = parseReviewEvidence(current[REVIEW_EVIDENCE_NAMESPACE]);
        if (!prior || prior.dataset.reviews.length === 0) {
          return { result: current, value: { cleared: false } };
        }
        const next: ReviewEvidenceV1 = {
          schema: REVIEW_EVIDENCE_SCHEMA,
          version: 1,
          candidateId: prior.candidateId,
          dataset: {
            reviews: [],
            stats: computeDatasetStats([]),
            sampling: prior.dataset.sampling,
            updatedAt: new Date().toISOString(),
          },
        };
        const after: Record<string, unknown> = { ...current, [REVIEW_EVIDENCE_NAMESPACE]: next };
        // 清空 dataset 时同步清除旧的 VOC 分析（避免陈旧结论指向已删除样本）
        delete after[VOC_ANALYSIS_NAMESPACE];
        return { result: after, value: { cleared: true } };
      },
    });
    return outcome.value as { cleared: boolean };
  } catch (error) {
    if (error instanceof ReviewEvidenceError) throw error;
    if (error instanceof TaskResultJsonMutationError) {
      throw new ReviewEvidenceError(error.code, error.status, error.message);
    }
    throw error;
  }
}
