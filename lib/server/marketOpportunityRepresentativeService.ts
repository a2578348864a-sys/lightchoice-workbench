import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { resolveMarketScanImageRef } from "@/lib/server/marketScanImage";
import { createMarketScanRepository } from "@/lib/server/marketScanRepository";
import { prisma } from "@/lib/server/db";
import { deriveResearchHistoryStatus } from "@/lib/taskResearchHistoryPresentation";
import { readStoredResearchDecision } from "@/lib/server/research/researchHumanReviewStore";
import { readStoredResearchReport } from "@/lib/server/research/researchReportStore";
import {
  parseRepresentativeSelectionSet,
  suggestedRoleTags,
  type RepresentativeRoleTag,
  type RepresentativeSelection,
} from "@/lib/marketOpportunity/representatives";
import {
  createMarketOpportunityRepository,
  type MarketOpportunityRepository,
} from "@/lib/server/marketOpportunityRepository";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";
import type { MarketScanSampleItemV1 } from "@/lib/marketScan/types";

export type RepresentativeResearchStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "ABANDONED";

export type RepresentativeResearchView = {
  readonly candidateId: string | null;
  readonly candidateStatus: string | null;
  readonly convertedTaskId: string | null;
  readonly researchStatus: RepresentativeResearchStatus;
  readonly researchDecision: { readonly status: string; readonly nextAction: string; readonly notes: string } | null;
  readonly missingEvidence: readonly string[];
  readonly modules: readonly {
    readonly key: "market_competition" | "voc" | "cost_profit" | "supply_chain" | "compliance_ip" | "differentiation";
    readonly label: string;
    readonly status: "EVIDENCE_BACKED" | "HUMAN_INPUT" | "MISSING";
  }[];
};

export type RepresentativeSampleView = {
  readonly productFactSubjectKey: string;
  readonly asin: string;
  readonly title: string | null;
  readonly imageUrl: string | null;
  readonly price: { readonly amount: number; readonly currency: string } | null;
  readonly sales: number | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly suggestedRoleTags: readonly RepresentativeRoleTag[];
  readonly selected: boolean;
  readonly selection: {
    readonly candidateId: string | null;
    readonly roleTags: readonly RepresentativeRoleTag[];
    readonly selectedBy: string;
    readonly selectedAt: string;
    readonly note: string | null;
  } | null;
  readonly research: RepresentativeResearchView;
};

export type RepresentativeView = {
  readonly opportunityId: string;
  readonly latestScanId: string;
  readonly revision: number;
  readonly selectedCount: number;
  readonly sampleCount: number;
  readonly samples: readonly RepresentativeSampleView[];
};

export class MarketOpportunityRepresentativeError extends Error {
  constructor(
    public readonly code:
      | "opportunity_not_found"
      | "latest_scan_not_found"
      | "representative_invalid"
      | "candidate_bridge_unavailable"
      | "candidate_identity_mismatch"
      | "research_candidate_required"
      | "research_start_failed"
      | "legacy_research_handoff_retired",
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "MarketOpportunityRepresentativeError";
  }
}

type CandidateRow = {
  id: string;
  name: string;
  status: string;
  sourceMetaJson: string;
  convertedTaskId: string | null;
};

