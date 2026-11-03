import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  buildAmazonCaptureContextOptions,
  resolveAmazonCaptureNetworkConfig,
  snapshotAmazonCaptureProxyEnv,
  type AmazonCaptureProxyEnv,
  type AmazonCaptureLaunchOptions,
} from "@/lib/server/amazonCaptureBrowserConfig";
import { checkAmazonCapturePreflight, type AmazonCapturePreflightResult } from "@/lib/server/amazonCapturePreflight";
import {
  describeSessionError,
  type AmazonSessionFailureKind,
  type AmazonSessionStage,
} from "@/lib/server/amazonSessionDiagnostics";
import {
  ensureAmazonUsSessionEnvironment,
  toAmazonSessionFailureReport,
  type AmazonUsSessionPage,
} from "@/lib/server/amazonUsSessionEnvironment";
import { loadPlaywright } from "@/lib/server/playwrightRuntime";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { AMAZON_PROFILE_DIR, launchAmazonCapturePersistentContext, recordBrowserDiagnostic } from "@/lib/server/captureRecipeBrowser";
import { resolveSystemBrowser } from "@/tools/collectors/amazon/browser-control";
import { readCaptureRuntimeConfig } from "@/scripts/ops/capture-runtime-config.mjs";

/**
 * Amazon Session Readiness Check —— 「采集前先证明会话可用」。
 *
 * 只做环境检查：
 * - 不请求 Detail ASIN、不发起 Search keyword、不采集 Review；
 * - 不产生 Evidence / ProductFact / Search observation / ReviewEvidence；
 * - 唯一副作用是一条诊断事件（用于审计会话门禁结果）。
 *
 * 顺序固定为：出口预检 → （仅 US_READY 才启动浏览器）→ 打开 Amazon 首页 →
 * 读页面状态 / 配送地区 / 语言 → `SESSION_READY`。非美国出口绝不启动浏览器，
 * 也不会用「延长 timeout」掩盖出口问题。
 */

export type AmazonSessionReadinessStatus =
  | "ACQUISITION_DISABLED"
  | "SESSION_READY"
  | "SESSION_NOT_READY"
  | "PREFLIGHT_BLOCKED"
  | "BROWSER_UNAVAILABLE";

export type AmazonSessionReadinessResult = {
  ok: boolean;
  status: AmazonSessionReadinessStatus;
  sessionReady: boolean;
  networkPreflight: "US_READY" | "NON_US_EXIT" | "UNKNOWN";
  exitCountry: string | null;
  exitCountryName: string | null;
  browserLaunched: boolean;
  hostname: string;
  pageStatus: "ok" | "blocked";
  delivery: "US" | "NON_US" | "UNKNOWN";
  language: string;
  /** true=已登录，false=明确未登录，null=未读到可判定的登录标记。 */
  signedIn: boolean | null;
  calibrationAttempted: boolean;
  failureStage: AmazonSessionStage | null;
  failureKind: AmazonSessionFailureKind | null;
  elapsedMs: number;
  navigationElapsedMs: number;
  calibrationElapsedMs: number;
  errorCode: string | null;
  errorName: string | null;
  errorDetail: string | null;
  message: string;
  traceId: string;
  checkedAt: string;
};

type ReadinessPage = AmazonUsSessionPage;
type ReadinessContext = { newPage(): Promise<AmazonUsSessionPage>; close(): Promise<void> };
type ReadinessPlaywrightModule = {
  chromium: {
    launchPersistentContext(userDataDir: string, options: AmazonCaptureLaunchOptions): Promise<ReadinessContext>;
  };
};

type OpenedSession =
  | { ok: true; page: ReadinessPage; close: () => Promise<void> }
  | { ok: false; errorCode: string; errorMessage: string; errorName: string | null; errorDetail: string | null };

export type AmazonSessionReadinessDeps = {
  checkPreflight?: (proxyEnv: AmazonCaptureProxyEnv) => Promise<AmazonCapturePreflightResult>;
  openSession?: (proxyEnv: AmazonCaptureProxyEnv) => Promise<OpenedSession>;
};

