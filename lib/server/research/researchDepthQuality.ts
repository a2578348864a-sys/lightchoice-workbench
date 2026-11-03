import {
  isVerifiedNarrative,
  type ResearchNarrative,
  type ResearchReport,
} from "@/lib/research/researchContracts";

/**
 * P2-02 / P5-01 的离线研究深度门禁。
 *
 * 这不是模型裁判，也不声称能自动判断一段中文是否真的解释了工程根因。
 * 它只做可机械验证的最低合同检查：正式结论必须有合法引用，改良建议必须
 * 同时暴露代价和证伪/停止动作，风险必须有停止条件和下一步，购买价值必须
 * 仍然是待验证假设。所有通过结构门禁的输出仍标记为需要人工语义审阅。
 */

export const RESEARCH_DEPTH_RUBRIC_VERSION = "research-depth.v1" as const;

export type ResearchDepthSemanticSampleId =
  | "same_complaint_different_causes"
  | "packaging_or_instruction_alternative"
  | "better_performance_acquisition_constraint"
  | "cannot_manufacture_or_profit_stop";

export type ResearchDepthSemanticSample = {
  readonly id: ResearchDepthSemanticSampleId;
  readonly title: string;
  readonly scenario: string;
  readonly mustReview: readonly string[];
  readonly forbiddenShortcuts: readonly string[];
};

/**
 * 小而有区分力的离线语义样本目录。样本描述本身不包含真实商品、供应商或
 * 模型输出，后续可由同一 rubric 回放合成报告或经授权的已存报告。
 */
export const RESEARCH_DEPTH_SEMANTIC_SAMPLES: readonly ResearchDepthSemanticSample[] = [
  {
    id: "same_complaint_different_causes",
    title: "相同投诉，不同可能原因",
    scenario: "同一漏水投诉可能来自密封结构、装配误差、使用方式或说明缺失。",
    mustReview: ["是否列出至少两种可区分的原因假设", "是否给出能区分原因的最低成本验证"],
    forbiddenShortcuts: ["把投诉直接写成已证明的材料或工程根因", "只返回需要人工判断"],
  },
  {
    id: "packaging_or_instruction_alternative",
    title: "包装/说明替代结构改良",
    scenario: "先比较包装或说明改良是否能降低误用，再决定是否值得改结构。",
    mustReview: ["是否说明结构改良与包装/说明方案的差异和副作用", "是否写出不改或缩小场景的停止条件"],
    forbiddenShortcuts: ["把包装改善承诺为销量提升", "把替代方案写成已验证工程结果"],
  },
  {
    id: "better_performance_acquisition_constraint",
    title: "性能更好但获客受限",
    scenario: "性能改良可能提高使用体验，但价格、外观或关键词竞争可能限制购买与获客。",
    mustReview: ["是否同时呈现性能收益、购买价值假设和获客约束", "是否给出验证购买价值的证据而非承诺销量"],
    forbiddenShortcuts: ["把性能更好等同于一定会卖得更多", "把口头喜欢等同于付款意愿"],
  },
  {
    id: "cannot_manufacture_or_profit_stop",
    title: "无法制造或无法盈利时停止",
    scenario: "没有可行工艺、报价或成本边界时，研究应允许停止而不是凑一个改良方向。",
    mustReview: ["是否明确不可制造/不可盈利的证据缺口", "是否给出停止、放弃或缩小场景的条件"],
    forbiddenShortcuts: ["无报价却填写精确供应商成本", "以估算利润替代真实成本证据"],
  },
];

export type ResearchDepthAssessment = {
  readonly rubricVersion: typeof RESEARCH_DEPTH_RUBRIC_VERSION;
  readonly automatedStatus: "pass" | "hard_fail";
  readonly humanReviewStatus: "pending";
  readonly hardFailures: readonly string[];
  readonly checks: Readonly<Record<string, "pass" | "fail">>;
  /**
   * P2-02：需要专业判断、不能机械硬拒绝的可解释提示。
   * 这些提示不改变 automatedStatus，只供离线验收与人工评审阅读。
   */
  readonly advisories: readonly string[];
  readonly semanticSampleIds: readonly ResearchDepthSemanticSampleId[];
};

export type ResearchDepthReportLike = Pick<
  ResearchReport,
  "marketOpportunity" | "competitionInsight" | "vocAnalysis" | "riskAssessment"
>;

function textOf(value: ResearchNarrative | null | undefined): string {
  return typeof value?.text === "string" ? value.text.trim() : "";
}

