/**
 * VOC 规则版本（唯一来源 · 不在其他文件重复硬编码）。
 *
 * 变更历史：
 * - v1：初始主题词典与五类意图规则（PR #116 之前，当时未做版本记录）。
 * - v2：PR #116——否定范围（`zero leaks`）与食物滑落（`salmon slid right off`）误判修复。
 * - v3：PR #117——假设性担忧（`worried…would arrive broken`）误判与部件松脱（`handles fall off`）漏判修复。
 *
 * 边界：
 * - 历史研报/咨询记录若未保存生成时的版本，读侧一律标记 UNKNOWN，不伪造旧版本。
 * - 本文件只提供版本标识与读侧时效判定，不参与 reportHash/stale 合同（避免历史数据批量失效）。
 */

export const VOC_RULE_VERSION = "voc-rules.v3" as const;

export type VocRuleCurrencyStatus = "current" | "outdated" | "unknown";

export type VocRuleCurrency = {
  status: VocRuleCurrencyStatus;
  /** 需要向用户展示的提示；current 时为 null。 */
  hint: string | null;
};

/** 解析 `voc-rules.v<N>` 的数字后缀；无法解析时返回 null。 */
function parseRuleVersionNumber(version: string): number | null {
  const match = /^voc-rules\.v(\d+)$/u.exec(version.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 读侧规则时效判定（纯函数 · 不写任何状态 · 不参与 stale 门禁）：
 *
 * - 记录版本与当前一致 → `current`（无需提示）；
 * - 记录版本是可解析的旧版本 → `outdated`（结论可能需要重新核对；
 *   差异也可能来自规则词典覆盖范围不同，不一定是旧结论错误）；
 * - 未记录版本 / 无法解析 → `unknown`（无法证明依赖关系，不批量判 stale，
 *   也不编造旧报告使用的具体规则版本）。
 */
export function describeVocRuleCurrency(storedRuleVersion: string | null | undefined): VocRuleCurrency {
  if (typeof storedRuleVersion !== "string" || storedRuleVersion.trim() === "") {
    return {
      status: "unknown",
      hint: "该研报生成时未记录 VOC 规则版本，无法自动判断其评论分析是否需要按新规则重新核对。",
    };
  }
  const stored = storedRuleVersion.trim();
  if (stored === VOC_RULE_VERSION) return { status: "current", hint: null };
  const storedNumber = parseRuleVersionNumber(stored);
  const currentNumber = parseRuleVersionNumber(VOC_RULE_VERSION);
  if (storedNumber === null || currentNumber === null) {
    return {
      status: "unknown",
      hint: `该研报记录的 VOC 规则版本（${stored}）无法识别，无法自动判断其评论分析是否需要按新规则重新核对。`,
    };
  }
  if (storedNumber < currentNumber) {
    return {
      status: "outdated",
      hint: `该研报生成于 VOC 规则 ${stored}，当前规则已更新为 ${VOC_RULE_VERSION}；其评论分析结论可能需要按新规则重新核对（差异也可能来自规则词典覆盖范围不同，不一定是旧结论错误）。`,
    };
  }
  // 记录版本不旧于当前（含高于当前的异常回滚场景）：无需重新核对。
  return { status: "current", hint: null };
}
