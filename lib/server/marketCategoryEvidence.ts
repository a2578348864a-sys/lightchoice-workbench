/**
 * 类目市场证据 → 02 市场研究的只读消费层。
 *
 * 硬边界（与 `lib/marketScan/types.ts` 一致）：
 * - MarketScan 的确定性指标只由锁定的 ProductFact 样本计算，**本模块不参与任何 metrics 计算**；
 * - 类目市场观察是 SellerSprite 第三方估算（`amazonConfirmed: false`），
 *   只能作为「市场级观察」单独展示，**不得下发给任何 ASIN 变成商品事实**；
 * - 研究市场与类目证据之间必须是**显式绑定**（用户在 02 页选择），
 *   不允许按标签/关键词字符串相似自动关联；
 * - 证据缺失、主体不合法、站点不匹配、批次损坏一律 fail-closed 返回 null，不用默认值顶替。
 */

import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import {
  assertCategoryMarketCaptureBatch,
  isCategoryMarketSubjectKey,
  type CategoryMarketCaptureBatch,
  type ProviderEstimate,
} from "@/lib/sourceLayer/categoryMarketCapture";

/** MarketScan 的 nicheDefinition 里保存显式绑定的参数名（无 schema 迁移，走既有 JSON 字段）。 */
export const CATEGORY_EVIDENCE_BINDING_PARAM = "categoryEvidenceSubjectKey" as const;

export type CategoryEvidenceMetric = {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  /** 恒为第三方估算；绝不与 Amazon 实测混用。 */
  readonly nature: "provider_estimate";
  readonly unit: "count" | "currency" | "rating" | "percent";
  /**
   * 是否可用于有效指标计算。
   * 违反字段合同范围（如百分比不在 0–100）时为 false：保留原始值供追溯，
   * 但不得参与任何汇总、排序或研究结论。
   */
  readonly usableForMetrics: boolean;
  /** 异常原因码；正常值为 null。 */
  readonly anomaly: "out_of_range_percent" | "negative_value" | null;
};

export type CategoryEvidenceSummary = {
  readonly subjectKey: string;
  readonly nodeId: string;
  readonly batchId: string;
  readonly label: string;
  readonly query: string;
  readonly marketplace: "US";
  readonly capturedAt: string;
  readonly rowCount: number;
  readonly amazonConfirmed: false;
  readonly providerProductCount: number | null;
};

export type CategoryEvidenceRow = {
  readonly segment: string;
  readonly metrics: readonly CategoryEvidenceMetric[];
  readonly warnings: readonly string[];
};

export type CategoryEvidenceDetail = CategoryEvidenceSummary & {
  readonly sourceUrl: string;
  readonly sourceProvider: "SellerSprite";
  readonly rows: readonly CategoryEvidenceRow[];
  /** 采集时间距今的天数；时间不可解析时为 null（不猜）。 */
  readonly ageDays: number | null;
  readonly observedHeaders: readonly string[] | null;
  /** 是否存在违反字段合同范围的指标（保留原值，但不可用于指标计算）。 */
  readonly hasAnomalousMetrics: boolean;
};

/** 类目路径中某个非首段的细分范围证据。 */
export type CategoryScopeSegment = {
  readonly segment: string;
  readonly keywords: readonly string[];
  /** 该段关键词在样本标题中被命中的商品数。 */
  readonly matchedSampleCount: number;
  readonly sampleTotal: number;
  /** 命中率是否达到阈值（可用于判定细分匹配）。 */
  readonly supported: boolean;
};