type TaskRow = {
  id: string;
  decisionStatus: string;
  oneLineSummary: string;
  resultJson: string;
  updatedAt: Date;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return object(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stableIdentityScore(sourceMetaJson: string, item: MarketScanSampleItemV1): number {
  const root = jsonObject(sourceMetaJson);
  const seen = new Set<unknown>();
  let score = 0;
  const walk = (value: unknown): void => {
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if ((key === "productKey" || key === "subjectKey") && child === item.subjectKey) score = Math.max(score, 3);
      if (key === "asin" && child === item.asin) score = Math.max(score, 2);
      walk(child);
    }
  };
  walk(root);
  return score;
}

function parseTaskResult(task: TaskRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(task.resultJson) as unknown;
    return object(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function researchModules(result: Record<string, unknown>): RepresentativeResearchView["modules"] {
  const report = readStoredResearchReport(result)?.report ?? null;
  const reportRecord = object(report) ? report : null;
  const narrative = (value: unknown): "EVIDENCE_BACKED" | "HUMAN_INPUT" | "MISSING" => {
    if (!object(value)) return "MISSING";
    const evidenceRefs = value.evidenceRefs;
    if (Array.isArray(evidenceRefs) && evidenceRefs.length > 0) return "EVIDENCE_BACKED";
    if (typeof value.text === "string" && value.text.trim()) return "HUMAN_INPUT";
    return "MISSING";
  };
  const hasEvidence = (value: unknown): boolean => object(value)
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.length > 0;
  const unitEconomics = reportRecord && object(reportRecord.unitEconomics) ? reportRecord.unitEconomics : null;
  const deterministic = unitEconomics && object(unitEconomics.deterministic) ? unitEconomics.deterministic : null;
  const grossProfit = deterministic && object(deterministic.grossProfit) ? deterministic.grossProfit : null;
  const riskAssessment = reportRecord && object(reportRecord.riskAssessment) ? reportRecord.riskAssessment : null;
  const competitionInsight = reportRecord && object(reportRecord.competitionInsight) ? reportRecord.competitionInsight : null;
  const risks = riskAssessment && Array.isArray(riskAssessment.risks) ? riskAssessment.risks : [];
  const differentiationSuggestions = competitionInsight && Array.isArray(competitionInsight.differentiationSuggestions)
    ? competitionInsight.differentiationSuggestions
    : [];
  return [
    { key: "market_competition", label: "市场与竞品", status: reportRecord ? (narrative(reportRecord.marketOpportunity && object(reportRecord.marketOpportunity) ? reportRecord.marketOpportunity.analysis : null) === "MISSING" ? "MISSING" : "EVIDENCE_BACKED") : "MISSING" },
    { key: "voc", label: "VOC", status: reportRecord ? narrative(reportRecord.vocAnalysis && object(reportRecord.vocAnalysis) ? reportRecord.vocAnalysis.analysis : null) : "MISSING" },
    { key: "cost_profit", label: "成本与利润", status: grossProfit?.status === "available" ? "EVIDENCE_BACKED" : "MISSING" },
    { key: "supply_chain", label: "供应链", status: reportRecord ? narrative(reportRecord.supplyChain && object(reportRecord.supplyChain) ? reportRecord.supplyChain.analysis : null) : "MISSING" },
    { key: "compliance_ip", label: "合规 / IP", status: risks.some(hasEvidence) ? "EVIDENCE_BACKED" : (reportRecord ? "HUMAN_INPUT" : "MISSING") },
    { key: "differentiation", label: "差异化", status: differentiationSuggestions.some(hasEvidence) ? "EVIDENCE_BACKED" : (reportRecord ? "HUMAN_INPUT" : "MISSING") },
  ];
}

function researchView(candidate: CandidateRow | null, task: TaskRow | null): RepresentativeResearchView {
  if (!candidate) {
    return {
      candidateId: null,
      candidateStatus: null,
      convertedTaskId: null,
      researchStatus: "NOT_STARTED",
      researchDecision: null,
      missingEvidence: ["Candidate bridge"],
      modules: researchModules({}),
    };
  }
  if (!task) {
    return {
      candidateId: candidate.id,
      candidateStatus: candidate.status,
      convertedTaskId: candidate.convertedTaskId,
      researchStatus: "NOT_STARTED",
      researchDecision: null,
      missingEvidence: candidate.convertedTaskId ? ["Research Task 记录不可读"] : ["尚未开始 Research"],
      modules: researchModules({}),
    };
  }
  const result = parseTaskResult(task);
  const lifecycle = deriveResearchHistoryStatus({
    result,
    decisionStatus: task.decisionStatus as never,
    oneLineSummary: task.oneLineSummary,
  });
  const completion = object(result.researchCompletion) ? result.researchCompletion.status : null;
  const report = readStoredResearchReport(result)?.report ?? null;
  const decision = readStoredResearchDecision(result);
  const reportRecord = object(report) ? report : null;
  const decisionSummary = reportRecord && object(reportRecord.decisionSummary) ? reportRecord.decisionSummary : null;
  const missingInformation = decisionSummary && Array.isArray(decisionSummary.missingInformation)
    ? decisionSummary.missingInformation.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const researchStatus: RepresentativeResearchStatus = completion === "completed"
    ? "COMPLETED"
    : completion === "abandoned"
      ? "ABANDONED"
      : "IN_PROGRESS";
  return {
    candidateId: candidate.id,
    candidateStatus: candidate.status,
    convertedTaskId: candidate.convertedTaskId,
    researchStatus,
    researchDecision: decision ? { status: decision.status, nextAction: decision.nextAction, notes: decision.notes } : null,
    missingEvidence: missingInformation.length
      ? missingInformation
      : lifecycle.researchSaved ? [] : ["Research Report"],
    modules: researchModules(result),
  };
}

async function candidateRows(): Promise<CandidateRow[]> {
  return prisma.opportunityCandidate.findMany({
    select: { id: true, name: true, status: true, sourceMetaJson: true, convertedTaskId: true },
    take: 2_000,
  });
}

async function resolveCandidate(item: MarketScanSampleItemV1, candidates: readonly CandidateRow[]): Promise<CandidateRow | null> {
  if (item.candidateId) {
    const explicit = candidates.find((candidate) => candidate.id === item.candidateId);
    if (!explicit) throw new MarketOpportunityRepresentativeError("candidate_identity_mismatch", "样本绑定的 Candidate 不存在或不可访问。", 409);
    if (stableIdentityScore(explicit.sourceMetaJson, item) === 0) {
      throw new MarketOpportunityRepresentativeError("candidate_identity_mismatch", "样本与 Candidate 的 ASIN / subjectKey 身份不一致。", 409);
    }
    return explicit;
  }
  const matches = candidates
    .map((candidate) => ({ candidate, score: stableIdentityScore(candidate.sourceMetaJson, item) }))
    .filter((match) => match.score > 0);
  const highestScore = Math.max(0, ...matches.map((match) => match.score));
  const strongest = matches.filter((match) => match.score === highestScore);
  if (strongest.length > 1) {
    throw new MarketOpportunityRepresentativeError("candidate_identity_mismatch", "同一商品存在多个 Candidate 身份，已停止自动选择。", 409);
  }
  return strongest[0]?.candidate ?? null;
}

async function taskMapFor(candidates: readonly (CandidateRow | null)[]): Promise<Map<string, TaskRow>> {
  const ids = Array.from(new Set(candidates.map((candidate) => candidate?.convertedTaskId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const tasks = await prisma.viralAnalysisRecord.findMany({
    where: { id: { in: ids } },
    select: { id: true, decisionStatus: true, oneLineSummary: true, resultJson: true, updatedAt: true },
  });
  return new Map(tasks.map((task) => [task.id, task]));
}

async function latestContext(
  opportunityId: string,
  repository: MarketOpportunityRepository,
): Promise<{ opportunity: MarketOpportunityRecordView; itemMap: Map<string, MarketScanSampleItemV1> }> {
  const opportunity = await repository.getById(opportunityId);
  if (!opportunity) throw new MarketOpportunityRepresentativeError("opportunity_not_found", "没有找到该市场机会。", 404);
  const scan = await createMarketScanRepository().getById(opportunity.latestMarketScanId);
  if (!scan) throw new MarketOpportunityRepresentativeError("latest_scan_not_found", "机会关联的最新 MarketScan 不存在。", 409);
  return {
    opportunity,
    itemMap: new Map(scan.sampleSnapshot.items.map((item) => [`${item.subjectKey}|${item.asin}`, item])),
  };
}

export async function readRepresentativeView(
  opportunityId: string,
  repository: MarketOpportunityRepository = createMarketOpportunityRepository(),
): Promise<RepresentativeView> {
  const { opportunity, itemMap } = await latestContext(opportunityId, repository);
  const candidates = await candidateRows();
  const resolved = await Promise.all([...itemMap.values()].map((item) => resolveCandidate(item, candidates)));
  const tasks = await taskMapFor(resolved);
  const selectedByIdentity = new Map(opportunity.representativeSet.items.map((item) => [`${item.productFactSubjectKey}|${item.asin}`, item]));
  const samples = await Promise.all([...itemMap.values()].map(async (item, index) => {
    const selection = selectedByIdentity.get(`${item.subjectKey}|${item.asin}`) ?? null;
    const candidate = resolved[index];
    const task = candidate?.convertedTaskId ? tasks.get(candidate.convertedTaskId) ?? null : null;
    const title = item.factValues.title.presence === "present" ? item.factValues.title.value : null;
    const price = item.factValues.price.presence === "present" ? item.factValues.price.value : null;
    const sales = item.factValues.monthlySalesEstimate.presence === "present" ? item.factValues.monthlySalesEstimate.value : null;
    const rating = item.factValues.rating.presence === "present" ? item.factValues.rating.value : null;
    const reviews = item.factValues.reviewCount.presence === "present" ? item.factValues.reviewCount.value : null;
    return {
      productFactSubjectKey: item.subjectKey,
      asin: item.asin,
      title,
      imageUrl: await resolveMarketScanImageRef(item.imageRef),
      price,
      sales,
      rating,
      reviews,
      suggestedRoleTags: suggestedRoleTags(item),
      selected: Boolean(selection),
      selection: selection ? {
        candidateId: candidate?.id ?? selection.candidateId,
        roleTags: selection.roleTags,
        selectedBy: selection.selectedBy,
        selectedAt: selection.selectedAt,
        note: selection.note,
      } : null,
      research: researchView(candidate, task),
    } satisfies RepresentativeSampleView;
  }));
  return {
    opportunityId,
    latestScanId: opportunity.latestMarketScanId,
    revision: opportunity.representativeSet.revision,
    selectedCount: opportunity.representativeSet.items.length,
    sampleCount: samples.length,
    samples,
  };
}

export async function saveRepresentativeSelections(input: {
  readonly context: AccessContext;
  readonly opportunityId: string;
  readonly expectedRevision: number;
  readonly selections: readonly RepresentativeSelection[];
  readonly repository?: MarketOpportunityRepository;
}): Promise<RepresentativeView> {
  if (input.context.mode !== "owner") throw new MarketOpportunityRepresentativeError("representative_invalid", "代表商品选择只对 Owner 开放。", 403);
  if (input.selections.length < 1) throw new MarketOpportunityRepresentativeError("representative_invalid", "至少选择一款代表商品。", 422);
  const repository = input.repository ?? createMarketOpportunityRepository();
  const { opportunity, itemMap } = await latestContext(input.opportunityId, repository);
  const parsedSet = parseRepresentativeSelectionSet({
    schemaVersion: "market-opportunity-representatives.v1",
    revision: opportunity.representativeSet.revision,
    items: input.selections,
  });
  const candidates = await candidateRows();
  const normalized: RepresentativeSelection[] = [];
  for (const selection of parsedSet.items) {
    const item = itemMap.get(`${selection.productFactSubjectKey}|${selection.asin}`);
    if (!item) throw new MarketOpportunityRepresentativeError("representative_invalid", "代表商品必须来自机会最新 MarketScan。", 422);
    const candidate = await resolveCandidate(item, candidates);
    normalized.push({ ...selection, candidateId: candidate?.id ?? null });
  }
  await repository.setRepresentatives({
    id: input.opportunityId,
    expectedRevision: input.expectedRevision,
    items: normalized,
  });
  return readRepresentativeView(input.opportunityId, repository);
}

/**
 * 旧版代表品研究启动（**已退役**，2026-11-02）。
 *
 * 历史实现只校验 owner、代表品归属与 Candidate 桥接，缺 Market Gate(PROCEED)、
 * 扫描快照哈希、readiness 与代表品版本校验，与正式 `handoffMarketToResearch`
 * 构成第二条 02→03 链路。为防任何未发现的调用方继续创建研究任务，这里在服务层
 * 直接以 410 拒绝；正式入口见 `lib/server/v5MarketService.ts#handoffMarketToResearch`。
 *
 * 只读能力（`readRepresentativeView`）与历史数据（NicheOpportunity / 代表品关系）保留。
 *
 * @deprecated 请使用 02 市场研究的正式研究交接 API。
 */
export async function startRepresentativeResearch(input: {
  readonly context: AccessContext;
  readonly opportunityId: string;
  readonly subjectKey: string;
}): Promise<{ readonly taskId: string; readonly mode: "created" | "existing"; readonly view: RepresentativeView }> {
  void input;
  throw new MarketOpportunityRepresentativeError(
    "legacy_research_handoff_retired",
    "旧版代表品研究入口已停用：请先完成 Market Gate（PROCEED），再通过 02 市场研究的正式交接进入 03。",
    410,
  );
}