/**
 * 打开一次只读会话：与采集路径共用同一个专用 profile（串行租约）、同一套
 * context 配置与同一个可选代理出口。不复制、不清洗、不轮换 profile。
 */
async function openAmazonCaptureSession(proxyEnv: AmazonCaptureProxyEnv): Promise<OpenedSession> {
  const playwrightModule = await loadPlaywright<ReadinessPlaywrightModule>();
  if (!playwrightModule) {
    return { ok: false, errorCode: "PLAYWRIGHT_RUNTIME_MISSING", errorMessage: "当前项目未安装 Playwright runtime；没有回退到 CDP。", errorName: null, errorDetail: null };
  }
  const browser = resolveSystemBrowser();
  if (!browser) {
    return { ok: false, errorCode: "BROWSER_NOT_FOUND", errorMessage: "本机未检测到可用于 Playwright 的 Chrome/Edge。", errorName: null, errorDetail: null };
  }
  const captureNetwork = resolveAmazonCaptureNetworkConfig(proxyEnv);
  if (captureNetwork.invalidReason) {
    return { ok: false, errorCode: "AMAZON_CAPTURE_PROXY_INVALID", errorMessage: captureNetwork.invalidReason, errorName: null, errorDetail: null };
  }
  let leasedContext: { context: ReadinessContext; close: () => Promise<void> } | null = null;
  try {
    leasedContext = await launchAmazonCapturePersistentContext(() => playwrightModule.chromium.launchPersistentContext(
      AMAZON_PROFILE_DIR,
      buildAmazonCaptureContextOptions({ executablePath: browser.executablePath, proxy: captureNetwork.proxy }),
    ));
    return {
      ok: true,
      page: await leasedContext.context.newPage(),
      close: leasedContext.close,
    };
  } catch (error) {
    let failure = error;
    if (leasedContext) {
      try {
        await leasedContext.close();
      } catch (closeError) {
        failure = closeError;
      }
    }
    const described = describeSessionError(failure);
    const code = failure instanceof Error ? (failure as Error & { code?: unknown }).code : null;
    const profileFailure = code === "PROFILE_IN_USE" || code === "PROFILE_LOCK_UNAVAILABLE"
      || code === "PROFILE_BROWSER_CLOSE_FAILED" || code === "PROFILE_LOCK_OWNERSHIP_LOST";
    return {
      ok: false,
      errorCode: profileFailure ? String(code) : "BROWSER_LAUNCH_FAILED",
      errorMessage: code === "PROFILE_IN_USE"
        ? "Amazon 采集 Profile 已被其他进程占用，或租约状态无法确认；未启动浏览器。"
        : code === "PROFILE_LOCK_UNAVAILABLE"
          ? "无法确认 Amazon 采集 Profile 独占状态；未启动浏览器。"
          : code === "PROFILE_BROWSER_CLOSE_FAILED"
            ? "Amazon 会话浏览器未能确认关闭，Profile 锁已保留；请先检查浏览器进程再继续。"
            : code === "PROFILE_LOCK_OWNERSHIP_LOST"
              ? "Amazon 会话 Profile 租约所有权无法确认，锁已保留；请检查浏览器进程后再继续。"
              : "Amazon 会话浏览器启动失败；未自动切换 profile 或代理。",
      errorName: described.name,
      errorDetail: described.detail,
    };
  }
}