export type CategoryScopeAssessment = {
  /**
   * 四级范围语义（`range_matched` 才表示「范围匹配」）：
   * - `range_matched`：类目每个非首段都在样本标题中有足够命中证据（细分范围匹配）；
   * - `category_related`：只有一级类目相交，细分范围未被证实（需人工确认）；
   * - `possible_mismatch`：已有证据显示一级类目都不相交（需人工确认）；
   * - `unknown`：来源类目或样本事实不足，无法证明任何相关性。
   */
  readonly level: "range_matched" | "category_related" | "possible_mismatch" | "unknown";
  readonly evidenceTopCategory: string | null;
  readonly sampleCategoryTop: string | null;
  /** 样本中与所选类目一级目录相交的商品数。 */
  readonly sampleCategoryMatchCount: number;
  readonly sampleCategoryTotal: number;
  /** 类目非首段的细分范围证据；一级目录不相交或类目只有一级时为空。 */
  readonly segments: readonly CategoryScopeSegment[];
  readonly reason: string;
};

export type CategoryEvidenceView = {
  readonly linked: CategoryEvidenceDetail | null;
  readonly available: readonly CategoryEvidenceSummary[];
  /**
   * 绑定状态说明：
   * - `linked`：已显式绑定且证据可用；
   * - `not_linked`：尚未绑定（可绑定列表非空）；
   * - `linked_evidence_missing`：绑定存在但证据已不可读（fail-closed，不自动改绑）；
   * - `no_evidence`：本 EvidenceStore 里没有该类目市场的证据。
   */
  readonly status: "linked" | "not_linked" | "linked_evidence_missing" | "no_evidence";
  readonly notice: string;
  /** 已绑定证据与当前研究的范围匹配评估；未绑定时为 null。 */
  readonly scopeAssessment: CategoryScopeAssessment | null;
  /** 每个可选类目证据与当前研究的范围评估，用于绑定前的提示。 */
  readonly availableScopeAssessments: Readonly<Record<string, CategoryScopeAssessment>>;
};

function topCategorySegment(label: string): string | null {
  const top = label.split(":")[0]?.trim() ?? "";
  return top.length > 0 ? top : null;
}

/** 非首段细分路径，如 "Kitchen & Dining"、"Storage & Organization"。 */
function categoryTailSegments(label: string): string[] {
  return label
    .split(":")
    .slice(1)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** 类目路径段做比较用的小写归一化形式。 */
function normalizeSegment(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * 是否存在**结构化类目路径**证据，表明来源批次商品确实属于所选类目的细分层级。
 *
 * 只有同时满足才算：
 * - 所选类目至少有一个非首段（否则无从证明细分）；
 * - 某条来源类目路径的段集合覆盖所选类目的**全部**非首段。
 *
 * 标题关键词命中率不参与本判定。
 */
function supportsStructuredSubcategory(categoryLabel: string, sampleCategoryPaths: ReadonlyArray<string | null | undefined>): boolean {
  const required = categoryTailSegments(categoryLabel).map(normalizeSegment);
  if (required.length === 0) return false;
  for (const raw of sampleCategoryPaths) {
    if (typeof raw !== "string") continue;
    const segments = raw
      .split(":")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .map(normalizeSegment);
    if (segments.length === 0) continue;
    if (required.every((item) => segments.includes(item))) return true;
  }
  return false;
}

const SEGMENT_STOP_WORDS = new Set([
  "and", "the", "of", "for", "with", "without", "from", "into", "your", "use", "etc", "other", "misc", "all",
]);

/** 细分段命中率阈值：至少一半样本标题命中，才算该细分段有样本证据。 */
const SUB_SEGMENT_MATCH_THRESHOLD = 0.5;
const SEGMENT_KEYWORD_MIN_LENGTH = 3;

/** 从细分段提取可比对的小写关键词；只取功能词以外的实词。 */
function segmentKeywords(segment: string): string[] {
  const words = segment
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^a-z0-9]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= SEGMENT_KEYWORD_MIN_LENGTH && !SEGMENT_STOP_WORDS.has(word));
  return [...new Set(words)];
}

