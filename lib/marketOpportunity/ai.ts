/**
 * Phase 2：机会解释的输入 / 输出守卫。
 *
 * 本模块没有网络调用。deterministic 模式只用于本地契约和浏览器验收，明确标为
 * local-deterministic；real 模式当前 fail-closed，避免没有授权时误触发付费 Provider。
 */

import {
  buildFailedAiInterpretation,
  parseMarketOpportunityAiInterpretation,
} from "@/lib/marketOpportunity/contract";
import type {
  MarketOpportunityAiInterpretation,
  MarketOpportunityAnalysisSnapshot,
  MarketOpportunityFactRef,
} from "@/lib/marketOpportunity/types";

export type MarketOpportunityAiMode = "disabled" | "deterministic" | "real";

export type MarketOpportunityAiInput = {
  readonly schemaVersion: "market-opportunity-ai-input.v1";
  readonly nicheDefinition: MarketOpportunityAnalysisSnapshot["sampleDefinition"] extends never
    ? never
    : Record<string, unknown>;
  readonly latestMetrics: MarketOpportunityAnalysisSnapshot["metrics"];
  readonly comparableHistory: MarketOpportunityAnalysisSnapshot["comparison"];
  readonly coverage: MarketOpportunityAnalysisSnapshot["metrics"]["fieldCoverage"];
  readonly sourceTime: MarketOpportunityAnalysisSnapshot["metrics"]["evidenceWindow"];
  readonly missingEvidence: readonly string[];
};

export class MarketOpportunityAiError extends Error {
  constructor(
    public readonly code: "AI_DISABLED" | "AI_PROVIDER_NOT_CONFIGURED" | "AI_OUTPUT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "MarketOpportunityAiError";
  }
}

const ALLOWED_FACT_PATHS = new Set([
  "metrics.price.value.median",
  "metrics.sales.value.total",
  "metrics.revenue.value.total",
  "metrics.salesConcentration.cr5.value.ratio",
  "metrics.brandConcentration.uniqueBrandCount.value",
  "metrics.rating.averageRating.value",
  "metrics.reviews.medianReviewCount.value",
  "metrics.fieldCoverage",
  "comparison",
]);

function factRef(
  path: string,
  source: MarketOpportunityFactRef["source"],
  scanId: string,
): MarketOpportunityFactRef {
  return { path, source, scanId };
}

export function buildMarketOpportunityAiInput(
  snapshot: MarketOpportunityAnalysisSnapshot,
  nicheDefinition: Record<string, unknown>,
): MarketOpportunityAiInput {
  return {
    schemaVersion: "market-opportunity-ai-input.v1",
    nicheDefinition,
    latestMetrics: snapshot.metrics,
    comparableHistory: snapshot.comparison,
    coverage: snapshot.metrics.fieldCoverage,
    sourceTime: snapshot.metrics.evidenceWindow,
    missingEvidence: snapshot.missingEvidence,
  };
}

function displayNumber(value: number | null): string {
  return value === null ? "缺失" : String(Math.round(value * 100) / 100);
}

