import "server-only";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";
import { computeResearchEvidenceHash, getResearchStaleState } from "@/lib/productResearchRecord";
import { researchDisplayIdentity } from "@/lib/product/researchDisplayIdentity";
import { deriveResearchState } from "@/lib/research/researchState";

import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { mutateTaskResultJson, TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";
import {
  assertExpectedVersion,
  assertExpectedVersionMatches,
  hashJson,
  isRecord,
  parseJsonRecord,
  requireOwnerContext,
  V5CoreError,
  withV5Receipt,
  resourceVersion,
} from "@/lib/server/v5CoreCommon";
import { callAiJson, getAiConfig } from "@/lib/server/aiClient";
import { getFeishuConnectionStatus } from "@/lib/server/v5FeishuService";
import { buildResearchInputBundle as buildCanonicalResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { buildDecisionDelivery, type DecisionDelivery } from "@/lib/server/research/decisionDelivery";
import { buildResearchFactSnapshot } from "@/lib/server/research/researchEngine";
import { readCommercialInputs } from "@/lib/server/commercialInputs";
import {
  buildEconomicAssumptions,
  buildUnitEconomicsView,
} from "@/lib/server/research/unitEconomicsScenario";
import type { EconomicAssumptionsInput, UnitEconomicsView } from "@/lib/research/researchContracts";
import { projectResearchDetailFacts } from "@/lib/server/research/researchDetailFactProjection";
import { stableFactHash } from "@/lib/server/research/stableFactHash";
import { sanitizeReportForConsumption, type RejectedClaim } from "@/lib/server/research/reportEvidenceIntegrity";
import { getVocAnalysis } from "@/lib/server/vocAnalysis";
import { VOC_RULE_VERSION, describeVocRuleCurrency } from "@/lib/research/vocRuleVersion";
import { readJevReadinessPolicy } from "@/lib/decision/readiness/policy";
import { getReadinessAdviceProvider } from "@/lib/decision/providers/readinessIndex";
import { getJevReadinessRuntime, type ReadinessPeek } from "@/lib/server/research/jevReadinessRuntime";
import { buildJevReadinessInputFromProduction, buildJevReadinessViewState, type JevReadinessViewState } from "@/lib/server/research/jevReadinessInput";
import { deriveImprovementRequirements, deriveSupplierCheckpoints } from "@/lib/research/vocImprovement";
import { readResearchCandidateProductFact } from "@/lib/server/research/researchInput";
import { assessResearchDepth, type ResearchDepthAssessment } from "@/lib/server/research/researchDepthQuality";
import { readStoredResearchReport } from "@/lib/server/research/researchReportStore";
import { buildV5ReportView } from "@/lib/research/v5ReportView";
import { auditResearchClaims, salesAvailabilityFromMetrics, makeUnavailableClaimAudit, type ResearchClaimAudit, type EvidenceGrade } from "@/lib/research/evidenceAudit";
import { buildV1ReportView, type V1ReportView } from "@/lib/research/v1ReportView";
import {
  resolveCurrentResearchReport,
  type ResearchCurrentReportPointer,
  type ResearchReportCandidate,
  type ResearchReportResolution,
} from "@/lib/research/currentResearchReport";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { summarizeTrendObservations } from "@/lib/server/research/v3EvidenceResearchAdapter";
import { buildProviderMarketResearchSummary } from "@/lib/server/research/providerMarketResearchSummary";
import { hasFormalHumanDecision } from "@/lib/taskWorkflowSummary";
import {
  type CanonicalDecisionStatus,
  teamRecommendationToCanonical,
  canonicalToDbDecisionStatus,
  canonicalToLegacyChoice,
} from "@/lib/types/v5DecisionStatus";
import {
  resolveBusinessStage,
  type BusinessStage,
} from "@/lib/types/v5BusinessStage";

type V5ResearchState = {
  schema: "v5-research.v1";
  candidateId: string;
  asin: string;
  marketplace: string;
  title: string;
  factHash: string | null;
  evidenceHash: string | null;
  evidenceRefs: string[];
  researchRevision: number;
  report: Record<string, unknown> | null;
  reportHash: string | null;
  teamRecommendation?: Record<string, unknown> | null;
  conceptTeamRecommendation?: Record<string, unknown> | null;
  reportBindingHashes?: Record<string, unknown> | null;
  advisory: Record<string, unknown> | null;
  myChoice: Record<string, unknown> | null;
  temporaryWatches: Array<Record<string, unknown>>;
  feishuHubPacketBinding?: Record<string, unknown> | null;
};

const OWNER = "owner:v1";

/**
 * Research advisory 的 Provider 输出 token 预算。
 *
 * **默认与旧行为完全一致（2000）**；仅当 `AI_RESEARCH_MAX_TOKENS` 显式配置为
 * 正整数时才覆盖。用于真实 Provider 下输入 bundle 较大（如含多条 VOC 观察）
 * 导致 `finishReason=length` JSON 截断时的受控调整。
 *
 * 只影响**一次 advisory 调用的输出预算**：不改输入契约、不改哈希/绑定语义、
 * 不改失败处理（截断仍 fail-closed 返回 `PROVIDER_FINISH_REASON_LENGTH`）。
 */
function researchAdvisoryMaxTokens(): number {
  const raw = process.env.AI_RESEARCH_MAX_TOKENS?.trim() ?? "";
  if (!raw) return 2000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 2000;
}

/**
 * 展示层中文标签：把 ProductFact 的内部字段路径（`basic.brand`）翻译成人话
 * （`基础事实·品牌`）。**只影响展示字符串**：
 * - 不改 `missingProductFactFields` / `conflictProductFactFields` 的返回结构与数量；
 * - 不改 ProductFact / EvidenceStore / Research 输入契约；
 * - 未登记的分组或字段一律原样保留，绝不丢信息。
 */
const FACT_GROUP_LABELS: Readonly<Record<string, string>> = {
  basic: "基础事实",
  market: "市场事实",
  profit: "利润事实",
  extended: "扩展事实",
  keywordEvidence: "关键词证据",
  providerRawData: "供应商原始数据",
  timeSeries: "历史走势",
  variationAnalysis: "变体分析",
  concentration: "集中度分析",
};

const FACT_FIELD_LABELS: Readonly<Record<string, string>> = {
  asin: "ASIN",
  title: "标题",
  image: "主图",
  brand: "品牌",
  category: "类目",
  price: "价格",
  rating: "评分",
  reviewCount: "评论数",
  bulletPoints: "要点",
  bsr: "BSR排名",
  bsrRanks: "BSR排名",
  subCategoryBsr: "子类目BSR排名",
  amazonDetail: "详情页扩展",
  ratingDistribution: "评分分布",
  shipsFrom: "发货地",
  variations: "商品变体",
  monthlySalesEstimate: "月销估算",
  monthlyRevenueEstimate: "月销售额估算",
  launchedDate: "上架日期",
  dateFirstAvailable: "首次可售日期",
  buyboxSeller: "Buybox卖家",
  buyBox: "Buybox",
  fulfillmentType: "配送方式",
  fulfillment: "配送方式",
  estimatedGrossMargin: "预估毛利率",
  listingQualityScore: "Listing质量分",
  brandCr5Share: "品牌CR5份额",
  packageWeight: "包装重量",
  packageDimensions: "包装尺寸",
  itemWeight: "商品重量",
  itemDimensions: "商品尺寸",
  fbaFee: "FBA费用",
  categoryPath: "类目路径",
  material: "材质",
  includedComponents: "包含组件",
  galleryImageUrls: "图集",
  listPrice: "标价",
  coupon: "优惠券",
  seller: "卖家",
  parentAsin: "父ASIN",
};

/** 把 `group.field` 形态的内部路径转成中文展示标签；未登记时原样返回。 */
function factPathDisplayLabel(path: string): string {
  const separator = path.indexOf(".");
  if (separator <= 0 || separator === path.length - 1) return path;
  const group = path.slice(0, separator);
  const field = path.slice(separator + 1);
  const groupLabel = FACT_GROUP_LABELS[group];
  const fieldLabel = FACT_FIELD_LABELS[field];
  if (groupLabel === undefined && fieldLabel === undefined) return path;
  return `${groupLabel ?? group}·${fieldLabel ?? field}`;
}

/** 缺失事实的展示文案（仅字符串表现变化，数量与语义不变）。 */
function missingFactDisplayText(path: string): string {
  return `缺失商品字段事实: ${factPathDisplayLabel(path)}`;
}

/** 数据冲突的展示文案（与缺失事实使用同一套标签映射）。 */
function factConflictDisplayText(path: string): string {
  return `数据冲突: ${factPathDisplayLabel(path)}`;
}

function candidateAsin(candidate?: { sourceMetaJson?: string | null; link?: string | null }): string {
  if (!candidate) return "";
  const meta = parseJsonRecord(candidate.sourceMetaJson);
  const identity = isRecord(meta.identity) ? meta.identity : null;
  const metaAsin = typeof identity?.asin === "string" ? identity.asin.trim().toUpperCase() : "";
  if (/^[A-Z0-9]{10}$/u.test(metaAsin)) return metaAsin;
  const linkAsin = typeof candidate.link === "string"
    ? candidate.link.match(/\/dp\/([A-Z0-9]{10})/iu)?.[1]?.toUpperCase() ?? ""
    : "";
  return /^[A-Z0-9]{10}$/u.test(linkAsin) ? linkAsin : "";
}

function taskState(task: { resultJson: string }, candidate?: { id: string; name: string; sourceMetaJson?: string | null; link?: string | null }): V5ResearchState {
  const root = parseJsonRecord(task.resultJson);
  const raw = isRecord(root.v5Research) ? root.v5Research : {};
  return {
    schema: "v5-research.v1",
    candidateId: typeof raw.candidateId === "string" ? raw.candidateId : candidate?.id ?? "",
    asin: (typeof raw.asin === "string" && raw.asin.trim())
      ? raw.asin.trim()
      : ((isRecord(root.facts) && isRecord((root.facts as Record<string, unknown>).basic) && isRecord(((root.facts as Record<string, unknown>).basic as Record<string, unknown>).asin) && typeof (((root.facts as Record<string, unknown>).basic as Record<string, unknown>).asin as Record<string, unknown>).value === "string")
          ? (((root.facts as Record<string, unknown>).basic as Record<string, unknown>).asin as Record<string, unknown>).value as string
           : (typeof root.asin === "string" && root.asin.trim() ? root.asin : candidateAsin(candidate))),
    marketplace: typeof raw.marketplace === "string" ? raw.marketplace : "US",
    title: typeof raw.title === "string" ? raw.title : candidate?.name ?? "",
    factHash: typeof raw.factHash === "string" ? raw.factHash : null,
    evidenceHash: typeof raw.evidenceHash === "string" ? raw.evidenceHash : null,
    evidenceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.filter((item): item is string => typeof item === "string") : [],
    researchRevision: Number.isSafeInteger(raw.researchRevision) ? Number(raw.researchRevision) : 0,
    report: isRecord(raw.report) ? raw.report : null,
    reportHash: typeof raw.reportHash === "string" ? raw.reportHash : null,
    teamRecommendation: isRecord(raw.teamRecommendation) ? raw.teamRecommendation : null,
    conceptTeamRecommendation: isRecord(raw.conceptTeamRecommendation) ? raw.conceptTeamRecommendation : null,
    reportBindingHashes: isRecord(raw.reportBindingHashes) ? raw.reportBindingHashes : null,
    advisory: isRecord(raw.advisory) ? raw.advisory : null,
    myChoice: isRecord(raw.myChoice) ? raw.myChoice : null,
    temporaryWatches: Array.isArray(raw.temporaryWatches) ? raw.temporaryWatches.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [],
    feishuHubPacketBinding: isRecord(raw.feishuHubPacketBinding) ? raw.feishuHubPacketBinding : null,
  };
}

async function commitResearchState(context: AccessContext, task: { id: string; resultJson: string; updatedAt: Date },
  state: V5ResearchState, conflictCode: string, decisionStatus?: string,
  currentReport?: { source: "v1" | "v5"; reportHash: string; generatedAt: string | null; researchRevision: number | null }) {
  try {
    await mutateTaskResultJson({ context, taskId: task.id, writer: "v5-research",
      expectedStorageVersion: { resultJson: task.resultJson, updatedAt: task.updatedAt },
      mutate: (current) => ({ result: { ...current, v5Research: state, ...(currentReport ? { researchCurrentReport: currentReport } : {}) }, value: null,
        ...(decisionStatus === undefined ? {} : { decisionStatus }) }),
    });
  } catch (error) {
    if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") {
      throw new V5CoreError(conflictCode, "研究任务已被更新，请刷新后重试。", 409, false, true);
    }
    throw error;
  }
}

async function findTask(taskId: string) {
  const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: taskId } });
  if (!task) throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", "研究任务不存在。", 404);
  const root = parseJsonRecord(task.resultJson);
  const candidateId = (root.candidateToTask as Record<string, unknown> | undefined)?.candidateId;
  const candidate = typeof candidateId === "string" ? await prisma.opportunityCandidate.findUnique({ where: { id: candidateId }, select: { id: true, name: true, sourceMetaJson: true, link: true } }) : null;
  return { task, candidate, state: taskState(task, candidate ?? undefined) };
}

function choiceProjection(choice: Record<string, unknown> | null) {
  if (!choice) return null;
  return {
    choice: choice.choice ?? null,
    canonicalStatus: typeof choice.canonicalStatus === "string" ? choice.canonicalStatus : null,
    hubStatus: typeof choice.hubStatus === "string" ? choice.hubStatus : null,
    scope: choice.scope ?? null,
    chosenAt: choice.chosenAt ?? null,
    chosenBy: choice.chosenBy ?? "Owner",
    reason: typeof choice.reason === "string" ? choice.reason : null,
    reasonPreview: typeof choice.reason === "string" ? choice.reason.slice(0, 160) : null,
    // 外部人工决策依据：只读展示来源标识，不改变历史决定状态。
    source: isRecord(choice.source) ? {
      kind: typeof choice.source.kind === "string" ? choice.source.kind : null,
      recordId: typeof choice.source.recordId === "string" ? choice.source.recordId : null,
      reviewedAt: typeof choice.source.reviewedAt === "string" ? choice.source.reviewedAt : null,
      packetHash: typeof choice.source.packetHash === "string" ? choice.source.packetHash : null,
    } : null,
    decisionBindingHash: typeof choice.decisionBindingHash === "string" ? choice.decisionBindingHash : null,
    decisionHash: typeof choice.decisionHash === "string" ? choice.decisionHash : null,
    bindingHashes: isRecord(choice.bindingHashes) ? choice.bindingHashes : null,
  };
}

export function systemSuggestion(state: V5ResearchState, delivery?: DecisionDelivery) {
  const hasEvidence = Boolean(state.evidenceRefs.length && state.factHash && state.evidenceHash);
  // 证据充分度单独计算
  const evidenceSufficiency = hasEvidence ? "adequate" : "insufficient";
  // P0-DC-01：有确定性决策交付物时填真实值；否则保持安全默认（无 delivery → unavailable / no_suggestion）。
  // 值域约束：blockingRisk ∈ none|present|insufficient_evidence|unavailable；
  // composite ∈ recommend_proceed|watch_carefully|recommend_drop|no_suggestion（既有消费方枚举，不新增值）。
  let blockingRisk = "unavailable";
  let composite = "no_suggestion";
  if (delivery?.status === "available" && delivery.decisionSummary && delivery.riskCounts) {
    const counts = delivery.riskCounts;
    const missing = delivery.decisionSummary.missingInformation.length;
    blockingRisk = counts.blocking > 0
      ? "present"
      : counts.notComputable > 0 || missing > 0
        ? "insufficient_evidence"
        : "none";
    composite = delivery.decisionSummary.recommendedNextAction === "继续研究"
      ? "recommend_proceed"
      : delivery.decisionSummary.recommendedNextAction === "暂停"
        ? "watch_carefully"
        : "no_suggestion";
  }
  return {
    status: hasEvidence ? "available" : "unavailable",
    evidenceSufficiency,
    blockingRisk,
    composite,
    deepseekAvailable: Boolean(state.report),
    jevStatus: "unavailable",
    jevAtomicJudgmentSet: null,
  };
}