function normalizeCategory(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
/**
 * 评估 SellerSphere 类目证据与当前研究的范围关系（四级别）。
 *
 * 语义分四级，只有 `range_matched` 才表示「范围匹配」：
 * 1. `range_matched`：类目的每个非首段都能在样本标题中找到足够命中证据；
 * 2. `category_related`：只有一级类目相交，细分范围未被证实（需人工确认）；
 * 3. `possible_mismatch`：一级类目都不相交（需人工确认）；
 * 4. `unknown`：来源类目或样本事实不足，无法证明任何相关性。
 *
 * 硬约束：
 * - 只使用商品自身记录的 Amazon 类目与标题文本，不做语义推断；
 * - **不因为共享一级目录（如都用 Home & Kitchen）就认定细分类目匹配**；
 * - 类目只到一级、或样本没有类目/标题事实时，返回 `unknown` 或 `category_related`，
 *   宁可让用户确认，也不给出虚假的「范围匹配」。
 */
export function assessCategoryScope(input: {
  categoryLabel: string;
  sampleCategories: ReadonlyArray<string | null | undefined>;
  sampleTitles?: ReadonlyArray<string | null | undefined>;
  /**
   * 来源批次的**结构化类目路径**（如 "Home & Kitchen:Kitchen & Dining:Storage & Organization"）。
   * 只有这类事实才能支持 `range_matched`；标题命中率不能替代它。
   */
  sampleCategoryPaths?: ReadonlyArray<string | null | undefined>;
}): CategoryScopeAssessment {
  const evidenceTopCategory = topCategorySegment(input.categoryLabel);
  const titles = input.sampleTitles ?? [];
  const known = input.sampleCategories
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  if (!evidenceTopCategory) {
    return {
      level: "unknown",
      evidenceTopCategory: null,
      sampleCategoryTop: null,
      sampleCategoryMatchCount: 0,
      sampleCategoryTotal: known.length,
      segments: [],
      reason: "所选类目证据没有可用的类目名称，无法与本研究样本比对。",
    };
  }
  if (known.length === 0) {
    return {
      level: "unknown",
      evidenceTopCategory,
      sampleCategoryTop: null,
      sampleCategoryMatchCount: 0,
      sampleCategoryTotal: 0,
      segments: [],
      reason: "来源批次没有记录商品类目事实，系统无法证明该类别与本研究样本属于同一细分市场。",
    };
  }

  const counts = new Map<string, number>();
  const originalByKey = new Map<string, string>();
  for (const value of known) {
    const key = normalizeCategory(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!originalByKey.has(key)) originalByKey.set(key, value);
  }
  const [sampleCategoryKey] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]!;
  // 展示时保留来源原始大小写，不把 "Home & Kitchen" 显示成 "home & kitchen"。
  const sampleCategoryTop = originalByKey.get(sampleCategoryKey) ?? sampleCategoryKey;
  const target = normalizeCategory(evidenceTopCategory);
  const matchCount = [...counts.entries()]
    .filter(([category]) => category === target || category.includes(target) || target.includes(category))
    .reduce((sum, [, count]) => sum + count, 0);

  if (matchCount === 0) {
    return {
      level: "possible_mismatch",
      evidenceTopCategory,
      sampleCategoryTop,
      sampleCategoryMatchCount: 0,
      sampleCategoryTotal: known.length,
      segments: [],
      reason: `来源批次商品的 Amazon 类目（最多为「${sampleCategoryTop}」）与所选类目「${evidenceTopCategory}」没有交集，可能不是同一市场。`,
    };
  }

  // 一级类目相交：继续验证细分范围，不能停在「同属一个大类」。
  const lowerTitles = titles.map((value) => (typeof value === "string" ? value.toLowerCase() : ""));
  const sampleTotal = known.length;
  const segments: CategoryScopeSegment[] = categoryTailSegments(input.categoryLabel).map((segment) => {
    const keywords = segmentKeywords(segment);
    const matchedSampleCount = keywords.length === 0
      ? 0
      : lowerTitles.filter((title) => title.length > 0 && keywords.some((keyword) => title.includes(keyword))).length;
    return {
      segment,
      keywords,
      matchedSampleCount,
      sampleTotal,
      supported: sampleTotal > 0 && matchedSampleCount / sampleTotal >= SUB_SEGMENT_MATCH_THRESHOLD,
    };
  });

  if (segments.length === 0) {
    return {
      level: "category_related",
      evidenceTopCategory,
      sampleCategoryTop,
      sampleCategoryMatchCount: matchCount,
      sampleCategoryTotal: sampleTotal,
      segments,
      reason: `来源批次中有 ${matchCount}/${sampleTotal} 款商品属于「${evidenceTopCategory}」，与所选类目同属一级目录；但所选类目没有更细的层级，无法证实是否属于同一细分市场。`,
    };
  }

  const titleHitSegments = segments.filter((segment) => segment.supported);

  // 唯一能授予 `range_matched` 的条件：来源批次中存在结构化类目路径明确覆盖所选类目的每个非首段。
  if (supportsStructuredSubcategory(input.categoryLabel, input.sampleCategoryPaths ?? [])) {
    return {
      level: "range_matched",
      evidenceTopCategory,
      sampleCategoryTop,
      sampleCategoryMatchCount: matchCount,
      sampleCategoryTotal: sampleTotal,
      segments,
      reason: `来源批次中有 ${matchCount}/${sampleTotal} 款商品属于「${evidenceTopCategory}」，且有商品的结构化类目路径明确包含 ${segments
        .map((segment) => `「${segment.segment}」`)
        .join("、")}，细分范围有结构化类目证据支持。`,
    };
  }

  // 没有结构化细分证据：标题命中率只作为相关性提示，不能证明同一细分竞争市场。
  const titleHint = titleHitSegments.length > 0
    ? `标题命中 ${titleHitSegments.map((segment) => `「${segment.segment}」${segment.matchedSampleCount}/${sampleTotal}`).join("、")}，但标题词相同不代表属于同一细分市场，仅作相关性提示。`
    : "样本标题也未命中所选类目的细分级词。";
  return {
    level: "category_related",
    evidenceTopCategory,
    sampleCategoryTop,
    sampleCategoryMatchCount: matchCount,
    sampleCategoryTotal: sampleTotal,
    segments,
    reason: `来源批次中有 ${matchCount}/${sampleTotal} 款商品与所选类目同属「${evidenceTopCategory}」，但只有一级目录相交，且没有结构化细分类目证据；${titleHint}`,
  };
}

