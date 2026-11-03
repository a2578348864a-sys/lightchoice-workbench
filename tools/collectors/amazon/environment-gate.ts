import type { CollectionPageStatus } from "../../../lib/upstream/contracts";

export type AmazonEnvironmentSignals = {
  pageStatus: CollectionPageStatus;
  pageErrorCode?: string | null;
  pageUrl: string;
  amazonBrandMarkerPresent: boolean;
  deliveryRegion: string | null;
  language: string | null;
  currencyPreference: string | null;
};

export type AmazonEnvironmentGateResult = {
  status: "passed" | "failed";
  failedStage:
    | "page_status"
    | "marketplace_verification"
    | "delivery_verification"
    | "language_verification"
    | "currency_verification"
    | null;
  errorCodes: string[];
  canSearch: boolean;
  observed: {
    marketplace: "amazon.com" | null;
    market: "US" | null;
    deliveryRegion: string | null;
    language: string | null;
    currency: string | null;
  };
  observedEvidence: {
    marketplace: AmazonObservedFieldEvidence<"amazon.com">;
    market: AmazonObservedFieldEvidence<"US">;
    deliveryRegion: AmazonObservedFieldEvidence<string>;
    language: AmazonObservedFieldEvidence<string>;
    currency: AmazonObservedFieldEvidence<string>;
  };
};

type AmazonObservedFieldEvidence<T> = {
  value: T | null;
  evidenceSource: string;
  confidence: "high" | "unknown";
  satisfiesFieldGate: boolean;
};

function hasAmazonMarketplaceEvidence(signals: AmazonEnvironmentSignals): boolean {
  try {
    const url = new URL(signals.pageUrl);
    return url.protocol === "https:"
      && (url.hostname === "amazon.com" || url.hostname === "www.amazon.com")
      && signals.amazonBrandMarkerPresent;
  } catch {
    return false;
  }
}

function hasExplicitUsDelivery(deliveryRegion: string | null): boolean {
  if (!deliveryRegion) return false;
  // V3R（Research→Creative Consistency）：与 applyDeliveryPostalCode 的放宽口径保持一致——
  // 任意明确的美国 ZIP 或英文 US 区域标记任一即视为美国配送环境；本地化/简版页面常只显示其一，
  // 旧逻辑双标记必选导致真实 US 环境误判非 US。
  // 注意：不把 "deliver to" 当作独立标记（"Deliver to Japan" 会误判）；区域词本身已覆盖
  // "Deliver to New York / United States" 等常见页面文案。Amazon.com 当前账户可能
  // 已保存到任意美国 ZIP（例如 Los Angeles 90017），不能把一个历史默认 ZIP 当成唯一证据。
  return /\b\d{5}(?:-\d{4})?\b/.test(deliveryRegion)
    || /\b(?:new york|ny|united states|usa)\b/i.test(deliveryRegion);
}

