import "server-only";

import { createHash } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ResearchFactSnapshot } from "@/lib/research/researchContracts";
import { prisma } from "@/lib/server/db";
import {
  PRODUCT_CONCEPT_SCHEMA,
  buildInitialProductConceptHumanDecision,
  buildInitialProductProjectSync,
  parseProductConcept,
  parseProductProjectSync,
  type ProductConceptSnapshot,
  type ProductConceptSourceBinding,
  type ProductConceptTraceableItem,
  type ProductProjectSync,
} from "@/lib/marketOpportunity/concept";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { buildV5ResearchPacket } from "@/lib/server/research/researchPacketBuilder";
import { getResearchDetail } from "@/lib/server/v5ResearchService";
import { teamRecommendationToCanonical } from "@/lib/types/v5DecisionStatus";
import { assertExpectedVersionMatches, hashJson, parseJsonRecord } from "@/lib/server/v5CoreCommon";
import { mutateTaskResultJson, TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";
import { syncProductProjectForResearch } from "@/lib/integrations/lark/productProjectSync";

const PRODUCT_CONCEPT_V5_STATE_SCHEMA = "product-concept-v5-state.v1" as const;

export type ResearchSnapshot = {
  readonly taskId: string;
  readonly subjectKey: string;
  readonly title: string;
  readonly report: Record<string, unknown>;
  readonly binding: ProductConceptSourceBinding;
  readonly packetHash: string | null;
  readonly current: boolean;
  readonly staleReason: string | null;
  readonly productEvidenceId: string;
  readonly productTitle: string | null;
};

type StoredConceptState = {
  schemaVersion: typeof PRODUCT_CONCEPT_V5_STATE_SCHEMA;
  concept: ProductConceptSnapshot | null;
  projectSync: ProductProjectSync;
};

export class ProductConceptV5Error extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProductConceptV5Error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function jsonSnapshot(taskId: string) {
  return prisma.viralAnalysisRecord.findUnique({
    where: { id: taskId },
    select: { id: true, type: true, resultJson: true, updatedAt: true },
  }).then((task) => {
    if (!task || task.type !== "workflow") throw new ProductConceptV5Error("RESEARCH_TASK_NOT_FOUND", 404, "正式 Research 任务不存在。");
    return task;
  });
}

async function liveResearchSnapshot(
  context: AccessContext,
  taskId: string,
  options: { recordDiagnostic?: boolean } = {},
): Promise<ResearchSnapshot> {
  if (context.mode !== "owner") throw new ProductConceptV5Error("PRODUCT_CONCEPT_OWNER_REQUIRED", 403, "V5 产品概念仅对 Owner 开放。");
  const [research, bundle] = await Promise.all([
    getResearchDetail({ context, taskId }),
    buildResearchInputBundle({ context, taskId, recordDiagnostic: options.recordDiagnostic ?? true }),
  ]);
  const taskSnapshot = await jsonSnapshot(taskId);
  const taskRoot = parseJsonRecord(taskSnapshot.resultJson);
  if (!isRecord(research.report) || research.report.schema !== "research-report.v5") {
    throw new ProductConceptV5Error("RESEARCH_REPORT_REQUIRED", 409, "请先完成正式 V5 Research，再生成产品概念。");
  }
  // P0 证据可信度（读侧边界）：研报中存在**引用白名单外来源、支撑范围不可知**的已持久化陈述时，
  // 该研报不得作为产品概念/决策材料的来源。此处给出明确阻断原因（而不是让下游哈希校验给出误导性报错）。
  if (research.reportIntegrity?.suppressed === true) {
    throw new ProductConceptV5Error(
      "RESEARCH_REPORT_EVIDENCE_UNVERIFIED",
      409,
      "该研报包含未通过证据校验的具体事实，已暂停用于产品概念生成。请先重新生成研报或补齐证据后再试。",
    );
  }
  const reportHash = typeof research.reportHash === "string" ? research.reportHash : "";
  const factHash = typeof research.factHash === "string" ? research.factHash : "";
  const evidenceHash = typeof research.evidenceHash === "string" ? research.evidenceHash : "";
  const researchRevision = Number(research.researchRevision);
  const identityTaskId = typeof research.taskId === "string" ? research.taskId : taskId;
  const expectedReportHash = hashJson(research.report);
  const expectedFactHash = hashJson(bundle.productFact);
  const expectedEvidenceHash = hashJson(bundle.sourceEvidenceRefs
    .map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
    .sort((left, right) => left.refId.localeCompare(right.refId)));
  let staleReason: string | null = null;
  if (research.reportStale === true) staleReason = "RESEARCH_EVIDENCE_CHANGED";
  else if (identityTaskId !== taskId) staleReason = "RESEARCH_TASK_ID_MISMATCH";
  else if (!Number.isSafeInteger(researchRevision) || researchRevision < 1) staleReason = "RESEARCH_REVISION_MISSING";
  else if (!reportHash || reportHash !== expectedReportHash) staleReason = "RESEARCH_REPORT_HASH_MISMATCH";
  else if (!factHash || factHash !== expectedFactHash) staleReason = "RESEARCH_FACT_HASH_STALE";
  else if (!evidenceHash || evidenceHash !== expectedEvidenceHash) staleReason = "RESEARCH_EVIDENCE_HASH_STALE";
  const generatedAt = new Date().toISOString();
  const binding: ProductConceptSourceBinding = {
    sourceType: "research_v5",
    subjectKey: bundle.subjectKey,
    researchTaskId: taskId,
    researchRevision: Number.isSafeInteger(researchRevision) ? researchRevision : 0,
    reportHash: reportHash || expectedReportHash,
    factHash: factHash || expectedFactHash,
    evidenceHash: evidenceHash || expectedEvidenceHash,
    generatedAt,
  };
  let packetHash: string | null = null;
  const researchState = isRecord(taskRoot.v5Research) ? taskRoot.v5Research : null;
  if (bundle.productFact && isRecord(taskRoot.facts) && researchState) {
    try {
      packetHash = buildV5ResearchPacket({
        productFact: bundle.productFact,
        facts: taskRoot.facts as unknown as ResearchFactSnapshot,
        researchInputBundle: bundle,
        taskId,
        revision: researchRevision,
        marketplace: typeof researchState.marketplace === "string" ? researchState.marketplace : "US",
        generatedAt,
      }).packetHash;
    } catch {
      // Missing or incompatible current packet inputs must not invalidate concept reads;
      // Phase 5 decision Pull separately requires a reproducible packet hash.
    }
  }
  return {
    taskId,
    subjectKey: bundle.subjectKey,
    title: typeof research.title === "string" && research.title.trim() ? research.title.trim() : taskId,
    report: research.report,
    binding,
    packetHash,
    current: staleReason === null,
    staleReason,
    productEvidenceId: bundle.productFact?.sourceProof.evidenceId ?? "",
    productTitle: bundle.productFact?.basic.title.status === "present" ? bundle.productFact.basic.title.value : null,
  };
}

function parseStoredState(value: unknown): StoredConceptState | null {
  if (!isRecord(value) || value.schemaVersion !== PRODUCT_CONCEPT_V5_STATE_SCHEMA) return null;
  const concept = value.concept === null ? null : parseProductConcept(value.concept);
  const projectSync = value.projectSync === undefined
    ? buildInitialProductProjectSync()
    : parseProductProjectSync(value.projectSync);
  return { schemaVersion: PRODUCT_CONCEPT_V5_STATE_SCHEMA, concept, projectSync };
}

function conceptStateFromResultJson(resultJson: string): StoredConceptState | null {
  const root = parseJsonRecord(resultJson);
  return parseStoredState(root.productConceptV5);
}

function sameBinding(left: ProductConceptSourceBinding, right: ProductConceptSourceBinding): boolean {
  return left.sourceType === right.sourceType
    && left.subjectKey === right.subjectKey
    && left.researchTaskId === right.researchTaskId
    && left.researchRevision === right.researchRevision
    && left.reportHash === right.reportHash
    && left.factHash === right.factHash
    && left.evidenceHash === right.evidenceHash;
}

export function productConceptSourceBindingMatches(
  concept: ProductConceptSnapshot,
  current: ProductConceptSourceBinding,
): boolean {
  return concept.sourceBinding !== undefined && sameBinding(concept.sourceBinding, current);
}

export function evaluateProductConceptCurrentGate(input: {
  concept: ProductConceptSnapshot;
  currentBinding: ProductConceptSourceBinding | null;
  researchCurrent: boolean;
}) {
  const stale = !input.researchCurrent || !input.currentBinding
    || !productConceptSourceBindingMatches(input.concept, input.currentBinding);
  return {
    stale,
    approvalCurrent: !stale && input.concept.humanDecision.status === "APPROVE",
    canSync: !stale && input.concept.humanDecision.status === "APPROVE",
  };
}

function stableItemId(kind: string, text: string): string {
  return `pci_${createHash("sha256").update(`${kind}\n${text}`, "utf8").digest("hex").slice(0, 32)}`;
}

function narrativeRefs(report: Record<string, unknown>, field: string, text: string, allowlist: Set<string>): string[] {
  if (!Array.isArray(report.narrativeBindings)) return [];
  const binding = report.narrativeBindings.find((item) => isRecord(item)
    && item.field === field && item.text === text);
  if (!isRecord(binding) || !Array.isArray(binding.evidenceRefs)) return [];
  return [...new Set(binding.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && allowlist.has(ref)))];
}

