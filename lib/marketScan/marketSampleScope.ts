/**
 * MarketScan 样本范围投影（读侧，服务端唯一权威）。
 *
 * 目的：把「采集到多少」「技术有效多少」「有多少符合本次研究范围」「多少待人工核实」
 * 分开表达，避免把 validSampleCount 误读成「直接竞品数量」。
 *
 * 硬约束：
 * - 只复用既有确定性能力：样本有效性（marketSamplePolicy）、标题子类型分类
 *   （sampleHomogeneity）、已确认品类专项范围分析（marketScopeAnalysis）。
 * - 不新增 AI 分类、不新增第二事实来源、不按标题关键词臆断任意品类。
 * - 目标品类没有可用范围规则时，inScope/outOfScope 一律 `null`，全部计入 unknown，
 *   并标记 `manualReviewRequired`——不得用 0 或全量冒充「已核实」。
 * - 本投影不参与 Market Gate、样本哈希、代表商品与 Research Handoff 的任何判定。
 */

import {
  analyzeSampleHomogeneity,
  type SampleHomogeneityReport,
  type SampleSubtypeId,
} from "@/lib/marketScan/sampleHomogeneity";
import type { MarketScopeAnalysisV1 } from "@/lib/marketScan/marketScopeAnalysis";

export const MARKET_SAMPLE_SCOPE_VERSION = "market-sample-scope.v1" as const;

export type MarketSampleScopeBasis =
  /** 该品类已有确认的专项范围规则（目前仅硅胶烘焙垫），in/out 可直接给出 */
  | "CONFIRMED_TOPIC_SCOPE"
  /** 只有标题子类型分布，没有可用于判定「是否符合研究范围」的正式规则 */
  | "TITLE_SUBTYPE_ONLY"
  /** 连标题都没有，无法给出任何分布 */
  | "UNAVAILABLE";

export type MarketSampleSubtypeGroup = {
  readonly id: SampleSubtypeId;
  readonly label: string;
  readonly labelEn: string;
  readonly count: number;
  readonly share: number;
};

export type MarketSampleScopeProjection = {
  readonly version: typeof MARKET_SAMPLE_SCOPE_VERSION;
  readonly basis: MarketSampleScopeBasis;
  /** 本次研究声明的范围（来自 nicheDefinition.label，仅作展示，不参与判定） */
  readonly targetLabel: string | null;
  readonly counts: {
    /** 原始采集并锁定的样本数 */
    readonly raw: number;
    /** 按既有采集合同技术有效的样本数（= decisionReadiness.validSampleCount） */
    readonly technicallyValid: number;
    /** 有正式规则判定为符合研究范围的数量；null = 当前品类无法自动判定 */
    readonly inScope: number | null;
    /** 有正式规则判定为不符合研究范围的数量；null = 当前品类无法自动判定 */
    readonly outOfScope: number | null;
    /** 无法判断是否符合研究范围的数量；null = 不适用（已有专项规则时以 in/out 为准） */
    readonly unknown: number | null;
  };
  /** 标题子类型分布（确定性、仅标题、可筛选展示） */
  readonly subtypeGroups: readonly MarketSampleSubtypeGroup[];
  readonly dominantSubtype: MarketSampleSubtypeGroup | null;
  readonly mixedRisk: SampleHomogeneityReport["mixedRisk"];
  /** 是否必须由人工确认研究范围后才能把样本当作同类市场 */
  readonly manualReviewRequired: boolean;
  readonly notes: readonly string[];
  readonly limitations: readonly string[];
};

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function subtypeGroupsOf(report: SampleHomogeneityReport): MarketSampleSubtypeGroup[] {
  return report.groups.map((group) => ({
    id: group.id,
    label: group.label,
    labelEn: group.labelEn,
    count: group.count,
    share: group.share,
  }));
}

