import { enforceSpecEvidenceRules } from "./specEvidence";

export const PRODUCT_BRIEF_SCHEMA = "product-brief.v1" as const;
export const PRODUCT_BRIEF_MAX_BENCHMARKS = 3 as const;
export const PRODUCT_BRIEF_STATUSES = ["DRAFT", "READY", "APPROVED"] as const;
export type ProductBriefStatus = (typeof PRODUCT_BRIEF_STATUSES)[number];

export type ProductBriefEvidenceLine = {
  readonly text: string;
  readonly nature: "FACT" | "EVIDENCE_DERIVED" | "ASSUMPTION";
  readonly evidenceRefs: readonly string[];
};

export type ProductBriefBenchmark = {
  readonly asin: string;
  readonly title: string | null;
  readonly imageUrl: string | null;
  readonly marketplace: string;
  readonly role: "benchmark" | "newcomer" | "pain_point" | "fast_track";
  readonly marketSampleKey: string | null;
  readonly evidenceRefs: readonly string[];
};

export type PurchaseCostCeiling = {
  readonly status: "COMPUTED" | "NOT_COMPUTABLE";
  readonly value: number | null;
  readonly currency: string | null;
  readonly formula: string;
  readonly reason: string | null;
};

/**
 * 经济性输入的来源性质。数值本身仍可为空；该段只说明“这个数为什么出现”，
 * 不把 Research 估算或商品事实升级为人工确认的开发目标。
 */
export type ProductBriefEconomicOrigin = "PRODUCT_FACT" | "USER_INPUT" | "RESEARCH_ESTIMATE" | "MISSING";

export type ProductBriefEconomicProvenance = {
  readonly origin: ProductBriefEconomicOrigin;
  readonly source: string | null;
  readonly note: string | null;
};

export type ProductBriefEconomicsProvenance = Partial<Record<
  "targetPrice" | "targetMarginPct" | "referralFee" | "fbaFee" | "logistics" | "estimatedTax" | "otherKnownCosts",
  ProductBriefEconomicProvenance
>>;

/** P0-BR-A1 规格章节实体行：无证据引用的行不得保持 FACT（契约层强制降级 ASSUMPTION）。 */
export type ProductBriefSpecRow = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly nature: "FACT" | "ASSUMPTION" | "EVIDENCE_DERIVED";
  readonly verification: "unverified" | "verified" | "not_applicable";
  readonly evidenceRefs: readonly string[];
};

/**
 * P0-BR（追加修正后）：产品开发确认事项。
 * AI 只负责提出「需要确认什么」（供应商沟通/开发验证/待确认信息），
 * 不生成任何供应链事实：不填 MOQ 数值、打样周期、报价或生产能力。
 * 形如 { item, status: "待确认", reason }——答案永远由人工/供应商给出。
 */
export type ProductBriefConfirmationItem = {
  readonly id: string;
  readonly item: string;
  readonly status: "待确认" | "已确认" | "不适用";
  readonly reason: string | null;
};

/** P0-BR-A4 竞品-本品对照行；theirs 允许为空（未采集，诚实展示）。 */
export type ProductBriefComparisonRow = {
  readonly id: string;
  readonly label: string;
  readonly ours: string | null;
  readonly theirs: string | null;
  readonly nature: "FACT" | "ASSUMPTION";
  readonly note: string | null;
};

export type ProductBriefBenchmarkComparison = {
  readonly rows: readonly ProductBriefComparisonRow[];
};

/** P0-BR-A5 验证计划：由 missingValidation 生成，人工补充方法与时点。 */
export type ProductBriefVerificationItem = {
  readonly id: string;
  readonly item: string;
  readonly method: string;
  readonly timing: string;
  readonly status: "pending" | "done" | "dropped";
};

