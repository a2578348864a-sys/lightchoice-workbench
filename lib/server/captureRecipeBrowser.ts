import "server-only";

import { resolveAmazonCaptureProfileDirectory } from "@/scripts/ops/capture-runtime-config.mjs";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  buildAmazonCaptureContextOptions,
  resolveAmazonCaptureNetworkConfig,
  type AmazonCaptureLaunchOptions,
} from "@/lib/server/amazonCaptureBrowserConfig";
import { launchPersistentContextWithProfileLock } from "@/lib/server/playwrightProfileLease.mjs";
import { checkAmazonCapturePreflight } from "@/lib/server/amazonCapturePreflight";
import { AMAZON_NAVIGATION_TIMEOUT_MS } from "@/lib/server/amazonSessionDiagnostics";
import {
  ensureAmazonUsSessionEnvironment,
  toAmazonSessionFailureReport,
  type AmazonSessionEnvironmentDiagnostic,
  type AmazonSessionFailureReport,
  type AmazonUsSessionPage,
} from "@/lib/server/amazonUsSessionEnvironment";
import { captureThroughGateway, type CaptureGatewayResult } from "@/lib/sourceLayer/server/captureGateway";
import { captureV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { newSpanId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";
import { normalizeSourceLayerErrorCode } from "@/lib/sourceLayer/errorCodes";
import {
  executeRecipeWithPlaywright,
  type PlaywrightRecipeDriver,
  type RecipeRunTrace,
} from "@/tools/collectors/recipes";
import { planAmazonDetailCapture } from "@/tools/collectors/recipes/amazon";
import {
  buildAmazonDetailPageExtractionExpression,
  type AmazonDetailPageExtraction,
} from "@/tools/collectors/amazon/detail-page-extract";
import {
  extractAmazonDetailPageV2,
  type AmazonDetailPageDomSnapshot,
  type AmazonDetailPageExtractionV2,
} from "@/tools/collectors/amazon/detail-page-extract-v2";
import { buildAmazonDetailPageSnapshotExpression } from "@/tools/collectors/amazon/detail-page-snapshot-expression";
import {
  auditAmazonDetailPageFieldPresence,
  type AmazonDetailPagePresenceAudit,
} from "@/tools/collectors/amazon/detail-page-presence-audit";
import { resolveSystemBrowser } from "@/tools/collectors/amazon/browser-control";
import { loadPlaywright } from "@/lib/server/playwrightRuntime";
import { AmazonConsoleErrorCollector, type AmazonConsoleErrorSummary } from "@/tools/collectors/amazon/console-error-diagnostics";
import {
  buildAmazonPageContextExpression,
  buildAmazonSearchPageExtractionExpression,
} from "@/tools/collectors/amazon/search-page-expression-source";
import { evaluateAmazonSearchPageEnvironment } from "@/tools/collectors/amazon/search-page-environment";
import {
  type AmazonPageContextSignals,
} from "@/tools/collectors/amazon/extract-search-page";
import {
  describeAmazonEnvironmentFailure,
  classifyAmazonCapturePageTitle,
  type AmazonEnvironmentGateResult,
} from "@/tools/collectors/amazon/environment-gate";
import { planAmazonSearchCapture, type AmazonSearchCapturePlan } from "@/tools/collectors/recipes/amazon";
import { planReviewVocImport } from "@/tools/collectors/recipes/reviewVoc";
import {
  MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
  runFreshReviewSessionAttempts,
} from "@/lib/server/reviewFreshSessionRetry";
import {
  normalizeAmazonVariationPageCapture,
  buildAmazonVariationPageExtractionExpression,
  type AmazonVariationPageCapture,
  type RawVariationPage,
} from "@/tools/collectors/amazon/variation-page-extract";
import {
  withAmazonVariationSourceSignals,
  type AmazonVariationSourceSignals,
} from "@/lib/server/amazonVariationSourceSignals";
import type { ReviewSourceProductRole } from "@/lib/server/reviewEvidence";
import {
  buildReviewDomReadinessExpression,
  buildReviewSnippetExtractionExpression,
  isReviewPageIdentityBound,
  type ReviewDomReadiness,
} from "@/tools/collectors/amazon/review-snippet-extract";

const AMAZON_DETAIL_COLLECTOR_VERSION = "amazon-playwright-detail-collector.v1";
/** 采集路径与 Session Readiness 共用的唯一专用 profile 目录。 */
export const AMAZON_PROFILE_DIR = resolveAmazonCaptureProfileDirectory();
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export async function recordBrowserDiagnostic(input: {
  context: AccessContext;
  traceId: string;
  subjectKey: string;
  module: string;
  phase: "browser" | "extract" | "persist";
  eventType: string;
  status: "succeeded" | "failed" | "blocked";
  reason: string;
  errorCode?: string | null;
  evidenceRefs?: string[];
  contentHash?: string | null;
  recipeVersion?: string | null;
  pageTemplateHash?: string | null;
  humanRequired?: boolean;
  durationMs?: number | null;
}): Promise<void> {
  await recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId: input.traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: null,
      captureId: null,
      subjectKey: input.subjectKey,
      module: input.module,
      phase: input.phase,
      eventType: input.eventType,
      severity: input.status === "failed" ? "error" : input.status === "blocked" ? "warning" : "info",
      statusBefore: null,
      statusAfter: input.status,
      status: input.status,
      errorCode: input.errorCode ?? null,
      reason: input.reason,
      retryable: input.status === "failed",
      humanRequired: input.humanRequired ?? false,
      sourceType: "amazon_dom",
      recipeVersion: input.recipeVersion ?? null,
      pageTemplateHash: input.pageTemplateHash ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      contentHash: input.contentHash ?? null,
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: input.durationMs ?? null,
      attempt: 1,
    },
  }).catch(() => undefined);
}

/**
 * 会话门禁审计文案。
 *
 * 顶层错误码保持既有契约（`AMAZON_US_SESSION_CALIBRATION_FAILED` 等），
 * 失败阶段 / 失败类型 / 耗时在这里显式落盘，避免审计里只剩一个 UNKNOWN。
 * `errorDetail` 已在生成侧截断并打码，不含 Cookie / Token / 页面 HTML。
 */
function sessionDiagnosticReason(fields: AmazonSessionEnvironmentDiagnostic): string {
  return [
    `networkPreflight=${fields.networkPreflight}`,
    `sessionDeliveryBefore=${fields.sessionDeliveryBefore}`,
    `calibrationAttempted=${fields.calibrationAttempted}`,
    `sessionDeliveryAfter=${fields.sessionDeliveryAfter}`,
    `finalEnvironmentStatus=${fields.finalEnvironmentStatus}`,
    `module=${fields.module}`,
    `failureStage=${fields.failureStage ?? "NONE"}`,
    `failureKind=${fields.failureKind ?? "NONE"}`,
    `elapsedMs=${fields.elapsedMs}`,
    `navigationElapsedMs=${fields.navigationElapsedMs}`,
    `calibrationElapsedMs=${fields.calibrationElapsedMs}`,
    fields.errorDetail ? `errorDetail=${fields.errorDetail}` : "errorDetail=NONE",
  ].join(";");
}

function profileLeaseErrorCode(error: unknown): "PROFILE_IN_USE" | "PROFILE_LOCK_UNAVAILABLE" | "PROFILE_BROWSER_CLOSE_FAILED" | "PROFILE_LOCK_OWNERSHIP_LOST" | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  return code === "PROFILE_IN_USE" || code === "PROFILE_LOCK_UNAVAILABLE"
    || code === "PROFILE_BROWSER_CLOSE_FAILED" || code === "PROFILE_LOCK_OWNERSHIP_LOST" ? code : null;
}

function profileLeaseErrorMessage(error: unknown): string | null {
  const code = profileLeaseErrorCode(error);
  if (code === "PROFILE_LOCK_UNAVAILABLE") {
    return "无法确认 Amazon 采集 Profile 独占状态；本次已 fail-closed，未启动浏览器。";
  }
  if (code === "PROFILE_BROWSER_CLOSE_FAILED") {
    return "Amazon 采集浏览器未能确认关闭，Profile 锁已保留以防并发；请先检查浏览器进程再继续。";
  }
  if (code === "PROFILE_LOCK_OWNERSHIP_LOST") {
    return "Amazon 采集 Profile 租约所有权或状态已变化，系统保留了无法确认归属的锁；请检查浏览器进程后再继续。";
  }
  if (code === "PROFILE_IN_USE") {
    const state = (error as Error & { state?: unknown }).state;
    if (state === "stale_owner_process") {
      return "Amazon 采集 Profile 留有已退出进程的锁；系统正在串行恢复。若仍无法启动，请检查浏览器进程与锁状态。";
    }
    return "Amazon 采集 Profile 已被其他进程占用，或持有者身份无法确认；本次已 fail-closed，未启动浏览器。";
  }
  return null;
}

type PlaywrightPage = AmazonUsSessionPage & {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

/** Search, Detail, Review/VOC, Variation and Session Readiness share one cross-process lease. */
export async function launchAmazonCapturePersistentContext<T extends { close(): Promise<void> }>(
  launch: () => Promise<T>,
): Promise<{ context: T; close: () => Promise<void> }> {
  return launchPersistentContextWithProfileLock(AMAZON_PROFILE_DIR, launch);
}

type PlaywrightBrowser = {
  newContext(options: { viewport: null; locale: string; timezoneId: string }): Promise<PlaywrightContext>;
  close(): Promise<void>;
};

type PlaywrightModule = {
  chromium: {
    launch(options: {
      executablePath: string;
      headless: boolean;
      args: string[];
      proxy?: AmazonCaptureLaunchOptions["proxy"];
    }): Promise<PlaywrightBrowser>;
    launchPersistentContext(
      userDataDir: string,
      options: AmazonCaptureLaunchOptions,
    ): Promise<PlaywrightContext>;
  };
};

type AmazonDetailSupplemental = {
  categoryPath: string[];
  parentAsin: string | null;
  listPrice: { amount: number; currency: string } | null;
  coupon: { text: string | null; amount: number | null; percent: number | null; currency: string | null } | null;
  seller: string | null;
  shipsFrom: string | null;
  fulfillment: string | null;
  buyBox: { seller: string | null; price: { amount: number; currency: string } | null } | null;
  ratingDistribution: Record<string, number>;
  boughtPastMonth: number | null;
  galleryImageUrls: string[];
  variations: string[];
};

/**
 * 详情页 P1 补充字段只读 DOM；每个字段都可以返回 null/空数组，绝不由
 * 页面文本推断不存在的商业事实。选择器族故意限制在主商品/BuyBox/评分
 * 直方图容器，避免把推荐商品卡片混入当前实体。
 */
const AMAZON_DETAIL_SUPPLEMENTAL_EXPRESSION = `(() => {
  const clean = (value, max = 300) => typeof value === 'string'
    ? value.replace(/[\\u0000-\\u001F\\u007F]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max) || null
    : null;
  const firstText = (selectors, max = 300) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = clean(node && (node.textContent || node.getAttribute?.('aria-label')), max);
      if (value) return value;
    }
    return null;
  };
  const parsePrice = (value) => {
    const match = value && /(?:US\\$|\\$)\\s*([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)/.exec(value);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(amount) && amount >= 0 ? { amount, currency: 'USD' } : null;
  };
  const categoryPath = Array.from(document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a, #wayfinding-breadcrumbs_container a'))
    .map((node) => clean(node.textContent, 120)).filter(Boolean).slice(0, 12);
  const galleryImageUrls = Array.from(document.querySelectorAll('#altImages img, #imageBlock img'))
    .map((node) => node.getAttribute('data-old-hires') || node.getAttribute('src'))
    .filter((value) => typeof value === 'string' && /^https:\\//i.test(value))
    .map((value) => value.slice(0, 2048)).filter((value, index, list) => list.indexOf(value) === index).slice(0, 20);
  const parentRaw = firstText(['#variation_parent', '#productDetails_detailBullets_sections1 tr'], 120);
  const parentAsin = parentRaw && /(?:parent|ASIN)\\D*([A-Z0-9]{10})/i.exec(parentRaw)?.[1]?.toUpperCase() || null;
  const couponText = firstText(['.couponBadge', '#couponText', '.s-coupon-unclipped', '[data-cy="coupon"]'], 160);
  const amountMatch = couponText && /(?:US\\$|\\$)\\s*([0-9]+(?:\\.[0-9]{1,2})?)/.exec(couponText);
  const percentMatch = couponText && /([0-9]+(?:\\.[0-9]+)?)\\s*%/.exec(couponText);
  const coupon = couponText ? {
    text: couponText,
    amount: amountMatch ? Number(amountMatch[1]) : null,
    percent: percentMatch ? Number(percentMatch[1]) : null,
    currency: amountMatch ? 'USD' : null,
  } : null;
  const buyBoxText = clean(document.querySelector('#tabular-buybox-container')?.innerText, 1000) || '';
  const seller = firstText(['#sellerProfileTriggerId', '#merchant-info a', '#tabular-buybox-container #sellerProfileTriggerId'], 300);
  const shipsFromMatch = /Ships from\\s*:?\\s*([^\\n]+)/i.exec(buyBoxText);
  const fulfillmentMatch = /(?:Fulfilled by|Fulfillment)\\s*:?\\s*([^\\n]+)/i.exec(buyBoxText);
  const shipsFrom = clean(shipsFromMatch?.[1], 200);
  const fulfillment = clean(fulfillmentMatch?.[1], 200);
  const currentPrice = parsePrice(firstText(['#corePriceDisplay_desktop_feature_div .a-price .a-offscreen', '#corePrice_feature_div .a-offscreen', '.priceToPay .a-offscreen'], 80));
  const buyBox = seller || currentPrice ? { seller, price: currentPrice } : null;
  const listPrice = parsePrice(firstText(['.basisPrice .a-offscreen', '.a-text-price .a-offscreen', '#listPrice'], 80));
  const ratingDistribution = {};
  for (const row of Array.from(document.querySelectorAll('#histogramTable tr, #reviewsMedley .a-histogram-row'))) {
    const text = clean(row.textContent, 120) || '';
    const star = /([1-5])\\s*star/i.exec(text)?.[1];
    const percent = /([0-9]+(?:\\.[0-9]+)?)\\s*%/.exec(text)?.[1];
    if (star && percent) ratingDistribution[star] = Number(percent);
  }
  const boughtText = firstText(['#social-proofing-faceout', '[data-cy="social-proofing-faceout"]'], 120);
  const boughtMatch = boughtText && /([0-9][0-9,.]*\\s*[kK]?)\\+?\\s+bought\\s+in\\s+past\\s+month/i.exec(boughtText);
  const boughtPastMonth = boughtMatch ? Number(boughtMatch[1].replace(/,/g, '').replace(/k$/i, '')) * (/k/i.test(boughtMatch[1]) ? 1000 : 1) : null;
  const variations = Array.from(document.querySelectorAll('#twister option, #twister .a-button-text, #variation_size_name option, #variation_color_name option, #variation_pattern_name option'))
    .map((node) => clean(node.textContent, 120)).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).slice(0, 40);
  return {
    categoryPath,
    parentAsin,
    listPrice,
    coupon,
    seller,
    shipsFrom,
    fulfillment,
    buyBox,
    ratingDistribution,
    boughtPastMonth: Number.isSafeInteger(boughtPastMonth) && boughtPastMonth >= 0 ? boughtPastMonth : null,
    galleryImageUrls,
    variations,
  };
})()`;

export type AmazonDetailBrowserCollectionResult = {
  partial?: boolean;
  postWriteFailures?: Array<{ code: string; subjectKey: string | null }>;
  status: "captured" | "human_required" | "blocked" | "unavailable" | "failed";
  trace: RecipeRunTrace | null;
  extraction: AmazonDetailPageExtractionV2 | null;
  /** Sanitized booleans from the bounded target-product snapshot; never includes DOM text. */
  pageFieldPresenceAudit?: AmazonDetailPagePresenceAudit | null;
  capture: CaptureGatewayResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 会话门禁失败时的阶段级诊断；顶层错误码保持既有契约，此处补充「卡在哪一步、为什么」。 */
  sessionDiagnostics?: AmazonSessionFailureReport | null;
  consoleErrors: number;
  consoleErrorDiagnostics?: AmazonConsoleErrorSummary;
  pageErrors: number;
  browser: { name: string; profile: string } | null;
};

export type AmazonSearchBrowserCollectionResult = {
  partial?: boolean;
  postWriteFailures?: Array<{ code: string; subjectKey: string | null }>;
  navigationUsed?: number;
  pageCheckpoints?: AmazonSearchPageCheckpoint[];
  status: "captured" | "human_required" | "blocked" | "unavailable" | "failed";
  traces: RecipeRunTrace[];
  plan: AmazonSearchCapturePlan | null;
  captures: CaptureGatewayResult[];
  errorCode: string | null;
  errorMessage: string | null;
  /** 会话门禁失败时的阶段级诊断；顶层错误码保持既有契约，此处补充「卡在哪一步、为什么」。 */
  sessionDiagnostics?: AmazonSessionFailureReport | null;
  consoleErrors: number;
  pageErrors: number;
  browser: { name: string; profile: string } | null;
};

export type AmazonSearchPageCheckpoint = {
  page: number;
  state: "navigating" | "extracted" | "validated" | "evidence_persisted" | "blocked";
  pageStatus: string;
  observationCount: number;
  errorCode?: string;
  evidenceReferences: Array<{ subjectKey: string; captureId: string; evidenceId: string; evidenceVersion: number; contentHash: string }>;
};

export type CaptureDriverFailureCode = "TIMEOUT" | "BROWSER_CLOSED" | "PROFILE_BUSY" | "INTERNAL_UNEXPECTED";

/**
 * 把采集驱动抛出的异常映射成**可识别的业务错误码**。
 * 历史缺陷：除 TIMEOUT 外一律落到 INTERNAL_UNEXPECTED，前端无法分类，只能显示「未分类的状态」。
 * 典型场景：用户在采集中手动关闭了采集浏览器 → Playwright 抛
 * "Target page, context or browser has been closed"。
 */
export function captureDriverFailureCode(error: unknown): CaptureDriverFailureCode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /timed?\s*out|timeout/iu.test(message))) {
    return "TIMEOUT";
  }
  if (/Target (?:page, context or browser|page|context|browser).*closed|has been closed|Browser has been closed|Target closed|browser has disconnected/iu.test(message)) {
    return "BROWSER_CLOSED";
  }
  if (/AMAZON_CAPTURE_PROFILE_IN_USE|profile.*(?:in use|locked|占用)/iu.test(message)) {
    return "PROFILE_BUSY";
  }
  return "INTERNAL_UNEXPECTED";
}

