/**
 * Amazon US 类目树采集器（真实 Amazon 门店「部门子导航」）。
 *
 * 数据源（Amazon 官方、无认证、可复现）：
 *   对每个 browse node，加载 https://www.amazon.com/s?rh=n%3A<nodeId>&language=en_US
 *   读取 `#nav-subnav`（Amazon 部门子导航）内的同站链接，得到该节点的真实子类目
 *   （真实 Amazon browse node ID + 真实英文名）。
 *
 * 说明与边界：
 *   - 只读取公开页面导航，不登录、不绕过任何门禁、不写入任何 Amazon 账号数据。
 *   - Amazon node ID 是 Amazon 自己的 ID；本脚本与 SellerSprite 无关。
 *   - 输出原始快照（含 sourceUrl / fetchedAt / 别名），供下游生成器使用。
 *
 * 用法：
 *   node scripts/taxonomy/harvest-amazon-us-taxonomy.mjs [--max-depth=4] [--budget=1200]
 *        [--delay=1200] [--concurrency=2] [--out=<path>] [--roots=<path>]
 *
 * 可断点续跑：每个节点的抓取结果缓存在 .tmp/amz-tax/cache/<nodeId>.json。
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { resolveAmazonCaptureProfileDirectory } from "../ops/capture-runtime-config.mjs";
import { launchPersistentContextWithProfileLock } from "../../lib/server/playwrightProfileLease.mjs";

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.join("=") || "true"];
}));
const num = (k, d) => (args.has(k) ? Number(args.get(k)) : d);

/** 每个深度实际抓取的节点数上限（depth1=38 全覆盖，depth2/3 按需放大）。 */
const PLAN = (args.get("plan") || "38,400,300").split(",").map((n) => Number(n.trim()));
const DELAY_MS = num("delay", 1200);
const CONCURRENCY = num("concurrency", 2);
const CWD = process.cwd();
const ROOTS_PATH = resolve(CWD, args.get("roots") || "data/amazon-taxonomy/roots.v1.json");
const OUT_PATH = resolve(CWD, args.get("out") || "data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json");
const CACHE_DIR = resolve(CWD, ".tmp/amz-tax/cache");
const PROFILE = resolveAmazonCaptureProfileDirectory(process.env, CWD);
const URL_TEMPLATE = (id) => `https://www.amazon.com/s?rh=n%3A${id}&language=en_US`;

await mkdir(CACHE_DIR, { recursive: true });

/**
 * 在页面上下文里抽取子类目链接。
 *
 * 优先级（全部来自 Amazon 页面自身的导航结构，不做推断）：
 *   1) `ref_=sv_*`：Amazon 部门「store tab」子导航（容器不固定，故按链接特征匹配）。
 *   2) `#nav-subnav` / `.mm-category-list` / `[class*=dcl-carousel]`：部门子导航或类目轮播。
 *   3) 兜底：主内容区同站 node 链接，排除全局导航条 / 页脚 / 弹层与营销位。
 */
