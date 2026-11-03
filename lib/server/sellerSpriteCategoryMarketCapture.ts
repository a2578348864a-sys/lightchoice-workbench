import "server-only";

import { adaptSellerSpriteCategoryMarketTable } from "@/lib/sourceLayer/sellerSpriteCategoryMarketAdapter";
import type { CategoryMarketCaptureBatch } from "@/lib/sourceLayer/categoryMarketCapture";
import {
  matchSellerSpriteCandidate,
  type SellerSpriteCandidateMatch,
} from "@/lib/sourceLayer/sellerSpriteCategoryMatch";
import { verifyConnectedBrowserIdentity } from "@/lib/server/sellerSpriteBrowserIdentity";
import { loadPlaywright } from "@/lib/server/playwrightRuntime";

const MARKET_RESEARCH_URL = "https://www.sellersprite.com/v2/market-research";
const NODES_LIST_PATH = "/v2/competitor-lookup/nodesList";
const MAX_QUERY_LENGTH = 120;

export type SellerSpriteCategoryNode = {
  id: string;
  label: string;
  products: number | null;
};

export class SellerSpriteCategoryCaptureError extends Error {
  constructor(
    public readonly code:
      | "category_query_invalid"
      | "category_selection_stale"
      | "category_match_unconfirmed"
      | "seller_sprite_session_unavailable"
      | "seller_sprite_login_required"
      | "seller_sprite_suggestions_unavailable"
      | "seller_sprite_category_not_selectable"
      | "seller_sprite_market_table_missing"
      | "seller_sprite_market_table_invalid"
      /** D2-1F：9222 上的浏览器不是本工作台专用实例（Profile 不匹配）。 */
      | "seller_sprite_browser_identity_mismatch"
      /** D2-1F：无法验证 9222 上浏览器的身份（如外部实例无自动化标记）。 */
      | "seller_sprite_browser_identity_unverified",
    message: string,
  ) {
    super(message);
    this.name = "SellerSpriteCategoryCaptureError";
  }
}

type PageLocator = {
  allTextContents(): Promise<string[]>;
  clear?(options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  first(): PageLocator;
  nth(index: number): PageLocator;
  press(key: string): Promise<void>;
  pressSequentially?(text: string, options?: { delay?: number }): Promise<void>;
  type?(text: string, options?: { delay?: number }): Promise<void>;
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
};

/** 与真实用户键入等价，保证 SPA 类目建议收到 input 事件。 */
async function typeIntoLocator(locator: PageLocator, text: string): Promise<void> {
  if (typeof locator.pressSequentially === "function") {
    await locator.pressSequentially(text, { delay: 35 });
    return;
  }
  if (typeof locator.type === "function") {
    await locator.type(text, { delay: 35 });
    return;
  }
  await locator.fill(text);
}

type MarketPage = {
  close(): Promise<void>;
  evaluate<Result, Argument>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>;
  goto(url: string, options?: { timeout?: number; waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  locator(selector: string): PageLocator;
  url(): string;
};

type BrowserContext = {
  newPage(): Promise<MarketPage>;
};

type ConnectedBrowser = {
  /** 仅 SELF_LAUNCHED 允许调用；EXTERNAL_CDP_ATTACHED 绝对禁止。 */
  close(): Promise<void>;
  contexts(): BrowserContext[];
  /** D2-1F：在**本次连接对象**上读取启动参数（身份校验）；绝不用于关闭浏览器。 */
  newBrowserCDPSession?(): Promise<{ send(method: string): Promise<unknown>; detach?(): Promise<void> }>;
};

type PlaywrightModule = {
  chromium: {
    connectOverCDP(endpoint: string, options?: { timeout?: number }): Promise<ConnectedBrowser>;
  };
};

/**
 * 浏览器所有权语义。
 * - SELF_LAUNCHED：本任务 launch 的浏览器，完成后允许 close。
 * - EXTERNAL_CDP_ATTACHED：attach 到用户/专用 Chrome（如 9222），绝对不得 close 整个 Chrome。
 */
export type SellerSpriteBrowserOwnership = "SELF_LAUNCHED" | "EXTERNAL_CDP_ATTACHED";

export const SELLERSPRITE_CDP_OWNERSHIP: SellerSpriteBrowserOwnership = "EXTERNAL_CDP_ATTACHED";

/** 是否允许关闭整个 browser（仅 SELF_LAUNCHED）。 */
export function canCloseBrowser(ownership: SellerSpriteBrowserOwnership): boolean {
  return ownership === "SELF_LAUNCHED";
}

/**
 * 释放本次任务创建的 page；external CDP 场景绝不关闭整个 browser。
 * 成功/失败/throw 路径共用，防止回归。
 */
export async function releaseSellerSpriteBrowserSession(input: {
  ownership: SellerSpriteBrowserOwnership;
  page: { close(): Promise<void> } | null;
  browser: { close(): Promise<void> } | null;
}): Promise<void> {
  if (input.page) {
    await input.page.close().catch(() => undefined);
  }
  if (input.browser && canCloseBrowser(input.ownership)) {
    await input.browser.close().catch(() => undefined);
  }
  // EXTERNAL_CDP_ATTACHED：只结束本任务的 page；browser 连接交给进程生命周期回收，
  // 绝不调用 browser.close()（Playwright 对 connectOverCDP 的 close 会关掉整个 Chrome）。
}

export async function getSellerSpriteCategoryNodes(query: string): Promise<SellerSpriteCategoryNode[]> {
  const normalizedQuery = validateQuery(query);
  return withMarketPage(async (page) => {
    const response = await readNodesList(page, normalizedQuery);
    if (response.status === 401 || response.status === 403) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_login_required", "SellerSprite 登录状态不可用，请先在已连接浏览器中登录。");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_suggestions_unavailable", "SellerSprite 类目建议暂时不可用，请稍后重试。");
    }
    const nodes = parseSellerSpriteCategoryNodes(response.body);
    if (nodes.length === 0) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_suggestions_unavailable", "没有找到匹配类目，请换一个关键词后重试。");
    }
    return nodes;
  });
}