const VOC_CONCEPT_MAP = [
  ["painPoints", "research_voc_pain"],
  ["positiveSignals", "research_voc_positive"],
  ["failureModes", "research_voc_failure"],
  ["useCases", "research_voc_use_case"],
  ["replacementSignals", "research_voc_replacement"],
  ["switchReasons", "research_voc_switch"],
  ["ownershipClaims", "research_voc_ownership"],
] as const;

function boundVocItems(report: Record<string, unknown>, allowlist: Set<string>) {
  if (!isRecord(report.vocAnalysis)) return [];
  const items: Array<{
    category: typeof VOC_CONCEPT_MAP[number][0];
    kind: typeof VOC_CONCEPT_MAP[number][1];
    text: string;
    evidenceRefs: string[];
    reportIndex: number;
  }> = [];
  for (const [category, kind] of VOC_CONCEPT_MAP) {
    const entries = Array.isArray(report.vocAnalysis[category]) ? report.vocAnalysis[category] as unknown[] : [];
    entries.forEach((raw, index) => {
      if (!isRecord(raw) || typeof raw.text !== "string" || !raw.text.trim()) return;
      const unboundedText = raw.text.trim();
      const field = `vocAnalysis.${category}[${index}]`;
      const refs = narrativeRefs(report, field, unboundedText, allowlist);
      const declaredRefs = stringList(raw.evidenceRefs).filter((ref) => allowlist.has(ref));
      if (refs.length === 0 || refs.some((ref) => !declaredRefs.includes(ref))) return;
      items.push({ category, kind, text: unboundedText.slice(0, 1_000), evidenceRefs: refs, reportIndex: index });
    });
  }
  return items.slice(0, 180);
}

