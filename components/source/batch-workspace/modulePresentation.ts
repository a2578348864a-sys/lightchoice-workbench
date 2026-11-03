import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";

/**
 * 八模块状态与限制原因的中文展示映射（从 SourceManagementClient 提取，纯展示常量）。
 * 提取目的：详情面板与工作区共用同一套真实文案，避免出现第二套说法。
 */
export const MODULE_STATUS_LABELS: Record<ProductModuleStatus, string> = {
  COMPLETE: "已完成",
  CAPTURED_PARTIAL: "部分完成",
  NO_DATA_WITH_EVIDENCE: "无数据（有证据）",
  AVAILABLE_WITH_LIMITATION: "受限",
  BLOCKED_WITH_EVIDENCE: "受限（有证据）",
  FAILED_HUMAN: "需人工",
  LOGIN_REQUIRED: "需登录",
  EXTENSION_REQUIRED: "需安装插件",
  PLAN_LIMITED: "套餐受限",
  HUMAN_ACTION_REQUIRED: "人工操作",
  NOT_COLLECTED: "未采集",
};

export const MODULE_LIMITATION_LABELS: Record<string, string> = {
  page_asin_anchor_mismatch: "Amazon 页面与目标商品身份不匹配",
  review_page_extraction_empty: "页面未提取到可验证评论",
  review_page_page_unknown: "当前页面状态无法确认，评论没有被写入",
  review_extraction_empty: "页面未提取到可验证评论",
  confirmed_no_public_reviews: "当前页面未发现公开评论",
  public_top_reviews_only: "只覆盖 Amazon 公开 Top Reviews",
  variation_mapping_incomplete: "已读到部分变体信息，仍缺少完整的子体映射",
  variation_extraction_empty_retryable: "Amazon 页面暂未返回可验证的变体数据，可重试",
  variation_page_identity_not_bound: "当前 Amazon 页面无法确认属于目标商品，可重试",
  variation_requires_human: "Amazon 当前会话需要人工处理后才能继续",
  variation_source_unavailable_retryable: "变体采集环境暂不可用，可重试",
  variation_evidence_persist_failed: "采集结果未能写入正式证据库，可重试",
  no_variation_with_evidence: "Amazon 页面明确未提供其它变体",
  sellersprite_requires_login: "需要登录 SellerSprite 后重新采集",
  sellersprite_extension_required: "需要安装并启用 SellerSprite 浏览器插件",
  provider_plan_limited: "当前服务套餐不支持此功能",
  browser_use_remote_debugging_disabled: "浏览器未开放远程调试，需要用户在本机浏览器中开启",
  browser_use_remote_debugging_required: "需要用户在本机 Chrome 中允许远程调试，系统不会自行修改浏览器设置",
  browser_use_connection_unavailable: "本机 SellerSprite 浏览器会话尚未连接。连接已登录的 SellerSprite 浏览器后可重试；账号套餐权限尚未核实。",
  capture_attempt_failed: "采集本轮未完成，可查看回执后重试",
  module_source_input_required: "需要对应来源的官方报告或专属页面输入",
  review_full_not_available: "当前证据只能确认公开评论摘要，不能当作完整评论正文",
  login_required: "需要登录后才能继续采集",
  captcha_requires_human: "需要人工处理验证码",
  not_attempted_after_human_gate: "检测到人工验证要求，后续商品已暂停",
  "sample:collector_page_budget": "本次搜索采集受单页数量限制",
};

export function moduleAttemptMessage(message: string, errorCode: string | null): string {
  if (errorCode) {
    const mappedByErrorCode = MODULE_LIMITATION_LABELS[errorCode.trim().toLowerCase()];
    if (mappedByErrorCode) return mappedByErrorCode;
  }
  const key = message.trim().toLowerCase().replace(/\s+/gu, "_");
  return MODULE_LIMITATION_LABELS[key] ?? message;
}

export function moduleStatusTone(status: ProductModuleStatus): "ok" | "warn" | "bad" | "off" {
  if (status === "COMPLETE") return "ok";
  if (status === "NOT_COLLECTED") return "off";
  if (["LOGIN_REQUIRED", "EXTENSION_REQUIRED", "PLAN_LIMITED", "HUMAN_ACTION_REQUIRED", "FAILED_HUMAN"].includes(status)) return "bad";
  return "warn";
}
