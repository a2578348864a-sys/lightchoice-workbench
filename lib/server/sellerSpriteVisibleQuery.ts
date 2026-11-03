import "server-only";

import { createHash } from "node:crypto";
import { verifyConnectedBrowserIdentity } from "@/lib/server/sellerSpriteBrowserIdentity";
import { decideSellerSpriteCaptureTraversal, type SellerSpriteCaptureTraversalState } from "@/lib/server/sellerSpriteCaptureTraversal";
import { loadPlaywright } from "@/lib/server/playwrightRuntime";
import {
  releaseSellerSpriteBrowserSession,
  SELLERSPRITE_CDP_OWNERSHIP,
} from "@/lib/server/sellerSpriteCategoryMarketCapture";
import { captureBrowserVisibleV3Envelope } from "@/lib/sourceLayer/browserVisibleModuleCapture";
import {
  collectRawVisibleTables,
  resolveVisibleTableLayout,
  type RawVisibleSnapshot,
} from "@/lib/sourceLayer/sellerSpriteVisibleTableLayout";
import {
  parseV3ModuleEvidence,
  readV3ModuleEvidence,
  type V3ModuleEvidence,
  type V3ModuleId,
} from "@/lib/sourceLayer/v3ModuleEvidence";
import { sha256OfRawArtifact, type SourceRawArtifact } from "@/lib/sourceLayer/rawArtifact";
import { SELLERSPRITE_PROVIDER_NAME } from "@/lib/sourceLayer/v3ModuleRegistry";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  isSellerSpriteQuerySubjectKey,
  sellerSpriteQuerySubjectKey,
} from "@/lib/sourceLayer/queryEvidenceSubject";
import type { AccessContext } from "@/lib/server/accessPassword";
import {
  identifySellerSpriteVisibleKeywordRows,
  type SellerSpriteVisibleKeywordRow,
} from "@/lib/sourceLayer/sellerSpriteVisibleRowIdentity";
import type { SellerSpriteKeywordPage } from "@/lib/sourceLayer/sellerSpriteKeywordTable";
import type {
  SellerSpriteCaptureCounters,
  SellerSpriteCaptureCursor,
  SellerSpriteCaptureDiagnostics,
} from "@/lib/server/sellerSpriteCaptureJob";

const SELLERSPRITE_HOST = /(^|\.)sellersprite\.com$/iu;
const NAVIGATION_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 30_000;
const SOURCE_LIMIT_DECLARATION_PATTERN = String.raw`(?:当前.{0,30}会员.{0,30}无法查看全部结果|无法查看全部结果.{0,60}升级套餐)`;
const MODULE_PATHS = {
  sellersprite_product_market: /\/(?:v[23]\/)?product-research(?:\/|$)/iu,
  reverse_asin: /\/(?:v[23]\/)?(?:keyword-reverse|reverse-asin)(?:\/|$)/iu,
  // 真实页面为 /v3/keyword-miner（探测实测）；keyword-mining / keyword-research 为历史/别名路径，保留兼容。
  keyword_mining_trend: /\/(?:v[23]\/)?(?:keyword-miner|keyword-mining|keyword-research)(?:\/|$)/iu,
} as const;

export type SellerSpriteQueryInput =
  | { module: "sellersprite_product_market"; category: string; marketplace: "US"; filters?: Record<string, string> }
  | { module: "reverse_asin"; targetAsin: string; marketplace: "US" }
  | { module: "keyword_mining_trend"; seedKeyword: string; marketplace: "US"; conditions?: Record<string, string> };

type SellerSpriteKeywordQueryInput = Extract<SellerSpriteQueryInput, { module: "reverse_asin" }>
  | Extract<SellerSpriteQueryInput, { module: "keyword_mining_trend" }>;

export type SellerSpriteQuerySnapshot = {
  pageTitle: string;
  bodyText: string;
  tables: Array<{ headers: string[]; rows: Array<(string | null)[]> }>;
  queryInputs: string[];
  visibleControls?: Array<{ label: string; value: string }>;
  marketplaceEcho: string | null;
  loading: boolean;
  gate: "login" | "captcha" | "stop" | null;
  empty: boolean;
  queryError: boolean;
  traversal?: SellerSpriteCaptureTraversalState & {
    readonly pageNumber: number | null;
    readonly pageCount: number | null;
    readonly nextPageDisabled: boolean | null;
    readonly accessibleRows: number | null;
    readonly unavailableRows: number | null;
  };
};

export type SellerSpriteQueryAdapter = {
  module: SellerSpriteQueryInput["module"];
  inputSelector: string;
  identityInput(input: SellerSpriteQueryInput): string;
  resultTables(snapshot: SellerSpriteQuerySnapshot): SellerSpriteQuerySnapshot["tables"];
  hasResult(snapshot: SellerSpriteQuerySnapshot): boolean;
  /** Query identity (echo + marketplace + conditions) without requiring visible result rows. */
  hasQueryIdentity(snapshot: SellerSpriteQuerySnapshot, expected: string, conditions?: Record<string, string>): boolean;
  hasCompletionSignal(snapshot: SellerSpriteQuerySnapshot, expected: string, conditions?: Record<string, string>): boolean;
};

const productResearchAdapter: SellerSpriteQueryAdapter = {
  module: "sellersprite_product_market",
  // Product Research is category-driven; do not reuse the reverse/keyword input locator.
  inputSelector: 'input[name="category"], input[placeholder*="类目"], input[placeholder*="Category"]',
  identityInput(input) {
    if (input.module !== "sellersprite_product_market") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    return requiredQueryText(input.category, "category");
  },
  resultTables(snapshot) {
    return snapshot.tables.filter((table) => hasProductResearchIdentity(table));
  },
  hasResult(snapshot) {
    return this.resultTables(snapshot).length > 0;
  },
  hasQueryIdentity(snapshot, expected, conditions) {
    return snapshot.queryInputs.some((value) => includesNormalized(value, expected))
      && isUnitedStatesMarketplace(snapshot.marketplaceEcho)
      && conditionsVisible(snapshot, conditions);
  },
  hasCompletionSignal(snapshot, expected, conditions) {
    return !snapshot.loading && this.hasResult(snapshot) && this.hasQueryIdentity(snapshot, expected, conditions);
  },
};

const reverseAsinAdapter: SellerSpriteQueryAdapter = {
  module: "reverse_asin",
  // Reverse ASIN requires an explicit target ASIN field and a matching query echo.
  inputSelector: 'input[name*="asin" i], input[placeholder*="ASIN"], input[aria-label*="ASIN"]',
  identityInput(input) {
    if (input.module !== "reverse_asin") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    const asin = requiredQueryText(input.targetAsin, "targetAsin").toUpperCase();
    if (!/^[A-Z0-9]{10}$/u.test(asin)) throw new Error("SELLERSPRITE_TARGET_ASIN_INVALID");
    return asin;
  },
  resultTables(snapshot) {
    return snapshot.tables.filter((table) => hasKeywordIdentity(table, ["keyword", "关键词", "搜索词"]));
  },
  hasResult(snapshot) {
    return this.resultTables(snapshot).length > 0;
  },
  hasQueryIdentity(snapshot, expected) {
    return snapshot.queryInputs.some((value) => value.toUpperCase() === expected)
      && isUnitedStatesMarketplace(snapshot.marketplaceEcho);
  },
  hasCompletionSignal(snapshot, expected) {
    return !snapshot.loading && this.hasResult(snapshot) && this.hasQueryIdentity(snapshot, expected);
  },
};

const keywordMiningAdapter: SellerSpriteQueryAdapter = {
  module: "keyword_mining_trend",
  // Keyword Mining is seed-driven and has its own visible form identity.
  inputSelector: 'input[name*="keyword" i], input[placeholder*="关键词"], input[placeholder*="Keyword"]',
  identityInput(input) {
    if (input.module !== "keyword_mining_trend") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    requiredQueryText(input.marketplace, "marketplace");
    if (input.marketplace !== "US") throw new Error("SELLERSPRITE_MARKETPLACE_UNSUPPORTED");
    return requiredQueryText(input.seedKeyword, "seedKeyword");
  },
  resultTables(snapshot) {
    return snapshot.tables.filter((table) => hasKeywordIdentity(table, ["keyword", "关键词", "搜索词"]));
  },
  hasResult(snapshot) {
    return this.resultTables(snapshot).length > 0;
  },
  hasQueryIdentity(snapshot, expected, conditions) {
    return snapshot.queryInputs.some((value) => includesNormalized(value, expected))
      && isUnitedStatesMarketplace(snapshot.marketplaceEcho)
      && conditionsVisible(snapshot, conditions);
  },
  hasCompletionSignal(snapshot, expected, conditions) {
    return !snapshot.loading && this.hasResult(snapshot) && this.hasQueryIdentity(snapshot, expected, conditions);
  },
};

export const SELLERSPRITE_QUERY_ADAPTERS: Readonly<Record<SellerSpriteQueryInput["module"], SellerSpriteQueryAdapter>> = {
  sellersprite_product_market: productResearchAdapter,
  reverse_asin: reverseAsinAdapter,
  keyword_mining_trend: keywordMiningAdapter,
};

function requiredQueryText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`SELLERSPRITE_${field.toUpperCase()}_REQUIRED`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`SELLERSPRITE_${field.toUpperCase()}_INVALID`);
  }
  return normalized;
}

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.normalize("NFC").toLocaleLowerCase().includes(needle.normalize("NFC").trim().toLocaleLowerCase());
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function columnIndex(headers: readonly string[], aliases: readonly string[]): number | null {
  const accepted = new Set(aliases.map(normalizeHeader).filter(Boolean));
  const exact = headers.flatMap((header, index) => accepted.has(normalizeHeader(header)) ? [index] : []);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  // 真实页面表头常带徽标/提示词（如「关键词 数据解释」「内测版流量占比」），
  // 精确匹配失败时回退到**唯一包含匹配**；命中多个则视为歧义并放弃（不猜）。
  const normalizedAliases = [...accepted].sort((left, right) => right.length - left.length);
  const contained = headers.flatMap((header, index) => {
    const normalized = normalizeHeader(header);
    return normalized && normalizedAliases.some((alias) => normalized.includes(alias)) ? [index] : [];
  });
  return contained.length === 1 ? contained[0] : null;
}

function hasProductResearchIdentity(table: SellerSpriteQuerySnapshot["tables"][number]): boolean {
  const asinColumn = columnIndex(table.headers, ["ASIN", "商品ASIN", "产品ASIN"]);
  const titleColumn = columnIndex(table.headers, ["Title", "Product Title", "Product Name", "商品名称", "商品标题", "产品名称"]);
  return asinColumn !== null && titleColumn !== null && table.rows.some((row) =>
    /^[A-Z0-9]{10}$/u.test((row[asinColumn] ?? "").trim().toUpperCase())
      && Boolean((row[titleColumn] ?? "").trim()));
}

function hasKeywordIdentity(table: SellerSpriteQuerySnapshot["tables"][number], aliases: readonly string[]): boolean {
  const keywordColumn = columnIndex(table.headers, aliases);
  return keywordColumn !== null && table.rows.some((row) => Boolean((row[keywordColumn] ?? "").trim()));
}

function conditionsVisible(snapshot: SellerSpriteQuerySnapshot, conditions?: Record<string, string>): boolean {
  return Object.values(conditions ?? {}).every((expected) => snapshot.queryInputs.some((value) => includesNormalized(value, expected)));
}

function isUnitedStatesMarketplace(value: string | null): boolean {
  return value !== null && /^(?:US|Amazon[.]com|United States|美国站)$/iu.test(value.trim());
}

