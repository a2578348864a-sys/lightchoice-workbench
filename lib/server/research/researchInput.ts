import "server-only";

import { V1_DEFAULT_TIMEOUT_MS, V1_MAX_OUTPUT_TOKENS } from "./researchOutputLimits";

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/server/db";
import {
  parseEvidencePromotionReference,
  resolveEvidencePromotionProductFact,
} from "@/lib/sourceLayer/server/evidencePromotionReference";
import type { AccessContext } from "@/lib/server/accessPassword";
import { getSandboxCandidate, getSandboxTask, isSandboxTaskId } from "@/lib/server/demoSandbox";
import type {
  FactField,
  ProductFact,
  ProductFactKeywordEvidenceInput,
  ProductFactSource,
} from "@/lib/sourceLayer/fact/types";
import { amazonDetailHistoryOriginsOf } from "@/lib/sourceLayer/amazonDetailFieldHistory";
import {
  keywordEvidenceInputFromAttachment,
  withKeywordEvidence,
} from "@/lib/sourceLayer/fact/productFactAdapter";
import {
  adaptV3HistoricalTrendAttachment,
  adaptV3KeywordAttachment,
  adaptV3ReviewAttachment,
  deduplicateReviewEvidence,
} from "@/lib/server/research/v3EvidenceResearchAdapter";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { parseCustomerVoiceAttachmentPayload } from "@/lib/sourceLayer/customerVoice";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import {
  RESEARCH_ENGINE_SCHEMA,
  type ResearchConfig,
  type ResearchEngineInput,
  type ResearchEvidenceRef,
  type ReviewEvidenceSummaryItem,
  type ReviewEvidenceSample,
} from "@/lib/research/researchContracts";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { readVerifiedCandidateFact } from "@/lib/server/research/candidateFactRead";

const PRODUCT_FACT_SOURCES = new Set<ProductFactSource>([
  "amazon_dom",
  "sellersprite_plugin",
  "sellersprite_xlsx",
  "keepa_export",
  "manual",
]);

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
  locale: "zh-CN",
  focus: ["market", "competition", "voc", "differentiation"],
  // 2026-10-29 真实调用实测记录（不要退回这些值）：
  //  - 2400 必截断（completion=2400 触顶）；
  //  - 4000 也不安全：#3 旧/新提示词各 1 次真实调用都在 4000 触顶（3998 / 4000，
  //    finish_reason=length，整段 JSON 不闭合，无法产出 ResearchReport）；
  //  - 12000 为本轮确定值：官方 `GET /models` 显示 deepseek-flash 的
  //    max_output_tokens=393,216、context_window=1,048,576，12000 远在能力内，
  //    且 145,000 输入上限 + 12,000 输出上限 = 157,000 << 上下文窗口。
  // 该值必须与路由允许区间、闸的 CHAIN_OUTPUT_CAP_TOKENS.v1 保持一致，否则触发
  // OUTPUT_CAP_MISMATCH 而拒发。
  maxTokens: V1_MAX_OUTPUT_TOKENS,
  // 12,000 输出的生成时间明显长于 4,000（4,000 实测约 25s），45s 不够安全；
  // 90s 仍短于路由允许的 120s 上限，且 SDK maxRetries=0，超时不会重发。
  timeoutMs: V1_DEFAULT_TIMEOUT_MS,
};

export class ResearchV1InputError extends Error {
  constructor(
    public readonly code:
      | "invalid_task_id"
      | "task_not_found"
      | "candidate_binding_missing"
      | "candidate_binding_invalid"
      | "product_fact_missing"
      | "product_fact_invalid",
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "ResearchV1InputError";
  }
}

