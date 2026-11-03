import "server-only";
import { reviewResearchNarratives } from "./researchSemanticReview";
import { auditResearchParsing, researchUsageCost, startResearchRunAudit } from "./researchRunAudit";

import { createHash } from "node:crypto";
import { callAiJson, getAiConfig, type AiCallDiagnostics } from "@/lib/server/aiClient";
import type { FactField, ProductFact, ProductFactExtended, ProductPrice } from "@/lib/sourceLayer/fact/types";
import { RESEARCH_INPUT_BUNDLE_SCHEMA } from "@/lib/sourceLayer/v2/contracts";
import { buildDecisionSummary } from "@/lib/research/decisionSummary";
import {
  RESEARCH_REPORT_SCHEMA,
  RESEARCH_SYNTHESIS_NODE,
  isVerifiedNarrative,
  type ResearchConfig,
  type ResearchDeterministicMetric,
  type ResearchEngineInput,
  type ResearchEvidenceRef,
  type ResearchFactField,
  type ResearchFactSnapshot,
  type ResearchNarrative,
  type ResearchReport,
  type ResearchReportCore,
  type ResearchReportGeneration,
  type EconomicAssumptionsInput,
  type DeterministicRiskGateSummary,
} from "@/lib/research/researchContracts";
import { calculateUnitEconomics } from "./unitEconomicsCalculator";
import { evaluateDeterministicRiskGates } from "./riskGateEvaluator";
import { summarizeTrendObservations } from "./v3EvidenceResearchAdapter";

type SynthesisDraft = Record<string, unknown>;

type SynthesisResult = {
  readonly ok: boolean;
  readonly data: SynthesisDraft | null;
  readonly errorCode: string | null;
  /**
   * 失败时的原始错误摘要（`AiClientError.detail`）。
   * 没有它就无法区分「连接超时」「生成超时」「输出被截断」——真实批次首轮正是因为缺这一项
   * 把 `class=truncated` 误读成网络超时。
   */
  readonly errorDetail?: string | null;
  readonly providerCallStarted: boolean;
  /** P5-04：把本次调用的模型与 usage 透出，供报告持久化后复算真实费用。 */
  readonly diagnostics?: AiCallDiagnostics | null;
};

export type ResearchSynthesisInvoker = (input: {
  readonly system: string;
  readonly user: string;
  readonly config: ResearchConfig;
  readonly onProviderResponse?: (response: unknown) => void;
}) => Promise<SynthesisResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function hashReport(report: ResearchReport): string {
  return createHash("sha256").update(canonicalJson(report), "utf8").digest("hex");
}

function uniqueRefs(refs: readonly ResearchEvidenceRef[]): ResearchEvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.refId)) return false;
    seen.add(ref.refId);
    return true;
  });
}

function refForProductFact(productFact: ProductFact): ResearchEvidenceRef {
  const proof = productFact.sourceProof;
  return {
    refId: `evidence:${proof.evidenceId}`,
    source: proof.source,
    captureId: proof.captureId,
    evidenceId: proof.evidenceId,
    subjectKey: proof.subjectKey,
    capturedAt: proof.capturedAt,
    contentHash: proof.contentHash,
    sourceUrl: proof.sourceUrl,
  };
}

function refsForFact(input: ResearchEngineInput): ResearchEvidenceRef[] {
  const proofRef = refForProductFact(input.productFact);
  const matchesProof = (ref: ResearchEvidenceRef) => ref.refId === proofRef.refId
    && ref.source === proofRef.source
    && ref.evidenceId === proofRef.evidenceId
    && ref.captureId === proofRef.captureId
    && ref.subjectKey === proofRef.subjectKey
    && ref.capturedAt === proofRef.capturedAt
    && ref.contentHash === proofRef.contentHash
    && ref.sourceUrl === proofRef.sourceUrl;

  // G3-B：允许同主体的 EvidenceStore 附件（如 review_evidence）通过验证
  const matchesAttachment = (ref: ResearchEvidenceRef) =>
    ref.refId.startsWith("attachment:")
    && ref.subjectKey === proofRef.subjectKey
    && typeof ref.contentHash === "string"
    && ref.contentHash.length > 0
    && typeof ref.capturedAt === "string"
    && !Number.isNaN(Date.parse(ref.capturedAt))
    && (!input.researchInputBundle || input.researchInputBundle.sourceEvidenceRefs.some((bound) =>
      bound.kind === "attachment" && bound.refId === ref.refId
      && bound.attachmentId === ref.refId.slice("attachment:".length)
      && bound.subjectKey === ref.subjectKey && bound.contentHash === ref.contentHash
      && bound.capturedAt === ref.capturedAt
      && ((bound.evidenceId === ref.evidenceId && bound.captureId === ref.captureId)
        // Existing field-level ProductFact attachment refs use the immutable
        // attachment ID as their own capture/evidence identity (not the parent).
        || (ref.evidenceId === bound.attachmentId && ref.captureId === bound.attachmentId))
      && bound.version === input.researchInputBundle?.sourceEvidenceRefs.find((candidate) =>
        candidate.kind === "product_evidence" && candidate.refId === proofRef.refId)?.version));

  // Amazon detail history is deliberately replayed as additional, immutable
  // product-evidence refs. They are not the current ProductFact proof, but
  // when the read-only ResearchInputBundle binds them exactly they are valid
  // provenance and must not make an otherwise eligible V1 run fail closed.
  const bundleProductEvidenceRefs = input.researchInputBundle?.sourceEvidenceRefs
    .filter((ref) => ref.kind === "product_evidence") ?? [];
  const matchesBoundProductEvidence = (ref: ResearchEvidenceRef) =>
    ref.source === proofRef.source
    && bundleProductEvidenceRefs.some((candidate) => candidate.refId === ref.refId
      && candidate.subjectKey === ref.subjectKey
      && candidate.evidenceId === ref.evidenceId
      && candidate.captureId === ref.captureId
      && candidate.contentHash === ref.contentHash
      && candidate.capturedAt === ref.capturedAt);
  const matchesAllowedRef = (ref: ResearchEvidenceRef) =>
    matchesProof(ref) || matchesAttachment(ref) || matchesBoundProductEvidence(ref);

  if (input.productFact.sourceProof.subjectKey !== input.productFact.subjectKey
    || input.sourceEvidenceRefs.length === 0
    || !input.sourceEvidenceRefs.some(matchesProof)
    || input.sourceEvidenceRefs.some((ref) => !matchesAllowedRef(ref))) {
    throw new Error("RESEARCH_EVIDENCE_REF_INVALID");
  }

  if (input.researchInputBundle) {
    const bundle = input.researchInputBundle;
    const bundleFact = bundle.productFact;
    const productEvidenceRefs = bundle.sourceEvidenceRefs.filter((ref) => ref.kind === "product_evidence");
    const bundleProofMatches = Boolean(bundleFact)
      && bundle.schemaVersion === RESEARCH_INPUT_BUNDLE_SCHEMA
      && bundle.taskId === input.taskId
      && bundle.candidateId === input.candidateId
      && bundle.subjectKey === proofRef.subjectKey
      && bundleFact?.subjectKey === proofRef.subjectKey
      && bundleFact?.sourceProof.evidenceId === proofRef.evidenceId
      && bundleFact?.sourceProof.captureId === proofRef.captureId
      && bundleFact?.sourceProof.contentHash === proofRef.contentHash
      && bundleFact?.sourceProof.source === proofRef.source
      && canonicalJson(bundleFact) === canonicalJson(input.productFact);
    const bundleProofRef = productEvidenceRefs.find((ref) => ref.refId === proofRef.refId
      && ref.subjectKey === proofRef.subjectKey
      && ref.evidenceId === proofRef.evidenceId
      && ref.captureId === proofRef.captureId
      && ref.contentHash === proofRef.contentHash
      && ref.capturedAt === proofRef.capturedAt);
    const allBundleProductEvidenceBound = productEvidenceRefs.every((ref) =>
      input.sourceEvidenceRefs.some((candidate) => matchesBoundProductEvidence(candidate) && candidate.refId === ref.refId));
    if (!bundleProofMatches || !bundleProofRef || productEvidenceRefs.length === 0 || !allBundleProductEvidenceBound) {
      throw new Error("RESEARCH_EVIDENCE_REF_INVALID");
    }
  }
  return uniqueRefs(input.sourceEvidenceRefs);
}