export function validateSellerSpriteQueryInput(value: unknown, module: unknown): SellerSpriteQueryInput {
  if (typeof module !== "string" || !Object.hasOwn(SELLERSPRITE_QUERY_ADAPTERS, module)) {
    throw new Error("SELLERSPRITE_QUERY_MODULE_UNSUPPORTED");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SELLERSPRITE_QUERY_INPUT_REQUIRED");
  }
  const input = value as Record<string, unknown>;
  if (input.module !== module) throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
  const adapter = SELLERSPRITE_QUERY_ADAPTERS[module as SellerSpriteQueryInput["module"]];
  const parsedInput = input as unknown as SellerSpriteQueryInput;
  if (module !== "reverse_asin" && module !== "keyword_mining_trend") {
    if (parsedInput.marketplace !== "US") throw new Error("SELLERSPRITE_MARKETPLACE_UNSUPPORTED");
  }
  if (module === "reverse_asin" && (input.marketplace !== "US")) throw new Error("SELLERSPRITE_MARKETPLACE_UNSUPPORTED");
  adapter.identityInput(parsedInput);
  if (module === "sellersprite_product_market") {
    const filters = input.filters;
    if (filters !== undefined && (typeof filters !== "object" || filters === null || Array.isArray(filters))) {
      throw new Error("SELLERSPRITE_FILTERS_INVALID");
    }
    validateConditions(filters, new Set(["priceMin", "priceMax", "ratingMin", "ratingMax", "reviewCountMin", "reviewCountMax"]));
  }
  if (module === "keyword_mining_trend") {
    const conditions = input.conditions;
    if (conditions !== undefined && (typeof conditions !== "object" || conditions === null || Array.isArray(conditions))) {
      throw new Error("SELLERSPRITE_CONDITIONS_INVALID");
    }
    validateConditions(conditions, new Set(["searchVolumeMin", "searchVolumeMax", "purchasesMin", "purchasesMax", "productsMin", "productsMax", "titleDensityMin", "titleDensityMax", "sprMin", "sprMax"]));
  }
  return input as unknown as SellerSpriteQueryInput;
}

function validateConditions(value: unknown, allowedKeys: ReadonlySet<string>): void {
  if (value === undefined) return;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length > 24) throw new Error("SELLERSPRITE_CONDITIONS_TOO_MANY");
  for (const [key, condition] of entries) {
    if (!allowedKeys.has(key)) {
      throw new Error("SELLERSPRITE_CONDITION_KEY_INVALID");
    }
    if (typeof condition !== "string" || !condition.trim() || condition.length > 120 || /[\u0000-\u001f\u007f]/u.test(condition)) {
      throw new Error("SELLERSPRITE_CONDITION_VALUE_INVALID");
    }
  }
}

export function visibleSnapshotCore(sourceLimitDeclarationPattern: string): Omit<SellerSpriteQuerySnapshot, "tables"> {
  const clean = (value: string | null | undefined, max = 500): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const bodyText = clean(document.body?.innerText, 20_000);
  var reportedMatch = /(?:搜索结果数|结果总数)\s*[：:]?\s*([\d,]+)/u.exec(bodyText)
    || /共\s*([\d,]+)\s*(?:条|个|项)/u.exec(bodyText);
  var accessibleMatch = /(?:当前可访问(?:结果)?(?:总数|数量)?|可查看(?:结果)?(?:总数|数量)?)\s*[：:]\s*([\d,]+)/u.exec(bodyText);
  var unavailableMatch = /(?:不可访问(?:结果)?(?:总数|数量)?|无法查看(?:结果)?(?:总数|数量)?)\s*[：:]\s*([\d,]+)/u.exec(bodyText);
  var resultCount = function (match: RegExpExecArray | null): number | null {
    if (!match) return null;
    var parsed = Number(match[1].replace(/,/gu, ""));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  var sourceLimitDeclared = new RegExp(sourceLimitDeclarationPattern, "iu").test(bodyText);
  var pageNumber: number | null = null;
  var pageCount: number | null = null;
  var hasNextPage: boolean | null = null;
  var nextPageDisabled: boolean | null = null;
  var pagerReportedMatch: RegExpExecArray | null = null;
  var pagers = Array.prototype.slice.call(document.querySelectorAll(".el-pagination")) as Element[];
  var visiblePagers = pagers.filter(visible);
  if (visiblePagers.length === 1) {
    var pager = visiblePagers[0];
    // Keyword Mining exposes its total in the visible pager (for example `/5,416`),
    // not necessarily as labeled body text. Keep an explicit body report authoritative.
    pagerReportedMatch = /\/\s*([\d,]+)/u.exec(clean(pager.querySelector(".all-page-num")?.textContent, 32));
    var activePage = pager.querySelector(".el-pager li.active, [aria-current='page']");
    var activeText = activePage ? clean(activePage.textContent, 16) : "";
    if (/^\d+$/u.test(activeText)) pageNumber = Number(activeText);
    var numberNodes = Array.prototype.slice.call(pager.querySelectorAll(".el-pager li.number")) as Element[];
    var numbers = numberNodes.map(function (node) { return Number(clean(node.textContent, 16)); }).filter(function (number) { return Number.isSafeInteger(number) && number > 0; });
    if (numbers.length > 0) pageCount = Math.max.apply(null, numbers);
    var nextCandidates = Array.prototype.slice.call(pager.querySelectorAll("button.btn-next,button[aria-label*='下一页'],button[aria-label*='Next']")) as Element[];
    nextCandidates = nextCandidates.filter(visible);
    if (nextCandidates.length === 1) {
      var next = nextCandidates[0] as HTMLButtonElement;
      nextPageDisabled = next.disabled || next.getAttribute("aria-disabled") === "true" || ("disabled" in next && Boolean(next.disabled))
        || String(next.className || "").split(/\s+/u).indexOf("is-disabled") >= 0;
      hasNextPage = !nextPageDisabled;
    }
  }
  var resultWidgets = Array.prototype.slice.call(document.querySelectorAll(".el-table")) as Element[];
  resultWidgets = resultWidgets.filter(function (widget) {
    if (!visible(widget)) return false;
    var header = clean(widget.querySelector(".el-table__header-wrapper")?.textContent || widget.querySelector("thead")?.textContent, 1_000);
    return /关键词|搜索词|keyword/iu.test(header);
  });
  var scrollElement: HTMLElement | null = null;
  if (resultWidgets.length === 1) {
    var bodyWrapper = resultWidgets[0].querySelector(".el-table__body-wrapper");
    var cursor: Element | null = bodyWrapper || resultWidgets[0];
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      var parentStyle = window.getComputedStyle(cursor);
      var parentHtml = cursor as HTMLElement;
      if ((parentStyle.overflowY === "auto" || parentStyle.overflowY === "scroll")
        && parentHtml.scrollHeight > parentHtml.clientHeight + 1) {
        scrollElement = parentHtml;
        break;
      }
      cursor = cursor.parentElement;
    }
  }
  var scrollTarget: "document" | "table" | null = scrollElement ? "table" : null;
  var scrollY = scrollElement ? scrollElement.scrollTop : window.scrollY;
  var scrollHeight = scrollElement ? scrollElement.scrollHeight : Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  var clientHeight = scrollElement ? scrollElement.clientHeight : window.innerHeight;
  if (!scrollElement && scrollHeight > clientHeight + 1) scrollTarget = "document";
  const inputValues = Array.from(document.querySelectorAll("input:not([type='password']):not([autocomplete='current-password']):not([autocomplete='new-password']),textarea,select,[role='textbox']"))
    .filter(visible).map((input) => clean((input as HTMLInputElement).value || input.textContent, 200));
  const visibleControls = Array.from(document.querySelectorAll("input:not([type='password']),textarea,select,[role='combobox']"))
    .filter(visible)
    .map((element) => {
      const control = element as HTMLInputElement | HTMLSelectElement;
      const label = clean(element.getAttribute("aria-label") || element.getAttribute("name")
        || element.getAttribute("placeholder") || element.closest("label")?.textContent, 120);
      const value = clean(control instanceof HTMLSelectElement
        ? control.selectedOptions?.[0]?.textContent || control.value
        : control.value || element.textContent, 160);
      return label && value ? { label, value } : null;
    })
    .filter((item): item is { label: string; value: string } => item !== null)
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  const MARKETPLACE_ECHO = /^(?:US|Amazon[.]com|United States|美国站)$/iu;
  // 真实页面用 Element UI 下拉呈现站点（非原生 select），值可能落在 input.value /
  // 选中项文本 / aria-label 上 —— 逐类取值后用同一套站点词表匹配，不做位置猜测。
  const marketplaceEcho = Array.from(document.querySelectorAll(
    'select,[role="combobox"],input,[role="textbox"],[aria-label*="market" i],[data-testid*="market" i],[class*="el-select__selected"],.el-select__selected-item,.el-select__placeholder',
  ))
    .filter(visible)
    .map((element) => {
      const control = element as HTMLSelectElement;
      const selected = control.selectedOptions?.[0]?.textContent ?? control.value;
      return clean(selected || element.getAttribute("aria-label") || element.textContent, 100);
    })
    .find((value) => MARKETPLACE_ECHO.test(value)) ?? null;
  const loading = Array.from(document.querySelectorAll("[aria-busy='true'],[role='progressbar'],.ant-spin-spinner,.ant-spin-spinning,.el-loading-mask,.el-loading-spinner,[class*='el-loading'],.loading"))
    .some(visible);
  const gate = /captcha|verify you are human|security check/iu.test(bodyText) ? "captcha"
    : /access denied|账号异常|访问受限/iu.test(bodyText) ? "stop"
      : /请先登录|登录后使用|sign in to sellersprite/iu.test(bodyText) ? "login" : null;
  // 空结果必须**有可见证据**：可见的表格空态块，或「搜索结果数: 0」。
  // 页面里可能残留隐藏的「暂无相关数据」节点，不能凭 bodyText 直接判定空。
  const visibleEmptyBlocks = Array.from(document.querySelectorAll(".el-table__empty-block, .el-table__empty-text")).filter(visible);
  const emptyByBlock = visibleEmptyBlocks.some((element) => /暂无|无数据|no data|no results/iu.test(element.textContent ?? ""));
  const resultCountZero = /搜索结果数[：:\s]*0(?!\d)/u.test(bodyText);
  return {
    pageTitle: clean(document.title, 300),
    bodyText,
    queryInputs: inputValues.filter(Boolean),
    visibleControls,
    marketplaceEcho,
    loading,
    gate,
    empty: emptyByBlock || resultCountZero,
    queryError: /查询失败|搜索失败|request failed|something went wrong/iu.test(bodyText),
    traversal: {
      page: pageNumber ?? 1,
      pageNumber,
      pageCount,
      scrollY: Number.isSafeInteger(scrollY) && scrollY >= 0 ? scrollY : 0,
      scrollTarget,
      clientHeight: Number.isSafeInteger(clientHeight) && clientHeight >= 0 ? clientHeight : 0,
      scrollHeight: Number.isSafeInteger(scrollHeight) && scrollHeight >= 0 ? scrollHeight : 0,
      hasNextPage,
      nextPageDisabled,
      sourceLimitDeclared,
      reportedTotalRows: resultCount(reportedMatch) ?? resultCount(pagerReportedMatch),
      accessibleRows: resultCount(accessibleMatch),
      unavailableRows: resultCount(unavailableMatch),
    },
  };
}

/**
 * P2-2：表格统一由「页内采集 + Node 侧表头对齐」两步产出。
 * 真实 SellerSprite 页面是 Element UI 双表结构（表头表与数据表分离），
 * 不能依赖 `thead` 只读或 `tr:first-child` 猜测。
 */
async function readQuerySnapshot(page: TaskPage): Promise<SellerSpriteQuerySnapshot> {
  const core = await page.evaluate(visibleSnapshotCore, SOURCE_LIMIT_DECLARATION_PATTERN);
  const raw = await page.evaluate(collectRawVisibleTables as unknown as () => RawVisibleSnapshot);
  const layouts = resolveVisibleTableLayout(raw);
  return {
    ...core,
    tables: layouts.map((layout) => ({ headers: [...layout.headers], rows: layout.rows.map((row) => [...row]) })),
  };
}

type Locator = {
  count(): Promise<number>;
  nth(index: number): Locator;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
  selectOption(value: string): Promise<void>;
  click(): Promise<void>;
};
type TaskPage = {
  close(): Promise<void>;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<void>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): Locator;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, TArg>(fn: (arg: TArg) => T, arg: TArg): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
};
type ConnectedBrowser = {
  contexts(): Array<{ newPage(): Promise<TaskPage> }>;
  close(): Promise<void>;
  /** D2-1F：在**本次连接对象**上读取启动参数（身份校验）；绝不用于关闭浏览器。 */
  newBrowserCDPSession?(): Promise<{ send(method: string): Promise<unknown>; detach?(): Promise<void> }>;
};
type PlaywrightModule = { chromium: { connectOverCDP(endpoint: string, options: { timeout: number }): Promise<ConnectedBrowser> } };

