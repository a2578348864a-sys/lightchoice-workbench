import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import {
  PRODUCT_CONCEPT_SCHEMA,
  buildInitialProductConceptHumanDecision,
  type ProductConceptSnapshot,
  type ProductConceptHumanDecision,
} from "@/lib/marketOpportunity/concept";
import {
  createMarketOpportunityRepository,
  type MarketOpportunityRepository,
} from "@/lib/server/marketOpportunityRepository";
import {
  readRepresentativeView,
  type RepresentativeView,
} from "@/lib/server/marketOpportunityRepresentativeService";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";

export type ConceptGenerationMode = "deterministic" | "fail";

export class MarketOpportunityConceptError extends Error {
  constructor(
    public readonly code:
      | "opportunity_not_found"
      | "representatives_required"
      | "concept_invalid"
      | "concept_decision_invalid"
      | "concept_project_blocked",
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "MarketOpportunityConceptError";
  }
}

function unique(items: readonly string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim())));
}

function conceptInputs(
  opportunity: MarketOpportunityRecordView,
  representatives: RepresentativeView,
): { readonly snapshot: ProductConceptSnapshot; readonly selectedCount: number } {
  const selected = representatives.samples.filter((sample) => sample.selected);
  if (selected.length === 0) throw new MarketOpportunityConceptError("representatives_required", "至少选择一款代表商品后才能生成产品概念。", 409);
  const prices = selected.flatMap((sample) => sample.price ? [sample.price.amount] : []);
  const priceRefs = prices.length > 0 ? [opportunity.latestMarketScanId] : [];
  const factRefs = selected.flatMap((sample) => [
    { kind: "market_scan" as const, refId: opportunity.latestMarketScanId, path: `sample.${sample.asin}.factValues.price` },
    ...(sample.sales === null ? [] : [{ kind: "market_scan" as const, refId: opportunity.latestMarketScanId, path: `sample.${sample.asin}.factValues.monthlySalesEstimate` }]),
    ...(sample.rating === null ? [] : [{ kind: "market_scan" as const, refId: opportunity.latestMarketScanId, path: `sample.${sample.asin}.factValues.rating` }]),
    ...(sample.reviews === null ? [] : [{ kind: "market_scan" as const, refId: opportunity.latestMarketScanId, path: `sample.${sample.asin}.factValues.reviewCount` }]),
  ]);
  const researchRefs = selected.flatMap((sample) => sample.research.convertedTaskId
    ? [{ kind: "research" as const, refId: sample.research.convertedTaskId, path: "researchCompletion / researchReport" }]
    : []);
  const missing = unique([
    "采购成本与毛利：当前没有供应商报价或成本证据。",
    "供应商可行性：当前没有供应商身份、MOQ 或打样证据。",
    "合规 / IP：当前没有材料认证、法规或专利检索证据。",
    ...(selected.some((sample) => sample.research.researchStatus === "NOT_STARTED") ? ["代表商品 Research 尚未全部启动。"] : []),
    ...(selected.some((sample) => sample.research.missingEvidence.length > 0) ? ["代表商品 Research 仍有缺失证据。"] : []),
  ]);
  const confirmedFacts = unique(selected.flatMap((sample) => [
    sample.price ? `${sample.asin} 价格 ${sample.price.currency} ${sample.price.amount}` : "",
    sample.sales === null ? "" : `${sample.asin} 已知月销量估算 ${sample.sales}`,
    sample.rating === null ? "" : `${sample.asin} 评分 ${sample.rating}`,
    sample.reviews === null ? "" : `${sample.asin} 评论数 ${sample.reviews}`,
  ]));
  const derived = prices.length > 0
    ? [`代表商品价格观察区间为 ${Math.min(...prices)}–${Math.max(...prices)}，仅为样本派生范围。`]
    : [];
  const risks = unique([
    "样本指标来自锁定 MarketScan，不代表全市场。",
    "没有成本、供应链和合规证据前，不应把概念视为可生产方案。",
  ]);
  return {
    snapshot: {
      schemaVersion: PRODUCT_CONCEPT_SCHEMA,
      status: "READY",
      conceptId: randomUUID(),
      opportunityId: opportunity.id,
      revision: (opportunity.conceptSnapshot?.revision ?? 0) + 1,
      generatedAt: new Date().toISOString(),
      targetCustomer: null,
      useCases: [],
      primaryPainPoints: [],
      recommendedSpecs: [],
      differentiation: [],
      targetPriceRange: {
        status: prices.length > 0 ? "DERIVED" : "MISSING",
        min: prices.length > 0 ? Math.min(...prices) : null,
        max: prices.length > 0 ? Math.max(...prices) : null,
        currency: selected.find((sample) => sample.price)?.price?.currency ?? null,
        refs: priceRefs,
      },
      targetCostRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
      marginAssumptions: null,
      packagingDirection: [],
      supplierFeasibility: null,
      complianceRequirements: [],
      risks,
      missingValidation: missing,
      factRefs,
      researchRefs,
      assumptions: ["本概念由本地确定性合成器生成，不等同于真实 AI Provider 结论。"],
      confirmedFacts,
      derived,
      missing,
      aiSummary: `基于 ${selected.length} 款人工选择代表商品和已保存研究引用生成概念草案；成本、供应商与合规仍待验证。`,
      model: "local-concept-synthesis-v1",
      humanDecision: buildInitialProductConceptHumanDecision(),
    },
    selectedCount: selected.length,
  };
}

