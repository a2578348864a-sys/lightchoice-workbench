import "server-only";

import { mkdir } from "node:fs/promises";

import type { AccessContext } from "@/lib/server/accessPassword";
import { resolveSystemBrowser } from "@/tools/collectors/amazon/browser-control";
import { loadPlaywright } from "@/lib/server/playwrightRuntime";
import { captureBrowserVisibleV3Envelope } from "@/lib/sourceLayer/browserVisibleModuleCapture";
import { persistRawArtifact } from "@/lib/sourceLayer/server/rawArtifactIntake";
import {
  collectRawVisibleTables,
  hasStructuredVisibleTableData,
  resolveVisibleTableLayout,
  type RawVisibleSnapshot,
  type VisibleTableLayout,
} from "@/lib/sourceLayer/sellerSpriteVisibleTableLayout";
import type { V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";
import { SELLERSPRITE_PROVIDER_NAME } from "@/lib/sourceLayer/v3ModuleRegistry";
import { resolveSellerSpriteProfileDirectory } from "@/lib/server/sellerSpriteProfileConfig";
import { resolveSellerSpriteCdpEndpoint } from "@/lib/server/sellerSpriteProfileConfig";
import { verifyConnectedBrowserIdentity } from "@/lib/server/sellerSpriteBrowserIdentity";
import { releaseSellerSpriteBrowserSession, SELLERSPRITE_CDP_OWNERSHIP } from "@/lib/server/sellerSpriteCategoryMarketCapture";
import {visibleSnapshotCore} from "@/lib/server/sellerSpriteVisibleQuery";
import { collectSellerSpriteSubjectCards, projectSellerSpriteSubjectCard, projectSellerSpriteSubjectTables } from "@/lib/sourceLayer/sellerSpriteSubjectTable";
import { buildSellerSpriteHistorySeries, collectSellerSpriteHistoryDrawer, type SellerSpriteHistoryChartSurface, type SellerSpriteHistorySeriesResult } from "@/lib/sourceLayer/sellerSpriteHistoryTrend";

/**
 * 专用 Profile 目录：与服务端启动器（sellerSpriteBrowserLauncher）使用同一解析规则，
 * 保证「一键启动的浏览器」与「采集代码使用的 Profile」永远是同一个目录。
 * `SELLERSPRITE_PROFILE_DIR` 配置无效时 fail-closed（与配置解析同语义）。
 */
const SELLERSPRITE_PROFILE_DIR = resolveSellerSpriteProfileDirectory();
const SELLERSPRITE_HOST = /(^|\.)sellersprite\.com$/iu;
const NAVIGATION_TIMEOUT_MS = 45_000;

export type SellerSpriteSubjectPageMode = "reused_confirmed_drawer" | "reused_confirmed_url" | "reused_seller_page" | "navigated_home_page" | "created_page";

export type SellerSpriteSubjectDiagnostics = {
  pageSelection: SellerSpriteSubjectPageMode | null;
  candidatePages: number;
  pageUrlBefore: string | null;
  pageUrlAfter: string | null;
  navigated: boolean;
  drawer: { open: boolean; asin: string | null; activeTab: string | null; rangeLabel: string | null } | null;
  history: Pick<SellerSpriteHistorySeriesResult, "points" | "monthlyPoints" | "eventPoints" | "monthlyRange" | "eventRange" | "metrics" | "sameDateVariants"> | null;
  historyIssues: string[];
};

export function emptySubjectDiagnostics(): SellerSpriteSubjectDiagnostics {
  return { pageSelection: null, candidatePages: 0, pageUrlBefore: null, pageUrlAfter: null, navigated: false, drawer: null, history: null, historyIssues: [] };
}

export function isSellerSpriteHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !SELLERSPRITE_HOST.test(parsed.hostname.toLowerCase())) return false;
    return parsed.pathname === "" || parsed.pathname === "/" || /^\/v3\/?$/u.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * 页面选择：**优先复用用户已经打开并确认身份的页面**，绝不为了「看起来干净」而 newPage + goto。
 * 真实 SellerSprite 是 SPA：重新 goto 会丢查询状态（asins 参数被重置、抽屉关闭），
 * 这正是「打开目标页后又跳回首页/读不到数据」的根因。
 * 用户在弹窗里明确选中的页面（preferredUrl）优先——选错页时由抽屉身份校验如实报错，而不是偷偷换页。
 */
