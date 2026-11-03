/**
 * Amazon 会话门禁（Session / Browser Environment）的共享诊断词汇。
 *
 * 职责边界：
 * - 只描述「Amazon 会话是否可用」这一件事；不产生 Evidence / ProductFact，
 *   也不参与任何采集事实的判定。
 * - 只做分类，不做自我修复：一次导航失败即 fail-closed，不自动重试、
 *   不轮换代理或 profile、不清 Cookie、不自动登录。
 * - 只暴露安全字段（`error.name` 与截断后的 message）。绝不落 Cookie、Token、
 *   账号、完整 headers、代理密码或完整页面 HTML。
 */

/**
 * 受跨境网络影响的一次 `page.goto()` 导航上限。
 *
 * 实测背景：美国出口下 Amazon 首页导航偶发超过 30s；30s 会把「慢」误判成
 * 「不可用」。这里收敛为单一常量并放宽到 60s，但仍然是有界的：
 * 一次导航、最多 60s、失败即 fail-closed，禁止无限等待或多轮自动重试。
 */
export const AMAZON_NAVIGATION_TIMEOUT_MS = 60_000 as const;

/** 配送弹窗、ZIP 输入与应用按钮等交互控件保持短等待：站点不响应要尽快暴露。 */
export const AMAZON_SESSION_DIALOG_TIMEOUT_MS = 8_000 as const;

/** 弹窗内「确认 / 关闭」类收尾按钮更短。 */
export const AMAZON_SESSION_CONFIRM_TIMEOUT_MS = 5_000 as const;

/** 诊断消息单行截断上限：够定位问题，又不足以泄漏整页内容。 */
const SESSION_ERROR_DETAIL_MAX_LENGTH = 300;

/** 会话门禁的失败锚点阶段。失败时至少能回答「卡在哪一步」。 */
export const AMAZON_SESSION_STAGES = [
  "PREFLIGHT",
  "BROWSER_LAUNCH",
  "BROWSER_CLOSE",
  "OPEN_AMAZON_HOME",
  "READ_PAGE_STATUS",
  "READ_DELIVERY_SIGNAL",
  "OPEN_DELIVERY_DIALOG",
  "ENTER_US_ZIP",
  "APPLY_US_ZIP",
  "VERIFY_DELIVERY",
  "VERIFY_LANGUAGE",
  "SESSION_READY",
] as const;

export type AmazonSessionStage = (typeof AMAZON_SESSION_STAGES)[number];

/**
 * 会话失败类型。顶层错误码（如 `AMAZON_US_SESSION_CALIBRATION_FAILED`）保持
 * 既有契约，精确原因由本字段表达，避免所有问题都被压成一个 UNKNOWN。
 */
export const AMAZON_SESSION_FAILURE_KINDS = [
  "NAVIGATION_TIMEOUT",
  "NAVIGATION_ERROR",
  "AMAZON_ERROR_PAGE",
  "LOGIN_REQUIRED",
  "DELIVERY_SIGNAL_NOT_FOUND",
  "DELIVERY_DIALOG_TIMEOUT",
  "ZIP_INPUT_TIMEOUT",
  "ZIP_APPLY_TIMEOUT",
  "DELIVERY_VERIFY_FAILED",
  "LANGUAGE_MISMATCH",
  "MARKETPLACE_MISMATCH",
  "UNKNOWN_SESSION_FAILURE",
] as const;

export type AmazonSessionFailureKind = (typeof AMAZON_SESSION_FAILURE_KINDS)[number];

/** 会话失败时的安全诊断块：字段语义固定，便于审计与后续 Agent 复核。 */
export type AmazonSessionFailureDiagnostics = {
  failureStage: AmazonSessionStage | null;
  failureKind: AmazonSessionFailureKind | null;
  /** 整个会话门禁调用的墙钟耗时。 */
  elapsedMs: number;
  /** 累计 `page.goto()` 导航耗时（首页 + 校准后重载）。 */
  navigationElapsedMs: number;
  /** UI 配送校准交互耗时（弹窗 → ZIP → 应用），不含重载导航。 */
  calibrationElapsedMs: number;
  /** 原始异常的 `error.name`；无异常路径为 null。 */
  errorName: string | null;
  /** 截断后的安全异常文本；绝不含凭据或页面 HTML。 */
  errorDetail: string | null;
};

/** Playwright 超时判定：TimeoutError，或消息形如 `Timeout 60000ms exceeded`。 */
export function isSessionTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate.name === "TimeoutError") return true;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /Timeout\s+\d+\s*ms\s+exceeded/i.test(message);
}

/**
 * 把任意异常压成安全诊断文本。
 *
 * 只保留 `error.name` 与折叠空白后截断的 message；URL 内联凭据一律打码。
 * 调用方不得把 Cookie / Token / headers / 页面 HTML 传进来。
 */
export function describeSessionError(error: unknown): { name: string | null; detail: string | null } {
  const rawName = error instanceof Error && typeof error.name === "string" ? error.name : null;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return {
    name: rawName ? rawName.slice(0, 60) : null,
    detail: sanitizeSessionErrorDetail(rawMessage),
  };
}

export function sanitizeSessionErrorDetail(message: string): string | null {
  const collapsed = message.split(/\s+/).join(" ").trim();
  if (!collapsed) return null;
  const redacted = collapsed.replace(/\/\/([^/\s@:]+):[^/\s@]*@/g, "//$1:***@");
  return redacted.slice(0, SESSION_ERROR_DETAIL_MAX_LENGTH) || null;
}

/**
 * 抛错时的失败类型分类。
 *
 * - 导航 / 文档读取阶段：区分超时与一般导航错误；
 * - 校准交互阶段：按阶段给出确定类型（短等待下的失败等价于「控件不可用」），
 *   是超时还是其它异常由 `errorName` / `errorDetail` 保留；
 * - Amazon 错误页是「检测结果」而不是异常，不走本函数。
 */
export function classifyThrownSessionFailure(
  stage: AmazonSessionStage,
  error: unknown,
): AmazonSessionFailureKind {
  const timedOut = isSessionTimeoutError(error);
  switch (stage) {
    case "OPEN_AMAZON_HOME":
    case "READ_PAGE_STATUS":
    case "VERIFY_DELIVERY":
    case "VERIFY_LANGUAGE":
      return timedOut ? "NAVIGATION_TIMEOUT" : "NAVIGATION_ERROR";
    case "READ_DELIVERY_SIGNAL":
      return "DELIVERY_SIGNAL_NOT_FOUND";
    case "OPEN_DELIVERY_DIALOG":
      return "DELIVERY_DIALOG_TIMEOUT";
    case "ENTER_US_ZIP":
      return "ZIP_INPUT_TIMEOUT";
    case "APPLY_US_ZIP":
      return "ZIP_APPLY_TIMEOUT";
    default:
      return "UNKNOWN_SESSION_FAILURE";
  }
}