const METRIC_DEFINITIONS: ReadonlyArray<{
  key: keyof CategoryMarketCaptureBatch["rows"][number];
  label: string;
  unit: CategoryEvidenceMetric["unit"];
}> = [
  { key: "sampleProductCount", label: "样本商品数", unit: "count" },
  { key: "sampleBrandCount", label: "样本品牌数", unit: "count" },
  { key: "sampleSellerCount", label: "样本卖家数", unit: "count" },
  { key: "monthlyTotalSales", label: "月总销量（估算）", unit: "count" },
  { key: "topMonthlyAverageRevenueUsd", label: "头部月均销售额（估算）", unit: "currency" },
  { key: "averagePriceUsd", label: "平均售价", unit: "currency" },
  { key: "averageRating", label: "平均评分", unit: "rating" },
  { key: "averageReviewCount", label: "平均评论数", unit: "count" },
  { key: "productConcentrationPercent", label: "商品集中度", unit: "percent" },
  { key: "brandConcentrationPercent", label: "品牌集中度", unit: "percent" },
  { key: "newProductSharePercent", label: "新品占比", unit: "percent" },
];

function estimateValue(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (record.nature !== "provider_estimate") return null;
  return typeof record.value === "number" && Number.isFinite(record.value) ? record.value : null;
}

function segmentText(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  if (typeof record.value !== "string") return "";
  return record.value.replace(/\s+/gu, " ").trim();
}

function ageDaysOf(capturedAt: string, now: Date): number | null {
  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) return null;
  const diff = now.getTime() - captured.getTime();
  if (diff < 0) return null;
  return Math.floor(diff / 86_400_000);
}