export async function captureModuleEvidenceAfterGateway(capture: CaptureGatewayResult,
  input: Parameters<typeof captureV3ModuleEvidence>[0]) {
  try {
    await captureV3ModuleEvidence(input);
    return null;
  } catch {
    const subjectKey = capture.capture.items[0]?.subjectKey ?? null;
    await recordBrowserDiagnostic({ context: input.context, traceId: capture.traceId,
      subjectKey, module: "CAPTURE_GATEWAY", phase: "persist", eventType: "module_evidence_write_failed",
      status: "failed", errorCode: "PERSISTENCE_FAILED", reason: "商品证据已保存；补充模块证据写入失败，保留已有采集结果。",
      evidenceRefs: capture.capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
    });
    return { code: "MODULE_EVIDENCE_WRITE_FAILED", subjectKey };
  }
}

export type AmazonReviewBrowserCollectionResult = {
  status: "captured" | "human_required" | "unavailable" | "failed";
  items: Array<{
    asin: string;
    role: ReviewSourceProductRole;
    rating: number | null;
    date: string | null;
    title: string;
    reviewText: string;
    verifiedPurchase: boolean | null;
    sourceUrl: string;
    bindingNote: string;
  }>;
  pageResults: Array<{
    asin: string;
    status: string;
    note: string | null;
    extractedCount: number;
    finalUrl?: string;
    diagnostics?: {
      strategy?: "persistent_profile" | "fresh_context";
      identityCheckVersion?: string;
      freshSessionAttempt?: number;
      freshSessionAttempts?: number;
      freshSessionAttemptsRemaining?: number;
      freshSessionBudgetExhausted?: boolean;
      pageStatus?: string | null;
      bindingReason?: string | null;
      sessionFailure?: {
        errorCode: string | null;
        failureStage: string | null;
        failureKind: string | null;
      } | null;
      identityProof?: {
        urlMatchesExpected?: boolean;
        pageAnchorMatchesExpected?: boolean;
        productContainerFound?: boolean;
      } | null;
      readiness?: {
        productTitlePresent: boolean;
        reviewNodeCount: number;
        bodyNodeCount: number;
        explicitNoReviews: boolean;
        elapsedMs: number;
        retryAttempt: number;
        scrollTriggered: boolean;
      } | null;
      consoleErrors?: number;
      pageErrors?: number;
    };
  }>;
  errorCode: string | null;
  errorMessage: string | null;
  /** 会话门禁失败时的阶段级诊断；顶层错误码保持既有契约，此处补充「卡在哪一步、为什么」。 */
  sessionDiagnostics?: AmazonSessionFailureReport | null;
  consoleErrors: number;
  pageErrors: number;
  browser: { name: string; profile: string } | null;
};

export type AmazonVariationBrowserCollectionResult = {
  status: "captured" | "human_required" | "blocked" | "unavailable" | "failed";
  results: Array<{
    asin: string;
    capture: AmazonVariationPageCapture;
    rawVariationSignals?: AmazonVariationSourceSignals | null;
    evidenceId: string | null;
    contentHash: string | null;
    errorCode: string | null;
    consoleErrors: number;
    pageErrors: number;
    elapsedMs: number;
  }>;
  errorCode: string | null;
  humanAborted: boolean;
  consoleErrors: number;
  pageErrors: number;
  browser: { name: string; profile: string } | null;
};

function requestedAmazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`;
}

function isSafeAmazonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com"))
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

/** 仅用于诊断文本的主机名提取；解析失败返回空串，绝不抛错影响采集结果。 */
function observedHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function runWithPlaywright(input: {
  context: AccessContext;
  asin: string;
  now: Date;
  traceId?: string;
}): Promise<AmazonDetailBrowserCollectionResult> {
  const playwrightModule = await loadPlaywright<PlaywrightModule>();
  const browser = resolveSystemBrowser();
  if (!playwrightModule) {
    return {
      status: "unavailable",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: "PLAYWRIGHT_RUNTIME_MISSING",
      errorMessage: "当前项目未安装 Playwright runtime；没有回退到 CDP。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: browser ? { name: browser.browser, profile: AMAZON_PROFILE_DIR } : null,
    };
  }
  if (!browser) {
    return {
      status: "unavailable",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: "BROWSER_NOT_FOUND",
      errorMessage: "本机未检测到可用于 Playwright 的 Chrome/Edge。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  const captureNetwork = resolveAmazonCaptureNetworkConfig();
  if (captureNetwork.invalidReason) {
    return {
      status: "failed",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: "AMAZON_CAPTURE_PROXY_INVALID",
      errorMessage: `${captureNetwork.invalidReason}为避免误采，本次未启动采集浏览器。`,
      consoleErrors: 0,
      pageErrors: 0,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  const preflight = await checkAmazonCapturePreflight({ env: captureNetwork.env });
  if (!preflight.ok) {
    await recordBrowserDiagnostic({
      context: input.context,
      traceId: input.traceId ?? "",
      subjectKey: `amazon:US:${input.asin}`,
      module: "BROWSER",
      phase: "browser",
      eventType: "amazon_capture_outbound_preflight",
      status: "blocked",
      reason: preflight.message,
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      humanRequired: false,
    });
    return {
      status: "failed",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      errorMessage: `${preflight.message}为避免误采，本次未启动采集浏览器。`,
      consoleErrors: 0,
      pageErrors: 0,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  let context: PlaywrightContext | null = null;
  let consoleErrors = 0;
  let pageErrors = 0;
  const consoleErrorCollector = new AmazonConsoleErrorCollector();
  let extraction: AmazonDetailPageExtractionV2 | null = null;
  let pageFieldPresenceAudit: AmazonDetailPagePresenceAudit | null = null;
  let closeProfileContext: (() => Promise<void>) | null = null;
  try {
    const leasedContext = await launchAmazonCapturePersistentContext(() => playwrightModule.chromium.launchPersistentContext(
      AMAZON_PROFILE_DIR,
      buildAmazonCaptureContextOptions({ executablePath: browser.executablePath, proxy: captureNetwork.proxy }),
    ));
    context = leasedContext.context;
    closeProfileContext = leasedContext.close;
    const page = await context.newPage();
    page.on("console", (...args) => {
      const message = args[0] as {
        type?: () => string;
        text?: () => string;
        location?: () => { url?: string };
      } | undefined;
      const type = message?.type?.() ?? "";
      if (type === "error") {
        consoleErrors += 1;
        consoleErrorCollector.record({
          type,
          text: message?.text?.() ?? "",
          sourceUrl: message?.location?.().url ?? null,
        });
      }
    });
    page.on("pageerror", () => { pageErrors += 1; });
    const sessionEnvironment = await ensureAmazonUsSessionEnvironment({
      page, networkPreflight: preflight.status === "US_READY" ? "US_READY" : preflight.status === "NON_US_EXIT" ? "NON_US_EXIT" : "UNKNOWN",
      module: "DETAIL", traceId: input.traceId ?? "",
      onDiagnostic: async (fields) => recordBrowserDiagnostic({
        context: input.context, traceId: fields.traceId, subjectKey: `amazon:US:${input.asin}`,
        module: fields.module, phase: "browser", eventType: fields.eventType, status: fields.finalEnvironmentStatus === "US_READY" ? "succeeded" : "blocked",
        reason: sessionDiagnosticReason(fields),
        durationMs: fields.elapsedMs,
      }),
    });
    if (!sessionEnvironment.ok) return {
      status: "failed", trace: null, extraction: null, capture: null,
      errorCode: sessionEnvironment.errorCode ?? "AMAZON_US_SESSION_CALIBRATION_FAILED",
      errorMessage: sessionEnvironment.errorMessage ?? "Amazon 美国会话环境门禁未通过。",
      sessionDiagnostics: toAmazonSessionFailureReport(sessionEnvironment),
      consoleErrors, pageErrors, browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
      consoleErrorDiagnostics: consoleErrorCollector.snapshot(),
    };
    const targetUrl = requestedAmazonUrl(input.asin);
    const driver: PlaywrightRecipeDriver = {
      kind: "playwright",
      runStep: async ({ step }) => {
        const startedAt = Date.now();
        try {
          if (step.stepId === "navigate_detail") {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
            const productTitleLoaded = await page.waitForSelector("#productTitle", {
              state: "attached",
              timeout: 10_000,
            }).then(() => true).catch(() => false);
            if (productTitleLoaded) {
              await page.waitForSelector([
                "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
                "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen",
                "#corePrice_feature_div .a-offscreen",
                ".priceToPay .a-offscreen",
                "#priceblock_ourprice",
                "#priceblock_dealprice",
              ].join(","), {
                state: "attached",
                timeout: 5_000,
              }).catch(() => undefined);
            }
            return { status: "completed", errorCode: null, pageClass: "navigation_complete", elapsedMs: Date.now() - startedAt };
          }
          if (step.stepId === "classify_page" || step.stepId === "prove_entity_binding") {
            const snapshot = await page.evaluate<AmazonDetailPageDomSnapshot>(buildAmazonDetailPageSnapshotExpression());
            pageFieldPresenceAudit = process.env.AMAZON_DETAIL_D4_FIELD_AUDIT === "true"
              ? auditAmazonDetailPageFieldPresence(snapshot, { includeCandidateEvidence: true })
              : null;
            extraction = extractAmazonDetailPageV2(snapshot, {
              expectedAsin: input.asin,
              capturedAt: input.now.toISOString(),
              collectorVersion: AMAZON_DETAIL_COLLECTOR_VERSION,
              marketplace: "US",
            });
            if (extraction.pageStatus !== "ok") {
              const pageTitle = await page.title().catch(() => "");
              const isSiteError = classifyAmazonCapturePageTitle(pageTitle) === "site_error_page";
              return {
                status: isSiteError ? "failed" : "human_required",
                errorCode: extraction.pageStatus === "captcha"
                  ? "CAPTCHA_DETECTED"
                  : extraction.pageStatus === "login_wall"
                    ? "LOGIN_REQUIRED"
                    : isSiteError
                      ? "AMAZON_SITE_ERROR"
                      : extraction.pageStatus === "automation_blocked"
                        ? "AUTOMATION_BLOCKED"
                        : "PAGE_CHANGED",
                pageClass: `amazon_${extraction.pageStatus}`,
                elapsedMs: Date.now() - startedAt,
              };
            }
            if (step.stepId === "classify_page" && extraction.fields.price.reason?.startsWith("currency_not_usd:")) {
              return { status: "failed", errorCode: "LOCALE_MISMATCH", pageClass: "amazon_currency_not_usd", elapsedMs: Date.now() - startedAt };
            }
            if (step.stepId === "prove_entity_binding" && !extraction.entityBound) {
              return { status: "human_required", errorCode: "ASIN_NOT_FOUND", pageClass: "amazon_binding_failed", elapsedMs: Date.now() - startedAt };
            }
            return { status: "completed", errorCode: null, pageClass: "amazon_normal", elapsedMs: Date.now() - startedAt };
          }
          if (step.stepId === "extract_detail_fields") {
            if (!extraction) {
              const snapshot = await page.evaluate<AmazonDetailPageDomSnapshot>(buildAmazonDetailPageSnapshotExpression());
              pageFieldPresenceAudit = process.env.AMAZON_DETAIL_D4_FIELD_AUDIT === "true"
                ? auditAmazonDetailPageFieldPresence(snapshot, { includeCandidateEvidence: true })
                : null;
              extraction = extractAmazonDetailPageV2(snapshot, {
                expectedAsin: input.asin,
                capturedAt: input.now.toISOString(),
                collectorVersion: AMAZON_DETAIL_COLLECTOR_VERSION,
                marketplace: "US",
              });
            }
            return { status: "completed", errorCode: null, pageClass: "amazon_detail_fields", elapsedMs: Date.now() - startedAt };
          }
          return { status: "completed", errorCode: null, pageClass: "capture_gateway_pending", elapsedMs: Date.now() - startedAt };
        } catch (error) {
          return { status: "failed", errorCode: captureDriverFailureCode(error), pageClass: "browser_error", elapsedMs: Date.now() - startedAt };
        }
      },
    };
    const trace = await executeRecipeWithPlaywright({ recipeId: "product_detail", driver, now: input.now, traceId: input.traceId });
    const pageUrl = page.url();
    if (!extraction) {
      let failureCapture: CaptureGatewayResult | null = null;
      try {
        failureCapture = await captureThroughGateway({
          context: input.context,
          source: "amazon_dom",
          payload: { asin: input.asin, productUrl: targetUrl },
          now: input.now,
          sourceUrl: isSafeAmazonUrl(pageUrl) ? pageUrl : targetUrl,
          subjectKey: `amazon:US:${input.asin}`,
          marketplace: "US",
          pageContext: {
            pageClass: "browser_error",
            allowFields: false,
            errorCode: normalizeSourceLayerErrorCode(trace.errorCode),
            reason: "浏览器在详情字段提取前失败；仅保存零字段失败证据。",
            entityBinding: {
              expectedAsin: input.asin,
              observedAsin: null,
              expectedMarketplace: "US",
              observedMarketplace: null,
              urlAsin: input.asin,
              urlMarketplace: "US",
              bound: false,
            },
          },
          traceId: trace.traceId,
        });
      } catch {
        // 浏览器本身失败时，诊断写入仍是 best-effort；不伪造成功采集结果。
      }
      await recordBrowserDiagnostic({
        context: input.context,
        traceId: trace.traceId ?? "",
        subjectKey: `amazon:US:${input.asin}`,
        module: "BROWSER",
        phase: "browser",
        eventType: "browser_navigation",
        status: "failed",
        reason: "浏览器未返回可解析的详情页提取结果。",
        errorCode: trace.errorCode,
        recipeVersion: trace.recipeId,
        humanRequired: trace.status === "human_required",
      });
      return {
        status: trace.status === "human_required" ? "human_required" : "failed",
        trace,
        extraction: null,
        pageFieldPresenceAudit,
        capture: failureCapture,
        errorCode: trace.errorCode,
        errorMessage: "浏览器没有返回详情页提取结果。",
        consoleErrors,
        consoleErrorDiagnostics: consoleErrorCollector.snapshot(),
        pageErrors,
        browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
      };
    }
    const plan = planAmazonDetailCapture({
      extraction,
      pageUrl: isSafeAmazonUrl(pageUrl) ? pageUrl : targetUrl,
    });
    const capture = await captureThroughGateway({
      context: input.context,
      source: "amazon_dom",
      payload: plan.payload,
      now: input.now,
      sourceUrl: plan.sourceUrl ?? (isSafeAmazonUrl(pageUrl) ? pageUrl : targetUrl),
      subjectKey: plan.subjectKey,
      marketplace: "US",
      pageContext: plan.pageContext,
      traceId: trace.traceId,
    });
    const postWriteFailures: NonNullable<AmazonDetailBrowserCollectionResult["postWriteFailures"]> = [];
    if (plan.ok) {
      const extractedDetail = extraction as AmazonDetailPageExtractionV2;
      const moduleFailure = await captureModuleEvidenceAfterGateway(capture, {
        context: input.context,
        sourceType: "amazon_dom",
        moduleEvidence: {
          module: "amazon_detail",
          subjectKey: plan.subjectKey,
          marketplace: "US",
          capturedAt: input.now.toISOString(),
          provider: "Amazon",
          sourceSurface: "amazon product detail DOM",
          sourceUrl: plan.sourceUrl,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "source_observed",
          status: "VALIDATED_AVAILABLE",
          identity: { asin: input.asin },
          data: {
            registeredFields: extractedDetail.registeredFields,
            payload: plan.payload,
            pageFieldPresenceAudit,
          },
          evidenceOnly: true,
        },
      });
      if (moduleFailure) postWriteFailures.push(moduleFailure);
    }
    const detailSubjectKey = capture.capture.items[0]?.subjectKey ?? plan.subjectKey;
    const detailEvidenceRefs = capture.productFacts.map((fact) => fact.sourceProof.evidenceId);
    await recordBrowserDiagnostic({
      context: input.context,
      traceId: trace.traceId ?? capture.traceId,
      subjectKey: detailSubjectKey,
      module: "ENTITY_BINDING",
      phase: "extract",
      eventType: "entity_binding_checked",
      status: plan.ok ? "succeeded" : "blocked",
      reason: plan.ok
        ? "详情页 URL、页面 ASIN 与目标 ASIN 已通过实体绑定检查。"
        : "详情页实体绑定未通过，字段不会升级为可研究事实。",
      errorCode: plan.ok ? null : plan.errorCode,
      evidenceRefs: detailEvidenceRefs,
      contentHash: capture.capture.items[0]?.contentHash ?? null,
      recipeVersion: trace.recipeId,
      pageTemplateHash: AMAZON_DETAIL_COLLECTOR_VERSION,
      humanRequired: !plan.ok,
    });
    await recordBrowserDiagnostic({
      context: input.context,
      traceId: trace.traceId ?? capture.traceId,
      subjectKey: detailSubjectKey,
      module: "BROWSER",
      phase: "browser",
      eventType: "browser_navigation",
      status: trace.status === "completed" ? "succeeded" : "blocked",
      reason: "Playwright 详情页完成页面状态与实体绑定检查。",
      errorCode: trace.errorCode,
      evidenceRefs: detailEvidenceRefs,
      contentHash: capture.capture.items[0]?.contentHash ?? null,
      recipeVersion: trace.recipeId,
      pageTemplateHash: AMAZON_DETAIL_COLLECTOR_VERSION,
      humanRequired: trace.humanTakeoverRequired,
    });
    await recordBrowserDiagnostic({
      context: input.context,
      traceId: trace.traceId ?? capture.traceId,
      subjectKey: detailSubjectKey,
      module: "EXTRACTOR",
      phase: "extract",
      eventType: "field_extracted",
      status: plan.ok ? "succeeded" : "blocked",
      reason: plan.ok ? "详情页固定字段已完成确定性提取。" : "详情页提取被页面门禁阻断，未生成事实字段。",
      errorCode: plan.ok ? null : plan.errorCode,
      evidenceRefs: detailEvidenceRefs,
      contentHash: capture.capture.items[0]?.contentHash ?? null,
      recipeVersion: trace.recipeId,
      pageTemplateHash: AMAZON_DETAIL_COLLECTOR_VERSION,
      humanRequired: !plan.ok,
    });
    return {
      status: plan.ok ? "captured" : "human_required",
      partial: postWriteFailures.length > 0,
      postWriteFailures,
      trace,
      extraction,
      pageFieldPresenceAudit,
      capture,
      errorCode: plan.ok ? null : plan.errorCode,
      errorMessage: plan.ok ? null : plan.reason,
      consoleErrors,
      consoleErrorDiagnostics: consoleErrorCollector.snapshot(),
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } catch (error) {
    return {
      status: "failed",
      trace: null,
      extraction,
      pageFieldPresenceAudit,
      capture: null,
      errorCode: profileLeaseErrorCode(error) ?? "PLAYWRIGHT_BROWSER_FAILED",
      errorMessage: profileLeaseErrorMessage(error) ?? (error instanceof Error ? error.message : "Playwright 浏览器执行失败。"),
      consoleErrors,
      consoleErrorDiagnostics: consoleErrorCollector.snapshot(),
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } finally {
    if (closeProfileContext) await closeProfileContext();
  }
}

export async function collectAmazonDetailWithPlaywright(input: {
  context: AccessContext;
  asin: string;
  now?: Date;
  traceId?: string;
}): Promise<AmazonDetailBrowserCollectionResult> {
  const asin = input.asin.trim().toUpperCase();
  if (!ASIN_PATTERN.test(asin)) {
    return {
      status: "failed",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: "ASIN_INVALID",
      errorMessage: "ASIN 必须是 10 位大写字母或数字。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  if (process.env.LOCAL_ACQUISITION_ENABLED !== "true") {
    return {
      status: "unavailable",
      trace: null,
      extraction: null,
      capture: null,
      errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
      errorMessage: "实时页面采集需要在本地研究环境开启。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  return runWithPlaywright({ context: input.context, asin, now: input.now ?? new Date(), traceId: input.traceId });
}

function searchUrl(query: string, page: number): string {
  const url = new URL("https://www.amazon.com/s");
  url.searchParams.set("k", query);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function searchGateErrorCode(failedStage: string | null): string {
  switch (failedStage) {
    case "marketplace_verification": return "MARKETPLACE_MISMATCH";
    case "delivery_verification": return "MARKETPLACE_MISMATCH";
    case "language_verification": return "LOCALE_MISMATCH";
    case "currency_verification": return "LOCALE_MISMATCH";
    case "page_status": return "PAGE_CHANGED";
    default: return "PAGE_CHANGED";
  }
}

/**
 * 搜索结果就绪选择器：命中「结果卡片」或「明确终态」（验证码 / 登录墙 / 无结果）。
 *
 * 为什么需要：搜索页 `goto` 只等到 DOMContentLoaded，结果卡片由 Amazon 前端异步注入。
 * 旧实现导航后立刻抽取，冷启动或慢网络下会读到 0 张卡片 → `detectPageStatus` 判为
 * unknown_page → PAGE_CHANGED，用户看到「页面结构发生变化」，实际只是尚未渲染完成。
 */
export const AMAZON_SEARCH_READY_SELECTOR = [
  '[data-component-type="s-search-result"]',
  ".s-main-slot .s-result-item",
  'form[action*="validateCaptcha"]',
  'form[name="signIn"]',
  ".s-no-results",
  '[data-component-type="no-results"]',
].join(", ");

/**
 * 有界等待搜索页就绪（非抛出）。
 *
 * 超时后不改变任何判定：仍由 `detectPageStatus` + 环境门禁决定 ok / captcha / login_wall /
 * unknown_page，fail-closed 语义与等待前完全一致。
 */
export async function waitForAmazonSearchResults(
  page: { waitForSelector: (selector: string, options?: { state?: string; timeout?: number }) => Promise<unknown> },
  timeoutMs = 8_000,
): Promise<void> {
  await page.waitForSelector(AMAZON_SEARCH_READY_SELECTOR, { state: "attached", timeout: timeoutMs }).catch(() => undefined);
}

export async function collectAmazonSearchWithPlaywright(input: {
  context: AccessContext;
  query: string;
  pages?: number;
  maxAppearances?: number;
  /** 批次扩充时从历史已用页码之后继续，不回到第一页。 */
  startPage?: number;
  /** 已属于当前批次的 ASIN；过滤后不会再次写入 Capture Gateway。 */
  excludeAsins?: readonly string[];
  now?: Date;
  traceId?: string;
  onPageCheckpoint?: (checkpoint: AmazonSearchPageCheckpoint) => Promise<void>;
}): Promise<AmazonSearchBrowserCollectionResult> {
  const query = input.query.trim();
  const pageCount = input.pages ?? 1;
  const startPage = input.startPage ?? 1;
  const requestedSampleLimit = input.maxAppearances ?? 20;
  if (!query) {
    return { status: "failed", traces: [], plan: null, captures: [], errorCode: "QUERY_REQUIRED", errorMessage: "搜索关键词不能为空。", consoleErrors: 0, pageErrors: 0, browser: null };
  }
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10
    || !Number.isInteger(startPage) || startPage < 1 || startPage + pageCount - 1 > 10) {
    return { status: "failed", traces: [], plan: null, captures: [], errorCode: "PAGE_BUDGET_INVALID", errorMessage: "市场搜索最多采集 10 页。", consoleErrors: 0, pageErrors: 0, browser: null };
  }
  if (!Number.isInteger(requestedSampleLimit) || requestedSampleLimit < 1 || requestedSampleLimit > 200) {
    return { status: "failed", traces: [], plan: null, captures: [], errorCode: "SAMPLE_BUDGET_INVALID", errorMessage: "单次市场搜索样本上限必须为 1–200 条。", consoleErrors: 0, pageErrors: 0, browser: null };
  }
  if (process.env.LOCAL_ACQUISITION_ENABLED !== "true") {
    return { status: "unavailable", traces: [], plan: null, captures: [], errorCode: "LOCAL_ENVIRONMENT_REQUIRED", errorMessage: "实时页面采集需要在本地研究环境开启。", consoleErrors: 0, pageErrors: 0, browser: null };
  }
  const playwrightModule = await loadPlaywright<PlaywrightModule>();
  const browser = resolveSystemBrowser();
  if (!playwrightModule) {
    return { status: "unavailable", traces: [], plan: null, captures: [], errorCode: "PLAYWRIGHT_RUNTIME_MISSING", errorMessage: "当前项目未安装 Playwright runtime；没有回退到 CDP。", consoleErrors: 0, pageErrors: 0, browser: browser ? { name: browser.browser, profile: AMAZON_PROFILE_DIR } : null };
  }
  if (!browser) {
    return { status: "unavailable", traces: [], plan: null, captures: [], errorCode: "BROWSER_NOT_FOUND", errorMessage: "本机未检测到可用于 Playwright 的 Chrome/Edge。", consoleErrors: 0, pageErrors: 0, browser: null };
  }
  const captureNetwork = resolveAmazonCaptureNetworkConfig();
  if (captureNetwork.invalidReason) {
    return { status: "failed", traces: [], plan: null, captures: [], errorCode: "AMAZON_CAPTURE_PROXY_INVALID", errorMessage: `${captureNetwork.invalidReason}为避免误采，本次未启动采集浏览器。`, consoleErrors: 0, pageErrors: 0, browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR } };
  }

  const preflight = await checkAmazonCapturePreflight({ env: captureNetwork.env });
  if (!preflight.ok) {
    await recordBrowserDiagnostic({
      context: input.context,
      traceId: input.traceId ?? "",
      subjectKey: "amazon:US:market_search",
      module: "BROWSER",
      phase: "browser",
      eventType: "amazon_market_search_preflight",
      status: "blocked",
      reason: preflight.message,
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      humanRequired: false,
    });
    return {
      status: "failed",
      traces: [],
      plan: null,
      captures: [],
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      errorMessage: `${preflight.message}为避免误采，本次未启动采集浏览器。`,
      consoleErrors: 0,
      pageErrors: 0,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  const now = input.now ?? new Date();
  const excludedAsins = new Set((input.excludeAsins ?? []).map((asin) => asin.trim().toUpperCase()).filter(Boolean));
  const excludeExisting = <T extends { observations: Array<{ asin?: string | null }> }>(page: T): T => ({
    ...page,
    observations: page.observations.filter((observation) => !observation.asin || !excludedAsins.has(observation.asin.toUpperCase())),
  });
  let context: PlaywrightContext | null = null;
  let consoleErrors = 0;
  let pageErrors = 0;
  const traces: RecipeRunTrace[] = [];
  let closeProfileContext: (() => Promise<void>) | null = null;
  const extractionPages: Parameters<typeof planAmazonSearchCapture>[0]["pages"][number][] = [];
  const captures: CaptureGatewayResult[] = [];
  const postWriteFailures: NonNullable<AmazonSearchBrowserCollectionResult["postWriteFailures"]> = [];
  const pageCheckpoints = new Map<number, AmazonSearchPageCheckpoint>();
  const persistedAsins = new Set(excludedAsins);
  let navigationUsed = 0;
  const checkpoint = async (next: AmazonSearchPageCheckpoint) => {
    pageCheckpoints.set(next.page, next);
    await input.onPageCheckpoint?.(next);
  };
  const persistValidatedPage = async (page: Parameters<typeof planAmazonSearchCapture>[0]["pages"][number]) => {
    const pagePlan = planAmazonSearchCapture({ pages: [page], maxAppearances: requestedSampleLimit });
    for (const observation of pagePlan.observations) {
      if (observation.status !== "ready" || !observation.payload || !observation.productUrl || !observation.asin
        || persistedAsins.has(observation.asin.toUpperCase())) continue;
      const captured = await captureThroughGateway({
        context: input.context,
        source: "amazon_dom",
        payload: observation.payload,
        now,
        sourceUrl: observation.productUrl,
        subjectKey: `amazon:US:${observation.asin}`,
        marketplace: "US",
        pageContext: {
          pageClass: "amazon_search_normal",
          allowFields: true,
          entityBinding: {
            expectedAsin: observation.asin,
            observedAsin: observation.asin,
            expectedMarketplace: "US",
            observedMarketplace: "US",
            urlAsin: observation.asin,
            urlMarketplace: "US",
            bound: true,
          },
        },
        traceId: traces[0]?.traceId,
      });
      captures.push(captured);
      persistedAsins.add(observation.asin.toUpperCase());
      const evidenceReferences = captured.productFacts.flatMap((fact) => {
        const proof = fact.sourceProof;
        const item = captured.capture.items.find((candidate) => (
          candidate.subjectKey === proof.subjectKey && candidate.captureId === proof.captureId
        ));
        return item ? [{
          subjectKey: proof.subjectKey,
          captureId: proof.captureId,
          evidenceId: proof.evidenceId,
          evidenceVersion: item.version,
          contentHash: proof.contentHash,
        }] : [];
      });
      const prior = pageCheckpoints.get(page.page);
      await checkpoint({
        page: page.page,
        state: "evidence_persisted",
        pageStatus: page.pageStatus,
        observationCount: page.observations.length,
        evidenceReferences: [...(prior?.evidenceReferences ?? []), ...evidenceReferences],
      });
      const moduleFailure = await captureModuleEvidenceAfterGateway(captured, {
        context: input.context,
        sourceType: "amazon_dom",
        moduleEvidence: {
          module: "amazon_search_market",
          subjectKey: `amazon:US:${observation.asin}`,
          marketplace: "US",
          capturedAt: now.toISOString(),
          provider: "Amazon",
          sourceSurface: "amazon search result DOM",
          sourceUrl: observation.sourceUrl,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "source_observed",
          status: "AVAILABLE_WITH_LIMITATION",
          limitations: ["sample:collector_page_budget"],
          identity: { asin: observation.asin, query: pagePlan.query },
          data: {
            query: pagePlan.query,
            page: observation.page,
            position: observation.position,
            sponsored: observation.sponsored,
            observedProduct: observation.payload,
          },
          evidenceOnly: true,
        },
      });
      if (moduleFailure) postWriteFailures.push(moduleFailure);
    }
  };
  const plannedPartialResult = (input: {
    status: "failed" | "human_required";
    errorCode: string;
    errorMessage: string;
    page: number;
  }): AmazonSearchBrowserCollectionResult => {
    const plan = extractionPages.length > 0
      ? planAmazonSearchCapture({ pages: extractionPages, maxAppearances: requestedSampleLimit })
      : null;
    return {
      status: captures.length > 0 ? "captured" : input.status,
      traces,
      plan,
      captures: [...captures],
      partial: captures.length > 0,
      postWriteFailures: [...postWriteFailures],
      navigationUsed,
      pageCheckpoints: [...pageCheckpoints.values()].sort((a, b) => a.page - b.page),
      errorCode: input.errorCode,
      errorMessage: `第 ${input.page} 页未完成：${input.errorMessage}`,
      consoleErrors,
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  };
  try {
    const leasedContext = await launchAmazonCapturePersistentContext(() => playwrightModule.chromium.launchPersistentContext(
      AMAZON_PROFILE_DIR,
      buildAmazonCaptureContextOptions({ executablePath: browser.executablePath, proxy: captureNetwork.proxy }),
    ));
    context = leasedContext.context;
    closeProfileContext = leasedContext.close;
    const page = await context.newPage();
    page.on("console", (...args) => {
      const message = args[0] as { type?: () => string } | undefined;
      if (message?.type?.() === "error") consoleErrors += 1;
    });
    page.on("pageerror", () => { pageErrors += 1; });
    const sessionEnvironment = await ensureAmazonUsSessionEnvironment({
      page, networkPreflight: preflight.status === "US_READY" ? "US_READY" : preflight.status === "NON_US_EXIT" ? "NON_US_EXIT" : "UNKNOWN",
      module: "SEARCH", traceId: input.traceId ?? "",
      onDiagnostic: async (fields) => recordBrowserDiagnostic({
        context: input.context, traceId: fields.traceId, subjectKey: "amazon:US:market_search",
        module: fields.module, phase: "browser", eventType: fields.eventType, status: fields.finalEnvironmentStatus === "US_READY" ? "succeeded" : "blocked",
        reason: sessionDiagnosticReason(fields),
        durationMs: fields.elapsedMs,
      }),
    });
    if (!sessionEnvironment.ok) return {
      status: "failed", traces: [], plan: null, captures: [],
      errorCode: sessionEnvironment.errorCode ?? "AMAZON_US_SESSION_CALIBRATION_FAILED",
      errorMessage: sessionEnvironment.errorMessage ?? "Amazon 美国会话环境门禁未通过。",
      sessionDiagnostics: toAmazonSessionFailureReport(sessionEnvironment),
      consoleErrors, pageErrors, browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
    let firstExtraction: Awaited<ReturnType<typeof page.evaluate>> | null = null;
    let firstSignals: AmazonPageContextSignals | null = null;
    let firstEnvironmentGate: AmazonEnvironmentGateResult | null = null;
    const driver: PlaywrightRecipeDriver = {
      kind: "playwright",
      runStep: async ({ step }) => {
        const startedAt = Date.now();
        try {
          if (step.stepId === "submit_keyword") {
            navigationUsed += 1;
            await checkpoint({
              page: startPage,
              state: "navigating",
              pageStatus: "not_checked",
              observationCount: 0,
              evidenceReferences: [],
            });
            await page.goto(searchUrl(query, startPage), { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
            return { status: "completed", errorCode: null, pageClass: "navigation_complete", elapsedMs: Date.now() - startedAt };
          }
          if (step.stepId === "classify_search_page" || step.stepId === "extract_search_page") {
            // 等结果卡片或明确终态出现，再抽取；超时仍按原门禁判定（不放宽 fail-closed）。
            await waitForAmazonSearchResults(page);
            firstSignals = await page.evaluate<AmazonPageContextSignals>(buildAmazonPageContextExpression());
            firstExtraction = excludeExisting(await page.evaluate(buildAmazonSearchPageExtractionExpression({
              query,
              page: startPage,
              maxAppearances: requestedSampleLimit,
              capturedAt: now.toISOString(),
              requested: { marketplace: "amazon.com", market: "US", currency: "USD" },
              observed: {},
            })));
            await checkpoint({
              page: startPage,
              state: "extracted",
              pageStatus: (firstExtraction as { pageStatus?: string }).pageStatus ?? "unknown",
              observationCount: (firstExtraction as { observations?: unknown[] }).observations?.length ?? 0,
              evidenceReferences: [],
            });
            const extraction = firstExtraction as Parameters<typeof evaluateAmazonSearchPageEnvironment>[1];
            const environment = evaluateAmazonSearchPageEnvironment(firstSignals, extraction);
            if (environment.status !== "passed") {
              await checkpoint({
                page: startPage,
                state: "blocked",
                pageStatus: extraction.pageStatus ?? "unknown",
                observationCount: extraction.observations?.length ?? 0,
                errorCode: extraction.pageStatus === "captcha" ? "CAPTCHA_DETECTED"
                  : extraction.pageStatus === "login_wall" ? "LOGIN_REQUIRED"
                    : searchGateErrorCode(environment.failedStage),
                evidenceReferences: [],
              });
              // 门禁结果必须带出 driver 供外层生成可读诊断（真实失败条件，而非笼统文案）。
              firstEnvironmentGate = environment;
              /**
               * 页面本身就是「要人确认」时，错误码必须反映这一点，而不是被门禁统一压成
               * PAGE_CHANGED。否则前端会显示「页面结构变化」，把 Amazon 的 checkpoint /
               * 验证码误导成需要维护者改选择器。仍然 fail-closed，不绕过校验。
               */
              const pageStatus = extraction.pageStatus ?? "unknown_page";
              if (pageStatus === "captcha" || pageStatus === "login_wall") {
                return {
                  status: "human_required",
                  errorCode: pageStatus === "captcha" ? "CAPTCHA_DETECTED" : "LOGIN_REQUIRED",
                  pageClass: `amazon_search_${pageStatus}`,
                  elapsedMs: Date.now() - startedAt,
                };
              }
              return {
                status: extraction.pageStatus === "captcha" || extraction.pageStatus === "login_wall" ? "human_required" : "failed",
                errorCode: searchGateErrorCode(environment.failedStage),
                pageClass: `amazon_search_${extraction.pageStatus ?? "unknown"}`,
                elapsedMs: Date.now() - startedAt,
              };
            }
            if (extraction.pageStatus !== "ok") {
              await checkpoint({
                page: startPage,
                state: "blocked",
                pageStatus: extraction.pageStatus,
                observationCount: extraction.observations?.length ?? 0,
                errorCode: extraction.pageStatus === "captcha" ? "CAPTCHA_DETECTED" : extraction.pageStatus === "login_wall" ? "LOGIN_REQUIRED" : "PAGE_CHANGED",
                evidenceReferences: [],
              });
              return { status: "human_required", errorCode: extraction.pageStatus === "captcha" ? "CAPTCHA_DETECTED" : extraction.pageStatus === "login_wall" ? "LOGIN_REQUIRED" : "PAGE_CHANGED", pageClass: `amazon_search_${extraction.pageStatus}`, elapsedMs: Date.now() - startedAt };
            }
            return { status: "completed", errorCode: null, pageClass: "amazon_search_normal", elapsedMs: Date.now() - startedAt };
          }
          return { status: "completed", errorCode: null, pageClass: "amazon_search_bound", elapsedMs: Date.now() - startedAt };
        } catch (error) {
          return { status: "failed", errorCode: captureDriverFailureCode(error), pageClass: "browser_error", elapsedMs: Date.now() - startedAt };
        }
      },
    };
    const trace = await executeRecipeWithPlaywright({ recipeId: "market_search", driver, now, traceId: input.traceId });
    traces.push(trace);
    if (trace.status !== "completed" || !firstExtraction || !firstSignals) {
      // 失败必须说清真实条件：目标站点固定为 www.amazon.com，门禁失败时区分
      // 「被导向其它站点」/「站点正确但配送地区、语言或币种不是美国」/「页面本身不可解析」。
      // 注意：这两个变量在 driver 闭包内赋值，TS 会按初始值把本分支收窄为 null，
      // 因此这里按声明类型回读真实运行值。
      const signals = firstSignals as AmazonPageContextSignals | null;
      const gate = firstEnvironmentGate as AmazonEnvironmentGateResult | null;
      const pageUrl = signals?.pageUrl ?? page.url();
      // 站点错误页（如 "Sorry! Something went wrong!"）只能靠页面标题识别；
      // 取不到标题不影响诊断，退化为通用文案。标题不做持久化，只做白名单归类。
      const pageTitle = await page.title().catch(() => "");
      const pageTitleClass = classifyAmazonCapturePageTitle(pageTitle);
      const isSiteError = pageTitleClass === "site_error_page";
      const resolvedErrorCode = isSiteError ? "AMAZON_SITE_ERROR" : trace.errorCode;
      const errorMessage = gate
        ? describeAmazonEnvironmentFailure(gate, pageUrl, pageTitle)
        : "采集浏览器没有拿到可解析的 Amazon 搜索页结果（导航失败或超时），未继续采集。";
      await recordBrowserDiagnostic({
        context: input.context,
        traceId: trace.traceId ?? "",
        subjectKey: "amazon:US:market_search",
        module: "BROWSER",
        phase: "browser",
        eventType: "amazon_market_search_preflight",
        status: "blocked",
        // 只记录站点信号（主机 / 门禁阶段 / 配送地区 / 语言 / 币种 / 页面归类）；不含 Cookie、Token、认证头。
        reason: gate
          ? `美国环境预检未通过（stage=${gate.failedStage ?? "unknown"}；host=${observedHost(pageUrl) || "unknown"}；page=${pageTitleClass ?? "unknown"}；delivery=${gate.observed.deliveryRegion ?? "unknown"}；language=${gate.observed.language ?? "unknown"}；currency=${gate.observed.currency ?? "unknown"}）。`
          : "采集浏览器未返回 Amazon 搜索页提取结果。",
        errorCode: resolvedErrorCode,
        recipeVersion: trace.recipeId,
        humanRequired: isSiteError ? false : trace.status === "human_required",
      });
      return {
        status: captures.length > 0 ? "captured" : isSiteError ? "failed" : trace.status === "human_required" ? "human_required" : "failed",
        traces,
        plan: null,
        captures: [...captures],
        partial: captures.length > 0,
        postWriteFailures: [...postWriteFailures],
        navigationUsed,
        pageCheckpoints: [...pageCheckpoints.values()],
        errorCode: resolvedErrorCode,
        errorMessage,
        consoleErrors,
        pageErrors,
        browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
      };
    }
    const firstTyped = firstExtraction as Parameters<typeof planAmazonSearchCapture>[0]["pages"][number];
    extractionPages.push(firstTyped);
    await checkpoint({
      page: firstTyped.page,
      state: "validated",
      pageStatus: firstTyped.pageStatus,
      observationCount: firstTyped.observations.length,
      evidenceReferences: [],
    });
    await persistValidatedPage(firstTyped);
    for (let pageNumber = startPage + 1; pageNumber <= startPage + pageCount - 1; pageNumber += 1) {
      /**
       * 采样预算边界（2026-10-14 修复）：
       * 第 1 页的页内提取上限就是 `requestedSampleLimit`（按实际卡片数截断），
       * 因此当第 1 页已取满预算时（常见于 authorizedItemLimit > 单页卡片数假设），
       * 后续页的剩余预算会变成 0；旧的直接传参会触发页内 `COLLECTOR_SAMPLE_BUDGET_INVALID`
       * （要求 maxAppearances ≥ 1）导致整次搜索失败（真实复现：authorizedItemLimit=35 → 2 页 → 第 2 页预算 0 → HTTP 500）。
       * 修复语义：预算已用尽时**不再导航后续页**（无意义导航），以已提取的观察完成计划；
       * 未用尽时行为与原先完全一致。不改变任何页数上限、样本上限或门禁语义。
       */
      const remainingAppearances = requestedSampleLimit
        - extractionPages.reduce((sum, item) => sum + item.observations.length, 0);
      if (remainingAppearances < 1) break;
      navigationUsed += 1;
      await checkpoint({
        page: pageNumber,
        state: "navigating",
        pageStatus: "not_checked",
        observationCount: 0,
        evidenceReferences: [],
      });
      await page.goto(searchUrl(query, pageNumber), { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
      await waitForAmazonSearchResults(page);
      const signals = await page.evaluate<AmazonPageContextSignals>(buildAmazonPageContextExpression());
      const extraction = await page.evaluate(buildAmazonSearchPageExtractionExpression({
        query,
        page: pageNumber,
        maxAppearances: remainingAppearances,
        capturedAt: now.toISOString(),
        requested: { marketplace: "amazon.com", market: "US", currency: "USD" },
        observed: {},
      }));
      const typed = excludeExisting(extraction as Parameters<typeof planAmazonSearchCapture>[0]["pages"][number]);
      await checkpoint({
        page: pageNumber,
        state: "extracted",
        pageStatus: typed.pageStatus,
        observationCount: typed.observations.length,
        evidenceReferences: [],
      });
      const environment = evaluateAmazonSearchPageEnvironment(signals, typed);
      if (environment.status !== "passed") {
        const humanRequired = typed.pageStatus === "captcha" || typed.pageStatus === "login_wall";
        const errorCode = humanRequired
          ? typed.pageStatus === "captcha" ? "CAPTCHA_DETECTED" : "LOGIN_REQUIRED"
          : searchGateErrorCode(environment.failedStage);
        await checkpoint({
          page: pageNumber,
          state: "blocked",
          pageStatus: typed.pageStatus,
          observationCount: typed.observations.length,
          errorCode,
          evidenceReferences: [],
        });
        const pageTitle = await page.title().catch(() => "");
        const pageTitleClass = classifyAmazonCapturePageTitle(pageTitle);
        await recordBrowserDiagnostic({
          context: input.context,
          traceId: traces[0]?.traceId ?? "",
          subjectKey: "amazon:US:market_search",
          module: "BROWSER",
          phase: "browser",
          eventType: "amazon_market_search_page_environment",
          status: "blocked",
          reason: `第 ${pageNumber} 页美国环境门禁未通过（stage=${environment.failedStage ?? "unknown"}；host=${observedHost(signals.pageUrl) || "unknown"}；page=${pageTitleClass ?? "unknown"}；delivery=${environment.observed.deliveryRegion ?? "unknown"}；language=${environment.observed.language ?? "unknown"}；currency=${environment.observed.currency ?? "unknown"}）。`,
          errorCode,
          recipeVersion: traces[0]?.recipeId,
          humanRequired,
        });
        const detail = describeAmazonEnvironmentFailure(environment, signals.pageUrl, pageTitle);
        return plannedPartialResult({
          status: humanRequired ? "human_required" : "failed",
          errorCode,
          errorMessage: `未通过 Amazon US 市场环境门禁。${detail}`,
          page: pageNumber,
        });
      }
      extractionPages.push(typed);
      await checkpoint({
        page: pageNumber,
        state: "validated",
        pageStatus: typed.pageStatus,
        observationCount: typed.observations.length,
        evidenceReferences: [],
      });
      await persistValidatedPage(typed);
    }
    const plan = planAmazonSearchCapture({ pages: extractionPages, maxAppearances: requestedSampleLimit });
    return {
      status: "captured",
      traces,
      plan,
      captures,
      partial: postWriteFailures.length > 0,
      postWriteFailures,
      navigationUsed,
      pageCheckpoints: [...pageCheckpoints.values()].sort((a, b) => a.page - b.page),
      errorCode: null,
      errorMessage: null,
      consoleErrors,
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } catch (error) {
    const code = profileLeaseErrorCode(error) ?? "PLAYWRIGHT_BROWSER_FAILED";
    const message = profileLeaseErrorMessage(error) ?? (error instanceof Error ? error.message : "Playwright 搜索采集失败。");
    const partialPlan = extractionPages.length > 0
      ? planAmazonSearchCapture({ pages: extractionPages, maxAppearances: requestedSampleLimit })
      : null;
    return {
      status: captures.length > 0 ? "captured" : "failed",
      traces,
      plan: partialPlan,
      captures: [...captures],
      partial: captures.length > 0 || postWriteFailures.length > 0,
      postWriteFailures: [...postWriteFailures],
      navigationUsed,
      pageCheckpoints: [...pageCheckpoints.values()].sort((a, b) => a.page - b.page),
      errorCode: code,
      errorMessage: message,
      consoleErrors,
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } finally {
    if (closeProfileContext) await closeProfileContext();
  }
}

function reviewStatusForPage(status: string): { status: string; note: string } | null {
  if (status === "captcha") return { status: "captcha_required", note: "页面要求完成 CAPTCHA 验证，系统未绕过。" };
  if (status === "automation_blocked") return { status: "captcha_required", note: "Amazon 触发自动化访问校验，系统未绕过。" };
  if (status === "login_wall") return { status: "login_required", note: "页面要求登录，系统未自动登录。" };
  if (status === "error_page") return { status: "page_error", note: "Amazon 返回错误页，未提取评论。" };
  return null;
}

type ReviewPageCaptureAttempt = {
  pageResult: AmazonReviewBrowserCollectionResult["pageResults"][number];
  items: AmazonReviewBrowserCollectionResult["items"];
  retryable: boolean;
  humanRequired: boolean;
};

async function collectReviewPage(input: {
  page: PlaywrightPage;
  asin: string;
  role: ReviewSourceProductRole;
  now: Date;
  strategy: "persistent_profile" | "fresh_context";
  freshSessionAttempt?: number;
  consoleErrors?: number;
  pageErrors?: number;
}): Promise<ReviewPageCaptureAttempt> {
  const finalUrl = input.page.url();
  const asin = input.asin;
  const strategy = input.strategy;
  const freshSessionAttempt = input.freshSessionAttempt;
  const diagnosticsBase = {
    strategy,
    identityCheckVersion: "review-page-identity.v2",
    ...(freshSessionAttempt ? { freshSessionAttempt } : {}),
    ...(typeof input.consoleErrors === "number" ? { consoleErrors: input.consoleErrors } : {}),
    ...(typeof input.pageErrors === "number" ? { pageErrors: input.pageErrors } : {}),
  };
  const host = (() => {
    try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return ""; }
  })();
  if (host !== "amazon.com" && host !== "www.amazon.com") {
    return {
      pageResult: { asin, status: "blocked_redirect", note: `页面重定向到非 Amazon US 主机 ${host || "未知"}。`, extractedCount: 0, finalUrl,
        diagnostics: { ...diagnosticsBase, pageStatus: "blocked_redirect" } },
      items: [], retryable: true, humanRequired: false,
    };
  }

  const extraction = await input.page.evaluate<AmazonDetailPageExtraction & { bindingReason?: string | null }>(buildAmazonDetailPageExtractionExpression({
    expectedAsin: asin,
    capturedAt: input.now.toISOString(),
    collectorVersion: "amazon-playwright-review-collector.v1",
  }));
  const pageBlock = reviewStatusForPage(extraction.pageStatus);
  if (pageBlock) {
    const humanRequired = pageBlock.status === "captcha_required" || pageBlock.status === "login_required";
    return {
      pageResult: { asin, status: pageBlock.status, note: pageBlock.note, extractedCount: 0, finalUrl,
        diagnostics: { ...diagnosticsBase, pageStatus: extraction.pageStatus } },
      items: [], retryable: !humanRequired && pageBlock.status === "page_error", humanRequired,
    };
  }

  const reviewIdentityBound = isReviewPageIdentityBound({
    expectedAsin: asin,
    urlAsin: extraction.urlAsin,
    pageAsin: extraction.pageAsin,
    pageStatus: extraction.pageStatus,
    productContainerFound: extraction.bindingProof.productContainerFound,
  });
  if (!reviewIdentityBound) {
    return {
      pageResult: {
        asin,
        status: "page_unknown",
        note: "无法证明详情页属于目标 ASIN。",
        extractedCount: 0,
        finalUrl,
        diagnostics: {
          ...diagnosticsBase,
          pageStatus: extraction.pageStatus,
          bindingReason: extraction.pageAsin && !extraction.bindingProof.pageAnchorMatchesExpected
            ? "page_asin_anchor_mismatch"
            : !extraction.bindingProof.productContainerFound
              ? "product_container_not_found"
              : !extraction.bindingProof.urlMatchesExpected
                ? "url_asin_mismatch"
                : null,
          identityProof: extraction.bindingProof,
        },
      },
      items: [], retryable: false, humanRequired: false,
    };
  }

  const readiness = await input.page.evaluate<ReviewDomReadiness>(buildReviewDomReadinessExpression());
  const extracted = await input.page.evaluate<unknown[]>(buildReviewSnippetExtractionExpression({ maxItems: 20 }));
  const snippets = Array.isArray(extracted)
    ? extracted.filter((value): value is { rating: number | null; date: string; title: string; reviewText: string; verifiedPurchase: boolean } => (
      typeof value === "object"
      && value !== null
      && typeof (value as { title?: unknown }).title === "string"
      && typeof (value as { reviewText?: unknown }).reviewText === "string"
      && (value as { reviewText: string }).reviewText.trim().length > 0
    ))
    : [];
  const readinessDiagnostics = {
    productTitlePresent: readiness.productTitlePresent,
    reviewNodeCount: readiness.reviewNodeCount,
    bodyNodeCount: readiness.bodyNodeCount,
    explicitNoReviews: readiness.explicitNoReviews,
    elapsedMs: readiness.elapsedMs,
    retryAttempt: readiness.retryAttempt,
    scrollTriggered: readiness.scrollTriggered,
  };
  if (snippets.length === 0) {
    const confirmedNoReviews = readiness.explicitNoReviews;
    return {
      pageResult: {
        asin,
        status: confirmedNoReviews ? "confirmed_no_reviews" : "extraction_empty",
        note: confirmedNoReviews ? "页面明确显示暂无公开评论。" : "评论片段未完成可解析提取，请重试。",
        extractedCount: 0,
        finalUrl,
        diagnostics: {
          ...diagnosticsBase,
          pageStatus: extraction.pageStatus,
          bindingReason: null,
          identityProof: extraction.bindingProof,
          readiness: readinessDiagnostics,
        },
      },
      items: [], retryable: !confirmedNoReviews, humanRequired: false,
    };
  }

  const plan = planReviewVocImport({
    asin,
    sourceProductRole: input.role,
    sourceUrl: finalUrl,
    entityBound: true,
    pageStatus: "ok",
    sourceType: "browser",
    snippets: snippets.map((snippet) => ({
      rating: typeof snippet.rating === "number" ? snippet.rating : null,
      date: typeof snippet.date === "string" && snippet.date ? snippet.date : null,
      title: snippet.title,
      reviewText: snippet.reviewText,
      verifiedPurchase: snippet.verifiedPurchase,
      sourceRef: `${finalUrl}#reviewsMedley`,
    })),
  });
  if (!plan.ok) {
    return {
      pageResult: {
        asin, status: "extraction_empty", note: plan.reason, extractedCount: 0, finalUrl,
        diagnostics: { ...diagnosticsBase, pageStatus: extraction.pageStatus, identityProof: extraction.bindingProof, readiness: readinessDiagnostics },
      },
      items: [], retryable: true, humanRequired: false,
    };
  }

  const items = plan.reviews.map((review) => ({
    asin,
    role: input.role,
    rating: review.rating ?? null,
    date: review.reviewDate ?? null,
    title: review.reviewTitle ?? review.reviewText,
    reviewText: review.reviewText,
    verifiedPurchase: review.verifiedPurchase ?? null,
    sourceUrl: review.sourceUrl ?? finalUrl,
    bindingNote: "Amazon 商品详情页公开 Top Reviews snippet；snippet 不代表评论全文，全文页登录限制未绕过。",
  }));
  return {
    pageResult: {
      asin, status: "ok", note: null, extractedCount: plan.reviews.length, finalUrl,
      diagnostics: {
        ...diagnosticsBase,
        pageStatus: extraction.pageStatus,
        bindingReason: null,
        identityProof: extraction.bindingProof,
        readiness: readinessDiagnostics,
      },
    },
    items,
    retryable: false,
    humanRequired: false,
  };
}

function errorMessageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim().slice(0, 200);
}

/**
 * fresh-session 基础设施或单次尝试抛错时的真实失败记录。
 * 状态用 page_error（可重试），诊断里保留具体 errorCode 与已消耗的 fresh 尝试次数，
 * 绝不回退成持久会话的 extraction_empty 假象。
 */
function freshSessionFailurePageResult(input: {
  asin: string;
  errorCode: string;
  note: string;
  attemptsAlreadyUsed: number;
}): AmazonReviewBrowserCollectionResult["pageResults"][number] {
  const attempts = Math.min(MAX_REVIEW_FRESH_SESSION_ATTEMPTS, Math.max(0, input.attemptsAlreadyUsed));
  return {
    asin: input.asin,
    status: "page_error",
    note: input.note,
    extractedCount: 0,
    diagnostics: {
      strategy: "fresh_context",
      freshSessionAttempts: attempts,
      freshSessionAttemptsRemaining: MAX_REVIEW_FRESH_SESSION_ATTEMPTS - attempts,
      freshSessionBudgetExhausted: attempts >= MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
      sessionFailure: {
        errorCode: input.errorCode,
        failureStage: "fresh_session",
        failureKind: "browser_or_navigation_error",
      },
    },
  };
}

function replacePageResult(
  pageResults: AmazonReviewBrowserCollectionResult["pageResults"],
  next: AmazonReviewBrowserCollectionResult["pageResults"][number],
): void {
  const index = pageResults.findIndex((pageResult) => pageResult.asin === next.asin);
  if (index >= 0) pageResults[index] = next;
  else pageResults.push(next);
}

