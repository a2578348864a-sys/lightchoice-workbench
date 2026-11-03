/**
 * P1-VOC-01/02 — VOC 主题 → 改进需求 / 待供应商确认问题（确定性派生，零 AI 自由度）
 *
 * 只加工 voc-analysis.v1 已有主题数据：不新增采集、不调用 LLM、不生成供应链事实。
 * 派生规则（fail-closed）：
 * - improvementRequirements：仅从 strength === "recurring"（≥ VOC_STRENGTH_THRESHOLDS.recurringMin 条评论）
 *   的痛点 / 复现请求主题派生——改进需求要投入开发资源，只认强证据；
 * - supplierCheckpoints：从全部痛点主题派生（验货时多核实一项成本低，弱样本也值得列出，
 *   但每条必须带 reviewCount 让人工判断样本量）。
 * 每条都携带来源主题与 evidenceRefs，可一一溯源到评论原文。
 */

export type VocImprovementInputTheme = {
  themeId: string;
  label: string;
  summary: string;
  evidenceRefs: string[];
  reviewCount: number;
  coverage: number;
  strength: "isolated" | "weak" | "recurring";
  limitations: string | null;
};

export type VocImprovementRequirement = {
  id: string;
  /** 需求描述（确定性模板句，文本全部来自来源主题，不新造内容） */
  requirement: string;
  /** 来源痛点主题 label（可溯源） */
  sourceThemeLabel: string;
  sourceThemeId: string;
  strength: VocImprovementInputTheme["strength"];
  reviewCount: number;
  coverage: number;
  /** 严重度线索：仅当分析时模型给出主题级 limitations 时透传（无则 null，不推断） */
  severityHint: string | null;
  evidenceRefs: string[];
};

export type VocSupplierCheckpoint = {
  id: string;
  /** 待供应商确认问题（验货/询价语境；只提出「要确认什么」，不含报价/MOQ 数值等供应链事实） */
  checkpoint: string;
  sourceThemeLabel: string;
  sourceThemeId: string;
  reviewCount: number;
  evidenceRefs: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽容输入：接受 VocAnalysisV1["themes"] 或其安全视图（client 投影类型同形） */
function themeList(value: unknown): VocImprovementInputTheme[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const themeId = typeof item.themeId === "string" ? item.themeId : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0) : [];
    const reviewCount = typeof item.reviewCount === "number" && Number.isFinite(item.reviewCount) ? item.reviewCount : evidenceRefs.length;
    const strength = item.strength === "recurring" || item.strength === "weak" ? item.strength : "isolated";
    if (!themeId || !label || !summary || evidenceRefs.length === 0) return [];
    return [{
      themeId,
      label,
      summary,
      evidenceRefs,
      reviewCount,
      coverage: typeof item.coverage === "number" && Number.isFinite(item.coverage) ? item.coverage : 0,
      strength,
      limitations: typeof item.limitations === "string" && item.limitations.trim() ? item.limitations.trim() : null,
    }];
  });
}

/** P1-VOC-01：痛点 / 复现请求主题（recurring）→ 改进需求（每条带证据引用与频次）。 */
export function deriveImprovementRequirements(themesInput: unknown, requestsInput: unknown): VocImprovementRequirement[] {
  const themes = themeList(themesInput);
  const requests = themeList(requestsInput);
  return [...themes, ...requests]
    .filter((theme) => theme.strength === "recurring")
    .map((theme) => ({
      id: `voc_req_${theme.themeId}`,
      requirement: `改进方向：针对买家反馈的「${theme.label}」问题——${theme.summary}`,
      sourceThemeLabel: theme.label,
      sourceThemeId: theme.themeId,
      strength: theme.strength,
      reviewCount: theme.reviewCount,
      coverage: theme.coverage,
      severityHint: theme.limitations,
      evidenceRefs: [...theme.evidenceRefs],
    }))
    .slice(0, 40);
}

/** P1-VOC-02：全部痛点主题 → 待供应商确认问题（验货/询价语境，一一映射可溯源）。 */
export function deriveSupplierCheckpoints(themesInput: unknown): VocSupplierCheckpoint[] {
  return themeList(themesInput)
    .map((theme) => ({
      id: `voc_cp_${theme.themeId}`,
      checkpoint: `样品/验货时重点核实「${theme.label}」（${theme.reviewCount} 条买家反馈提及此问题）`,
      sourceThemeLabel: theme.label,
      sourceThemeId: theme.themeId,
      reviewCount: theme.reviewCount,
      evidenceRefs: [...theme.evidenceRefs],
    }))
    .slice(0, 40);
}