export function pickSellerSpriteSubjectPage(input: {
  pages: readonly { url: string; drawerAsin: string | null }[];
  asin: string;
  module: "sellersprite_product_market" | "historical_trend";
  preferredUrl?: string | null;
}): { index: number; mode: SellerSpriteSubjectPageMode } | null {
  const asin = input.asin.toUpperCase();
  const preferred = (input.preferredUrl ?? "").trim();
  if (preferred) {
    const preferredIndex = input.pages.findIndex((page) => page.url === preferred);
    if (preferredIndex >= 0) {
      const drawerMatches = (input.pages[preferredIndex].drawerAsin ?? "").toUpperCase() === asin;
      return { index: preferredIndex, mode: drawerMatches ? "reused_confirmed_drawer" : "reused_confirmed_url" };
    }
  }
  const drawerIndex = input.pages.findIndex((page) => (page.drawerAsin ?? "").toUpperCase() === asin);
  if (drawerIndex >= 0) return { index: drawerIndex, mode: "reused_confirmed_drawer" };
  const urlIndex = input.pages.findIndex((page) => page.url.toUpperCase().includes(asin));
  if (urlIndex >= 0) return { index: urlIndex, mode: "reused_confirmed_url" };
  const homeIndex = input.pages.findIndex((page) => isSellerSpriteHomepage(page.url));
  if (homeIndex >= 0) return { index: homeIndex, mode: "navigated_home_page" };
  if (input.pages.length > 0) return { index: 0, mode: "reused_seller_page" };
  return null;
}

/** 在已打开的 SellerSprite 结果页里，点开目标 ASIN 行/卡片的「历史趋势」抽屉（正常交互，不改查询）。 */
async function openSellerSpriteHistoryDrawer(page: import("playwright").Page, asin: string): Promise<boolean> {
  const clickIcon = () => page.evaluate((target: string) => {
    const containers = Array.from(document.querySelectorAll(".el-table__row, .card-wrap, tr"));
    for (const container of containers) {
      const text = (container.textContent ?? "").toUpperCase();
      if (!text.includes(target)) continue;
      const icon = container.querySelector(".icon-historical-trend");
      if (icon instanceof HTMLElement) {
        icon.click();
        return true;
      }
    }
    return false;
  }, asin).catch(() => false);
  let clicked = await clickIcon();
  if (!clicked) {
    // 真实页面：大图（卡片）视图没有行内历史图标，列表视图才有。切一次视图后重试。
    await page.getByText("列表", { exact: true }).first().click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    clicked = await clickIcon();
  }
  if (!clicked) return false;
  await page.waitForFunction((target: string) => {
    const drawer = document.querySelector(".el-drawer.btt");
    if (!drawer) return false;
    const rect = drawer.getBoundingClientRect();
    return rect.width > 200 && (drawer.textContent ?? "").toUpperCase().includes(target);
  }, asin, { timeout: 12_000 }).catch(() => undefined);
  return true;
}

/**
 * 切到抽屉里的指定标签并等待 canvas 可见。
 * 这一步只做正常点击；数值仍必须在真实悬停浮层里出现才会被记录。
 */
async function openSellerSpriteDrawerTab(page: import("playwright").Page, label: "历史趋势" | "留评率"): Promise<boolean> {
  const clicked = await page.evaluate((tabLabel: string) => {
    const drawer = document.querySelector(".el-drawer.btt");
    if (!drawer) return false;
    const active = drawer.querySelector(".el-tabs__item.is-active");
    if ((active?.textContent ?? "").trim() === tabLabel) return true;
    for (const tab of Array.from(drawer.querySelectorAll(".el-tabs__item"))) {
      if ((tab.textContent ?? "").trim() !== tabLabel) continue;
      (tab as HTMLElement).click();
      return true;
    }
    return false;
  }, label).catch(() => false);
  if (!clicked) return false;
  return await page.waitForFunction(() => {
    for (const canvas of Array.from(document.querySelectorAll(".el-drawer.btt canvas"))) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100) return true;
    }
    return false;
  }, undefined, { timeout: 10_000 }).then(() => true).catch(() => false);
}

/** 读当前可见的历史/留评率悬停浮层文本（保留换行；不推断画布像素）。 */
function readSellerSpriteHistoryTooltipText(): string {
  const drawer = document.querySelector(".el-drawer.btt");
  if (!drawer) return "";
  for (const node of Array.from(drawer.querySelectorAll(".chart"))) {
    const text = ((node as HTMLElement).innerText ?? "").replace(/[ \t]+/gu, " ").trim();
    if (/^\d{4}-?\d{2}(?:-\d{2})?/u.test(text)) return text;
  }
  return "";
}

/**
 * 悬停扫描：在已通过身份确认的图表上做正常鼠标移动，只记录**真实出现的可见浮层文本**。
 * 有界：最多 two-pass、有限步数；不做像素反推、不调用页面内部数据接口。
 */
