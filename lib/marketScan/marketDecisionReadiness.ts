import { MIN_VALID_SAMPLE_COUNT } from "@/lib/marketScan/marketSamplePolicy";
export { MIN_VALID_SAMPLE_COUNT };
export const RECOMMENDED_VALID_SAMPLE_RANGE = { min: 40, max: 60 } as const;

export type SampleSufficiencyStatus = "INSUFFICIENT_SAMPLE" | "SAMPLE_SUFFICIENT";
export type DecisionReadinessStatus = "READY" | "READY_WITH_MISSING_DATA_CONFIRMATION" | "NOT_READY";

export type DecisionReadinessBlocker = {
  readonly code: string;
  readonly label: string;
  readonly detail: string;
};

export type MarketDecisionReadiness = {
  readonly status: DecisionReadinessStatus;
  readonly sampleSufficiency: SampleSufficiencyStatus;
  readonly rawSampleCount: number;
  readonly validSampleCount: number;
  readonly requiredValidSampleCount: number;
  readonly evidenceWindow: {
    readonly earliestCapturedAt: string | null;
    readonly latestCapturedAt: string | null;
    readonly observedAtSource: string;
  };
  /** 硬阻断：样本门槛、价格、证据窗口等不允许人工确认绕过的前提。 */
  readonly blockers: readonly DecisionReadinessBlocker[];
  /**
   * 可确认缺失：数据来源本身暂时无法提供、且不属于安全/完整性硬风险的关键指标
   * （需求/销量、品牌集中度）。样本充足且无硬阻断时，用户可显式确认后继续。
   */
  readonly acknowledgeableMissing: readonly DecisionReadinessBlocker[];
};

export type MarketProceedBlockReason =
  | "INSUFFICIENT_SAMPLE"
  | "NOT_READY"
  | "MISSING_ACK_REQUIRED";

type Metric = { status?: unknown; sampleSize?: unknown; missingCount?: unknown; value?: unknown };
type RecordValue = Record<string, unknown>;

/**
 * Fail-closed market readiness projection.
 * - 样本不足 / 价格不完整 / 证据窗口未知 = NOT_READY（不可人工绕过）。
 * - 需求/销量、品牌集中度缺失 = 可确认缺失：样本充足且无硬阻断时进入
 *   READY_WITH_MISSING_DATA_CONFIRMATION，由用户显式确认并填写理由后才能 PROCEED；
 *   服务端仍会校验确认与理由，不自动绿灯。
 */
