/**
 * 探索台（Research Cockpit）只读数据投影。
 *
 * 原则：
 * - 只从已保存的 scan / intelligence 事实派生，不推断、不补 0、不编造指标；
 * - 缺失保持 null，UI 负责展示「未知」而不是 0；
 * - 价格分带只描述当前锁定样本，不代表全市场；
 * - AI 研报按 inputHash 判定是否已过期，过期仍可追溯但不作为当前结论。
 */
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import type { ScanReadModel } from "../researchPresentation";
import { uniqueReviewProducts } from "../researchPresentation";
import type { Screen } from "../data";

export type CockpitTone = "green" | "blue" | "violet" | "amber" | "risk";

export type PriceBandView = {
  id: string;
  /** 坐标轴短标签，例如 "$10–15"。 */
  axisLabel: string;
  /** 精确区间标签，同时用于 02 市场竞争的价格带筛选（"$a–b" 可被 inBand 解析）。 */
  rangeLabel: string;
  /** 传给 02 的筛选值；空带或开区间不可传递时为 null。 */
  filterLabel: string | null;
  min: number;
  max: number | null;
  count: number;
  share: number;
  observedMin: number | null;
  observedMax: number | null;
  tone: CockpitTone;
  asins: string[];
};

export type PriceStructure = {
  currency: string;
  sampleCount: number;
  pricedCount: number;
  unpricedCount: number;
  median: number | null;
  min: number | null;
  max: number | null;
  bands: PriceBandView[];
};