export function evaluateAmazonEnvironment(signals: AmazonEnvironmentSignals): AmazonEnvironmentGateResult {
  const marketplace = hasAmazonMarketplaceEvidence(signals) ? "amazon.com" as const : null;
  const usDelivery = hasExplicitUsDelivery(signals.deliveryRegion);
  const language = signals.language?.trim().toLowerCase() ?? null;
  const currencyPreference = signals.currencyPreference?.trim().toUpperCase() ?? null;
  const observed = {
    marketplace,
    market: marketplace && usDelivery ? "US" as const : null,
    deliveryRegion: signals.deliveryRegion,
    language,
    currency: currencyPreference,
  };
  const observedEvidence: AmazonEnvironmentGateResult["observedEvidence"] = {
    marketplace: {
      value: marketplace,
      evidenceSource: "final_url_and_amazon_brand_marker",
      confidence: marketplace ? "high" : "unknown",
      satisfiesFieldGate: marketplace !== null,
    },
    market: {
      value: observed.market,
      evidenceSource: "marketplace_and_delivery_region",
      confidence: observed.market ? "high" : "unknown",
      satisfiesFieldGate: observed.market !== null,
    },
    deliveryRegion: {
      value: signals.deliveryRegion,
      evidenceSource: "delivery_entry_text",
      confidence: signals.deliveryRegion ? "high" : "unknown",
      satisfiesFieldGate: usDelivery,
    },
    language: {
      value: language,
      evidenceSource: "document_language",
      confidence: language ? "high" : "unknown",
      satisfiesFieldGate: language === "en-us",
    },
    currency: {
      value: observed.currency,
      evidenceSource: "explicit_currency_observation",
      confidence: currencyPreference ? "high" : "unknown",
      satisfiesFieldGate: currencyPreference === "USD",
    },
  };

  if (signals.pageStatus !== "ok") {
    return {
      status: "failed",
      failedStage: "page_status",
      errorCodes: [signals.pageErrorCode ?? signals.pageStatus],
      canSearch: false,
      observed,
      observedEvidence,
    };
  }
  if (!marketplace) {
    return {
      status: "failed", failedStage: "marketplace_verification", errorCodes: ["marketplace_unconfirmed"],
      canSearch: false, observed, observedEvidence,
    };
  }
  if (!usDelivery) {
    return {
      status: "failed", failedStage: "delivery_verification", errorCodes: ["delivery_region_not_us"],
      canSearch: false, observed, observedEvidence,
    };
  }
  if (language !== "en-us") {
    return {
      status: "failed", failedStage: "language_verification", errorCodes: ["language_not_en_us"],
      canSearch: false, observed, observedEvidence,
    };
  }
  if (currencyPreference !== "USD") {
    return {
      status: "failed", failedStage: "currency_verification", errorCodes: ["currency_not_usd"],
      canSearch: false, observed, observedEvidence,
    };
  }
  return { status: "passed", failedStage: null, errorCodes: [], canSearch: true, observed, observedEvidence };
}

/** 采集目标固定为 Amazon US 主站；任何其它主机都必须 fail-closed。 */
export const AMAZON_US_TARGET_HOSTS = ["amazon.com", "www.amazon.com"] as const;

/**
 * Amazon 站点自身的错误 / 拦截页。
 *
 * 真实浏览器取证（2026-09-22）：同一采集会话首次搜索请求正常返回结果，
 * 紧随其后的同一会话请求会得到标题为 "Sorry! Something went wrong!" 的
 * 页面（DOM 无搜索结果、无语言标记）。换用全新会话后同一请求恢复正常，
 * 说明这是站点侧针对自动化会话的响应，与环境、账号、套餐都无关。
 */
const AMAZON_SITE_ERROR_PAGE_PATTERN = /sorry!\s*something went wrong/i;

/**
 * 只对「已知的站点错误页」做归类，返回稳定标识；
 * 不把任意页面标题透出到诊断里（页面标题可能包含账号等个人信息）。
 */
export function classifyAmazonCapturePageTitle(pageTitle: string | null | undefined): "site_error_page" | null {
  if (!pageTitle) return null;
  return AMAZON_SITE_ERROR_PAGE_PATTERN.test(pageTitle) ? "site_error_page" : null;
}

function observedHostOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 把门禁失败结果翻译成用户可读的诊断文案。
 *
 * 原则（与真实使用阶段取证一致）：
 * - 只描述门禁实际观测到的值，不把未观测到的原因写成结论；
 * - hostname 仍是 amazon.com 时，绝不允许把失败归因为「VPN 不是美国」——
 *   必须如实说明真正的失败条件（品牌标记缺失 / 配送地区 / 语言 / 币种）；
 * - 不输出 Cookie、Token、认证头等敏感信息。
 */