export function allowedEvidenceRefsOf(bundle: {
  sourceEvidenceRefs?: ReadonlyArray<{
    refId: string;
    kind?: string;
    attachmentId?: string;
    subjectKey?: string;
    contentHash?: string;
    capturedAt?: string;
  }>;
  productFact?: any;
  reviewEvidence?: ReadonlyArray<{ attachmentId?: string; contentHash?: string }>;
  keywordEvidence?: ReadonlyArray<{ attachmentId?: string; contentHash?: string }>;
  customerVoiceEvidence?: ReadonlyArray<{ attachmentId?: string; contentHash?: string }>;
  trendObservations?: ReadonlyArray<{ evidenceRefs?: readonly string[] }>;
  /** PH3：已绑定的第三方 Provider 结构化字段（SellerSprite typed rows）。 */
  providerMetricEvidence?: ReadonlyArray<{
    evidenceRefId?: string;
    attachmentId?: string;
    contentHash?: string;
  }>;
  /** Exact-ASIN Product Market metrics with a separate provider provenance contract. */
  providerProductMarketEvidence?: ReadonlyArray<{
    schemaVersion?: string;
    provider?: string;
    module?: string;
    subjectKey?: string;
    marketplace?: string;
    asin?: string;
    parentAsin?: string | null;
    sourceType?: string;
    evidenceRefId?: string;
    attachmentId?: string;
    contentHash?: string;
    capturedAt?: string;
    metricNature?: string;
    metrics?: ReadonlyArray<{ value?: number; metricNature?: string; status?: string }>;
  }>;
  variationEvidence?: {
    subjectKey?: string;
    subjectAsin?: string;
    outcome?: string;
    completeness?: string;
    evidenceRefs?: ReadonlyArray<{
      refId: string;
      attachmentId?: string;
      subjectKey?: string;
      contentHash?: string;
      capturedAt?: string;
      kind?: string;
    }>;
  };
}): string[] {
  const allowed = new Set<string>();

  if (bundle.productFact?.sourceProof?.evidenceId) {
    allowed.add(`evidence:${bundle.productFact.sourceProof.evidenceId}`);
  }

  const bundleAttachments = (bundle.sourceEvidenceRefs ?? []).filter((ref) => ref.kind === "attachment");
  const addBoundProductAttachment = (ref: any) => {
    if (!ref || typeof ref.refId !== "string" || !ref.refId.startsWith("attachment:")
      || typeof ref.subjectKey !== "string" || typeof ref.contentHash !== "string"
      || !/^[a-f0-9]{64}$/iu.test(ref.contentHash)
      || ref.subjectKey !== productFact?.subjectKey
      || typeof ref.capturedAt !== "string") return;
    const attachmentId = ref.refId.slice("attachment:".length);
    const matches = bundleAttachments.some((candidate) => candidate.refId === ref.refId
      && candidate.attachmentId === attachmentId
      && candidate.subjectKey === ref.subjectKey
      && candidate.contentHash === ref.contentHash
      && candidate.capturedAt === ref.capturedAt);
    if (!matches) return;
    allowed.add(ref.refId);
    allowed.add(`attachment:${ref.contentHash}`);
    allowed.add(`attachment:a-${ref.contentHash}`);
  };

  const productFact = bundle.productFact;
  for (const groupName of ["basic", "market", "profit", "extended"]) {
    const group = productFact?.[groupName];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [fieldName, field] of Object.entries(group)) {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const refs = (field as { evidenceRefs?: unknown }).evidenceRefs;
      if (Array.isArray(refs)) refs.forEach(addBoundProductAttachment);
      if (fieldName === "variationStructure") {
        const structureRefs = (field as { evidenceRefs?: unknown }).evidenceRefs;
        if (Array.isArray(structureRefs)) structureRefs.forEach(addBoundProductAttachment);
      }
    }
  }
  for (const conflict of productFact?.sourceConflicts ?? []) {
    for (const candidate of conflict?.candidates ?? []) {
      if (Array.isArray(candidate?.evidenceRefs)) candidate.evidenceRefs.forEach(addBoundProductAttachment);
    }
  }

  const variation = bundle.variationEvidence;
  const factAsin = typeof productFact?.basic?.asin?.value === "string" ? productFact.basic.asin.value : null;
  const variationIsCitable = variation
    && variation.subjectKey === productFact?.subjectKey
    && variation.subjectAsin === factAsin
    && ((variation.outcome === "complete" && variation.completeness === "complete")
      || (variation.outcome === "no_variation_with_evidence" && variation.completeness === "none"));
  if (variationIsCitable) {
    for (const ref of variation.evidenceRefs ?? []) addBoundProductAttachment(ref);
  }

  for (const review of bundle.reviewEvidence ?? []) {
    if (review.attachmentId) {
      allowed.add(`attachment:${review.attachmentId}`);
      if (review.contentHash) {
        allowed.add(`attachment:${review.contentHash}`);
        allowed.add(`attachment:a-${review.contentHash}`);
      }
    }
  }

  for (const kw of bundle.keywordEvidence ?? []) {
    if (kw.attachmentId) {
      allowed.add(`attachment:${kw.attachmentId}`);
      if (kw.contentHash) {
        allowed.add(`attachment:${kw.contentHash}`);
        allowed.add(`attachment:a-${kw.contentHash}`);
      }
    }
  }

  for (const voice of bundle.customerVoiceEvidence ?? []) {
    if (voice.attachmentId) {
      allowed.add(`attachment:${voice.attachmentId}`);
      if (voice.contentHash) {
        allowed.add(`attachment:${voice.contentHash}`);
        allowed.add(`attachment:a-${voice.contentHash}`);
      }
    }
  }

  for (const trend of bundle.trendObservations ?? []) {
    for (const ref of trend.evidenceRefs ?? []) {
      if (typeof ref === "string" && ref.length > 0) {
        allowed.add(ref);
      }
    }
  }

  // PH3：第三方 Provider 指标只能引用它自己的附件来源（provider_estimate / provider_observed），
  // 绝不与 Amazon 主证据混同；引用语法与 keyword/review/voice 保持一致。
  for (const metric of bundle.providerMetricEvidence ?? []) {
    if (metric.evidenceRefId) {
      allowed.add(metric.evidenceRefId);
    }
    if (metric.attachmentId) {
      allowed.add(`attachment:${metric.attachmentId}`);
      if (metric.contentHash) {
        allowed.add(`attachment:${metric.contentHash}`);
        allowed.add(`attachment:a-${metric.contentHash}`);
      }
    }
  }

  for (const market of bundle.providerProductMarketEvidence ?? []) {
    if (market.schemaVersion !== "provider-product-market-evidence.v1"
      || market.provider?.trim().toLowerCase() !== "sellersprite"
      || market.module !== "sellersprite_product_market"
      || market.sourceType !== "sellersprite_plugin"
      || !market.subjectKey || market.subjectKey !== productFact?.subjectKey
      || !market.asin || market.asin !== factAsin
      || (market.metricNature !== "provider_observed" && market.metricNature !== "provider_estimate")
      || typeof market.attachmentId !== "string" || !market.attachmentId
      || market.evidenceRefId !== `attachment:${market.attachmentId}`
      || typeof market.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(market.contentHash)
      || typeof market.capturedAt !== "string" || !Number.isFinite(Date.parse(market.capturedAt))
      || !Array.isArray(market.metrics) || market.metrics.length === 0) continue;
    const subjectMatch = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(market.subjectKey);
    if (!subjectMatch || subjectMatch[1] !== market.marketplace || subjectMatch[2] !== market.asin) continue;
    if (market.parentAsin !== null && market.parentAsin !== undefined
      && (!/^[A-Z0-9]{10}$/u.test(market.parentAsin) || market.parentAsin === market.asin)) continue;
    if (!market.metrics.some((item) => Number.isFinite(item.value)
      && item.metricNature === market.metricNature && item.status === "parsed")) continue;

    const ref = bundleAttachments.find((candidate) => candidate.refId === market.evidenceRefId);
    if (!ref || ref.attachmentId !== market.attachmentId || ref.subjectKey !== market.subjectKey
      || ref.contentHash !== market.contentHash || ref.capturedAt !== market.capturedAt) continue;

    allowed.add(market.evidenceRefId);
    allowed.add(`attachment:${market.contentHash}`);
    allowed.add(`attachment:a-${market.contentHash}`);
  }

  return Array.from(allowed);
}

function declaredProductAttachmentBindingFailure(bundle: {
  productFact?: any;
  sourceEvidenceRefs?: ReadonlyArray<{
    refId: string;
    kind?: string;
    attachmentId?: string;
    subjectKey?: string;
    contentHash?: string;
    capturedAt?: string;
  }>;
  variationEvidence?: {
    subjectKey?: string;
    subjectAsin?: string;
    outcome?: string;
    completeness?: string;
    evidenceRefs?: ReadonlyArray<{
      refId: string;
      attachmentId?: string;
      subjectKey?: string;
      contentHash?: string;
      capturedAt?: string;
      kind?: string;
    }>;
  };
}): string | null {
  const attachments = (bundle.sourceEvidenceRefs ?? []).filter((ref) => ref.kind === "attachment");
  const validAttachment = (ref: any) => {
    if (!ref || typeof ref.refId !== "string" || !ref.refId.startsWith("attachment:")
      || typeof ref.subjectKey !== "string" || typeof ref.contentHash !== "string"
      || !/^[a-f0-9]{64}$/iu.test(ref.contentHash)
      || ref.subjectKey !== productFact?.subjectKey
      || typeof ref.capturedAt !== "string") return false;
    const attachmentId = ref.refId.slice("attachment:".length);
    return attachments.some((candidate) => candidate.refId === ref.refId
      && candidate.attachmentId === attachmentId
      && candidate.subjectKey === ref.subjectKey
      && candidate.contentHash === ref.contentHash
      && candidate.capturedAt === ref.capturedAt);
  };

  const productFact = bundle.productFact;
  for (const groupName of ["basic", "market", "profit", "extended"]) {
    const group = productFact?.[groupName];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const [fieldName, field] of Object.entries(group)) {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const refs = (field as { evidenceRefs?: unknown }).evidenceRefs;
      if (Array.isArray(refs)) {
        if (refs.some((ref) => typeof ref === "object" && ref !== null && (ref as any).refId?.startsWith("attachment:") && !validAttachment(ref))) {
          return `${groupName}.${fieldName}`;
        }
      }
    }
  }
  for (const conflict of productFact?.sourceConflicts ?? []) {
    for (const candidate of conflict?.candidates ?? []) {
      if (candidate?.evidenceRefs?.some((ref: any) => ref?.refId?.startsWith("attachment:") && !validAttachment(ref))) {
        return conflict.field;
      }
    }
  }
  const variation = bundle.variationEvidence;
  const factAsin = typeof productFact?.basic?.asin?.value === "string" ? productFact.basic.asin.value : null;
  if (variation
    && variation.subjectKey === productFact?.subjectKey
    && variation.subjectAsin === factAsin
    && ((variation.outcome === "complete" && variation.completeness === "complete")
      || (variation.outcome === "no_variation_with_evidence" && variation.completeness === "none"))) {
    if ((variation.evidenceRefs ?? []).some((ref) => !validAttachment(ref))) return "variationEvidence";
  }
  return null;
}

/**
 * 加载正式 ResearchInputBundle（唯一生产输入边界）。
 * EvidenceStore / ProductFact 不可读时 fail-closed，不生成正式 narrative。
 */
export async function loadCanonicalResearchBoundary(input: {
  context: AccessContext;
  taskId: string;
  traceId?: string | null;
  recordDiagnostic?: boolean;
}): Promise<
  | { ok: true; bundle: Awaited<ReturnType<typeof buildCanonicalResearchInputBundle>>; allowedEvidenceRefs: string[] }
  | { ok: false; errorCode: "EVIDENCE_BINDING_MISSING" | "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING" | "PRODUCT_FACT_MISSING"; message: string }
> {
  try {
    const bundle = await buildCanonicalResearchInputBundle({
      context: input.context,
      taskId: input.taskId,
      traceId: input.traceId ?? null,
      recordDiagnostic: input.recordDiagnostic ?? false,
    });
    const bindingFailure = declaredProductAttachmentBindingFailure(bundle);
    if (bindingFailure) {
      return {
        ok: false,
        errorCode: "EVIDENCE_BINDING_MISSING",
        message: `ResearchInputBundle 的 ${bindingFailure} 字段声明了无法绑定到本次附件清单的引用，Provider 调用已阻断。`,
      };
    }
    const allowedEvidenceRefs = allowedEvidenceRefsOf(bundle);
    if (!allowedEvidenceRefs.length) {
      return {
        ok: false,
        errorCode: "EVIDENCE_BINDING_MISSING",
        message: "正式 ResearchInputBundle 没有可用 evidenceRefs，禁止生成正式结论。",
      };
    }
    return { ok: true, bundle, allowedEvidenceRefs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING/u.test(message)) {
      return { ok: false, errorCode: "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING", message };
    }
    if (/product_fact_missing|candidate_binding/u.test(message)) {
      return { ok: false, errorCode: "PRODUCT_FACT_MISSING", message };
    }
    return { ok: false, errorCode: "EVIDENCE_BINDING_MISSING", message };
  }
}

/**
 * V6：单位经济性只读投影（确定性计算、零 AI、不写任何状态）。
 *
 * **fail-soft 纪律**：任何异常、或结构不完整的 `ProductFact`（缺 basic/profit/sourceProof），
 * 一律降级为 `null`。经济性投影绝不阻断研究详情读取——与 `buildDecisionDelivery`
 * 内部 fail-closed（返回 unavailable 而非抛出）保持一致。
 */
function buildUnitEconomicsProjection(
  boundary: Awaited<ReturnType<typeof loadCanonicalResearchBoundary>>,
  assumptions: EconomicAssumptionsInput | null,
  marketplace: string | null,
): UnitEconomicsView | null {
  if (!boundary.ok) return null;
  try {
    const productFact: unknown = boundary.bundle.productFact;
    if (!productFact || typeof productFact !== "object") return null;
    const shaped = productFact as { basic?: unknown; profit?: unknown; sourceProof?: unknown };
    if (!shaped.basic || !shaped.profit || !shaped.sourceProof) return null;
    return buildUnitEconomicsView({
      facts: buildResearchFactSnapshot(productFact as ProductFact),
      assumptions,
      marketplace,
    });
  } catch {
    return null;
  }
}

type NarrativeDraft = {
  summary?: unknown;
  opportunities?: unknown;
  risks?: unknown;
  vocAnalysis?: unknown;
  citations?: unknown;
};

type NarrativeDraftValidation =
  | { ok: true; data: NarrativeDraft }
  | { ok: false; errorClass: "root_not_object" | "required_field_missing" | "field_wrong_type" | "entry_wrong_shape" | "unknown_field" };

const NARRATIVE_DRAFT_FIELDS = ["summary", "opportunities", "risks", "vocAnalysis", "citations"] as const;
const VOC_NARRATIVE_FIELDS = ["painPoints", "positiveSignals", "failureModes", "useCases", "replacementSignals", "switchReasons", "ownershipClaims"] as const;
export const RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT = [
  "只输出一个符合下方 Research JSON contract 的 JSON object；禁止 Markdown fence、前言、解释、后记或其他文本。",
  "所有下列顶层字段及 vocAnalysis 子字段都必须存在；没有内容的数组输出 []。不要输出额外字段。",
  '{"summary": {"text": "...", "evidenceRefs": ["evidence:..."]}, "opportunities": [{"text": "...", "evidenceRefs": ["evidence:..."]}], "risks": [{"text": "...", "evidenceRefs": ["evidence:..."]}], "vocAnalysis": {"painPoints": [{"text": "...", "evidenceRefs": ["attachment:..."]}], "positiveSignals": [], "failureModes": [], "useCases": [], "replacementSignals": [], "switchReasons": [], "ownershipClaims": []}, "citations": [{"quote": "...", "source": "attachment:..."}]}',
].join("\n");