function latestBatchOf(batches: readonly CategoryMarketCaptureBatch[] | undefined): CategoryMarketCaptureBatch | null {
  if (!batches || batches.length === 0) return null;
  const sorted = [...batches].sort((left, right) => {
    const byTime = left.capturedAt.localeCompare(right.capturedAt);
    return byTime !== 0 ? byTime : left.batchId.localeCompare(right.batchId);
  });
  return sorted[sorted.length - 1] ?? null;
}

function summaryOf(subjectKey: string, batch: CategoryMarketCaptureBatch): CategoryEvidenceSummary {
  return {
    subjectKey,
    nodeId: batch.category.nodeId,
    batchId: batch.batchId,
    label: batch.category.label,
    query: batch.query,
    marketplace: batch.marketplace,
    capturedAt: batch.capturedAt,
    rowCount: batch.rowCount,
    amazonConfirmed: false,
    providerProductCount: estimateValue(batch.category.productCount),
  };
}

function rowOf(input: CategoryMarketCaptureBatch["rows"][number]): CategoryEvidenceRow {
  const metrics: CategoryEvidenceMetric[] = [];
  for (const definition of METRIC_DEFINITIONS) {
    const raw = input[definition.key];
    const value = estimateValue(raw);
    if (value === null) continue;
    // 字段合同范围：百分比只能是 0–100；计数/金额/评分不允许负数。
    const anomaly: CategoryEvidenceMetric["anomaly"] = definition.unit === "percent" && (value < 0 || value > 100)
      ? "out_of_range_percent"
      : value < 0 ? "negative_value" : null;
    metrics.push({
      key: String(definition.key),
      label: definition.label,
      value,
      nature: "provider_estimate",
      unit: definition.unit,
      usableForMetrics: anomaly === null,
      anomaly,
    });
  }
  return {
    segment: segmentText(input.segment),
    metrics,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter((item): item is string => typeof item === "string") : [],
  };
}

/**
 * 读取单个类目主体的最新批次详情。
 * 主体非法 / 站点不符 / 无快照 / 批次损坏 → null（fail-closed）。
 */
export async function readCategoryEvidenceDetail(
  subjectKey: string,
  options: { marketplace?: string; now?: Date } = {},
): Promise<CategoryEvidenceDetail | null> {
  if (!isCategoryMarketSubjectKey(subjectKey)) return null;
  const marketplace = (options.marketplace ?? "US").toUpperCase();
  if (marketplace !== "US") return null;

  const store = createEvidenceStore("owner:v1");
  const record = await store.getSubject(subjectKey);
  if (!record) return null;
  if (record.marketplace !== marketplace) return null;

  const batch = latestBatchOf(record.marketCaptures);
  if (!batch) return null;
  try {
    assertCategoryMarketCaptureBatch(batch);
  } catch {
    return null;
  }

  const summary = summaryOf(subjectKey, batch);
  const rows = batch.rows.map(rowOf);
  return {
    ...summary,
    sourceUrl: batch.sourceUrl,
    sourceProvider: batch.provider,
    rows,
    ageDays: ageDaysOf(batch.capturedAt, options.now ?? new Date()),
    observedHeaders: Array.isArray(batch.observedHeaders) && batch.observedHeaders.length > 0 ? batch.observedHeaders : null,
    hasAnomalousMetrics: rows.some((row) => row.metrics.some((metric) => !metric.usableForMetrics)),
  };
}