function listText(values: readonly ResearchNarrative[] | null | undefined): string {
  return (values ?? []).map(textOf).filter(Boolean).join("；");
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isGenericOnly(text: string): boolean {
  if (!text) return true;
  const normalized = text.replace(/[。；;.!！\s]/gu, "");
  return /^(需要人工判断|建议优化|风险可控|请人工判断|待进一步研究)$/u.test(normalized);
}

/**
 * 对已生成的 ResearchReport 做最低结构门禁；不会将结果标成“语义质量通过”。
 */
export function assessResearchDepth(report: ResearchDepthReportLike): ResearchDepthAssessment {
  const competition = textOf(report.competitionInsight.analysis);
  const suggestions = listText(report.competitionInsight.differentiationSuggestions);
  const supportingEvidence = report.competitionInsight.supportingEvidence ?? [];
  const counterevidence = report.competitionInsight.counterevidence ?? [];
  const competitionVerification = report.competitionInsight.verificationItems ?? [];
  const riskVerification = report.riskAssessment.verificationItems ?? [];
  const market = textOf(report.marketOpportunity.analysis);
  const voc = [textOf(report.vocAnalysis.analysis), listText(report.vocAnalysis.painPoints)].filter(Boolean).join("；");
  const risks = [textOf(report.riskAssessment.analysis), listText(report.riskAssessment.risks)].filter(Boolean).join("；");
  const failures: string[] = [];

  const checks: Record<string, "pass" | "fail"> = {};
  const verified = (value: ResearchNarrative | null | undefined) => isVerifiedNarrative(value);
  checks.competitionEvidence = verified(report.competitionInsight.analysis) ? "pass" : "fail";
  checks.marketEvidence = verified(report.marketOpportunity.analysis) ? "pass" : "fail";
  checks.riskEvidence = verified(report.riskAssessment.analysis) ? "pass" : "fail";
  checks.competitionCausalHypothesis = hasAny(competition, [/原因|假设/u]) && hasAny(competition, [/可能错|反证|替代解释|如何证伪/u]) ? "pass" : "fail";
  const suggestionItems = report.competitionInsight.differentiationSuggestions;
  checks.differentiationEvidence = suggestionItems.length > 0 && suggestionItems.every(isVerifiedNarrative) ? "pass" : "fail";
  checks.differentiationTradeoff = suggestionItems.length > 0 && suggestionItems.every((item) => hasAny(textOf(item), [/成本|副作用|代价|更贵|更重|更难/u])) ? "pass" : "fail";
  checks.differentiationStopOrTest = suggestionItems.length > 0 && suggestionItems.every((item) => hasAny(textOf(item), [/验证|证伪|停止|放弃|不改动|缩小目标场景/u])) ? "pass" : "fail";
  checks.marketValueHypothesis = hasAny(market, [/购买价值|为什么会买|愿意购买|价值假设|需要.*证据|验证/u]) ? "pass" : "fail";
  checks.riskStopAndNextAction = hasAny(risks, [/停止|放弃|不再继续|退出/u]) && hasAny(risks, [/验证|下一步|核实|测试|证据/u]) ? "pass" : "fail";
  checks.vocSpecificScenario = voc && hasAny(voc, [/人群|场景|使用|问题|投诉|原声/u]) ? "pass" : "fail";
  // P3-01-B：新版结构化字段出现时，不能只看一段总括文本；支持/反证与验证项
  // 必须各自有可追溯引用。旧报告没有这些字段时保持历史兼容，不凭空硬失败。
  const hasStructuredCompetition = [
    report.competitionInsight.causalHypotheses,
    report.competitionInsight.alternatives,
    report.competitionInsight.supportingEvidence,
    report.competitionInsight.counterevidence,
    report.competitionInsight.verificationItems,
  ].some((value) => value !== undefined);
  checks.structuredSupportAndCounterevidence = !hasStructuredCompetition
    || (supportingEvidence.length > 0
      && counterevidence.length > 0
      && [...supportingEvidence, ...counterevidence].every(isVerifiedNarrative))
    ? "pass"
    : "fail";
  checks.structuredVerification = !hasStructuredCompetition
    || ([...competitionVerification, ...riskVerification].length > 0
      && [...competitionVerification, ...riskVerification].every(isVerifiedNarrative))
    ? "pass"
    : "fail";

  // P2-02（4.1）：逐原因证据对应。只做可机械判定的事：
  // 原因有文本就必须能追溯到证据；有支持证据就必须同时交代反证或未知；
  // 原因必须有各自的低成本验证。语义是否真的成立仍留给人工评审。
  const investigations = report.competitionInsight.causalInvestigations ?? [];
  const advisories: string[] = [];
  if (investigations.length === 0) {
    checks.causalPerCauseTraceability = "pass";
    checks.causalPerCauseUnknowns = "pass";
    checks.causalPerCauseVerification = "pass";
  } else {
    const untraceable = investigations.filter((item) => item.hypothesis.text !== null && item.hypothesis.evidenceRefs.length === 0);
    checks.causalPerCauseTraceability = untraceable.length === 0 ? "pass" : "fail";
    const oneSided = investigations.filter((item) => item.hypothesis.text !== null
      && item.supportingEvidence.length > 0
      && item.counterevidence.length === 0
      && item.unknowns.length === 0);
    checks.causalPerCauseUnknowns = oneSided.length === 0 ? "pass" : "fail";
    const unverified = investigations.filter((item) => item.hypothesis.text !== null && item.verification.length === 0);
    checks.causalPerCauseVerification = unverified.length === 0 ? "pass" : "fail";

    // 以下只作诊断：多条原因共用同一段验证或同一段支持证据，可能是合理的
    // （同一次测试确实能区分两个原因），也可能是互借材料，需人工判断。
    const verificationCounts = new Map<string, number>();
    const supportCounts = new Map<string, number>();
    for (const item of investigations) {
      for (const line of new Set(item.verification.map((value) => value.trim()).filter(Boolean))) verificationCounts.set(line, (verificationCounts.get(line) ?? 0) + 1);
      for (const line of new Set(item.supportingEvidence.map((value) => value.text?.trim() ?? "").filter(Boolean))) supportCounts.set(line, (supportCounts.get(line) ?? 0) + 1);
    }
    const sharedVerification = [...verificationCounts.entries()].filter(([, count]) => count > 1).map(([line]) => line);
    const sharedSupport = [...supportCounts.entries()].filter(([, count]) => count > 1).map(([line]) => line);
    if (sharedVerification.length > 0) advisories.push(`有 ${sharedVerification.length} 条验证动作被多个原因共用，需人工确认它是否真的能区分这些原因。`);
    if (sharedSupport.length > 0) advisories.push(`有 ${sharedSupport.length} 条支持证据被多个原因共用，需人工确认各原因的主张是否被过度借用。`);
    const highWithoutCounter = investigations.filter((item) => item.confidence === "high" && item.counterevidence.length === 0);
    if (highWithoutCounter.length > 0) advisories.push(`有 ${highWithoutCounter.length} 个原因自评高可信度但没有列出任何反证，需人工复核可信度。`);
    const unverifiedCause = investigations.filter((item) => item.hypothesis.text === null);
    if (unverifiedCause.length > 0) advisories.push(`有 ${unverifiedCause.length} 个原因因缺少可追溯证据被降级为待验证方向（已移入未验证假设）。`);
  }

  if (!checks.competitionEvidence || checks.competitionEvidence === "fail") failures.push("competitionInsight.analysis 缺少可追溯证据引用");
  if (checks.marketEvidence === "fail") failures.push("marketOpportunity.analysis 缺少可追溯证据引用");
  if (checks.riskEvidence === "fail") failures.push("riskAssessment.analysis 缺少可追溯证据引用");
  if (checks.competitionCausalHypothesis === "fail") failures.push("竞争分析没有同时呈现原因假设与可能错在哪里");
  if (checks.differentiationEvidence === "fail") failures.push("改良方向缺少可追溯证据引用");
  if (checks.differentiationTradeoff === "fail") failures.push("改良方向没有暴露成本或副作用");
  if (checks.differentiationStopOrTest === "fail") failures.push("改良方向没有证伪方法或停止条件");
  if (checks.marketValueHypothesis === "fail") failures.push("购买价值没有作为假设并写出所需证据");
  if (checks.riskStopAndNextAction === "fail") failures.push("风险没有同时给出停止条件和下一步验证动作");
  if (checks.vocSpecificScenario === "fail") failures.push("VOC 没有呈现具体人群/场景/问题");
  if (checks.structuredSupportAndCounterevidence === "fail") failures.push("新版竞争性解释缺少同时带引用的支持证据与反证");
  if (checks.structuredVerification === "fail") failures.push("新版研究内容缺少带引用的验证或停止事项");
  if (checks.causalPerCauseTraceability === "fail") failures.push("逐原因调查中存在没有可追溯证据的原因假设");
  if (checks.causalPerCauseUnknowns === "fail") failures.push("逐原因调查中存在只有支持证据、既无反证也未标注未知的原因");
  if (checks.causalPerCauseVerification === "fail") failures.push("逐原因调查中存在没有低成本验证或否定方式的原因");

  const keyTexts = [competition, suggestions, market, risks].filter(Boolean);
  if (keyTexts.length === 0 || keyTexts.every(isGenericOnly)) failures.push("研究输出为空或只有泛化占位语");

  return {
    rubricVersion: RESEARCH_DEPTH_RUBRIC_VERSION,
    automatedStatus: failures.length === 0 ? "pass" : "hard_fail",
    humanReviewStatus: "pending",
    hardFailures: failures,
    checks,
    advisories,
    semanticSampleIds: RESEARCH_DEPTH_SEMANTIC_SAMPLES.map((sample) => sample.id),
  };
}