/** Validate the provider's complete Research JSON contract before any evidence binding or persistence. */
export function validateNarrativeDraft(value: unknown): NarrativeDraftValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errorClass: "root_not_object" };
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some((key) => !(NARRATIVE_DRAFT_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, errorClass: "unknown_field" };
  }
  if (NARRATIVE_DRAFT_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(draft, field) || draft[field] === undefined)) {
    return { ok: false, errorClass: "required_field_missing" };
  }
  const isNarrative = (entry: unknown) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).text === "string"
    && Boolean(((entry as Record<string, unknown>).text as string).trim())
    && Array.isArray((entry as Record<string, unknown>).evidenceRefs)
    && ((entry as Record<string, unknown>).evidenceRefs as unknown[]).every((ref) => typeof ref === "string")
    && Object.keys(entry as object).every((key) => key === "text" || key === "evidenceRefs"));
  if (!isNarrative(draft.summary)) return { ok: false, errorClass: "entry_wrong_shape" };
  for (const field of ["opportunities", "risks"] as const) {
    if (!Array.isArray(draft[field])) return { ok: false, errorClass: "field_wrong_type" };
    if (!(draft[field] as unknown[]).every(isNarrative)) return { ok: false, errorClass: "entry_wrong_shape" };
  }
  if (!draft.vocAnalysis || typeof draft.vocAnalysis !== "object" || Array.isArray(draft.vocAnalysis)) {
    return { ok: false, errorClass: "field_wrong_type" };
  }
  const voc = draft.vocAnalysis as Record<string, unknown>;
  if (Object.keys(voc).some((key) => !(VOC_NARRATIVE_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, errorClass: "unknown_field" };
  }
  if (VOC_NARRATIVE_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(voc, field) || voc[field] === undefined)) {
    return { ok: false, errorClass: "required_field_missing" };
  }
  for (const field of VOC_NARRATIVE_FIELDS) {
    if (!Array.isArray(voc[field])) return { ok: false, errorClass: "field_wrong_type" };
    if (!(voc[field] as unknown[]).every(isNarrative)) return { ok: false, errorClass: "entry_wrong_shape" };
  }
  if (!Array.isArray(draft.citations)) return { ok: false, errorClass: "field_wrong_type" };
  if (!(draft.citations as unknown[]).every((item) => Boolean(item && typeof item === "object" && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).quote === "string"
    && typeof (item as Record<string, unknown>).source === "string"
    && Object.keys(item as object).every((key) => key === "quote" || key === "source")))) {
    return { ok: false, errorClass: "entry_wrong_shape" };
  }
  return { ok: true, data: draft as NarrativeDraft };
}

type BoundVocNarrative = { text: string; evidenceRefs: string[] };

type BoundNarrativeReport = {
  summary: string | null;
  opportunities: string[];
  risks: string[];
  vocAnalysis: {
    painPoints: BoundVocNarrative[];
    positiveSignals: BoundVocNarrative[];
    failureModes: BoundVocNarrative[];
    useCases: BoundVocNarrative[];
    replacementSignals: BoundVocNarrative[];
    switchReasons: BoundVocNarrative[];
    ownershipClaims: BoundVocNarrative[];
  };
  citations: Array<{ quote: string; source: string; refId: string }>;
  unverifiedAssumptions: string[];
  /** 每个正式 narrative 至少绑定 1 条合法 citation.source。 */
  narrativeBindings: Array<{ field: string; text: string; evidenceRefs: string[] }>;
  /**
   * P0 证据可信度修复：任何声明了白名单外引用的陈述都被**整条拒收**（不保留原文、
   * 不改用其他合法引用）。此处保留结构化拒收审计：字段路径、非法引用、声明引用、
   * 处理方式与原文预览。
   */
  rejectedClaims: RejectedClaim[];
};

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  }
  return null;
}

function asEvidenceRefs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return asEvidenceRefs(record.evidenceRefs ?? record.refs ?? []);
  }
  return [];
}

const PRICE_BAND_CLAIM_PATTERN = /价格带|主流价格|竞品价格|同类.{0,10}价格/u;

function priceAmountsOf(text: string): number[] {
  return [...text.matchAll(/(?:\$|USD\s*)(\d[\d,]*(?:\.\d+)?)/giu)]
    .map((match) => Number(match[1]!.replace(/,/gu, "")))
    .filter((value) => Number.isFinite(value));
}

function numericTokensOf(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/gu)]
    .map((match) => Number(match[0].replace(/,/gu, "")))
    .filter((value) => Number.isFinite(value));
}

/**
 * Narrative ↔ citation 强绑定：
 * - 正式 summary / opportunity / risk 必须至少绑定 1 条 allowlist 内 citation；
 * - 无 citation / 非法 citation → unverifiedAssumptions，不进入正式 narrative；
 * - allowlist 外 source fail-closed。
 */
export function bindNarrativesWithCitations(
  draft: NarrativeDraft,
  allowedEvidenceRefs: string[],
  seedUnverified: string[] = [],
): BoundNarrativeReport {
  const allowlist = new Set(allowedEvidenceRefs);
  const unverifiedAssumptions: string[] = [...seedUnverified];
  const validCitations: BoundNarrativeReport["citations"] = [];
  const seenCitationKeys = new Set<string>();

  const rawCitations = Array.isArray(draft.citations) ? draft.citations : [];
  for (const item of rawCitations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const quote = typeof record.quote === "string" ? record.quote.trim() : "";
    const source = typeof record.source === "string" ? record.source.trim() : "";
    if (!source || !allowlist.has(source)) {
      unverifiedAssumptions.push(
        `未核实引用来源 [${source || "无来源"}]: ${quote ? `"${quote.slice(0, 80)}"` : "未提供引用文本"}`,
      );
      continue;
    }
    const key = `${source}::${quote}`;
    if (seenCitationKeys.has(key)) continue;
    seenCitationKeys.add(key);
    validCitations.push({ quote, source, refId: source });
  }

  const citationsBySource = new Map<string, BoundNarrativeReport["citations"]>();
  for (const citation of validCitations) {
    const list = citationsBySource.get(citation.source) ?? [];
    list.push(citation);
    citationsBySource.set(citation.source, list);
  }

  const narrativeBindings: BoundNarrativeReport["narrativeBindings"] = [];
  const rejectedClaims: RejectedClaim[] = [];

  /**
   * P0 证据可信度修复（V6_RESEARCH_EVIDENCE_INTEGRITY_P0_FIX）：
   *
   * 旧行为：只把白名单外的 ref 过滤掉，只要还剩至少 1 条合法 ref，就**原样保留整段原文**。
   * 后果：模型写「X 属于以 Y 为父体的多变体家族」并同时声明了合法与非法引用时，
   * 非法引用被删、句子留下并挂上合法引用 —— 失去支撑的事实被当成已确认结论展示。
   *
   * 新行为（保守）：只要声明了任意白名单外引用，就无法确定该陈述的哪些部分由非法来源支撑，
   * 因此**整条拒收**：既不保留原文，也**不**改用其他合法引用让它看起来有支撑。
   * 拒收原因、字段路径、非法引用 ID 与处理方式同时写入 unverifiedAssumptions 与 rejectedClaims。
   */
  const rejectForIllegalRefs = (
    field: string,
    text: string,
    declaredRefs: string[],
    illegalDeclared: string[],
  ): null => {
    const illegalRefs = [...new Set(illegalDeclared)];
    for (const illegal of illegalRefs) {
      unverifiedAssumptions.push(`${field} 引用了 allowlist 外证据 [${illegal}]，已 fail-closed。`);
    }
    rejectedClaims.push({
      field,
      reason: "illegal_evidence_ref",
      illegalRefs,
      declaredRefs: [...new Set(declaredRefs)],
      disposition: "rejected_whole_statement",
      textPreview: text.slice(0, 160),
    });
    unverifiedAssumptions.push(
      `${field} 因引用白名单外证据整条拒收（不保留原文、不替换为其他合法引用）: ${text.slice(0, 160)}`,
    );
    return null;
  };

  const bindOne = (field: string, raw: unknown, kind: "summary" | "opportunity" | "risk"): string | null => {
    const text = asText(raw);
    if (!text) return null;
    const declaredRefs = asEvidenceRefs(raw);
    const supportingSources = declaredRefs.filter((ref) => allowlist.has(ref) && citationsBySource.has(ref));
    const illegalDeclared = declaredRefs.filter((ref) => !allowlist.has(ref));
    if (illegalDeclared.length) return rejectForIllegalRefs(field, text, declaredRefs, illegalDeclared);
    if (!supportingSources.length) {
      // 无合法 citation 绑定 → 不进入正式 narrative
      unverifiedAssumptions.push(`${field} 缺少合法 citation 绑定，已移入未验证假设: ${text.slice(0, 160)}`);
      return null;
    }
    if (PRICE_BAND_CLAIM_PATTERN.test(text)) {
      const claimedAmounts = priceAmountsOf(text);
      if (claimedAmounts.length) {
        const quotedAmounts = new Set(supportingSources.flatMap((source) =>
          (citationsBySource.get(source) ?? []).flatMap((citation) => numericTokensOf(citation.quote))));
        const missingAmounts = [...new Set(claimedAmounts)].filter((amount) => !quotedAmounts.has(amount));
        if (missingAmounts.length) {
          unverifiedAssumptions.push(
            `${field} 价格带结论含引用原文未出现的金额 (${missingAmounts.map((amount) => `$${amount}`).join(", ")})，已移入未验证假设: ${text.slice(0, 160)}`,
          );
          return null;
        }
      }
    }
    narrativeBindings.push({ field, text, evidenceRefs: supportingSources });
    return text;
  };

  const bindVocOne = (field: string, raw: unknown): BoundVocNarrative | null => {
    const text = asText(raw);
    if (!text) return null;
    const declaredRefs = asEvidenceRefs(raw);
    const supportingSources = [...new Set(declaredRefs.filter((ref) => allowlist.has(ref) && citationsBySource.has(ref)))];
    const illegalDeclared = declaredRefs.filter((ref) => !allowlist.has(ref));
    if (illegalDeclared.length) { rejectForIllegalRefs(field, text, declaredRefs, illegalDeclared); return null; }
    if (!supportingSources.length) {
      unverifiedAssumptions.push(`${field} 缺少合法 citation 绑定，已移入未验证假设: ${text.slice(0, 160)}`);
      return null;
    }
    narrativeBindings.push({ field, text, evidenceRefs: supportingSources });
    return { text, evidenceRefs: supportingSources };
  };

  const summary = bindOne("summary", draft.summary, "summary");

  const opportunities: string[] = [];
  const rawOpps = Array.isArray(draft.opportunities) ? draft.opportunities : [];
  rawOpps.forEach((raw, index) => {
    const bound = bindOne(`opportunities[${index}]`, raw, "opportunity");
    if (bound) opportunities.push(bound);
  });

  const risks: string[] = [];
  const rawRisks = Array.isArray(draft.risks) ? draft.risks : [];
  rawRisks.forEach((raw, index) => {
    const bound = bindOne(`risks[${index}]`, raw, "risk");
    if (bound) risks.push(bound);
  });

  const vocCategories = [
    "painPoints",
    "positiveSignals",
    "failureModes",
    "useCases",
    "replacementSignals",
    "switchReasons",
    "ownershipClaims",
  ] as const;
  const rawVoc = isRecord(draft.vocAnalysis) ? draft.vocAnalysis : {};
  const vocAnalysis = Object.fromEntries(vocCategories.map((category) => {
    const entries = Array.isArray(rawVoc[category]) ? rawVoc[category] as unknown[] : [];
    const boundEntries = entries.flatMap((raw, index) => {
      const bound = bindVocOne(`vocAnalysis.${category}[${index}]`, raw);
      return bound ? [bound] : [];
    });
    return [category, boundEntries];
  })) as BoundNarrativeReport["vocAnalysis"];

  // 有合法 citation 但没有任何 narrative 使用 → 保留 citation；无 narrative 绑定则至少提示
  if (!summary && opportunities.length === 0 && risks.length === 0 && validCitations.length === 0) {
    unverifiedAssumptions.push("当前研究尚无任何已核验证据引用 (evidenceRefs 为空)");
  }

  return {
    summary,
    opportunities,
    risks,
    vocAnalysis,
    citations: validCitations,
    unverifiedAssumptions,
    narrativeBindings,
    rejectedClaims,
  };
}

function hasBoundResearchNarrative(report: BoundNarrativeReport): boolean {
  return Boolean(report.summary || report.opportunities.length || report.risks.length
    || Object.values(report.vocAnalysis).some((items) => items.length > 0));
}

export function validateCitationsAndAssumptions(
  rawCitations: unknown[],
  evidenceRefs: string[],
  missingFields: string[] = [],
  conflicts: string[] = [],
) {
  const seedUnverified: string[] = [
    ...missingFields.map((missing) => missingFactDisplayText(missing)),
    ...conflicts.map((conflict) => factConflictDisplayText(conflict)),
  ];
  // 复用强绑定校验：非法 citation 进入 unverified，合法 citation 保留。
  const bound = bindNarrativesWithCitations(
    {
      // 仅校验 citation 时不绑定 narrative 文本
      citations: rawCitations,
    },
    evidenceRefs,
    seedUnverified,
  );
  return { validCitations: bound.citations, unverifiedAssumptions: bound.unverifiedAssumptions };
}

export function resolveProductFacts(
  _root: Record<string, unknown> | null | undefined,
  _meta: Record<string, unknown> | null | undefined,
  verifiedFact: ProductFact | null = null,
) {
  // Only a verified ProductFact may supply facts. Historical result/snapshot/identity stays display-only.
  const projected = projectResearchDetailFacts(verifiedFact);
  const dimensions = projected.itemDimensions
    ? `${[projected.itemDimensions.length, projected.itemDimensions.width, projected.itemDimensions.height]
      .filter((value): value is number => value !== undefined).join(" × ")} ${projected.itemDimensions.unit}`
    : null;
  const weight = projected.itemWeight ? `${projected.itemWeight.value} ${projected.itemWeight.unit}` : null;
  return {
    ...projected,
    dimensions,
    weight,
  };
}

/**
 * P2-04：正式研报的权威绑定。
 *
 * 生产里存在两条研究写链：v5（`v5Research.report` + `reportHash`）与 v1
 * （根节点 `researchReport.reportJson` + `reportHash`，由 `/api/tasks/[id]/research-v1`
 * 写入）。人工决定必须认同一份正式报告，否则 v1 研报生成后无法记录四态，
 * 03→04 会在「没有正式研究报告」处被永久挡住。
 */
/**
 * 读取当前权威报告：唯一解释路径。
 *
 * 候选来自两条真实写链（v5Research.report / 根节点 researchReport），
 * 权威由 `researchCurrentReport` 指针决定；指针缺失或对不上时返回歧义，
 * 由调用方 fail-closed，不按格式或版本号猜测。
 */
function reportAuthorityOf(root: Record<string, unknown>, state: V5ResearchState): ResearchReportResolution {
  const candidates: ResearchReportCandidate[] = [];
  if (state.report && state.reportHash) {
    const generatedAt = (state.report as { generatedAt?: unknown }).generatedAt;
    candidates.push({
      source: "v5",
      reportHash: state.reportHash,
      generatedAt: typeof generatedAt === "string" ? generatedAt : null,
      researchRevision: state.researchRevision,
    });
  }
  const stored = readStoredResearchReport(root);
  if (stored) {
    candidates.push({ source: "v1", reportHash: stored.reportHash, generatedAt: stored.generatedAt, researchRevision: null });
  }
  const rawPointer = isRecord(root.researchCurrentReport) ? root.researchCurrentReport : null;
  const pointer: ResearchCurrentReportPointer | null = rawPointer
    && (rawPointer.source === "v1" || rawPointer.source === "v5")
    && typeof rawPointer.reportHash === "string"
    ? {
        source: rawPointer.source,
        reportHash: rawPointer.reportHash,
        generatedAt: typeof rawPointer.generatedAt === "string" ? rawPointer.generatedAt : null,
        researchRevision: typeof rawPointer.researchRevision === "number" ? rawPointer.researchRevision : null,
      }
    : null;
  return resolveCurrentResearchReport({ candidates, pointer });
}

/** 人工决定/失效判定使用的正式绑定：只有权威明确时才给出 hash。 */
function effectiveReportBinding(root: Record<string, unknown>, state: V5ResearchState): { reportHash: string | null; source: "v5" | "v1" | "none"; resolution: ResearchReportResolution } {
  const resolution = reportAuthorityOf(root, state);
  if (resolution.status !== "current") return { reportHash: null, source: "none", resolution };
  // v1 只有记录过事实/证据绑定（当前写链产出）才可作为正式绑定，历史遗留报告不能冒充。
  if (resolution.source === "v1") {
    const bindings = isRecord(root.researchReportBindingHashes) ? root.researchReportBindingHashes : null;
    const bound = Boolean(bindings && typeof bindings.factHash === "string" && typeof bindings.evidenceHash === "string");
    if (!bound) return { reportHash: null, source: "none", resolution };
  }
  return { reportHash: resolution.reportHash, source: resolution.source, resolution };
}

