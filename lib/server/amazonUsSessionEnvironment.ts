import {
  AMAZON_NAVIGATION_TIMEOUT_MS,
  AMAZON_SESSION_CONFIRM_TIMEOUT_MS,
  AMAZON_SESSION_DIALOG_TIMEOUT_MS,
  classifyThrownSessionFailure,
  describeSessionError,
  type AmazonSessionFailureKind,
  type AmazonSessionStage,
} from "@/lib/server/amazonSessionDiagnostics";

export { AMAZON_NAVIGATION_TIMEOUT_MS };

export const MAX_AMAZON_US_SESSION_CALIBRATION_ATTEMPTS = 1 as const;
export const AMAZON_HOME_MARKER_WAIT_MS = 5_000 as const;
const AMAZON_HOME_MARKER_SELECTOR = "#nav-logo-sprites, #nav-logo";

/** 会话门禁的调用方标识。Readiness Check 复用同一门禁，但不产生任何采集事实。 */
export type AmazonSessionModule = "DETAIL" | "SEARCH" | "REVIEW" | "SESSION_READINESS";

export type AmazonUsSessionPage = {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector?(selector: string, options?: { state?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  locator(selector: string): {
    click(options?: { timeout?: number }): Promise<void>;
    fill(value: string, options?: { timeout?: number }): Promise<void>;
    count(): Promise<number>;
  };
};

export type AmazonUsSessionEnvironmentResult = {
  ok: boolean;
  errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED" | "AMAZON_CAPTURE_PREFLIGHT_FAILED" | "MARKETPLACE_MISMATCH" | "LOCALE_MISMATCH" | "PAGE_CHANGED" | null;
  errorMessage: string | null;
  networkPreflight: "US_READY" | "NON_US_EXIT" | "UNKNOWN";
  hostname: string;
  deliveryBefore: "US" | "NON_US" | "UNKNOWN";
  calibrationAttempted: boolean;
  deliveryAfter: "US" | "NON_US" | "UNKNOWN";
  language: string;
  pageStatus: "ok" | "blocked";
  /** 当前 / 最终所处阶段；成功时为 SESSION_READY。 */
  stage: AmazonSessionStage;
  /** 失败锚点：失败发生在哪一步（成功时为 null）。 */
  failureStage: AmazonSessionStage | null;
  /** 失败类型：为什么失败（成功时为 null）。 */
  failureKind: AmazonSessionFailureKind | null;
  /** 整个会话门禁调用的墙钟耗时。 */
  elapsedMs: number;
  /** 累计 `page.goto()` 导航耗时。 */
  navigationElapsedMs: number;
  /** UI 配送校准交互耗时，不含校准后的重载导航。 */
  calibrationElapsedMs: number;
  /** 原始异常的 `error.name`；非异常失败路径为 null。 */
  errorName: string | null;
  /** 截断后的安全异常文本；不含凭据与页面 HTML。 */
  errorDetail: string | null;
};

export type AmazonSessionEnvironmentDiagnostic = {
  module: string;
  eventType: string;
  networkPreflight: string;
  sessionDeliveryBefore: string;
  calibrationAttempted: boolean;
  sessionDeliveryAfter: string;
  finalEnvironmentStatus: string;
  traceId: string;
  failureStage: AmazonSessionStage | null;
  failureKind: AmazonSessionFailureKind | null;
  elapsedMs: number;
  navigationElapsedMs: number;
  calibrationElapsedMs: number;
  errorName: string | null;
  errorDetail: string | null;
};

/** 供采集 API / 审计透传的安全诊断子集。 */
export type AmazonSessionFailureReport = Pick<
  AmazonUsSessionEnvironmentResult,
  "stage" | "failureStage" | "failureKind" | "elapsedMs" | "navigationElapsedMs" | "calibrationElapsedMs" | "errorName" | "errorDetail"
>;

export function toAmazonSessionFailureReport(
  result: AmazonUsSessionEnvironmentResult,
): AmazonSessionFailureReport {
  return {
    stage: result.stage,
    failureStage: result.failureStage,
    failureKind: result.failureKind,
    elapsedMs: result.elapsedMs,
    navigationElapsedMs: result.navigationElapsedMs,
    calibrationElapsedMs: result.calibrationElapsedMs,
    errorName: result.errorName,
    errorDetail: result.errorDetail,
  };
}

type PageSignals = { delivery: string; language: string; title: string; marker: boolean };
type DeliveryStatus = "US" | "NON_US" | "UNKNOWN";

async function waitForAmazonHomeMarker(page: AmazonUsSessionPage): Promise<void> {
  if (typeof page.waitForSelector !== "function") return;
  await page.waitForSelector(AMAZON_HOME_MARKER_SELECTOR, {
    state: "attached",
    timeout: AMAZON_HOME_MARKER_WAIT_MS,
  }).catch(() => undefined);
}

async function readSignals(page: AmazonUsSessionPage): Promise<PageSignals> {
  return page.evaluate<PageSignals>(`(() => {
    const delivery = document.querySelector('#glow-ingress-line2, #nav-global-location-data-modal-action')?.textContent || '';
    return {
      delivery: delivery.replace(/\\s+/g, ' ').trim(),
      language: document.documentElement.lang || '',
      title: document.title || '',
      marker: Boolean(document.querySelector('#nav-logo-sprites, #nav-logo')),
    };
  })()`);
}

function deliveryStatus(value: string): DeliveryStatus {
  if (/\b(?:Japan|Canada|United Kingdom|Germany|France|Australia)\b|日本/i.test(value)) return "NON_US";
  if (/\b(?:United States|USA)\b|\b\d{5}(?:-\d{4})?\b/i.test(value)) return "US";
  return "UNKNOWN";
}

/** Keep diagnostic delivery evidence useful without persisting a street address or postal code. */
function diagnosticDeliveryLabel(value: string, status: DeliveryStatus): string {
  if (status === "US") return "US";
  if (status === "UNKNOWN") return "UNKNOWN";
  const normalized = value.toLowerCase();
  if (normalized.includes("japan") || normalized.includes("日本")) return "Japan";
  if (normalized.includes("canada")) return "Canada";
  if (normalized.includes("united kingdom") || normalized.includes("uk")) return "United Kingdom";
  if (normalized.includes("germany")) return "Germany";
  if (normalized.includes("france")) return "France";
  if (normalized.includes("australia")) return "Australia";
  return "NON_US";
}

/**
 * Amazon US 会话 / 浏览器环境门禁。
 *
 * 设计约束（不得放宽）：
 * - `MAX_AMAZON_US_SESSION_CALIBRATION_ATTEMPTS = 1`：最多一次正常 UI 校准；
 * - 一次导航、最多 `AMAZON_NAVIGATION_TIMEOUT_MS`，失败即 fail-closed；
 * - 不自动重试、不轮换代理 / profile、不清 Cookie、不自动登录、不绕 CAPTCHA；
 * - 失败时必须给出 `failureStage` / `failureKind` / 耗时，不允许只回一个 UNKNOWN。
 */
export async function ensureAmazonUsSessionEnvironment(input: {
  page: AmazonUsSessionPage;
  networkPreflight: "US_READY" | "NON_US_EXIT" | "UNKNOWN";
  module: AmazonSessionModule;
  traceId: string;
  onDiagnostic?: (fields: AmazonSessionEnvironmentDiagnostic) => Promise<void>;
}): Promise<AmazonUsSessionEnvironmentResult> {
  const page = input.page;
  const startedAt = Date.now();
  let stage: AmazonSessionStage = "PREFLIGHT";
  let navigationElapsedMs = 0;
  let calibrationElapsedMs = 0;
  let failureStage: AmazonSessionStage | null = null;
  let failureKind: AmazonSessionFailureKind | null = null;
  let errorName: string | null = null;
  let errorDetail: string | null = null;

  const fail = (at: AmazonSessionStage, kind: AmazonSessionFailureKind | null) => {
    stage = at;
    failureStage = at;
    failureKind = kind;
  };
  const failureSuffix = () => `（failureStage=${failureStage ?? "UNKNOWN"}; failureKind=${failureKind ?? "UNKNOWN"}）`;
  const diagnostics = (): AmazonSessionFailureReport => ({
    stage,
    failureStage,
    failureKind,
    elapsedMs: Date.now() - startedAt,
    navigationElapsedMs,
    calibrationElapsedMs,
    errorName,
    errorDetail,
  });
  const report = async (
    sessionDeliveryBefore: string,
    calibrationAttempted: boolean,
    sessionDeliveryAfter: string,
    finalEnvironmentStatus: string,
  ) => input.onDiagnostic?.({
    module: input.module,
    eventType: "amazon_us_session_environment_checked",
    networkPreflight: input.networkPreflight,
    sessionDeliveryBefore,
    calibrationAttempted,
    sessionDeliveryAfter,
    finalEnvironmentStatus,
    traceId: input.traceId,
    failureStage,
    failureKind,
    elapsedMs: Date.now() - startedAt,
    navigationElapsedMs,
    calibrationElapsedMs,
    errorName,
    errorDetail,
  });
  const gotoWithBoundedTimeout = async (url: string): Promise<void> => {
    const navigationStartedAt = Date.now();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
    } finally {
      navigationElapsedMs += Date.now() - navigationStartedAt;
    }
  };
  const empty = {
    networkPreflight: input.networkPreflight,
    hostname: "",
    deliveryBefore: "UNKNOWN" as const,
    calibrationAttempted: false,
    deliveryAfter: "UNKNOWN" as const,
    language: "",
    pageStatus: "blocked" as const,
  };
  let hostname = "";
  let deliveryBefore: DeliveryStatus = "UNKNOWN";
  let deliveryAfter: DeliveryStatus = "UNKNOWN";
  let sessionDeliveryBefore = "UNKNOWN";
  let sessionDeliveryAfter = "UNKNOWN";
  let calibrationAttempted = false;
  let language = "";
  let pageStatus: "ok" | "blocked" = "blocked";
  if (input.networkPreflight !== "US_READY") {
    // 非美国出口没有 session 级 failureKind：网络原因由 networkPreflight 表达，
    // 且此处绝不启动浏览器。
    fail("PREFLIGHT", null);
    await report("UNKNOWN", false, "UNKNOWN", "BLOCKED");
    return { ...empty, ...diagnostics(), ok: false, errorCode: "AMAZON_CAPTURE_PREFLIGHT_FAILED", errorMessage: "美国网络出口预检未通过，未打开 Amazon 页面。" };
  }
  stage = "BROWSER_LAUNCH";
  try {
    stage = "OPEN_AMAZON_HOME";
    await gotoWithBoundedTimeout("https://www.amazon.com/");
    // A new browser context may finish DOMContentLoaded before Amazon hydrates
    // the navigation header. Wait once on the same page before classifying it.
    await waitForAmazonHomeMarker(page);
    hostname = new URL(page.url()).hostname.toLowerCase();
    stage = "READ_PAGE_STATUS";
    const before = await readSignals(page);
    deliveryBefore = deliveryStatus(before.delivery);
    deliveryAfter = deliveryBefore;
    sessionDeliveryBefore = diagnosticDeliveryLabel(before.delivery, deliveryBefore);
    sessionDeliveryAfter = sessionDeliveryBefore;
    const initialStatus = /captcha|robot check|sorry/i.test(before.title) || !before.marker ? "blocked" : "ok";
    pageStatus = initialStatus;
    language = before.language.toLowerCase();
    const initial = {
      ...empty,
      hostname,
      deliveryBefore,
      deliveryAfter: deliveryBefore,
      language,
      pageStatus: initialStatus as "ok" | "blocked",
    };
    if (hostname !== "www.amazon.com" && hostname !== "amazon.com") {
      fail("READ_PAGE_STATUS", "MARKETPLACE_MISMATCH");
      await report(sessionDeliveryBefore, false, sessionDeliveryAfter, "BLOCKED");
      return { ...initial, ...diagnostics(), ok: false, errorCode: "MARKETPLACE_MISMATCH", errorMessage: `Amazon 会话未停留在 amazon.com。${failureSuffix()}` };
    }
    if (initialStatus !== "ok") {
      fail("READ_PAGE_STATUS", "AMAZON_ERROR_PAGE");
      await report(sessionDeliveryBefore, false, sessionDeliveryAfter, "BLOCKED");
      return { ...initial, ...diagnostics(), ok: false, errorCode: "PAGE_CHANGED", errorMessage: `Amazon 会话页面状态不可用，未进行配送校准。${failureSuffix()}` };
    }
    stage = "READ_DELIVERY_SIGNAL";
    if (deliveryBefore === "UNKNOWN") {
      // 读不到可识别的配送地区信号时不做盲目校准：弹窗可能与配送节点一起缺失，
      // 继续点下去只会把「页面结构变化」伪装成「校准失败」。
      fail("READ_DELIVERY_SIGNAL", "DELIVERY_SIGNAL_NOT_FOUND");
      await report(sessionDeliveryBefore, false, sessionDeliveryAfter, "BLOCKED");
      return { ...initial, ...diagnostics(), ok: false, errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED", errorMessage: `Amazon 首页未读到可识别的配送地区信号，未进行配送校准。${failureSuffix()}` };
    }
    if (deliveryBefore !== "US") {
      calibrationAttempted = true;
      deliveryAfter = "UNKNOWN";
      sessionDeliveryAfter = "UNKNOWN";
      const calibrationStartedAt = Date.now();
      try {
        stage = "OPEN_DELIVERY_DIALOG";
        await page.locator("#nav-global-location-popover-link").click({ timeout: AMAZON_SESSION_DIALOG_TIMEOUT_MS });
        stage = "ENTER_US_ZIP";
        await page.locator("#GLUXZipUpdateInput").fill("10001", { timeout: AMAZON_SESSION_DIALOG_TIMEOUT_MS });
        stage = "APPLY_US_ZIP";
        await page.locator("#GLUXZipUpdate").click({ timeout: AMAZON_SESSION_DIALOG_TIMEOUT_MS });
        if (await page.locator("#GLUXConfirmClose").count() > 0) {
          await page.locator("#GLUXConfirmClose").click({ timeout: AMAZON_SESSION_CONFIRM_TIMEOUT_MS }).catch(() => undefined);
        }
      } finally {
        calibrationElapsedMs += Date.now() - calibrationStartedAt;
      }
      stage = "OPEN_AMAZON_HOME";
      await gotoWithBoundedTimeout("https://www.amazon.com/");
      await waitForAmazonHomeMarker(page);
    }
    stage = "VERIFY_DELIVERY";
    const afterSignals = calibrationAttempted ? await readSignals(page) : before;
    hostname = new URL(page.url()).hostname.toLowerCase();
    const afterPageStatus: "ok" | "blocked" = /captcha|robot check|sorry/i.test(afterSignals.title) || !afterSignals.marker ? "blocked" : "ok";
    pageStatus = afterPageStatus;
    language = afterSignals.language.toLowerCase();
    deliveryAfter = calibrationAttempted ? deliveryStatus(afterSignals.delivery) : deliveryBefore;
    sessionDeliveryAfter = diagnosticDeliveryLabel(afterSignals.delivery, deliveryAfter);
    const hostMatches = hostname === "www.amazon.com" || hostname === "amazon.com";
    const languageMatches = afterSignals.language.replace(/_/g, "-").toLowerCase() === "en-us";
    const result = {
      ...initial,
      hostname,
      calibrationAttempted,
      deliveryAfter,
      language,
      pageStatus: afterPageStatus,
    };
    // 五道门（marketplace → pageStatus → delivery → language）顺序与既有契约一致。
    const verificationFailure: {
      stage: AmazonSessionStage;
      kind: AmazonSessionFailureKind;
      errorCode: NonNullable<AmazonUsSessionEnvironmentResult["errorCode"]>;
      message: string;
    } | null = !hostMatches
      ? { stage: "VERIFY_DELIVERY", kind: "MARKETPLACE_MISMATCH", errorCode: "MARKETPLACE_MISMATCH", message: "Amazon 会话未停留在 amazon.com。" }
      : afterPageStatus !== "ok"
        ? { stage: "VERIFY_DELIVERY", kind: "AMAZON_ERROR_PAGE", errorCode: "PAGE_CHANGED", message: "Amazon 会话页面状态不可用，未继续采集。" }
        : deliveryAfter !== "US"
          ? { stage: "VERIFY_DELIVERY", kind: "DELIVERY_VERIFY_FAILED", errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED", message: "Amazon 配送地区校准一次后仍未通过。" }
          : !languageMatches
            ? { stage: "VERIFY_LANGUAGE", kind: "LANGUAGE_MISMATCH", errorCode: "LOCALE_MISMATCH", message: "Amazon 页面语言不是英语，未继续采集。" }
            : null;
    if (verificationFailure) {
      fail(verificationFailure.stage, verificationFailure.kind);
    } else {
      // 只有走到这里才允许后续 Detail / Search / Review 开始。
      stage = "SESSION_READY";
    }
    await report(sessionDeliveryBefore, calibrationAttempted, sessionDeliveryAfter, verificationFailure ? "BLOCKED" : "US_READY");
    if (verificationFailure) {
      return {
        ...result,
        ...diagnostics(),
        ok: false,
        errorCode: verificationFailure.errorCode,
        errorMessage: `${verificationFailure.message}${failureSuffix()}`,
      };
    }
    return {
      ...result,
      ...diagnostics(),
      ok: true,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    // 不再吞掉底层异常：阶段 + 类型 + 耗时 + 安全截断文本一并保留。
    fail(stage, classifyThrownSessionFailure(stage, error));
    const described = describeSessionError(error);
    errorName = described.name;
    errorDetail = described.detail;
    await report(sessionDeliveryBefore, calibrationAttempted, sessionDeliveryAfter, "BLOCKED").catch(() => undefined);
    return {
      ...empty,
      ...diagnostics(),
      hostname,
      deliveryBefore,
      calibrationAttempted,
      deliveryAfter,
      language,
      pageStatus,
      ok: false,
      errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED",
      errorMessage: `Amazon 美国配送地区校准未能完成，已停止采集。${failureSuffix()}`,
    };
  }
}
