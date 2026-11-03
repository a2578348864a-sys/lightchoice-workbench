import { classifyProblemNature, type ProblemNature } from "./competitiveExplanations";

/**
 * 研究结论的证据强度审查（确定性、只读、不调用模型）。
 *
 * 真实问题（P5-v6 业务验证）：
 *  - 风险段写「月销量缺失，无法核算」，机会段却用「近月购买量约 600 件」推出「现成需求验证」；
 *  - 8 条评论写成「多条评论」，3 条痛点共用 1 个引用；
 *  - 「薄 / 软 / 尺寸差 1 英寸」被写成产品缺陷。
 * 这些都不是"措辞不好看"，而是同一份报告里结论强度超过了证据强度。
 *
 * 本模块只做判定与降级建议，不改写原文、不生成新事实：
 *  - 结构化前置条件（销量可用性 / 阅读评论数 / 引用独立性）优先，文本模式只用于定位句子；
 *  - BLOCKING = 该句不能作为结论使用（下游不得据此立项或派生改良）；
 *  - WARNING  = 表述强度超过证据，应加基数/降级措辞。
 */

export type EvidenceGrade = "CONFIRMED" | "ESTIMATED" | "OBSERVED" | "HYPOTHESIS" | "NOT_AVAILABLE";

/**
 * 从 MarketScan.metrics 读取销量数据的**可用性与性质**（纯函数，服务端/测试共用）。
 *
 * 关键事实（易被误判）：
 *  - `metrics.sales.status === "PRESENT"` 时，`value` 是**分布对象**
 *    `{total,mean,median,p25,p75,min,max,distribution}`，不是数字；
 *    把对象当数字判断会把「有数据」误判成「不可用」。
 *  - 该字段来自 `market.monthlySalesEstimate`，即使 PRESENT 也仍是**估算**，
 *    不能升级为已确认销量。
 */
export function salesAvailabilityFromMetrics(metrics: unknown): {
  readonly grade: EvidenceGrade;
  readonly sampleSize: number | null;
  readonly missingCount: number | null;
  readonly note: string;
} {
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const sales = record(metrics) && record(metrics.sales) ? metrics.sales : null;
  const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const sampleSize = count(sales?.sampleSize);
  const missingCount = count(sales?.missingCount);
  const status = sales && typeof sales.status === "string" ? sales.status.toUpperCase() : "";
  if (!sales || status !== "PRESENT") {
    return { grade: "NOT_AVAILABLE", sampleSize, missingCount, note: "市场层没有可用销量数据（缺失或不可用），不能据此确认销量或动销。" };
  }
  // 保留旧有限非负数字合同；分布对象必须包含完整、有限的统计值，空对象不算有数据。
  const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const statistics = ["mean", "median", "p25", "p75", "min", "max"] as const;
  const value = sales.value;
  const distribution = record(value) && record(value.distribution) ? value.distribution : null;
  const hasValue = nonNegative(value) || (record(value) && nonNegative(value.total)
    && statistics.every((key) => nonNegative(value[key]))
    && distribution !== null && statistics.every((key) => nonNegative(distribution[key]))
    && count(distribution.sampleSize) !== null && count(distribution.missingCount) !== null
    && distribution.sampleSize === sampleSize && distribution.missingCount === missingCount
    && sampleSize !== null && sampleSize > 0
    && Number(value.min) <= Number(value.p25) && Number(value.p25) <= Number(value.median) && Number(value.median) <= Number(value.p75) && Number(value.p75) <= Number(value.max)
    && Number(value.min) <= Number(value.mean) && Number(value.mean) <= Number(value.max)
    && statistics.every((key) => value[key] === distribution[key]));
  if (!hasValue) {
    return { grade: "NOT_AVAILABLE", sampleSize, missingCount, note: "销量字段标记为可用但缺少数值，按不可用处理。" };
  }
  return {
    grade: "ESTIMATED",
    sampleSize,
    missingCount,
    note: `销量来自估算字段（monthlySalesEstimate），样本 ${sampleSize ?? "未知"} 款；可作为线索，不能当作已确认销量。`,
  };
}

export type ClaimIssueCode =
  | "ESTIMATE_AS_CONFIRMED"
  | "MISSING_DATA_USED"
  | "SINGLE_SOURCE_AS_MULTIPLE"
  | "SAMPLE_AS_POPULATION"
  | "PROPERTY_AS_DEFECT";

export type ClaimFlag = {
  readonly code: ClaimIssueCode;
  readonly severity: "BLOCKING" | "WARNING";
  readonly field: "summary" | "opportunities" | "risks" | "painPoints";
  readonly index: number;
  /** 原文（不改写）。 */
  readonly text: string;
  /** 为什么判定为超强度。 */
  readonly reason: string;
  /** 建议的降级表述（供人工修改，不自动写入报告）。 */
  readonly suggested: string;
};