async function sweepSellerSpriteHistoryTooltips(page: import("playwright").Page, surface: SellerSpriteHistoryChartSurface): Promise<string[]> {
  const texts = new Set<string>();
  const passes: number[] = [0.5, 0.62];
  for (const ratio of passes) {
    if (texts.size > 0 && ratio !== 0.5) break;
    const y = surface.y + surface.height * ratio;
    const steps = texts.size > 0 ? 0 : 24;
    for (let index = 0; index <= steps; index += 1) {
      const x = surface.x + 10 + ((surface.width - 20) * index) / Math.max(1, steps);
      await page.mouse.move(x, y, { steps: 2 });
      await page.waitForTimeout(70);
      const text = await page.evaluate(readSellerSpriteHistoryTooltipText).catch(() => "");
      if (text) texts.add(text);
      if (texts.size >= 60) break;
    }
  }
  return [...texts];
}

/** 等待 SPA 真正就绪：要么出现目标 ASIN，要么出现登录/权益门禁。 */
async function waitForSellerSpriteSubjectPage(page: import("playwright").Page, asin: string): Promise<"asin_present" | "gate" | "timeout"> {
  const outcome = await page.waitForFunction((target: string) => {
    const text = document.body.innerText ?? "";
    if (/captcha|请先登录|登录后使用|权限不足|套餐.{0,20}(?:限制|不足)/iu.test(text)) return "gate";
    if (text.toUpperCase().includes(target)) return "asin_present";
    return false;
  }, asin, { timeout: 20_000 }).catch(() => null);
  if (!outcome) return "timeout";
  return (await outcome.jsonValue()) as "asin_present" | "gate";
}

export type SellerSpriteSubjectCaptureResult = {
  status: "captured" | "partial" | "human_required" | "failed";
  errorCode: string | null;
  message: string;
  attachment: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>>["attachment"] | null;
  usableRows: number;
  diagnostics: SellerSpriteSubjectDiagnostics;
};