export type ResearchTaskSnapshot = {
  readonly id: string;
  readonly type: string;
  readonly decisionStatus: string;
  /** 原始 JSON 用于独立 namespace 写入的 CAS 指纹；Research 仍只消费 parsed result。 */
  readonly resultJson: string;
  readonly result: Record<string, unknown>;
  readonly updatedAt: Date | string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResultJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function candidateIdFromResult(result: Record<string, unknown>): string | null {
  const binding = isRecord(result.candidateToTask) ? result.candidateToTask : null;
  return nonEmptyString(binding?.candidateId);
}

function isFactField(value: unknown): value is FactField<unknown> {
  if (!isRecord(value)) return false;
  if (value.status !== "present" && value.status !== "missing") return false;
  if (value.status === "present" && (value.value === null || value.value === undefined)) return false;
  if (value.status === "missing" && value.value !== null) return false;
  if (typeof value.source !== "string" || !PRODUCT_FACT_SOURCES.has(value.source as ProductFactSource)) return false;
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
  if (value.capturedAt !== null && (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt)))) return false;
  if (value.rawProofHash !== null && (typeof value.rawProofHash !== "string" || !value.rawProofHash.trim())) return false;
  return true;
}

const FACT_GROUPS = ["basic", "market", "profit"] as const;

function isProductFact(value: unknown): value is ProductFact {
  if (!isRecord(value) || value.schema !== "product-fact.v3") return false;
  if (typeof value.subjectKey !== "string" || !value.subjectKey.trim()) return false;
  if (!isRecord(value.sourceProof)) return false;
  const proof = value.sourceProof;
  if (typeof proof.source !== "string" || !PRODUCT_FACT_SOURCES.has(proof.source as ProductFactSource)) return false;
  for (const key of ["captureId", "evidenceId", "subjectKey", "capturedAt", "contentHash"] as const) {
    if (typeof proof[key] !== "string" || !proof[key].trim()) return false;
  }
  const proofCapturedAt = proof.capturedAt;
  if (typeof proofCapturedAt !== "string" || Number.isNaN(Date.parse(proofCapturedAt))) return false;
  if (proof.sourceUrl !== null && typeof proof.sourceUrl !== "string") return false;
  if (typeof proof.operator !== "string" || !proof.operator.trim()) return false;
  if (proof.sourceMethod !== undefined
    && proof.sourceMethod !== null
    && (typeof proof.sourceMethod !== "string" || !proof.sourceMethod.trim())) return false;
  if (proof.subjectKey !== value.subjectKey) return false;

  for (const group of FACT_GROUPS) {
    const fields = value[group];
    if (!isRecord(fields)) return false;
    for (const field of Object.values(fields)) {
      if (!isFactField(field)) return false;
    }
  }
  if (value.extended !== undefined) {
    if (!isRecord(value.extended)) return false;
    for (const field of Object.values(value.extended)) {
      if (!isFactField(field)) return false;
    }
  }
  return true;
}

function sourceEvidenceRefOf(productFact: ProductFact): ResearchEvidenceRef {
  const proof = productFact.sourceProof;
  return {
    refId: `evidence:${proof.evidenceId}`,
    source: proof.source,
    captureId: proof.captureId,
    evidenceId: proof.evidenceId,
    subjectKey: proof.subjectKey,
    capturedAt: proof.capturedAt,
    contentHash: proof.contentHash,
    sourceUrl: proof.sourceUrl,
  };
}

