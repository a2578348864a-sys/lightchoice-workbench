/**
 * 双语展示层工具（中文优先，英文仅作辅助）。
 *
 * 硬约束（与 strategyDisplayLocalization 一致）：
 * - 只作用于 UI 展示层，不修改任何存储数据、接口字段或后端生成链路；
 * - 不做机器翻译、不生成译文；英文原文一律保留并标注为原文；
 * - 映射仅覆盖「枚举 / 固定短语」这类可确定翻译的值；未知值原样展示并标注为原始值，
 *   由用户自行判断，绝不猜测含义。
 */

const VOICE_SOURCE_LABELS: Record<string, string> = {
  amazon_review: "Amazon 真实评论",
  reddit_post: "Reddit 帖子",
  reddit_comment: "Reddit 评论",
  manual_voc: "人工录入 / 导入",
};

const VOICE_CONTENT_TYPE_LABELS: Record<string, string> = {
  review: "评论",
  comment: "回复",
  post: "帖子",
  question: "提问",
  answer: "回答",
};

const ACCESS_BASIS_LABELS: Record<string, string> = {
  browser_visible: "浏览器可见页面",
  public_web: "公开网页",
  manual_import: "人工导入",
  file_import: "文件导入",
};

const IDENTITY_MATCH_LABELS: Record<string, { label: string; tone: "emerald" | "amber" | "blue" | "slate" }> = {
  EXACT: { label: "精确匹配该商品", tone: "emerald" },
  VARIANT: { label: "变体关联", tone: "blue" },
  FAMILY: { label: "同族关联", tone: "blue" },
  PROBABLE: { label: "疑似匹配，需人工核对", tone: "amber" },
  UNRESOLVED: { label: "人工录入 / 未验证", tone: "slate" },
};

const SCOPE_REVIEW_LABELS: Record<string, string> = {
  UNREVIEWED: "未确认",
  IN_SCOPE: "已确认符合范围",
  OUT_OF_SCOPE: "已确认不符合范围",
  STALE: "历史确认已过期，需重新核对",
};

const VOC_STRENGTH_LABELS: Record<string, string> = {
  recurring: "复现主题",
  weak: "弱信号",
  isolated: "孤立提及",
};

const SAMPLE_SOURCE_LABELS: Record<string, string> = {
  amazon_search: "Amazon 搜索采集",
  sellersprite_xlsx: "卖家精灵导入",
  keepa: "Keepa 数据",
  manual_import: "人工导入",
};

/** 已知枚举 → 中文；未知值保留原始英文并标注，避免把未知状态翻译错。 */
export function localizeVoiceSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未标注来源";
  return VOICE_SOURCE_LABELS[value] ?? `其他来源（原始值 ${value}）`;
}

export function localizeVoiceContentType(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未标注类型";
  return VOICE_CONTENT_TYPE_LABELS[value] ?? `其他类型（原始值 ${value}）`;
}

export function localizeAccessBasis(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未标注依据";
  return ACCESS_BASIS_LABELS[value] ?? `其他依据（原始值 ${value}）`;
}

export function localizeIdentityMatch(value: unknown): { label: string; tone: "emerald" | "amber" | "blue" | "slate" } {
  if (typeof value !== "string" || !value.trim()) return { label: "未标注匹配", tone: "slate" };
  return IDENTITY_MATCH_LABELS[value] ?? { label: `未识别匹配（原始值 ${value}）`, tone: "slate" };
}

export function localizeScopeReviewStatus(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未确认";
  return SCOPE_REVIEW_LABELS[value] ?? `状态待确认（原始值 ${value}）`;
}

export function localizeVocStrength(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "强度未标注";
  return VOC_STRENGTH_LABELS[value] ?? `强度未识别（原始值 ${value}）`;
}

export function localizeSampleSourceType(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未标注来源";
  return SAMPLE_SOURCE_LABELS[value] ?? `其他来源（原始值 ${value}）`;
}

/** 判断文本是否已经是中文（用于「中文优先」时避免重复加工）。 */
export function isMostlyChinese(value: string): boolean {
  if (!value) return false;
  const cjk = (value.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return cjk >= Math.max(1, Math.floor(value.trim().length * 0.3));
}