export function researchRootStaleState(root: Record<string, unknown>, state: V5ResearchState) {
  const legacy = getResearchStaleState(root);
  const authority = effectiveReportBinding(root, state);
  const effectiveReportHash = authority.reportHash;
  const choiceBindings = state.myChoice && isRecord(state.myChoice.bindingHashes) ? state.myChoice.bindingHashes : null;
  const bindings = state.reportBindingHashes && Object.prototype.hasOwnProperty.call(state.reportBindingHashes, "researchEvidenceHash")
    ? state.reportBindingHashes : choiceBindings;
  const rootHashChanged = Boolean(bindings && Object.prototype.hasOwnProperty.call(bindings, "researchEvidenceHash")
    && bindings.researchEvidenceHash !== computeResearchEvidenceHash(root));
  // 权威不明（两份报告并存且无指针）时，旧决定一律视为需要重新确认。
  const decisionStale = Boolean(choiceBindings && (authority.resolution.status !== "current" || choiceBindings.reportHash !== effectiveReportHash
    || choiceBindings.factHash !== state.factHash || choiceBindings.evidenceHash !== state.evidenceHash
    || (Object.prototype.hasOwnProperty.call(choiceBindings, "researchEvidenceHash") && choiceBindings.researchEvidenceHash !== computeResearchEvidenceHash(root))
    || (choiceBindings.researchRevision !== undefined && choiceBindings.researchRevision !== state.researchRevision)));
  // v5 的绑定/完成哈希只代表 v5 报告的时效；权威是 v1 或未定时不得用它判 stale，
  // 否则 v1 重新生成会连带把 v5 的旧绑定算成「证据变化」。
  const v5IsAuthority = authority.resolution.status === "current" && authority.resolution.source === "v5";
  const reportStale = v5IsAuthority ? ((!state.reportBindingHashes && legacy.stale) || rootHashChanged) : false;
  return { reportStale, decisionStale };
}

async function researchReadStaleState(context: AccessContext, taskId: string, root: Record<string, unknown>, state: V5ResearchState) {
  const pure = researchRootStaleState(root, state);
  // v5 报告自身 hash 比对只在 v5 是当前权威时有意义；
  // 权威是 v1 时 state.reportHash 已被换成 v1 的 hash，再比就是拿两份不同报告互相对照。
  const authorityForHash = effectiveReportBinding(root, state);
  const v5IsAuthority = authorityForHash.resolution.status === "current" && authorityForHash.resolution.source === "v5";
  let reportStale = pure.reportStale || Boolean(v5IsAuthority && state.report && hashJson(state.report) !== state.reportHash);
  const evidenceRefsHash = (bundle: { sourceEvidenceRefs: readonly { refId: string; contentHash?: string; evidenceId?: string }[] }) =>
    hashJson(bundle.sourceEvidenceRefs.map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
      .sort((a, b) => a.refId.localeCompare(b.refId)));
  const authority = effectiveReportBinding(root, state);
  const authoritySource = authority.resolution.status === "current" ? authority.resolution.source : "none";
  if (authoritySource === "v5" && state.factHash && state.evidenceHash) {
    const boundary = await loadCanonicalResearchBoundary({ context, taskId, recordDiagnostic: false });
    // factHash 语义（方案 A 隔离修复）：对稳定业务事实子集计算（剔除动态派生 amazonDetailHistory，
    // 其 injectedNow 每次注入当前时刻导致完整对象哈希永不稳定——见 research/stableFactHash.ts）。
    reportStale ||= !boundary.ok || stableFactHash(boundary.bundle.productFact) !== state.factHash
      || evidenceRefsHash(boundary.bundle) !== state.evidenceHash;
  }
  // P2-04：v1 正式研报（根节点 researchReport）用自己的绑定哈希判断来源是否变化。
  // 没有绑定的历史 v1 报告无法判定时效，读侧以 bindingStatus=unbound 如实标注，不假装有效。
  const v1Bindings = authoritySource === "v1" && isRecord(root.researchReportBindingHashes) ? root.researchReportBindingHashes : null;
  if (v1Bindings) {
    const boundary = await loadCanonicalResearchBoundary({ context, taskId, recordDiagnostic: false });
    if (!boundary.ok) reportStale = true;
    else {
      if (typeof v1Bindings.factHash === "string" && v1Bindings.factHash !== stableFactHash(boundary.bundle.productFact)) reportStale = true;
      if (typeof v1Bindings.evidenceHash === "string" && v1Bindings.evidenceHash !== evidenceRefsHash(boundary.bundle)) reportStale = true;
    }
  }
  return { reportStale, stale: reportStale || pure.decisionStale, staleReason: reportStale ? "RESEARCH_EVIDENCE_CHANGED" : pure.decisionStale ? "DECISION_BINDING_CHANGED" : null };
}

/**
 * Jev 二次复核 — 详情读侧视图（只读；不触发任何 Provider 调用，不写任何状态）。
 * 功能未启用时返回最小投影；启用时复用同一 boundary / delivery / VOC 构建输入并读取进程内缓存。
 */
function buildJevReadinessDetailView(args: {
  taskId: string;
  state: V5ResearchState;
  boundary: Awaited<ReturnType<typeof loadCanonicalResearchBoundary>>;
  delivery: DecisionDelivery | null;
  vocAnalysis: Awaited<ReturnType<typeof getVocAnalysis>>;
}): JevReadinessViewState {
  const policy = readJevReadinessPolicy();
  const resolvedProvider = getReadinessAdviceProvider();
  const binding = {
    reportHash: args.state.reportHash ?? null,
    factHash: args.state.factHash ?? null,
    evidenceHash: args.state.evidenceHash ?? null,
    researchRevision: typeof args.state.researchRevision === "number" ? args.state.researchRevision : null,
  };
  let inputAvailable = false;
  let inputReason: string | null = null;
  let peek: ReadinessPeek | null = null;
  if (policy.enabled && resolvedProvider.kind !== "unavailable") {
    if (!args.boundary.ok) {
      inputReason = `EVIDENCE_BOUNDARY_UNAVAILABLE:${args.boundary.errorCode}`;
    } else {
      const built = buildJevReadinessInputFromProduction({
        taskId: args.taskId,
        asin: typeof args.state.asin === "string" && args.state.asin ? args.state.asin : null,
        binding,
        report: sanitizeReportForConsumption(args.state.report).report,
        bundle: args.boundary.bundle,
        allowedEvidenceRefs: args.boundary.allowedEvidenceRefs,
        delivery: args.delivery,
        vocAnalysis: args.vocAnalysis,
      });
      if (built.ok) {
        inputAvailable = true;
        try {
          peek = getJevReadinessRuntime().peek(args.taskId, resolvedProvider.provider.providerId, built.input);
        } catch {
          peek = null;
        }
      } else {
        inputReason = built.reason;
      }
    }
  }
  return buildJevReadinessViewState({
    policy,
    providerKind: resolvedProvider.kind,
    providerReason: resolvedProvider.reason,
    binding,
    inputAvailable,
    inputReason,
    peek,
  });
}

function taskDetail(
  task: { id: string; title: string | null; updatedAt: Date; archivedAt: Date | null; resultJson: string },
  candidate: { id: string; name: string; sourceMetaJson?: string | null; link?: string | null } | null,
  state: V5ResearchState,
  legacyGenerationBoundary: { available: boolean; message: string | null } | null = null,
  staleState = { stale: false, reportStale: false, staleReason: null as string | null },
  verifiedFact: ProductFact | null = null,
  decisionDelivery: DecisionDelivery | null = null,
  strengthBlockedTexts: readonly string[] = [],
) {
  const reportHash = state.reportHash;
  const root = parseJsonRecord(task.resultJson);
  const meta = parseJsonRecord(candidate?.sourceMetaJson);
  const resolvedFacts = resolveProductFacts(root, meta, verifiedFact);
  const marketProvenance = isRecord(root.marketProvenance)
    ? root.marketProvenance
    : isRecord(meta.marketProvenance)
    ? meta.marketProvenance
    : null;

  const gate = systemSuggestion(state, decisionDelivery ?? undefined);
  const lastAdvisoryAttempt = state.advisory && isRecord(state.advisory.deepseek) ? state.advisory.deepseek : null;
  // P0 证据可信度（读侧统一投影）：任何引用白名单外来源、支撑范围不可知的**已持久化**陈述
  // 一律暂停作为有效研究结论输出。无需屏蔽时原样返回同一对象 → reportHash 语义与下游绑定校验不变。
  // P5-v6：strengthBlockedTexts 由 getResearchDetail 统一计算后传入，
  // 使「结论强度超过证据」的条目从消费投影中真正移除，而不是只留 UI 标签。
  const { report: consumableReport, integrity: reportIntegrity } = sanitizeReportForConsumption(state.report, { strengthBlockedTexts });
  const deepseek: Record<string, unknown> = consumableReport ? {
    status: "available", summary: consumableReport.summary ?? null,
    opportunities: Array.isArray(consumableReport.opportunities) ? consumableReport.opportunities : [],
    risks: Array.isArray(consumableReport.risks) ? consumableReport.risks : [],
    vocAnalysis: consumableReport.vocAnalysis ?? null,
    citations: Array.isArray(consumableReport.citations) ? consumableReport.citations : [],
    unverifiedAssumptions: consumableReport.unverifiedAssumptions ?? [], reportRefs: state.evidenceRefs,
    evidenceIntegrity: reportIntegrity.contaminated ? reportIntegrity : null,
  } : lastAdvisoryAttempt ?? { status: "unavailable", summary: null, opportunities: [], risks: [], citations: [], reportRefs: [] };

  const evidenceRiskGate = state.advisory && isRecord(state.advisory.evidenceRiskGate)
    ? state.advisory.evidenceRiskGate
    : {
        status: gate.status,
        evidenceSufficiency: gate.evidenceSufficiency,
        blockingRisk: gate.blockingRisk,
        gateVersion: "deterministic-v1",
      };

  const compositeSuggestion = state.advisory && isRecord(state.advisory.compositeSuggestion)
    ? state.advisory.compositeSuggestion
    : {
        status: gate.status,
        composite: gate.composite,
        inputs: state.evidenceRefs,
        gateVersion: "deterministic-v1",
      };

  const myChoice = choiceProjection(state.myChoice);
  const feishuHubPacketBinding = state.feishuHubPacketBinding;
  const feishuHub = feishuHubPacketBinding && typeof feishuHubPacketBinding.recordId === "string" && feishuHubPacketBinding.recordId.trim()
    ? {
        table: "T02" as const,
        recordId: feishuHubPacketBinding.recordId,
        baseOpenUrl: getFeishuConnectionStatus().baseOpenUrl,
      }
    : null;
  const legacyReport = isRecord(root.researchReport)
    ? root.researchReport.reportJson
    : null;

  const ResearchRecordIdentity = {
    taskId: task.id,
    candidateId: state.candidateId || candidate?.id || null,
    researchRevision: state.researchRevision,
    researchRecordKey: `${task.id}:${state.researchRevision}`,
    asin: state.asin,
    factHash: state.factHash,
    evidenceHash: state.evidenceHash,
    reportHash,
    stale: staleState.stale,
  };

  const facts = {
    brand: resolvedFacts.brand,
    price: resolvedFacts.price,
    currency: resolvedFacts.currency,
    rating: resolvedFacts.rating,
    reviewCount: resolvedFacts.reviewCount,
    bsr: resolvedFacts.bsr,
    fbaFee: resolvedFacts.fbaFee,
    fbaFeeNature: resolvedFacts.fbaFeeNature,
    mainCategory: resolvedFacts.mainCategory,
    dimensions: resolvedFacts.dimensions,
    weight: resolvedFacts.weight,
    itemDimensions: resolvedFacts.itemDimensions,
    itemWeight: resolvedFacts.itemWeight,
    material: resolvedFacts.material,
    bulletPoints: resolvedFacts.bulletPoints,
    sourceProof: resolvedFacts.sourceProof,
    fieldEvidence: resolvedFacts.fieldEvidence,
    conflicts: resolvedFacts.conflicts,
    variationStructure: resolvedFacts.variationStructure,
  };

  const imageUrl = resolvedFacts.imageUrl;

  return {
    ...ResearchRecordIdentity,
    ResearchRecordIdentity,
    title: state.title || candidate?.name || task.title,
    imageUrl,
    marketplace: state.marketplace,
    marketProvenance,
    fastTrack: marketProvenance === null,
    facts,
    displayOnlyIdentity: researchDisplayIdentity(meta, resolvedFacts),
    report: consumableReport,
    reportIntegrity,
    reportStale: staleState.reportStale,
    staleReason: staleState.staleReason,
    // A2 读侧：历史 AI 研报的 VOC 规则时效（纯读侧标注，不参与 stale 门禁、不改任何状态）。
    vocRuleCurrency: describeVocRuleCurrency(
      isRecord(state.advisory) && typeof state.advisory.vocRuleVersion === "string"
        ? state.advisory.vocRuleVersion
        : null,
    ),
    lastAdvisoryAttempt,
    advisory: state.advisory,
    deepseek,
    evidenceRiskGate,
    compositeSuggestion,
    decisionDelivery: decisionDelivery ?? null,
    myChoice,
    teamRecommendation: state.teamRecommendation ? { ...state.teamRecommendation, stale: (() => {
      const binding = isRecord(state.teamRecommendation.bindingHashes) ? state.teamRecommendation.bindingHashes : {};
      const active = state.feishuHubPacketBinding;
      return staleState.reportStale || binding.reportHash !== state.reportHash || binding.factHash !== state.factHash
        || binding.evidenceHash !== state.evidenceHash || binding.researchRevision !== state.researchRevision
        || !active || active.status !== "active" || binding.packetHash !== active.packetHash || binding.subjectKey !== active.subjectKey
        || binding.packetEvidenceHash !== active.evidenceHash;
    })() } : null,
    conceptTeamRecommendation: state.conceptTeamRecommendation ?? null,
    decisionBindingHash: myChoice?.decisionBindingHash ?? null,
    feishuHub,
    /**
     * E-1E：飞书写入的前置条件（只读布尔，零网络）。
     * 服务端仍以真实凭证/预检为权威门禁；前端只用于提前禁用必然失败的同步按钮。
     */
    feishuConfigured: getFeishuConnectionStatus().configured,
    hasLegacyReport: isRecord(legacyReport),
    hasHumanDecision: Boolean(state.myChoice || hasFormalHumanDecision(root)),
    legacyV5GenerationAvailable: legacyGenerationBoundary?.available ?? false,
    legacyV5GenerationBlockReason: legacyGenerationBoundary?.message ?? null,
    temporaryWatches: state.temporaryWatches,
    resourceVersion: resourceVersion(task.updatedAt),
    archivedAt: task.archivedAt?.toISOString() ?? null,
    costMode: "CLIENT_SIDE_EPHEMERAL",
  };
}