function mapFactField<T>(
  value: FactField<T> | undefined,
  refs: readonly ResearchEvidenceRef[],
  fallbackRefs: readonly ResearchEvidenceRef[] = refs,
): ResearchFactField<T> {
  if (!value) {
    return {
      value: null as unknown as T,
      status: "missing",
      source: "sellersprite_plugin",
      confidence: 0,
      capturedAt: null,
      rawProofHash: null,
      evidenceRefs: fallbackRefs,
    };
  }
  return {
    value: value.value,
    status: value.status,
    metricNature: value.metricNature,
    source: value.source,
    confidence: value.confidence,
    capturedAt: value.capturedAt,
    rawProofHash: value.rawProofHash,
    evidenceRefs: value.evidenceRefs?.length
      ? uniqueRefs(value.evidenceRefs.flatMap((fieldRef) => refs.filter((ref) => ref.refId === fieldRef.refId
        && ref.source === fieldRef.source
        && ref.captureId === fieldRef.captureId
        && ref.evidenceId === fieldRef.evidenceId
        && ref.subjectKey === fieldRef.subjectKey
        && ref.capturedAt === fieldRef.capturedAt
        && ref.contentHash === fieldRef.contentHash
        && ref.sourceUrl === fieldRef.sourceUrl)))
      : fallbackRefs,
  };
}

function mapProductFactExtended(
  extended: ProductFactExtended | undefined,
  refs: readonly ResearchEvidenceRef[],
  fallbackRefs: readonly ResearchEvidenceRef[],
): ResearchFactSnapshot["extended"] {
  if (!extended) return undefined;
  return Object.fromEntries(Object.entries(extended).flatMap(([key, value]) => {
    if (key === "variationStructure" && value && typeof value === "object" && !Array.isArray(value)) {
      const structure = value as NonNullable<ProductFactExtended["variationStructure"]>;
      const mappedRefs = structure.evidenceRefs.flatMap((fieldRef) => refs.filter((ref) => ref.refId === fieldRef.refId
        && ref.subjectKey === fieldRef.subjectKey
        && ref.capturedAt === fieldRef.capturedAt
        && ref.contentHash === fieldRef.contentHash));
      return [[key, {
        value: structure,
        status: "present",
        metricNature: "snapshot",
        source: "amazon_dom",
        confidence: mappedRefs.length ? 1 : 0,
        capturedAt: structure.evidenceRefs[0]?.capturedAt ?? null,
        rawProofHash: structure.evidenceRefs[0]?.contentHash ?? null,
        evidenceRefs: uniqueRefs(mappedRefs),
      }]];
    }
    return [[key, mapFactField(value as FactField<unknown>, refs, fallbackRefs)]];
  })) as ResearchFactSnapshot["extended"];
}

/**
 * G2-A：`ProductFactMarket` / `ProductFactProfit` 的部分槽位在类型上是可选的
 * （旧 ProductFact 可能没有），但 Research 报告的快照形状必须稳定 —— 否则报告的
 * 键集合与 `citationIndex` 条数会随输入漂移。缺省时统一表达为显式
 * `status: "missing"`，`value` 保持 `null`；本层**不补值、不换算、不猜测**。
 */
function projectedField<T>(
  value: FactField<T> | undefined,
  proof: ProductFact["sourceProof"],
): FactField<T> {
  if (value) return value;
  return {
    value: null,
    status: "missing",
    metricNature: "unknown",
    source: proof.source,
    confidence: 0,
    capturedAt: proof.capturedAt,
    rawProofHash: proof.contentHash,
  };
}

/** Deterministic read-only projection; caller must supply a verified ProductFact. */
export function buildResearchFactSnapshot(
  productFact: ProductFact,
  sourceRefs: readonly ResearchEvidenceRef[] = [refForProductFact(productFact)],
): ResearchFactSnapshot {
  return snapshotOf(productFact, sourceRefs);
}