export function buildProductConceptV5FromResearchSnapshot(
  research: ResearchSnapshot,
  previous: ProductConceptSnapshot | null = null,
): ProductConceptSnapshot {
  const allowedRefs = new Set(stringList(research.report.allowedEvidenceRefs));
  const traceableItems: ProductConceptTraceableItem[] = [];
  const researchRefPaths = new Map<string, string>();
  const summary = typeof research.report.summary === "string" ? research.report.summary.trim() : "";
  if (summary) {
    const refs = narrativeRefs(research.report, "summary", summary, allowedRefs);
    if (refs.length > 0) {
      const id = stableItemId("research_summary", summary);
      traceableItems.push({
        id,
        kind: "research_summary",
        text: summary,
        nature: "derived",
        evidenceRefs: refs,
        validationRequired: true,
      });
      researchRefPaths.set(id, "report.summary");
    }
  }
  const opportunities = stringList(research.report.opportunities);
  opportunities.forEach((text, index) => {
    const refs = narrativeRefs(research.report, `opportunities[${index}]`, text, allowedRefs);
    if (refs.length > 0) {
      const id = stableItemId("research_opportunity", `${index}\n${text}`);
      traceableItems.push({
        id,
        kind: "research_opportunity",
        text,
        nature: "recommendation",
        evidenceRefs: refs,
        validationRequired: true,
      });
      researchRefPaths.set(id, `report.opportunities[${index}]`);
    }
  });
  const risks = stringList(research.report.risks);
  risks.forEach((text, index) => {
    const refs = narrativeRefs(research.report, `risks[${index}]`, text, allowedRefs);
    if (refs.length > 0) {
      const id = stableItemId("research_risk", `${index}\n${text}`);
      traceableItems.push({
        id,
        kind: "research_risk",
        text,
        nature: "derived",
        evidenceRefs: refs,
        validationRequired: true,
      });
      researchRefPaths.set(id, `report.risks[${index}]`);
    }
  });
  const vocItems = boundVocItems(research.report, allowedRefs);
  vocItems.forEach((item, index) => {
    const id = stableItemId(item.kind, `${item.category}\n${index}\n${item.text}`);
    traceableItems.push({
      id,
      kind: item.kind,
      text: item.text,
      nature: "derived",
      evidenceRefs: item.evidenceRefs,
      validationRequired: true,
    });
    researchRefPaths.set(id, `report.vocAnalysis.${item.category}[${item.reportIndex}]`);
  });
  if (research.productTitle && research.productEvidenceId) traceableItems.push({
    id: stableItemId("confirmed_fact", `${research.subjectKey}\n${research.productTitle}`),
    kind: "confirmed_fact",
    text: `Research 商品标题：${research.productTitle}`,
    nature: "confirmed_fact",
    evidenceRefs: [`evidence:${research.productEvidenceId}`],
    validationRequired: false,
  });
  const assumptions = stringList(research.report.unverifiedAssumptions);
  assumptions.forEach((text, index) => traceableItems.push({
    id: stableItemId("assumption", `${index}\n${text}`),
    kind: "assumption",
    text,
    nature: "assumption",
    evidenceRefs: [],
    validationRequired: true,
  }));
  const researchRefs = [...new Map(traceableItems
    .filter((item) => item.kind !== "confirmed_fact" && item.kind !== "assumption")
    .flatMap((item) => {
      const path = researchRefPaths.get(item.id);
      return path ? [[item.id, { kind: "research" as const, refId: research.taskId, path }] as const] : [];
    })).values()];
  const vocTexts = (category: typeof VOC_CONCEPT_MAP[number][0]) => vocItems
    .filter((item) => item.category === category)
    .map((item) => item.text);
  const generatedAt = new Date().toISOString();
  const conceptId = previous?.conceptId ?? `pcv5_${createHash("sha256").update(research.taskId).digest("hex").slice(0, 32)}`;
  const missingValidation = [
    ...assumptions,
    "Product Concept 不含供应商报价、制造成本、法规/IP 验证；需人工补证。",
    ...(research.productTitle ? [] : ["缺少已确认的商品标题事实。"]),
  ];
  return parseProductConcept({
    schemaVersion: PRODUCT_CONCEPT_SCHEMA,
    status: "READY",
    conceptId,
    opportunityId: null,
    sourceBinding: { ...research.binding, generatedAt },
    revision: (previous?.revision ?? 0) + 1,
    generatedAt,
    targetCustomer: null,
    useCases: vocTexts("useCases"),
    primaryPainPoints: vocTexts("painPoints"),
    recommendedSpecs: [],
    differentiation: [],
    researchOpportunities: opportunities.filter((text, index) => narrativeRefs(research.report, `opportunities[${index}]`, text, allowedRefs).length > 0),
    targetPriceRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
    targetCostRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
    marginAssumptions: null,
    packagingDirection: [],
    supplierFeasibility: null,
    complianceRequirements: [],
    risks: risks.filter((text, index) => narrativeRefs(research.report, `risks[${index}]`, text, allowedRefs).length > 0),
    missingValidation,
    factRefs: [],
    researchRefs,
    assumptions,
    confirmedFacts: research.productTitle ? [`Research 商品标题：${research.productTitle}`] : [],
    derived: traceableItems.filter((item) => item.nature === "derived").map((item) => item.text),
    missing: missingValidation,
    aiSummary: summary || null,
    model: "local-research-v5-adapter-v1",
    humanDecision: buildInitialProductConceptHumanDecision(),
    traceableItems,
  });
}

