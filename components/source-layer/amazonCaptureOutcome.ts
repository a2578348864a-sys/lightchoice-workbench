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
  | "market_locale"
  | "marketplace_mismatch"
  | "session_unavailable"
  | "network_exit"
  | "acquisition_disabled"
  | "scope_disabled"
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
  "PLAYWRIGHT_RUNTIME_MISSING",
  "BROWSER_NOT_FOUND",
  "AMAZON_CAPTURE_PROXY_INVALID",
]);

const NETWORK_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "CAPTURE_REQUEST_FAILED",
  "PLAYWRIGHT_BROWSER_FAILED",
  "TIMEOUT",
  "AMAZON_CAPTURE_PREFLIGHT_FAILED",
]);

const NETWORK_EXIT_ERROR_CODES = new Set([
  "NON_US_EXIT",
  "AMAZON_CAPTURE_NON_US_EXIT",
]);

const ACQUISITION_ERROR_CODES = new Set([
  "LOCAL_ENVIRONMENT_REQUIRED",
]);

const SCOPE_ERROR_CODES = new Set([
  "BATCH_CAPTURE_SCOPE_DISABLED",
]);

const SESSION_ERROR_CODES = new Set([
  "AMAZON_US_SESSION_CALIBRATION_FAILED",
]);

const MARKET_LOCALE_ERROR_CODES = new Set([
  "LOCALE_MISMATCH",
]);

const MARKETPLACE_ERROR_CODES = new Set([
  "MARKETPLACE_MISMATCH",
]);

/**
 * 把服务端错误码归入用户语言的状态：
 * 需要登录授权 / 需要人工确认（验证码）/ 地区或币种不符 / 会话未就绪 /
 * 网络出口 / 采集授权 / 批量范围 / 页面变化 / 网络失败 / 输入错误 / 其他。
 * 不同故障不得合并成一个「采集环境不可用」。
 */
export function classifyAmazonCaptureFailure(errorCode?: string | null): AmazonCaptureFailureKind {
  const code = (errorCode ?? "").toUpperCase();
  if (code === "LOGIN_REQUIRED" || code === "LOGIN_WALL" || code === "AUTH_REQUIRED") return "login_required";
  if (code === "CAPTCHA_DETECTED" || code === "HUMAN_REQUIRED" || code === "AUTOMATION_BLOCKED" || code === "RATE_LIMITED") return "human_confirmation";
  if (MARKET_LOCALE_ERROR_CODES.has(code)) return "market_locale";
  if (MARKETPLACE_ERROR_CODES.has(code)) return "marketplace_mismatch";
  if (SESSION_ERROR_CODES.has(code)) return "session_unavailable";
  if (NETWORK_EXIT_ERROR_CODES.has(code)) return "network_exit";
  if (ACQUISITION_ERROR_CODES.has(code)) return "acquisition_disabled";
  if (SCOPE_ERROR_CODES.has(code)) return "scope_disabled";
  if (code === "PAGE_CHANGED" || code === "PAGE_NOT_FOUND" || code === "CONTENT_REMOVED" || code === "CONTENT_DELETED" || code === "REVIEW_EXTRACTION_EMPTY" || code === "ASIN_PAGE_ANCHOR_MISMATCH") return "page_changed";
  if (NETWORK_ERROR_CODES.has(code) || code === "REVIEW_SOURCE_UNAVAILABLE") return "network";
  if (INPUT_ERROR_CODES.has(code)) return "invalid_input";
  if (ENVIRONMENT_ERROR_CODES.has(code)) return "environment_unavailable";
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
        hint: "当前浏览器或本地采集配置不可用；系统没有改用未验证的数据源。修复环境后可以重试。",
      };
    case "market_locale":
      return {
        title: "页面地区或币种不符",
        hint: "Amazon 页面未确认是美国站价格（配送地区、语言或币种未通过核验）。系统已停止，未写入证据。请检查专用浏览器的配送地址与页面币种后重试；这不是登录问题。",
      };
    case "marketplace_mismatch":
      return {
        title: "不是美国站页面",
        hint: "Amazon 把会话导向了非 amazon.com 页面，或页面缺少站点标识。系统已停止；请检查网络出口与专用浏览器页面后重试。",
      };
    case "session_unavailable":
      return {
        title: "Amazon 会话未就绪",
        hint: "登录状态、页面状态、配送地区或语言未通过核验；系统未绕过登录或验证码。请在专用浏览器确认已登录且配送地区为美国，然后重新检查。",
      };
    case "network_exit":
      return {
        title: "网络出口不是美国",
        hint: "当前出口不是美国，采集已禁用。请切换美国节点后重新检查；系统不会跨站点继续采集。",
      };
    case "acquisition_disabled":
      return {
        title: "采集未开放",
        hint: "服务端未开启本地真实采集。请使用正式工作台启动配置，并确认采集授权后再试。",
      };
    case "scope_disabled":
      return {
        title: "批量采集未开放",
        hint: "当前实例仅允许单 ASIN 采集（V5_ACQUISITION_SCOPE=single_asin_only），关键词批量采集被服务端安全策略关闭。系统没有把它伪装成登录失败，也没有放宽范围限制。",
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