/** Bounded one-page extension of the existing visible collector, using the managed external CDP profile. */
export async function collectSellerSpriteSubjectWithCdp(input: {context:AccessContext;module:"sellersprite_product_market"|"historical_trend";asin:string;sourceUrl:string}): Promise<SellerSpriteSubjectCaptureResult> {
  const diagnostics = emptySubjectDiagnostics();
  const blocked = (status: SellerSpriteSubjectCaptureResult["status"], errorCode: string, message: string): SellerSpriteSubjectCaptureResult =>
    ({ status, errorCode, message, attachment: null, usableRows: 0, diagnostics });
  if(process.env.LOCAL_ACQUISITION_ENABLED!=="true")return blocked("failed","LOCAL_ACQUISITION_DISABLED","当前服务未启用真实采集。");
  const endpoint=resolveSellerSpriteCdpEndpoint();
  if(!endpoint||!allowedSellerSpriteUrl(input.sourceUrl)||!/^[A-Z0-9]{10}$/u.test(input.asin)||input.asin.length!==10)throw new Error("SELLERSPRITE_SUBJECT_INPUT_INVALID");
  const playwright=await loadPlaywright<typeof import("playwright")>();if(!playwright)throw new Error("PLAYWRIGHT_UNAVAILABLE");
  const browser=await playwright.chromium.connectOverCDP(endpoint.origin,{timeout:10000});
  let page:import("playwright").Page|null=null;
  let ownsPage=false;
  try{
    if(await verifyConnectedBrowserIdentity(browser)!=="managed")throw new Error("CDP_BROWSER_IDENTITY_NOT_MANAGED");
    const context=browser.contexts()[0];if(!context)throw new Error("CDP_CONTEXT_MISSING");
    const sellerPages=context.pages().filter(candidate=>allowedSellerSpriteUrl(candidate.url()));
    diagnostics.candidatePages=sellerPages.length;
    const probes: {page:import("playwright").Page;url:string;drawerAsin:string|null}[]=[];
    for(const candidate of sellerPages.slice(0,4)){
      let drawerAsin:string|null=null;
      if(input.module==="historical_trend"){
        drawerAsin=await candidate.evaluate(collectSellerSpriteHistoryDrawer).then(raw=>raw?.asin??null).catch(()=>null);
      }
      probes.push({page:candidate,url:candidate.url(),drawerAsin});
    }
    const selection=pickSellerSpriteSubjectPage({pages:probes.map(entry=>({url:entry.url,drawerAsin:entry.drawerAsin})),asin:input.asin,module:input.module,preferredUrl:input.sourceUrl});
    if(selection){
      page=probes[selection.index].page;
      diagnostics.pageSelection=selection.mode;
      diagnostics.pageUrlBefore=probes[selection.index].url;
      if(selection.mode==="navigated_home_page"){
        await page.goto(input.sourceUrl,{waitUntil:"domcontentloaded",timeout:25_000});
        diagnostics.navigated=true;
        await waitForSellerSpriteSubjectPage(page,input.asin);
      }else{
        await page.bringToFront().catch(()=>undefined);
      }
    }else{
      page=await context.newPage();
      ownsPage=true;
      diagnostics.pageSelection="created_page";
      await page.goto(input.sourceUrl,{waitUntil:"domcontentloaded",timeout:25_000});
      diagnostics.navigated=true;
      await waitForSellerSpriteSubjectPage(page,input.asin);
    }
    diagnostics.pageUrlAfter=page.url();
    if(!allowedSellerSpriteUrl(page.url()))return blocked("failed","SELLERSPRITE_REDIRECT_INVALID","SellerSprite 页面跳转到非官方主机，已停止。");
    if(isSellerSpriteHomepage(page.url()))return blocked("failed","SELLERSPRITE_SOURCE_PAGE_REDIRECTED_HOME","来源页被重定向回 SellerSprite 首页：请在该专用浏览器打开目标 ASIN 的结果页（保持查询与历史抽屉）后重新检测，系统不会用首页冒充来源。");

    const base=await page.evaluate(visibleDomExtraction);
    if(isHumanGateText(base.bodyText)||/会员.{0,20}(?:升级|权限不足)|套餐.{0,20}(?:不足|限制)|订阅后|登录后/iu.test(base.bodyText))return blocked("human_required","SELLERSPRITE_SESSION_OR_PERMISSION_REQUIRED","来源页面要求登录、验证或相应权益；已停止，等待人工处理。");
    const url=new URL(page.url());
    if(!url.href.toUpperCase().includes(input.asin)&&!base.bodyText.toUpperCase().includes(input.asin))return blocked("failed","SELLERSPRITE_SUBJECT_NOT_CONFIRMED","来源URL及可见页面未共同确认当前ASIN。请在专用浏览器打开对应美国站商品页再试。");
    const querySnapshot=await page.evaluate(visibleSnapshotCore,"");
    if(!querySnapshot.marketplaceEcho||!/^(?:US|Amazon[.]com|United States|美国站)$/iu.test(querySnapshot.marketplaceEcho.trim()))return blocked("human_required","SELLERSPRITE_MARKETPLACE_NOT_CONFIRMED","来源页面未能确认美国站，未保存商品指标，请人工核对来源站点。");
    const observedAt=new Date().toISOString();const subjectKey=`amazon:US:${input.asin}`;

    if(input.module==="historical_trend"){
      let drawer=await page.evaluate(collectSellerSpriteHistoryDrawer);
      if(drawer?.asin!==input.asin){
        await openSellerSpriteHistoryDrawer(page,input.asin);
        drawer=await page.evaluate(collectSellerSpriteHistoryDrawer);
      }
      diagnostics.drawer=drawer?{open:true,asin:drawer.asin,activeTab:drawer.activeTab,rangeLabel:drawer.rangeLabel}:null;
      if(!drawer)return blocked("partial","SELLERSPRITE_HISTORY_DRAWER_NOT_OPEN","当前页没有打开的历史抽屉。请在名单/卡片行点击「历史趋势」图标后再采集；系统不会用其他页面猜数据。");
      if(drawer.asin!==input.asin)return blocked("failed","SELLERSPRITE_HISTORY_SUBJECT_MISMATCH",`历史抽屉显示的是 ${drawer.asin??"未知 ASIN"}，与目标 ${input.asin} 不一致；未保存任何数值。`);
      // 悬停点只在图表标签里可见：历史趋势（价格/BSR/评分…）与留评率（当月销量/评分数增长/留评率）
      // 分别做一次正常点击并读取真实出现的浮层文本；月份表仍是月销量权威。
      const tooltipTexts=[...drawer.tooltipTexts];
      for(const tab of ["历史趋势","留评率"] as const){
        if(!(await openSellerSpriteDrawerTab(page,tab)))continue;
        const tabDrawer=await page.evaluate(collectSellerSpriteHistoryDrawer);
        if(tabDrawer?.chartSurface)tooltipTexts.push(...await sweepSellerSpriteHistoryTooltips(page,tabDrawer.chartSurface));
      }
      const openedDrawer=await page.evaluate(collectSellerSpriteHistoryDrawer)??drawer;
      const series=buildSellerSpriteHistorySeries({...openedDrawer,tooltipTexts:[...openedDrawer.tooltipTexts,...tooltipTexts]});
      diagnostics.history={points:series.points,monthlyPoints:series.monthlyPoints,eventPoints:series.eventPoints,monthlyRange:series.monthlyRange,eventRange:series.eventRange,metrics:series.metrics,sameDateVariants:series.sameDateVariants};
      diagnostics.historyIssues=series.issues.slice(0,12).map(item=>`${item.code}: ${item.detail}`);
      const usableRows=series.points;
      const result=await captureBrowserVisibleV3Envelope({context:input.context,sourceType:"sellersprite_plugin",envelope:{schemaVersion:"capture-system-v3-browser-visible-envelope.v1",module:"historical_trend",subjectKey,marketplace:"US",provider:SELLERSPRITE_PROVIDER_NAME,sourceSurface:"SellerSprite managed CDP historical_trend drawer",sourceUrl:page.url(),capturedAt:observedAt,providerUpdatedAt:null,freshnessMetricKey:null,acquisitionMode:"DOM_DIRECT",metricNature:"provider_estimate",status:usableRows?"AVAILABLE_WITH_LIMITATION":"BLOCKED_WITH_EVIDENCE",limitations:usableRows?["商品历史来自 SellerSprite 当前合法可见的「销量趋势」月份表与「历史趋势」悬停浮层；为第三方估算/观察，不代表整个市场或未来趋势","悬停点只记录真实出现的日期与指标；同日期多次读数只保留最早时间戳","不从图表像素或私有接口推算数值"]:["当前抽屉没有可验证的日期/指标数值；未从图像补造历史"],identity:{asin:input.asin},data:{series:series.series,history:{asin:openedDrawer.asin,title:openedDrawer.title,activeTab:openedDrawer.activeTab,rangeLabel:openedDrawer.rangeLabel,monthlyRange:series.monthlyRange,eventRange:series.eventRange,metrics:series.metrics,sameDateVariants:series.sameDateVariants,issues:series.issues.slice(0,12),pageSelection:diagnostics.pageSelection,pageUrlBefore:diagnostics.pageUrlBefore,pageUrlAfter:page.url()},browserObservedAt:observedAt,visibleDom:{tables:[],cards:[],visibleLabels:base.visibleLabels,chartSurfaces:base.chartSurfaces},amazonConfirmed:false},evidenceOnly:true}});
      return {status:usableRows?"captured":"partial",errorCode:usableRows?null:"SELLERSPRITE_HISTORY_NO_VERIFIED_POINTS",message:usableRows?`已保存 ${series.monthlyPoints} 个月度点与 ${series.eventPoints} 个悬停日期点；来源为 SellerSprite 当前页可见历史，须按日期范围核对。`:"历史抽屉已确认属于该 ASIN，但没有可验证的日期/指标数值；已保存为缺口证据，不能宣布历史采集完成。",attachment:result.attachment,usableRows,diagnostics};
    }

    const raw=await page.evaluate(collectRawVisibleTables);const tables=resolveVisibleTableLayout(raw);
    const visibleAsins=[...new Set(base.bodyText.toUpperCase().match(/\bB[A-Z0-9]{9}\b/gu)??[])];
    const projection=projectSellerSpriteSubjectTables(tables,input.asin,visibleAsins.length===1&&visibleAsins[0]===input.asin);
    const cards=await page.evaluate(collectSellerSpriteSubjectCards,input.asin);
    if(Object.keys(projection.product).length===0)Object.assign(projection.product,projectSellerSpriteSubjectCard(cards,input.asin));
    const usableRows=Object.values(projection.product).filter(v=>v!==null).length;
    const result=await captureBrowserVisibleV3Envelope({context:input.context,sourceType:"sellersprite_plugin",envelope:{schemaVersion:"capture-system-v3-browser-visible-envelope.v1",module:input.module,subjectKey,marketplace:"US",provider:SELLERSPRITE_PROVIDER_NAME,sourceSurface:`SellerSprite managed CDP ${input.module}`,sourceUrl:page.url(),capturedAt:observedAt,providerUpdatedAt:null,freshnessMetricKey:null,acquisitionMode:"DOM_DIRECT",metricNature:"provider_estimate",status:usableRows?"AVAILABLE_WITH_LIMITATION":"BLOCKED_WITH_EVIDENCE",limitations:[usableRows?"仅本次当前可见页；不代表全市场或完整历史":"来源当前页没有可验证的命名指标/日期表格；未从图像补造数值"],identity:{asin:input.asin},data:{...projection.product,series:projection.series,browserObservedAt:observedAt,visibleDom:{tables,cards,visibleLabels:base.visibleLabels,chartSurfaces:base.chartSurfaces},amazonConfirmed:false},evidenceOnly:true}});
    return {status:usableRows?"captured":"partial",errorCode:usableRows?null:"SELLERSPRITE_NUMERIC_DATA_MISSING",message:usableRows?"当前页证据已通过Gateway保存，须核对来源范围。":"来源观察已保存，但没有合格数值，不能宣布历史或市场指标采集完成。",attachment:result.attachment,usableRows,diagnostics};
  }finally{await releaseSellerSpriteBrowserSession({ownership:SELLERSPRITE_CDP_OWNERSHIP,page:ownsPage?page:null,browser});}
}