async function persistState(input: {
  context: AccessContext;
  taskId: string;
  reviewRecommendation?: { expectedId?: string; expectedVersion?: string; apply?: boolean };
  mutate: (state: StoredConceptState, research: ResearchSnapshot, recommendation: Record<string, unknown> | null) => StoredConceptState;
}) {
  const task = await jsonSnapshot(input.taskId);
  if (input.reviewRecommendation?.expectedVersion !== undefined) assertExpectedVersionMatches(input.reviewRecommendation.expectedVersion, task.updatedAt);
  return mutateTaskResultJson({
    context: input.context,
    taskId: input.taskId,
    writer: input.reviewRecommendation ? "team-recommendation-apply" : "product-concept-v5",
    expectedStorageVersion: { resultJson: task.resultJson, updatedAt: task.updatedAt },
    mutate: async (current) => {
      const research = await liveResearchSnapshot(input.context, input.taskId);
      if (!research.current) throw new ProductConceptV5Error("PRODUCT_CONCEPT_RESEARCH_STALE", 409, `Research 输入已变化或哈希不匹配：${research.staleReason}`);
      const currentState = parseStoredState(current.productConceptV5)
        ?? { schemaVersion: PRODUCT_CONCEPT_V5_STATE_SCHEMA, concept: null, projectSync: buildInitialProductProjectSync() };
      const state = isRecord(current.v5Research) ? current.v5Research : {};
      const recommendation = isRecord(state.conceptTeamRecommendation) ? state.conceptTeamRecommendation : null;
      const review = input.reviewRecommendation;
      if (review?.expectedId !== undefined && (recommendation?.id !== review.expectedId || recommendation.status !== "VERIFIED_TEAM_RECOMMENDATION")) {
        throw new ProductConceptV5Error("TEAM_RECOMMENDATION_STALE", 409, "概念飞书端建议已变化或已处理，请刷新。");
      }
      if (review?.apply) {
        if (recommendation?.status !== "VERIFIED_TEAM_RECOMMENDATION") throw new ProductConceptV5Error("TEAM_RECOMMENDATION_STALE", 409, "概念飞书端建议已处理。");
        const binding = recommendation && isRecord(recommendation.bindingHashes) ? recommendation.bindingHashes : null;
        if (!binding || binding.reportHash !== research.binding.reportHash || binding.factHash !== research.binding.factHash
          || binding.evidenceHash !== research.binding.evidenceHash || binding.researchRevision !== research.binding.researchRevision
          || binding.packetHash !== research.packetHash || binding.subjectKey !== research.subjectKey
          || binding.conceptId !== currentState.concept?.conceptId || binding.conceptRevision !== currentState.concept?.revision) {
          throw new ProductConceptV5Error("TEAM_RECOMMENDATION_STALE", 409, "概念飞书端建议针对的报告、证据或概念已变化。");
        }
      }
      const nextState = input.mutate(currentState, research, recommendation);
      let nextRoot: Record<string, unknown> = { ...current, productConceptV5: nextState };
      if (review && recommendation?.status === "VERIFIED_TEAM_RECOMMENDATION") {
        const canonical = teamRecommendationToCanonical(recommendation.recommendationStatus);
        const finalStatus = nextState.concept?.humanDecision.status;
        const target = canonical === "PROCEED" ? "APPROVE" : canonical;
        nextRoot = { ...nextRoot, v5Research: { ...state, conceptTeamRecommendation: { ...recommendation,
          status: target === finalStatus ? "APPLIED" : "OVERRIDDEN", reviewedBy: "owner:v1",
          reviewedAtWorkbench: nextState.concept?.humanDecision.decidedAt,
          finalConceptDecision: nextState.concept?.humanDecision,
        } } };
      }
      return { result: nextRoot, value: nextState };
    },
  });
}