export async function captureSellerSpriteCategoryMarketTable(input: {
  query: string;
  categoryId: string;
  /**
   * 正式类目采集的强制 Amazon 选择上下文。
   * 缺失/不完整 → category_match_unconfirmed，禁止进入真实 SellerSprite 采集。
   * 只有 shared matcher 判定可信对应才允许继续，禁止默认第一条/顺序命中。
   */
  amazonNodeId: string;
  amazonPathEn: readonly string[];
}): Promise<CategoryMarketCaptureBatch> {
  const query = validateQuery(input.query);
  const categoryId = typeof input.categoryId === "string" ? input.categoryId.trim() : "";
  if (!/^[0-9]+(?::[0-9]+)*$/u.test(categoryId) || categoryId.length > 80) {
    throw new SellerSpriteCategoryCaptureError("category_query_invalid", "所选 Amazon 类目无效，请重新搜索并选择类目。");
  }

  const amazonNodeId = typeof input.amazonNodeId === "string" ? input.amazonNodeId.trim() : "";
  const amazonPathEn = Array.isArray(input.amazonPathEn)
    ? input.amazonPathEn.map((segment) => String(segment ?? "").trim()).filter(Boolean)
    : [];
  // Service 层二次 fail-closed：即使绕过 Route 也不得缺 Amazon 上下文。
  if (!amazonNodeId || !/^[0-9]+$/u.test(amazonNodeId) || amazonPathEn.length === 0) {
    throw new SellerSpriteCategoryCaptureError("category_match_unconfirmed", "必须提供完整的 Amazon 类目上下文（amazonNodeId 与 amazonPathEn），否则禁止采集。");
  }

  return withMarketPage(async (page) => {
    const nodesResponse = await readNodesList(page, query);
    if (nodesResponse.status === 401 || nodesResponse.status === 403) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_login_required", "SellerSprite 登录状态不可用，请先在已连接浏览器中登录。");
    }
    if (nodesResponse.status < 200 || nodesResponse.status >= 300) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_suggestions_unavailable", "SellerSprite 类目建议暂时不可用，请稍后重试。");
    }
    const category = parseSellerSpriteCategoryNodes(nodesResponse.body)
      .find((node) => node.id === categoryId);
    if (!category) {
      throw new SellerSpriteCategoryCaptureError("category_selection_stale", "所选类目已失效，请重新搜索并选择类目。");
    }

    // fail-closed：必须可信匹配才能进入真实页面采集（绝不回落到 candidates[0]）。
    const match = matchSellerSpriteCandidate({
      amazon: { amazonNodeId, amazonPathEn },
      candidate: { id: category.id, label: category.label },
    });
    if (!match.trusted || match.matchType === "UNCONFIRMED" || match.conflicting) {
      throw new SellerSpriteCategoryCaptureError(
        "category_match_unconfirmed",
        match.conflicting
          ? "该 SellerSprite 节点与当前 Amazon 类目不匹配。"
          : "未找到可信的 Amazon ↔ SellerSprite 类目对应关系，已阻止采集。",
      );
    }

    // 真实页无 #departmentKeyword id；name/class/placeholder 为稳定锚点。
    const searchInput = page.locator('input[name="departmentKeyword"], input.departmentKeyword-inputs, input[placeholder*="类目关键词"]');
    try {
      const mainInput = searchInput.first();
      const uiQueries = buildUiSearchQueries(query, category);
      const suggestions = page.locator(".suggest-item");
      let selectedIndex = -1;
      let lastLabels: string[] = [];
      for (const uiQuery of uiQueries) {
        await mainInput.fill("");
        // fill() 不触发类目建议；真实页需键入产生 input 事件（与用户输入一致）。
        await typeIntoLocator(mainInput, uiQuery);
        const appeared = await suggestions.first()
          .waitFor({ state: "visible", timeout: 6_000 })
          .then(() => true)
          .catch(() => false);
        if (!appeared) continue;
        lastLabels = await suggestions.allTextContents();
        selectedIndex = findCategorySuggestionIndex(lastLabels, category);
        if (selectedIndex >= 0) break;
      }
      if (selectedIndex < 0) {
        throw new SellerSpriteCategoryCaptureError(
          "seller_sprite_category_not_selectable",
          "SellerSprite 页面未显示已选择的类目，请重新选择后采集。",
        );
      }
      await suggestions.nth(selectedIndex).click({ timeout: 5_000 });
      // 真实页提交以输入框 Enter 为准；#form-condition-search 仅为表单容器。
      await mainInput.press("Enter").catch(async () => {
        await page.locator("#form-condition-search").click({ timeout: 5_000 });
      });
    } catch (error) {
      if (error instanceof SellerSpriteCategoryCaptureError) throw error;
      console.error("[sellerSpriteCategoryMarketCapture] search step failed", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        query,
        categoryId,
      });
      throw new SellerSpriteCategoryCaptureError("seller_sprite_category_not_selectable", "SellerSprite 类目搜索未能完成，请确认登录状态和类目后重试。");
    }

    let table: { headers: string[]; rows: string[][] } | null;
    try {
      await page.locator("table").first().waitFor({ state: "visible", timeout: 15_000 });
      table = await page.evaluate(() => {
        const tables = [...document.querySelectorAll("table")];
        const target = tables.find((candidate) => {
          const headerText = [...candidate.querySelectorAll("thead th, tr:first-child th, tr:first-child td")]
            .map((cell) => (cell.textContent ?? "").trim()).join(" ");
          return headerText.includes("细分市场");
        });
        if (!target) return null;
        const headerCells = [...target.querySelectorAll("thead th")];
        const headers = (headerCells.length > 0
          ? headerCells
          : [...target.querySelectorAll("tr:first-child th, tr:first-child td")])
          .map((cell) => (cell.textContent ?? "").trim().slice(0, 160));
        const dataRows = [...target.querySelectorAll("tbody tr")];
        const rows = dataRows
          .map((row) => [...row.querySelectorAll("th, td")]
            .map((cell) => (cell.textContent ?? "").trim().slice(0, 1000)))
          // 真实页夹杂 1 列展开/占位行；仅保留与表头等宽的完整数据行
          .filter((row) => row.length === headers.length && row.some((cell) => cell.trim().length > 0))
          .slice(0, 60);
        return { headers, rows };
      }, undefined);
    } catch {
      table = null;
    }
    if (!table || table.headers.length === 0 || table.rows.length === 0) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_market_table_missing", "SellerSprite 未返回类目市场结果，请检查页面提示后重试。");
    }
    if (table.rows.length > 60 || table.rows.some((row) => row.length !== table!.headers.length)) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_market_table_invalid", "SellerSprite 返回的类目市场表格格式不完整。");
    }

    try {
      return adaptSellerSpriteCategoryMarketTable({
        query,
        category,
        headers: table.headers,
        rows: table.rows,
        sourceUrl: MARKET_RESEARCH_URL,
        capturedAt: new Date().toISOString(),
      });
    } catch {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_market_table_invalid", "SellerSprite 类目市场表格字段无法识别，请检查页面结构是否变化。");
    }
  });
}