/** 枚举本 EvidenceStore 中所有可用的类目市场证据摘要（按采集时间倒序）。 */
export async function listCategoryEvidenceSummaries(
  options: { marketplace?: string } = {},
): Promise<CategoryEvidenceSummary[]> {
  const marketplace = (options.marketplace ?? "US").toUpperCase();
  if (marketplace !== "US") return [];

  const store = createEvidenceStore("owner:v1");
  if (!store.listCategoryMarketSubjects) return [];
  const subjects = await store.listCategoryMarketSubjects();

  const summaries: CategoryEvidenceSummary[] = [];
  for (const subject of subjects) {
    const record = await store.getSubject(subject.subjectKey);
    if (!record || record.marketplace !== marketplace) continue;
    const batch = latestBatchOf(record.marketCaptures);
    if (!batch) continue;
    try {
      assertCategoryMarketCaptureBatch(batch);
    } catch {
      continue;
    }
    summaries.push(summaryOf(subject.subjectKey, batch));
  }
  return summaries.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}

/** 从 MarketScan 的 nicheDefinition 解析显式绑定（只接受合法类目主体键）。 */
export function readCategoryEvidenceBinding(nicheDefinition: unknown): string | null {
  if (typeof nicheDefinition !== "object" || nicheDefinition === null) return null;
  const parameters = (nicheDefinition as Record<string, unknown>).parameters;
  if (typeof parameters !== "object" || parameters === null) return null;
  const value = (parameters as Record<string, unknown>)[CATEGORY_EVIDENCE_BINDING_PARAM];
  return typeof value === "string" && isCategoryMarketSubjectKey(value) ? value : null;
}

/**
 * 组装 02 市场研究需要的类目证据视图。
 * 未绑定时只返回可绑定列表；绑定了但证据不可读时返回 `linked_evidence_missing`，绝不自动改绑。
 */
export async function buildCategoryEvidenceView(input: {
  nicheDefinition: unknown;
  marketplace: string;
  now?: Date;
  /** 来源批次的商品类目与标题事实（可为空）；用于评估类目证据与本研究是否可能相关。 */
  sampleCategories?: ReadonlyArray<string | null>;
  sampleTitles?: ReadonlyArray<string | null>;
  /** 来源批次的结构化类目路径（可为空）；只有它能支持 `range_matched`。 */
  sampleCategoryPaths?: ReadonlyArray<string | null>;
}): Promise<CategoryEvidenceView> {
  const binding = readCategoryEvidenceBinding(input.nicheDefinition);
  const available = await listCategoryEvidenceSummaries({ marketplace: input.marketplace });
  const sampleCategories = input.sampleCategories ?? [];
  const sampleTitles = input.sampleTitles ?? [];
  const sampleCategoryPaths = input.sampleCategoryPaths ?? [];

  const availableScopeAssessments: Record<string, CategoryScopeAssessment> = {};
  for (const summary of available) {
    availableScopeAssessments[summary.subjectKey] = assessCategoryScope({
      categoryLabel: summary.label,
      sampleCategories,
      sampleTitles,
      sampleCategoryPaths,
    });
  }

  if (!binding) {
    return {
      linked: null,
      available,
      status: available.length > 0 ? "not_linked" : "no_evidence",
      notice: available.length > 0
        ? "当前研究尚未绑定类目市场证据。类目指标是第三方估算，只有显式绑定后才会在此展示，且不参与本页的样本统计。"
        : "证据库中暂无类目市场采集结果。可在 01 市场采集 → 类目市场 采集类目指标后再回到这里绑定。",
      scopeAssessment: null,
      availableScopeAssessments,
    };
  }

  const linked = await readCategoryEvidenceDetail(binding, { marketplace: input.marketplace, now: input.now });
  if (!linked) {
    return {
      linked: null,
      available,
      status: "linked_evidence_missing",
      notice: "已绑定的类目市场证据当前不可读取（可能已被归档或主体不匹配）。系统不会自动改绑，请重新选择。",
      scopeAssessment: null,
      availableScopeAssessments,
    };
  }

  return {
    linked,
    available,
    status: "linked",
    notice: "类目指标来自 SellerSprite 第三方估算，不是 Amazon 确认事实，也不参与本页样本指标计算。",
    scopeAssessment: assessCategoryScope({ categoryLabel: linked.label, sampleCategories, sampleTitles, sampleCategoryPaths }),
    availableScopeAssessments,
  };
}