export async function generateProductConceptV5(input: { context: AccessContext; taskId: string }) {
  const research = await liveResearchSnapshot(input.context, input.taskId);
  if (!research.current) throw new ProductConceptV5Error("PRODUCT_CONCEPT_RESEARCH_STALE", 409, `Research 输入哈希不匹配：${research.staleReason}`);
  const task = await jsonSnapshot(input.taskId);
  const existing = conceptStateFromResultJson(task.resultJson);
  if (existing?.concept?.sourceBinding && sameBinding(existing.concept.sourceBinding, research.binding)) {
    return { concept: existing.concept, stale: false, projectSync: existing.projectSync, created: false };
  }
  const saved = await persistState({
    context: input.context,
    taskId: input.taskId,
    mutate: (state, currentResearch) => {
      const prior = state.concept;
      const concept = buildProductConceptV5FromResearchSnapshot(currentResearch, prior);
      return { schemaVersion: PRODUCT_CONCEPT_V5_STATE_SCHEMA, concept, projectSync: buildInitialProductProjectSync() };
    },
  });
  return { concept: saved.value.concept, stale: false, projectSync: saved.value.projectSync, created: true };
}

export async function readProductConceptV5(input: { context: AccessContext; taskId: string }) {
  const task = await jsonSnapshot(input.taskId);
  const state = conceptStateFromResultJson(task.resultJson);
  if (!state?.concept) return { taskId: input.taskId, concept: null, stale: false, staleReason: null, currentBinding: null, packetHash: null, projectSync: buildInitialProductProjectSync() };
  let research: ResearchSnapshot | null = null;
  try {
    research = await liveResearchSnapshot(input.context, input.taskId, { recordDiagnostic: false });
  } catch {
    // A missing or unreadable current Research binding makes a saved concept stale, never current by guess.
  }
  const gate = evaluateProductConceptCurrentGate({
    concept: state.concept,
    currentBinding: research?.binding ?? null,
    researchCurrent: research?.current === true,
  });
  const stale = gate.stale;
  return {
    taskId: input.taskId,
    concept: state.concept,
    stale,
    staleReason: stale ? research?.staleReason ?? "RESEARCH_BINDING_UNAVAILABLE_OR_CHANGED" : null,
    currentBinding: research?.binding ?? null,
    packetHash: research?.packetHash ?? null,
    projectSync: state.projectSync,
    resourceVersion: task.updatedAt.toISOString(),
    teamRecommendation: (() => {
      const root = parseJsonRecord(task.resultJson);
      const raw = isRecord(root.v5Research) && isRecord(root.v5Research.conceptTeamRecommendation) ? root.v5Research.conceptTeamRecommendation : null;
      if (!raw) return null;
      const b = isRecord(raw.bindingHashes) ? raw.bindingHashes : {};
      return { ...raw, id: typeof raw.id === "string" ? raw.id : "", status: raw.status, recommendationStatus: raw.recommendationStatus, stale: stale || b.conceptId !== state.concept.conceptId || b.conceptRevision !== state.concept.revision
        || b.packetHash !== research?.packetHash || b.reportHash !== research?.binding.reportHash
        || b.factHash !== research?.binding.factHash || b.evidenceHash !== research?.binding.evidenceHash };
    })(),
  };
}

