import type { NextRequest } from "next/server";

import { runMarketOpportunityAi, failedAiFromError } from "@/lib/marketOpportunity/ai";
import {
  MarketOpportunityContractError,
  parseMarketOpportunityHumanDecisionStatus,
} from "@/lib/marketOpportunity/contract";
import { syncOpportunityExport } from "@/lib/integrations/lark/opportunityExportSync";
import {
  MarketOpportunityPersistenceError,
  createMarketOpportunityRepository,
} from "@/lib/server/marketOpportunityRepository";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";

export type MarketOpportunityApiError = {
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number;
};

export function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  let expected = url.origin;
  if (host !== null) {
    try {
      expected = new URL(`${url.protocol}//${host}`).origin;
    } catch {
      return false;
    }
  }
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && new URL(referer).origin === expected
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

export function toMarketOpportunityListView(record: MarketOpportunityRecordView) {
  const metrics = record.analysisSnapshot.metrics;
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    nicheKind: record.nicheKind,
    nicheDefinition: record.nicheDefinition,
    latestMarketScanId: record.latestMarketScanId,
    sampleCount: metrics.sampleCount,
    metricsVersion: metrics.metricsVersion,
    analysisStatus: record.analysisSnapshot.status,
    aiStatus: record.aiInterpretation?.status ?? "NOT_REQUESTED",
    humanDecision: record.humanDecision?.status ?? "UNREVIEWED",
    larkSync: record.larkSync.status,
    representativeCount: record.representativeSet.items.length,
    conceptStatus: record.conceptSnapshot?.status ?? "NOT_GENERATED",
    conceptHumanDecision: record.conceptSnapshot?.humanDecision.status ?? "UNREVIEWED",
    conceptProjectSync: record.conceptProjectSync.status,
    missingEvidenceCount: record.analysisSnapshot.missingEvidence.length,
    priceMedian: metrics.price.value?.median ?? null,
    knownSalesTotal: metrics.sales.value?.total ?? null,
    knownRevenueTotal: metrics.revenue.value?.total ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toMarketOpportunityDetailView(record: MarketOpportunityRecordView) {
  return {
    ...toMarketOpportunityListView(record),
    scanRefs: record.scanRefs,
    analysisSnapshot: record.analysisSnapshot,
    aiInterpretation: record.aiInterpretation,
    humanDecision: record.humanDecision?.status ?? "UNREVIEWED",
    humanDecisionDetail: record.humanDecision,
    humanDecisionRevision: record.humanDecision?.revision ?? 0,
    larkSync: record.larkSync,
    representativeSet: record.representativeSet,
    conceptSnapshot: record.conceptSnapshot,
    conceptProjectSync: record.conceptProjectSync,
    scopeNotice: "机会池只编组已存在的 MarketScan；AI 文本不能替代事实与人工决策。",
  };
}

export function apiErrorOf(error: unknown, fallback = "机会池操作失败，请稍后重试。"): MarketOpportunityApiError {
  if (error instanceof MarketOpportunityPersistenceError) {
    const status = error.code === "market_opportunity_not_found" ? 404
      : error.code === "market_opportunity_conflict" ? 409
        : error.code === "market_opportunity_invalid_record" ? 422 : 500;
    return { code: error.code, message: error.message, httpStatus: status };
  }
  if (error instanceof MarketOpportunityContractError) {
    return { code: error.code, message: error.message, httpStatus: 422 };
  }
  return {
    code: "market_opportunity_failed",
    message: error instanceof Error ? error.message : fallback,
    httpStatus: 500,
  };
}

export { createMarketOpportunityRepository, failedAiFromError, parseMarketOpportunityHumanDecisionStatus, runMarketOpportunityAi, syncOpportunityExport };