export type ProductBrief = {
  /** Read projection only; never persisted or included in the source/report hash. */
  readonly claimAudit?: import("@/lib/research/evidenceAudit").ResearchClaimAudit | null;
  readonly schemaVersion: typeof PRODUCT_BRIEF_SCHEMA;
  readonly status: ProductBriefStatus;
  readonly revision: number;
  readonly generatedAt: string;
  readonly sourceBinding: {
    readonly taskId: string;
    readonly researchRevision: number;
    readonly reportHash: string;
    readonly factHash: string;
    readonly evidenceHash: string;
    readonly marketScanId: string | null;
    readonly marketSampleHash: string | null;
  };
  readonly identity: {
    readonly asin: string;
    readonly title: string | null;
    readonly imageUrl: string | null;
    readonly brand: string | null;
    readonly category: string | null;
    readonly marketplace: string;
  };
  readonly projectOverview: ProductBriefEvidenceLine | null;
  readonly targetUser: ProductBriefEvidenceLine | null;
  readonly corePainPoints: readonly ProductBriefEvidenceLine[];
  readonly benchmarks: readonly ProductBriefBenchmark[];
  readonly differentiation: readonly ProductBriefEvidenceLine[];
  readonly economics: {
    readonly targetPrice: number | null;
    readonly targetMarginPct: number | null;
    readonly referralFee: number | null;
    readonly fbaFee: number | null;
    readonly logistics: number | null;
    readonly estimatedTax: number | null;
    readonly otherKnownCosts: number | null;
    readonly currency: string;
    readonly purchaseCostCeiling: PurchaseCostCeiling;
    /** 旧 Brief 缺省；新生成/保存的 Brief 显式保留每个输入的来源性质。 */
    readonly provenance?: ProductBriefEconomicsProvenance;
  };
  readonly specsDirection: readonly ProductBriefEvidenceLine[];
  readonly vocQaRedlines: readonly ProductBriefEvidenceLine[];
  readonly risks: readonly ProductBriefEvidenceLine[];
  readonly rationale: readonly ProductBriefEvidenceLine[];
  readonly missingValidation: readonly string[];
  // P0-BR-A1/A4/A5 + 修正后确认事项：全部 optional，旧快照读取时缺省
  readonly specifications?: readonly ProductBriefSpecRow[];
  readonly confirmationItems?: readonly ProductBriefConfirmationItem[];
  readonly benchmarkComparison?: ProductBriefBenchmarkComparison;
  readonly verificationPlan?: readonly ProductBriefVerificationItem[];
  // P0-BR-BR02：产品定位（研报搬运或人工填写；显式 null = 尚无定位，待人工填）；用户场景（VOC useCases 纯读取）
  readonly positioning?: ProductBriefEvidenceLine | null;
  readonly userScenarios?: readonly ProductBriefEvidenceLine[];
  // P1-VOC/BR-03：VOC 转需求（由 recurring 痛点主题派生，每条带 evidenceRefs；与 lib/research/vocImprovement 同源）
  readonly vocRequirements?: readonly ProductBriefEvidenceLine[];
  // P3-01-B：新版 ResearchReport 的结构化继承。它们是研究来源投影，
  // 不等同于人工确认的开发要求；无引用的文本在 Research 层已被分流为假设。
  readonly competitiveHypotheses?: readonly ProductBriefEvidenceLine[];
  readonly researchAlternatives?: readonly ProductBriefEvidenceLine[];
  readonly supportingEvidence?: readonly ProductBriefEvidenceLine[];
  readonly counterevidence?: readonly ProductBriefEvidenceLine[];
  readonly researchAssumptions?: readonly ProductBriefEvidenceLine[];
  readonly causalInvestigations?: readonly {
    readonly hypothesis: ProductBriefEvidenceLine;
    /** P2-02：为什么提出该原因（触发观察），与原因本身分开。 */
    readonly rationale?: ProductBriefEvidenceLine;
    readonly supportingEvidence: readonly ProductBriefEvidenceLine[];
    readonly counterevidence: readonly ProductBriefEvidenceLine[];
    readonly unknowns: readonly string[];
    readonly confidence: "low" | "medium" | "high" | "unknown";
    readonly verification: readonly string[];
  }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function line(value: unknown): ProductBriefEvidenceLine | null {
  if (!isRecord(value)) return null;
  const content = text(value.text);
  if (!content) return null;
  const nature = value.nature === "FACT" || value.nature === "ASSUMPTION" ? value.nature : "EVIDENCE_DERIVED";
  const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20) : [];
  return { text: content.slice(0, 2_000), nature: evidenceRefs.length ? nature : "ASSUMPTION", evidenceRefs };
}

function lines(value: unknown): ProductBriefEvidenceLine[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const parsed = line(item);
    return parsed ? [parsed] : [];
  }).slice(0, 80) : [];
}