async function detectReviewHumanGate(page: PlaywrightPage): Promise<"captcha_required" | "login_required" | null> {
  const url = page.url().toLowerCase();
  const pageSignals = await page.evaluate<{ captcha: boolean; login: boolean }>(`(() => {
    const title = document.title || '';
    const bodyText = (document.body?.innerText || '').slice(0, 5000);
    const text = (title + ' ' + bodyText).toLowerCase();
    return {
      captcha: Boolean(document.querySelector('#captchacharacters, form[action*="validateCaptcha"]')) || /captcha|robot check|verify you are human|validatecaptcha/.test(text),
      login: Boolean(document.querySelector('#ap_email, #ap_password')) || /sign in to your account|enter your password/.test(text),
    };
  })()`);
  if (pageSignals.captcha) return "captcha_required";
  if (pageSignals.login || /\/ap\/signin/u.test(url)) return "login_required";
  return null;
}

/**
 * 评论正式采集路径：Playwright 只读公开 Top Reviews 片段。
 * 不访问评论全文页，不读取 Cookie，不自动登录，也不把片段直接写入任务。
 */
export async function collectAmazonReviewsWithPlaywright(input: {
  context: AccessContext;
  asins: ReadonlyArray<{ asin: string; role: ReviewSourceProductRole }>;
  freshSessionAttemptsRemainingByAsin?: Readonly<Record<string, number>>;
  now?: Date;
  traceId?: string;
}): Promise<AmazonReviewBrowserCollectionResult> {
  if (input.asins.length < 1 || input.asins.length > 3) {
    return {
      status: "failed",
      items: [],
      pageResults: [],
      errorCode: "ASIN_BUDGET_INVALID",
      errorMessage: "一次评论采集最多处理 3 个 ASIN。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  if (input.asins.some((item) => !ASIN_PATTERN.test(item.asin.trim().toUpperCase()))) {
    return {
      status: "failed",
      items: [],
      pageResults: [],
      errorCode: "ASIN_INVALID",
      errorMessage: "评论采集包含无效 ASIN。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  if (process.env.LOCAL_ACQUISITION_ENABLED !== "true") {
    return {
      status: "unavailable",
      items: [],
      pageResults: [],
      errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
      errorMessage: "实时页面采集需要在本地研究环境开启。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  const playwrightModule = await loadPlaywright<PlaywrightModule>();
  const browser = resolveSystemBrowser();
  if (!playwrightModule) {
    return {
      status: "unavailable",
      items: [],
      pageResults: [],
      errorCode: "PLAYWRIGHT_RUNTIME_MISSING",
      errorMessage: "当前项目未安装 Playwright runtime；没有回退到 CDP。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: browser ? { name: browser.browser, profile: AMAZON_PROFILE_DIR } : null,
    };
  }
  if (!browser) {
    return {
      status: "unavailable",
      items: [],
      pageResults: [],
      errorCode: "BROWSER_NOT_FOUND",
      errorMessage: "本机未检测到可用于 Playwright 的 Chrome/Edge。",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    };
  }
  const captureNetwork = resolveAmazonCaptureNetworkConfig();
  if (captureNetwork.invalidReason) {
    return {
      status: "failed",
      items: [],
      pageResults: [],
      errorCode: "AMAZON_CAPTURE_PROXY_INVALID",
      errorMessage: `${captureNetwork.invalidReason}为避免误采，本次未启动采集浏览器。`,
      consoleErrors: 0,
      pageErrors: 0,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  const preflight = await checkAmazonCapturePreflight({ env: captureNetwork.env });
  if (!preflight.ok) {
    return {
      status: "failed",
      items: [],
      pageResults: [],
      errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      errorMessage: `${preflight.message}为避免误采，本次未启动采集浏览器。`,
      consoleErrors: 0,
      pageErrors: 0,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  const now = input.now ?? new Date();
  const items: AmazonReviewBrowserCollectionResult["items"] = [];
  const pageResults: AmazonReviewBrowserCollectionResult["pageResults"] = [];
  const freshSessionAttemptsRemainingByAsin = new Map(input.asins.map((requested) => {
    const asin = requested.asin.trim().toUpperCase();
    const configuredRemaining = input.freshSessionAttemptsRemainingByAsin?.[asin];
    const remaining = configuredRemaining === undefined
      ? MAX_REVIEW_FRESH_SESSION_ATTEMPTS
      : Number.isSafeInteger(configuredRemaining)
        ? Math.min(MAX_REVIEW_FRESH_SESSION_ATTEMPTS, Math.max(0, configuredRemaining))
        : 0;
    return [asin, remaining] as const;
  }));
  let stoppedAtHumanGate = false;
  let consoleErrors = 0;
  let pageErrors = 0;
  let context: PlaywrightContext | null = null;
  let freshBrowser: PlaywrightBrowser | null = null;
  let closeProfileContext: (() => Promise<void>) | null = null;
  try {
    const leasedContext = await launchAmazonCapturePersistentContext(() => playwrightModule.chromium.launchPersistentContext(
      AMAZON_PROFILE_DIR,
      buildAmazonCaptureContextOptions({ executablePath: browser.executablePath, proxy: captureNetwork.proxy }),
    ));
    context = leasedContext.context;
    closeProfileContext = leasedContext.close;
    const page = await context.newPage();
    page.on("console", (...args) => {
      const message = args[0] as { type?: () => string } | undefined;
      if (message?.type?.() === "error") consoleErrors += 1;
    });
    page.on("pageerror", () => { pageErrors += 1; });

    const sessionEnvironment = await ensureAmazonUsSessionEnvironment({
      page, networkPreflight: preflight.status === "US_READY" ? "US_READY" : preflight.status === "NON_US_EXIT" ? "NON_US_EXIT" : "UNKNOWN",
      module: "REVIEW", traceId: input.traceId ?? "",
      onDiagnostic: async (fields) => recordBrowserDiagnostic({
        context: input.context, traceId: fields.traceId, subjectKey: "amazon:US:review",
        module: fields.module, phase: "browser", eventType: fields.eventType, status: fields.finalEnvironmentStatus === "US_READY" ? "succeeded" : "blocked",
        reason: sessionDiagnosticReason(fields),
        durationMs: fields.elapsedMs,
      }),
    });
    if (!sessionEnvironment.ok) return {
      status: "failed", items: [], pageResults: [],
      errorCode: sessionEnvironment.errorCode ?? "AMAZON_US_SESSION_CALIBRATION_FAILED",
      errorMessage: sessionEnvironment.errorMessage ?? "Amazon 美国会话环境门禁未通过。",
      sessionDiagnostics: toAmazonSessionFailureReport(sessionEnvironment),
      consoleErrors, pageErrors, browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };

    for (const requested of input.asins) {
      const asin = requested.asin.trim().toUpperCase();
      if (stoppedAtHumanGate) {
        pageResults.push({ asin, status: "not_attempted_human_gate", note: "前一商品触发真人门禁，本轮为保护会话而停止后续导航。", extractedCount: 0 });
        continue;
      }
      const target = `${requestedAmazonUrl(asin)}?language=en_US&currency=USD`;
      try {
        const consoleErrorsBefore = consoleErrors;
        const pageErrorsBefore = pageErrors;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
        await page.waitForSelector("#productTitle", { state: "attached", timeout: 10_000 }).catch(() => undefined);
        const captured = await collectReviewPage({
          page,
          asin,
          role: requested.role,
          now,
          strategy: "persistent_profile",
          consoleErrors: consoleErrors - consoleErrorsBefore,
          pageErrors: pageErrors - pageErrorsBefore,
        });
        items.push(...captured.items);
        pageResults.push(captured.pageResult);
        if (captured.humanRequired) stoppedAtHumanGate = true;
      } catch (error) {
        pageResults.push({ asin, status: "error", note: error instanceof Error ? error.message.slice(0, 160) : "浏览器采集失败。", extractedCount: 0,
          diagnostics: { strategy: "persistent_profile", consoleErrors, pageErrors } });
      }
    }

    for (const pageResult of pageResults) {
      const remaining = freshSessionAttemptsRemainingByAsin.get(pageResult.asin) ?? MAX_REVIEW_FRESH_SESSION_ATTEMPTS;
      const attemptsAlreadyUsed = MAX_REVIEW_FRESH_SESSION_ATTEMPTS - remaining;
      pageResult.diagnostics = {
        ...pageResult.diagnostics,
        freshSessionAttempts: attemptsAlreadyUsed,
        freshSessionAttemptsRemaining: remaining,
        freshSessionBudgetExhausted: remaining === 0,
      };
    }

    const retryTargets = stoppedAtHumanGate
      ? []
      : pageResults.filter((pageResult) => pageResult.status === "extraction_empty");
    const freshRetryTargets = retryTargets.filter((pageResult) => (
      (freshSessionAttemptsRemainingByAsin.get(pageResult.asin) ?? MAX_REVIEW_FRESH_SESSION_ATTEMPTS) > 0
    ));
    if (freshRetryTargets.length > 0) {
      // fresh-session 基础设施失败必须留下真实失败记录：关闭会话 / 启动 fresh 浏览器 / 单次尝试
      // 抛错都不能静默冒泡到外层 catch，否则外层会带着持久会话的 extraction_empty 结果返回，
      // 证据里的 freshSessionAttempts 将永远是 0，重试机制看似运行实则从未发生。
      let freshInfrastructureError: { errorCode: string; note: string } | null = null;
      // Close the persistent profile session before creating any fresh context.
      if (context) {
        try {
          if (closeProfileContext) {
            await closeProfileContext();
            closeProfileContext = null;
          } else {
            await context.close();
          }
        } catch (error) {
          closeProfileContext = null;
          freshInfrastructureError = {
            errorCode: "REVIEW_PERSISTENT_SESSION_CLOSE_FAILED",
            note: `持久采集会话关闭失败，本轮未启动 fresh session：${errorMessageOf(error)}`,
          };
        }
        context = null;
      }
      const freshLaunchOptions = buildAmazonCaptureContextOptions({
        executablePath: browser.executablePath,
        proxy: captureNetwork.proxy,
      });
      if (!freshInfrastructureError) {
        try {
          freshBrowser = await playwrightModule.chromium.launch({
            executablePath: freshLaunchOptions.executablePath,
            headless: freshLaunchOptions.headless,
            args: freshLaunchOptions.args,
            ...(freshLaunchOptions.proxy ? { proxy: freshLaunchOptions.proxy } : {}),
          });
        } catch (error) {
          freshBrowser = null;
          freshInfrastructureError = {
            errorCode: "REVIEW_FRESH_BROWSER_LAUNCH_FAILED",
            note: `fresh session 浏览器启动失败：${errorMessageOf(error)}`,
          };
        }
      }

      for (const initialResult of freshRetryTargets) {
        if (freshInfrastructureError) {
          replacePageResult(pageResults, freshSessionFailurePageResult({
            asin: initialResult.asin,
            errorCode: freshInfrastructureError.errorCode,
            note: freshInfrastructureError.note,
            attemptsAlreadyUsed: MAX_REVIEW_FRESH_SESSION_ATTEMPTS
              - (freshSessionAttemptsRemainingByAsin.get(initialResult.asin) ?? MAX_REVIEW_FRESH_SESSION_ATTEMPTS),
          }));
          continue;
        }
        if (stoppedAtHumanGate) {
          const index = pageResults.findIndex((pageResult) => pageResult.asin === initialResult.asin);
          if (index >= 0) pageResults[index] = {
            asin: initialResult.asin,
            status: "not_attempted_human_gate",
            note: "前一 fresh session 触发真人门禁，本轮为保护会话而停止后续导航。",
            extractedCount: 0,
          };
          continue;
        }
        const requested = input.asins.find((item) => item.asin.trim().toUpperCase() === initialResult.asin);
        if (!requested) continue;
        const asin = initialResult.asin;
        const attemptsAlreadyUsed = MAX_REVIEW_FRESH_SESSION_ATTEMPTS
          - (freshSessionAttemptsRemainingByAsin.get(asin) ?? MAX_REVIEW_FRESH_SESSION_ATTEMPTS);
        let freshRun: { result: ReviewPageCaptureAttempt | null; attempts: number; humanRequired: boolean } | null = null;
        try {
          freshRun = await runFreshReviewSessionAttempts({
          createSession: async () => {
            if (!freshBrowser) throw new Error("REVIEW_FRESH_BROWSER_UNAVAILABLE");
            return freshBrowser.newContext({
              viewport: freshLaunchOptions.viewport,
              locale: freshLaunchOptions.locale,
              timezoneId: freshLaunchOptions.timezoneId,
            });
          },
          runAttempt: async (freshContext, attempt) => {
            const consoleErrorsBefore = consoleErrors;
            const pageErrorsBefore = pageErrors;
            const freshPage = await freshContext.newPage();
            freshPage.on("console", (...args) => {
              const message = args[0] as { type?: () => string } | undefined;
              if (message?.type?.() === "error") consoleErrors += 1;
            });
            freshPage.on("pageerror", () => { pageErrors += 1; });
            const freshTraceId = `${input.traceId ?? "review"}:fresh:${asin}:${attempt}`;
            const sessionEnvironment = await ensureAmazonUsSessionEnvironment({
              page: freshPage,
              networkPreflight: preflight.status === "US_READY" ? "US_READY" : "UNKNOWN",
              module: "REVIEW",
              traceId: freshTraceId,
              onDiagnostic: async (fields) => recordBrowserDiagnostic({
                context: input.context,
                traceId: fields.traceId,
                subjectKey: `amazon:US:${asin}`,
                module: fields.module,
                phase: "browser",
                eventType: fields.eventType,
                status: fields.finalEnvironmentStatus === "US_READY" ? "succeeded" : "blocked",
                reason: sessionDiagnosticReason(fields),
                durationMs: fields.elapsedMs,
              }),
            });
            if (!sessionEnvironment.ok) {
              const humanGate = await detectReviewHumanGate(freshPage);
              return {
                pageResult: {
                  asin,
                  status: humanGate ?? "page_changed",
                  note: humanGate === "captcha_required"
                    ? "fresh Amazon context 遇到 CAPTCHA；已停止此来源后续导航。"
                    : humanGate === "login_required"
                      ? "fresh Amazon context 要求登录；未自动输入凭据。"
                      : "fresh Amazon context 首页门禁未完成，最多三次后停止此商品。",
                  extractedCount: 0,
                  finalUrl: freshPage.url(),
                  diagnostics: {
                    strategy: "fresh_context",
                    freshSessionAttempt: attempt,
                    pageStatus: sessionEnvironment.pageStatus,
                    sessionFailure: {
                      errorCode: sessionEnvironment.errorCode,
                      failureStage: sessionEnvironment.failureStage,
                      failureKind: sessionEnvironment.failureKind,
                    },
                    consoleErrors: consoleErrors - consoleErrorsBefore,
                    pageErrors: pageErrors - pageErrorsBefore,
                  },
                },
                items: [],
                retryable: !humanGate,
                humanRequired: Boolean(humanGate),
              } satisfies ReviewPageCaptureAttempt;
            }

            const target = `${requestedAmazonUrl(asin)}?language=en_US&currency=USD`;
            await freshPage.goto(target, { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
            await freshPage.waitForSelector("#productTitle", { state: "attached", timeout: 10_000 }).catch(() => undefined);
            const captured = await collectReviewPage({
              page: freshPage,
              asin,
              role: requested.role,
              now,
              strategy: "fresh_context",
              freshSessionAttempt: attempt,
            });
            const diagnostics = captured.pageResult.diagnostics;
            captured.pageResult.diagnostics = {
              ...diagnostics,
              consoleErrors: consoleErrors - consoleErrorsBefore,
              pageErrors: pageErrors - pageErrorsBefore,
            };
            return captured;
          },
          shouldRetry: (attemptResult) => attemptResult.retryable,
          isHumanRequired: (attemptResult) => attemptResult.humanRequired,
          closeSession: (freshContext) => freshContext.close(),
          maxAttempts: MAX_REVIEW_FRESH_SESSION_ATTEMPTS - attemptsAlreadyUsed,
          attemptOffset: attemptsAlreadyUsed,
          });
        } catch (error) {
          // 单次 fresh 尝试抛错（会话创建 / 导航 / 页面求值）同样必须记录真实失败，
          // 不得让外层 catch 用持久会话的 extraction_empty 覆盖全部尝试痕迹。
          replacePageResult(pageResults, freshSessionFailurePageResult({
            asin,
            errorCode: "REVIEW_FRESH_SESSION_FAILED",
            note: `fresh session 尝试失败：${errorMessageOf(error)}`,
            attemptsAlreadyUsed,
          }));
          continue;
        }

        const finalResult = freshRun?.result ?? null;
        const finalPageResult = finalResult?.pageResult ?? {
          asin,
          status: "page_changed",
          note: "fresh session 无法创建；本商品未完成 Review 采集。",
          extractedCount: 0,
        };
        finalPageResult.diagnostics = {
          ...finalPageResult.diagnostics,
          strategy: finalPageResult.diagnostics?.strategy ?? "fresh_context",
          freshSessionAttempts: attemptsAlreadyUsed + (freshRun?.attempts ?? 0),
          freshSessionAttemptsRemaining: MAX_REVIEW_FRESH_SESSION_ATTEMPTS - attemptsAlreadyUsed - (freshRun?.attempts ?? 0),
          freshSessionBudgetExhausted: attemptsAlreadyUsed + (freshRun?.attempts ?? 0) >= MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
        };
        const index = pageResults.findIndex((pageResult) => pageResult.asin === asin);
        if (index >= 0) pageResults[index] = finalPageResult;
        else pageResults.push(finalPageResult);
        if (finalResult) items.push(...finalResult.items);
        if (freshRun?.humanRequired) stoppedAtHumanGate = true;
      }
    }
    const humanGate = pageResults.find((page) => page.status === "captcha_required" || page.status === "login_required");
    const humanErrorCode = humanGate?.status === "login_required" ? "LOGIN_REQUIRED" : "CAPTCHA_DETECTED";
    return {
      status: items.length > 0 ? "captured" : humanGate ? "human_required" : "failed",
      items,
      pageResults,
      errorCode: items.length > 0 ? null : humanGate ? humanErrorCode : "REVIEW_SOURCE_UNAVAILABLE",
      errorMessage: items.length > 0 ? null : humanGate?.status === "login_required"
        ? "Amazon 评论页面要求登录；系统未自动登录。"
        : humanGate ? "Amazon 评论页面要求人工完成验证码或访问验证；系统未绕过。"
          : "没有可保存的公开评论片段。",
      consoleErrors,
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } catch (error) {
    return {
      status: "failed",
      items,
      pageResults,
      errorCode: profileLeaseErrorCode(error) ?? "PLAYWRIGHT_BROWSER_FAILED",
      errorMessage: profileLeaseErrorMessage(error) ?? (error instanceof Error ? error.message : "Playwright 评论采集失败。"),
      consoleErrors,
      pageErrors,
      browser: { name: browser.browser, profile: AMAZON_PROFILE_DIR },
    };
  } finally {
    if (closeProfileContext) await closeProfileContext();
    if (freshBrowser) await freshBrowser.close();
  }
}

const MAX_VARIATION_ASINS_PER_SESSION = 5;

function variationCapturePersistencePlan(capture: AmazonVariationPageCapture) {
  switch (capture.status) {
    case "COMPLETE":
      return { moduleStatus: "VALIDATED_AVAILABLE" as const, outcome: "COMPLETE", limitation: null, errorCode: null, retryable: false };
    case "CAPTURED_PARTIAL":
      return { moduleStatus: "AVAILABLE_WITH_LIMITATION" as const, outcome: "CAPTURED_PARTIAL", limitation: "variation_mapping_incomplete", errorCode: null, retryable: false };
    case "NO_VARIATION_WITH_EVIDENCE":
      return { moduleStatus: "AVAILABLE_WITH_LIMITATION" as const, outcome: "NO_DATA_WITH_EVIDENCE", limitation: "no_variation_with_evidence", errorCode: null, retryable: false };
    case "HUMAN_REQUIRED":
      return { moduleStatus: "HUMAN_ACTION_REQUIRED" as const, outcome: "FAILED_HUMAN", limitation: "variation_requires_human", errorCode: "HUMAN_ACTION_REQUIRED", retryable: false };
    case "PAGE_CHANGED":
      return { moduleStatus: "BLOCKED_WITH_EVIDENCE" as const, outcome: "FAILED_RETRYABLE", limitation: "variation_page_identity_not_bound", errorCode: "VARIATION_PAGE_CHANGED", retryable: true };
    case "EXTRACTION_EMPTY_RETRYABLE":
      return { moduleStatus: "BLOCKED_WITH_EVIDENCE" as const, outcome: "FAILED_RETRYABLE", limitation: "variation_extraction_empty_retryable", errorCode: "VARIATION_EXTRACTION_EMPTY", retryable: true };
    case "NOT_ATTEMPTED":
      return { moduleStatus: "BLOCKED_WITH_EVIDENCE" as const, outcome: "FAILED_RETRYABLE", limitation: "not_attempted_after_human_gate", errorCode: "HUMAN_GATE_PAUSE", retryable: true };
  }
}

/** Amazon native variation capture. This writes only V3 module evidence through Capture Gateway. */
export async function collectAmazonVariationsWithPlaywright(input: {
  context: AccessContext;
  asins: ReadonlyArray<{ asin: string }>;
  now?: Date;
  traceId?: string;
}): Promise<AmazonVariationBrowserCollectionResult> {
  const invalid = input.asins.length < 1 || input.asins.length > MAX_VARIATION_ASINS_PER_SESSION
    || input.asins.some((item) => !ASIN_PATTERN.test(item.asin.trim().toUpperCase()));
  if (invalid) {
    return {
      status: "failed", results: [], errorCode: "VARIATION_ASIN_BUDGET_INVALID", humanAborted: false,
      consoleErrors: 0, pageErrors: 0, browser: null,
    };
  }
  if (process.env.LOCAL_ACQUISITION_ENABLED !== "true") {
    return {
      status: "unavailable", results: [], errorCode: "LOCAL_ENVIRONMENT_REQUIRED", humanAborted: false,
      consoleErrors: 0, pageErrors: 0, browser: null,
    };
  }
  const playwrightModule = await loadPlaywright<PlaywrightModule>();
  const browserInfo = resolveSystemBrowser();
  if (!playwrightModule || !browserInfo) {
    return {
      status: "unavailable", results: [], errorCode: playwrightModule ? "BROWSER_NOT_FOUND" : "PLAYWRIGHT_RUNTIME_MISSING",
      humanAborted: false, consoleErrors: 0, pageErrors: 0,
      browser: browserInfo ? { name: browserInfo.browser, profile: AMAZON_PROFILE_DIR } : null,
    };
  }
  const captureNetwork = resolveAmazonCaptureNetworkConfig();
  if (captureNetwork.invalidReason) {
    return {
      status: "failed", results: [], errorCode: "AMAZON_CAPTURE_PROXY_INVALID", humanAborted: false,
      consoleErrors: 0, pageErrors: 0, browser: { name: browserInfo.browser, profile: AMAZON_PROFILE_DIR },
    };
  }
  const preflight = await checkAmazonCapturePreflight({ env: captureNetwork.env });
  if (!preflight.ok) {
    return {
      status: "blocked", results: [], errorCode: preflight.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      humanAborted: false, consoleErrors: 0, pageErrors: 0,
      browser: { name: browserInfo.browser, profile: AMAZON_PROFILE_DIR },
    };
  }

  const now = input.now ?? new Date();
  const results: AmazonVariationBrowserCollectionResult["results"] = [];
  let consoleErrors = 0;
  let pageErrors = 0;
  let humanAborted = false;
  let context: PlaywrightContext | null = null;
  let topErrorCode: string | null = null;
  let closeProfileContext: (() => Promise<void>) | null = null;

  const persistCapture = async (
    asin: string,
    capture: AmazonVariationPageCapture,
    traceId: string,
    diagnostics?: Record<string, unknown>,
    rawVariationSignals?: RawVariationPage | null,
  ) => {
    const plan = variationCapturePersistencePlan(capture);
    const persistedData = withAmazonVariationSourceSignals({
      outcome: plan.outcome,
      traceId,
      variationStatus: capture.status,
      parentAsin: capture.parentAsin,
      currentAsin: capture.currentAsin,
      dimensions: capture.dimensions,
      variantAsins: capture.variantAsins,
      variants: capture.variants,
      sourceUrl: capture.sourceUrl,
      capturedAt: capture.capturedAt,
      identityProof: capture.identityProof,
      captureDiagnostics: { ...capture.diagnostics, ...diagnostics },
      error: plan.errorCode ? { code: plan.errorCode, retryable: plan.retryable } : null,
    }, rawVariationSignals);
    try {
      const persisted = await captureV3ModuleEvidence({
        context: input.context,
        sourceType: "amazon_dom",
        sourceFingerprint: `variation:${asin}:${capture.capturedAt}:${traceId}`,
        moduleEvidence: {
          module: "variation",
          subjectKey: `amazon:US:${asin}`,
          marketplace: "US",
          capturedAt: capture.capturedAt,
          provider: "Amazon",
          sourceSurface: "Amazon product detail variation JSON and DOM",
          sourceUrl: isSafeAmazonUrl(capture.sourceUrl) ? capture.sourceUrl : null,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "source_observed",
          status: plan.moduleStatus,
          limitations: plan.limitation ? [plan.limitation] : [],
          identity: { asin, ...(capture.parentAsin ? { parentAsin: capture.parentAsin } : {}) },
          data: persistedData.data,
          evidenceOnly: true,
        },
      });
      return {
        evidenceId: persisted.attachment.attachmentId,
        contentHash: persisted.attachment.contentHash,
        errorCode: null,
        rawVariationSignals: persistedData.sourceSignals,
      };
    } catch {
      return {
        evidenceId: null,
        contentHash: null,
        errorCode: "VARIATION_EVIDENCE_PERSIST_FAILED",
        rawVariationSignals: persistedData.sourceSignals,
      };
    }
  };

  const persistFailureForAsin = async (asin: string, inputFailure: {
    sourceUrl: string;
    pageStatus: string;
    humanRequired: boolean;
    traceId: string;
    consoleCount: number;
    pageErrorCount: number;
    errorCode: string | null;
  }) => {
    const capture = normalizeAmazonVariationPageCapture({
      expectedAsin: asin,
      sourceUrl: inputFailure.sourceUrl,
      capturedAt: now.toISOString(),
      raw: {},
      identity: { urlAsin: null, pageAsin: null, productContainerFound: false, pageStatus: inputFailure.pageStatus },
      humanRequired: inputFailure.humanRequired,
    });
    if (inputFailure.humanRequired) {
      // The caller has identified the actual page-level login/CAPTCHA signal.
      capture.status = "HUMAN_REQUIRED";
    }
    const persisted = await persistCapture(asin, capture, inputFailure.traceId, {
      sessionFailure: inputFailure.errorCode,
      pageStatus: inputFailure.pageStatus,
      consoleErrors: inputFailure.consoleCount,
      pageErrors: inputFailure.pageErrorCount,
    });
    results.push({
      asin,
      capture,
      evidenceId: persisted.evidenceId,
      contentHash: persisted.contentHash,
      rawVariationSignals: persisted.rawVariationSignals,
      errorCode: persisted.errorCode ?? variationCapturePersistencePlan(capture).errorCode ?? inputFailure.errorCode,
      consoleErrors: inputFailure.consoleCount,
      pageErrors: inputFailure.pageErrorCount,
      elapsedMs: 0,
    });
  };

  try {
    const leasedContext = await launchAmazonCapturePersistentContext(() => playwrightModule.chromium.launchPersistentContext(
      AMAZON_PROFILE_DIR,
      buildAmazonCaptureContextOptions({ executablePath: browserInfo.executablePath, proxy: captureNetwork.proxy }),
    ));
    context = leasedContext.context;
    closeProfileContext = leasedContext.close;
    const page = await context.newPage();
    page.on("console", (...args) => {
      const message = args[0] as { type?: () => string } | undefined;
      if (message?.type?.() === "error") consoleErrors += 1;
    });
    page.on("pageerror", () => { pageErrors += 1; });

    const session = await ensureAmazonUsSessionEnvironment({
      page,
      networkPreflight: preflight.status === "US_READY" ? "US_READY" : "UNKNOWN",
      module: "DETAIL",
      traceId: input.traceId ?? "",
    });
    if (!session.ok) {
      const sessionPageStatus = session.pageStatus ?? "unknown";
      const sessionError = session.errorCode ?? "AMAZON_US_SESSION_CALIBRATION_FAILED";
      const humanRequired = /captcha|login|automation_blocked/iu.test(`${sessionPageStatus} ${sessionError}`);
      humanAborted = humanRequired;
      topErrorCode = humanRequired ? sessionError : "VARIATION_PAGE_CHANGED";
      const sourceUrl = isSafeAmazonUrl(page.url()) ? page.url() : "https://www.amazon.com/";
      for (const requested of input.asins) {
        await persistFailureForAsin(requested.asin.trim().toUpperCase(), {
          sourceUrl,
          pageStatus: sessionPageStatus,
          humanRequired,
          traceId: `${input.traceId ?? "variation"}:${requested.asin}:session`,
          consoleCount: consoleErrors,
          pageErrorCount: pageErrors,
          errorCode: sessionError,
        });
      }
    } else {
      for (let index = 0; index < input.asins.length; index += 1) {
        const asin = input.asins[index]!.asin.trim().toUpperCase();
        const startedAt = Date.now();
        const consoleBefore = consoleErrors;
        const pageErrorsBefore = pageErrors;
        const traceId = `${input.traceId ?? "variation"}:${asin}`;
        const targetUrl = requestedAmazonUrl(asin);
        try {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
          await page.waitForSelector("#productTitle", { state: "attached", timeout: 10_000 }).catch(() => undefined);
          const finalUrl = page.url();
          const host = (() => { try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return ""; } })();
          const identity = await page.evaluate<AmazonDetailPageExtraction>(buildAmazonDetailPageExtractionExpression({
            expectedAsin: asin,
            capturedAt: now.toISOString(),
            collectorVersion: AMAZON_DETAIL_COLLECTOR_VERSION,
          }));
          const pageStatus = host === "amazon.com" || host === "www.amazon.com" ? identity.pageStatus : "blocked_redirect";
          const humanRequired = ["captcha", "automation_blocked", "login_wall"].includes(pageStatus);
          const raw: RawVariationPage = humanRequired || pageStatus !== "ok"
            ? {}
            : await page.evaluate<RawVariationPage>(buildAmazonVariationPageExtractionExpression());
          const capture = normalizeAmazonVariationPageCapture({
            expectedAsin: asin,
            sourceUrl: isSafeAmazonUrl(finalUrl) ? finalUrl : targetUrl,
            capturedAt: now.toISOString(),
            raw,
            identity: {
              urlAsin: host === "amazon.com" || host === "www.amazon.com" ? identity.urlAsin : null,
              pageAsin: identity.pageAsin,
              productContainerFound: identity.bindingProof.productContainerFound,
              pageStatus,
            },
            humanRequired,
          });
          const persisted = await persistCapture(asin, capture, traceId, {
            finalUrl,
            pageStatus,
            consoleErrors: consoleErrors - consoleBefore,
            pageErrors: pageErrors - pageErrorsBefore,
          }, raw);
          results.push({
            asin,
            capture,
            rawVariationSignals: persisted.rawVariationSignals,
            evidenceId: persisted.evidenceId,
            contentHash: persisted.contentHash,
            errorCode: persisted.errorCode ?? variationCapturePersistencePlan(capture).errorCode,
            consoleErrors: consoleErrors - consoleBefore,
            pageErrors: pageErrors - pageErrorsBefore,
            elapsedMs: Date.now() - startedAt,
          });
          if (humanRequired) {
            humanAborted = true;
            topErrorCode = capture.status === "HUMAN_REQUIRED"
              ? (/login_wall/iu.test(pageStatus) ? "LOGIN_REQUIRED" : "CAPTCHA_REQUIRED")
              : "HUMAN_ACTION_REQUIRED";
            const later = input.asins.slice(index + 1);
            for (const item of later) {
              const skippedAsin = item.asin.trim().toUpperCase();
              const skippedUrl = requestedAmazonUrl(skippedAsin);
              const skippedCapture = normalizeAmazonVariationPageCapture({
                expectedAsin: skippedAsin,
                sourceUrl: skippedUrl,
                capturedAt: now.toISOString(),
                raw: {},
                identity: { urlAsin: skippedAsin, pageAsin: null, productContainerFound: false, pageStatus: "not_attempted_human_gate" },
              });
              skippedCapture.status = "NOT_ATTEMPTED";
              results.push({
                asin: skippedAsin,
                capture: skippedCapture,
                rawVariationSignals: null,
                evidenceId: null,
                contentHash: null,
                errorCode: "HUMAN_GATE_PAUSE",
                consoleErrors: 0,
                pageErrors: 0,
                elapsedMs: 0,
              });
            }
            break;
          }
        } catch {
          const finalUrl = isSafeAmazonUrl(page.url()) ? page.url() : targetUrl;
          const capture = normalizeAmazonVariationPageCapture({
            expectedAsin: asin,
            sourceUrl: finalUrl,
            capturedAt: now.toISOString(),
            raw: {},
            identity: { urlAsin: null, pageAsin: null, productContainerFound: false, pageStatus: "page_changed" },
          });
          const persisted = await persistCapture(asin, capture, traceId, {
            pageStatus: "page_changed",
            consoleErrors: consoleErrors - consoleBefore,
            pageErrors: pageErrors - pageErrorsBefore,
          });
          results.push({
            asin,
            capture,
            rawVariationSignals: persisted.rawVariationSignals,
            evidenceId: persisted.evidenceId,
            contentHash: persisted.contentHash,
            errorCode: persisted.errorCode ?? "VARIATION_PAGE_CHANGED",
            consoleErrors: consoleErrors - consoleBefore,
            pageErrors: pageErrors - pageErrorsBefore,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }
    }
    const completed = results.some((result) => result.capture.status === "COMPLETE" || result.capture.status === "CAPTURED_PARTIAL" || result.capture.status === "NO_VARIATION_WITH_EVIDENCE");
    return {
      status: humanAborted ? "human_required" : completed ? "captured" : "blocked",
      results,
      errorCode: completed ? null : topErrorCode ?? "VARIATION_SOURCE_UNAVAILABLE",
      humanAborted,
      consoleErrors,
      pageErrors,
      browser: { name: browserInfo.browser, profile: AMAZON_PROFILE_DIR },
    };
  } catch (error) {
    return {
      status: "failed", results, errorCode: topErrorCode ?? profileLeaseErrorCode(error) ?? "PLAYWRIGHT_BROWSER_FAILED", humanAborted,
      consoleErrors, pageErrors, browser: { name: browserInfo.browser, profile: AMAZON_PROFILE_DIR },
    };
  } finally {
    if (closeProfileContext) await closeProfileContext();
  }
}