function snapshotOf(
  productFact: ProductFact,
  refs: readonly ResearchEvidenceRef[],
): ResearchFactSnapshot {
  const proof = productFact.sourceProof;
  const primaryRefs = [refForProductFact(productFact)];
  const mapField = <T>(value: FactField<T> | undefined) => mapFactField(value, refs, primaryRefs);
  return {
    basic: {
      asin: mapField(productFact.basic.asin),
      title: mapField(productFact.basic.title),
      image: mapField(productFact.basic.image),
      brand: mapField(productFact.basic.brand),
      category: mapField(productFact.basic.category),
      price: mapField(productFact.basic.price),
      rating: mapField(productFact.basic.rating),
      reviewCount: mapField(productFact.basic.reviewCount),
      bulletPoints: mapField(productFact.basic.bulletPoints),
    },
    market: {
      bsr: mapField(productFact.market.bsr),
      monthlySalesEstimate: mapField(productFact.market.monthlySalesEstimate),
      monthlyRevenueEstimate: mapField(productFact.market.monthlyRevenueEstimate),
      launchedDate: mapField(productFact.market.launchedDate),
      // G2-A：SellerSprite 事实投影补齐（事实已在 ProductFact 内，此前 Research 读取面未投影）。
      subCategoryBsr: mapField(projectedField(productFact.market.subCategoryBsr, proof)),
      dateFirstAvailable: mapField(projectedField(productFact.market.dateFirstAvailable, proof)),
      buyboxSeller: mapField(projectedField(productFact.market.buyboxSeller, proof)),
      fulfillmentType: mapField(projectedField(productFact.market.fulfillmentType, proof)),
      // `estimatedGrossMargin` 是第三方估算（SellerSprite 导表，metricNature=estimate）。
      // Research 只投影该估算值本身，绝不用它推导/宣称利润。
      estimatedGrossMargin: mapField(projectedField(productFact.market.estimatedGrossMargin, proof)),
      listingQualityScore: mapField(projectedField(productFact.market.listingQualityScore, proof)),
    },
    profit: {
      packageWeight: mapField(productFact.profit.packageWeight),
      packageDimensions: mapField(productFact.profit.packageDimensions),
      fbaFee: mapField(productFact.profit.fbaFee),
      itemWeight: mapField(projectedField(productFact.profit.itemWeight, proof)),
      itemDimensions: mapField(projectedField(productFact.profit.itemDimensions, proof)),
    },
    // G2-B：SellerSprite 关键词证据投影。报告层只读 ProductFact，绝不回读任务原始 JSON。
    keywordEvidence: {
      topKeywords: mapField(projectedField(productFact.keywordEvidence?.topKeywords, proof)),
    },
    ...(productFact.extended ? { extended: mapProductFactExtended(productFact.extended, refs, primaryRefs) } : {}),
    ...(productFact.timeSeries ? {
      timeSeries: {
        price90dMin: mapField(productFact.timeSeries.price90dMin),
        price90dAvg: mapField(productFact.timeSeries.price90dAvg),
        price360dMin: mapField(productFact.timeSeries.price360dMin),
        bsr90dAvg: mapField(productFact.timeSeries.bsr90dAvg),
        bsrDrops90d: mapField(productFact.timeSeries.bsrDrops90d),
        buyBoxAmazonSharePercent: mapField(productFact.timeSeries.buyBoxAmazonSharePercent),
        dealCount90d: mapField(productFact.timeSeries.dealCount90d),
      },
    } : {}),
    ...(productFact.variationAnalysis ? {
      variationAnalysis: {
        childSales: mapField(productFact.variationAnalysis.childSales),
        parentTotalSales: mapField(productFact.variationAnalysis.parentTotalSales),
        currentAsinSalesShare: mapField(productFact.variationAnalysis.currentAsinSalesShare),
        isDominantVariation: mapField(productFact.variationAnalysis.isDominantVariation),
        isMinorVariation: mapField(productFact.variationAnalysis.isMinorVariation),
      },
    } : {}),
    ...(productFact.concentration ? {
      concentration: {
        brandCr5Share: mapField(productFact.concentration.brandCr5Share),
        amazon1pShare: mapField(productFact.concentration.amazon1pShare),
        sellerMarketShare: mapField(productFact.concentration.sellerMarketShare),
        sellerOriginDomesticRatio: mapField(productFact.concentration.sellerOriginDomesticRatio),
      },
    } : {}),
  };
}

function mergeMetricRefs(
  ...fields: readonly ResearchFactField<unknown>[]
): ResearchEvidenceRef[] {
  return uniqueRefs(fields.flatMap((field) => field.evidenceRefs));
}

function deterministicMetric<T>(input: {
  value: T | null;
  refs: readonly ResearchEvidenceRef[];
  reason: string | null;
}): ResearchDeterministicMetric<T> {
  return {
    value: input.value,
    status: input.value === null ? "not_computable" : "available",
    evidenceRefs: uniqueRefs(input.refs),
    reason: input.reason,
  };
}

function deterministicCalculations(
  facts: ResearchFactSnapshot,
  assumptions?: EconomicAssumptionsInput | null,
) {
  return calculateUnitEconomics({ facts, assumptions });
}

/**
 * 单条叙事的字符上限。
 *
 * 原为 4,000：在 12,000 输出预算下这会成为**隐藏的二次截断**——模型正常输出、
 * 费用已花，但长条目（典型是 verification 对照设计）会被无声切掉尾巴。
 * 12,000 tokens 约合 8,000–12,000 汉字，分散到十余条叙事，单条留 8,000 字符
 * 既能容纳最长的验证设计，又不会让单条异常膨胀拖垮整份报告。
 */
function textFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").trim();
  return text ? text.slice(0, 8_000) : null;
}

function refsFromDraft(
  value: unknown,
  refsById: ReadonlyMap<string, ResearchEvidenceRef>,
): ResearchEvidenceRef[] {
  if (!isRecord(value) || !Array.isArray(value.evidenceRefs)) return [];
  const refs: ResearchEvidenceRef[] = [];
  for (const candidate of value.evidenceRefs) {
    if (typeof candidate !== "string") continue;
    const ref = refsById.get(candidate);
    if (ref) refs.push(ref);
  }
  return uniqueRefs(refs);
}

function narrativeFromDraft(
  value: unknown,
  refsById: ReadonlyMap<string, ResearchEvidenceRef>,
): ResearchNarrative {
  if (typeof value === "string") {
    return { text: textFrom(value), evidenceRefs: [] };
  }
  if (!isRecord(value)) return { text: null, evidenceRefs: [] };
  const text = textFrom(value.text ?? value.summary ?? value.analysis ?? value.recommendation);
  return { text, evidenceRefs: refsFromDraft(value, refsById) };
}

function sectionOf(draft: SynthesisDraft, key: string): Record<string, unknown> {
  return isRecord(draft[key]) ? draft[key] : {};
}

function listFromDraft(
  value: unknown,
  refsById: ReadonlyMap<string, ResearchEvidenceRef>,
): ResearchNarrative[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => narrativeFromDraft(item, refsById))
    .filter((item) => item.text !== null)
    .slice(0, 12);
}

/**
 * JEV-002：narrative 分流。
 *
 * - 有文本且至少 1 条已解析 evidenceRef → 保留为「已核实分析」；
 * - 有文本但没有任何可解析引用 → 移入 sink（未验证假设），并从分析字段清空，
 *   避免「看起来像研究结论、却没有可追溯来源」的内容出现在报告与页面主区。
 */
function partitionNarrative(
  narrative: ResearchNarrative,
  sink: ResearchNarrative[],
): ResearchNarrative {
  if (isVerifiedNarrative(narrative)) return narrative;
  if (typeof narrative.text === "string" && narrative.text.trim().length > 0) {
    sink.push({ text: narrative.text, evidenceRefs: [] });
  }
  return { text: null, evidenceRefs: [] };
}

