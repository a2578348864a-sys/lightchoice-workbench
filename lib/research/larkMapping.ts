import { decisionSummaryOf } from "./decisionSummary";
import type {
  ResearchDecision,
  ResearchExportRecord,
  ResearchReport,
} from "./researchContracts";
import { buildResearchExportRecord, SALES_ESTIMATE_NOTICE } from "./exportRecord";

/**
 * 飞书多维表格（Lark Base）标准记录平铺结构。
 * 遵循六大业务分组：商品信息、市场数据、研究结论、人工决策、风险、证据。
 */
export type LarkBaseRecord = {
  readonly 商品信息: {
    readonly 图片: string | null;
    readonly ASIN: string | null;
    readonly 商品标题: string | null;
    readonly 类目: string | null;
  };
  readonly 市场数据: {
    readonly 当前售价: number | null;
    readonly 当前售价币种: string | null;
    readonly 月销量: number | null;
    readonly BSR: number | null;
  };
  readonly 研究结论: {
    readonly 研究优先级: "P1" | "P2" | "P3";
    readonly 核心摘要: string | null;
    readonly 核心机会: string | null;
  };
  readonly 人工决策: {
    readonly 决策状态: string | null;
    readonly 下一步动作: string | null;
    readonly 决策备注: string | null;
  };
  readonly 风险: readonly string[];
  readonly 证据: {
    readonly 报告指纹: string;
    readonly 生成时间: string;
    readonly 引用数量: number;
  };
};

/**
 * 保持向前兼容性的旧结构类型。
 */
export type LarkBaseFields = {
  readonly 商品信息: {
    readonly 图片: string | null;
    readonly ASIN: string | null;
    readonly 商品标题: string | null;
    readonly 类目: string | null;
  };
  readonly 市场数据: {
    readonly 当前售价: number | null;
    readonly 当前售价币种: string | null;
    readonly 月销量: number | null;
    readonly 月销售额: number | null;
    readonly 月销售额币种: string | null;
    readonly BSR: number | null;
    readonly 上架时间: string | null;
  };
  readonly 竞争分析: string | null;
  readonly 研究结论: {
    readonly 研究优先级: "P1" | "P2" | "P3";
    readonly 研究状态: "已生成" | "降级报告";
    readonly 下一步动作: "继续研究" | "补充数据" | "暂停";
    readonly 核心机会: string | null;
    readonly 核心风险: readonly string[];
    readonly 缺失数据: readonly string[];
  };
  readonly 利润分析: {
    readonly FBA费: number | null;
    readonly FBA费币种: string | null;
    readonly 包装重量: number | null;
    readonly 包装重量单位: string | null;
    readonly 包装尺寸: string | null;
    readonly 已知扣除FBA后金额: number | null;
    readonly 已知扣除FBA后金额币种: string | null;
    readonly 毛利: number | null;
    readonly 说明: string;
  };
  readonly 风险: readonly string[];
  readonly AI建议: string | null;
  readonly 人工决策状态: string | null;
  readonly 研究链接: string | null;
};

export type LarkMappingContext = {
  readonly decisionStatus?: string | null;
  readonly researchLink?: string | null;
};

function textOf(value: { text: string | null } | null | undefined): string | null {
  const text = value?.text?.trim();
  return text || null;
}

function textsOf(values: readonly { text: string | null }[]): string[] {
  return values
    .map((value) => value.text?.trim() ?? "")
    .filter(Boolean);
}

function dimensionsText(value: ResearchReport["facts"]["profit"]["packageDimensions"]["value"]): string | null {
  if (!value) return null;
  return `${value.length} × ${value.width} × ${value.height} ${value.unit}`;
}

/**
 * Task 2 核心实现：将 ResearchExportRecord 转换为稳定平铺的飞书多维表格结构。
 * 纯函数，不执行网络请求，不写入飞书，仅映射已确立的字段。
 */
export function mapResearchExportToLarkRecord(
  exportRecord: ResearchExportRecord,
): LarkBaseRecord {
  // RESEARCH-001：人工复核针对的是旧版报告时，不能沿用旧状态冒充新报告的人工背书。
  // 用既有的 "待复核" 值域表达（需重新复核），并在风险清单显式提示原因。
  const reviewStale = exportRecord.humanDecision?.reviewStale === true || exportRecord.evidence.claimAuditVerdict === "BLOCKED" || exportRecord.evidence.claimAuditVerdict === "UNAVAILABLE";
  const risks = [...exportRecord.research.risks];
  if (exportRecord.market.sales !== null && !risks.includes(SALES_ESTIMATE_NOTICE)) {
    risks.push(SALES_ESTIMATE_NOTICE);
  }
  if (reviewStale) {
    risks.push("【系统提示】本行人工复核针对旧版报告（报告已重新生成），人工结论需重新确认。");
  }

  return {
    商品信息: {
      图片: exportRecord.product.image,
      ASIN: exportRecord.product.asin,
      商品标题: exportRecord.product.title,
      类目: exportRecord.product.category,
    },
    市场数据: {
      当前售价: exportRecord.market.price?.amount ?? null,
      当前售价币种: exportRecord.market.price?.currency ?? null,
      月销量: exportRecord.market.sales,
      BSR: exportRecord.market.bsr,
    },
    研究结论: {
      研究优先级: exportRecord.research.priority,
      核心摘要: exportRecord.research.summary,
      核心机会: exportRecord.research.opportunity,
    },
    人工决策: {
      决策状态: reviewStale ? "待复核" : (exportRecord.humanDecision?.status ?? "待复核"),
      下一步动作: exportRecord.humanDecision?.nextAction ?? "待定",
      决策备注: exportRecord.humanDecision?.notes ?? null,
    },
    风险: risks,
    证据: {
      报告指纹: exportRecord.evidence.reportHash,
      生成时间: exportRecord.evidence.generatedAt,
      // RESEARCH-002：整份报告的引用数量（事实字段 ∪ AI narrative，按 refId 去重）。
      引用数量: exportRecord.evidence.citationCount,
    },
  };
}