function refs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20) : [];
}

const ECONOMIC_ORIGINS: readonly ProductBriefEconomicOrigin[] = ["PRODUCT_FACT", "USER_INPUT", "RESEARCH_ESTIMATE", "MISSING"];

function economicProvenance(value: unknown): ProductBriefEconomicsProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["targetPrice", "targetMarginPct", "referralFee", "fbaFee", "logistics", "estimatedTax", "otherKnownCosts"] as const;
  const parsed: ProductBriefEconomicsProvenance = {};
  for (const key of keys) {
    const raw = value[key];
    if (!isRecord(raw)) continue;
    const origin = ECONOMIC_ORIGINS.includes(raw.origin as ProductBriefEconomicOrigin)
      ? raw.origin as ProductBriefEconomicOrigin
      : "MISSING";
    parsed[key] = {
      origin,
      source: text(raw.source)?.slice(0, 160) ?? null,
      note: text(raw.note)?.slice(0, 300) ?? null,
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function specRow(value: unknown): ProductBriefSpecRow | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const label = text(value.label);
  const content = text(value.value);
  if (!id || !label || !content) return null;
  const evidenceRefs = refs(value.evidenceRefs);
  const rawNature = value.nature === "FACT" || value.nature === "ASSUMPTION" ? value.nature : "EVIDENCE_DERIVED";
  const rawVerification = value.verification === "verified" || value.verification === "not_applicable" ? value.verification : "unverified";
  return enforceSpecEvidenceRules({ id: id.slice(0, 64), label: label.slice(0, 120), value: content.slice(0, 300), unit: text(value.unit)?.slice(0, 32) ?? null, nature: rawNature, verification: rawVerification, evidenceRefs });
}

function specRows(value: unknown): ProductBriefSpecRow[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const parsed = specRow(item);
    return parsed ? [parsed] : [];
  }).slice(0, 60) : [];
}

function confirmationItem(value: unknown): ProductBriefConfirmationItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const item = text(value.item);
  if (!id || !item) return null;
  const status = value.status === "已确认" || value.status === "不适用" ? value.status : "待确认";
  return { id: id.slice(0, 64), item: item.slice(0, 300), status, reason: text(value.reason)?.slice(0, 300) ?? null };
}

function confirmationItems(value: unknown): ProductBriefConfirmationItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => {
    const parsed = confirmationItem(entry);
    return parsed ? [parsed] : [];
  }).slice(0, 60);
  return items;
}

function comparisonRow(value: unknown): ProductBriefComparisonRow | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const label = text(value.label);
  if (!id || !label) return null;
  return {
    id: id.slice(0, 64),
    label: label.slice(0, 120),
    ours: text(value.ours)?.slice(0, 300) ?? null,
    theirs: text(value.theirs)?.slice(0, 300) ?? null,
    // 对照行没有逐字段来源绑定，任何行都不能作为确认事实读取。
    nature: "ASSUMPTION",
    note: text(value.note)?.slice(0, 300) ?? null,
  };
}

function benchmarkComparison(value: unknown): ProductBriefBenchmarkComparison | undefined {
  if (!isRecord(value)) return undefined;
  const rows = Array.isArray(value.rows) ? value.rows.flatMap((item) => {
    const parsed = comparisonRow(item);
    return parsed ? [parsed] : [];
  }).slice(0, 40) : [];
  return { rows };
}

function verificationItem(value: unknown): ProductBriefVerificationItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const item = text(value.item);
  if (!id || !item) return null;
  const status = value.status === "done" || value.status === "dropped" ? value.status : "pending";
  return { id: id.slice(0, 64), item: item.slice(0, 500), method: text(value.method)?.slice(0, 300) ?? "", timing: text(value.timing)?.slice(0, 300) ?? "", status };
}

function verificationPlan(value: unknown): ProductBriefVerificationItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => {
    const parsed = verificationItem(entry);
    return parsed ? [parsed] : [];
  }).slice(0, 80);
  return items;
}