const EXTRACT = () => {
  const rows = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    const m = /node=(\d+)/.exec(href) || /rh=n%3A(\d+)/i.exec(href);
    if (!m) continue;
    const text = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const ref = (/ref_=([^&"']+)/.exec(href) || [, ""])[1];
    const inChrome = Boolean(a.closest('#nav-main, #nav-belt, #navFooter, #nav-flyout-shopAll, [id^="nav-flyout"], header, footer'));
    const isCarousel = Boolean(a.closest('[id="nav-subnav"], .mm-category-list, [class*=dcl-carousel]'));
    rows.push({ id: m[1], text, href, ref, inChrome, isCarousel });
  }
  const uniq = (arr) => {
    const out = new Map();
    for (const x of arr) {
      if (!out.has(x.id)) out.set(x.id, x);
      else if (!out.get(x.id).text && x.text) out.set(x.id, x);
    }
    return [...out.values()].map(({ id, text }) => ({ id, text })).slice(0, 40);
  };
  const sv = rows.filter((r) => /^sv_/.test(r.ref) && r.text);
  const subnav = rows.filter((r) => r.isCarousel && r.text);
  const main = rows.filter((r) => !r.inChrome && r.text && !/^(nav_|footer_|zg_|sspa|pd_|asc_)/.test(r.ref));
  let mode;
  let children;
  if (sv.length >= 2) { mode = "sv"; children = uniq(sv); }
  else if (subnav.length >= 3) { mode = "subnav"; children = uniq(subnav); }
  else { mode = "main"; children = uniq([...sv, ...subnav, ...main]); }
  return {
    title: document.title,
    blocked: /Enter the characters you see below|automated access|Sorry, we just need to make sure/i.test(document.body.innerText.slice(0, 6000)),
    mode,
    children,
  };
};

async function loadRoots() {
  const raw = JSON.parse(await readFile(ROOTS_PATH, "utf8"));
  return raw.map((r) => ({ id: String(r.amazonNodeId), en: r.en, zh: r.zh, ss: r.sellerSpriteSearchTerm }));
}

function cachePath(id) { return resolve(CACHE_DIR, `${id}.json`); }

async function fetchNode(page, id) {
  const cp = cachePath(id);
  if (existsSync(cp)) {
    try { return { ...JSON.parse(await readFile(cp, "utf8")), cached: true }; } catch { /* fallthrough */ }
  }
  let record = { id, url: URL_TEMPLATE(id), fetchedAt: new Date().toISOString(), ok: false, blocked: false, mode: "none", title: "", children: [], error: null };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(URL_TEMPLATE(id), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2200);
      const r = await page.evaluate(EXTRACT);
      if (r.blocked) throw new Error("BLOCKED");
      record = {
        id, url: URL_TEMPLATE(id), fetchedAt: new Date().toISOString(), ok: true,
        blocked: false, mode: r.mode, title: r.title,
        children: r.children.filter((c) => c.id !== id && c.text && /^\d{1,14}$/.test(c.id)),
        error: null,
      };
      break;
    } catch (e) {
      record.error = String(e.message || e).slice(0, 200);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  await writeFile(cp, JSON.stringify(record), "utf8");
  return record;
}

const roots = await loadRoots();
console.log(`[harvest] roots=${roots.length} perDepthPlan=${PLAN.join("/")} concurrency=${CONCURRENCY} delay=${DELAY_MS}ms`);

const nodes = new Map(); // id -> node
for (const r of roots) nodes.set(r.id, { id: r.id, en: r.en, depth: 1, parentId: null, children: [], aliases: [] });

const leasedContext = await launchPersistentContextWithProfileLock(PROFILE, () => chromium.launchPersistentContext(PROFILE, {
  headless: true,
  channel: "chrome",
  viewport: null,
  locale: "en-US",
  timezoneId: "America/New_York",
  args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
}));
const ctx = leasedContext.context;
let fetched = 0;

try {
const pages = [];
for (let i = 0; i < CONCURRENCY; i++) pages.push(await ctx.newPage());

let cursor = 0;
let batch = [];
async function worker(page) {
  while (true) {
    const idx = cursor++;
    if (idx >= batch.length) return;
    const job = batch[idx];
    const rec = await fetchNode(page, job.id);
    if (!rec.cached) fetched++;
    if (!rec.ok) {
      console.log(`[harvest] FAIL ${job.id} ${rec.error || ""}`);
    } else {
      for (const c of rec.children) {
        let n = nodes.get(c.id);
        if (!n) {
          n = { id: c.id, en: c.text, depth: job.depth + 1, parentId: job.id, children: [], aliases: [] };
          nodes.set(c.id, n);
        } else if (n.en !== c.text && !n.aliases.includes(c.text)) {
          n.aliases.push(c.text);
        }
        if (!job.node.children.includes(c.id)) job.node.children.push(c.id);
      }
    }
    if (fetched > 0 && fetched % 25 === 0) console.log(`[harvest] fetched=${fetched} nodes=${nodes.size}`);
    if (!rec.cached) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}

// 逐层 BFS：每层按 PLAN 指定实际抓取数量，先宽后深（保证低层完整、深层有样本）。
let queue = roots.map((r) => ({ id: r.id, depth: 1, node: nodes.get(r.id) }));
for (let depth = 1; depth <= PLAN.length && queue.length; depth++) {
  batch = queue.slice(0, PLAN[depth - 1]);
  console.log(`[harvest] === depth ${depth}: queue=${queue.length} fetch=${batch.length} ===`);
  cursor = 0;
  await Promise.all(pages.map((p) => worker(p)));
  const nextQueue = [];
  const seen = new Set();
  for (const job of batch) {
    for (const cid of job.node.children) {
      const n = nodes.get(cid);
      if (n && n.depth === depth + 1 && !seen.has(cid)) { seen.add(cid); nextQueue.push({ id: cid, depth: depth + 1, node: n }); }
    }
  }
  queue = nextQueue;
  console.log(`[harvest] depth ${depth} done. next=${queue.length} nodes=${nodes.size}`);
}

} finally {
  await leasedContext.close().catch(() => {});
}

/** 全局去重 + 逐层分配：同一 Amazon node ID 在树中只出现一次（先占位 38 个一级根）。 */
const placed = new Set(roots.map((r) => r.id));
const crossLinks = [];
const rootsOut = roots.map((r) => ({
  amazonNodeId: r.id, zh: r.zh, en: r.en, sellerSpriteSearchTerm: r.ss, children: [],
}));

function assignChildren(parentOut) {
  const source = nodes.get(parentOut.amazonNodeId);
  if (!source) return;
  for (const childId of source.children) {
    if (placed.has(childId)) { crossLinks.push({ parentId: parentOut.amazonNodeId, childId }); continue; }
    const childSource = nodes.get(childId);
    if (!childSource) continue;
    placed.add(childId);
    parentOut.children.push({
      amazonNodeId: childId, en: childSource.en, aliases: childSource.aliases, children: [],
    });
  }
}

// 逐层分配：先把所有一级的子节点分完，再逐层向下，避免某个根把其他根的子树整片吞掉。
let level = rootsOut;
while (level.length > 0) {
  for (const parent of level) assignChildren(parent);
  level = level.flatMap((parent) => parent.children);
}

const countAll = (arr) => arr.reduce((s, n) => s + 1 + countAll(n.children || []), 0);
const total = countAll(rootsOut);

const snapshot = {
  schemaVersion: "amazon-us-browse-tree.raw.v1",
  marketplace: "US",
  source: {
    kind: "amazon_storefront_department_subnav",
    description: "Amazon 门店部门子导航（#nav-subnav）真实 browse node 链接；真实 Amazon node ID 与英文名。",
    baseUrl: "https://www.amazon.com",
    urlTemplate: URL_TEMPLATE("{amazonNodeId}"),
    harvestedAt: new Date().toISOString(),
    perDepthFetchPlan: PLAN,
    pagesFetchedThisRun: fetched,
  },
  stats: {
    rootCount: rootsOut.length,
    uniqueTreeNodeCount: total,
    discoveredNodeCount: nodes.size,
    crossLinkCount: crossLinks.length,
  },
  crossLinks,
  roots: rootsOut,
};
await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
console.log(`[harvest] wrote ${OUT_PATH} uniqueTreeNodeCount=${total} discovered=${nodes.size} crossLinks=${crossLinks.length} fetches=${fetched}`);