function partitionNarratives(
  narratives: readonly ResearchNarrative[],
  sink: ResearchNarrative[],
): ResearchNarrative[] {
  // 列表只保留已核实项；未验证项已进入 sink，不留下空占位。
  return narratives
    .map((item) => partitionNarrative(item, sink))
    .filter((item) => item.text !== null);
}

/** 未验证假设上限：够用于提示，不构成第二份报告。 */
const MAX_UNVERIFIED_ASSUMPTIONS = 40;

export function synthesisSystemPrompt(): string {
  return [
    `你是轻选工作台 Research Layer V1 的 ${RESEARCH_SYNTHESIS_NODE} 节点。`,
    "只消费 EvidenceStore 的 ProductFact 与 researchInputBundle 只读投影，不采集、不改事实或计算。ProductFact 的 value=null/status=missing 保持未知；评论只是买家报告，不是已确认商品事实。",
    "禁止猜销量、价格、成本、利润、供应商、VOC 内容或任何不存在的数据。",
    "不要输出 facts、price、sales、revenue、profit 等事实字段；事实由服务端确定性复制。",
    "所有涉及输入事实的分析文字都应使用 allowedEvidenceRefs 中的 refId；没有可引用事实时 evidenceRefs 输出空数组；引用 allowedEvidenceRefs 之外的引用均无效并将被拦截移入未验证假设。",
    "vocAnalysis 只能引用白名单中 attachment: 评论凭据，标题/卖点不能当买家原声。有 trendSummary/keywordEvidence 时结合走势/关键词分析并引用对应凭据，估算不升级为事实。",
    // P2-02：把「具体、可否决的改良研究」写成可执行的输出要求，而不是泛泛总结。
    "研究结论必须具体到可执行、可否决，禁止只写「需要人工判断」「建议优化」这类空话。",
    "vocAnalysis 必须写清：哪类人群/在什么场景下、观察到什么具体问题；只能引用真实评论证据，不得把标题或卖点当买家原声。",
    "competitionInsight 从观察提出竞争性原因假设，并说明该假设可能错在哪里。每项 causalInvestigations 输出 hypothesis、rationale、supportingEvidence、counterevidence、unknowns、confidence(low/medium/high/unknown)、verification；原因始终待验证，合法引用不确认因果。",
    "每个原因独立说明支持与限制；同证据可关联不同解释但须说明作用，不用相同验证动作互相顶替。没有观察依据的原因进入 unknowns。",
    // 2026-10-29 真实调用暴露：模型把因果假设写成纯文本，hypothesis.evidenceRefs 为空，
    // 结果被 P2-02 证据门禁整条降级到未验证区，竞争因果分析在报告里变成空壳。
    // 这里把「结构化 + 引用」写成硬要求，并禁止把 refId 当作正文。
    "【引用结构硬要求】所有分析及列表条目使用 {\"text\":\"...\",\"evidenceRefs\":[\"<refId>\"]}；包括 hypothesis/rationale/supportingEvidence/counterevidence/建议。引用逐字匹配 allowedEvidenceRefs，不把 refId 当正文；无引用内容进入 unknowns，不编造依据。",
    "【研究质量 LC-PRQ-1】引用评论写 externalContentId、准确星级和相关原文；保留同一评论相关正反语义，不能只截有利片段，也不能机械拆分制造反证。按产品属性/使用场景区分产品、描述预期、物流服务问题，不从投诉直接确认制造原因。",
    "counterevidence 必须解释该证据为何削弱本假设或限定适用条件；重复投诉、另一种解释或证据同时符合两种解释均不是有区分力的反证。无有效反证留空，在 unknowns 说明缺口；不得凑数量。",
    "问题按内容识别，4/5星也可能投诉。vocAnalysis.analysis 声明当前各星级样本数、omittedCount/来源限制；已有样本不代表全体买家。验证不能只查1–3星，需纳入相关高星混合评价及正面限制信息。",
    "区分评论级、商品级、品类级证据；单商品不得推出品类共性，多商品相似也不自动证明普遍性。品类外推只作待验证假设，写明所需跨商品/场景补证。",
    "verification 写可执行的同条件对照：比较什么、控制哪些条件、观察指标、不同解释各自预测什么、何种结果削弱/否定原因及停止条件。评论词频/出现次数只用于找线索，不能以阈值判定因果成立。不能区分时明确尚不能区分。",
    "成本、利润、制造难度、模具、供应商能力、合规无对应报价/工艺/测算/合规证据时保持未知；改良仅作依赖假设的方向，列补证和反向影响，不承诺低成本、可制造、合规或盈利。",
    "competitionInsight.differentiationSuggestions 的每一条都要包含四件事：①有实质差异的改良方向；②它相对现有商品改变了什么；③成本或副作用（例如更贵、更重、更难清洗、更难包装）；④证伪方法或停止条件（用什么证据/测试能证明它不成立，什么情况下应停止）。",
    "若证据不足以支持任何改良方向，必须显式给出「不改动 / 缩小目标场景 / 停止该方向」三者之一，并说明依据；不得为了凑建议编造方向。",
    "riskAssessment 必须包含至少一条「何时应当停止或放弃」的条件，以及验证该条件的下一步动作；不得用「风险可控」代替具体条件。",
    "marketOpportunity 必须说明买家为什么会买（购买价值假设）以及该假设需要什么证据支持，不能把估算当已证事实。",
    "只输出 JSON，不要 Markdown，不要解释 JSON 外的内容。",
    "JSON 结构：executiveSummary(analysis/keyPoints)、marketOpportunity(analysis)、competitionInsight(analysis/differentiationSuggestions/causalHypotheses/causalInvestigations/alternatives/supportingEvidence/counterevidence/verificationItems)、vocAnalysis(analysis/painPoints)、unitEconomics(analysis)、supplyChain(analysis)、riskAssessment(analysis/risks/verificationItems)。unknowns/verification 为字符串数组。",
  ].join("\n");
}

export async function invokeDeepSeek(input: {
  readonly system: string;
  readonly user: string;
  readonly config: ResearchConfig;
  readonly onProviderResponse?: (response: unknown) => void;
}): Promise<SynthesisResult> {
  const config = getAiConfig();
  if (!config.ok) {
    return { ok: false, data: null, errorCode: config.error.code, providerCallStarted: false };
  }
  if (config.data.provider !== "deepseek") {
    return { ok: false, data: null, errorCode: "provider_not_deepseek", providerCallStarted: false };
  }
  const response = await callAiJson<SynthesisDraft>({
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: 0,
    maxTokens: input.config.maxTokens,
    timeoutMs: input.config.timeoutMs,
    thinkingMode: "disabled",
    onProviderResponse: input.onProviderResponse,
  });
  if (!response.ok) {
    return {
      ok: false,
      data: null,
      errorCode: response.error.code,
      errorDetail: response.error.detail ?? null,
      providerCallStarted: response.providerCallStarted === true,
      diagnostics: response.diagnostics ?? null,
    };
  }
  if (!isRecord(response.data)) {
    return { ok: false, data: null, errorCode: "invalid_synthesis_shape", providerCallStarted: response.providerCallStarted === true, diagnostics: response.diagnostics ?? null };
  }
  return {
    ok: true,
    data: response.data,
    errorCode: null,
    providerCallStarted: response.providerCallStarted === true,
    diagnostics: response.diagnostics ?? null,
  };
}