const BAND_DEFS: Array<{ id: string; tone: CockpitTone; min: number; max: number | null; axisLabel: string }> = [
  { id: "entry", tone: "green", min: 0, max: 10, axisLabel: "$0–10" },
  { id: "core", tone: "blue", min: 10, max: 15, axisLabel: "$10–15" },
  { id: "upper", tone: "violet", min: 15, max: 20, axisLabel: "$15–20" },
  { id: "premium", tone: "amber", min: 20, max: null, axisLabel: "$20+" },
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function money(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}

export function buildPriceStructure(scan: ScanReadModel | null): PriceStructure {
  const items = scan?.sampleItems ?? [];
  const priced = items.filter((item) => typeof item.price === "number" && Number.isFinite(item.price));
  const prices = priced.map((item) => item.price as number);
  const currency = priced.find((item) => item.priceCurrency)?.priceCurrency || "USD";
  const observedMax = prices.length ? Math.max(...prices) : null;

  const bands = BAND_DEFS.map((def) => {
    const inBand = priced.filter((item) => {
      const price = item.price as number;
      return price >= def.min && (def.max == null ? true : price < def.max);
    });
    const bandPrices = inBand.map((item) => item.price as number);
    const upper = def.max == null ? observedMax : def.max - 0.01;
    const rangeLabel = upper == null
      ? `$${def.min.toFixed(2)}+`
      : `$${money(def.min)}–${money(upper)}`;
    const closed = upper != null;
    return {
      id: def.id,
      axisLabel: def.axisLabel,
      rangeLabel,
      filterLabel: closed && inBand.length ? rangeLabel : null,
      min: def.min,
      max: def.max,
      count: inBand.length,
      share: priced.length ? inBand.length / priced.length : 0,
      observedMin: bandPrices.length ? Math.min(...bandPrices) : null,
      observedMax: bandPrices.length ? Math.max(...bandPrices) : null,
      tone: def.tone,
      asins: inBand.map((item) => item.asin),
    } satisfies PriceBandView;
  });

  return {
    currency,
    sampleCount: items.length,
    pricedCount: priced.length,
    unpricedCount: items.length - priced.length,
    median: medianOf(prices),
    min: prices.length ? Math.min(...prices) : null,
    max: observedMax,
    bands,
  };
}

export type ReviewConflict = {
  asin: string;
  subjectKey: string;
  lockedValue: number | null;
  lockedSurface: string | null;
  lockedCapturedAt: string | null;
  productPageValue: number | null;
  productPageCapturedAt: string | null;
};

export type EvidenceModel = {
  reviewsRead: number | null;
  asinCovered: number | null;
  sampleCount: number;
  coverageRatio: number | null;
  conflictCount: number | null;
  verifiedCount: number | null;
  unverifiedCount: number | null;
  lockedCount: number | null;
  conflicts: ReviewConflict[];
  missing: Array<{ code: string; label: string; detail: string }>;
  blockedReasons: Array<{ code: string; label: string; detail: string }>;
  statisticsReady: boolean;
};

export function buildEvidenceModel(scan: ScanReadModel | null, intelligence: MarketIntelligence | null): EvidenceModel {
  const sampleCount = scan?.sampleCount ?? scan?.sampleItems.length ?? 0;
  const covered = intelligence ? uniqueReviewProducts(intelligence) : null;
  const caliber = intelligence?.statistics?.reviewCount;
  const conflicts: ReviewConflict[] = (caliber?.conflicts ?? []).map((item) => ({
    asin: item.asin,
    subjectKey: item.subjectKey,
    lockedValue: item.lockedValue ?? null,
    lockedSurface: item.lockedSurface ?? null,
    lockedCapturedAt: item.lockedCapturedAt ?? null,
    productPageValue: item.productPageValue ?? null,
    productPageCapturedAt: item.productPageCapturedAt ?? null,
  }));
  const conflictCount = typeof caliber?.conflictCount === "number"
    ? caliber.conflictCount
    : intelligence
      ? conflicts.length
      : null;

  return {
    reviewsRead: intelligence ? intelligence.reviews.length : null,
    asinCovered: covered,
    sampleCount,
    coverageRatio: covered != null && sampleCount > 0 ? covered / sampleCount : null,
    conflictCount,
    verifiedCount: caliber?.verifiedCount ?? null,
    unverifiedCount: caliber?.unverifiedCount ?? null,
    lockedCount: caliber?.lockedCount ?? null,
    conflicts,
    missing: scan?.decisionReadiness?.acknowledgeableMissing ?? [],
    blockedReasons: scan?.decisionReadiness?.blockers ?? [],
    statisticsReady: Boolean(intelligence?.statistics),
  };
}

export type InsightStatus = "ready" | "stale" | "missing" | "unavailable";

export type InsightItem = {
  id: string;
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  lists: Array<{ label: string; items: string[] }>;
  citations: string[];
  relatedSubjects: Array<{ subjectKey: string; role: string | null; rationale: string | null }>;
};

export type InsightModel = {
  status: InsightStatus;
  statusLabel: string;
  statusDetail: string;
  generatedAt: string | null;
  model: string | null;
  providerReady: boolean;
  judgment: { text: string; canJudge: string; cannotJudge: string } | null;
  decision: { status: string; reason: string } | null;
  opportunities: InsightItem[];
  risks: InsightItem[];
  actions: InsightItem[];
  voiceThemeCount: number | null;
};

const DECISION_LABEL: Record<string, string> = {
  recommend: "建议继续研究",
  insufficient: "证据不足，暂不建议",
  do_not_continue: "建议停止本次研究",
};

export function buildInsightModel(intelligence: MarketIntelligence | null): InsightModel {
  const providerReady = Boolean(intelligence?.provider.ready);
  const base: InsightModel = {
    status: "unavailable",
    statusLabel: "暂无可读证据",
    statusDetail: "尚未读取到当前研究的证据材料，不能生成或展示机会与风险。",
    generatedAt: null,
    model: null,
    providerReady,
    judgment: null,
    decision: null,
    opportunities: [],
    risks: [],
    actions: [],
    voiceThemeCount: null,
  };
  if (!intelligence) return base;

  const reports = [...intelligence.reports].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const report = reports[0] ?? null;
  if (!report) {
    return {
      ...base,
      status: "missing",
      statusLabel: "尚未生成 AI 研报",
      statusDetail: providerReady
        ? "当前证据已可读，但还没有保存过研报。可进入 02 市场研究生成；未生成前不展示任何机会或风险结论。"
        : "当前证据已可读，AI 服务未配置有效凭据，无法生成研报；未生成前不展示任何机会或风险结论。",
    };
  }

  const stale = report.inputHash !== intelligence.inputHash;
  const recByOpportunity = new Map<string, Array<{ subjectKey: string; role: string | null; rationale: string | null }>>();
  for (const rec of report.researchRecommendations ?? []) {
    for (const opportunityId of rec.opportunityIds ?? []) {
      const list = recByOpportunity.get(opportunityId) ?? [];
      list.push({ subjectKey: rec.subjectKey, role: rec.role ?? null, rationale: rec.rationale ?? null });
      recByOpportunity.set(opportunityId, list);
    }
  }

  const opportunities: InsightItem[] = (report.productOpportunities ?? []).map((item, index) => {
    const id = item.id ?? `opportunity-${index}`;
    return {
      id,
      title: item.title,
      summary: item.hypothesis || item.buyerProblem,
      fields: [
        { label: "买家问题", value: item.buyerProblem },
        { label: "使用场景", value: item.scenario },
        { label: "改进假设", value: item.hypothesis },
      ].filter((field) => Boolean(field.value)),
      lists: [
        { label: "尚未验证", items: item.unverified ?? [] },
        { label: "相反证据", items: item.counterEvidence ?? [] },
        { label: "否定条件", items: item.rejectionConditions ?? [] },
        { label: "开发约束", items: item.developmentConstraints ?? [] },
      ].filter((list) => list.items.length > 0),
      citations: item.citations ?? [],
      relatedSubjects: recByOpportunity.get(id) ?? [],
    };
  });

  const risks: InsightItem[] = (report.riskGaps ?? []).map((item, index) => ({
    id: `risk-${index}`,
    title: item.title,
    summary: item.text,
    fields: [
      { label: "证据缺口", value: item.gap },
      { label: "影响", value: item.impact },
    ].filter((field) => Boolean(field.value)),
    lists: [],
    citations: item.citations ?? [],
    relatedSubjects: [],
  }));

  const actions: InsightItem[] = (report.nextActions ?? []).map((item, index) => ({
    id: `action-${index}`,
    title: item.question,
    summary: item.howToVerify,
    fields: [
      { label: "需要的证据", value: item.neededEvidence },
      { label: "验证方式", value: item.howToVerify },
      { label: "完成标准", value: item.doneWhen },
    ].filter((field) => Boolean(field.value)),
    lists: [],
    citations: item.citations ?? [],
    relatedSubjects: [],
  }));

  const hasContent = opportunities.length + risks.length + actions.length > 0;
  const status: InsightStatus = !hasContent ? "missing" : stale ? "stale" : "ready";
  const generated = report.generatedAt?.slice(0, 10) ?? null;

  return {
    status,
    statusLabel: !hasContent
      ? "研报未包含结构化结论"
      : stale
        ? "历史研报 · 输入已变化"
        : "当前有效研报",
    statusDetail: !hasContent
      ? "已保存的研报没有可展开的机会/风险条目，不补写结论。"
      : stale
        ? `证据在 ${generated ?? "未知日期"} 之后发生变化，研报未重新生成；以下内容仅作追溯与待验证线索，不代表当前判断。`
        : `与当前证据输入一致（${generated ?? "日期未知"}）。AI 提议仍需人工复核。`,
    generatedAt: report.generatedAt ?? null,
    model: report.model ?? null,
    providerReady,
    judgment: report.judgment
      ? { text: report.judgment.text, canJudge: report.judgment.canJudge, cannotJudge: report.judgment.cannotJudge }
      : null,
    decision: report.recommendationDecision
      ? {
          status: DECISION_LABEL[report.recommendationDecision.status] ?? report.recommendationDecision.status,
          reason: report.recommendationDecision.reason,
        }
      : null,
    opportunities,
    risks,
    actions,
    voiceThemeCount: report.voiceThemes?.length ?? null,
  };
}

export type CockpitActionTarget =
  | { kind: "screen"; screen: Screen }
  | { kind: "href"; href: string }
  | { kind: "drawer"; drawer: "conflicts" | "missing" | "coverage" }
  | { kind: "blocked" };

export type CockpitAction = {
  id: string;
  title: string;
  detail: string;
  tone: CockpitTone;
  cta: string;
  target: CockpitActionTarget;
  blockedReason: string | null;
};

export function buildActions(input: {
  scan: ScanReadModel | null;
  evidence: EvidenceModel;
  insight: InsightModel;
  gateStale: boolean;
  gateStatus: string;
}): CockpitAction[] {
  const { scan, evidence, insight, gateStale, gateStatus } = input;
  const actions: CockpitAction[] = [];

  if (!scan) return actions;

  if (gateStale || gateStatus === "PENDING") {
    actions.push({
      id: "gate",
      title: "重新确认市场判断",
      detail: gateStale
        ? "来源变化后历史判断已失效，需要人工重新确认后 03 才可用。"
        : "当前没有有效的人工市场判断，先核对证据再记录决定。",
      tone: "risk",
      cta: "打开市场闸门",
      target: { kind: "screen", screen: "gate" },
      blockedReason: null,
    });
  }

  if ((evidence.conflictCount ?? 0) > 0) {
    actions.push({
      id: "conflicts",
      title: `处理评价数来源冲突（${evidence.conflictCount} 件）`,
      detail: "搜索页与商品页读数不一致；冲突未解决前不用于竞争强度或新旧判断。",
      tone: "amber",
      cta: "查看冲突读数",
      target: { kind: "drawer", drawer: "conflicts" },
      blockedReason: null,
    });
  }

  if (evidence.missing.length > 0) {
    actions.push({
      id: "missing",
      title: `确认证据缺口（${evidence.missing.length} 类）`,
      detail: evidence.missing.map((item) => item.label).join(" · "),
      tone: "violet",
      cta: "查看缺口与影响",
      target: { kind: "drawer", drawer: "missing" },
      blockedReason: null,
    });
  }

  if (evidence.coverageRatio != null && evidence.coverageRatio < 1) {
    actions.push({
      id: "coverage",
      title: `核对评论证据覆盖（${evidence.asinCovered}/${evidence.sampleCount} ASIN）`,
      detail: "未被评论覆盖的样本不能凭星级推断体验，需回到原声逐条核对。",
      tone: "blue",
      cta: "查看覆盖明细",
      target: { kind: "drawer", drawer: "coverage" },
      blockedReason: null,
    });
  }

  if (insight.status === "stale") {
    actions.push({
      id: "insight",
      title: "重新生成市场研报",
      detail: "证据输入已变化，历史研报仅作追溯；重新生成后才能作为当前线索。",
      tone: "blue",
      cta: "进入研究总览",
      target: { kind: "screen", screen: "overview" },
      blockedReason: null,
    });
  }

  const proceedBlocked = gateStale || gateStatus !== "PROCEED" || !scan.handoffEligible;
  actions.push({
    id: "handoff",
    title: "进入 03 商品深研",
    detail: proceedBlocked
      ? "需要有效的「继续研究」闸门、已保存代表商品角色与理由，并通过交接检查。"
      : "闸门与代表商品已满足，可进入商品深研继续验证。",
    tone: "green",
    cta: proceedBlocked ? "条件未满足" : "进入商品深研",
    target: proceedBlocked ? { kind: "blocked" } : { kind: "href", href: "/research" },
    blockedReason: proceedBlocked
      ? gateStale
        ? "市场判断已失效，需重新确认"
        : gateStatus !== "PROCEED"
          ? "当前闸门不是「继续研究」"
          : "交接条件未满足"
      : null,
  });

  return actions;
}