type VisibleLocatorHandle = {
  count(): Promise<number>;
  nth(index: number): VisibleLocatorHandle;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
};

type VisiblePage = {
  goto(url: string, options?: Record<string, unknown>): Promise<void>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>;
  locator(selector: string): VisibleLocatorHandle;
  keyboard: {
    type(text: string, options?: Record<string, unknown>): Promise<void>;
    press(key: string): Promise<void>;
  };
  waitForTimeout(ms: number): Promise<void>;
};

type VisibleBrowserContext = {
  newPage(): Promise<VisiblePage>;
  close(): Promise<void>;
};

type PlaywrightVisibleModule = {
  chromium: {
    launchPersistentContext(path: string, options: Record<string, unknown>): Promise<VisibleBrowserContext>;
  };
};

export type VisibleDomSnapshot = {
  bodyText: string;
  /**
   * P2-2：表格由 `resolveVisibleTableLayout` 产出 —— 表头只来自 `thead` 或同部件配对的
   * 表头表，数据行排除表头行；列数不匹配一律 `headers: []` + 状态标记（fail-closed）。
   */
  tables: readonly VisibleTableLayout[];
  chartSurfaces: Array<{ selector: string; role: string | null; label: string | null; text: string | null }>;
  visibleLabels: string[];
};