export async function listResearch(input: { context: AccessContext; view?: string; include?: string; limit?: number }) {
  requireOwnerContext(input.context);
  const allowed = [
    "all",
    "ready",
    "needs_decision",
    "proceed",
    "validate_more",
    "pause",
    "drop",
    "archived",
    // legacy mappings
    "needs_choice",
    "in_progress",
    "watch",
  ];
  const view = input.view ?? "all";
  if (!allowed.includes(view)) throw new V5CoreError("INVALID_FILTER", "Research view 参数无效。", 400);

  // Map legacy filter parameters to canonical business stage
  const targetStage: string =
    view === "needs_choice"
      ? "needs_decision"
      : view === "in_progress"
      ? "ready"
      : view === "watch"
      ? "pause"
      : view;

  const isArchivedFilter = targetStage === "archived";
  const tasks = await prisma.viralAnalysisRecord.findMany({
    where: {
      type: "workflow",
      ...(isArchivedFilter ? { archivedAt: { not: null } } : targetStage === "all" ? {} : { archivedAt: null }),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(input.limit ?? 100, 100),
  });

  /**
   * 计数口径修复（2026-11-02）：总研究数与各阶段数必须是**全局**口径。
   *
   * 此前 counts 由「按 view 过滤后的 tasks」累加，导致 view=archived 时总数退化为 1、
   * view=ready 时总数少掉已归档项——界面把局部数量当全局数量显示。
   * 这里单独做一次只读计数投影：只解析任务自身字段，不加载候选、boundary、stale，
   * 因此不会把展示期的重 IO 带进计数路径。
   */
  const countScopedTasks = await prisma.viralAnalysisRecord.findMany({
    where: { type: "workflow" },
    select: { id: true, resultJson: true, decisionStatus: true, archivedAt: true, updatedAt: true, title: true },
    orderBy: { updatedAt: "desc" },
  });

  const allRows: Array<Record<string, unknown>> = [];
  const stageCounts: Record<string, number> = {
    all: 0,
    ready: 0,
    needs_decision: 0,
    proceed: 0,
    validate_more: 0,
    pause: 0,
    drop: 0,
    archived: 0,
  };

  for (const task of countScopedTasks) {
    const countState = taskState(task);
    const countStage = resolveBusinessStage({
      isArchived: Boolean(task.archivedAt),
      archivedAt: task.archivedAt?.toISOString() ?? null,
      myChoice: countState.myChoice as { canonicalStatus?: CanonicalDecisionStatus; choice?: string; scope?: string } | null,
      dbStatus: task.decisionStatus,
      taskId: task.id,
      isLegacy: Boolean((countState as unknown as { isLegacy?: boolean }).isLegacy || (!countState.report && !countState.factHash)),
      reportHash: countState.reportHash,
      deepseekAvailable: Boolean(countState.report),
      hasFormalReport: Boolean(countState.report && countState.reportHash),
    });
    stageCounts[countStage] = (stageCounts[countStage] || 0) + 1;
    stageCounts.all++;
  }

  // 尚未转成研究任务的候选品同样计入「全部」与「待推进」的全局数。
  const pendingCandidateCount = await prisma.opportunityCandidate.count({ where: { convertedTaskId: null, archivedAt: null } });
  if (pendingCandidateCount > 0) {
    stageCounts.ready += pendingCandidateCount;
    stageCounts.all += pendingCandidateCount;
  }

  for (const task of tasks) {
    const root = parseJsonRecord(task.resultJson);
    const candidateId = isRecord(root.candidateToTask) && typeof root.candidateToTask.candidateId === "string" ? root.candidateToTask.candidateId : null;
    const candidate = candidateId ? await prisma.opportunityCandidate.findUnique({ where: { id: candidateId }, select: { id: true, name: true, sourceMetaJson: true, link: true } }) : null;
    const state = taskState(task, candidate ?? undefined);
    const meta = parseJsonRecord(candidate?.sourceMetaJson);
    const boundary = await loadCanonicalResearchBoundary({ context: input.context, taskId: task.id });
    const resolvedFacts = resolveProductFacts(root, meta, boundary.ok ? boundary.bundle.productFact : null);
    const viewState = task.archivedAt ? "archived" : state.myChoice?.scope === "FINAL" ? String(state.myChoice.choice).toLowerCase() : state.report ? "needs_choice" : "in_progress";

    const businessStage = resolveBusinessStage({
      isArchived: Boolean(task.archivedAt),
      archivedAt: task.archivedAt?.toISOString() ?? null,
      myChoice: state.myChoice as { canonicalStatus?: CanonicalDecisionStatus; choice?: string; scope?: string } | null,
      dbStatus: task.decisionStatus,
      taskId: task.id,
      isLegacy: Boolean((state as unknown as { isLegacy?: boolean }).isLegacy || (!state.report && !state.factHash)),
      reportHash: state.reportHash,
      deepseekAvailable: Boolean(state.report),
      hasFormalReport: Boolean(state.report && state.reportHash),
    });

    /**
     * E-1B：研究任务的真实进度（派生字段，不写库）。
     *
     * handoff 只写 factHash/evidenceHash、report 为 null，businessStage 会 fallback 成 ready，
     * 列表于是把「还没开始研究」显示成「已准备/进行中」。这里用真实产物区分三态。
     */
    const researchState: "report_ready" | "in_progress" | "not_started" = deriveResearchState({
      hasReport: Boolean(state.report),
      researchRevision: state.researchRevision,
      hasProductBrief: isRecord(root.productBrief),
      hasDecision: Boolean(state.myChoice),
    });

    const findingOfRow = researchFindingOf(root, state, researchState);

    allRows.push({
      taskId: task.id,
      candidateId: candidateId ?? state.candidateId,
      asin: state.asin,
      title: state.title || candidate?.name || task.title,
      image: resolvedFacts.imageUrl,
      marketplace: state.marketplace,
      displayOnlyIdentity: researchDisplayIdentity(meta, resolvedFacts),
      brand: resolvedFacts.brand,
      category: resolvedFacts.mainCategory,
      price: resolvedFacts.price,
      rating: resolvedFacts.rating,
      reviewCount: resolvedFacts.reviewCount,
      viewState,
      businessStage,
      researchState,
      finding: findingOfRow,
      findingPreview: findingOfRow.text,
      researchRevision: state.researchRevision ?? null,
      myChoice: choiceProjection(state.myChoice),
      systemSuggestion: systemSuggestion(state),
      stale: (await researchReadStaleState(input.context, task.id, root, state)).stale,
      hasProductBrief: isRecord(root.productBrief),
      archivedAt: task.archivedAt?.toISOString() ?? null,
      updatedAt: task.updatedAt.toISOString(),
      resourceVersion: resourceVersion(task.updatedAt),
    });
  }

  // Include pending candidates if view is all or ready
  if (targetStage === "all" || targetStage === "ready") {
    const pending = await prisma.opportunityCandidate.findMany({ where: { convertedTaskId: null, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 100 });
    for (const candidate of pending) {
      const meta = parseJsonRecord(candidate.sourceMetaJson);
      let verifiedFact: ProductFact | null = null;
      try { verifiedFact = await readResearchCandidateProductFact(input.context, candidate.sourceMetaJson); } catch { /* Invalid evidence renders unknown. */ }
      const resolvedFacts = resolveProductFacts({}, meta, verifiedFact);
      const businessStage = "ready";

      allRows.push({
        taskId: null,
        candidateId: candidate.id,
        asin: typeof meta.asin === "string" ? meta.asin : "",
        title: candidate.name,
        image: resolvedFacts.imageUrl,
        marketplace: typeof meta.marketplace === "string" ? meta.marketplace : "US",
        displayOnlyIdentity: researchDisplayIdentity(meta, resolvedFacts),
      brand: resolvedFacts.brand,
        category: resolvedFacts.mainCategory,
        price: resolvedFacts.price,
        rating: resolvedFacts.rating,
        reviewCount: resolvedFacts.reviewCount,
        viewState: "candidate_pending",
        businessStage,
        researchState: "not_started" as const,
        finding: { status: "NOT_STARTED" as const, label: "尚未研究", text: null, basis: "还没有生成研报" },
        findingPreview: null,
        researchRevision: null,
        myChoice: null,
        systemSuggestion: { status: "unavailable", composite: "no_suggestion", deepseekAvailable: false, jevStatus: "unavailable", jevAtomicJudgmentSet: null },
        stale: false,
        archivedAt: null,
        updatedAt: candidate.updatedAt.toISOString(),
      });
    }
  }

  // Filter rows based on targetStage
  const filteredRows = targetStage === "all" ? allRows : allRows.filter((r) => r.businessStage === targetStage);

  return { items: filteredRows, counts: stageCounts, nextCursor: null };
}

/**
 * P2-02（4.3）：研究深度诊断（只读、非阻断）。
 *
 * 只对已持久化的正式研报做可机械验证的合同检查；不修改报告、不参与 reportHash、
 * 不改变任何门禁结果，也不表示“研究质量已通过”。形状不匹配时返回 null，不猜。
 */
function researchDepthDiagnosisOf(root: Record<string, unknown>): ResearchDepthAssessment | null {
  const stored = readStoredResearchReport(root);
  if (!stored) return null;
  const report = stored.report as unknown;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const candidate = report as Record<string, unknown>;
  const sections = ["marketOpportunity", "competitionInsight", "vocAnalysis", "riskAssessment"] as const;
  if (!sections.every((key) => candidate[key] !== null && typeof candidate[key] === "object" && !Array.isArray(candidate[key]))) return null;
  try {
    return assessResearchDepth(candidate as never);
  } catch {
    return null;
  }
}

/**
 * P2-04：v1 正式研报的只读展示投影。
 *
 * 只在「没有 v5 正式报告」时提供，确保 v5 优先且不会把两份不同版本的报告
 * 拼接展示；不写库、不改 reportHash/版本、不参与 stale 与人工决定判定。
 */
function reportViewV1Of(root: Record<string, unknown>, state: V5ResearchState): V1ReportView | null {
  const authority = reportAuthorityOf(root, state);
  // v5 是权威时不展示 v1（避免两份"当前报告"并存）；权威未定时仍返回，但标记为非权威。
  const authoritative = authority.status === "current" && authority.source === "v1";
  if (authority.status === "current" && authority.source === "v5") return null;
  const stored = readStoredResearchReport(root);
  if (!stored) return null;
  try {
    const bound = isRecord(root.researchReportBindingHashes)
      && typeof root.researchReportBindingHashes.factHash === "string"
      && typeof root.researchReportBindingHashes.evidenceHash === "string";
    return {
      ...buildV1ReportView(stored.report, { reportHash: stored.reportHash, generatedAt: stored.generatedAt, bindingStatus: bound ? "bound" : "unbound" }),
      authoritative,
    };
  } catch {
    return null;
  }
}

/**
 * P5-v3：v5 综合研报的只读投影。
 *
 * 只在「v5 为当前权威」时返回，避免两套视图并存；不写库、不改 reportHash / 权威关系。
 * v5 契约没有逐项原因假设层，缺失字段由 `missingFacts` 如实披露，派生逻辑据此降级。
 */
function reportViewV5Of(root: Record<string, unknown>, state: V5ResearchState): ReturnType<typeof buildV5ReportView> {
  const authority = reportAuthorityOf(root, state);
  if (!(authority.status === "current" && authority.source === "v5")) return null;
  if (!state.report || !state.reportHash) return null;
  try {
    return { ...buildV5ReportView(state.report, { reportHash: state.reportHash, researchRevision: state.researchRevision }), authoritative: true } as ReturnType<typeof buildV5ReportView>;
  } catch {
    return null;
  }
}

/**
 * 读侧证据强度审查（P5-v6）。
 *
 * 只读：不改研报、不改权威、不写库。销量可用性来自该任务所属 MarketScan 的
 * `metrics.sales.status`；评论基数来自商品事实；「读取了多少条评论」只能取研报自述（标注来源）。
 */
async function claimAuditOf(input: {
  readonly root: Record<string, unknown>;
  readonly view: NonNullable<ReturnType<typeof buildV5ReportView>>;
  readonly reviewBase: number | null;
}): Promise<import("@/lib/research/evidenceAudit").ResearchClaimAudit | null> {
  try {
    const provenance = isRecord(input.root.marketProvenance) ? input.root.marketProvenance : null;
    const scanId = provenance && typeof provenance.marketScanId === "string" ? provenance.marketScanId : null;
    let salesGrade: EvidenceGrade = "NOT_AVAILABLE";
    if (scanId) {
      const scan = await prisma.marketScan.findUnique({ where: { id: scanId }, select: { metricsJson: true } });
      const metrics = parseJsonRecord(scan?.metricsJson ?? null);
      // P5-v6：销量字段可能是分布对象（PRESENT 时 value 不是数字），且来源是 monthlySalesEstimate 估算。
      // 映射统一走 salesAvailabilityFromMetrics，避免把"有数据"误判成"不可用"、把估算当确认。
      salesGrade = salesAvailabilityFromMetrics(metrics).grade;
    }
    return auditResearchClaims({
      summary: input.view.summary?.text ?? null,
      opportunities: input.view.opportunities.map((item) => item.text),
      risks: input.view.risks.map((item) => item.text),
      painPoints: input.view.painPoints,
      salesGrade,
      reviewBase: input.reviewBase,
    });
  } catch {
    return makeUnavailableClaimAudit("读取销量或审查上下文失败，暂不能采信结论。");
  }
}

/**
 * 列表卡片用的一句话摘要：只投影当前权威研报已保存的摘要文本。
 * 不是事实、不是结论审查结果；客户端必须以“AI 摘要”标注，不得当作已验证事实。
 */
/**
 * 列表「核心发现」投影（只读）。
 *
 * 旧实现取 summary.slice(0,160)：summary 是一整段商品描述，截出来既读不懂又会把
 * 「页面快照 5.0 分」这类描述当成结论。这里改为从当前研报的结构化条目里挑一条
 * 语义完整、带证据引用的发现，不做字符截断、不生成新结论：
 *   current 且有条目 → 主要买家问题 / 核心机会 / 主要风险（均为报告原文整句）
 *   有历史报告但权威已失效 → 历史研报需复核（不把旧推断升级为当前事实）
 *   有当前报告但无可概括条目 → 暂无明确发现
 *   还没有研报 → 尚未研究
 */
export type ResearchFindingProjection = {
  status: "CURRENT" | "HISTORICAL" | "NONE" | "NOT_STARTED";
  label: string;
  text: string | null;
  basis: string | null;
};

function researchFindingOf(
  root: Record<string, unknown>,
  state: V5ResearchState,
  researchState: "report_ready" | "in_progress" | "not_started",
): ResearchFindingProjection {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null);

  if (researchState === "not_started") {
    return { status: "NOT_STARTED", label: "尚未研究", text: null, basis: "还没有生成研报" };
  }

  const authority = reportAuthorityOf(root, state);
  const hasAnyReport = Boolean(state.report) || isRecord(root.researchReport);
  if (authority.status !== "current") {
    return hasAnyReport
      ? { status: "HISTORICAL", label: "历史研报需复核", text: null, basis: "上一版研报已过期（来源变化），结论不能直接采信" }
      : { status: "NONE", label: "暂无明确发现", text: null, basis: "还没有可采信的研报结论" };
  }

  const report = isRecord(state.report) ? state.report : null;
  const voc = report && isRecord(report.vocAnalysis) ? report.vocAnalysis : null;

  /** 只取报告原文的第一句（语义完整），不做字符截断；CSS 端再加 3 行兜底。 */
  const firstSentence = (value: string): string => {
    const match = value.match(/^[\s\S]{6,}?[。！？]/);
    return (match ? match[0] : value).trim();
  };

  const pickFirst = (list: unknown): { text: string; refs: number } | null => {
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const value = isRecord(item) ? text(item.text) : text(item);
      if (value) {
        const refs = isRecord(item) && Array.isArray(item.evidenceRefs) ? item.evidenceRefs.length : 0;
        return { text: value, refs };
      }
    }
    return null;
  };

  const pain = pickFirst(voc?.painPoints);
  if (pain) {
    return {
      status: "CURRENT",
      label: "主要买家问题",
      text: firstSentence(pain.text),
      basis: pain.refs > 0 ? `当前研报 · 引用 ${pain.refs} 条证据` : "当前研报",
    };
  }
  const opportunity = pickFirst(report?.opportunities);
  if (opportunity) {
    return {
      status: "CURRENT",
      label: "核心机会",
      text: firstSentence(opportunity.text),
      basis: opportunity.refs > 0 ? `当前研报 · 引用 ${opportunity.refs} 条证据` : "当前研报",
    };
  }
  const risk = pickFirst(report?.risks);
  if (risk) {
    return {
      status: "CURRENT",
      label: "主要风险",
      text: firstSentence(risk.text),
      basis: risk.refs > 0 ? `当前研报 · 引用 ${risk.refs} 条证据` : "当前研报",
    };
  }
  return { status: "NONE", label: "暂无明确发现", text: null, basis: "当前研报没有可一句话概括的结论，完整内容见详情" };
}

function numericFactValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value) && typeof value.value === "number" && Number.isFinite(value.value)) return value.value;
  return null;
}