export function buildMarketSampleScope(input: {
  readonly nicheDefinition: Record<string, unknown>;
  readonly items: ReadonlyArray<{ asin: string; title?: string | null }>;
  readonly technicallyValidCount: number;
  readonly marketScopeAnalysis?: MarketScopeAnalysisV1 | null;
}): MarketSampleScopeProjection {
  const raw = input.items.length;
  const technicallyValid = Math.max(0, Math.min(raw, Math.trunc(input.technicallyValidCount)));
  const targetLabel = textOf(input.nicheDefinition.label);

  const titledItems = input.items.filter((item) => typeof item.title === "string" && item.title.trim().length > 0);
  const report = analyzeSampleHomogeneity(
    titledItems.map((item) => ({ asin: item.asin, title: item.title ?? null })),
  );
  const subtypeGroups = subtypeGroupsOf(report);
  const dominantSubtype = subtypeGroups[0] ?? null;

  const notes: string[] = [];
  const limitations: string[] = [];

  if (input.marketScopeAnalysis) {
    const analysis = input.marketScopeAnalysis;
    notes.push(
      `该品类已有确认的专项范围规则：按标题确定性初筛 ${analysis.totalCount} 件（范围外 ${analysis.counts.OUT_OF_SCOPE} 件，无法判断 ${analysis.counts.UNCERTAIN} 件）。`,
    );
    limitations.push("专项规则只按标题命中判断相关性，不代表详情用途、规格或可比价格已被核实。");
    if (analysis.totalCount !== raw) {
      limitations.push(`专项分析覆盖 ${analysis.totalCount} 件，与锁定样本 ${raw} 件不一致，请以锁定样本为准。`);
    }
    return {
      version: MARKET_SAMPLE_SCOPE_VERSION,
      basis: "CONFIRMED_TOPIC_SCOPE",
      targetLabel,
      counts: {
        raw,
        technicallyValid,
        inScope: analysis.counts.IN_SCOPE,
        outOfScope: analysis.counts.OUT_OF_SCOPE,
        unknown: analysis.counts.UNCERTAIN,
      },
      subtypeGroups,
      dominantSubtype,
      mixedRisk: report.mixedRisk,
      manualReviewRequired: analysis.counts.UNCERTAIN > 0 || report.mixedRisk === "high",
      notes,
      limitations,
    };
  }

  if (titledItems.length === 0) {
    return {
      version: MARKET_SAMPLE_SCOPE_VERSION,
      basis: "UNAVAILABLE",
      targetLabel,
      counts: { raw, technicallyValid, inScope: null, outOfScope: null, unknown: raw },
      subtypeGroups,
      dominantSubtype: null,
      mixedRisk: report.mixedRisk,
      manualReviewRequired: raw > 0,
      notes: ["当前样本缺少商品标题，无法给出任何类型分布。"],
      limitations: ["标题缺失时不得推断商品类型；请先补齐采集或人工核对。"],
    };
  }

  notes.push(
    `当前品类没有可用于判定「是否符合研究范围」的正式规则：${raw} 件样本中，${technicallyValid} 件技术上有效，但范围归属全部待人工核实。`,
  );
  notes.push(
    "标题子类型分布仅用于帮助人工筛选同类商品，不改变锁定样本、样本哈希、Market Gate 与代表商品。",
  );
  limitations.push("技术有效数量（validSampleCount）只表示样本按采集合同可用，不等于同质竞品数量。");
  limitations.push("未命中任何子类型规则的商品保持「待人工确认」，不强行归类，也不计入任何竞品数量。");
  if (dominantSubtype && dominantSubtype.id !== "unknown") {
    limitations.push(
      `占比最高的子类型为「${dominantSubtype.label}」${dominantSubtype.count} 款（${Math.round(dominantSubtype.share * 100)}%）；是否属于本次研究范围仍需人工确认。`,
    );
  }
  if (report.mixedRisk === "high") {
    limitations.push("样本混合了多个细分类型：整体价格中位数与竞争强度不能直接当作某一具体产品的结论。");
  }

  return {
    version: MARKET_SAMPLE_SCOPE_VERSION,
    basis: "TITLE_SUBTYPE_ONLY",
    targetLabel,
    counts: { raw, technicallyValid, inScope: null, outOfScope: null, unknown: raw },
    subtypeGroups,
    dominantSubtype,
    mixedRisk: report.mixedRisk,
    manualReviewRequired: raw > 0,
    notes,
    limitations,
  };
}