/**
 * 便捷纯函数：输入已有的 ResearchReport + ResearchDecision，直接生成 LarkBaseRecord。
 */
export function mapResearchToLarkRecord(
  report: ResearchReport,
  decision?: ResearchDecision | null,
  options?: { reportHash?: string; taskId?: string; candidateId?: string },
): LarkBaseRecord {
  const exportRecord = buildResearchExportRecord({
    taskId: options?.taskId ?? report.taskId,
    candidateId: options?.candidateId ?? report.candidateId,
    report,
    reportHash: options?.reportHash ?? "unhashed",
    decision,
  });
  return mapResearchExportToLarkRecord(exportRecord);
}

/**
 * 兼容包装器：保持对既有 mapReportToLarkFields 的 100% 向后兼容。
 */
export function mapReportToLarkFields(
  report: ResearchReport,
  context: LarkMappingContext = {},
): LarkBaseFields {
  const basic = report.facts.basic;
  const market = report.facts.market;
  const profit = report.facts.profit;
  const economics = report.unitEconomics;
  const decisionSummary = decisionSummaryOf(report);
  // 兼容入口必须复用相同消费投影，不能绕过新入口的证据强度审查。
  const safeRecord = buildResearchExportRecord({ taskId: report.taskId, candidateId: report.candidateId, report, reportHash: "unhashed" });
  const risks = [...safeRecord.research.risks];
  const claimBlocked = safeRecord.evidence.claimAuditVerdict === "BLOCKED" || safeRecord.evidence.claimAuditVerdict === "UNAVAILABLE";
  if (market.monthlyRevenueEstimate.value !== null) risks.push("【估算口径】月销售额是来源估算，不是已确认经营事实。");
  const aiSuggestion = [
    safeRecord.research.summary,
    ...[textOf(report.competitionInsight.analysis), ...textsOf(report.competitionInsight.differentiationSuggestions)]
      .filter((text): text is string => Boolean(text)).map((text) => `【AI待人工复核，不作为确认结论】${text}`),
  ].filter((value): value is string => Boolean(value)).join("\n").trim() || null;

  return {
    商品信息: {
      图片: basic.image.value,
      ASIN: basic.asin.value,
      商品标题: basic.title.value,
      类目: basic.category.value,
    },
    市场数据: {
      当前售价: basic.price.value?.amount ?? null,
      当前售价币种: basic.price.value?.currency ?? null,
      月销量: market.monthlySalesEstimate.value,
      月销售额: market.monthlyRevenueEstimate.value?.amount ?? null,
      月销售额币种: market.monthlyRevenueEstimate.value?.currency ?? null,
      BSR: market.bsr.value,
      上架时间: market.launchedDate.value,
    },
    竞争分析: textOf(report.competitionInsight.analysis) ? `【AI待人工复核，不作为确认结论】${textOf(report.competitionInsight.analysis)}` : null,
    研究结论: {
      研究优先级: decisionSummary.researchPriority,
      研究状态: report.generationStatus === "completed" ? "已生成" : "降级报告",
      下一步动作: claimBlocked ? "补充数据" : decisionSummary.recommendedNextAction,
      核心机会: safeRecord.research.opportunity,
      核心风险: decisionSummary.blockingRisks.map((text) => `【AI待人工复核】${text}`),
      缺失数据: decisionSummary.missingInformation,
    },
    利润分析: {
      FBA费: profit.fbaFee.value?.amount ?? null,
      FBA费币种: profit.fbaFee.value?.currency ?? null,
      包装重量: profit.packageWeight.value?.value ?? null,
      包装重量单位: profit.packageWeight.value?.unit ?? null,
      包装尺寸: dimensionsText(profit.packageDimensions.value),
      已知扣除FBA后金额: economics.deterministic.knownRevenueAfterFbaFee.value?.amount ?? null,
      已知扣除FBA后金额币种: economics.deterministic.knownRevenueAfterFbaFee.value?.currency ?? null,
      毛利: economics.deterministic.grossProfit.value?.amount ?? null,
      说明: economics.deterministic.grossProfit.reason
        ?? "毛利未计算。",
    },
    风险: risks,
    AI建议: aiSuggestion,
    人工决策状态: claimBlocked ? "待复核" : (context.decisionStatus?.trim() || null),
    研究链接: context.researchLink?.trim() || null,
  };
}