export function evaluateMarketDecisionReadiness(metricsValue: unknown): MarketDecisionReadiness {
  const metrics = record(metricsValue);
  const rawSampleCount = nonNegativeInteger(metrics.sampleCount);
  const validSampleCount = Math.min(rawSampleCount, nonNegativeInteger(metrics.validSampleCount));
  const sampleSufficiency: SampleSufficiencyStatus = validSampleCount >= MIN_VALID_SAMPLE_COUNT
    ? "SAMPLE_SUFFICIENT"
    : "INSUFFICIENT_SAMPLE";
  const blockers: DecisionReadinessBlocker[] = [];
  const acknowledgeableMissing: DecisionReadinessBlocker[] = [];

  if (sampleSufficiency === "INSUFFICIENT_SAMPLE") {
    blockers.push({
      code: "INSUFFICIENT_SAMPLE",
      label: "有效样本不足",
      detail: `当前 ${validSampleCount} 个有效商品，至少需要 ${MIN_VALID_SAMPLE_COUNT} 个。`,
    });
  }

  const limitedCount = nonNegativeInteger(metrics.limitedEvidenceSampleCount);
  if (limitedCount > 0) acknowledgeableMissing.push({ code: "LIMITED_EVIDENCE", label: "部分商品证据有限", detail: `${limitedCount} 个有效商品的证据完整度有限；请记录缺口和继续判断的理由。` });

  const price = completeMetric(metrics.price, validSampleCount);
  if (!price) blockers.push({ code: "PRICE_NOT_COMPLETE", label: "价格数据不完整", detail: metricDetail(metrics.price, validSampleCount) });

  const sales = completeMetric(metrics.sales, validSampleCount);
  if (!sales) acknowledgeableMissing.push({ code: "DEMAND_NOT_COMPLETE", label: "销量 / 需求数据不完整", detail: metricDetail(metrics.sales, validSampleCount) });

  const brandConcentration = record(metrics.brandConcentration);
  const brandCr5 = completeMetric(brandConcentration.brandCr5, validSampleCount);
  if (!brandCr5) acknowledgeableMissing.push({
    code: "BRAND_CR5_NOT_COMPUTABLE",
    label: "品牌集中度（CR5）无法完整计算",
    detail: metricDetail(brandConcentration.brandCr5, validSampleCount),
  });

  const evidenceWindow = record(metrics.evidenceWindow);
  const earliestCapturedAt = parseableIso(evidenceWindow.earliestCapturedAt);
  const latestCapturedAt = parseableIso(evidenceWindow.latestCapturedAt);
  const observedAtSource = typeof evidenceWindow.observedAtSource === "string" ? evidenceWindow.observedAtSource : "unknown";
  if (!earliestCapturedAt || !latestCapturedAt || Date.parse(earliestCapturedAt) > Date.parse(latestCapturedAt) || !["caller_recorded", "evidence_captured_at"].includes(observedAtSource)) {
    blockers.push({
      code: "EVIDENCE_WINDOW_NOT_COMPUTABLE",
      label: "证据时间窗口未知",
      detail: "缺少可解析的采集时间边界，不能判断指标依据的证据窗口。",
    });
  }

  const status: DecisionReadinessStatus = blockers.length > 0
    ? "NOT_READY"
    : acknowledgeableMissing.length > 0
      ? "READY_WITH_MISSING_DATA_CONFIRMATION"
      : "READY";

  return {
    status,
    sampleSufficiency,
    rawSampleCount,
    validSampleCount,
    requiredValidSampleCount: MIN_VALID_SAMPLE_COUNT,
    evidenceWindow: { earliestCapturedAt, latestCapturedAt, observedAtSource },
    blockers,
    acknowledgeableMissing,
  };
}

/**
 * PROCEED 的阻断判定。可确认缺失在用户未显式确认时同样阻断（MISSING_ACK_REQUIRED）；
 * 确认后由调用方（Gate 保存）再校验判断理由。人工绕过只适用于可确认缺失，
 * 样本不足与硬阻断永远不可绕过。
 */
export function marketProceedBlockReason(
  readiness: MarketDecisionReadiness,
  options?: { missingDataAcknowledged?: boolean },
): MarketProceedBlockReason | null {
  if (readiness.sampleSufficiency === "INSUFFICIENT_SAMPLE") return "INSUFFICIENT_SAMPLE";
  if (readiness.blockers.length > 0) return "NOT_READY";
  if (readiness.acknowledgeableMissing.length > 0 && options?.missingDataAcknowledged !== true) {
    return "MISSING_ACK_REQUIRED";
  }
  return null;
}

function completeMetric(value: unknown, validSampleCount: number): boolean {
  const metric = record(value) as Metric;
  return metric.status === "PRESENT"
    && metric.value !== null
    && typeof metric.value === "object"
    && metric.sampleSize === validSampleCount
    && metric.missingCount === 0;
}

function metricDetail(value: unknown, validSampleCount: number): string {
  const metric = record(value) as Metric;
  const sampleSize = nonNegativeInteger(metric.sampleSize);
  const missingCount = nonNegativeInteger(metric.missingCount);
  if (metric.status !== "PRESENT" || metric.value === null || metric.value === undefined) {
    if (metric.status === "NOT_AVAILABLE") return "当前数据来源暂时无法提供该指标；缺失会降低判断可信度，需人工确认后才能继续。";
    if (metric.status === "INSUFFICIENT_DATA") return "当前数据不足以计算该指标；缺失会降低判断可信度，需人工确认后才能继续。";
    return "指标结果缺失或状态无法核实；缺失会降低判断可信度，需人工确认后才能继续。";
  }
  return `有效商品 ${validSampleCount} 个，指标实际覆盖 ${sampleSize} 个；缺失或无效记录 ${missingCount} 个。`;
}

function parseableIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