export type ResearchClaimAudit = {
  readonly schema: "research-claim-audit.v1";
  readonly verdict: "CONSISTENT" | "NEEDS_DOWNGRADE" | "BLOCKED" | "UNAVAILABLE";
  readonly marketData: {
    /** 市场层销量数据可用性（NOT_AVAILABLE 表示市场样本内没有可用销量字段）。 */
    readonly salesGrade: EvidenceGrade;
    /** 商品总评论数（已持久化事实，可为空）。 */
    readonly reviewBase: number | null;
    /** 研报自述的阅读评论数（来自研报文本，无法独立核实）。 */
    readonly reviewRead: number | null;
    readonly reviewReadSource: "REPORT_TEXT" | "UNKNOWN";
    /** 痛点引用独立性：引用总数 / 唯一引用数。 */
    readonly painReferences: { readonly total: number; readonly unique: number };
  };
  readonly flags: readonly ClaimFlag[];
  readonly blockingCount: number;
  readonly warningCount: number;
  /** 一句话给用户看的结论。 */
  readonly headline: string;
};

const MOVEMENT_TOKENS = /购买量|购买人数|人购买|件\/月|近月购买|月销/;
const CERTAINTY_TOKENS = /动销|走量|稳定(?:成交|需求|销量|口碑)|现成需求|适合.{0,6}选品|已有.{0,4}需求|机会点|值得开发/;
const ESTIMATE_MARKERS = /估算|未经核实|未核实|页面展示|未经确认|不能据此/;
const POPULATION_TOKENS = /代表|普遍|多数|趋势|发生率|比例|统计|显著性/;
const MULTI_PERSON_TOKENS = /多条评论|多位买家|多个买家|多名买家/;