export type SellerSpriteVisibleBrowserResult = {
  status: "captured" | "human_required" | "unavailable" | "failed";
  module: V3ModuleId;
  sourceUrl: string;
  envelope: Record<string, unknown> | null;
  capture: Awaited<ReturnType<typeof captureBrowserVisibleV3Envelope>> | null;
  screenshotArtifact: Awaited<ReturnType<typeof persistRawArtifact>> | null;
  errorCode: string | null;
  errorMessage: string | null;
  browser: { name: string; profile: string } | null;
};

function allowedSellerSpriteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SELLERSPRITE_HOST.test(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isHumanGateText(value: string): boolean {
  return /captcha|verify you are human|security check|access denied|请先登录|登录后使用|sign in to sellersprite/iu.test(value);
}

function safeModuleMetricNature(module: V3ModuleId): "source_observed" | "provider_observed" | "provider_estimate" {
  // 市场/关键词/历史趋势均为 Provider 侧估算，禁止升格为 Amazon confirmed / source_observed。
  if (module === "historical_trend" || module === "keyword_mining_trend" || module === "sellersprite_product_market") {
    return "provider_estimate";
  }
  return "provider_observed";
}

/** 真实页选择器：类目关键词输入（市场研究页）。 */
const MARKET_CATEGORY_INPUT_SELECTOR = "input#departmentKeyword, input.departmentKeyword-inputs, input[placeholder*='类目关键词']";

/**
 * 选市场是查询驱动 SPA：仅 goto 时细分市场表无数据行。
 * 在 DOM 抽取前补一次正常用户查询（选类目 → 提交），仅针对 market-research。
 * 类目节点请求：GET /v2/competitor-lookup/nodesList（CDP/XHR 自然发生，不绕过权限）。
 */
export function matchSellerSpriteCategorySuggestion(category: string, labels: string[]): number {
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const wanted = normalized(category);
  const matches = labels.flatMap((label, index) => normalized(label) === wanted ? [index] : []);
  return wanted && matches.length === 1 ? matches[0] : -1;
}

async function runSellerSpriteMarketCategoryQuery(page: VisiblePage, category: string): Promise<{ attempted: boolean; suggestionClicked: boolean; submitted: boolean; dataRows: number }> {
  if (!category.trim() || category.length > 120) throw new Error("SELLERSPRITE_EXPLICIT_CATEGORY_REQUIRED");
  const input = page.locator(MARKET_CATEGORY_INPUT_SELECTOR);
  if ((await input.count()) === 0) {
    return { attempted: false, suggestionClicked: false, submitted: false, dataRows: 0 };
  }
  const mainInput = input.nth(0);
  await mainInput.fill("");
  await page.keyboard.type(category.trim(), { delay: 80 });
  await page.waitForTimeout(3000);
  const suggestion = page.locator(".suggest-item");
  let suggestionClicked = false;
  const suggestionCount = await suggestion.count();
  if (suggestionCount > 0) {
    const labels: string[] = [];
    for (let index = 0; index < Math.min(suggestionCount, 30); index += 1) labels.push((await suggestion.nth(index).textContent()) ?? "");
    const targetIndex = matchSellerSpriteCategorySuggestion(category, labels);
    if (targetIndex < 0) throw new Error("SELLERSPRITE_CATEGORY_SUGGESTION_UNCONFIRMED");
    await suggestion.nth(targetIndex).click();
    suggestionClicked = true;
    await page.waitForTimeout(1500);
  }
  if (!suggestionClicked) throw new Error("SELLERSPRITE_CATEGORY_SUGGESTION_UNCONFIRMED");
  await mainInput.press("Enter").catch(async () => {
    await page.keyboard.press("Enter").catch(() => undefined);
  });
  await page.waitForTimeout(12_000);
  const dataRows = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    return tables.reduce((total, table) => {
      const rows = Array.from(table.querySelectorAll("tbody tr")).filter((row) => (row.textContent ?? "").trim().length > 3);
      return total + rows.length;
    }, 0);
  });
  return { attempted: true, suggestionClicked, submitted: true, dataRows };
}