export function parseProductBrief(value: unknown): ProductBrief | null {
  if (!isRecord(value) || value.schemaVersion !== PRODUCT_BRIEF_SCHEMA) return null;
  const sourceBinding = isRecord(value.sourceBinding) ? value.sourceBinding : null;
  const identity = isRecord(value.identity) ? value.identity : null;
  const economics = isRecord(value.economics) ? value.economics : null;
  const ceiling = economics && isRecord(economics.purchaseCostCeiling) ? economics.purchaseCostCeiling : null;
  const status = PRODUCT_BRIEF_STATUSES.includes(value.status as ProductBriefStatus) ? value.status as ProductBriefStatus : "DRAFT";
  if (!sourceBinding || !identity || !economics || !ceiling) return null;
  const taskId = text(sourceBinding.taskId);
  const asin = text(identity.asin)?.toUpperCase();
  if (!taskId || !asin) return null;
  return {
    schemaVersion: PRODUCT_BRIEF_SCHEMA,
    status,
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : 0,
    generatedAt: text(value.generatedAt) ?? new Date(0).toISOString(),
    sourceBinding: {
      taskId,
      researchRevision: Number.isSafeInteger(sourceBinding.researchRevision) ? Number(sourceBinding.researchRevision) : 0,
      reportHash: text(sourceBinding.reportHash) ?? "",
      factHash: text(sourceBinding.factHash) ?? "",
      evidenceHash: text(sourceBinding.evidenceHash) ?? "",
      marketScanId: text(sourceBinding.marketScanId),
      marketSampleHash: text(sourceBinding.marketSampleHash),
    },
    identity: {
      asin,
      title: text(identity.title),
      imageUrl: text(identity.imageUrl),
      brand: text(identity.brand),
      category: text(identity.category),
      marketplace: text(identity.marketplace)?.toUpperCase() ?? "US",
    },
    projectOverview: line(value.projectOverview),
    targetUser: line(value.targetUser),
    corePainPoints: lines(value.corePainPoints),
    benchmarks: Array.isArray(value.benchmarks) ? value.benchmarks.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const benchmarkAsin = text(raw.asin)?.toUpperCase();
      if (!benchmarkAsin) return [];
      const role = raw.role === "newcomer" || raw.role === "pain_point" || raw.role === "fast_track" ? raw.role : "benchmark";
      return [{ asin: benchmarkAsin, title: text(raw.title), imageUrl: text(raw.imageUrl), marketplace: text(raw.marketplace)?.toUpperCase() ?? "US", role, marketSampleKey: text(raw.marketSampleKey), evidenceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.filter((item): item is string => typeof item === "string").slice(0, 20) : [] } satisfies ProductBriefBenchmark];
     }).slice(0, PRODUCT_BRIEF_MAX_BENCHMARKS) : [],
    differentiation: lines(value.differentiation),
    economics: {
      targetPrice: finite(economics.targetPrice),
      targetMarginPct: finite(economics.targetMarginPct),
      referralFee: finite(economics.referralFee),
      fbaFee: finite(economics.fbaFee),
      logistics: finite(economics.logistics),
      estimatedTax: finite(economics.estimatedTax),
      otherKnownCosts: finite(economics.otherKnownCosts),
      currency: text(economics.currency)?.toUpperCase() ?? "USD",
      ...(economicProvenance(economics.provenance) ? { provenance: economicProvenance(economics.provenance) } : {}),
      purchaseCostCeiling: {
        status: ceiling.status === "COMPUTED" ? "COMPUTED" : "NOT_COMPUTABLE",
        value: finite(ceiling.value),
        currency: text(ceiling.currency),
        formula: text(ceiling.formula) ?? "目标售价 - 已知费用 - 目标利润",
        reason: text(ceiling.reason),
      },
    },
    specsDirection: lines(value.specsDirection),
    vocQaRedlines: lines(value.vocQaRedlines),
    risks: lines(value.risks),
    rationale: lines(value.rationale),
    missingValidation: Array.isArray(value.missingValidation) ? value.missingValidation.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 500)).slice(0, 80) : [],
    ...(value.specifications !== undefined ? { specifications: specRows(value.specifications) } : {}),
    ...(value.confirmationItems !== undefined ? { confirmationItems: confirmationItems(value.confirmationItems) } : {}),
    ...(value.benchmarkComparison !== undefined ? { benchmarkComparison: benchmarkComparison(value.benchmarkComparison) } : {}),
    ...(value.verificationPlan !== undefined ? { verificationPlan: verificationPlan(value.verificationPlan) } : {}),
    ...(value.positioning !== undefined ? { positioning: line(value.positioning) } : {}),
    ...(value.userScenarios !== undefined ? { userScenarios: lines(value.userScenarios) } : {}),
    ...(value.vocRequirements !== undefined ? { vocRequirements: lines(value.vocRequirements) } : {}),
    ...(value.competitiveHypotheses !== undefined ? { competitiveHypotheses: lines(value.competitiveHypotheses) } : {}),
    ...(value.researchAlternatives !== undefined ? { researchAlternatives: lines(value.researchAlternatives) } : {}),
    ...(value.supportingEvidence !== undefined ? { supportingEvidence: lines(value.supportingEvidence) } : {}),
    ...(value.counterevidence !== undefined ? { counterevidence: lines(value.counterevidence) } : {}),
    ...(value.researchAssumptions !== undefined ? { researchAssumptions: lines(value.researchAssumptions) } : {}),
    ...(value.causalInvestigations !== undefined ? { causalInvestigations: Array.isArray(value.causalInvestigations) ? value.causalInvestigations.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const hypothesis = line(raw.hypothesis);
      if (!hypothesis) return [];
      const strings = (items: unknown) => Array.isArray(items) ? items.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 500)] : []).slice(0, 20) : [];
      const confidence: "low" | "medium" | "high" | "unknown" = raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high" ? raw.confidence : "unknown";
      const rationale = line(raw.rationale);
      return [{ hypothesis: { ...hypothesis, nature: "ASSUMPTION" as const }, ...(rationale ? { rationale } : {}), supportingEvidence: lines(raw.supportingEvidence), counterevidence: lines(raw.counterevidence), unknowns: strings(raw.unknowns), confidence, verification: strings(raw.verification) }];
    }).slice(0, 80) : [] } : {}),
  };
}