function productFactEvidenceRefsOf(productFact: ProductFact): ResearchEvidenceRef[] {
  const refs = new Map<string, ResearchEvidenceRef>();
  const add = (candidate: unknown) => {
    if (!isRecord(candidate)
      || typeof candidate.refId !== "string"
      || typeof candidate.source !== "string"
      || typeof candidate.captureId !== "string"
      || typeof candidate.evidenceId !== "string"
      || typeof candidate.subjectKey !== "string"
      || typeof candidate.capturedAt !== "string"
      || typeof candidate.contentHash !== "string"
      || !(candidate.sourceUrl === null || typeof candidate.sourceUrl === "string")) return;
    const ref: ResearchEvidenceRef = {
      refId: candidate.refId,
      source: candidate.source as ResearchEvidenceRef["source"],
      captureId: candidate.captureId,
      evidenceId: candidate.evidenceId,
      subjectKey: candidate.subjectKey,
      capturedAt: candidate.capturedAt,
      contentHash: candidate.contentHash,
      sourceUrl: candidate.sourceUrl,
    };
    refs.set(`${ref.refId}|${ref.contentHash}|${ref.capturedAt}`, ref);
  };
  for (const groupName of ["basic", "market", "profit", "extended"] as const) {
    const group = productFact[groupName];
    if (!isRecord(group)) continue;
    for (const field of Object.values(group)) {
      if (!isRecord(field) || !Array.isArray(field.evidenceRefs)) continue;
      field.evidenceRefs.forEach(add);
    }
  }
  for (const conflict of productFact.sourceConflicts ?? []) {
    for (const candidate of conflict.candidates) candidate.evidenceRefs.forEach(add);
  }
  productFact.extended?.variationStructure?.evidenceRefs.forEach(add);
  return [...refs.values()];
}

function amazonDetailHistoryRefsOf(productFact: ProductFact, versions: readonly import("@/lib/sourceLayer/sourceAdapter").CaptureEvidenceRecord[]): ResearchEvidenceRef[] {
  const projection = productFact.amazonDetailHistory;
  if (!projection) return [];
  const refs: ResearchEvidenceRef[] = [];
  for (const origin of amazonDetailHistoryOriginsOf(productFact)) {
    const matches = versions.filter((item) => item.subjectKey === productFact.subjectKey
      && item.evidenceId === origin.evidenceId && item.captureId === origin.captureId
      && item.version === origin.version && item.contentHash === origin.contentHash
      && item.capturedAt === origin.capturedAt && item.sourceType === "amazon_dom"
      && item.factAuthority === "evidence_only"
      && item.sourceUrl === origin.sourceUrl
      && item.pkg.sourceProof.sourceType === "amazon_dom"
      && item.pkg.sourceProof.sourceUrl === origin.sourceUrl
      && item.pkg.sourceProof.capturedAt === origin.capturedAt
      && item.pkg.marketplace.toUpperCase() === projection.marketplace
      && origin.marketplace === projection.marketplace
      && item.pkg.fields.asin === origin.asin
      && item.pkg.captureId === origin.captureId
      && item.pkg.version === origin.version
      && item.pkg.sourceProof.entityBinding?.bound === true
      && item.pkg.sourceProof.entityBinding?.expectedAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.observedAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.urlAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.expectedMarketplace === projection.marketplace
      && item.pkg.sourceProof.entityBinding?.observedMarketplace === projection.marketplace
      && item.pkg.sourceProof.entityBinding?.urlMarketplace === projection.marketplace);
    const evidence = matches.length === 1 ? matches[0] : null;
    if (!evidence || evidence.validation.verdict !== "passed" || evidence.validation.readyForResearch !== true) {
      throw new Error("RESEARCH_INPUT_BUNDLE_AMAZON_DETAIL_HISTORY_EVIDENCE_MISSING");
    }
    refs.push({
      refId: `evidence:${evidence.evidenceId}`,
      source: "amazon_dom",
      captureId: evidence.captureId,
      evidenceId: evidence.evidenceId,
      subjectKey: evidence.subjectKey,
      capturedAt: evidence.capturedAt,
      contentHash: evidence.contentHash,
      sourceUrl: evidence.sourceUrl,
    });
  }
  return refs;
}

function productFactFromSourceMeta(sourceMetaJson: string): ProductFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceMetaJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const candidate = parsed.productFact;
  return isProductFact(candidate) ? candidate : null;
}