function visibleDomExtraction(): VisibleDomSnapshot {
  const clean = (value: string | null | undefined, limit: number): string | null => {
    const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
    return normalized ? normalized.slice(0, limit) : null;
  };
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const chartSurfaces = Array.from(document.querySelectorAll("svg, canvas, [role='img'], [role='graphics-symbol']"))
    .filter(visible)
    .slice(0, 20)
    .map((element, index) => ({
      selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
      role: element.getAttribute("role"),
      label: clean(element.getAttribute("aria-label") ?? element.getAttribute("title"), 300),
      text: clean(element.textContent, 1000),
    }));
  const visibleLabels = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading'], [data-testid], [class*='metric'], [class*='title']"))
    .filter(visible)
    .map((element) => clean(element.textContent, 300))
    .filter((value): value is string => value !== null)
    .slice(0, 200);
  return {
    bodyText: clean(document.body?.innerText, 10_000) ?? "",
    // 表格不在此处采集：由 collectRawVisibleTables + resolveVisibleTableLayout 统一处理（P2-2）。
    tables: [],
    chartSurfaces,
    visibleLabels: [...new Set(visibleLabels)],
  };
}

export function hasStructuredVisibleData(snapshot: VisibleDomSnapshot): boolean {
  return hasStructuredVisibleTableData(snapshot.tables);
}