export async function checkAmazonSessionReadiness(input: {
  context?: AccessContext | null;
  traceId?: string;
  deps?: AmazonSessionReadinessDeps;
} = {}): Promise<AmazonSessionReadinessResult> {
  const startedAt = Date.now();
  const traceId = input.traceId ?? newTraceId();
  const checkedAt = new Date().toISOString();
  const base = {
    ok: false,
    sessionReady: false,
    networkPreflight: "UNKNOWN" as "US_READY" | "NON_US_EXIT" | "UNKNOWN",
    exitCountry: null as string | null,
    exitCountryName: null as string | null,
    browserLaunched: false,
    hostname: "",
    pageStatus: "blocked" as "ok" | "blocked",
    delivery: "UNKNOWN" as "US" | "NON_US" | "UNKNOWN",
    language: "",
    signedIn: null as boolean | null,
    calibrationAttempted: false,
    failureStage: null as AmazonSessionStage | null,
    failureKind: null as AmazonSessionFailureKind | null,
    elapsedMs: 0,
    navigationElapsedMs: 0,
    calibrationElapsedMs: 0,
    errorCode: null as string | null,
    errorName: null as string | null,
    errorDetail: null as string | null,
    traceId,
    checkedAt,
  };
  const finish = (
    partial: Partial<AmazonSessionReadinessResult> & Pick<AmazonSessionReadinessResult, "status" | "message">,
  ): AmazonSessionReadinessResult => ({
    ...base,
    ...partial,
    elapsedMs: partial.elapsedMs ?? Date.now() - startedAt,
  });
  const audit = async (
    result: AmazonSessionReadinessResult,
    status: "succeeded" | "blocked" | "failed",
  ) => {
    if (!input.context) return;
    await recordBrowserDiagnostic({
      context: input.context,
      traceId,
      subjectKey: "amazon:US:session-readiness",
      module: "SESSION_READINESS",
      phase: "browser",
      eventType: "amazon_us_session_readiness_checked",
      status,
      reason: [
        `networkPreflight=${result.networkPreflight}`,
        `exitCountry=${result.exitCountry ?? "UNKNOWN"}`,
        `browserLaunched=${result.browserLaunched}`,
        `pageStatus=${result.pageStatus}`,
        `delivery=${result.delivery}`,
        `language=${result.language || "UNKNOWN"}`,
        `signedIn=${result.signedIn === null ? "UNKNOWN" : String(result.signedIn)}`,
        `calibrationAttempted=${result.calibrationAttempted}`,
        `sessionReady=${result.sessionReady}`,
        `failureStage=${result.failureStage ?? "NONE"}`,
        `failureKind=${result.failureKind ?? "NONE"}`,
        `elapsedMs=${result.elapsedMs}`,
        `navigationElapsedMs=${result.navigationElapsedMs}`,
        `calibrationElapsedMs=${result.calibrationElapsedMs}`,
        result.errorDetail ? `errorDetail=${result.errorDetail}` : "errorDetail=NONE",
      ].join(";"),
      errorCode: result.errorCode,
      durationMs: result.elapsedMs,
      humanRequired: !result.sessionReady,
    });
  };

  if (!readCaptureRuntimeConfig().enabled) return finish({
    status: "ACQUISITION_DISABLED", errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
    message: "Amazon 主动采集未开启；未检测网络、启动浏览器或写入诊断。请使用个人工作台启动配置。",
  });
  const proxyEnv = snapshotAmazonCaptureProxyEnv();
  const preflight = await (input.deps?.checkPreflight ?? ((env) => checkAmazonCapturePreflight({ env })))(proxyEnv);
  const networkPreflight = preflight.status === "US_READY"
    ? "US_READY" as const
    : preflight.status === "NON_US_EXIT"
      ? "NON_US_EXIT" as const
      : "UNKNOWN" as const;
  if (!preflight.ok || networkPreflight !== "US_READY") {
    const blocked = finish({
      status: "PREFLIGHT_BLOCKED",
      message: `${preflight.message}会话就绪检查未启动浏览器。`,
      networkPreflight,
      exitCountry: preflight.exitCountry,
      exitCountryName: preflight.exitCountryName ?? null,
      // 浏览器未启动时不存在 session 级 failureKind；网络原因由 networkPreflight 表达。
      failureStage: "PREFLIGHT",
      failureKind: null,
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
    });
    await audit(blocked, "blocked");
    return blocked;
  }

  const opened = await (input.deps?.openSession ?? openAmazonCaptureSession)(proxyEnv);
  if (!opened.ok) {
    const unavailable = finish({
      status: "BROWSER_UNAVAILABLE",
      message: `${opened.errorMessage}会话就绪检查未打开 Amazon 页面。`,
      networkPreflight,
      exitCountry: preflight.exitCountry,
      exitCountryName: preflight.exitCountryName ?? null,
      failureStage: "BROWSER_LAUNCH",
      failureKind: null,
      errorCode: opened.errorCode,
      errorName: opened.errorName,
      errorDetail: opened.errorDetail,
    });
    await audit(unavailable, "blocked");
    return unavailable;
  }

  let result: AmazonSessionReadinessResult;
  try {
    const sessionEnvironment = await ensureAmazonUsSessionEnvironment({
      page: opened.page,
      networkPreflight: "US_READY",
      module: "SESSION_READINESS",
      traceId,
    });
    const report = toAmazonSessionFailureReport(sessionEnvironment);
    const signedIn = sessionEnvironment.signedIn ?? null;
    const loginUnconfirmed = sessionEnvironment.ok && signedIn === null;
    const sessionReady = sessionEnvironment.ok && sessionEnvironment.stage === "SESSION_READY" && signedIn === true;
    result = finish({
      ok: sessionReady,
      sessionReady,
      status: sessionReady ? "SESSION_READY" : "SESSION_NOT_READY",
      message: sessionReady
        ? "Amazon 会话已就绪：已登录、出口 US、配送地区 US、语言 en-US。"
        : loginUnconfirmed
          ? "Amazon 环境已通过，但未能确认登录状态；请在专用浏览器确认已登录后重新检查。"
          : `Amazon 会话未就绪：${sessionEnvironment.errorMessage ?? "会话门禁未通过。"}`,
      networkPreflight,
      exitCountry: preflight.exitCountry,
      exitCountryName: preflight.exitCountryName ?? null,
      browserLaunched: true,
      hostname: sessionEnvironment.hostname,
      pageStatus: sessionEnvironment.pageStatus,
      delivery: sessionEnvironment.deliveryAfter,
      language: sessionEnvironment.language,
      signedIn,
      calibrationAttempted: sessionEnvironment.calibrationAttempted,
      failureStage: loginUnconfirmed ? "READ_PAGE_STATUS" : report.failureStage,
      failureKind: loginUnconfirmed ? "UNKNOWN_SESSION_FAILURE" : report.failureKind,
      navigationElapsedMs: report.navigationElapsedMs,
      calibrationElapsedMs: report.calibrationElapsedMs,
      errorCode: loginUnconfirmed ? "LOGIN_STATE_UNKNOWN" : sessionEnvironment.errorCode,
      errorName: report.errorName,
      errorDetail: report.errorDetail,
      elapsedMs: report.elapsedMs,
    });
  } catch (error) {
    const described = describeSessionError(error);
    result = finish({
      status: "SESSION_NOT_READY",
      message: "Amazon 会话检查过程中发生异常；本次未确认会话可用。",
      networkPreflight,
      exitCountry: preflight.exitCountry,
      exitCountryName: preflight.exitCountryName ?? null,
      browserLaunched: true,
      failureStage: null,
      failureKind: "UNKNOWN_SESSION_FAILURE",
      errorCode: "AMAZON_SESSION_READINESS_FAILED",
      errorName: described.name,
      errorDetail: described.detail,
    });
  }

  try {
    await opened.close();
  } catch (error) {
    const described = describeSessionError(error);
    result = finish({
      ...result,
      ok: false,
      sessionReady: false,
      status: "SESSION_NOT_READY",
      message: "Amazon 页面检查已结束，但浏览器未能确认关闭；Profile 锁已保留，请检查浏览器进程后再继续。",
      failureStage: "BROWSER_CLOSE",
      errorCode: error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : "PROFILE_BROWSER_CLOSE_FAILED",
      errorName: described.name,
      errorDetail: described.detail,
    });
  }
  await audit(result, result.sessionReady ? "succeeded" : "blocked");
  return result;
}