function resolvedRefRegistry(refs: readonly ResearchEvidenceRef[], allowedIds?: ReadonlySet<string>) {
  const registry = new Map<string, ResearchEvidenceRef>();
  for (const ref of refs) {
    registry.set(ref.refId, ref);
    if (ref.contentHash) {
      for (const alias of [`attachment:${ref.contentHash}`, `attachment:a-${ref.contentHash}`]) {
        if (!allowedIds || allowedIds.has(alias)) registry.set(alias, ref);
      }
    }
  }
  return registry;
}

function aiNarratives(input: {
  readonly draft: SynthesisDraft | null;
  readonly refs: readonly ResearchEvidenceRef[];
  readonly onCause?: (rawIndex: number, retained: boolean) => void;
  readonly allowedIds?: ReadonlySet<string>;
}) {
  const draft = input.draft ?? {};
  const refsById = resolvedRefRegistry(input.refs, input.allowedIds);
  const executive = sectionOf(draft, "executiveSummary");
  const market = sectionOf(draft, "marketOpportunity");
  const competition = sectionOf(draft, "competitionInsight");
  const voc = sectionOf(draft, "vocAnalysis");
  const economics = sectionOf(draft, "unitEconomics");
  const supply = sectionOf(draft, "supplyChain");
  const risk = sectionOf(draft, "riskAssessment");

  // JEV-002：所有分析字段统一经过分流器，未验证文本只进 unverifiedAssumptions。
  const unverified: ResearchNarrative[] = [];
  const narrative = (value: unknown) =>
    partitionNarrative(narrativeFromDraft(value, refsById), unverified);
  const list = (value: unknown) =>
    partitionNarratives(listFromDraft(value, refsById), unverified);
  const causalInvestigations = Array.isArray(competition.causalInvestigations)
    ? competition.causalInvestigations.slice(0, 20).flatMap((item, rawIndex) => {
        if (!isRecord(item)) { input.onCause?.(rawIndex, false); return []; }
        // 2026-10-29 真实调用暴露：模型常把 unknowns / verification 写成单个字符串
        // （例如 verification: "抽 50 条评论统计"），旧实现只接受数组，导致每条原因的
        // 验证动作被静默丢弃、报告里 0 条可执行验证。字符串视为单元素列表。
        const strings = (value: unknown) => {
          // 2026-10-29 真实调用（12,000 输出预算，#3）：模型把 verification 输出成
          // `{"text":"同条件对照：…"}` 对象而不是字符串数组，旧实现只接受数组/字符串，
          // 结果两条验证动作被静默丢弃（报告里 verification=0），而模型其实写了。
          // 同一字段在不同采样下会以 string / string[] / {text} / {text}[] 出现，
          // 统一归一化为字符串列表；无法识别形状的值仍然丢弃，不猜内容。
          const list = Array.isArray(value) ? value : [value];
          return list
            .map((item) => {
              if (typeof item === "string") return item;
              if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
                return (item as { text: string }).text;
              }
              return null;
            })
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
            .slice(0, 20);
        };
        // P2-02：hypothesis 与 rationale 同样走未验证分流器。
        // 没有可追溯引用的原因假设不能作为研究结论展示，只能落到未验证假设区，
        // 同时保留该原因的「未知」记录，避免整条原因凭空消失。
        const declaredConfidence: "low" | "medium" | "high" | "unknown" = item.confidence === "low" || item.confidence === "medium" || item.confidence === "high" ? item.confidence : "unknown";
        const supportingEvidence = list(item.supportingEvidence);
        const counterevidence = list(item.counterevidence);
        // 2026-10-29 真实调用暴露：模型把 hypothesis/rationale 写成纯文本，却把合法的
        // evidenceRefs 挂在同一条原因的 supportingEvidence/counterevidence 上。要求同一段证据
        // 在多个字段里重复引用并不现实，因此按**条目级证据**绑定假设：
        // 支持引用只关联触发观察，不验证原因；反证保持独立，不能转作支持引用。
        const itemEvidenceRefs = [...new Map(
          supportingEvidence
            .flatMap((entry) => entry.evidenceRefs)
            .map((ref) => [ref.refId, ref] as const),
        ).values()];
        const bindItemEvidence = (value: ResearchNarrative): ResearchNarrative => (
          value.text !== null && value.evidenceRefs.length === 0 && itemEvidenceRefs.length > 0
            ? { ...value, evidenceRefs: itemEvidenceRefs }
            : value
        );
        const rawHypothesis = bindItemEvidence(narrativeFromDraft(item.hypothesis, refsById));
        const linkedHypothesis = rawHypothesis.evidenceRefs.length > 0 || counterevidence.length > 0
          ? rawHypothesis : partitionNarrative(rawHypothesis, unverified);
        const hypothesis: ResearchNarrative = linkedHypothesis.text === null ? linkedHypothesis : {
          ...linkedHypothesis,
          semanticReview: { status: "hypothesis", reasons: ["引用仅关联触发观察，不能确认因果或工程原因；需以支持、反证及验证动作检验该假设。"] },
        };
        const rawRationale = bindItemEvidence(narrativeFromDraft(item.rationale ?? item.basis ?? item.why, refsById));
        const rationale = counterevidence.length > 0 && rawRationale.text !== null && rawRationale.evidenceRefs.length === 0
          ? { ...rawRationale, semanticReview: hypothesis.semanticReview }
          : partitionNarrative(rawRationale, unverified);
        const unknowns = strings(item.unknowns);
        const verification = strings(item.verification);
        const hasTraceableHypothesis = hypothesis.text !== null && hypothesis.evidenceRefs.length > 0;
        // 完全没有内容的空条目直接丢弃；只要模型提供了任何一项（假设、未知、证据），
        // 就保留下来，避免把「模型承认自己不知道」这件事丢掉。
        const hadContent = hypothesis.text !== null || unknowns.length > 0 || supportingEvidence.length > 0 || counterevidence.length > 0;
        input.onCause?.(rawIndex, hadContent);
        if (!hadContent) return [];
        const retainedUnknowns = hasTraceableHypothesis
          ? (counterevidence.length > 0 ? unknowns : [...unknowns,
            "当前没有通过引用校验的反证；模型未提供反证或其引用不合法，仍需补证验证。"])
          : [...unknowns, "该原因假设缺少可追溯证据引用，当前只作为待验证方向，不构成研究结论。"];
        return [{
          hypothesis,
          ...(rationale.text !== null ? { rationale } : {}),
          supportingEvidence,
          counterevidence,
          unknowns: retainedUnknowns,
          // 无可追溯证据的原因不允许保留模型自评的高可信度。
          confidence: hasTraceableHypothesis && supportingEvidence.length > 0
            ? (declaredConfidence === "high" || declaredConfidence === "medium" ? "low" : declaredConfidence)
            : "unknown" as const,
          verification,
        }];
      })
    : undefined;

  return {
    executiveSummary: {
      analysis: narrative(executive.analysis ?? executive),
      keyPoints: list(executive.keyPoints),
    },
    marketOpportunity: {
      analysis: narrative(market.analysis ?? market),
    },
    competitionInsight: {
      analysis: narrative(competition.analysis ?? competition),
      differentiationSuggestions: list(
        competition.differentiationSuggestions ?? competition.suggestions,
      ),
      causalHypotheses: list(
        competition.causalHypotheses ?? competition.causalHypothesis ?? competition.hypotheses,
      ),
      ...(causalInvestigations ? { causalInvestigations } : {}),
      alternatives: list(competition.alternatives ?? competition.options),
      supportingEvidence: list(
        competition.supportingEvidence ?? competition.supportingEvidenceItems ?? competition.evidenceFor,
      ),
      counterevidence: list(
        competition.counterevidence ?? competition.counterEvidence ?? competition.counterEvidenceItems,
      ),
      verificationItems: list(
        competition.verificationItems ?? competition.verification ?? competition.validationItems,
      ),
    },
    vocAnalysis: {
      analysis: narrative(voc.analysis ?? voc),
      painPoints: list(voc.painPoints),
    },
    unitEconomics: {
      analysis: narrative(economics.analysis ?? economics),
    },
    supplyChain: {
      analysis: narrative(supply.analysis ?? supply),
    },
    riskAssessment: {
      analysis: narrative(risk.analysis ?? risk),
      risks: list(risk.risks),
      verificationItems: list(
        risk.verificationItems ?? risk.verification ?? risk.validationItems,
      ),
    },
    unverifiedAssumptions: unverified.slice(0, MAX_UNVERIFIED_ASSUMPTIONS),
  };
}