export function calculatePurchaseCostCeiling(input: {
  targetPrice: number | null;
  targetMarginPct: number | null;
  referralFee: number | null;
  fbaFee: number | null;
  logistics: number | null;
  estimatedTax: number | null;
  otherKnownCosts?: number | null;
  currency?: string;
}): PurchaseCostCeiling {
  const currency = input.currency?.trim().toUpperCase() || "USD";
  const values = [input.targetPrice, input.targetMarginPct, input.referralFee, input.fbaFee, input.logistics, input.estimatedTax];
  if (values.some((value) => value === null || !Number.isFinite(value)) || (input.otherKnownCosts !== null && input.otherKnownCosts !== undefined && !Number.isFinite(input.otherKnownCosts))) {
    return { status: "NOT_COMPUTABLE", value: null, currency, formula: "目标售价 - referral fee - FBA - 物流 - 估算税费 - 其他已知成本 - 目标利润", reason: "需要补齐目标售价、目标毛利率、平台费、FBA、物流和估算税费。" };
  }
  if ((input.targetPrice as number) <= 0 || (input.targetMarginPct as number) < 0 || (input.targetMarginPct as number) >= 100 || [input.referralFee, input.fbaFee, input.logistics, input.estimatedTax, input.otherKnownCosts ?? 0].some((value) => (value as number) < 0)) {
    return { status: "NOT_COMPUTABLE", value: null, currency, formula: "目标售价 - referral fee - FBA - 物流 - 估算税费 - 其他已知成本 - 目标利润", reason: "测算参数必须是非负数，目标毛利率必须在 0% 到 100% 之间。" };
  }
  const targetProfit = (input.targetPrice as number) * ((input.targetMarginPct as number) / 100);
  const value = Math.round(((input.targetPrice as number) - (input.referralFee as number) - (input.fbaFee as number) - (input.logistics as number) - (input.estimatedTax as number) - (input.otherKnownCosts ?? 0) - targetProfit) * 100) / 100;
  return {
    status: value >= 0 ? "COMPUTED" : "NOT_COMPUTABLE",
    value: value >= 0 ? value : null,
    currency,
    formula: "目标售价 - referral fee - FBA - 物流 - 估算税费 - 其他已知成本 - 目标利润",
    reason: value >= 0 ? null : "已知费用与目标利润高于目标售价，购买成本上限为不可行。",
  };
}