export function isSellerSpriteQueryPageUrl(value: string, module: SellerSpriteQueryInput["module"]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SELLERSPRITE_HOST.test(url.hostname.toLowerCase())
      && MODULE_PATHS[module].test(url.pathname);
  } catch {
    return false;
  }
}

export function isSellerSpriteSourceLimitDeclared(bodyText: string): boolean {
  return new RegExp(SOURCE_LIMIT_DECLARATION_PATTERN, "iu").test(bodyText);
}

export function sellerSpriteQueryFingerprint(input: SellerSpriteQueryInput, accountAccessSnapshot = "not_verified"): string {
  return createHash("sha256").update(stableQueryIdentity({
    module: input.module,
    queryInput: input,
    marketplace: input.marketplace,
    accountAccessSnapshot,
  })).digest("hex");
}

/** Product Market 的证据主体是类目查询，不得复用任一商品 ASIN 主体。 */
export function sellerSpriteProductMarketQuerySubjectKey(
  input: Extract<SellerSpriteQueryInput, { module: "sellersprite_product_market" }>,
): string {
  return sellerSpriteQuerySubjectKey({
    module: "sellersprite_product_market",
    marketplace: input.marketplace,
    queryFingerprint: sellerSpriteQueryFingerprint(input),
  });
}

/** Keyword Mining evidence belongs to its seed query, never to an arbitrary batch ASIN. */
export function sellerSpriteKeywordMiningQuerySubjectKey(
  input: Extract<SellerSpriteQueryInput, { module: "keyword_mining_trend" }>,
): string {
  return sellerSpriteQuerySubjectKey({
    module: "keyword_mining_trend",
    marketplace: input.marketplace,
    queryFingerprint: sellerSpriteQueryFingerprint(input),
  });
}

function cdpEndpoint(): string {
  const value = process.env.SELLERSPRITE_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback || !["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("SELLERSPRITE_CDP_ENDPOINT_INVALID");
  }
  return url.toString();
}

async function applyVisibleConditions(page: TaskPage, input: SellerSpriteQueryInput): Promise<void> {
  const conditions = input.module === "sellersprite_product_market" ? input.filters
    : input.module === "keyword_mining_trend" ? input.conditions : undefined;
  for (const [name, value] of Object.entries(conditions ?? {})) {
    const control = page.locator(`input[name="${name}"],textarea[name="${name}"],select[name="${name}"]`);
    if (await control.count() !== 1 || !(await control.nth(0).isVisible())) {
      throw new Error("SELLERSPRITE_VISIBLE_FILTER_NOT_UNIQUE");
    }
    const field = control.nth(0);
    const select = page.locator(`select[name="${name}"]`);
    if (await select.count() === 1) await select.nth(0).selectOption(value);
    else {
      const type = ((await field.getAttribute("type")) ?? "text").toLowerCase();
      if (!["text", "search", "number"].includes(type)) {
        throw new Error("SELLERSPRITE_VISIBLE_FILTER_CONTROL_UNSUPPORTED");
      }
      await field.fill(value);
    }
  }
}

function scrollNextVisibleResultWindow(target: "document" | "table"): {
  advanced: boolean; scrollY: number; scrollTarget: "document" | "table";
} {
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const widgets: Element[] = [];
  for (const candidate of Array.from(document.querySelectorAll(".el-table"))) {
    if (!visible(candidate)) continue;
    const header = candidate.querySelector(".el-table__header-wrapper")?.textContent
      ?? candidate.querySelector("thead")?.textContent ?? "";
    if (/关键词|搜索词|keyword/iu.test(header)) widgets.push(candidate);
  }
  if (target === "table" && widgets.length === 1) {
    let cursor: Element | null = widgets[0].querySelector(".el-table__body-wrapper") || widgets[0];
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      const style = window.getComputedStyle(cursor);
      const element = cursor as HTMLElement;
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1) {
        const before = element.scrollTop;
        element.scrollTop = Math.min(element.scrollHeight, before + Math.max(1, Math.floor(element.clientHeight * 0.8)));
        return { advanced: element.scrollTop > before, scrollY: element.scrollTop, scrollTarget: "table" };
      }
      cursor = cursor.parentElement;
    }
    return { advanced: false, scrollY: 0, scrollTarget: "table" };
  }
  const before = window.scrollY;
  window.scrollBy(0, Math.max(1, Math.floor(window.innerHeight * 0.8)));
  return { advanced: window.scrollY > before, scrollY: window.scrollY, scrollTarget: "document" };
}

function restoreVisibleResultWindow(input: { target: "document" | "table"; scrollY: number }): boolean {
  if (!Number.isSafeInteger(input.scrollY) || input.scrollY < 0) return false;
  if (input.target === "document") {
    window.scrollTo(0, input.scrollY);
    return Math.abs(window.scrollY - input.scrollY) <= 2;
  }
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const widgets = Array.from(document.querySelectorAll(".el-table")).filter((widget) => {
    const header = widget.querySelector(".el-table__header-wrapper")?.textContent
      ?? widget.querySelector("thead")?.textContent ?? "";
    return visible(widget) && /关键词|搜索词|keyword/iu.test(header);
  });
  if (widgets.length !== 1) return input.scrollY === 0;
  let cursor: Element | null = widgets[0].querySelector(".el-table__body-wrapper") || widgets[0];
  while (cursor && cursor !== document.body && cursor !== document.documentElement) {
    const style = window.getComputedStyle(cursor);
    const element = cursor as HTMLElement;
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1) {
      element.scrollTop = input.scrollY;
      return Math.abs(element.scrollTop - input.scrollY) <= 2;
    }
    cursor = cursor.parentElement;
  }
  return input.scrollY === 0;
}

async function clickVisibleNextPage(page: TaskPage): Promise<boolean> {
  const next = page.locator(".el-pagination button.btn-next, .el-pagination button[aria-label*='下一页'], .el-pagination button[aria-label*='Next']");
  const count = await next.count();
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = next.nth(index);
    if (await item.isVisible()) visible.push(item);
  }
  if (visible.length !== 1 || !(await visible[0].isEnabled())) return false;
  await visible[0].click();
  return true;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sellerSpriteVisibleQuerySnapshotFingerprint(input: {
  module: SellerSpriteQueryInput["module"];
  queryInput: SellerSpriteQueryInput;
  snapshot: SellerSpriteQuerySnapshot;
}): string {
  const resultTables = SELLERSPRITE_QUERY_ADAPTERS[input.module].resultTables(input.snapshot);
  const rowIdentity = input.module === "sellersprite_product_market" ? []
    : identifySellerSpriteVisibleKeywordRows(input.module, resultTables).rows.map((row) => ({ rowKey: row.rowKey, rawCells: row.rawCells }));
  return contentHash({
    module: input.module,
    queryInput: stableQueryIdentity({
      module: input.module,
      marketplace: input.queryInput.marketplace,
      queryInput: input.queryInput,
      accountAccessSnapshot: "not_verified",
    }),
    headers: resultTables.map((table) => table.headers),
    rowIdentity,
    visibleQueryInputs: input.snapshot.queryInputs.map((value) => value.normalize("NFC").trim()),
    visibleControls: [...(input.snapshot.visibleControls ?? [])]
      .map((control) => ({ label: control.label.normalize("NFC").trim(), value: control.value.normalize("NFC").trim() }))
      .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value)),
    marketplaceEcho: input.snapshot.marketplaceEcho,
    reportedTotalRows: input.snapshot.traversal?.reportedTotalRows ?? null,
    accessibleRows: input.snapshot.traversal?.accessibleRows ?? null,
    unavailableRows: input.snapshot.traversal?.unavailableRows ?? null,
    sourceLimitDeclared: input.snapshot.traversal?.sourceLimitDeclared ?? false,
  });
}

export type SellerSpriteVisibleQueryResult = {
  status: "captured" | "limited" | "human_required" | "unavailable" | "empty" | "query_error" | "failed";
  module: SellerSpriteQueryInput["module"];
  sourceUrl: string;
  snapshot: SellerSpriteQuerySnapshot | null;
  inputDiagnostics?: {visibleMatches:number;pageTitle:string;visibleControlLabels:string[];loading:boolean;marketplaceEcho:string|null};
  capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null;
  windows?: readonly {
    cursor: SellerSpriteCaptureCursor;
    rowKeys: readonly string[];
    structuredValidRowKeys: readonly string[];
    persistedRowKeys: readonly string[];
    evidenceRefs: readonly string[];
    actualVisibleRows: number;
    duplicatesRejected: number;
    rejectedRows: number;
    capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null;
  }[];
  traversal?: {
    finalStatus: "COMPLETE" | "PARTIAL" | null;
    limitationReason: "query_finished" | "source_limit_declared" | "human_login_required" | "captcha_or_stop_page"
      | "budget_stop" | "technical_error" | "cancelled" | "unknown";
    errorCode: string | null;
    counters: {
      reportedTotalRows: number | null;
      accessibleRows: number | null;
      capturedUniqueRows: number;
      structuredValidRows: number;
      persistedEvidenceRows: number;
      unavailableRows: number | null;
    };
    diagnostics: { actualVisibleRows: number; duplicatesRejected: number; rejectedRows: number; windowsProcessed: number };
    cursor: SellerSpriteCaptureCursor | null;
    captureGeneration: number;
    snapshotFingerprint: string;
  };
  errorCode: string | null;
};

export type SellerSpriteVisibleCaptureJobBinding = {
  captureGeneration: number;
  snapshotFingerprint: string;
  cursorWindowFingerprint?: string | null;
  cursor: SellerSpriteCaptureCursor | null;
  rowKeys: readonly string[];
  structuredValidRowKeys: readonly string[];
  persistedRowKeys: readonly string[];
  counters: SellerSpriteCaptureCounters;
  diagnostics: SellerSpriteCaptureDiagnostics;
};

export type SellerSpriteVisibleCaptureWindowCheckpoint = {
  cursor: SellerSpriteCaptureCursor;
  cursorWindowFingerprint: string;
  rowKeys: readonly string[];
  structuredValidRowKeys: readonly string[];
  persistedRowKeys: readonly string[];
  evidenceRefs: readonly string[];
  counters: {
    reportedTotalRows: number | null;
    accessibleRows: number | null;
    capturedUniqueRows: number;
    structuredValidRows: number;
    persistedEvidenceRows: number;
    unavailableRows: number | null;
  };
  diagnostics: { actualVisibleRows: number; duplicatesRejected: number; rejectedRows: number; windowsProcessed: number };
  lastErrorCode?: string | null;
};

type SellerSpriteVisibleCaptureSnapshotInput = {
  snapshotFingerprint: string;
  reportedTotalRows: number | null;
  accessibleRows: number | null;
  unavailableRows: number | null;
  forceNewGeneration?: boolean;
};

async function waitForVisiblePageTransition(input: {
  page: TaskPage;
  previous: SellerSpriteQuerySnapshot;
  module: SellerSpriteKeywordPage;
  expected: string;
  conditions?: Record<string, string>;
  nextPage: number;
}): Promise<SellerSpriteQuerySnapshot | null> {
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  let snapshot = input.previous;
  while (Date.now() < deadline) {
    await input.page.waitForTimeout(300);
    snapshot = await readQuerySnapshot(input.page);
    // 加载中出现的套餐限制提示（多为上一页残留或过渡态横幅）不代表本次翻页已结束；
    // 只有 loading 结束后的限制声明才是可信边界。gate/queryError 是整页问题，保持立即返回。
    if (snapshot.gate || snapshot.queryError
      || (snapshot.traversal?.sourceLimitDeclared === true && !snapshot.loading)) return snapshot;
    const pageChanged = hasVisiblePageTransitionResult({
      previous: input.previous,
      snapshot,
      module: input.module,
      nextPage: input.nextPage,
    });
    if (!snapshot.loading && pageChanged
      && SELLERSPRITE_QUERY_ADAPTERS[input.module].hasCompletionSignal(snapshot, input.expected, input.conditions)) return snapshot;
  }
  return null;
}