/**
 * RESEARCH-002：citationIndex 必须覆盖整份报告的证据引用，而不只是 facts.* 字段。
 *
 * - facts.*：确定性事实字段自带引用；
 * - analysis.*：AI narrative 的可追溯引用（JEV-002 之后，无引用的 narrative 已被移出分析字段）。
 */
function citationIndexOf(
  facts: ResearchFactSnapshot,
  narratives: ReturnType<typeof aiNarratives>,
): ResearchReport["citationIndex"] {
  const output: Array<ResearchReport["citationIndex"][number]> = [];
  for (const [group, fields] of Object.entries(facts)) {
    for (const [field, value] of Object.entries(fields)) {
      output.push({
        fieldPath: `facts.${group}.${field}`,
        source: "fact",
        evidenceRefs: value.evidenceRefs,
      });
    }
  }

  const pushNarrative = (fieldPath: string, narrative: ResearchNarrative) => {
    if (narrative.evidenceRefs.length === 0) return;
    output.push({ fieldPath, source: "narrative", evidenceRefs: narrative.evidenceRefs });
  };
  const pushList = (prefix: string, list: readonly ResearchNarrative[]) => {
    list.forEach((item, index) => pushNarrative(`${prefix}[${index}]`, item));
  };

  pushNarrative("analysis.executiveSummary", narratives.executiveSummary.analysis);
  pushList("analysis.executiveSummary.keyPoints", narratives.executiveSummary.keyPoints);
  pushNarrative("analysis.marketOpportunity", narratives.marketOpportunity.analysis);
  pushNarrative("analysis.competitionInsight", narratives.competitionInsight.analysis);
  pushList(
    "analysis.competitionInsight.differentiationSuggestions",
    narratives.competitionInsight.differentiationSuggestions,
  );
  pushList(
    "analysis.competitionInsight.causalHypotheses",
    narratives.competitionInsight.causalHypotheses,
  );
  narratives.competitionInsight.causalInvestigations?.forEach((item, index) => {
    const prefix = `analysis.competitionInsight.causalInvestigations[${index}]`;
    pushNarrative(`${prefix}.hypothesis`, item.hypothesis);
    if (item.rationale) pushNarrative(`${prefix}.rationale`, item.rationale);
    pushList(`${prefix}.supportingEvidence`, item.supportingEvidence);
    pushList(`${prefix}.counterevidence`, item.counterevidence);
  });
  pushList(
    "analysis.competitionInsight.alternatives",
    narratives.competitionInsight.alternatives,
  );
  pushList(
    "analysis.competitionInsight.supportingEvidence",
    narratives.competitionInsight.supportingEvidence,
  );
  pushList(
    "analysis.competitionInsight.counterevidence",
    narratives.competitionInsight.counterevidence,
  );
  pushList(
    "analysis.competitionInsight.verificationItems",
    narratives.competitionInsight.verificationItems,
  );
  pushNarrative("analysis.vocAnalysis", narratives.vocAnalysis.analysis);
  pushList("analysis.vocAnalysis.painPoints", narratives.vocAnalysis.painPoints);
  pushNarrative("analysis.unitEconomics", narratives.unitEconomics.analysis);
  pushNarrative("analysis.supplyChain", narratives.supplyChain.analysis);
  pushNarrative("analysis.riskAssessment", narratives.riskAssessment.analysis);
  pushList("analysis.riskAssessment.risks", narratives.riskAssessment.risks);
  pushList("analysis.riskAssessment.verificationItems", narratives.riskAssessment.verificationItems);

  return output;
}