/** 仅引用当前分析快照中已有字段的本地测试替身；不产生新的市场数值事实。 */
export function interpretMarketOpportunityDeterministically(
  snapshot: MarketOpportunityAnalysisSnapshot,
): MarketOpportunityAiInterpretation {
  const scanId = snapshot.latestScanId;
  const refs: MarketOpportunityFactRef[] = [
    factRef("metrics.fieldCoverage", "coverage", scanId),
  ];
  const observations: string[] = [
    `当前样本包含 ${snapshot.metrics.sampleCount} 条已锁定商品事实，指标版本为 ${snapshot.metrics.metricsVersion}。`,
    `价格中位数：${displayNumber(snapshot.metrics.price.value?.median ?? null)}；已知月销量总量：${displayNumber(snapshot.metrics.sales.value?.total ?? null)}。`,
  ];
  refs.push(
    factRef("metrics.price.value.median", "market_scan_metrics", scanId),
    factRef("metrics.sales.value.total", "market_scan_metrics", scanId),
  );
  const risks: string[] = [];
  if (snapshot.metrics.price.status !== "PRESENT" || snapshot.metrics.sales.status !== "PRESENT") {
    risks.push("价格或销量指标存在缺失，不能据此形成完整机会判断。 ");
  }
  if (snapshot.comparison === null) {
    risks.push("当前没有可用的历史扫描比较，趋势判断仍缺少时间序列证据。");
  } else {
    refs.push(factRef("comparison", "scan_comparison", snapshot.comparison.toScanId));
    if (snapshot.comparison.status !== "COMPARABLE") {
      risks.push("历史扫描的定义或版本不可比，本次只呈现当前事实。");
    }
  }
  return parseMarketOpportunityAiInterpretation({
    schemaVersion: "market-opportunity-ai.v1",
    status: "READY",
    summary: "这是基于已锁定 MarketScan 事实的本地解释草稿，不能替代人工决策。",
    observations,
    risks,
    missingEvidence: snapshot.missingEvidence,
    questionsToValidate: [
      "是否需要补充更长观察窗口或第二次同定义扫描？",
      "销量与收入字段的来源覆盖是否足以支持下一步验证？",
    ],
    suggestedNextStep: "先由 Owner 核对样本定义、覆盖率和来源时间，再决定继续、观察或补数据。",
    factRefs: refs,
    generatedAt: new Date().toISOString(),
    model: "local-deterministic-v1",
  });
}

export function assertAiInterpretationBound(
  interpretation: MarketOpportunityAiInterpretation,
  allowedScanIds: ReadonlySet<string>,
): MarketOpportunityAiInterpretation {
  const parsed = parseMarketOpportunityAiInterpretation(interpretation);
  for (const ref of parsed.factRefs) {
    if (!allowedScanIds.has(ref.scanId) || !ALLOWED_FACT_PATHS.has(ref.path)) {
      throw new MarketOpportunityAiError(
        "AI_OUTPUT_INVALID",
        "AI 输出引用了不在当前机会事实范围内的字段。",
      );
    }
  }
  if (parsed.status === "READY" && parsed.factRefs.length === 0) {
    throw new MarketOpportunityAiError("AI_OUTPUT_INVALID", "AI READY 输出必须携带事实引用。");
  }
  return parsed;
}

export function resolveMarketOpportunityAiMode(
  env: Record<string, string | undefined> = process.env,
): MarketOpportunityAiMode {
  const raw = env.MARKET_OPPORTUNITY_AI_MODE?.trim().toLowerCase();
  if (raw === "deterministic") return "deterministic";
  if (raw === "real" && env.MARKET_OPPORTUNITY_REAL_AI_ENABLED === "true") return "real";
  return "disabled";
}

export function runMarketOpportunityAi(
  snapshot: MarketOpportunityAnalysisSnapshot,
  nicheDefinition: Record<string, unknown>,
  options: { readonly mode?: MarketOpportunityAiMode } = {},
): MarketOpportunityAiInterpretation {
  const mode = options.mode ?? resolveMarketOpportunityAiMode();
  // 构造并保留这个输入边界，确保未来接 Provider 时不会绕过契约。
  buildMarketOpportunityAiInput(snapshot, nicheDefinition);
  if (mode === "deterministic") {
    return assertAiInterpretationBound(
      interpretMarketOpportunityDeterministically(snapshot),
      new Set([snapshot.latestScanId, ...(snapshot.comparison ? [snapshot.comparison.fromScanId] : [])]),
    );
  }
  if (mode === "real") {
    throw new MarketOpportunityAiError(
      "AI_PROVIDER_NOT_CONFIGURED",
      "真实 AI Provider 尚未接入；当前只允许在获得专项授权后接入。",
    );
  }
  throw new MarketOpportunityAiError("AI_DISABLED", "机会解释未启用 AI 模式。");
}

export function failedAiFromError(error: unknown): MarketOpportunityAiInterpretation {
  if (error instanceof MarketOpportunityAiError) return buildFailedAiInterpretation(error.code);
  return buildFailedAiInterpretation("AI_OUTPUT_INVALID");
}