export async function decideProductConceptV5(input: {
  context: AccessContext;
  taskId: string;
  status: "APPROVE" | "VALIDATE_MORE" | "PAUSE" | "DROP";
  reason: string;
  expectedRevision: number;
  expectedPacketHash?: string;
  source?: ProductConceptSnapshot["humanDecision"]["source"];
  expectedTeamRecommendationId?: string;
  expectedVersion?: string;
  applyTeamRecommendation?: boolean;
  confirmed?: boolean;
}) {
  if (input.applyTeamRecommendation && (!input.expectedTeamRecommendationId?.trim() || !input.expectedVersion?.trim())) throw new ProductConceptV5Error("TEAM_RECOMMENDATION_EXPECTATION_REQUIRED", 400, "确认飞书端建议必须携带当前建议 ID 与版本。");
  if (input.applyTeamRecommendation && input.confirmed !== true) throw new ProductConceptV5Error("TEAM_RECOMMENDATION_CONFIRMATION_REQUIRED", 422, "请在 Workbench 显式确认概念飞书端建议。");
  if (!input.reason.trim()) throw new ProductConceptV5Error("CONCEPT_DECISION_REASON_REQUIRED", 422, "请填写人工决策理由。");
  const result = await persistState({
    context: input.context,
    taskId: input.taskId,
    reviewRecommendation: { expectedId: input.expectedTeamRecommendationId, expectedVersion: input.expectedVersion, apply: input.applyTeamRecommendation },
    mutate: (state, research, recommendation) => {
      if (!state.concept) throw new ProductConceptV5Error("PRODUCT_CONCEPT_REQUIRED", 409, "请先生成产品概念。");
      const gate = evaluateProductConceptCurrentGate({ concept: state.concept, currentBinding: research.binding, researchCurrent: research.current });
      if (gate.stale) throw new ProductConceptV5Error("PRODUCT_CONCEPT_STALE", 409, "Research 已变化，旧概念与其历史 APPROVE 均失效；请重新生成并复核。");
      if (state.concept.revision !== input.expectedRevision) throw new ProductConceptV5Error("PRODUCT_CONCEPT_REVISION_STALE", 409, "产品概念已更新，请刷新后重试。");
      if (input.expectedPacketHash !== undefined
        && (!research.packetHash || research.packetHash !== input.expectedPacketHash)) {
        throw new ProductConceptV5Error("PRODUCT_CONCEPT_PACKET_STALE", 409, "研究包已变化或无法复核，请刷新后重试。");
      }
      const canonical = teamRecommendationToCanonical(recommendation?.recommendationStatus);
      if (input.applyTeamRecommendation && !canonical) throw new ProductConceptV5Error("TEAM_RECOMMENDATION_INVALID", 422, "概念飞书端建议四态值无效。");
      const status = input.applyTeamRecommendation ? canonical === "PROCEED" ? "APPROVE" : canonical : input.status;
      const concept = parseProductConcept({
        ...state.concept,
        humanDecision: {
          status,
          reason: input.reason.trim(),
          decidedAt: input.source?.reviewedAt ?? new Date().toISOString(),
          revision: state.concept.humanDecision.revision + 1,
          ...(input.source ? { source: input.source } : {}),
        },
      });
      return { ...state, concept };
    },
  });
  return result.value;
}