export async function collectSellerSpriteVisibleModuleWithPlaywright(input: {
  context: AccessContext;
  module: V3ModuleId;
  sourceUrl: string;
  subjectKey: string;
  identity: Record<string, unknown>;
  sourceSurface?: string;
  now?: Date;
}): Promise<SellerSpriteVisibleBrowserResult> {
  const sourceUrl = input.sourceUrl.trim();
  if (!allowedSellerSpriteUrl(sourceUrl)) {
    return { status: "failed", module: input.module, sourceUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "SELLERSPRITE_URL_INVALID", errorMessage: "SellerSprite URL 必须是 HTTPS 官方页面。", browser: null };
  }
  const playwrightModule = await loadPlaywright<PlaywrightVisibleModule>();
  const browser = resolveSystemBrowser();
  if (!playwrightModule) {
    return { status: "unavailable", module: input.module, sourceUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "PLAYWRIGHT_RUNTIME_MISSING", errorMessage: "当前项目未安装可用的 Playwright runtime。", browser: browser ? { name: browser.browser, profile: SELLERSPRITE_PROFILE_DIR } : null };
  }
  if (!browser) {
    return { status: "unavailable", module: input.module, sourceUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "BROWSER_NOT_FOUND", errorMessage: "本机未检测到 Chrome/Edge。", browser: null };
  }
  let context: VisibleBrowserContext | null = null;
  try {
    await mkdir(SELLERSPRITE_PROFILE_DIR, { recursive: true });
    context = await playwrightModule.chromium.launchPersistentContext(SELLERSPRITE_PROFILE_DIR, {
      executablePath: browser.executablePath,
      headless: false,
      viewport: null,
    });
    const page = await context.newPage();
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    const finalUrl = page.url();
    if (!allowedSellerSpriteUrl(finalUrl)) {
      return { status: "failed", module: input.module, sourceUrl: finalUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "SELLERSPRITE_REDIRECT_INVALID", errorMessage: "SellerSprite 页面重定向到非官方主机，已停止。", browser: { name: browser.browser, profile: SELLERSPRITE_PROFILE_DIR } };
    }
    // Category Market：查询驱动页面需先完成类目查询，否则 DOM 无结构化数据行。
    const marketQuery = /market-research/iu.test(finalUrl)
      ? await runSellerSpriteMarketCategoryQuery(page, typeof input.identity.category === "string" ? input.identity.category : "")
      : null;
    const baseSnapshot = await page.evaluate(visibleDomExtraction);
    // P2-2：表格由统一的「页内采集 + Node 侧对齐」两步产出，避免把首行数据当表头。
    const rawTables = await page.evaluate(collectRawVisibleTables) as RawVisibleSnapshot;
    const snapshot: VisibleDomSnapshot = { ...baseSnapshot, tables: resolveVisibleTableLayout(rawTables) };
    if (isHumanGateText(snapshot.bodyText)) {
      return { status: "human_required", module: input.module, sourceUrl: finalUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "SELLERSPRITE_LOGIN_OR_CAPTCHA_REQUIRED", errorMessage: "当前页面需要人工登录或人机验证；系统未自动提交凭据、未绕过验证。", browser: { name: browser.browser, profile: SELLERSPRITE_PROFILE_DIR } };
    }
    const now = input.now ?? new Date();
    const structured = hasStructuredVisibleData(snapshot);
    const acquisitionMode = structured
      ? snapshot.tables.some((table) => table.rows.length > 0) ? "DOM_DIRECT" : "VISIBLE_CHART"
      : "SCREENSHOT_EVIDENCE";
    const envelope = {
      schemaVersion: "capture-system-v3-browser-visible-envelope.v1",
      module: input.module,
      subjectKey: input.subjectKey,
      marketplace: "US",
      capturedAt: now.toISOString(),
      provider: SELLERSPRITE_PROVIDER_NAME,
      sourceSurface: input.sourceSurface?.trim() || `SellerSprite visible ${input.module}`,
      sourceUrl: finalUrl,
      acquisitionMode,
      metricNature: safeModuleMetricNature(input.module),
      status: structured ? "AVAILABLE_WITH_LIMITATION" : "BLOCKED_WITH_EVIDENCE",
      limitations: ["export:PLAN_LIMITATION", ...(structured ? [] : ["visible_dom_has_no_structured_values"])],
      identity: input.identity,
      data: {
        capturedFromVisibleDom: true,
        exportAttempted: false,
        hiddenApiCalled: false,
        pageTitle: await page.title(),
        visibleDom: snapshot,
        amazonConfirmed: false,
        ...(marketQuery
          ? { categoryMarketQuery: { attempted: marketQuery.attempted, suggestionClicked: marketQuery.suggestionClicked, submitted: marketQuery.submitted, dataRows: marketQuery.dataRows } }
          : {}),
      },
      providerUpdatedAt: null,
      freshnessMetricKey: null,
      evidenceOnly: true,
    } as const;
    const capture = await captureBrowserVisibleV3Envelope({
      context: input.context,
      envelope,
      sourceType: "sellersprite_plugin",
    });
    let screenshotArtifact: Awaited<ReturnType<typeof persistRawArtifact>> | null = null;
    if (!structured) {
      const screenshot = await page.screenshot({ type: "png", fullPage: true });
      screenshotArtifact = await persistRawArtifact({
        context: input.context,
        subjectKey: input.subjectKey,
        sourceType: "sellersprite_plugin",
        kind: "other",
        fileName: `sellersprite-${input.module}-${input.subjectKey.replace(/[^A-Za-z0-9._-]+/gu, "-")}.png`,
        contentType: "image/png",
        bytes: screenshot,
        capturedAt: now.toISOString(),
        provenance: {
          provider: SELLERSPRITE_PROVIDER_NAME,
          sourceSurface: input.sourceSurface?.trim() || `SellerSprite visible ${input.module}`,
          sourceUrl: finalUrl,
          sourceRecordRef: input.subjectKey,
          providerUpdatedAt: null,
          acquisitionMode: "screenshot_evidence",
          parserVersion: "sellersprite-visible-browser.v1",
        },
      });
    }
    return { status: "captured", module: input.module, sourceUrl: finalUrl, envelope, capture, screenshotArtifact, errorCode: null, errorMessage: null, browser: { name: browser.browser, profile: SELLERSPRITE_PROFILE_DIR } };
  } catch (error) {
    return { status: "failed", module: input.module, sourceUrl, envelope: null, capture: null, screenshotArtifact: null, errorCode: "SELLERSPRITE_VISIBLE_BROWSER_FAILED", errorMessage: error instanceof Error ? error.message : "SellerSprite Browser Visible Capture 失败。", browser: { name: browser.browser, profile: SELLERSPRITE_PROFILE_DIR } };
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
}