function promptPayload(
  input: ResearchEngineInput,
  facts: ResearchFactSnapshot,
  deterministic: ReturnType<typeof deterministicCalculations>,
  deterministicGate?: DeterministicRiskGateSummary,
  allowedEvidenceRefs?: readonly string[],
): string {
  const trendSummary = input.researchInputBundle?.trendObservations?.length
    ? summarizeTrendObservations(input.researchInputBundle.trendObservations)
    : null;
  // The verified ProductFact is already present at the top level. Keeping the
  // same object again inside the read-only handoff bundle inflated large V1
  // prompts by 29–33 KB in the real P5 samples without adding evidence. The
  // bundle contract remains unchanged; this is only a compact prompt
  // projection, and all source refs/identity metadata stay intact.
  const citableRefIds = new Set(allowedEvidenceRefs ?? input.sourceEvidenceRefs.map((r) => r.refId));
  const researchInputBundleForPrompt = input.researchInputBundle
    ? (() => {
      const { productFact: _duplicateProductFact, sourceEvidenceRefs: bundleRefs, ...bundleWithoutProductFact } = input.researchInputBundle;
      // 2026-10-29 #5 真实调用暴露：bundle 的 sourceEvidenceRefs 里含**不可引用**的附件
      // （att-ba4ed1eb…：同商品同版本，但正文没进输入、也不在白名单）。模型看到 refId
      // 就照着引，结果 2 处 REF_NOT_ALLOWED 被门禁拒绝。
      // 「能读取 ≠ 有权引用」：模型可见的投影只保留可引用 refs，并显式告知省略了几条，
      // 而不是静默减少。审计用的 input.researchInputBundle 保持不变。
      const citable = (bundleRefs ?? []).filter((ref) => citableRefIds.has(ref.refId));
      const omitted = (bundleRefs ?? []).length - citable.length;
      return {
        ...bundleWithoutProductFact,
        sourceEvidenceRefs: citable,
        ...(omitted > 0 ? { nonCitableSourceRefsOmitted: omitted } : {}),
      };
    })()
    : null;

  // 出现在 bundle 里但不在白名单的 refs：模型可以读到它们承载的数据（例如 provider 估算），
  // 但**没有引用权**。显式列出，避免模型自己猜哪些能引（#5 就是这么踩的）。
  const nonCitableEvidenceRefs = (input.researchInputBundle?.sourceEvidenceRefs ?? [])
    .map((ref) => ref.refId)
    .filter((refId) => !citableRefIds.has(refId));

  return JSON.stringify({
    node: RESEARCH_SYNTHESIS_NODE,
    taskId: input.taskId,
    candidateId: input.candidateId,
    subjectKey: input.productFact.subjectKey,
    productFact: input.productFact,
    sourceEvidenceRefs: input.sourceEvidenceRefs,
    allowedEvidenceRefs: allowedEvidenceRefs ?? input.sourceEvidenceRefs.map((r) => r.refId),
    ...(nonCitableEvidenceRefs.length > 0 ? { nonCitableEvidenceRefs } : {}),
    deterministicCalculations: deterministic,
    deterministicRiskGate: deterministicGate ?? null,
    factSnapshotForReference: facts,
    researchInputBundle: researchInputBundleForPrompt,
    trendSummary,
    reviewEvidenceSummary: input.reviewEvidenceSummary ?? null,
  });
}

function addBoundProductFactAttachmentRefs(
  productFact: ProductFact,
  bundle: NonNullable<ResearchEngineInput["researchInputBundle"]>,
  allowed: Set<string>,
): void {
  const attachments = bundle.sourceEvidenceRefs.filter((ref) => ref.kind === "attachment");
  const add = (candidate: unknown) => {
    if (!isRecord(candidate)
      || typeof candidate.refId !== "string" || !candidate.refId.startsWith("attachment:")
      || typeof candidate.subjectKey !== "string" || typeof candidate.contentHash !== "string"
      || !/^[a-f0-9]{64}$/iu.test(candidate.contentHash)
      || candidate.subjectKey !== productFact.subjectKey
      || typeof candidate.capturedAt !== "string") return;
    const attachmentId = candidate.refId.slice("attachment:".length);
    const bound = attachments.some((ref) => ref.refId === candidate.refId
      && ref.attachmentId === attachmentId
      && ref.subjectKey === candidate.subjectKey
      && ref.contentHash === candidate.contentHash
      && ref.capturedAt === candidate.capturedAt);
    if (!bound) return;
    allowed.add(candidate.refId);
    allowed.add(`attachment:${candidate.contentHash}`);
    allowed.add(`attachment:a-${candidate.contentHash}`);
  };
  for (const groupName of ["basic", "market", "profit", "extended"] as const) {
    const group = productFact[groupName];
    if (!group || typeof group !== "object") continue;
    for (const field of Object.values(group)) {
      if (!field || typeof field !== "object") continue;
      const evidenceRefs = (field as { evidenceRefs?: unknown }).evidenceRefs;
      if (Array.isArray(evidenceRefs)) evidenceRefs.forEach(add);
    }
  }
  for (const conflict of productFact.sourceConflicts ?? []) {
    for (const candidate of conflict.candidates) candidate.evidenceRefs.forEach(add);
  }
  const variation = bundle.variationEvidence;
  if (variation
    && variation.subjectKey === productFact.subjectKey
    && variation.subjectAsin === productFact.basic.asin.value
    && ((variation.outcome === "complete" && variation.completeness === "complete")
      || (variation.outcome === "no_variation_with_evidence" && variation.completeness === "none"))) {
    variation.evidenceRefs.forEach(add);
  }
}

/**
 * Active Research Layer V1 主流程：ProductFact → 确定性计算 → 单次 DeepSeek 综合 → ResearchReport。
 * `synthesisInvoker` 只用于本地测试和故障回放；生产默认严格走 DeepSeek 单节点。
 */