/** Current report audit is recomputed from its original text and bound evidence; never from a sanitized copy. */
async function auditForState(input: {
  root: Record<string, unknown>;
  state: V5ResearchState;
  boundary: Awaited<ReturnType<typeof loadCanonicalResearchBoundary>>;
}): Promise<ResearchClaimAudit | null> {
  const v5 = reportViewV5Of(input.root, input.state);
  if (v5) return claimAuditOf({ root: input.root, view: v5,
    reviewBase: input.boundary.ok ? numericFactValue(input.boundary.bundle.productFact?.basic?.reviewCount) : null });
  const authority = reportAuthorityOf(input.root, input.state);
  if (authority.status !== "current") return null;
  const stored = isRecord(input.root.researchReport) ? input.root.researchReport.reportJson : null;
  if (!isRecord(stored)) return makeUnavailableClaimAudit();
  const narrative = (value: unknown): string | null => isRecord(value) && typeof value.text === "string" ? value.text : null;
  const list = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => narrative(item) ?? []) : [];
  const voc = isRecord(stored.vocAnalysis) ? stored.vocAnalysis : {};
  const facts = isRecord(stored.facts) ? stored.facts : {};
  const market = isRecord(facts.market) ? facts.market : {};
  const sales = isRecord(market.monthlySalesEstimate) ? market.monthlySalesEstimate : {};
  return auditResearchClaims({
    summary: narrative(isRecord(stored.executiveSummary) ? stored.executiveSummary.analysis : null),
    opportunities: list([isRecord(stored.marketOpportunity) ? stored.marketOpportunity.analysis : null]),
    risks: list(isRecord(stored.riskAssessment) ? stored.riskAssessment.risks : null),
    painPoints: Array.isArray(voc.painPoints) ? voc.painPoints.flatMap(item => {
      const text = narrative(item); return text ? [{ text, evidenceRefs: [] as string[] }] : [];
    }) : [],
    salesGrade: typeof sales.value === "number" && Number.isFinite(sales.value) && sales.value >= 0 ? "ESTIMATED" : "NOT_AVAILABLE",
    reviewBase: input.boundary.ok ? numericFactValue(input.boundary.bundle.productFact?.basic?.reviewCount) : null,
  });
}

export function assertResearchClaimsConsumable(audit: ResearchClaimAudit | null | undefined): void {
  const code = claimConsumptionBlockReason(audit);
  if (code) throw new V5CoreError(code, claimConsumptionNotice(audit), 409, false, true);
}

async function strengthBlockedTextsOf(input: {
  root: Record<string, unknown>; state: V5ResearchState;
  boundary: Awaited<ReturnType<typeof loadCanonicalResearchBoundary>>;
}): Promise<string[]> {
  const audit = await auditForState(input);
  return audit?.flags.map(flag => flag.text) ?? [];
}

/** 对外暴露的权威判定（只含身份与原因，不含报告内容）。 */
function reportResolutionView(root: Record<string, unknown>, state: V5ResearchState) {
  const authority = reportAuthorityOf(root, state);
  if (authority.status === "current") {
    return {
      status: authority.status,
      source: authority.source,
      reportHash: authority.reportHash,
      generatedAt: authority.generatedAt,
      researchRevision: authority.researchRevision,
      otherPresent: authority.otherPresent,
      reason: authority.reason,
      candidates: [] as { source: string; reportHash: string; generatedAt: string | null }[],
    };
  }
  if (authority.status === "ambiguous") {
    return {
      status: authority.status,
      source: null,
      reportHash: null,
      generatedAt: null,
      researchRevision: null,
      otherPresent: true,
      reason: authority.reason,
      candidates: authority.candidates.map((item) => ({ source: item.source, reportHash: item.reportHash, generatedAt: item.generatedAt })),
    };
  }
  return { status: authority.status, source: null, reportHash: null, generatedAt: null, researchRevision: null, otherPresent: false, reason: authority.reason, candidates: [] };
}

export async function getResearchDetail(input: { context: AccessContext; taskId: string }) {
  requireOwnerContext(input.context);
  const found = await findTask(input.taskId);
  const root = parseJsonRecord(found.task.resultJson);
  const legacyReport = isRecord(root.researchReport) ? root.researchReport.reportJson : null;
  const isEligibleLegacyOnly = isRecord(legacyReport)
    && !found.state.report
    && !found.state.reportHash
    && !found.state.myChoice
    && !hasFormalHumanDecision(root);
  const boundary = await loadCanonicalResearchBoundary({ context: input.context, taskId: found.task.id });
  const legacyGenerationBoundary = isEligibleLegacyOnly ? boundary : null;
  const boundaryProjection = legacyGenerationBoundary
    ? { available: legacyGenerationBoundary.ok, message: legacyGenerationBoundary.ok ? null : legacyGenerationBoundary.message }
    : null;
  // P0-DC：读时组装决策交付物（复用同一 bundle，零额外构建；不落库）
  // V6：人工保存的商业输入 → 情景假设 → 确定性计算；无输入时保持历史 null 行为。
  const commercialInputs = readCommercialInputs(root);
  const economicAssumptions = buildEconomicAssumptions(commercialInputs, {
    marketplace: found.state.marketplace ?? null,
  });
  const decisionDelivery = boundary.ok
    ? buildDecisionDelivery({
        bundle: boundary.bundle,
        assumptions: economicAssumptions,
        marketplace: found.state.marketplace ?? null,
      })
    : null;
  // V6：单位经济性只读展示契约（确定性计算，零 AI；不写任何状态；组装失败降级为 null）。
  const unitEconomics = buildUnitEconomicsProjection(
    boundary,
    economicAssumptions,
    found.state.marketplace ?? null,
  );
  // P1-VOC-03：读时派生改进需求/待供应商确认问题（fail-soft：未分析或读取失败 = available:false，不阻断详情）
  // —— 与 Jev 复核共享同一次正式快照读取（语义不变；仅为避免重复读取）。
  let vocAnalysisRecord: Awaited<ReturnType<typeof getVocAnalysis>> = null;
  try { vocAnalysisRecord = await getVocAnalysis(input.context, found.task.id); } catch { vocAnalysisRecord = null; }
  const vocImprovementInsights = vocAnalysisRecord ? {
    available: true as const,
    requirements: deriveImprovementRequirements(vocAnalysisRecord.themes.painPointThemes, vocAnalysisRecord.themes.recurringRequests),
    checkpoints: deriveSupplierCheckpoints(vocAnalysisRecord.themes.painPointThemes),
    // 主题摘要：即使样本不足派生不出改进需求，也让用户看到真实分析出的痛点/请求主题（不伪造）。
    // kind 保留上游类目（pain=负向 / positive=正向 / request=请求），展示层据此分层，禁止靠关键词猜测情绪。
    themes: [
      ...vocAnalysisRecord.themes.painPointThemes.map((theme) => ({ ...theme, kind: "pain" as const })),
      ...vocAnalysisRecord.themes.positiveThemes.map((theme) => ({ ...theme, kind: "positive" as const })),
      ...vocAnalysisRecord.themes.recurringRequests.map((theme) => ({ ...theme, kind: "request" as const })),
    ].map((theme) => ({
      label: theme.label,
      summary: theme.summary,
      reviewCount: typeof theme.reviewCount === "number" && Number.isFinite(theme.reviewCount) ? theme.reviewCount : 0,
      strength: theme.strength,
      kind: theme.kind,
    })),
    // 独立评论计数来自正式分析快照（datasetSnapshot），与主题提及次数（reviewCount 之和）严格分开
    reviewSnapshot: vocAnalysisRecord.datasetSnapshot
      ? {
          totalReviews: vocAnalysisRecord.datasetSnapshot.totalReviews,
          reviewsUsed: vocAnalysisRecord.datasetSnapshot.reviewsUsed,
        }
      : null,
    // 商品级证据缺口与下一步研究建议：直接透传正式 VOC 分析快照，供验证需求单派生商品专项任务
    unknowns: vocAnalysisRecord.unknowns,
    nextResearchSteps: vocAnalysisRecord.nextResearchSteps,
  } : { available: false as const, requirements: [], checkpoints: [], themes: [], unknowns: [], nextResearchSteps: [] };
  // Jev 二次复核读侧视图（只读；不触发任何 Provider 调用；功能未启用时为零成本最小投影）
  const jevReadiness = buildJevReadinessDetailView({
    taskId: found.task.id,
    state: found.state,
    boundary,
    delivery: decisionDelivery,
    vocAnalysis: vocAnalysisRecord,
  });
  // P2-04：v1 研报（researchReport）没有 v5Research.reportHash，读侧必须暴露同一份
  // 正式报告的 hash，否则客户端无法携带正确的 expectedReportHash 去保存人工决定。
  const effectiveReport = effectiveReportBinding(root, found.state);
  // 注意：不能用权威 hash 覆盖 state.reportHash 再去做权威判定——
  // 那会让 v5 候选携带 v1 的 hash，两个候选同 hash 反而被判定为歧义。
  // 权威 hash 只在返回对象上覆盖（供客户端携带 expectedReportHash）。
  const readState: V5ResearchState = found.state;
  // P5-v6：强度审查的阻断句在此处一次性算出，既用于消费投影消毒，也用于 03 审查卡。
  const claimAudit = await auditForState({ root, state: readState, boundary });
  const strengthBlockedTexts = claimAudit?.flags.map(flag => flag.text) ?? [];
  const v5ViewForDetail = reportViewV5Of(root, readState);
  const detailBase = await taskDetail(found.task, found.candidate ? { id: found.candidate.id, name: found.candidate.name, sourceMetaJson: found.candidate.sourceMetaJson, link: found.candidate.link } : null, readState, boundaryProjection, await researchReadStaleState(input.context, found.task.id, root, readState), boundary.ok ? boundary.bundle.productFact : null, decisionDelivery, strengthBlockedTexts);
  const authorityHash = effectiveReport.reportHash;
  return {
    ...detailBase,
    claimAudit,
    consumptionBlocked: Boolean(claimAudit && claimConsumptionBlockReason(claimAudit)),
    consumptionNotice: claimAudit ? claimConsumptionNotice(claimAudit) : null,
    // 对客户端而言 reportHash 恒表示「当前权威报告 hash」；权威不明时保留原值并靠 reportResolution 提示。
    ...(authorityHash && authorityHash !== detailBase.reportHash ? { reportHash: authorityHash } : {}),
    vocImprovementInsights,
    jevReadiness,
    unitEconomics,
    researchDepthDiagnosis: researchDepthDiagnosisOf(root),
    reportViewV1: reportViewV1Of(root, found.state),
    reportViewV5: v5ViewForDetail
      ? {
          ...v5ViewForDetail,
          claimAudit,
        }
      : null,
    reportResolution: reportResolutionView(root, found.state),
  };
}