export async function readResearchTaskSnapshot(
  context: AccessContext,
  taskId: string,
): Promise<ResearchTaskSnapshot> {
  const normalized = taskId.trim();
  if (!normalized) throw new ResearchV1InputError("invalid_task_id", "缺少有效 task id。", 400);

  if (isSandboxTaskId(normalized)) {
    if (context.mode !== "demo") throw new ResearchV1InputError("task_not_found", "任务不存在。", 404);
    const task = getSandboxTask(context.demoAccessId, normalized);
    if (!task) throw new ResearchV1InputError("task_not_found", "任务不存在。", 404);
    return {
      id: task.id,
      type: task.type,
      decisionStatus: task.decisionStatus,
      resultJson: task.resultJson,
      result: parseResultJson(task.resultJson),
      updatedAt: task.updatedAt,
    };
  }

  if (context.mode === "demo") throw new ResearchV1InputError("task_not_found", "任务不存在。", 404);
  const task = await prisma.viralAnalysisRecord.findUnique({
    where: { id: normalized },
    select: { id: true, type: true, decisionStatus: true, resultJson: true, updatedAt: true },
  });
  if (!task) throw new ResearchV1InputError("task_not_found", "任务不存在。", 404);
  return {
    id: task.id,
    type: task.type,
    decisionStatus: task.decisionStatus,
    resultJson: task.resultJson,
    result: parseResultJson(task.resultJson),
    updatedAt: task.updatedAt,
  };
}

/**
 * G2-B & V3：从同一 EvidenceStore 的关键词附件（`kind = "keyword_evidence"` 或 V3 模块
 * `v3_reverse_asin_v1` / `v3_keyword_mining_trend_v1`）投影关键词到 ProductFact。
 *
 * 设计约束：
 * - 只读回读 EvidenceStore 附件，不读 task.resultJson.keywordEvidence；
 * - Research 引擎仍只消费 ProductFact；
 * - 任何异常（store 不可读 / 附件缺失 / 契约不符）都不阻断 Research，原样返回；
 * - 无合格词时不注入任何分组，绝不造词；
 * - 第三方性质严格保持 estimate，绝不升格为 confirmed。
 */
async function attachKeywordEvidenceFromStore(input: {
  readonly context: AccessContext;
  readonly productFact: ProductFact;
}): Promise<{
  readonly productFact: ProductFact;
  readonly refs: ResearchEvidenceRef[];
}> {
  try {
    const store = createEvidenceStore(sourceLayerOperator(input.context));
    const subject = await store.getSubject(input.productFact.subjectKey);
    const attachments = subject?.attachments ?? [];

    const v3KwAtts = attachments.filter(
      (item) => item.kind === "v3_reverse_asin_v1" || item.kind === "v3_keyword_mining_trend_v1"
    );
    const legacyKwAtts = attachments.filter((item) => item.kind === "keyword_evidence");

    let keywordInput: ProductFactKeywordEvidenceInput | null = null;
    const refs: ResearchEvidenceRef[] = [];

    // V3_PRIMARY_LEGACY_COMPAT: 优先使用 V3 规范模块数据
    for (const att of v3KwAtts) {
      const adapted = adaptV3KeywordAttachment(att, input.productFact.subjectKey);
      if (adapted && adapted.rows.length > 0) {
        keywordInput = adapted.keywordInput;
        refs.push({
          refId: `attachment:${att.attachmentId}`,
          source: input.productFact.sourceProof.source,
          captureId: input.productFact.sourceProof.captureId,
          evidenceId: input.productFact.sourceProof.evidenceId,
          subjectKey: input.productFact.subjectKey,
          capturedAt: att.capturedAt,
          contentHash: att.contentHash,
          sourceUrl: att.sourceUrl ?? input.productFact.sourceProof.sourceUrl,
        });
        break;
      }
    }

    // 若无有效 V3 关键词，降级回退到 Legacy keyword_evidence
    if (!keywordInput) {
      for (const att of legacyKwAtts) {
        const legacy = keywordEvidenceInputFromAttachment(
          att.payload,
          `attachment:${att.attachmentId}`,
        );
        if (legacy && legacy.rows.length > 0) {
          keywordInput = legacy;
          refs.push({
            refId: `attachment:${att.attachmentId}`,
            source: input.productFact.sourceProof.source,
            captureId: input.productFact.sourceProof.captureId,
            evidenceId: input.productFact.sourceProof.evidenceId,
            subjectKey: input.productFact.subjectKey,
            capturedAt: att.capturedAt,
            contentHash: att.contentHash,
            sourceUrl: att.sourceUrl ?? input.productFact.sourceProof.sourceUrl,
          });
          break;
        }
      }
    }

    const updatedFact = keywordInput ? withKeywordEvidence(input.productFact, keywordInput) : input.productFact;
    return { productFact: updatedFact, refs };
  } catch {
    return { productFact: input.productFact, refs: [] };
  }
}