export function parseSellerSpriteCategoryNodes(value: unknown): SellerSpriteCategoryNode[] {
  const records = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : [];
  const result: SellerSpriteCategoryNode[] = [];
  const seen = new Set<string>();
  for (const record of records.slice(0, 30)) {
    if (!isRecord(record)) continue;
    const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id).trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!/^[0-9]+(?::[0-9]+)*$/u.test(id) || id.length > 80 || !label || label.length > 240 || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label, products: parseProductCount(record.products) });
  }
  return result;
}

function validateQuery(query: string): string {
  const normalized = typeof query === "string" ? query.trim() : "";
  if (!normalized || normalized.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new SellerSpriteCategoryCaptureError("category_query_invalid", "请输入 1 到 120 个字符的 Amazon 类目关键词。");
  }
  return normalized;
}

async function readNodesList(page: MarketPage, query: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (searchQuery) => {
    const url = new URL("/v2/competitor-lookup/nodesList", location.origin);
    url.searchParams.set("marketId", "1");
    url.searchParams.set("table", "bsr_sales_nearly");
    url.searchParams.set("nodeLabelPath", searchQuery);
    const response = await fetch(url.toString(), { credentials: "include" });
    const text = await response.text();
    if (text.length > 300_000) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  }, query);
}

async function withMarketPage<Result>(action: (page: MarketPage) => Promise<Result>): Promise<Result> {
  const playwright = await loadPlaywright<PlaywrightModule>();
  if (!playwright) {
    throw new SellerSpriteCategoryCaptureError("seller_sprite_session_unavailable", "当前环境缺少浏览器采集运行时，无法连接 SellerSprite 登录会话。");
  }
  let browser: ConnectedBrowser | null = null;
  let page: MarketPage | null = null;
  try {
    browser = await playwright.chromium.connectOverCDP(sellerSpriteCdpEndpoint(), { timeout: 5_000 });
    /**
     * D2-1F：在创建页面/导航之前，先在**本次连接对象**上校验浏览器身份——
     * 9222 上可能是其他 Chrome（非本工作台专用 Profile）；误连接会把采集引到错误浏览器。
     * 在同一连接对象上读取启动参数（不存在「先探测 A、后连接到 B」的 TOCTOU 缝隙）；
     * 读不到 / Profile 不匹配一律拒绝：不创建页面、不导航、不采集，也绝不关闭对方浏览器。
     */
    const identity = await verifyConnectedBrowserIdentity(browser);
    if (identity !== "managed") {
      throw new SellerSpriteCategoryCaptureError(
        identity === "foreign" ? "seller_sprite_browser_identity_mismatch" : "seller_sprite_browser_identity_unverified",
        identity === "foreign"
          ? "本机调试端口上的浏览器不是本工作台专用实例（Profile 不匹配）；已拒绝采集，未打开任何页面。请关闭该浏览器后，通过工作台「启动专用浏览器」重试。"
          : "无法验证本机调试端口上的浏览器身份（该实例可能未由工作台启动，或缺少自动化标记）；已拒绝采集，未打开任何页面。请通过工作台「启动专用浏览器」启动后重试。",
      );
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP_CONTEXT_MISSING");
    page = await context.newPage();
    await page.goto(MARKET_RESEARCH_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!isSellerSpriteHost(new URL(page.url()).hostname)) {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_login_required", "SellerSprite 登录状态不可用，请先登录后重试。");
    }
    try {
      await page
        .locator('input[name="departmentKeyword"], input.departmentKeyword-inputs, input[placeholder*="类目关键词"]')
        .first()
        .waitFor({ state: "visible", timeout: 12_000 });
    } catch {
      throw new SellerSpriteCategoryCaptureError("seller_sprite_login_required", "未检测到 SellerSprite 类目市场页面，请先在已连接浏览器中登录。");
    }
    return await action(page);
  } catch (error) {
    if (error instanceof SellerSpriteCategoryCaptureError) throw error;
    throw new SellerSpriteCategoryCaptureError("seller_sprite_session_unavailable", "无法连接 SellerSprite 登录浏览器，请确认本机 CDP 会话已开启并登录。");
  } finally {
    // connectOverCDP 挂接的是用户专用 Chrome：绝对不得 browser.close()。
    await releaseSellerSpriteBrowserSession({
      ownership: SELLERSPRITE_CDP_OWNERSHIP,
      page,
      browser,
    });
  }
}

function sellerSpriteCdpEndpoint(): string {
  const configured = process.env.SELLERSPRITE_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new SellerSpriteCategoryCaptureError("seller_sprite_session_unavailable", "SellerSprite CDP 地址配置无效，请检查本机浏览器连接设置。");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (!loopback || !["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new SellerSpriteCategoryCaptureError("seller_sprite_session_unavailable", "SellerSprite CDP 仅允许连接本机浏览器地址。");
  }
  return url.toString();
}

function isSellerSpriteHost(hostname: string): boolean {
  return hostname === "sellersprite.com" || hostname.endsWith(".sellersprite.com");
}

function normalizeLabel(label: string): string {
  return label
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    // 建议条会把商品数拼在末尾，如 "Automotive:Interior Accessories93,516"
    .replace(/[0-9][0-9,\s]*(?:\.[0-9]+)?\s*$/u, " ")
    .replace(/[:>／/|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * UI 自动补全对过长/复合查询可能不出建议；
 * 按确定性顺序准备可触发建议的关键词，仍以 category 身份做选择，绝不取第一条。
 */
export function buildUiSearchQueries(query: string, category: { id: string; label: string }): string[] {
  const labelParts = category.label
    .split(/[:>]|\s+>\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = [
    query.trim(),
    category.label.replace(/[:>]/gu, " ").trim(),
    labelParts.slice(-2).join(" "),
    labelParts.at(-1) ?? "",
    labelParts.slice(0, 2).join(" "),
    labelParts[0] ?? "",
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of candidates) {
    const normalized = item.replace(/\s+/gu, " ").trim();
    if (normalized.length < 2 || normalized.length > 80) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * 在 SellerSprite 建议列表中定位已选类目。
 * 禁止回落到第一条；必须与 category 的 label / ID 路径段形成确定性命中。
 */
export function findCategorySuggestionIndex(labels: readonly string[], category: { id: string; label: string }): number {
  const targetLabel = normalizeLabel(category.label);
  const targetSegments = category.label
    .split(/[:>]|\s+>\s+/u)
    .map((part) => normalizeLabel(part))
    .filter(Boolean);
  const idSegments = category.id.split(":").map((part) => part.trim()).filter(Boolean);
  const leafSegment = targetSegments.at(-1) ?? "";

  let best = -1;
  let bestScore = 0;
  labels.forEach((rawLabel, index) => {
    const label = normalizeLabel(rawLabel);
    if (!label) return;
    const overlapping = targetSegments.filter((seg) => seg && label.includes(seg)).length;
    let score = 0;
    if (label === targetLabel) score = 100;
    else if (idSegments.length > 0 && idSegments.some((id) => rawLabel.includes(id))) score = 90;
    else if (targetLabel && label.includes(targetLabel)) score = 85;
    else if (targetLabel && targetLabel.includes(label) && overlapping >= Math.max(1, targetSegments.length - 1)) {
      // 例如建议只显示叶子段 "Kitchen & Dining"，但完整路径覆盖目标
      score = 70 + overlapping * 5;
      if (leafSegment && label.includes(leafSegment)) score += 15;
    } else if (leafSegment && label.includes(leafSegment) && overlapping >= 1) {
      score = 50 + overlapping * 8;
    } else if (leafSegment && label.endsWith(leafSegment)) {
      score = 45;
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return bestScore >= 55 ? best : -1;
}

function parseProductCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const match = value.match(/[\d,]+(?:\.\d+)?/u);
  if (!match) return null;
  const parsed = Number(match[0].replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