async function captureSellerSpriteVisibleQueryWindows(input: {
  context: AccessContext;
  page: TaskPage;
  module: SellerSpriteKeywordPage;
  subjectKey: string;
  identity: Record<string, unknown>;
  queryInput: SellerSpriteKeywordQueryInput;
  snapshot: SellerSpriteQuerySnapshot;
  sourceLimitSnapshotConfirmed: boolean;
  expected: string;
  conditions?: Record<string, string>;
  attemptGeneration: number;
  captureJobFingerprint: string;
  accountAccessFingerprint: string;
  resumeCursor: SellerSpriteCaptureCursor | null;
  maxWindows: number;
  onSnapshot?: (snapshot: SellerSpriteVisibleCaptureSnapshotInput) => Promise<SellerSpriteVisibleCaptureJobBinding | null>;
  onWindowCheckpoint?: (checkpoint: SellerSpriteVisibleCaptureWindowCheckpoint) => Promise<boolean>;
  shouldStop?: () => Promise<boolean>;
}): Promise<{
  status: "captured" | "limited" | "human_required" | "failed";
  sourceUrl: string;
  snapshot: SellerSpriteQuerySnapshot;
  capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null;
  windows: SellerSpriteVisibleQueryResult["windows"];
  /** Absent only when a source-limit page failed identity confirmation before any binding. */
  traversal?: NonNullable<SellerSpriteVisibleQueryResult["traversal"]>;
  errorCode: string | null;
}> {
  if (!Number.isSafeInteger(input.attemptGeneration) || input.attemptGeneration < 1
    || !/^[a-f0-9]{64}$/u.test(input.captureJobFingerprint)) {
    throw new Error("SELLERSPRITE_CAPTURE_JOB_IDENTITY_INVALID");
  }
  assertSellerSpriteSubjectIdentity(input);
  const adapter = SELLERSPRITE_QUERY_ADAPTERS[input.module];
  const sourceQueryFingerprint = sellerSpriteQueryFingerprint(input.queryInput, input.accountAccessFingerprint);
  const firstSnapshotFingerprint = sellerSpriteVisibleQuerySnapshotFingerprint({ module: input.module, queryInput: input.queryInput, snapshot: input.snapshot });
  const initialCoverage = input.snapshot.traversal;
  if (initialCoverage?.sourceLimitDeclared === true && !input.sourceLimitSnapshotConfirmed) {
    // 来源声明了限制范围，但本次查询身份未确认（loading 未结束、回显或站点不成立）：
    // 不能把未知页面绑定到持久任务，也不能把它冒充为套餐限制结论。按技术失败返回，
    // 不调用 onSnapshot，任务原有断点与计数保持不变（route 失败收尾只做状态合并）。
    return {
      status: "failed",
      sourceUrl: input.page.url(),
      snapshot: input.snapshot,
      capture: null,
      windows: [],
      errorCode: "SELLERSPRITE_QUERY_IDENTITY_UNCONFIRMED_AT_SOURCE_LIMIT",
    };
  }
  const binding = input.onSnapshot
    ? await input.onSnapshot({
      snapshotFingerprint: firstSnapshotFingerprint,
      reportedTotalRows: initialCoverage?.reportedTotalRows ?? null,
      accessibleRows: initialCoverage?.accessibleRows ?? null,
      unavailableRows: initialCoverage?.unavailableRows ?? null,
    })
    : {
      captureGeneration: 1,
      snapshotFingerprint: firstSnapshotFingerprint,
      cursor: input.resumeCursor,
      rowKeys: [],
      structuredValidRowKeys: [],
      persistedRowKeys: [],
      counters: {
        reportedTotalRows: initialCoverage?.reportedTotalRows ?? null,
        accessibleRows: initialCoverage?.accessibleRows ?? null,
        capturedUniqueRows: 0,
        structuredValidRows: 0,
        persistedEvidenceRows: 0,
        unavailableRows: initialCoverage?.unavailableRows ?? null,
      },
      diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    } satisfies SellerSpriteVisibleCaptureJobBinding;
  if (!binding || binding.snapshotFingerprint !== firstSnapshotFingerprint
    || !Number.isSafeInteger(binding.captureGeneration) || binding.captureGeneration < 1) {
    throw new Error("SELLERSPRITE_CAPTURE_SNAPSHOT_BINDING_FAILED");
  }
  const persistedIndex = await indexPersistedSellerSpriteWindows({
    context: input.context,
    subjectKey: input.subjectKey,
    module: input.module,
    captureJobFingerprint: input.captureJobFingerprint,
    sourceQueryFingerprint,
  });
  const persistedWindows = persistedIndex.windows;
  const rowContentHashes = persistedIndex.rowContentHashes;
  const conflictingRowKeys = persistedIndex.conflictingRowKeys;
  const captureGeneration = binding.captureGeneration;
  const seenRowKeys = new Set(binding.rowKeys);
  const validRowKeys = new Set(binding.structuredValidRowKeys);
  const persistedRowKeys = new Set(binding.persistedRowKeys);
  const counters = { ...binding.counters };
  const diagnostics = { ...binding.diagnostics, cursorRestored: binding.cursor ? false : null };
  const windows: NonNullable<SellerSpriteVisibleQueryResult["windows"]>[number][] = [];
  let captured: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null = null;
  let snapshot = input.snapshot;
  let pageNumber = 1;
  let cursor: SellerSpriteCaptureCursor | null = binding.cursor;
  let resumeCursorWindowFingerprint = binding.cursor ? binding.cursorWindowFingerprint ?? null : null;
  let finalStatus: "COMPLETE" | "PARTIAL" | null = null;
  let limitationReason: NonNullable<SellerSpriteVisibleQueryResult["traversal"]>["limitationReason"] = "unknown";
  let errorCode: string | null = null;
  let windowsInRun = 0;

  if (cursor) {
    let cursorRestoreAborted = false;
    while (pageNumber < cursor.page) {
      if (snapshot.traversal?.hasNextPage !== true || !(await clickVisibleNextPage(input.page))) {
        return {
          status: "failed", sourceUrl: input.page.url(), snapshot, capture: null, windows,
          traversal: { finalStatus: null, limitationReason: "unknown", errorCode: "SELLERSPRITE_CURSOR_PAGE_NOT_RESTORABLE",
            counters, diagnostics, cursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
          errorCode: "SELLERSPRITE_CURSOR_PAGE_NOT_RESTORABLE",
        };
      }
      const next = await waitForVisiblePageTransition({
        page: input.page, previous: snapshot, module: input.module, expected: input.expected,
        conditions: input.conditions, nextPage: pageNumber + 1,
      });
      if (!next || next.gate || next.queryError || next.traversal?.sourceLimitDeclared) {
        const human = next?.gate;
        const sourceLimited = next?.traversal?.sourceLimitDeclared === true;
        if (sourceLimited && next && adapter.hasQueryIdentity(next, input.expected, input.conditions)) {
          // 来源限制但本次查询身份成立：当前页是本查询的合法结果页。接受它为工作页，
          // 跳出断点恢复，让主循环先保存本页合法可见行，再停止超出权限的继续访问。
          snapshot = next;
          pageNumber = next.traversal?.pageNumber ?? pageNumber;
          cursor = {
            page: pageNumber,
            scrollY: snapshot.traversal?.scrollY ?? 0,
            scrollTarget: snapshot.traversal?.scrollTarget ?? "document",
          };
          resumeCursorWindowFingerprint = null;
          diagnostics.cursorRestored = false;
          cursorRestoreAborted = true;
          break;
        }
        if (sourceLimited) {
          // 来源声明限制但查询身份不成立（回显/站点丢失）：属于技术失败，
          // 不得把它标记为套餐限制（那会挡住普通重试并误报来源结论）。
          counters.reportedTotalRows = next?.traversal?.reportedTotalRows ?? counters.reportedTotalRows;
          counters.accessibleRows = next?.traversal?.accessibleRows ?? null;
          counters.unavailableRows = next?.traversal?.unavailableRows ?? null;
          return {
            status: "failed", sourceUrl: input.page.url(), snapshot: next ?? snapshot, capture: null, windows,
            traversal: { finalStatus: "PARTIAL", limitationReason: "technical_error",
              errorCode: "SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL", counters, diagnostics,
              cursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
            errorCode: "SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL",
          };
        }
        return {
          status: human ? "human_required" : "failed", sourceUrl: input.page.url(), snapshot: next ?? snapshot, capture: null, windows,
          traversal: { finalStatus: null,
            limitationReason: human === "captcha" || human === "stop" ? "captcha_or_stop_page" : human === "login" ? "human_login_required" : "unknown",
            errorCode: "SELLERSPRITE_CURSOR_PAGE_NOT_RESTORABLE", counters, diagnostics, cursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
          errorCode: "SELLERSPRITE_CURSOR_PAGE_NOT_RESTORABLE",
        };
      }
      pageNumber += 1;
      snapshot = next;
    }
    if (!cursorRestoreAborted) {
      const target = cursor.scrollTarget ?? snapshot.traversal?.scrollTarget ?? "document";
      const restored = await input.page.evaluate(restoreVisibleResultWindow, { target, scrollY: cursor.scrollY });
      if (!restored) {
        return {
          status: "failed", sourceUrl: input.page.url(), snapshot, capture: null, windows,
          traversal: { finalStatus: null, limitationReason: "unknown", errorCode: "SELLERSPRITE_CURSOR_SCROLL_NOT_RESTORABLE",
            counters, diagnostics, cursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
          errorCode: "SELLERSPRITE_CURSOR_SCROLL_NOT_RESTORABLE",
        };
      }
      diagnostics.cursorRestored = true;
      await input.page.waitForTimeout(250);
      snapshot = await readQuerySnapshot(input.page);
    }
  }

  while (windowsInRun < input.maxWindows) {
    if (await input.shouldStop?.()) {
      return {
        status: "failed", sourceUrl: input.page.url(), snapshot, capture: null, windows,
        traversal: { finalStatus: null, limitationReason: "cancelled", errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
          counters, diagnostics, cursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
        errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
      };
    }
    if (snapshot.gate) {
      limitationReason = snapshot.gate === "captcha" || snapshot.gate === "stop" ? "captcha_or_stop_page" : "human_login_required";
      finalStatus = "PARTIAL";
      errorCode = `SELLERSPRITE_${snapshot.gate.toUpperCase()}_REQUIRED`;
      break;
    }
    // 来源限制页只要查询身份成立就是可信工作页（可能只有部分可见行，甚至 0 行）；
    // 此时不能按「完成信号缺失」误判为技术失败。
    if (!adapter.hasCompletionSignal(snapshot, input.expected, input.conditions)
      && !(snapshot.traversal?.sourceLimitDeclared === true
        && adapter.hasQueryIdentity(snapshot, input.expected, input.conditions))) {
      limitationReason = "technical_error";
      finalStatus = "PARTIAL";
      errorCode = "SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL";
      break;
    }
    if (snapshot.traversal?.sourceLimitDeclared) {
      counters.reportedTotalRows = snapshot.traversal.reportedTotalRows ?? counters.reportedTotalRows;
      counters.accessibleRows = snapshot.traversal.accessibleRows;
      counters.unavailableRows = snapshot.traversal.unavailableRows;
    }
    const observation = snapshot.traversal;
    if (!observation) {
      limitationReason = "unknown";
      finalStatus = "PARTIAL";
      errorCode = "SELLERSPRITE_TRAVERSAL_STATE_UNAVAILABLE";
      break;
    }
    pageNumber = observation.pageNumber ?? pageNumber;
    const pageState: SellerSpriteCaptureTraversalState = { ...observation, page: pageNumber };
    const windowCursor: SellerSpriteCaptureCursor = {
      page: pageState.page,
      scrollY: pageState.scrollY,
      scrollTarget: pageState.scrollTarget ?? "document",
    };
    const resultTables = adapter.resultTables(snapshot);
    const identified = identifySellerSpriteVisibleKeywordRows(input.module, resultTables);
    const scopedRowKeys = new Map(identified.rows.map((row) => [row.rowKey, `generation:${captureGeneration}:${row.rowKey}`]));
    const rowHashes = new Map(identified.rows.map((row) => [row.rowKey, contentHash({ headers: row.headers, row: row.rawCells })]));
    const cursorWindowFingerprint = contentHash({
      captureGeneration,
      snapshotFingerprint: firstSnapshotFingerprint,
      cursor: windowCursor,
      rows: identified.rows.map((row) => ({ rowKey: row.rowKey, headers: row.headers, rawCells: row.rawCells })),
    });
    const restoredCursorMatches = cursor !== null
      && cursor.page === windowCursor.page
      && cursor.scrollY === windowCursor.scrollY
      && (cursor.scrollTarget ?? "document") === windowCursor.scrollTarget
      && resumeCursorWindowFingerprint !== null
      && resumeCursorWindowFingerprint === cursorWindowFingerprint;
    const restoredCursorDrift = cursor !== null && resumeCursorWindowFingerprint !== null && !restoredCursorMatches;
    const changedExistingRow = identified.rows.find((row) => {
      const scopedKey = scopedRowKeys.get(row.rowKey)!;
      const previousHash = rowContentHashes.get(scopedKey);
      const wasSeen = seenRowKeys.has(scopedKey);
      if (!wasSeen && previousHash === undefined && !conflictingRowKeys.has(scopedKey)) return false;
      if (conflictingRowKeys.has(scopedKey)) return true;
      if (previousHash !== undefined) return previousHash !== rowHashes.get(row.rowKey);
      // A row whose Evidence write failed has no immutable row hash yet. Retry it
      // only when the exact cursor window stored in the durable job is restored.
      return !(restoredCursorMatches && wasSeen && !persistedRowKeys.has(scopedKey));
    });
    if (restoredCursorDrift || changedExistingRow) {
      const rotated = input.onSnapshot ? await input.onSnapshot({
        snapshotFingerprint: firstSnapshotFingerprint,
        reportedTotalRows: counters.reportedTotalRows,
        accessibleRows: counters.accessibleRows,
        unavailableRows: counters.unavailableRows,
        forceNewGeneration: true,
      }) : null;
      const rotationFailed = !rotated || rotated.captureGeneration <= captureGeneration
        || rotated.snapshotFingerprint !== firstSnapshotFingerprint;
      const driftErrorCode = rotationFailed
        ? "SELLERSPRITE_ROW_SNAPSHOT_DRIFT_GENERATION_ROTATION_FAILED"
        : "SELLERSPRITE_ROW_SNAPSHOT_DRIFT_NEW_GENERATION_REQUIRED";
      return {
        status: "failed", sourceUrl: input.page.url(), snapshot, capture: null, windows,
        traversal: {
          finalStatus: "PARTIAL",
          limitationReason: "unknown",
          errorCode: driftErrorCode,
          counters: rotated?.counters ?? counters,
          diagnostics: rotated?.diagnostics ?? diagnostics,
          cursor: rotated ? rotated.cursor : cursor,
          captureGeneration: rotated?.captureGeneration ?? captureGeneration,
          snapshotFingerprint: rotated?.snapshotFingerprint ?? firstSnapshotFingerprint,
        },
        errorCode: driftErrorCode,
      };
    }
    const uniqueRows = identified.rows.filter((row) => !seenRowKeys.has(scopedRowKeys.get(row.rowKey)!));
    const retryEvidenceRows = identified.rows.filter((row) => seenRowKeys.has(scopedRowKeys.get(row.rowKey)!)
      && row.typedRow.status === "valid" && !persistedRowKeys.has(scopedRowKeys.get(row.rowKey)!));
    const newRows = [...uniqueRows, ...retryEvidenceRows];
    const overlapCount = identified.rows.length - uniqueRows.length;
    const duplicateDelta = identified.duplicatesRejected + overlapCount;
    const generationRowKeys = uniqueRows.map((row) => `generation:${captureGeneration}:${row.rowKey}`);
    const generationValidRowKeys = uniqueRows.filter((row) => row.typedRow.status === "valid")
      .map((row) => `generation:${captureGeneration}:${row.rowKey}`);
    const nextUniqueRowCount = seenRowKeys.size + generationRowKeys.length;
    const traversalDecision = decideSellerSpriteCaptureTraversal({
      state: pageState,
      capturedUniqueRows: nextUniqueRowCount,
      newUniqueRowsInWindow: uniqueRows.length,
      windowsProcessed: windowsInRun + 1,
      maxWindows: input.maxWindows,
    });
    const persistTerminalCheckpoint = newRows.length === 0
      && identified.rows.length > 0
      && traversalDecision.action === "complete";
    let capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null = null;
    let generationPersistedRowKeys: string[] = [];
    let evidenceRefs: string[] = [];
    let windowErrorCode: string | null = null;
    if (newRows.length > 0 || persistTerminalCheckpoint) {
      try {
        if (await input.shouldStop?.()) {
          return {
            status: "failed", sourceUrl: input.page.url(), snapshot, capture: null, windows,
            traversal: { finalStatus: null, limitationReason: "cancelled", errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
              counters, diagnostics, cursor: windowCursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
            errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
          };
        }
        const evidence = await captureSellerSpriteRowWindowEvidence({
          context: input.context,
          module: input.module,
          sourceUrl: input.page.url(),
          subjectKey: input.subjectKey,
          identity: input.identity,
          queryInput: input.queryInput,
          captureJobFingerprint: input.captureJobFingerprint,
          sourceQueryFingerprint,
          captureGeneration,
          attemptGeneration: input.attemptGeneration,
          snapshotFingerprint: firstSnapshotFingerprint,
          cursor: windowCursor,
          windowBudget: input.maxWindows,
          snapshot,
          rows: newRows.length > 0 ? newRows : identified.rows,
          ...(persistTerminalCheckpoint ? { rowScope: "traversal_checkpoint_only" as const } : {}),
          persistedWindows,
        });
        capture = evidence.capture;
        if (!persistTerminalCheckpoint) {
          generationPersistedRowKeys = evidence.rowKeys.map((key) => `generation:${captureGeneration}:${key}`);
        }
        evidenceRefs = [`attachment:${evidence.attachmentId}`, `raw-artifact:${evidence.rawArtifactId}`];
      } catch (error) {
        windowErrorCode = error instanceof Error ? error.message : "SELLERSPRITE_ROW_EVIDENCE_CAPTURE_FAILED";
      }
    }
    const nextSeen = new Set([...seenRowKeys, ...generationRowKeys]);
    const nextValid = new Set([...validRowKeys, ...generationValidRowKeys]);
    const nextPersisted = new Set([...persistedRowKeys, ...generationPersistedRowKeys]);
    const nextCounters = {
      ...counters,
      capturedUniqueRows: nextSeen.size,
      structuredValidRows: nextValid.size,
      persistedEvidenceRows: nextPersisted.size,
    };
    const nextDiagnostics = {
      actualVisibleRows: diagnostics.actualVisibleRows + identified.actualVisibleRows,
      duplicatesRejected: diagnostics.duplicatesRejected + duplicateDelta,
      rejectedRows: diagnostics.rejectedRows + identified.rejectedRows,
      windowsProcessed: diagnostics.windowsProcessed + 1,
    };
    const checkpoint: SellerSpriteVisibleCaptureWindowCheckpoint = {
      cursor: windowCursor,
      cursorWindowFingerprint,
      rowKeys: generationRowKeys,
      structuredValidRowKeys: generationValidRowKeys,
      persistedRowKeys: generationPersistedRowKeys,
      evidenceRefs,
      counters: nextCounters,
      diagnostics: nextDiagnostics,
      ...(windowErrorCode ? { lastErrorCode: windowErrorCode } : {}),
    };
    if (input.onWindowCheckpoint && !(await input.onWindowCheckpoint(checkpoint))) {
      return {
        status: "failed", sourceUrl: input.page.url(), snapshot, capture, windows,
        traversal: { finalStatus: null, limitationReason: "cancelled", errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
          counters, diagnostics, cursor: windowCursor, captureGeneration, snapshotFingerprint: firstSnapshotFingerprint },
        errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
      };
    }
    for (const key of generationRowKeys) seenRowKeys.add(key);
    for (const key of generationValidRowKeys) validRowKeys.add(key);
    for (const key of generationPersistedRowKeys) persistedRowKeys.add(key);
    for (const row of newRows) {
      const scopedKey = scopedRowKeys.get(row.rowKey)!;
      rowContentHashes.set(scopedKey, rowHashes.get(row.rowKey)!);
    }
    Object.assign(counters, nextCounters);
    Object.assign(diagnostics, nextDiagnostics);
    cursor = windowCursor;
    resumeCursorWindowFingerprint = null;
    windowsInRun += 1;
    if (capture) captured = capture;
    windows.push({
      cursor: windowCursor,
      rowKeys: generationRowKeys,
      structuredValidRowKeys: generationValidRowKeys,
      persistedRowKeys: generationPersistedRowKeys,
      evidenceRefs,
      actualVisibleRows: identified.actualVisibleRows,
      duplicatesRejected: duplicateDelta,
      rejectedRows: identified.rejectedRows,
      capture,
    });
    if (windowErrorCode) {
      finalStatus = "PARTIAL";
      limitationReason = "technical_error";
      errorCode = windowErrorCode;
      break;
    }

    if (traversalDecision.action === "complete") {
      finalStatus = "COMPLETE";
      limitationReason = "query_finished";
      break;
    }
    if (traversalDecision.action === "stop") {
      finalStatus = "PARTIAL";
      limitationReason = traversalDecision.limitationReason;
      break;
    }
    if (traversalDecision.action === "scroll") {
      const moved = await input.page.evaluate(scrollNextVisibleResultWindow, pageState.scrollTarget as "document" | "table");
      if (!moved.advanced) {
        finalStatus = "PARTIAL";
        limitationReason = "unknown";
        errorCode = "SELLERSPRITE_SCROLL_DID_NOT_ADVANCE";
        break;
      }
      await input.page.waitForTimeout(350);
      snapshot = await readQuerySnapshot(input.page);
      continue;
    }
    if (!(await clickVisibleNextPage(input.page))) {
      finalStatus = "PARTIAL";
      limitationReason = "unknown";
      errorCode = "SELLERSPRITE_VISIBLE_NEXT_PAGE_NOT_ACTIONABLE";
      break;
    }
    const next = await waitForVisiblePageTransition({
      page: input.page, previous: snapshot, module: input.module, expected: input.expected,
      conditions: input.conditions, nextPage: pageNumber + 1,
    });
    if (!next) {
      finalStatus = "PARTIAL";
      limitationReason = "budget_stop";
      errorCode = "SELLERSPRITE_NEXT_PAGE_TIMEOUT";
      break;
    }
    if (next.gate) {
      finalStatus = "PARTIAL";
      limitationReason = next.gate === "captcha" || next.gate === "stop" ? "captcha_or_stop_page" : "human_login_required";
      errorCode = `SELLERSPRITE_${next.gate.toUpperCase()}_REQUIRED`;
      break;
    }
    if (next.traversal?.sourceLimitDeclared) {
      if (!adapter.hasQueryIdentity(next, input.expected, input.conditions)) {
        finalStatus = "PARTIAL";
        limitationReason = "technical_error";
        errorCode = "SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL";
        snapshot = next;
        break;
      }
      counters.reportedTotalRows = next.traversal.reportedTotalRows ?? counters.reportedTotalRows;
      counters.accessibleRows = next.traversal.accessibleRows;
      counters.unavailableRows = next.traversal.unavailableRows;
      snapshot = next;
      pageNumber = next.traversal.pageNumber ?? pageNumber + 1;
      continue;
    }
    snapshot = next;
    pageNumber = snapshot.traversal?.pageNumber ?? pageNumber + 1;
  }
  if (finalStatus === null) {
    finalStatus = "PARTIAL";
    limitationReason = "budget_stop";
  }
  return {
    status: snapshot.gate && windows.length === 0 ? "human_required"
      : limitationReason === "source_limit_declared" ? "limited" : "captured",
    sourceUrl: input.page.url(),
    snapshot,
    capture: captured,
    windows,
    traversal: {
      finalStatus,
      limitationReason,
      errorCode,
      counters,
      diagnostics,
      cursor,
      captureGeneration,
      snapshotFingerprint: firstSnapshotFingerprint,
    },
    errorCode,
  };
}

type SellerSpriteVisibleWindowEvidence = {
  readonly capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null;
  readonly attachmentId: string;
  readonly rawArtifactId: string;
  readonly rowKeys: readonly string[];
};

type PersistedSellerSpriteWindow = {
  attachment: SourceEvidenceAttachment;
  evidence: V3ModuleEvidence;
  rawArtifact: SourceRawArtifact;
};

async function indexPersistedSellerSpriteWindows(input: {
  context: AccessContext;
  subjectKey: string;
  module: SellerSpriteKeywordPage;
  captureJobFingerprint: string;
  sourceQueryFingerprint: string;
}): Promise<{
  windows: Map<string, PersistedSellerSpriteWindow>;
  rowContentHashes: Map<string, string>;
  conflictingRowKeys: Set<string>;
}> {
  const { evidenceStore } = await readV3ModuleEvidence({
    context: input.context,
    subjectKey: input.subjectKey,
    module: input.module,
  });
  const result = new Map<string, PersistedSellerSpriteWindow>();
  const rowContentHashes = new Map<string, string>();
  const conflictingRowKeys = new Set<string>();
  for (const attachment of evidenceStore?.attachments ?? []) {
    const evidence = parseV3ModuleEvidence(attachment.payload);
    if (!evidence || evidence.subjectKey !== input.subjectKey || evidence.module !== input.module
      || evidence.metricNature !== "provider_estimate") continue;
    const data = evidence.data;
    const queryIdentity = data.queryIdentity;
    if (!queryIdentity || typeof queryIdentity !== "object" || Array.isArray(queryIdentity)
      || (queryIdentity as Record<string, unknown>).captureJobFingerprint !== input.captureJobFingerprint
      || (queryIdentity as Record<string, unknown>).queryFingerprint !== input.sourceQueryFingerprint) continue;
    const captureWindow = data.captureWindow;
    if (!captureWindow || typeof captureWindow !== "object" || Array.isArray(captureWindow)) continue;
    const window = captureWindow as Record<string, unknown>;
    if (typeof window.captureWindowKey !== "string" || !/^[a-f0-9]{64}$/u.test(window.captureWindowKey)
      || !Number.isSafeInteger(window.captureGeneration) || Number(window.captureGeneration) < 1
      || !/^[a-f0-9]{64}$/u.test(String(window.snapshotFingerprint ?? ""))) continue;
    const rawEvidence = attachment.payload as unknown as V3ModuleEvidence;
    const rawBytes = new TextEncoder().encode(`${JSON.stringify({
      schemaVersion: rawEvidence.schemaVersion,
      acquisitionMode: rawEvidence.acquisitionMode,
      evidence: rawEvidence,
    }, null, 2)}\n`);
    const expectedRawHash = sha256OfRawArtifact(rawBytes);
    const rawArtifact = evidenceStore?.rawArtifacts?.find((item) => item.subjectKey === input.subjectKey
      && item.sha256 === expectedRawHash && item.capturedAt === evidence.capturedAt
      && item.sourceType === "sellersprite_plugin");
    if (!rawArtifact) continue;
    const bindings = data.rowEvidenceBindings;
    if (Array.isArray(bindings)) {
      for (const candidate of bindings) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const binding = candidate as Record<string, unknown>;
        if (typeof binding.rowKey !== "string" || !binding.rowKey.trim()
          || typeof binding.rowContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.rowContentHash)) continue;
        const scopedRowKey = `generation:${window.captureGeneration}:${binding.rowKey}`;
        const existing = rowContentHashes.get(scopedRowKey);
        if (existing !== undefined && existing !== binding.rowContentHash) conflictingRowKeys.add(scopedRowKey);
        else rowContentHashes.set(scopedRowKey, binding.rowContentHash);
      }
    }
    result.set(window.captureWindowKey, { attachment, evidence, rawArtifact });
  }
  return { windows: result, rowContentHashes, conflictingRowKeys };
}

export function assertSellerSpriteSubjectIdentity(input: {
  module: SellerSpriteQueryInput["module"];
  subjectKey: string;
  identity: Record<string, unknown>;
  queryInput: SellerSpriteQueryInput;
}): void {
  if (input.module === "sellersprite_product_market") {
    const query = input.queryInput;
    if (query.module !== "sellersprite_product_market"
      || input.subjectKey !== sellerSpriteProductMarketQuerySubjectKey(query)
      || typeof input.identity.category !== "string"
      || input.identity.category.normalize("NFC").trim().toLocaleLowerCase()
        !== query.category.normalize("NFC").trim().toLocaleLowerCase()) {
      throw new Error("SELLERSPRITE_PRODUCT_MARKET_QUERY_IDENTITY_MISMATCH");
    }
    return;
  }
  /**
   * Keyword Mining 的 Evidence 主体是 seedKeyword 查询本身，因此允许
   * `sellersprite:US:keyword-mining:<queryFingerprint>` 查询主体键；
   * 该主体不产生商品版本，也不得投影为任何 ASIN 的商品事实。
   * 商品主体（`amazon:US:<ASIN>`）路径保持原合同不变。
   */
  if (input.module === "keyword_mining_trend") {
    const query = input.queryInput;
    if (query.module !== "keyword_mining_trend") throw new Error("SELLERSPRITE_KEYWORD_IDENTITY_MISMATCH");
    if (typeof input.identity.keyword !== "string"
      || input.identity.keyword.normalize("NFC").trim().toLocaleLowerCase()
        !== query.seedKeyword.normalize("NFC").trim().toLocaleLowerCase()) {
      throw new Error("SELLERSPRITE_KEYWORD_IDENTITY_MISMATCH");
    }
    if (isSellerSpriteQuerySubjectKey(input.subjectKey)) {
      if (input.subjectKey !== sellerSpriteKeywordMiningQuerySubjectKey(query)) {
        throw new Error("SELLERSPRITE_KEYWORD_QUERY_SUBJECT_MISMATCH");
      }
      return;
    }
  }
  if (!/^amazon:US:[A-Z0-9]{10}$/u.test(input.subjectKey)) throw new Error("SELLERSPRITE_SUBJECT_ASIN_REQUIRED");
  if (input.module === "reverse_asin") {
    const query = input.queryInput;
    if (query.module !== "reverse_asin") throw new Error("SELLERSPRITE_REVERSE_ASIN_SUBJECT_MISMATCH");
    const targetAsin = query.targetAsin.toUpperCase();
    if (input.identity.asin !== targetAsin || input.subjectKey !== `amazon:US:${targetAsin}`) {
      throw new Error("SELLERSPRITE_REVERSE_ASIN_SUBJECT_MISMATCH");
    }
    return;
  }
}

async function captureSellerSpriteRowWindowEvidence(input: {
  context: AccessContext;
  module: SellerSpriteKeywordPage;
  sourceUrl: string;
  subjectKey: string;
  identity: Record<string, unknown>;
  queryInput: SellerSpriteKeywordQueryInput;
  captureJobFingerprint: string;
  sourceQueryFingerprint: string;
  captureGeneration: number;
  attemptGeneration: number;
  snapshotFingerprint: string;
  cursor: SellerSpriteCaptureCursor;
  windowBudget: number;
  snapshot: SellerSpriteQuerySnapshot;
  rows: readonly SellerSpriteVisibleKeywordRow[];
  rowScope?: "traversal_checkpoint_only";
  persistedWindows: ReadonlyMap<string, PersistedSellerSpriteWindow>;
}): Promise<SellerSpriteVisibleWindowEvidence> {
  assertSellerSpriteSubjectIdentity(input);
  const tableRows = new Map<number, Map<number, readonly (string | null)[]>>();
  for (const row of input.rows) {
    const group = tableRows.get(row.tableIndex) ?? new Map<number, readonly (string | null)[]>();
    group.set(row.rowIndex, row.rawCells);
    tableRows.set(row.tableIndex, group);
  }
  const resultTables = SELLERSPRITE_QUERY_ADAPTERS[input.module].resultTables(input.snapshot);
  const visibleTables = [...tableRows.entries()].sort(([left], [right]) => left - right).map(([tableIndex, rows]) => ({
    headers: [...resultTables[tableIndex].headers],
    rows: [...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => [...row]),
  }));
  const rowEvidenceBindings = input.rows.map((row) => ({
    rowKey: row.rowKey,
    rowContentHash: contentHash({ headers: row.headers, row: row.rawCells }),
    keyword: row.typedRow.keyword,
    status: row.typedRow.status,
    sourceRowIndex: row.rowIndex,
    sourceTableIndex: row.tableIndex,
  }));
  const checkpointTraversalState = input.rowScope === "traversal_checkpoint_only"
    ? {
      pageNumber: input.snapshot.traversal?.pageNumber ?? null,
      pageCount: input.snapshot.traversal?.pageCount ?? null,
      scrollY: input.snapshot.traversal?.scrollY ?? input.cursor.scrollY,
      scrollTarget: input.snapshot.traversal?.scrollTarget ?? input.cursor.scrollTarget ?? "document",
      clientHeight: input.snapshot.traversal?.clientHeight ?? null,
      scrollHeight: input.snapshot.traversal?.scrollHeight ?? null,
      hasNextPage: input.snapshot.traversal?.hasNextPage ?? null,
      nextPageDisabled: input.snapshot.traversal?.nextPageDisabled ?? null,
      sourceLimitDeclared: input.snapshot.traversal?.sourceLimitDeclared ?? false,
      reportedTotalRows: input.snapshot.traversal?.reportedTotalRows ?? null,
      accessibleRows: input.snapshot.traversal?.accessibleRows ?? null,
      unavailableRows: input.snapshot.traversal?.unavailableRows ?? null,
    }
    : null;
  const captureWindowKey = contentHash({
    captureJobFingerprint: input.captureJobFingerprint,
    captureGeneration: input.captureGeneration,
    page: input.cursor.page,
    scrollY: input.cursor.scrollY,
    scrollTarget: input.cursor.scrollTarget ?? "document",
    rowEvidenceBindings,
    ...(checkpointTraversalState ? {
      rowScope: "traversal_checkpoint_only",
      traversalState: checkpointTraversalState,
    } : {}),
  });
  const sourceFingerprint = `${input.captureJobFingerprint}:g${input.captureGeneration}:window:${captureWindowKey}`;
  const previous = input.persistedWindows.get(captureWindowKey);
  if (previous && previous.attachment.sourceFingerprint === sourceFingerprint
    && previous.evidence.subjectKey === input.subjectKey && previous.evidence.module === input.module
    && previous.evidence.metricNature === "provider_estimate") {
    const previousData = previous.evidence.data;
    const previousWindow = previousData.captureWindow;
    const previousIdentity = previousData.queryIdentity;
    const previousBindings = previousData.rowEvidenceBindings;
    const previousSnapshot = previousData.visibleSnapshot;
    const snapshotTables = previousSnapshot && typeof previousSnapshot === "object" && !Array.isArray(previousSnapshot)
      ? (previousSnapshot as Record<string, unknown>).tables
      : null;
    const parsedRows = Array.isArray(snapshotTables)
      ? identifySellerSpriteVisibleKeywordRows(input.module, snapshotTables as Array<{ headers: string[]; rows: Array<(string | null)[]> }>).rows
      : [];
    const previousRowHashes = new Map(parsedRows.map((row) => [row.rowKey, contentHash({ headers: row.headers, row: row.rawCells })]));
    const exactRows = Array.isArray(previousBindings) && JSON.stringify(previousBindings) === JSON.stringify(rowEvidenceBindings)
      && rowEvidenceBindings.every((binding) => previousRowHashes.get(binding.rowKey) === binding.rowContentHash);
    const exactWindow = previousWindow && typeof previousWindow === "object" && !Array.isArray(previousWindow)
      && (previousWindow as Record<string, unknown>).captureWindowKey === captureWindowKey
      && (previousWindow as Record<string, unknown>).snapshotFingerprint === input.snapshotFingerprint
      && (previousWindow as Record<string, unknown>).captureGeneration === input.captureGeneration;
    const exactQuery = previousIdentity && typeof previousIdentity === "object" && !Array.isArray(previousIdentity)
      && (previousIdentity as Record<string, unknown>).captureJobFingerprint === input.captureJobFingerprint
      && (previousIdentity as Record<string, unknown>).queryFingerprint === input.sourceQueryFingerprint;
    if (exactRows && exactWindow && exactQuery) {
      return {
        capture: null,
        attachmentId: previous.attachment.attachmentId,
        rawArtifactId: previous.rawArtifact.artifactId,
        rowKeys: input.rows.filter((row) => row.typedRow.status === "valid").map((row) => row.rowKey),
      };
    }
  }
  const capturedAt = new Date().toISOString();
  let sourceIdentity: { asin: string } | { keyword: string };
  let queryValue: string;
  if (input.module === "reverse_asin" && input.queryInput.module === "reverse_asin") {
    queryValue = input.queryInput.targetAsin.toUpperCase();
    sourceIdentity = { asin: queryValue };
  } else if (input.module === "keyword_mining_trend" && input.queryInput.module === "keyword_mining_trend") {
    queryValue = input.queryInput.seedKeyword.normalize("NFC").trim();
    sourceIdentity = { keyword: queryValue };
  } else {
    throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
  }
  const envelope = {
    schemaVersion: "capture-system-v3-browser-visible-envelope.v1",
    module: input.module,
    subjectKey: input.subjectKey,
    marketplace: "US",
    capturedAt,
    provider: SELLERSPRITE_PROVIDER_NAME,
    sourceSurface: `SellerSprite ${input.module} visible query window`,
    sourceUrl: input.sourceUrl,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_estimate",
    status: "AVAILABLE_WITH_LIMITATION",
    limitations: ["visible_dom_window_only", "visible_rows_are_not_total_rows"],
    identity: sourceIdentity,
    data: {
      capturedFromVisibleDom: true,
      exportAttempted: false,
      hiddenApiCalled: false,
      pageTitle: input.snapshot.pageTitle,
      queryInput: input.queryInput,
      queryIdentity: {
        subjectKey: input.subjectKey,
        marketplace: "US",
        module: input.module,
        query: queryValue,
        queryFingerprint: input.sourceQueryFingerprint,
        captureJobFingerprint: input.captureJobFingerprint,
      },
      captureWindow: {
        captureGeneration: input.captureGeneration,
        attemptGeneration: input.attemptGeneration,
        windowBudget: input.windowBudget,
        snapshotFingerprint: input.snapshotFingerprint,
        captureWindowKey,
        page: input.cursor.page,
        scrollY: input.cursor.scrollY,
        scrollTarget: input.cursor.scrollTarget ?? "document",
        clientHeight: input.snapshot.traversal?.clientHeight ?? null,
        scrollHeight: input.snapshot.traversal?.scrollHeight ?? null,
        hasNextPage: input.snapshot.traversal?.hasNextPage ?? null,
        nextPageDisabled: input.snapshot.traversal?.nextPageDisabled ?? null,
        pageReportedTotalRows: input.snapshot.traversal?.reportedTotalRows ?? null,
        accessibleRows: input.snapshot.traversal?.accessibleRows ?? null,
        unavailableRows: input.snapshot.traversal?.unavailableRows ?? null,
        sourceLimitDeclared: input.snapshot.traversal?.sourceLimitDeclared ?? false,
      },
      rowEvidenceBindings,
      visibleSnapshot: { ...input.snapshot, tables: visibleTables },
      amazonConfirmed: false,
      rowScope: input.rowScope ?? "visible_dom_window_not_total",
      snapshotRowLimit: 250,
      accountAccess: "not_verified",
    },
    providerUpdatedAt: null,
    freshnessMetricKey: null,
    evidenceOnly: true,
  } as const;
  const capture = await captureBrowserVisibleV3Envelope({
    context: input.context,
    envelope,
    sourceType: "sellersprite_plugin",
    sourceFingerprint,
  });

  const storedAttachment = capture.evidenceStore.attachments?.find((item) =>
    item.attachmentId === capture.attachment.attachmentId && item.contentHash === capture.attachment.contentHash,
  );
  const storedArtifact = capture.evidenceStore.rawArtifacts?.find((item) =>
    item.artifactId === capture.rawArtifact.artifact.artifactId && item.sha256 === capture.rawArtifact.artifact.sha256,
  );
  const storedPayload = storedAttachment?.payload;
  const storedEvidence = storedPayload && typeof storedPayload === "object" && !Array.isArray(storedPayload)
    ? storedPayload as Record<string, unknown>
    : null;
  const storedData = storedEvidence?.data && typeof storedEvidence.data === "object" && !Array.isArray(storedEvidence.data)
    ? storedEvidence.data as Record<string, unknown>
    : null;
  const storedCaptureWindow = storedData?.captureWindow;
  const storedBindings = storedData?.rowEvidenceBindings;
  if (capture.moduleEvidence.subjectKey !== input.subjectKey || capture.moduleEvidence.module !== input.module
    || capture.moduleEvidence.metricNature !== "provider_estimate"
    || capture.downstream.subjectKey !== input.subjectKey
    || capture.downstream.attachmentId !== capture.attachment.attachmentId
    || capture.downstream.rawArtifactId !== capture.rawArtifact.artifact.artifactId
    || !storedAttachment || !storedArtifact
    || !storedEvidence || storedEvidence.subjectKey !== input.subjectKey || storedEvidence.module !== input.module
    || storedEvidence.metricNature !== "provider_estimate"
    || JSON.stringify(storedEvidence.identity) !== JSON.stringify(capture.moduleEvidence.identity)
    || typeof storedCaptureWindow !== "object" || storedCaptureWindow === null
    || (storedCaptureWindow as Record<string, unknown>).captureWindowKey !== captureWindowKey
    || !Array.isArray(storedBindings) || storedBindings.length !== rowEvidenceBindings.length
    || JSON.stringify(storedBindings) !== JSON.stringify(rowEvidenceBindings)) {
    throw new Error("SELLERSPRITE_ROW_EVIDENCE_READBACK_MISMATCH");
  }
  const storedSnapshot = storedData?.visibleSnapshot;
  const readBackRows = identifySellerSpriteVisibleKeywordRows(input.module,
    storedSnapshot && typeof storedSnapshot === "object" && !Array.isArray(storedSnapshot)
      && Array.isArray((storedSnapshot as Record<string, unknown>).tables)
      ? (storedSnapshot as { tables: Array<{ headers: string[]; rows: Array<(string | null)[]> }> }).tables
      : [],
  ).rows;
  const readBackBindingHashes = new Map(readBackRows.map((row) => [row.rowKey, contentHash({ headers: row.headers, row: row.rawCells })]));
  if (rowEvidenceBindings.some((binding) => readBackBindingHashes.get(binding.rowKey) !== binding.rowContentHash)) {
    throw new Error("SELLERSPRITE_ROW_EVIDENCE_BINDING_INVALID");
  }
  return {
    capture,
    attachmentId: capture.attachment.attachmentId,
    rawArtifactId: capture.rawArtifact.artifact.artifactId,
    rowKeys: input.rows.filter((row) => row.typedRow.status === "valid").map((row) => row.rowKey),
  };
}

export async function captureSellerSpriteVisibleQuery(input: {
  context: AccessContext;
  module: SellerSpriteQueryInput["module"];
  sourceUrl: string;
  subjectKey: string;
  identity: Record<string, unknown>;
  queryInput: SellerSpriteQueryInput;
  attemptGeneration?: number;
  accountAccessFingerprint?: string;
  captureJobFingerprint?: string;
  resumeCursor?: SellerSpriteCaptureCursor | null;
  maxWindows?: number;
  onSnapshot?: (snapshot: SellerSpriteVisibleCaptureSnapshotInput) => Promise<SellerSpriteVisibleCaptureJobBinding | null>;
  onWindowCheckpoint?: (checkpoint: SellerSpriteVisibleCaptureWindowCheckpoint) => Promise<boolean>;
  /** BCR pause/cancel is checked before navigation, input and Evidence persistence. */
  shouldStop?: () => Promise<boolean>;
  now?: Date;
}): Promise<SellerSpriteVisibleQueryResult> {
  const sourceUrl = input.sourceUrl.trim();
  const queryInput = validateSellerSpriteQueryInput(input.queryInput, input.module);
  const adapter = SELLERSPRITE_QUERY_ADAPTERS[input.module];
  if (!isSellerSpriteQueryPageUrl(sourceUrl, input.module)) {
    return { status: "failed", module: input.module, sourceUrl, snapshot: null, capture: null, errorCode: "SELLERSPRITE_PAGE_TYPE_MISMATCH" };
  }
  try {
    assertSellerSpriteSubjectIdentity({ module: input.module, subjectKey: input.subjectKey, identity: input.identity, queryInput });
  } catch (error) {
    return { status: "failed", module: input.module, sourceUrl, snapshot: null, capture: null, errorCode: error instanceof Error ? error.message : "SELLERSPRITE_SUBJECT_IDENTITY_INVALID" };
  }
  if (await input.shouldStop?.()) {
    return { status: "failed", module: input.module, sourceUrl, snapshot: null, capture: null, errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" };
  }
  let browser: ConnectedBrowser | null = null;
  let page: TaskPage | null = null;
  try {
    const playwright = await loadPlaywright<PlaywrightModule>();
    if (!playwright) return { status: "unavailable", module: input.module, sourceUrl, snapshot: null, capture: null, errorCode: "PLAYWRIGHT_RUNTIME_MISSING" };
    browser = await playwright.chromium.connectOverCDP(cdpEndpoint(), { timeout: 5_000 });
    /**
     * D2-1F：在创建页面/导航之前，先在**本次连接对象**上校验浏览器身份——
     * 9222 上可能是其他 Chrome（非本工作台专用 Profile）；误连接会把采集引到错误浏览器。
     * 在同一连接对象上读取启动参数（无 TOCTOU 缝隙）；读不到 / Profile 不匹配一律拒绝：
     * 不创建页面、不导航、不采集，也绝不关闭对方浏览器。
     */
    const browserIdentity = await verifyConnectedBrowserIdentity(browser);
    if (browserIdentity !== "managed") {
      return {
        status: "unavailable",
        module: input.module,
        sourceUrl,
        snapshot: null,
        capture: null,
        errorCode: browserIdentity === "foreign"
          ? "SELLERSPRITE_BROWSER_IDENTITY_MISMATCH"
          : "SELLERSPRITE_BROWSER_IDENTITY_UNVERIFIED",
      };
    }
    const browserContext = browser.contexts()[0];
    if (!browserContext) throw new Error("SELLERSPRITE_CDP_CONTEXT_MISSING");
    page = await browserContext.newPage();
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    if (await input.shouldStop?.()) return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" };
    if (!isSellerSpriteQueryPageUrl(page.url(), input.module)) return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: "SELLERSPRITE_PAGE_TYPE_MISMATCH" };
    let before = await readQuerySnapshot(page);
    if (before.gate) return { status: "human_required", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: `SELLERSPRITE_${before.gate.toUpperCase()}_REQUIRED` };
    // 查询输入必须在**可见**控件中唯一：真实页面 DOM 里常有隐藏的同名输入
    // （例如隐藏页签里的「请搜索关键词词库」），仅按 DOM 计数会误判为不唯一。
    const field = page.locator(adapter.inputSelector);
    let visibleFieldIndexes: number[] = [];
    // domcontentloaded precedes the async source form. Wait only for a missing field;
    // multiple visible matches remain ambiguous and never choose a positional fallback.
    for(let attempt=0;attempt<9;attempt++){
      const fieldCount=await field.count();visibleFieldIndexes=[];
      for(let index=0;index<fieldCount;index++)if(await field.nth(index).isVisible())visibleFieldIndexes.push(index);
      if(visibleFieldIndexes.length>0||attempt===8)break;
      if(await input.shouldStop?.())return {status:"failed",module:input.module,sourceUrl:page.url(),snapshot:null,capture:null,errorCode:"SELLERSPRITE_CAPTURE_JOB_STOPPED"};
      await page.waitForTimeout(500);before=await readQuerySnapshot(page);
      if(before.gate)return {status:"human_required",module:input.module,sourceUrl:page.url(),snapshot:null,capture:null,errorCode:`SELLERSPRITE_${before.gate.toUpperCase()}_REQUIRED`};
    }
    if (visibleFieldIndexes.length !== 1) {
      return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot: before, capture: null, errorCode: visibleFieldIndexes.length ? "SELLERSPRITE_QUERY_INPUT_NOT_UNIQUE":"SELLERSPRITE_QUERY_INPUT_MISSING", inputDiagnostics:{visibleMatches:visibleFieldIndexes.length,pageTitle:before.pageTitle,visibleControlLabels:(before.visibleControls??[]).map(c=>c.label).slice(0,20),loading:before.loading,marketplaceEcho:before.marketplaceEcho} };
    }
    const inputField = field.nth(visibleFieldIndexes[0]);
    const expected = adapter.identityInput(queryInput);
    await applyVisibleConditions(page, queryInput);
    await inputField.fill(expected);
    await inputField.press("Enter");
    // 等待基准用可注入时钟（input.now），保证确定性测试不必等待真实超时。
    const deadline = (input.now ?? new Date()).getTime() + QUERY_TIMEOUT_MS;
    let snapshot = await readQuerySnapshot(page);
    const conditions = queryInput.module === "sellersprite_product_market" ? queryInput.filters
      : queryInput.module === "keyword_mining_trend" ? queryInput.conditions : undefined;
    // 套餐限制提示不是查询结束信号：加载过程中可能先渲染限制横幅、再渲染结果表。
    // 只有「loading 已结束仍声明限制」才退出等待；整页问题（gate/queryError/空结果）保持原判定。
    while (Date.now() < deadline && (!adapter.hasCompletionSignal(snapshot, expected, conditions)
      || !hasPageSpecificResultChanged(before, snapshot, input.module))
      && !snapshot.gate
      && !(snapshot.traversal?.sourceLimitDeclared === true && !snapshot.loading)
      && !newEmptyResult(before, snapshot) && !newQueryError(before, snapshot)) {
      await page.waitForTimeout(500);
      snapshot = await readQuerySnapshot(page);
    }
    if (await input.shouldStop?.()) return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" };
    if (snapshot.traversal?.sourceLimitDeclared && !snapshot.gate && !snapshot.queryError
      && queryInput.module !== "sellersprite_product_market") {
      // loading 未结束（含等待超时仍在加载）的页面不能作为身份确认依据。
      const identityConfirmed = !snapshot.loading && adapter.hasQueryIdentity(snapshot, expected, conditions);
      if (identityConfirmed && adapter.hasResult(snapshot)) {
        // 查询完成、站点与 ASIN 回显成立、可见表格身份成立：先通过现有解析器
        // 保存当前合法可见行，再由遍历决策停止超出权限的继续访问。
        const attemptGeneration = input.attemptGeneration ?? 1;
        const captureJobFingerprint = input.captureJobFingerprint
          ?? contentHash({ module: input.module, subjectKey: input.subjectKey, queryInput, accountAccessFingerprint: input.accountAccessFingerprint ?? "not_verified" });
        const depth = await captureSellerSpriteVisibleQueryWindows({
          context: input.context,
          page,
          module: queryInput.module,
          subjectKey: input.subjectKey,
          identity: input.identity,
          queryInput,
          snapshot,
          sourceLimitSnapshotConfirmed: true,
          expected,
          conditions,
          attemptGeneration,
          captureJobFingerprint,
          accountAccessFingerprint: input.accountAccessFingerprint ?? "not_verified",
          resumeCursor: input.resumeCursor ?? null,
          maxWindows: Number.isSafeInteger(input.maxWindows) ? Math.max(1, Math.min(20, input.maxWindows as number)) : 8,
          onSnapshot: input.onSnapshot,
          onWindowCheckpoint: input.onWindowCheckpoint,
          shouldStop: input.shouldStop,
        });
        return { module: input.module, ...depth };
      }
      if (identityConfirmed) {
        // 查询完成、身份确认，但当前可见范围为空（来源只声明了限制）：
        // 如实记录来源限制结论，不绑定快照、不写行证据；任务状态由 route 失败收尾合并，
        // 已有断点与计数保持不变。
        return {
          status: "limited", module: input.module, sourceUrl: page.url(), snapshot, capture: null,
          errorCode: "SELLERSPRITE_SOURCE_LIMIT_WITHOUT_VISIBLE_ROWS",
        };
      }
      // 身份未确认（loading 结束但回显/站点不成立）：技术失败，不冒充套餐限制。
      return {
        status: "failed", module: input.module, sourceUrl: page.url(), snapshot, capture: null,
        errorCode: "SELLERSPRITE_QUERY_IDENTITY_UNCONFIRMED_AT_SOURCE_LIMIT",
      };
    }
    if (snapshot.gate) return { status: "human_required", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: `SELLERSPRITE_${snapshot.gate.toUpperCase()}_REQUIRED` };
    if (newEmptyResult(before, snapshot)) return { status: "empty", module: input.module, sourceUrl: page.url(), snapshot, capture: null, errorCode: "SELLERSPRITE_QUERY_EMPTY" };
    if (newQueryError(before, snapshot)) return { status: "query_error", module: input.module, sourceUrl: page.url(), snapshot, capture: null, errorCode: "SELLERSPRITE_QUERY_ERROR_VISIBLE" };
    if (!adapter.hasCompletionSignal(snapshot, expected, conditions)
      || !hasPageSpecificResultChanged(before, snapshot, input.module)) return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot, capture: null, errorCode: "SELLERSPRITE_QUERY_COMPLETION_UNCONFIRMED" };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 180 * 1024) return { status: "failed", module: input.module, sourceUrl: page.url(), snapshot: null, capture: null, errorCode: "SELLERSPRITE_VISIBLE_SNAPSHOT_TOO_LARGE" };
    if (queryInput.module !== "sellersprite_product_market") {
      const attemptGeneration = input.attemptGeneration ?? 1;
      const captureJobFingerprint = input.captureJobFingerprint
        ?? contentHash({ module: input.module, subjectKey: input.subjectKey, queryInput, accountAccessFingerprint: input.accountAccessFingerprint ?? "not_verified" });
      const depth = await captureSellerSpriteVisibleQueryWindows({
        context: input.context,
        page,
        module: queryInput.module,
        subjectKey: input.subjectKey,
        identity: input.identity,
        queryInput,
        snapshot,
        sourceLimitSnapshotConfirmed: false,
        expected,
        conditions,
        attemptGeneration,
        captureJobFingerprint,
        accountAccessFingerprint: input.accountAccessFingerprint ?? "not_verified",
        resumeCursor: input.resumeCursor ?? null,
        maxWindows: Number.isSafeInteger(input.maxWindows) ? Math.max(1, Math.min(20, input.maxWindows as number)) : 8,
        onSnapshot: input.onSnapshot,
        onWindowCheckpoint: input.onWindowCheckpoint,
        shouldStop: input.shouldStop,
      });
      return { module: input.module, ...depth };
    }
    const capturedAt = (input.now ?? new Date()).toISOString();
    const envelope = {
      schemaVersion: "capture-system-v3-browser-visible-envelope.v1",
      module: input.module,
      subjectKey: input.subjectKey,
      marketplace: "US",
      capturedAt,
      provider: SELLERSPRITE_PROVIDER_NAME,
      sourceSurface: `SellerSprite ${input.module} visible query`,
      sourceUrl: page.url(),
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_estimate",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["single_query_visible_snapshot_only", "visible_rows_are_not_total_rows", "field_semantics_not_yet_validated"],
      identity: { ...input.identity, queryInput, marketplace: "US", accountAccessSnapshot: "not_verified", queryFingerprint: sellerSpriteQueryFingerprint(queryInput, input.accountAccessFingerprint ?? "not_verified") },
      data: {
        capturedFromVisibleDom: true,
        exportAttempted: false,
        hiddenApiCalled: false,
        pageTitle: await page.title(),
        queryContract: {
          module: queryInput.module,
          marketplace: "US",
          queryInput,
          queryFingerprint: sellerSpriteQueryFingerprint(queryInput, input.accountAccessFingerprint ?? "not_verified"),
        },
        visibleSnapshot: { ...snapshot, queryInputs: [expected] },
        amazonConfirmed: false,
        rowScope: "visible_dom_snapshot_not_total",
        snapshotRowLimit: 250,
        accountAccess: "not_verified",
      },
      providerUpdatedAt: null,
      freshnessMetricKey: null,
      evidenceOnly: true,
    } as const;
    const attemptGeneration = input.attemptGeneration ?? 1;
    if (!Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) throw new Error("SELLERSPRITE_ATTEMPT_GENERATION_INVALID");
    const capture = await captureBrowserVisibleV3Envelope({
      context: input.context,
      envelope: { ...envelope, identity: { ...envelope.identity, attemptGeneration } },
      sourceType: "sellersprite_plugin",
      sourceFingerprint: `${sellerSpriteQueryFingerprint(queryInput, input.accountAccessFingerprint ?? "not_verified")}:attempt:${attemptGeneration}`,
    });
    return { status: "captured", module: input.module, sourceUrl: page.url(), snapshot, capture, errorCode: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "SELLERSPRITE_VISIBLE_QUERY_FAILED";
    const unavailable = /ECONNREFUSED|connectovercdp|timeout/iu.test(message);
    return { status: unavailable ? "unavailable" : "failed", module: input.module, sourceUrl, snapshot: null, capture: null, errorCode: unavailable ? "SELLERSPRITE_CDP_UNAVAILABLE" : "SELLERSPRITE_VISIBLE_QUERY_FAILED" };
  } finally {
    await releaseSellerSpriteBrowserSession({ ownership: SELLERSPRITE_CDP_OWNERSHIP, page, browser });
  }
}

export function hasPageSpecificResultChanged(
  before: SellerSpriteQuerySnapshot,
  after: SellerSpriteQuerySnapshot,
  module: SellerSpriteQueryInput["module"],
): boolean {
  const adapter = SELLERSPRITE_QUERY_ADAPTERS[module];
  return JSON.stringify(adapter.resultTables(before)) !== JSON.stringify(adapter.resultTables(after));
}

export function hasVisiblePageTransitionResult(input: {
  previous: SellerSpriteQuerySnapshot;
  snapshot: SellerSpriteQuerySnapshot;
  module: SellerSpriteQueryInput["module"];
  nextPage: number;
}): boolean {
  const pageNumber = input.snapshot.traversal?.pageNumber;
  if (pageNumber !== null && pageNumber !== input.nextPage) return false;
  return hasPageSpecificResultChanged(input.previous, input.snapshot, input.module);
}

function newEmptyResult(before: SellerSpriteQuerySnapshot, after: SellerSpriteQuerySnapshot): boolean {
  // 加载中不得判定「空结果」：查询在途时页面会短暂显示「搜索结果数: 0」。
  if (after.loading) return false;
  // 已有对齐的结果表（表头 + 数据行）时也绝不是空结果。
  if (after.tables.some((table) => table.headers.length > 0 && table.rows.some((row) => row.some((cell) => (cell ?? "").trim() !== "")))) {
    return false;
  }
  return after.empty && (!before.empty || before.bodyText !== after.bodyText);
}

function newQueryError(before: SellerSpriteQuerySnapshot, after: SellerSpriteQuerySnapshot): boolean {
  return after.queryError && (!before.queryError || before.bodyText !== after.bodyText);
}

function stableQueryIdentity(value: { module: string; marketplace: string; queryInput: SellerSpriteQueryInput; accountAccessSnapshot: string }): string {
  const sortRecord = (record: Record<string, unknown> | undefined) => Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const queryInput = value.queryInput.module === "sellersprite_product_market"
    ? { module: value.queryInput.module, category: value.queryInput.category, filters: sortRecord(value.queryInput.filters) }
    : value.queryInput.module === "reverse_asin"
      ? { module: value.queryInput.module, targetAsin: value.queryInput.targetAsin }
      : { module: value.queryInput.module, seedKeyword: value.queryInput.seedKeyword, marketplace: value.queryInput.marketplace, conditions: sortRecord(value.queryInput.conditions) };
  return JSON.stringify({ module: value.module, marketplace: value.marketplace, queryInput, accountAccessSnapshot: value.accountAccessSnapshot });
}