/**
 * 从同一 EvidenceStore 读取历史走势附件（`kind = "v3_historical_trend_v1"`），
 * 构造合法的 `ResearchEvidenceRef`，注入 `sourceEvidenceRefs`。
 */
async function attachHistoricalTrendRefsFromStore(input: {
  readonly context: AccessContext;
  readonly productFact: ProductFact;
}): Promise<ResearchEvidenceRef[]> {
  try {
    const store = createEvidenceStore(sourceLayerOperator(input.context));
    const subject = await store.getSubject(input.productFact.subjectKey);
    const attachments = (subject?.attachments ?? []).filter(
      (item) => item.kind === "v3_historical_trend_v1"
    );
    const refs: ResearchEvidenceRef[] = [];
    for (const att of attachments) {
      const observations = adaptV3HistoricalTrendAttachment(att, input.productFact.subjectKey);
      if (observations.length > 0) {
        refs.push({
          refId: `attachment:${att.attachmentId}`,
          source: input.productFact.sourceProof.source,
          captureId: input.productFact.sourceProof.captureId,
          evidenceId: input.productFact.sourceProof.evidenceId,
          subjectKey: input.productFact.subjectKey,
          capturedAt: att.capturedAt,
          contentHash: att.contentHash,
          sourceUrl: att.sourceUrl ?? input.productFact.sourceProof.sourceUrl,
        });
      }
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * G3-B & V3：从同一 EvidenceStore 读取评论附件（`kind = "review_evidence"` 或
 * `v3_review_voc_v1`），构造合法的 `ResearchEvidenceRef`，注入 `sourceEvidenceRefs`。
 *
 * 铁律守卫：
 * - 纯只读读取 EvidenceStore 附件，严禁读取 task.resultJson.reviewEvidence；
 * - 评论属于 review_observation，绝不写入 ProductFact；
 * - 构造 refId 为 `attachment:${attachment.attachmentId}`；
 * - 提取结构化样本供 DeepSeek 参考，避免凭空捏造评论结论；
 * - 遵守 V3_PRIMARY_LEGACY_COMPAT：去重时保留 V3，丢弃内容重复的 Legacy 附件；
 * - 异常（store 不可读 / 附件缺失）不阻断 Research，返回空数据。
 */
async function attachReviewEvidenceRefsFromStore(input: {
  readonly context: AccessContext;
  readonly productFact: ProductFact;
}): Promise<{
  readonly refs: ResearchEvidenceRef[];
  readonly summary: ReviewEvidenceSummaryItem[];
}> {
  try {
    const store = createEvidenceStore(sourceLayerOperator(input.context));
    const subject = await store.getSubject(input.productFact.subjectKey);
    const allAttachments = subject?.attachments ?? [];

    const legacyReviews = allAttachments.filter((item) => item.kind === "review_evidence");
    const v3Reviews = allAttachments.filter((item) => item.kind === "v3_review_voc_v1");
    // F-03：canonical customer_voice_observation_v1 已归一某来源附件时，该来源的
    // legacy/v3 review 投影不得再作为独立样本进入 reviewEvidence（避免同一批评论被
    // customerVoiceEvidence 与 reviewEvidence 重复计入）。兼容读取保留，但不作独立消费样本。
    //
    // 关键顺序（与 ResearchInputBundle 保持一致）：必须先让**全部合法 v3** 参与既有
    // V3_PRIMARY_LEGACY_COMPAT 行级去重，再排除已被 canonical 归一的来源。若先按
    // attachmentId 剔除 v3，legacy 副本将失去 v3 对照而被去重逻辑原样保留，导致重复消费。
    // canonical 归一的是 v3 附件（provenance.sourceAttachmentId 指向 v3），legacy 附件
    // 的 attachmentId 通常**不在** normalizedSourceIds 内，故绝不能依赖提前过滤 legacy。
    const normalizedSourceIds = new Set(
      allAttachments
        .filter((item) => item.kind === "customer_voice_observation_v1")
        .flatMap((item) => parseCustomerVoiceAttachmentPayload(item.payload, input.productFact.subjectKey)?.observations ?? [])
        .map((observation) => observation.provenance.sourceAttachmentId)
        .filter((id): id is string => id !== null),
    );
    const allV3Reviews = v3Reviews.filter((item) => {
      const adapted = adaptV3ReviewAttachment(item, input.productFact.subjectKey);
      return adapted !== null && adapted.samples.length > 0;
    });
    // 用全部合法 v3（含已被 canonical 归一者）参与去重，避免其 legacy 副本被重复计入。
    const dedupedReviews = deduplicateReviewEvidence(legacyReviews, allV3Reviews);
    // 结果中排除已被 canonical 归一的来源附件（v3 或 legacy 本体）本身。
    const attachments = dedupedReviews.filter((item) => !normalizedSourceIds.has(item.attachmentId));

    const refs: ResearchEvidenceRef[] = [];
    const summary: ReviewEvidenceSummaryItem[] = [];

    // Deduplication removes samples, not provenance. Canonical voice observations
    // remain readable in the Bundle, so retain their immutable Store identities
    // and the validated V3 sources they explicitly reference for citation only.
    const voiceAttachments = allAttachments.filter((att) => att.kind === "customer_voice_observation_v1"
      && att.subjectKey === input.productFact.subjectKey
      && parseCustomerVoiceAttachmentPayload(att.payload, input.productFact.subjectKey));
    const citedSourceIds = new Set(voiceAttachments.flatMap((att) =>
      parseCustomerVoiceAttachmentPayload(att.payload, input.productFact.subjectKey)!.observations
        .filter((observation) => observation.provenance.sourceAttachmentId !== null
          && observation.evidenceRefs.includes(`attachment:${observation.provenance.sourceAttachmentId}`))
        .map((observation) => observation.provenance.sourceAttachmentId)));
    for (const att of [...voiceAttachments, ...allV3Reviews.filter((att) => citedSourceIds.has(att.attachmentId))]) {
      refs.push({
        refId: `attachment:${att.attachmentId}`,
        source: input.productFact.sourceProof.source,
        captureId: input.productFact.sourceProof.captureId,
        evidenceId: input.productFact.sourceProof.evidenceId,
        subjectKey: att.subjectKey,
        capturedAt: att.capturedAt,
        contentHash: att.contentHash,
        sourceUrl: att.sourceUrl ?? input.productFact.sourceProof.sourceUrl,
      });
    }

    for (const att of attachments) {
      if (att.kind === "v3_review_voc_v1") {
        const adapted = adaptV3ReviewAttachment(att, input.productFact.subjectKey);
        if (adapted && adapted.samples.length > 0) {
          refs.push({
            ...adapted.evidenceRefRecord,
            source: input.productFact.sourceProof.source,
            captureId: input.productFact.sourceProof.captureId,
            evidenceId: input.productFact.sourceProof.evidenceId,
          });
          summary.push(adapted.summaryItem);
        }
      } else if (att.kind === "review_evidence") {
        const refId = `attachment:${att.attachmentId}`;
        refs.push({
          refId,
          source: input.productFact.sourceProof.source,
          captureId: input.productFact.sourceProof.captureId,
          evidenceId: input.productFact.sourceProof.evidenceId,
          subjectKey: input.productFact.subjectKey,
          capturedAt: att.capturedAt,
          contentHash: att.contentHash,
          sourceUrl: att.sourceUrl ?? input.productFact.sourceProof.sourceUrl,
        });

        const payload = att.payload;
        if (payload && typeof payload === "object") {
          const rawReviews = (payload as Record<string, unknown>).reviews;
          if (Array.isArray(rawReviews)) {
            const sampleReviews: ReviewEvidenceSample[] = [];
            for (const item of rawReviews) {
              if (sampleReviews.length >= 20) break;
              if (item && typeof item === "object") {
                const rec = item as Record<string, unknown>;
                const text = typeof rec.reviewText === "string" ? rec.reviewText.trim() : "";
                if (!text) continue;
                sampleReviews.push({
                  rating: typeof rec.rating === "number" && Number.isInteger(rec.rating) ? rec.rating : null,
                  title: typeof rec.reviewTitle === "string" && rec.reviewTitle.trim() ? rec.reviewTitle.trim().slice(0, 100) : null,
                  text: text.slice(0, 500),
                  verifiedPurchase: typeof rec.verifiedPurchase === "boolean" ? rec.verifiedPurchase : null,
                });
              }
            }
            if (sampleReviews.length > 0) {
              summary.push({
                refId,
                asin: input.productFact.basic.asin.value ?? input.productFact.subjectKey,
                sampleReviews,
              });
            }
          }
        }
      }
    }

    return { refs, summary };
  } catch {
    return { refs: [], summary: [] };
  }
}


/**
 * 从 Source Layer handoff 保存的 Candidate 元数据中读取 ProductFact。
 * 注意：这里刻意不读取 analysisJson、summary、candidateAnalysisContext 或旧 fixture。
 */
/** Exact EvidenceStore projection; callers must use an explicit recovery write to attach missing facts. */
export async function readResearchCandidateProductFact(context: AccessContext, sourceMetaJson: string): Promise<ProductFact> {
  let storedProductFact = productFactFromSourceMeta(sourceMetaJson);
  if (!storedProductFact) {
    const reference = parseEvidencePromotionReference(sourceMetaJson);
    if (reference) {
      storedProductFact = await resolveEvidencePromotionProductFact(context, reference);
    }
  }

  let candidateMeta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(sourceMetaJson);
    if (isRecord(parsed)) candidateMeta = parsed;
  } catch {
    candidateMeta = {};
  }

  if (!storedProductFact) {
    throw new ResearchV1InputError(
      "product_fact_missing",
      "Source Layer 尚未为该 Candidate 保存可验证的 ProductFact，Research 已停止。",
      409,
    );
  }
  if (storedProductFact.sourceProof.subjectKey !== storedProductFact.subjectKey) {
    throw new ResearchV1InputError("product_fact_invalid", "ProductFact 的来源主体不一致。", 409);
  }
  try {
    storedProductFact = await readVerifiedCandidateFact({ context, meta: candidateMeta, productFact: storedProductFact });
  } catch (error) {
    throw new ResearchV1InputError("product_fact_invalid", error instanceof Error ? error.message : "ProductFact 校验失败。", 409);
  }
  return storedProductFact;
}

export async function buildResearchEngineInput(input: {
  readonly context: AccessContext;
  readonly taskId: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly researchConfig?: ResearchConfig;
  /** Active Research 正式执行时开启只读 Bundle 组装；默认保持旧调用兼容。 */
  readonly includeBundle?: boolean;
}): Promise<ResearchEngineInput> {
  const task = await readResearchTaskSnapshot(input.context, input.taskId);
  const candidateId = candidateIdFromResult(task.result);
  if (!candidateId) {
    throw new ResearchV1InputError("candidate_binding_missing", "研究任务没有绑定 Candidate。", 409);
  }

  let candidate: { id: string; convertedTaskId: string | null; sourceMetaJson: string } | null = null;
  if (input.context.mode === "demo") {
    const value = getSandboxCandidate(input.context.demoAccessId, candidateId);
    candidate = value
      ? { id: value.id, convertedTaskId: value.convertedTaskId ?? null, sourceMetaJson: value.sourceMetaJson }
      : null;
  } else {
    candidate = await prisma.opportunityCandidate.findUnique({
      where: { id: candidateId },
      select: { id: true, convertedTaskId: true, sourceMetaJson: true },
    });
  }
  if (!candidate) throw new ResearchV1InputError("candidate_binding_invalid", "研究任务绑定的 Candidate 不存在。", 409);
  if (candidate.convertedTaskId !== task.id) {
    throw new ResearchV1InputError("candidate_binding_invalid", "研究任务与 Candidate 绑定不一致。", 409);
  }

  const storedProductFact = await readResearchCandidateProductFact(input.context, candidate.sourceMetaJson);
  // G2-B：把同一 EvidenceStore 的关键词附件投影进 ProductFact。
  // 失败不阻断（返回原 ProductFact）；无论成功与否，Research 引擎都只消费 ProductFact。
  const keywordData = await attachKeywordEvidenceFromStore({
    context: input.context,
    productFact: storedProductFact,
  });

  // G3-B：从同一 EvidenceStore 的评论附件中提取引用与摘要
  const reviewEvidenceData = await attachReviewEvidenceRefsFromStore({
    context: input.context,
    productFact: keywordData.productFact,
  });

  // 从同一 EvidenceStore 的历史时序附件中提取引用
  const trendRefs = await attachHistoricalTrendRefsFromStore({
    context: input.context,
    productFact: keywordData.productFact,
  });

  const historySubject = keywordData.productFact.amazonDetailHistory
    ? await createEvidenceStore(sourceLayerOperator(input.context)).getSubject(keywordData.productFact.subjectKey)
    : null;
  if (keywordData.productFact.amazonDetailHistory && historySubject?.subjectKey !== keywordData.productFact.subjectKey) {
    throw new ResearchV1InputError("product_fact_invalid", "Amazon 详情历史来源无法从 EvidenceStore 回读。", 409);
  }
  const amazonDetailHistoryRefs = keywordData.productFact.amazonDetailHistory
    ? amazonDetailHistoryRefsOf(keywordData.productFact, historySubject?.versions ?? [])
    : [];

  const engineInput: ResearchEngineInput = {
    schema: RESEARCH_ENGINE_SCHEMA,
    taskId: task.id,
    candidateId,
    runId: input.runId?.trim() || `research-v1-${randomUUID()}`,
    traceId: input.traceId?.trim() || newTraceId(),
    productFact: keywordData.productFact,
    sourceEvidenceRefs: [
      sourceEvidenceRefOf(keywordData.productFact),
      ...productFactEvidenceRefsOf(keywordData.productFact),
      ...amazonDetailHistoryRefs,
      ...reviewEvidenceData.refs,
      ...keywordData.refs,
      ...trendRefs,
    ],
    researchConfig: input.researchConfig ?? DEFAULT_RESEARCH_CONFIG,
    ...(reviewEvidenceData.summary.length > 0 ? { reviewEvidenceSummary: reviewEvidenceData.summary } : {}),
  };
  if (input.includeBundle) {
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const researchInputBundle = await buildResearchInputBundle({
      context: input.context,
      taskId: input.taskId,
      traceId: engineInput.traceId ?? null,
      engineInput,
    });
    return { ...engineInput, researchInputBundle };
  }
  return engineInput;
}

export function researchCandidateIdFromResult(result: Record<string, unknown>): string | null {
  return candidateIdFromResult(result);
}

export function researchProductFactFromSourceMeta(sourceMetaJson: string): ProductFact | null {
  return productFactFromSourceMeta(sourceMetaJson);
}