export async function runResearchEngine(
  input: ResearchEngineInput,
  options: { readonly synthesisInvoker?: ResearchSynthesisInvoker; readonly auditDirectory?: string } = {},
): Promise<ResearchReportGeneration> {
  const generatedAt = new Date().toISOString();
  const refs = refsForFact(input);
  const proofRef = refForProductFact(input.productFact);
  // 未附字段级来源的旧事实仍只绑定主 proof；新增字段只绑定其 ProductFact 明确声明的来源。
  const facts = buildResearchFactSnapshot(input.productFact, refs);
  const deterministic = deterministicCalculations(facts, input.economicAssumptions);
  const deterministicGate = evaluateDeterministicRiskGates({ facts, unitEconomics: deterministic });

  // 运行时确定性生成 allowedEvidenceRefs 白名单（门禁铁律：BLOCKED/UNVERIFIED 绝不能进入）
  const allowedRefIds = new Set<string>([proofRef.refId]);
  if (input.researchInputBundle) {
    // Canonical voice projections and their validated source attachments share
    // the existing ref registry; a readable ID alone never grants permission.
    const bundle = input.researchInputBundle;
    const addVoiceRef = (id: string, hash?: string) => {
      const ref = refs.find((candidate) => candidate.refId === id);
      const bound = bundle.sourceEvidenceRefs.find((candidate) => candidate.kind === "attachment"
        && candidate.refId === id && candidate.subjectKey === proofRef.subjectKey
        && candidate.evidenceId === proofRef.evidenceId && candidate.captureId === proofRef.captureId
        && (hash === undefined || candidate.contentHash === hash));
      if (ref && bound) allowedRefIds.add(ref.refId);
    };
    for (const voice of bundle.customerVoiceEvidence ?? []) {
      const id = `attachment:${voice.attachmentId}`;
      addVoiceRef(id, voice.contentHash);
      if (!allowedRefIds.has(id)) continue;
      for (const observation of voice.observations) {
        const sourceId = observation.provenance.sourceAttachmentId;
        if (sourceId && observation.evidenceRefs.includes(`attachment:${sourceId}`)) {
          addVoiceRef(`attachment:${sourceId}`);
        }
      }
    }
    for (const ref of input.researchInputBundle.sourceEvidenceRefs) {
      if (ref.kind === "product_evidence") allowedRefIds.add(ref.refId);
    }
    for (const item of input.researchInputBundle.reviewEvidence ?? []) {
      if (item.attachmentId) {
        allowedRefIds.add(`attachment:${item.attachmentId}`);
        if (item.contentHash) {
          allowedRefIds.add(`attachment:${item.contentHash}`);
          allowedRefIds.add(`attachment:a-${item.contentHash}`);
        }
      }
    }
    for (const item of input.researchInputBundle.keywordEvidence ?? []) {
      if (item.attachmentId) {
        allowedRefIds.add(`attachment:${item.attachmentId}`);
        if (item.contentHash) {
          allowedRefIds.add(`attachment:${item.contentHash}`);
          allowedRefIds.add(`attachment:a-${item.contentHash}`);
        }
      }
    }
    for (const item of input.researchInputBundle.trendObservations ?? []) {
      for (const ref of item.evidenceRefs ?? []) {
        if (typeof ref === "string" && ref.length > 0) allowedRefIds.add(ref);
      }
    }
    addBoundProductFactAttachmentRefs(input.productFact, input.researchInputBundle, allowedRefIds);
  } else {
    for (const ref of refs) {
      allowedRefIds.add(ref.refId);
      if (ref.contentHash) {
        allowedRefIds.add(`attachment:${ref.contentHash}`);
        allowedRefIds.add(`attachment:a-${ref.contentHash}`);
      }
    }
  }
  const allowedEvidenceRefsList = Array.from(allowedRefIds);
  const allowedRefs = refs.filter((ref) => allowedRefIds.has(ref.refId));

  const request = { system: synthesisSystemPrompt(),
    user: promptPayload(input, facts, deterministic, deterministicGate, allowedEvidenceRefsList), config: input.researchConfig };
  const aiConfig = getAiConfig();
  const audit = !options.synthesisInvoker || options.auditDirectory ? startResearchRunAudit(input, {
    ...request, requestedModel: aiConfig.ok ? aiConfig.data.model : null,
    parameters: { temperature: 0, thinking: "disabled", responseFormat: "json_object" },
    whitelistBasis: "refsForFact + bound bundle projections + resolvedRefRegistry",
    allowedEvidenceRefs: allowedEvidenceRefsList, resolvedEvidenceRefs: allowedRefs,
    evidenceVersions: input.researchInputBundle?.sourceEvidenceRefs ?? [],
  }, options.auditDirectory) : null;
  const ai: SynthesisResult = audit && !audit.ready()
    ? { ok: false, data: null, errorCode: "audit_storage_unavailable", providerCallStarted: false }
    : await (options.synthesisInvoker ?? invokeDeepSeek)({ ...request, onProviderResponse: audit?.captureProvider });
  audit?.write("synthesis", ai);
  const causes: { rawIndex: number; finalIndex: number | null }[] = [];
  let retained = 0;
  const narratives = reviewResearchNarratives(aiNarratives({ draft: ai.data, refs: allowedRefs, allowedIds: allowedRefIds,
    onCause: (rawIndex, keep) => causes.push({ rawIndex, finalIndex: keep ? retained++ : null }) }), input);
  const reportCore: ResearchReportCore = {
    schema: RESEARCH_REPORT_SCHEMA,
    taskId: input.taskId,
    candidateId: input.candidateId,
    runId: input.runId,
    subjectKey: input.productFact.subjectKey,
    generatedAt,
    generationStatus: ai.ok ? "completed" : "degraded",
    node: RESEARCH_SYNTHESIS_NODE,
    facts,
    executiveSummary: narratives.executiveSummary,
    marketOpportunity: {
      facts: facts.market,
      analysis: narratives.marketOpportunity.analysis,
    },
    competitionInsight: narratives.competitionInsight,
    vocAnalysis: narratives.vocAnalysis,
    unitEconomics: {
      facts: {
        price: facts.basic.price,
        fbaFee: facts.profit.fbaFee,
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        // G2-A：第三方估算毛利率原样投影（estimate），供人阅读；
        // 不参与 `deterministic.grossProfit`（后者在缺成本时保持不可计算）。
        estimatedGrossMargin: facts.market.estimatedGrossMargin,
      },
      deterministic,
      analysis: narratives.unitEconomics.analysis,
    },
    supplyChain: {
      facts: {
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        itemWeight: facts.profit.itemWeight,
        itemDimensions: facts.profit.itemDimensions,
      },
      analysis: narratives.supplyChain.analysis,
    },
    riskAssessment: {
      ...narratives.riskAssessment,
      deterministicGate,
    },
    citationIndex: citationIndexOf(facts, narratives),
    unverifiedAssumptions: narratives.unverifiedAssumptions,
    ai: {
      provider: "deepseek",
      status: ai.ok ? "completed" : "degraded",
      errorCode: ai.errorCode,
      errorDetail: ai.errorDetail ?? null,
      // P5-04：模型名与 usage 必须随报告落盘，否则无法复核真实费用。
      // 缺失时保持 null（不填 0），并由调用方按「不可核算」处理。
      model: ai.diagnostics?.model ?? null,
      requestedModel: ai.diagnostics?.requestedModel ?? null,
      modelMismatch: ai.diagnostics?.modelMismatch === true,
      usage: {
        promptTokens: ai.diagnostics?.promptTokens ?? null,
        completionTokens: ai.diagnostics?.completionTokens ?? null,
        totalTokens: ai.diagnostics?.totalTokens ?? null,
        elapsedMs: typeof ai.diagnostics?.elapsedMs === "number" ? ai.diagnostics.elapsedMs : null,
      },
    },
  };
  let report: ResearchReport = {
    ...reportCore,
    decisionSummary: buildDecisionSummary(reportCore),
  };
  if (audit) {
    audit.write("parsing", auditResearchParsing(input, ai.data, report, resolvedRefRegistry(allowedRefs, allowedRefIds), causes));
    audit.write("outcome", { ok: ai.ok, providerCallStarted: ai.providerCallStarted, errorCode: ai.errorCode,
      model: report.ai.model, usage: report.ai.usage, cost: researchUsageCost(report) });
    report = audit.finish(report, ai.providerCallStarted, hashReport);
  }
  return {
    report,
    reportHash: hashReport(report),
    generatedAt,
    aiProviderCallStarted: ai.providerCallStarted,
  };
}