export async function syncProductConceptV5(input: { context: AccessContext; taskId: string }) {
  const current = await readProductConceptV5(input);
  if (!current.concept) throw new ProductConceptV5Error("PRODUCT_CONCEPT_REQUIRED", 409, "请先生成产品概念。");
  const currentGate = current.currentBinding ? evaluateProductConceptCurrentGate({
    concept: current.concept,
    currentBinding: current.currentBinding,
    researchCurrent: !current.stale,
  }) : { stale: true, approvalCurrent: false, canSync: false };
  if (currentGate.stale) throw new ProductConceptV5Error("PRODUCT_CONCEPT_STALE", 409, "Research 已变化，旧概念及其 APPROVE 已失效；请重新生成并复核。");
  if (!currentGate.canSync) {
    throw new ProductConceptV5Error("CONCEPT_APPROVE_REQUIRED", 409, "只有当前版本经人工 APPROVE 的产品概念才能同步 Product Project。");
  }
  const result = await syncProductProjectForResearch({
    concept: current.concept,
    researchTaskId: input.taskId,
    researchTitle: (await getResearchDetail({ context: input.context, taskId: input.taskId })).title ?? input.taskId,
  });
  const storedSync = parseProductProjectSync({
    ...buildInitialProductProjectSync(),
    status: result.status,
    conceptId: current.concept.conceptId,
    tableId: result.tableId,
    recordId: result.recordId,
    viewUrl: result.viewUrl,
    syncedAt: result.status === "SYNCED" ? new Date().toISOString() : null,
    idempotencyKey: result.idempotencyKey,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  });
  const saved = await persistState({
    context: input.context,
    taskId: input.taskId,
    mutate: (state, research) => {
      if (!state.concept || !state.concept.sourceBinding || !sameBinding(state.concept.sourceBinding, research.binding)
        || state.concept.humanDecision.status !== "APPROVE") {
        throw new ProductConceptV5Error("PRODUCT_CONCEPT_STALE", 409, "同步过程中 Research 或人工决策发生变化；概念同步状态未被标记为当前。");
      }
      return { ...state, projectSync: storedSync };
    },
  });
  return { ...saved.value, result };
}