export async function runResearchAdvisory(input: {
  context: AccessContext; taskId: string; expectedRevision: number; requested: string[]; expectedFactHash?: string | null; expectedEvidenceHash?: string | null; confirmFinalAdvisoryRegeneration?: boolean; idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const result = await withV5Receipt({
    context: input.context, operation: "research:advisory", resourceKey: input.taskId, idempotencyKey: input.idempotencyKey,
    requestBody: { confirmFinalAdvisoryRegeneration: input.confirmFinalAdvisoryRegeneration === true, expectedRevision: input.expectedRevision, requested: input.requested, expectedFactHash: input.expectedFactHash ?? null, expectedEvidenceHash: input.expectedEvidenceHash ?? null },
    execute: async () => {
      const found = await findTask(input.taskId);
      if (process.env.V5_RESEARCH_PROVIDER === "fake") throw new V5CoreError("TEST_ADVISORY_FORBIDDEN", "测试 advisory 不能写入正式研究链路。", 409);
      if (found.state.myChoice?.scope === "FINAL" && input.confirmFinalAdvisoryRegeneration !== true) throw new V5CoreError("FINAL_ADVISORY_CONFIRMATION_REQUIRED", "已有最终决策。重生成前须明确确认，旧决策将保留并需要重新确认。", 409);
      if (found.state.researchRevision !== input.expectedRevision) throw new V5CoreError("RESEARCH_REVISION_STALE", "研究版本已变化，请刷新后重试。", 409, false, true);
      if (input.expectedFactHash !== undefined && input.expectedFactHash !== found.state.factHash) throw new V5CoreError("FACT_STALE", "事实绑定已变化，请刷新后重试。", 409, false, true);
      if (input.expectedEvidenceHash !== undefined && input.expectedEvidenceHash !== found.state.evidenceHash) throw new V5CoreError("EVIDENCE_STALE", "证据绑定已变化，请刷新后重试。", 409, false, true);
      let gate = systemSuggestion(found.state);
      let report = found.state.report;
      let reportHash = found.state.reportHash;
      let revision = found.state.researchRevision;
      let nextFactHash = found.state.factHash;
      let nextEvidenceHash = found.state.evidenceHash;
      let nextEvidenceRefs = found.state.evidenceRefs;
      let reportBindingHashes = found.state.reportBindingHashes;
      let deepseek: Record<string, unknown> = {
        status: "unavailable",
        summary: null,
        opportunities: [],
        risks: [],
        citations: [],
        reportRefs: found.state.evidenceRefs,
      };

      // 唯一生产输入边界：正式 ResearchInputBundle + EvidenceStore
      const boundary = await loadCanonicalResearchBoundary({
        context: input.context,
        taskId: found.task.id,
        recordDiagnostic: true,
      });

      if (!boundary.ok) {
        // EvidenceStore / ProductFact 不可读 → 不生成新的正式结论；保留既有 report 供审计
        deepseek = {
          status: "failed",
          summary: null,
          opportunities: [],
          risks: [],
          citations: [],
          reportRefs: found.state.evidenceRefs,
          errorCode: boundary.errorCode,
          message: boundary.message,
        };
        report = found.state.report;
        reportHash = found.state.reportHash;
      } else {
        const { bundle, allowedEvidenceRefs } = boundary;
        // P0-DC：advisory 持久化时写入真实确定性判断（有 delivery 时；失败则保持安全默认）
        gate = systemSuggestion(found.state, buildDecisionDelivery({ bundle }));

        const seedUnverified: string[] = [
          ...bundle.missingFields.map((missing) => missingFactDisplayText(missing)),
          ...bundle.conflicts.map((conflict) => factConflictDisplayText(conflict)),
        ];


        const persistBoundReport = (bound: BoundNarrativeReport) => {
          report = {
            schema: "research-report.v5",
            summary: bound.summary,
            opportunities: bound.opportunities,
            risks: bound.risks,
            vocAnalysis: bound.vocAnalysis,
            citations: bound.citations,
            unverifiedAssumptions: bound.unverifiedAssumptions,
            narrativeBindings: bound.narrativeBindings,
            allowedEvidenceRefs,
            // P0 证据可信度：结构化保留拒收审计（字段路径 / 非法引用 / 处理方式 / 原文预览）。
            // 读侧据此判定是否需要对**已持久化**内容做保守屏蔽（见 research/reportEvidenceIntegrity.ts）。
            rejectedClaims: bound.rejectedClaims,
          };
          reportHash = hashJson(report);
          revision = Math.max(1, revision + 1);
          nextEvidenceRefs = allowedEvidenceRefs;
          deepseek = {
            status: "available",
            summary: bound.summary,
            opportunities: bound.opportunities,
            risks: bound.risks,
            vocAnalysis: bound.vocAnalysis,
            citations: bound.citations,
            unverifiedAssumptions: bound.unverifiedAssumptions,
            reportRefs: allowedEvidenceRefs,
          };
          // 4-hash：正式边界可用时，用 canonical ProductFact / evidence refs 刷新绑定
          // factHash 使用稳定事实子集（与 stale 检查同一入口；剔除动态派生字段，见 research/stableFactHash.ts）。
          nextFactHash = stableFactHash(bundle.productFact);
          nextEvidenceHash = hashJson(
            bundle.sourceEvidenceRefs
              .map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
              .sort((a, b) => a.refId.localeCompare(b.refId)),
          );
          reportBindingHashes = { factHash: nextFactHash, evidenceHash: nextEvidenceHash, reportHash, researchEvidenceHash: computeResearchEvidenceHash(parseJsonRecord(found.task.resultJson)) };
        };

        {
          const config = getAiConfig();
          if (!config.ok || config.data.provider !== "deepseek") {
            deepseek = {
              status: "unavailable",
              summary: null,
              opportunities: [],
              risks: [],
              citations: [],
              reportRefs: allowedEvidenceRefs,
              errorCode: !config.ok ? config.error.code : "provider_not_deepseek",
            };
          } else {
            const nonSellerSpriteTrends = bundle.trendObservations?.filter((observation) => observation.sourceType !== "sellersprite_plugin") ?? [];
            const trendSummary = nonSellerSpriteTrends.length
              ? summarizeTrendObservations(nonSellerSpriteTrends)
              : null;
            const providerMarketSummary = buildProviderMarketResearchSummary({
              subjectKey: bundle.subjectKey,
              allowedEvidenceRefs,
              sourceEvidenceRefs: bundle.sourceEvidenceRefs,
              providerMetricEvidence: bundle.providerMetricEvidence,
              providerProductMarketEvidence: bundle.providerProductMarketEvidence,
              trendObservations: bundle.trendObservations,
            });
            const system = [
              "你是轻选工作台 V5 商品深度研究分析助手。",
              "请基于提供的正式 ResearchInputBundle（商品事实与证据）进行严谨商业研判。",
              "summary / opportunities[] / risks[] 每条都必须绑定至少 1 个合法 evidenceRefs（来自 allowedEvidenceRefs）。",
              "citations 的 source 必须属于 allowlist（allowedEvidenceRefs），禁止虚构引用。",
              "若提供了 trendSummary，请在 opportunities 或 risks 中研判历史走势并引用对应 attachment 凭证（来自 allowedEvidenceRefs）。",
              "若提供了 reviewEvidence，请在 opportunities 或 risks 中提炼真实买家痛点并引用对应 attachment 凭证（来自 allowedEvidenceRefs）。",
              "引用评论时必须保留同句正面限定和反例；单条/少量评论只能写为样本内观察，不得概括为买家痛点、普遍问题或品类共性；无法确认时放入 unverifiedAssumptions。",
              "若提供了 customerVoiceEvidence，请区分来源、provenance.accessBasis 与 identityMatch，仅把有直接证据的买家体验用于 VOC 研判，并在对应 narrative/citation 中引用其 attachment 凭证；UNRESOLVED 不得描述成该商品的已确认体验。user_supplied_file/user_supplied_text 的评分和 verifiedPurchase 只能表述为用户提供文件/文本中的记录，不得说成 Amazon 已验证购买；只有 amazon_review + first_party_visible_page 才能按 Amazon 页面观察来源描述。",
              "有 customerVoiceEvidence 时，可输出 vocAnalysis：painPoints、positiveSignals、failureModes、useCases、replacementSignals、switchReasons、ownershipClaims。每条必须是 {text,evidenceRefs}，且 evidenceRefs 使用该观察所在的合法 attachment ref；只总结原文支持的内容。自述购买/拥有只能作为 ownership claim，不得升级为已验证购买或商品事实。没有证据的类别返回空数组；无法核实的内容保留在 unverifiedAssumptions。",
              "若提供了 keywordEvidence，请在 opportunities 中结合搜索热度研判市场机会并引用对应 attachment 凭证（来自 allowedEvidenceRefs）。",
              "SellerSprite 关键词表的聚合价格/均价是关键词市场估算，不是同口径竞品价格分布；不得据此推导竞品主流价格带。只有明确同口径的竞品价格样本才能比较价格带。",
              "若提供了 providerMarketSummary，按每个来源的 provider、module、subject/ASIN、marketplace、capturedAt、metricNature 和 limitations 分别研判，并引用该来源的精确 evidenceRefId（必须属于 allowedEvidenceRefs）；不同来源或时间的值不得静默合并。",
              "SellerSprite 的 provider_observed 仍是第三方页面观察，不是 Amazon 确认事实；provider_estimate 必须明确写成估算，绝不表述为实际销量、收入或 Amazon 实测。BSR 必须连同类目与采集时间表达；父体身份与子体 ASIN 必须分开，父体数据不能当作子体数据。缺失指标不推断，不根据 BSR 换算销量。",
              "SellerSprite 历史趋势以 providerMarketSummary 中按附件独立汇总的 provider_estimate 为准；不得将多个来源合并后的趋势另行归因。",
              "没有合法引用的内容不要输出为正式 narrative。",
              RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT,
            ].join("\n");
            const user = JSON.stringify({
              researchInputBundle: bundle,
              trendSummary,
              providerMarketSummary,
              allowedEvidenceRefs,
            });
            const aiRes = await callAiJson<NarrativeDraft>({
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              temperature: 0.2,
              responseFormat: { type: "json_object" },
              maxTokens: researchAdvisoryMaxTokens(),
              thinkingMode: "disabled",
            });
            if (aiRes.ok) {
              const validated = validateNarrativeDraft(aiRes.data);
              if (!validated.ok) {
                deepseek = {
                  status: "failed",
                  summary: null,
                  opportunities: [],
                  risks: [],
                  citations: [],
                  reportRefs: allowedEvidenceRefs,
                  errorCode: "PROVIDER_SCHEMA_VALIDATION_ERROR",
                  diagnostics: { ...aiRes.diagnostics, schemaStage: "failed", errorClass: validated.errorClass },
                };
                // Failed attempts retain the complete previous report and its bindings.
              } else {
                const bound = bindNarrativesWithCitations(validated.data, allowedEvidenceRefs, seedUnverified);
                if (!hasBoundResearchNarrative(bound)) {
                  const disallowedRef = bound.unverifiedAssumptions.some((item) => item.includes("allowlist 外"));
                  deepseek = {
                    status: "failed",
                    summary: null,
                    opportunities: [],
                    risks: [],
                    citations: bound.citations,
                    unverifiedAssumptions: bound.unverifiedAssumptions,
                    reportRefs: allowedEvidenceRefs,
                    errorCode: disallowedRef ? "PROVIDER_REF_NOT_ALLOWED" : "PROVIDER_CITATION_VALIDATION_ERROR",
                    diagnostics: { ...aiRes.diagnostics, schemaStage: "passed", errorClass: disallowedRef ? "ref_not_allowed" : "citation_validation_error" },
                  };
                  // Failed attempts retain the complete previous report and its bindings.
                } else {
                  persistBoundReport(bound);
                  deepseek = {
                    ...deepseek,
                    diagnostics: { ...aiRes.diagnostics, schemaStage: "passed", errorClass: "none" },
                  };
                }
              }
            } else {
              const failureClass = aiRes.diagnostics?.responseFailureClass;
              const providerErrorCode = failureClass === "truncated" ? "PROVIDER_FINISH_REASON_LENGTH"
                : failureClass === "content_empty" ? "PROVIDER_EMPTY_RESPONSE"
                : failureClass === "content_missing" ? "PROVIDER_CONTENT_MISSING"
                : failureClass === "refusal" ? "PROVIDER_REFUSAL"
                : failureClass === "unknown_response_shape" && aiRes.diagnostics?.providerHttpStatusClass === "success" ? "PROVIDER_UNKNOWN_RESPONSE_SHAPE"
                : failureClass === "non_json" ? "PROVIDER_NON_JSON_RESPONSE"
                : failureClass === "invalid_json" ? "PROVIDER_JSON_PARSE_ERROR"
                : aiRes.error.code;
              deepseek = {
                status: "failed",
                summary: null,
                opportunities: [],
                risks: [],
                citations: [],
                reportRefs: allowedEvidenceRefs,
                errorCode: providerErrorCode,
                diagnostics: aiRes.diagnostics ? { ...aiRes.diagnostics, schemaStage: "not_started" } : undefined,
              };
            }
          }
        }
      }

      const generatedView = report ? buildV5ReportView(report, { reportHash: reportHash ?? "", researchRevision: revision }) : null;
      const generatedClaimAudit = generatedView ? await claimAuditOf({
        root: parseJsonRecord(found.task.resultJson), view: generatedView,
        reviewBase: boundary.ok ? numericFactValue(boundary.bundle.productFact?.basic?.reviewCount) : null,
      }) : null;
      const advisory = {
        claimAudit: generatedClaimAudit,
        deepseek,
        // A2：记录本次研报生成时的 VOC 规则版本（读侧据此判断是否需要重新核对；
        // 不参与 reportHash/stale 合同，历史无版本记录的报告标记 UNKNOWN）。
        vocRuleVersion: VOC_RULE_VERSION,
        evidenceRiskGate: {
          status: gate.status,
          evidenceSufficiency: gate.evidenceSufficiency,
          blockingRisk: gate.blockingRisk,
          gateVersion: "deterministic-v1",
        },
        compositeSuggestion: {
          status: gate.status,
          composite: gate.composite,
          inputs: found.state.evidenceRefs,
          gateVersion: "deterministic-v1",
        },
      };
      const nextState: V5ResearchState = {
        ...found.state,
        researchRevision: revision,
        report,
        reportHash,
        advisory,
        factHash: nextFactHash,
        evidenceHash: nextEvidenceHash,
        evidenceRefs: nextEvidenceRefs,
        reportBindingHashes,
      };
      // 本轮 v5 生成即声明「v5 是最近一次产出的正式报告」，读侧据此判定权威。
      await commitResearchState(input.context, found.task, nextState, "RESEARCH_REVISION_STALE", undefined,
        typeof reportHash === "string" && reportHash
          ? {
              source: "v5",
              reportHash,
              generatedAt: typeof (report as { generatedAt?: unknown }).generatedAt === "string" ? (report as { generatedAt: string }).generatedAt : new Date().toISOString(),
              researchRevision: revision,
            }
          : undefined);
      return { researchRevision: nextState.researchRevision, factHash: nextState.factHash, evidenceHash: nextState.evidenceHash, deepseek, evidenceRiskGate: advisory.evidenceRiskGate, compositeSuggestion: advisory.compositeSuggestion, myChoiceStatus: nextState.myChoice ? nextState.myChoice.scope === "FINAL" ? "finalized" : "temporary_watch" : "none" };
    },
  });
  return { ...result.value, replayed: result.replayed };
}

/**
 * Jev Research Readiness — 独立复核 API 服务实现（与 DeepSeek 研报生成完全隔离）。
 *
 * 硬边界（本轮最小无持久化）：
 * - 不调用 DeepSeek、不重生成研报、不改 researchRevision / reportHash / factHash / evidenceHash；
 * - 不改 Human Decision、不改 Candidate analysisJson、不写 EvidenceStore、不触发飞书同步；
 * - 结果只回传前端 + 进程内缓存（进程重启后消失，属预期，UI 如实提示）。
 *
 * 调用前拒绝（全部发生在进入 Provider 之前，命中即 0 外部请求）：
 * 功能未启用 / Provider 不可用（含未确认预算）/ 版本与绑定 CAS 冲突 / 输入不可构建 /
 * Idempotency 重放冲突 / 同版本重跑冷却。
 */
export async function runJevReadinessAdvisory(input: {
  context: AccessContext;
  taskId: string;
  expectedRevision: number;
  expectedFactHash: string;
  expectedEvidenceHash: string;
  confirmRerun: boolean;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);

  // 1) 功能总开关（默认关闭）+ Provider 授权（未确认预算 / 未配置 → 不可用）
  const policy = readJevReadinessPolicy();
  if (!policy.enabled) {
    throw new V5CoreError("JEV_READINESS_DISABLED", "AI 二次复核未启用（默认关闭；未发起任何请求）。", 409, false, true);
  }
  const resolvedProvider = getReadinessAdviceProvider();
  if (resolvedProvider.kind === "unavailable") {
    throw new V5CoreError("JEV_READINESS_PROVIDER_UNAVAILABLE", `AI 二次复核 Provider 不可用（${resolvedProvider.reason ?? "not-configured"}；未发起任何请求）。`, 409, false, true);
  }

  // 2) 服务端重读并校验当前正式绑定；客户端提交的 hash 只作期望版本
  const found = await findTask(input.taskId);
  const state = found.state;
  if (input.expectedRevision !== state.researchRevision) {
    throw new V5CoreError("RESEARCH_REVISION_STALE", "研究版本已变化，请刷新后重试（未发起任何请求）。", 409, false, true);
  }
  if (input.expectedFactHash !== state.factHash) {
    throw new V5CoreError("FACT_STALE", "事实绑定已变化，请刷新后重试（未发起任何请求）。", 409, false, true);
  }
  if (input.expectedEvidenceHash !== state.evidenceHash) {
    throw new V5CoreError("EVIDENCE_STALE", "证据绑定已变化，请刷新后重试（未发起任何请求）。", 409, false, true);
  }
  if (!state.report || !state.reportHash || !state.factHash || !state.evidenceHash) {
    throw new V5CoreError("JEV_READINESS_INPUT_UNAVAILABLE", "缺少有效研报或证据绑定，暂不可复核（未发起任何请求）。", 409, false, true);
  }

  // 3) 正式读边界（唯一生产输入入口；recordDiagnostic=false 不写审计）+ 输入构建
  const boundary = await loadCanonicalResearchBoundary({ context: input.context, taskId: found.task.id, recordDiagnostic: false });
  if (!boundary.ok) {
    throw new V5CoreError("JEV_READINESS_INPUT_UNAVAILABLE", `正式证据边界不可用（${boundary.errorCode}；未发起任何请求）。`, 409, false, true);
  }
  const delivery = buildDecisionDelivery({ bundle: boundary.bundle });
  let vocAnalysis: Awaited<ReturnType<typeof getVocAnalysis>> = null;
  try { vocAnalysis = await getVocAnalysis(input.context, found.task.id); } catch { vocAnalysis = null; }
  const built = buildJevReadinessInputFromProduction({
    taskId: found.task.id,
    asin: typeof state.asin === "string" && state.asin ? state.asin : null,
    binding: { reportHash: state.reportHash, factHash: state.factHash, evidenceHash: state.evidenceHash, researchRevision: state.researchRevision },
    report: sanitizeReportForConsumption(state.report, {
      strengthBlockedTexts: await strengthBlockedTextsOf({ root: parseJsonRecord(found.task.resultJson), state, boundary }),
    }).report,
    bundle: boundary.bundle,
    allowedEvidenceRefs: boundary.allowedEvidenceRefs,
    delivery,
    vocAnalysis,
  });
  if (!built.ok) {
    throw new V5CoreError("JEV_READINESS_INPUT_UNAVAILABLE", `复核输入不可用（${built.reason}；未发起任何请求）。`, 409, false, true);
  }

  // 4) 运行时护栏（幂等重放 / 同版本会话缓存 / 重跑冷却 / 单飞去重；全部先于任何外部请求）
  const runtime = getJevReadinessRuntime();
  const guarded = await runtime.run({
    taskId: found.task.id,
    input: built.input,
    provider: resolvedProvider.provider,
    providerKind: resolvedProvider.kind,
    idempotencyKey: input.idempotencyKey,
    forceRefresh: input.confirmRerun === true,
  });
  if (!guarded.ok) {
    throw new V5CoreError(guarded.code, guarded.message, 409, false, true);
  }

  // 5) 执行后重读：运行期间研究状态变化 → 结果不得作为当前有效建议返回
  const after = await findTask(input.taskId);
  const bindingChanged = after.state.researchRevision !== state.researchRevision
    || after.state.factHash !== state.factHash
    || after.state.evidenceHash !== state.evidenceHash
    || after.state.reportHash !== state.reportHash;
  if (bindingChanged) {
    throw new V5CoreError("JEV_READINESS_STATE_CHANGED", "执行期间研究状态已变化；本次复核结果不作为当前有效建议，请刷新后重试。", 409, false, true);
  }

  const result = guarded.result;
  return {
    jevStatus: result.status,
    advice: result.advice,
    provider: result.provider,
    model: result.model,
    providerKind: resolvedProvider.kind,
    generatedAt: result.generatedAt,
    sideEffects: result.sideEffects,
    sideEffectsVerification: result.sideEffectsVerification,
    requestTrackerKind: result.requestTrackerKind,
    rejected: result.rejected,
    notes: result.notes,
    binding: { ...built.input.binding },
    meta: {
      cached: guarded.cached,
      deduped: guarded.deduped,
      replayed: guarded.replayed,
    },
  };
}

export async function saveResearchChoice(input: {
  context: AccessContext;
  taskId: string;
  choice?: "PROCEED" | "WATCH" | "DROP";
  canonicalStatus?: CanonicalDecisionStatus;
  applyTeamRecommendation?: boolean;
  expectedTeamRecommendationId?: string;
  expectedVersion?: string;
  reason?: string;
  readinessAcknowledged?: boolean;
  expectedRevision: number;
  expectedReportHash: string;
  expectedFactHash: string;
  expectedEvidenceHash: string;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (input.reason !== undefined && input.reason.length > 2000) throw new V5CoreError("INVALID_INPUT", "决策备注最多 2000 字。", 400);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);

  let canonicalStatus = input.canonicalStatus
    ?? (input.choice === "PROCEED" ? "PROCEED" : input.choice === "DROP" ? "DROP" : undefined);
  let choice = input.choice ?? (canonicalStatus ? canonicalToLegacyChoice(canonicalStatus) : "WATCH");
  let decisionStatus = canonicalStatus
    ? canonicalToDbDecisionStatus(canonicalStatus)
    : (choice === "DROP" ? "rejected" : choice === "PROCEED" ? "continue" : "need_info");

  const result = await withV5Receipt({ context: input.context, operation: "research:choice", resourceKey: input.taskId, idempotencyKey: input.idempotencyKey, requestBody: input, execute: async () => {
    const found = await findTask(input.taskId);
    assertExpectedVersionMatches(expectedVersion, found.task.updatedAt);
    const recommendation = found.state.teamRecommendation;
    if (input.expectedTeamRecommendationId !== undefined && (recommendation?.id !== input.expectedTeamRecommendationId || recommendation?.status !== "VERIFIED_TEAM_RECOMMENDATION")) throw new V5CoreError("TEAM_RECOMMENDATION_STALE", "飞书端建议已变化或已处理，请刷新后重试。", 409, false, true);
    if (input.applyTeamRecommendation === true) {
      const bindings = recommendation && isRecord(recommendation.bindingHashes) ? recommendation.bindingHashes : null;
      if (!bindings || bindings.reportHash !== found.state.reportHash || bindings.factHash !== found.state.factHash
        || bindings.evidenceHash !== found.state.evidenceHash || bindings.researchRevision !== found.state.researchRevision) throw new V5CoreError("TEAM_RECOMMENDATION_STALE", "飞书端建议针对的报告或证据已变化。", 409, false, true);
      const active = found.state.feishuHubPacketBinding;
      if (!active || active.status !== "active" || bindings.packetHash !== active.packetHash || bindings.subjectKey !== active.subjectKey
        || active.revision !== found.state.researchRevision || active.factHash !== found.state.factHash || active.evidenceHash !== bindings.packetEvidenceHash
        || active.taskId !== input.taskId) throw new V5CoreError("TEAM_RECOMMENDATION_STALE", "当前研究包绑定已变化。", 409, false, true);
      const target = teamRecommendationToCanonical(recommendation?.recommendationStatus);
      if (!target) throw new V5CoreError("TEAM_RECOMMENDATION_INVALID", "飞书端建议四态值无效。", 422);
      canonicalStatus = target; choice = canonicalToLegacyChoice(target); decisionStatus = canonicalToDbDecisionStatus(target);
    }
    const choiceRoot = parseJsonRecord(found.task.resultJson);
    const effectiveReport = effectiveReportBinding(choiceRoot, found.state);
    // 两份报告并存且无法确认权威时，拒绝写入决定，避免把决定绑到错误报告。
    if (effectiveReport.resolution.status === "ambiguous") {
      throw new V5CoreError("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS", "当前无法确认哪一份是正式报告（V1 与 V5 并存且缺少权威记录）。请重新生成一次研报后再保存决定。", 409, false, true);
    }
    if (!effectiveReport.reportHash) throw new V5CoreError("RESEARCH_REPORT_REQUIRED", "没有正式研究报告，不能保存最终选择。", 409, false, true);
    if (found.state.researchRevision !== input.expectedRevision) throw new V5CoreError("REPORT_STALE", "研究版本已变化，请刷新后重试。", 409, false, true);
    if ((effectiveReport.reportHash ?? "") !== (input.expectedReportHash ?? "")) throw new V5CoreError("REPORT_STALE", "研究报告已变化，请刷新后重试。", 409, false, true);
    if ((found.state.factHash ?? "") !== (input.expectedFactHash ?? "")) throw new V5CoreError("FACT_STALE", "事实绑定已变化，请刷新后重试。", 409, false, true);
    if ((found.state.evidenceHash ?? "") !== (input.expectedEvidenceHash ?? "")) throw new V5CoreError("EVIDENCE_STALE", "证据绑定已变化，请刷新后重试。", 409, false, true);
    const staleState = await researchReadStaleState(input.context, found.task.id, parseJsonRecord(found.task.resultJson), found.state);
    if (staleState.reportStale) throw new V5CoreError("RESEARCH_EVIDENCE_STALE", "研究证据已变化，请重生成研报后再确认决策。", 409, false, true);
    // P0-DC-04 决策就绪知悉门禁：服务端自行重算确定性风险，不信任前端计数（fail-closed）。
    const readinessBoundary = await loadCanonicalResearchBoundary({ context: input.context, taskId: found.task.id });
    if (canonicalStatus === "PROCEED" || choice === "PROCEED") {
      assertResearchClaimsConsumable(await auditForState({ root: choiceRoot, state: found.state, boundary: readinessBoundary }));
    }
    const readinessDelivery = readinessBoundary.ok ? buildDecisionDelivery({ bundle: readinessBoundary.bundle }) : null;
    const readinessCounts = readinessDelivery?.status === "available" ? readinessDelivery.riskCounts : undefined;
    const readinessAckRequired = Boolean(readinessCounts && (readinessCounts.blocking > 0 || readinessCounts.notComputable > 0));
    if (readinessAckRequired && input.readinessAcknowledged !== true) {
      const blockingCount = readinessCounts ? readinessCounts.blocking : 0;
      const missingCount = readinessCounts ? readinessCounts.notComputable : 0;
      throw new V5CoreError("READINESS_ACK_REQUIRED", `存在 ${blockingCount} 项阻断风险与 ${missingCount} 项不可评估数据缺失，请先勾选知悉确认后再提交决策。`, 409, false, true);
    }
    const bindingHashes = { researchRevision: found.state.researchRevision, factHash: found.state.factHash, evidenceHash: found.state.evidenceHash, reportHash: effectiveReport.reportHash,
      researchEvidenceHash: computeResearchEvidenceHash(parseJsonRecord(found.task.resultJson)) };
    const decisionBindingHash = hashJson({ taskId: found.task.id, asin: found.state.asin,
      ...bindingHashes, choice, canonicalStatus: canonicalStatus ?? null });
    const chosenAt = new Date().toISOString();
    const myChoice = {
      choice,
      canonicalStatus: canonicalStatus ?? null,
      scope: "FINAL",
      chosenAt,
      chosenBy: "owner:v1",
      reason: input.reason ?? null,
      ...(readinessAckRequired && input.readinessAcknowledged === true ? { readinessAcknowledged: true } : {}),
      source: { kind: "local_workbench", ...(recommendation?.status === "VERIFIED_TEAM_RECOMMENDATION" ? { teamRecommendationId: recommendation.id } : {}) },
      bindingHashes, decisionBindingHash, decisionHash: decisionBindingHash,
    };
    const target = teamRecommendationToCanonical(recommendation?.recommendationStatus);
    const nextRecommendation = recommendation?.status === "VERIFIED_TEAM_RECOMMENDATION" ? { ...recommendation,
      status: target === canonicalStatus ? "APPLIED" : "OVERRIDDEN", reviewedBy: "owner:v1", reviewedAtWorkbench: chosenAt,
      finalCanonicalStatus: canonicalStatus, finalDecisionBindingHash: decisionBindingHash } : recommendation;
    const nextState = { ...found.state, myChoice, teamRecommendation: nextRecommendation };
    await commitResearchState(input.context, found.task, nextState, "CHOICE_CAS_CONFLICT", decisionStatus);
    return {
      taskId: found.task.id,
      asin: found.state.asin,
      researchRevision: found.state.researchRevision,
      myChoice: choiceProjection(myChoice),
      decisionBindingHash,
      stale: false,
    };
  } });
  return { ...result.value, replayed: result.replayed };
}

export async function applyResearchTeamRecommendation(input: {
  context: AccessContext; taskId: string; recommendationId: string; confirmed: boolean; expectedVersion: string;
  expectedRevision: number; expectedReportHash: string; expectedFactHash: string; expectedEvidenceHash: string;
  readinessAcknowledged?: boolean; idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (input.confirmed !== true) throw new V5CoreError("TEAM_RECOMMENDATION_CONFIRMATION_REQUIRED", "请在 Workbench 显式确认飞书端建议。", 422);
  return saveResearchChoice({ ...input, expectedTeamRecommendationId: input.recommendationId, applyTeamRecommendation: true,
    reason: "Workbench 用户明确确认该飞书端建议" });
}

export async function saveTemporaryWatch(input: { context: AccessContext; taskId: string; note?: string; hasCandidateIdField: boolean; idempotencyKey: string }) {
  requireOwnerContext(input.context);
  if (input.hasCandidateIdField) throw new V5CoreError("TEMPORARY_WATCH_CANDIDATE_ID_FORBIDDEN", "candidateId 必须由服务端从 Task 推导。", 400);
  if (input.note !== undefined && input.note.length > 2000) throw new V5CoreError("INVALID_INPUT", "临时观察备注最多 2000 字。", 400);
  const result = await withV5Receipt({ context: input.context, operation: "research:temporary-watch", resourceKey: input.taskId, idempotencyKey: input.idempotencyKey, requestBody: { note: input.note ?? null }, execute: async () => {
    const found = await findTask(input.taskId);
    if (!found.state.candidateId) throw new V5CoreError("CANDIDATE_BINDING_MISSING", "Task 未绑定 Candidate。", 409, false, true);
    if (found.state.report) throw new V5CoreError("TEMPORARY_WATCH_REPORT_EXISTS", "已有正式报告，请使用最终选择。", 409, false, true);
    if (found.state.myChoice?.scope === "FINAL") throw new V5CoreError("TEMPORARY_WATCH_CHOICE_EXISTS", "已有最终选择，不能创建临时观察。", 409, false, true);
    const row = { id: `temporary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, note: input.note ?? null, createdAt: new Date().toISOString(), source: "human_manual", scope: "TEMPORARY" };
    const nextState = { ...found.state, temporaryWatches: [...found.state.temporaryWatches, row] };
    await commitResearchState(input.context, found.task, nextState, "CAS_CONFLICT");
    return { taskId: found.task.id, candidateId: found.state.candidateId, researchRevision: null, temporaryWatch: row };
  } });
  return { ...result.value, replayed: result.replayed };
}

export async function researchTaskAction(input: { context: AccessContext; taskId: string; action: "archive" | "restore" | "delete"; expectedVersion: unknown; idempotencyKey: string }) {
  requireOwnerContext(input.context);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const result = await withV5Receipt({ context: input.context, operation: `research:${input.action}`, resourceKey: input.taskId, idempotencyKey: input.idempotencyKey, requestBody: { action: input.action, expectedVersion }, execute: async () => {
    const found = await findTask(input.taskId);
    assertExpectedVersionMatches(expectedVersion, found.task.updatedAt);
    if (input.action === "delete") {
      if (found.state.report || found.state.myChoice || found.state.temporaryWatches.length) throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "已有研究产物或选择，只能归档。", 409, false, true);
      await prisma.$transaction(async (tx) => {
        if (found.state.candidateId) await tx.opportunityCandidate.updateMany({ where: { id: found.state.candidateId, convertedTaskId: found.task.id }, data: { convertedTaskId: null } });
        await tx.viralAnalysisRecord.delete({ where: { id: found.task.id } });
      });
      return { task: { id: found.task.id }, outcome: "deleted", researchRevision: found.state.researchRevision, dependencySummary: { deleteBlockedBy: [] } };
    }
    if (input.action === "restore" && found.task.archivedAt === null) throw new V5CoreError("NOT_ARCHIVED", "研究任务当前未归档。", 409, false, true);
    const task = await prisma.viralAnalysisRecord.update({ where: { id: found.task.id }, data: { archivedAt: input.action === "archive" ? new Date() : null } });
    return { task: { id: task.id, archivedAt: task.archivedAt?.toISOString() ?? null, resourceVersion: resourceVersion(task.updatedAt) }, outcome: input.action === "archive" ? "archived" : "restored", researchRevision: found.state.researchRevision, dependencySummary: { deleteBlockedBy: [] } };
  } });
  return { ...result.value, replayed: result.replayed };
}

async function candidateAction(input: { context: AccessContext; candidateId: string; action: "archive" | "restore" | "delete"; expectedVersion: unknown; idempotencyKey: string }) {
  requireOwnerContext(input.context);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const result = await withV5Receipt({
    context: input.context,
    operation: `candidate:${input.action}`,
    resourceKey: input.candidateId,
    idempotencyKey: input.idempotencyKey,
    requestBody: { action: input.action, expectedVersion },
    execute: async () => {
      const candidate = await prisma.opportunityCandidate.findUnique({ where: { id: input.candidateId } });
      if (!candidate) throw new V5CoreError("CANDIDATE_NOT_FOUND", "候选商品不存在。", 404);
      assertExpectedVersionMatches(expectedVersion, candidate.updatedAt);
      const sourceMeta = parseJsonRecord(candidate.sourceMetaJson);
      const provenance = Array.isArray(sourceMeta.provenance) ? sourceMeta.provenance : [];
      const candidateEvidenceHash = typeof sourceMeta.evidenceHash === "string" ? sourceMeta.evidenceHash : null;
      const dependencySummary = {
        referenced: Boolean(candidate.convertedTaskId || candidate.originProductBatchItemId || provenance.length),
        candidateIds: [candidate.id],
        marketScanIds: provenance.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).scanId === "string" ? [(entry as Record<string, unknown>).scanId as string] : []),
        taskIds: candidate.convertedTaskId ? [candidate.convertedTaskId] : [],
        evidenceRefCount: candidateEvidenceHash ? 1 : 0,
        deleteBlockedBy: [
          ...(candidate.convertedTaskId ? ["task_reference"] : []),
          ...(candidate.originProductBatchItemId ? ["candidate_origin"] : []),
          ...(provenance.length ? ["market_sample"] : []),
        ],
      };
      if (input.action === "delete") {
        if (dependencySummary.deleteBlockedBy.length) throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "候选商品仍被研究链引用，只能归档。", 409, false, true, { dependencySummary });
        await prisma.opportunityCandidate.delete({ where: { id: candidate.id } });
        return { candidate: { id: candidate.id }, outcome: "deleted", dependencySummary };
      }
      if (input.action === "restore" && candidate.archivedAt === null) throw new V5CoreError("NOT_ARCHIVED", "候选商品当前未归档。", 409, false, true);
      const updated = await prisma.opportunityCandidate.update({ where: { id: candidate.id }, data: { archivedAt: input.action === "archive" ? new Date() : null } });
      return { candidate: { id: updated.id, archivedAt: updated.archivedAt?.toISOString() ?? null, resourceVersion: resourceVersion(updated.updatedAt) }, outcome: input.action === "archive" ? "archived" : "restored", dependencySummary: { ...dependencySummary, deleteBlockedBy: [] } };
    },
  });
  return { ...result.value, replayed: result.replayed };
}

export async function researchBulkAction(input: { context: AccessContext; resource: "research_task" | "candidate"; action: "archive" | "restore" | "delete"; items: Array<{ id: string; expectedVersion: unknown }>; idempotencyKey: string }) {
  requireOwnerContext(input.context);
  if (!["research_task", "candidate"].includes(input.resource) || !["archive", "restore", "delete"].includes(input.action)) throw new V5CoreError("BULK_ACTION_INVALID", "研究批量操作类型无效。", 400);
  if (!input.items.length || input.items.length > 100) throw new V5CoreError(input.items.length > 100 ? "BULK_ACTION_TOO_LARGE" : "BULK_ACTION_INVALID", "批量操作数量无效。", 400);
  const receipt = await withV5Receipt({ context: input.context, operation: `research:${input.resource}:bulk:${input.action}`, resourceKey: input.items.map((item) => item.id).sort().join(","), idempotencyKey: input.idempotencyKey, requestBody: input, execute: async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const item of input.items) {
      try {
        if (input.resource === "candidate") {
          const result = await candidateAction({ context: input.context, candidateId: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` });
          results.push({ id: item.id, outcome: result.outcome, code: null, currentVersion: (result.candidate as Record<string, unknown>)?.resourceVersion ?? null, dependencySummary: result.dependencySummary });
        } else {
          const result = await researchTaskAction({ context: input.context, taskId: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` });
          results.push({ id: item.id, outcome: result.outcome, code: null, currentVersion: (result.task as Record<string, unknown>)?.resourceVersion ?? null, dependencySummary: result.dependencySummary });
        }
      } catch (error) {
        const v5 = error instanceof V5CoreError ? error : new V5CoreError("INTERNAL_ERROR", "项目操作失败。", 500);
        results.push({ id: item.id, outcome: "failed", code: v5.code, currentVersion: null });
      }
    }
    return { resource: input.resource, action: input.action, total: results.length, succeeded: results.filter((item) => item.outcome !== "failed").length, failed: results.filter((item) => item.outcome === "failed").length, results };
  } });
  return { ...receipt.value, replayed: receipt.replayed };
}