function failedConcept(opportunity: MarketOpportunityRecordView, representatives: RepresentativeView): ProductConceptSnapshot {
  const base = conceptInputs(opportunity, representatives);
  return {
    ...base.snapshot,
    status: "FAILED",
    aiSummary: null,
    model: null,
    errorCode: "CONCEPT_SYNTHESIS_FAILED",
  };
}

export async function generateProductConcept(input: {
  readonly context: AccessContext;
  readonly opportunityId: string;
  readonly mode?: ConceptGenerationMode;
  readonly repository?: MarketOpportunityRepository;
}): Promise<{ readonly opportunity: MarketOpportunityRecordView; readonly representatives: RepresentativeView; readonly concept: ProductConceptSnapshot }> {
  if (input.context.mode !== "owner") throw new MarketOpportunityConceptError("concept_invalid", "产品概念只对 Owner 开放。", 403);
  const repository = input.repository ?? createMarketOpportunityRepository();
  const opportunity = await repository.getById(input.opportunityId);
  if (!opportunity) throw new MarketOpportunityConceptError("opportunity_not_found", "没有找到该市场机会。", 404);
  const representatives = await readRepresentativeView(input.opportunityId, repository);
  if (representatives.selectedCount === 0) throw new MarketOpportunityConceptError("representatives_required", "至少选择一款代表商品后才能生成产品概念。", 409);
  const concept = input.mode === "fail" ? failedConcept(opportunity, representatives) : conceptInputs(opportunity, representatives).snapshot;
  const saved = await repository.setConceptSnapshot(input.opportunityId, concept);
  return { opportunity: saved, representatives: await readRepresentativeView(input.opportunityId, repository), concept: saved.conceptSnapshot as ProductConceptSnapshot };
}

export async function saveProductConceptDecision(input: {
  readonly context: AccessContext;
  readonly opportunityId: string;
  readonly status: ProductConceptHumanDecision["status"];
  readonly reason: string;
  readonly expectedRevision: number;
  readonly repository?: MarketOpportunityRepository;
}): Promise<MarketOpportunityRecordView> {
  if (input.context.mode !== "owner") throw new MarketOpportunityConceptError("concept_decision_invalid", "产品概念人工决策只对 Owner 开放。", 403);
  if (!input.reason.trim()) throw new MarketOpportunityConceptError("concept_decision_invalid", "产品概念人工决策必须填写理由。", 422);
  const repository = input.repository ?? createMarketOpportunityRepository();
  const current = await repository.getById(input.opportunityId);
  if (!current?.conceptSnapshot) throw new MarketOpportunityConceptError("concept_decision_invalid", "请先生成产品概念。", 409);
  return repository.setConceptHumanDecision({
    id: input.opportunityId,
    expectedRevision: input.expectedRevision,
    value: {
      status: input.status,
      reason: input.reason.trim(),
      decidedAt: new Date().toISOString(),
      revision: current.conceptSnapshot.humanDecision.revision + 1,
    },
  });
}