function countReadFromSummary(summary: string | null): number | null {
  if (!summary) return null;
  const match = /(\d{1,3})\s*条[^。；]{0,6}评论/u.exec(summary);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function uniqueRefs(list: readonly { readonly evidenceRefs: readonly string[] }[]): number {
  return new Set(list.flatMap((item) => item.evidenceRefs)).size;
}

export function auditResearchClaims(input: {
  readonly summary: string | null;
  readonly opportunities: readonly string[];
  readonly risks: readonly string[];
  readonly painPoints: readonly { readonly text: string; readonly evidenceRefs: readonly string[] }[];
  readonly salesGrade: EvidenceGrade;
  readonly reviewBase: number | null;
}): ResearchClaimAudit {
  const flags: ClaimFlag[] = [];
  const reviewRead = countReadFromSummary(input.summary ?? null);
  const refTotal = input.painPoints.reduce((sum, pain) => sum + pain.evidenceRefs.length, 0);
  const refUnique = uniqueRefs(input.painPoints);
  const salesUnconfirmed = input.salesGrade !== "CONFIRMED";
  const thinSample = reviewRead === null || reviewRead <= 10;
  const entries: { text: string; field: ClaimFlag["field"]; index: number }[] = [
    ...(input.summary ? [{ text: input.summary, field: "summary" as const, index: 0 }] : []),
    ...input.opportunities.map((text, index) => ({ text, field: "opportunities" as const, index })),
    ...input.risks.map((text, index) => ({ text, field: "risks" as const, index })),
    ...input.painPoints.map((pain, index) => ({ text: pain.text, field: "painPoints" as const, index })),
  ];
  for (const entry of entries) {
    // 按分句检查：一句“不代表”不能豁免另一句肯定结论；问句/明确未知保持正常。
    for (const sentence of entry.text.split(/[。；;！!\n]|但是|但(?=已|说明|证实|表明|可以|值得|需求|销量)/u).filter(Boolean)) {
      const bounded = /不能|无法|不足以|不代表|不宜|不应|并非|尚不能|尚未|未确认|未证实|待核实|待验证|是否|未知|缺失|不可用|未提供|没有可用|不确定/u.test(sentence);
      const assertive = CERTAINTY_TOKENS.test(sentence) || /证明|证实|确认|验证了|需求验证|说明.{0,10}(?:成交|需求|销量)|需求.{0,8}(?:稳定|成立|验证)|销量.{0,8}(?:稳定|确认)/u.test(sentence);
      const salesClaim = MOVEMENT_TOKENS.test(sentence) || /销量|成交|需求验证|需求稳定|稳定需求|动销|走量/u.test(sentence);
      const estimated = ESTIMATE_MARKERS.test(sentence);
      const add = (code: ClaimIssueCode, severity: ClaimFlag["severity"], reason: string, suggested: string) => {
        if (!flags.some((flag) => flag.code === code && flag.field === entry.field && flag.index === entry.index)) {
          flags.push({ code, severity, field: entry.field, index: entry.index, text: entry.text, reason, suggested });
        }
      };
      if (salesUnconfirmed && !bounded && salesClaim && assertive) {
        add("ESTIMATE_AS_CONFIRMED", "BLOCKING", input.salesGrade === "ESTIMATED"
          ? "销量来自 monthlySalesEstimate 估算，不能据此确认动销、稳定需求或开发价值。"
          : `销量未经确认（${input.salesGrade}），该句却把销量/成交线索升级为确认结论。`,
        "购买量为估算或待核实线索，不能据此确认销量、稳定需求或开发价值；补证后由人工判断。");
      } else if (salesUnconfirmed && !bounded && !estimated && /销量|成交|需求验证/u.test(sentence)) {
        add("MISSING_DATA_USED", "BLOCKING", `销量未经确认（${input.salesGrade}），该句未保留估算/待核实边界。`,
          "标注估算或待核实性质，当前只作调查线索，不能作为立项依据。");
      }
      if (!bounded && MULTI_PERSON_TOKENS.test(sentence) && thinSample) {
        add("SINGLE_SOURCE_AS_MULTIPLE", "WARNING", reviewRead === null
          ? "研报未写明实际读取评论条数，独立来源数量无法核实。"
          : `研报自述读取 ${reviewRead} 条评论，应给出提及该问题的独立评论数。`,
        reviewRead === null ? "标明读取条数未知，补齐评论级来源后再概括。" : `改为“读取的 ${reviewRead} 条评论中有 N 条提到”，N需独立来源支持。`);
      }
      if (!bounded && POPULATION_TOKENS.test(sentence) && /评论|买家|体验|问题|口碑|发生率|普遍|多数/u.test(sentence) && thinSample) {
        add("SAMPLE_AS_POPULATION", "WARNING", "少量或未知数量的公开评论不支持总体发生率、代表性或普遍性。",
          "限定为已读取样本内的观察，不推断总体比例或品类共性。");
      }
      // 单条/少量评论只能作为样本内观察；不能仅凭“买家反馈存在……痛点”升级为买家痛点。
      // 明确写成单条/个别/样本内观察，或带“不能代表整体”等边界时保持原样。
      if (!bounded && thinSample
        && /(?:痛点|反馈存在|买家反馈.{0,24}(?:问题|痛点)|评价指出.{0,24}(?:问题|痛点))/u.test(sentence)
        && /(?:评论|评价|买家|反馈)/u.test(sentence)
        && !/(?:单条|个别|少数|样本内|仅\s*\d+\s*条|共\s*\d+\s*条|读取的\s*\d+\s*条)/u.test(sentence)) {
        add("SAMPLE_AS_POPULATION", "WARNING",
          "样本过少或读取条数未知，不能把单条/少量评论概括为买家痛点。",
          "只写读取样本内的单条/少量观察，保留正面限定与反例；扩大样本后再判断。");
      }
    }
    if (entry.field === "painPoints" && classifyProblemNature(entry.text).nature === "PROPERTY_OBSERVATION"
      && !/不能.{0,8}(?:缺陷|判断)|不等于.{0,8}缺陷|尚不能|待核实|待验证/u.test(entry.text)) {
      flags.push({ code: "PROPERTY_AS_DEFECT", severity: "WARNING", ...entry,
        reason: "该条更像产品属性或使用情境观察，尚不能据此认定缺陷或指定改良方案。",
        suggested: "保留属性观察，区分品类设计、价格取舍、规格不符与预期偏差，待核实后再决定是否改良。" });
    }
  }

  const blockingCount = flags.filter((flag) => flag.severity === "BLOCKING").length;
  const warningCount = flags.length - blockingCount;
  const verdict = blockingCount > 0 ? "BLOCKED" : warningCount > 0 ? "NEEDS_DOWNGRADE" : "CONSISTENT";
  const headline = verdict === "BLOCKED"
    ? `发现 ${blockingCount} 处结论强度超过证据（销量/成交类），不能作为立项依据；另有 ${warningCount} 处表述需降级。`
    : verdict === "NEEDS_DOWNGRADE"
      ? `未发现销量类越级结论，但有 ${warningCount} 处表述强度超过证据（样本代表性/属性当缺陷），需降级阅读。`
      : "未发现结论强度超过证据的表述（按当前结构化口径）。";

  return {
    schema: "research-claim-audit.v1",
    verdict,
    marketData: {
      salesGrade: input.salesGrade,
      reviewBase: input.reviewBase,
      reviewRead,
      reviewReadSource: reviewRead === null ? "UNKNOWN" : "REPORT_TEXT",
      painReferences: { total: refTotal, unique: refUnique },
    },
    flags,
    blockingCount,
    warningCount,
    headline,
  };
}

/** 审查读取/解析失败必须显式不可用；零flags不代表通过，消费者必须检查verdict。 */
export function makeUnavailableClaimAudit(reason = "研究证据审查暂不可用，请核对来源后重试。"): ResearchClaimAudit {
  return {
    schema: "research-claim-audit.v1",
    verdict: "UNAVAILABLE",
    marketData: { salesGrade: "NOT_AVAILABLE", reviewBase: null, reviewRead: null,
      reviewReadSource: "UNKNOWN", painReferences: { total: 0, unique: 0 } },
    flags: [], blockingCount: 0, warningCount: 0,
    headline: reason,
  };
}

/** 供 UI 复用的属性/缺陷判断（与 audit 同源）。 */
export function problemNatureOf(text: string): ProblemNature {
  return classifyProblemNature(text).nature;
}
