export type AmazonCaptureOutcomeInput = {
  status?: string | null;
  mode: "detail" | "search";
  readyCount?: number | null;
  observationCount?: number | null;
  uniqueProductCount?: number | null;
  targetCount?: number | null;
  partial?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
};

export type AmazonCaptureOutcome =
  | { success: true; message: string }
  | { success: false; message: string; status: string; errorCode: string; errorMessage: string; traceId: string };

export function formatAmazonCaptureRequestFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : "Amazon 采集发生异常。";
  return [
    "Amazon 采集未完成。",
    "状态：failed",
    "错误码：CAPTURE_REQUEST_FAILED",
    `原因：${reason}`,
    "traceId：未提供",
  ].join("\n");
}

/** 采集失败的用户可理解分类；错误码来自服务端采集器（captureRecipeBrowser 等）。 */
export type AmazonCaptureFailureKind =
  | "login_required"
  | "human_confirmation"
  | "environment_unavailable"
  | "page_changed"
  | "network"
  | "invalid_input"
  | "browser_closed"
  | "unknown";

const INPUT_ERROR_CODES = new Set([
  "ASIN_INVALID",
  "ASIN_BUDGET_INVALID",
  "QUERY_REQUIRED",
  "INVALID_JSON",
  "INVALID_BODY",
  "PAGE_BUDGET_INVALID",
  "SAMPLE_BUDGET_INVALID",
]);

const ENVIRONMENT_ERROR_CODES = new Set([
  "LOCAL_ENVIRONMENT_REQUIRED",
  "PLAYWRIGHT_RUNTIME_MISSING",
  "BROWSER_NOT_FOUND",
  "AMAZON_CAPTURE_PROXY_INVALID",
  "AMAZON_CAPTURE_PREFLIGHT_FAILED",
  "AMAZON_US_SESSION_CALIBRATION_FAILED",
  "MARKETPLACE_MISMATCH",
  "LOCALE_MISMATCH",
  "NON_US_EXIT",
  "AMAZON_CAPTURE_NON_US_EXIT",
]);

/**
 * 把服务端错误码归入用户语言的状态：
 * 需要登录授权 / 需要人工确认（验证码）/ 页面变化 / 网络失败 / 输入错误 / 其他。
 */
export function classifyAmazonCaptureFailure(errorCode?: string | null): AmazonCaptureFailureKind {
  const code = (errorCode ?? "").toUpperCase();
  if (code === "LOGIN_REQUIRED" || code === "LOGIN_WALL" || code === "AUTH_REQUIRED") return "login_required";
  if (code === "CAPTCHA_DETECTED" || code === "HUMAN_REQUIRED" || code === "AUTOMATION_BLOCKED" || code === "RATE_LIMITED") return "human_confirmation";
  if (code === "PAGE_CHANGED" || code === "PAGE_NOT_FOUND" || code === "CONTENT_REMOVED" || code === "CONTENT_DELETED" || code === "REVIEW_EXTRACTION_EMPTY" || code === "ASIN_PAGE_ANCHOR_MISMATCH") return "page_changed";
  if (code === "NETWORK_ERROR" || code === "CAPTURE_REQUEST_FAILED" || code === "PLAYWRIGHT_BROWSER_FAILED" || code === "TIMEOUT") return "network";
  if (INPUT_ERROR_CODES.has(code)) return "invalid_input";
  if (ENVIRONMENT_ERROR_CODES.has(code)) return "environment_unavailable";
  if (code === "REVIEW_SOURCE_UNAVAILABLE") return "network";
  // 采集浏览器被关闭 / Profile 被占用：可恢复，不是「未分类」。
  if (code === "BROWSER_CLOSED" || code === "TARGET_CLOSED" || code === "PROFILE_BUSY" || code === "PROFILE_IN_USE" || code === "AMAZON_CAPTURE_PROFILE_IN_USE") return "browser_closed";
  return "unknown";
}

/** 各分类给用户的标题与下一步指引；诚实呈现，不掩盖失败原因。 */
export function amazonCaptureFailureGuidance(kind: AmazonCaptureFailureKind): { title: string; hint: string } {
  switch (kind) {
    case "login_required":
      return {
        title: "需要登录授权",
        hint: "Amazon 页面要求登录，系统不会自动绕过。请打开轻选专用浏览器完成 Amazon 登录后，再回来重试采集。",
      };
    case "human_confirmation":
      return {
        title: "需要人工确认",
        hint: "Amazon 弹出了验证码或访问限制。请在专用浏览器中完成人工验证后重试；连续出现时请降低采集频率。",
      };
    case "environment_unavailable":
      return {
        title: "采集环境不可用",
        hint: "当前浏览器、会话或本地采集配置未通过检查；系统没有改用未验证的数据源。修复环境后可以重试。",
      };
    case "page_changed":
      return {
        title: "页面发生变化",
        hint: "Amazon 页面结构与上次采集时不一致，系统已按 fail-closed 停止，未写入猜测数据。请稍后重试；若持续出现，说明页面模板已更新，需要维护者更新采集规则。",
      };
    case "browser_closed":
      return {
        title: "采集浏览器已关闭",
        hint: "采集窗口被关闭或浏览器已退出。已完成的商品与证据已保留；请点击重试重新打开采集浏览器，未完成的部分会继续，不会重复采集已完成的商品。",
      };
    case "network":
      return {
        title: "网络失败",
        hint: "浏览器或网络连接未完成。请检查本机网络与代理配置后重试；本次采集结果尚未确认，不会写入半成品数据。",
      };
    case "invalid_input":
      return {
        title: "输入有误",
        hint: "请检查输入格式：ASIN 必须是 10 位字母数字，搜索关键词不能为空。",
      };
    default:
      return {
        title: "采集未完成",
        hint: "服务端返回了未分类的状态。请查看下方技术详情中的错误码与追踪号，再决定重试或反馈维护者。",
      };
  }
}

export function resolveAmazonCaptureOutcome(input: AmazonCaptureOutcomeInput): AmazonCaptureOutcome {
  const status = input.status || "unknown";
  const traceId = input.traceId || "未提供";
  if (status === "captured") {
    const count = input.mode === "detail" ? input.readyCount : input.observationCount;
    if (typeof count === "number" && count > 0) {
      return {
        success: true,
        message: input.mode === "detail"
          ? `Amazon 商品详情已采集（${count} 条可用商品事实）。`
          : typeof input.uniqueProductCount === "number"
            ? `Amazon 市场搜索已保存 ${input.uniqueProductCount}${typeof input.targetCount === "number" ? `/${input.targetCount}` : ""} 件有效唯一商品（原始观察 ${count} 条）。${input.partial ? "本轮提前停止，已保存成果保留；按提示处理后可继续。" : "后续商品详情仍需按已确认计划采集。"}`
            : `Amazon 市场搜索已完成（${count} 条搜索样本，后续详情采集仍需逐条绑定）。`,
      };
    }
    return {
      success: false,
      message: "采集流程结束，但没有生成可用商品事实。",
      status,
      errorCode: input.errorCode || "CAPTURE_RESULT_EMPTY",
      errorMessage: input.errorMessage || "本次没有生成可用商品事实。",
      traceId,
    };
  }
  return {
    success: false,
    message: "Amazon 采集未完成。",
    status,
    errorCode: input.errorCode || "CAPTURE_NOT_COMPLETED",
    errorMessage: input.errorMessage || "服务端未返回可确认的成功状态。",
    traceId,
  };
}