export function describeAmazonEnvironmentFailure(
  gate: AmazonEnvironmentGateResult,
  pageUrl: string,
  pageTitle?: string | null,
): string {
  const host = observedHostOf(pageUrl);
  const hostLabel = host || "未知";
  const onUsHost = (AMAZON_US_TARGET_HOSTS as readonly string[]).includes(host);
  const primary = gate.errorCodes[0] ?? "";

  if (gate.failedStage === "page_status") {
    if (primary === "captcha") {
      return "Amazon 要求完成人机校验（CAPTCHA），系统不会自动绕过。请在专用采集浏览器中手动完成校验后重试。";
    }
    if (primary === "login_wall") {
      return "Amazon 要求登录后才返回结果，系统不会自动登录。请在专用采集浏览器中手动登录后重试。";
    }
    if (classifyAmazonCapturePageTitle(pageTitle) === "site_error_page") {
      return [
        "Amazon 返回了它自己的站点错误页（页面标题：「Sorry! Something went wrong!」），采集已停止。",
        `实际主机：${hostLabel}；页面状态：${primary || "未知"}。`,
        "真实浏览器取证结论：这不是美国环境问题，也不是账号或套餐问题——同一采集会话首次搜索可正常返回结果，随后同一会话的请求会被该错误页持续拒绝。",
        "请等待一段时间后再试；系统不会自动重试、不会轮换会话，也不会绕过站点校验。",
        "若长期持续，可由操作者重置专用采集资料目录（默认 .playwright-profile/amazon-us，重置后系统会自动重建）。",
      ].join("\n");
    }
    return [
      "Amazon 返回的页面不是可解析的搜索结果页，采集已停止。",
      `实际主机：${hostLabel}；页面状态：${primary || "未知"}。`,
      "可能是站点返回了错误页或页面结构已变化；本轮未继续采集。",
    ].join("\n");
  }

  if (gate.failedStage === "marketplace_verification") {
    if (!onUsHost) {
      return [
        "Amazon 当前不是美国站环境，采集已停止（目标站点固定为 www.amazon.com）。",
        `实际打开的主机：${hostLabel}。`,
        "可能原因：",
        "• 系统 VPN / 代理的出口节点不是美国，Amazon 依据出口 IP 把会话导向了当地站点",
        "• 采集浏览器配置了非美国的代理出口（AMAZON_CAPTURE_PROXY_URL）",
        "请把代理切换为美国节点（或把 AMAZON_CAPTURE_PROXY_URL 指向美国出口）后重试；系统不会跨站点继续采集。",
      ].join("\n");
    }
    return [
      "页面确实在 amazon.com，但没有通过 Marketplace 门禁：未检测到 Amazon 品牌标记。",
      `实际主机：${hostLabel}。`,
      "这通常意味着页面没有完整加载，或 Amazon 页面结构已经变化；采集已停止，请重新触发一次采集。",
    ].join("\n");
  }

  if (gate.failedStage === "delivery_verification") {
    return [
      "Amazon 是美国站点，但当前配送地区不是美国，采集已停止。",
      `实际配送地区：${gate.observed.deliveryRegion ?? "未能读取"}。`,
      "Amazon 配送地区可能同时受网络出口和专用浏览器会话中的配送偏好影响。",
      "出口已通过美国预检而页面仍显示非美国配送地区时，系统会尝试一次正常的美国配送地区校准；若仍未通过则停止采集。",
    ].join("\n");
  }

  if (gate.failedStage === "language_verification") {
    return [
      "Amazon 页面语言不是 en-US，采集已停止。",
      `实际页面语言：${gate.observed.language ?? "未能读取"}。`,
      "采集浏览器已固定 locale=en-US；若仍返回非英文页面，通常是 Amazon 依据出口 IP 返回了当地语言版本。",
      "请把代理切换为美国节点后重试。",
    ].join("\n");
  }

  if (gate.failedStage === "currency_verification") {
    return [
      "Amazon 页面价格币种不是 USD，采集已停止。",
      `实际币种：${gate.observed.currency ?? "未能读取"}；页面语言：${gate.observed.language ?? "未能读取"}。`,
      "价格币种以页面实际观测为准；配送偏好和网络出口均可能影响报价，未观察到 USD 时不会推断为美元。",
    ].join("\n");
  }

  return [
    "Amazon 采集前的美国环境预检没有通过，采集已停止。",
    `实际主机：${hostLabel}；配送地区：${gate.observed.deliveryRegion ?? "未能读取"}；页面语言：${gate.observed.language ?? "未能读取"}；币种：${gate.observed.currency ?? "未能读取"}。`,
    "请检查代理出口地区后重试。",
  ].join("\n");
}
