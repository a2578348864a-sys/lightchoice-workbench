/**
 * Amazon US 类目树生成器。
 *
 * 公开仓库不附带任何类目数据。本脚本只处理**使用者自己合法取得**的输入：
 *   1) `data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json`（必需）
 *      —— Amazon 门店部门子导航采集（Amazon node ID + 英文名）；
 *   2) `data/amazon-taxonomy/amazon-us-browse-tree.sellersprite-supplement.v1.json`（可选）
 *      —— 你自行取得的补充路径；不冒充 Amazon 官方数据；
 *   3) 中文映射 `zh-phrase-overrides.v1.json` + `zh-terms*.v1.json`（可选）。
 *
 * 输出（全部留在本地，不要提交）：
 *   - `data/amazon-taxonomy/amazon-us-taxonomy.v1.json`（运行时数据）
 *   - `data/amazon-taxonomy/zh-presentation.v1.json`（中文索引）
 *   - `data/amazon-taxonomy/amazon-us-taxonomy-stats.v1.json`
 *   - `data/amazon-taxonomy/amazon-us-taxonomy-report.md`
 *
 * 中文映射确定性、可保存、可复核：整名覆盖 → 词表组合 → 「中文待确认（English）」，绝不编造。
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

const CWD = process.cwd();
const RAW_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json");
const SUPPLEMENT_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-us-browse-tree.sellersprite-supplement.v1.json");
const OVERRIDES_PATH = resolve(CWD, "data/amazon-taxonomy/zh-phrase-overrides.v1.json");
const TERMS_PATH = resolve(CWD, "data/amazon-taxonomy/zh-terms.v1.json");
const VERIFICATION_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-node-id-verification.v1.json");
const OFFICIAL_DIFF_PATH = resolve(CWD, "data/amazon-taxonomy/official-taxonomy-diff.v1.json");
const ZH_PRESENTATION_PATH = resolve(CWD, "data/amazon-taxonomy/zh-presentation.v1.json");
const OUT_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-us-taxonomy.v1.json");
const STATS_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-us-taxonomy-stats.v1.json");
const REPORT_PATH = resolve(CWD, "data/amazon-taxonomy/amazon-us-taxonomy-report.md");

const MAX_DEPTH = Number(process.env.AMAZON_TAXONOMY_MAX_DEPTH || 6);
const NODE_BUDGET = Number(process.env.AMAZON_TAXONOMY_NODE_BUDGET || 4000);
const MAX_CHILDREN_PER_NODE = 40;
const FALLBACK_PREFIX = "中文待确认";

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

if (!existsSync(RAW_PATH)) {
  console.error(
    "缺少原始类目树：data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json（公开仓库不附带任何类目数据；请放入你自己合法取得的 Amazon 类目导出/采集结果后重试）",
  );
  process.exit(1);
}
const raw = await readJson(RAW_PATH);
const overrides = existsSync(OVERRIDES_PATH) ? await readJson(OVERRIDES_PATH) : {};
// 词表可拆成多个文件（zh-terms*.v1.json），按文件名顺序合并；后面的覆盖前面的同名键。
const termFiles = existsSync(TERMS_PATH)
  ? (await readdir(dirname(TERMS_PATH))).filter((f) => /^zh-terms.*\.json$/u.test(f)).sort().reverse()
  : [];
const terms = {};
for (const file of termFiles) Object.assign(terms, await readJson(resolve(dirname(TERMS_PATH), file)));
const supplement = existsSync(SUPPLEMENT_PATH) ? await readJson(SUPPLEMENT_PATH) : null;
const verification = existsSync(VERIFICATION_PATH) ? await readJson(VERIFICATION_PATH) : null;
const officialDiff = existsSync(OFFICIAL_DIFF_PATH) ? await readJson(OFFICIAL_DIFF_PATH) : null;

// ── 来源 1：Amazon 门店（节点级子导航）─────────────────────────
const storefrontChildren = new Map();
const names = new Map();
(function walkStorefront(nodes, parentId) {
  for (const node of nodes) {
    const id = String(node.amazonNodeId);
    names.set(id, node.en);
    const childIds = (node.children || []).map((c) => String(c.amazonNodeId));
    storefrontChildren.set(id, childIds);
    if (parentId) { /* 父级边由父节点登记，这里只登记向下 */ }
    walkStorefront(node.children || [], id);
  }
})(raw.roots, null);

// ── 来源 2：SellerSprite 补充（Amazon node ID 键）────────────────
const supplementChildren = new Map();
let supplementParentCount = 0;
for (const edge of supplement?.edges ?? []) {
  const parentId = String(edge.parentId);
  if (!supplementChildren.has(parentId)) supplementChildren.set(parentId, []);
  supplementParentCount++;
  for (const child of edge.children) {
    const id = String(child.amazonNodeId);
    if (!names.has(id)) names.set(id, child.en);
    supplementChildren.get(parentId).push(id);
  }
}

// ── 中英映射（确定性）─────────────────────────────────────────
function translateName(en) {
  const exact = overrides[en];
  if (typeof exact === "string" && exact.trim()) return { zh: exact.trim(), method: "override" };
  const composed = compose(en);
  if (composed) return { zh: composed, method: "composed" };
  return { zh: `${FALLBACK_PREFIX}（${en}）`, method: "fallback" };
}
function compose(en) {
  const norm = en.replace(/\s+/g, " ").trim();
  const out = [];
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === " ") { i++; continue; }
    if (ch === "'" || ch === "\u2019") { i++; continue; }
    if (ch === "&" || ch === "/") { out.push("与"); i++; continue; }
    if (ch === ",") { out.push("、"); i++; continue; }
    let matched = null;
    for (let len = Math.min(30, norm.length - i); len >= 2; len--) {
      const slice = norm.slice(i, i + len).toLowerCase();
      if (terms[slice]) { matched = { len, zh: terms[slice] }; break; }
    }
    if (!matched) return null;
    out.push(matched.zh);
    i += matched.len;
  }
  const joined = out.join("");
  return joined.length > 0 && joined.length <= 60 ? joined : null;
}
function toSearchTerm(en) {
  return en.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 8).join(" ");
}

// ── 组装树：门店优先，SellerSprite 补充补深（含「广播」剪枝）─────
const stats = {
  rootCount: 0, totalNodeCount: 0, level2Count: 0, level3Count: 0, level4PlusCount: 0, maxDepth: 0,
  rootsWithoutChildren: [], duplicateAmazonNodeIds: [], missingZhCount: 0, missingEnCount: 0,
  zhOverrideCount: 0, zhComposedCount: 0, zhFallbackCount: 0, zhCoveragePercent: 0,
  provenanceCounts: { amazon_storefront: 0, sellersprite_supplement: 0 },
  prunedBroadcastEdges: 0, nodeBudgetReached: false,
};
const placed = new Set(raw.roots.map((r) => String(r.amazonNodeId)));

/** 判断节点的门店导航是否为「父级门店导航的广播」（非节点专属）。 */
const isBroadcast = (parentId, candidate) => {
  if (!parentId) return false;
  const parentSet = new Set(storefrontChildren.get(parentId) || []);
  if (parentSet.size === 0 || candidate.length === 0) return false;
  return candidate.every((id) => parentSet.has(id) || id === parentId);
};

function pickChildren(nodeId, depth, parentId) {
  const store = storefrontChildren.get(nodeId) ?? [];
  const supp = supplementChildren.get(nodeId) ?? [];
  let ids = [];
  if (store.length > 0 && !isBroadcast(parentId, store)) ids = [...store];
  else if (store.length > 0) stats.prunedBroadcastEdges += store.length;
  // 两个来源取并集：门店导航负责权威层级，SellerSprite 补充负责补足门店 SSR 未暴露的层级。
  for (const id of supp) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, MAX_CHILDREN_PER_NODE);
}

const rootsOut = raw.roots.map((root) => {
  const id = String(root.amazonNodeId);
  return { amazonNodeId: id, zh: root.zh, en: root.en, sellerSpriteSearchTerm: root.sellerSpriteSearchTerm, children: [] };
});
const outById = new Map(rootsOut.map((n) => [n.amazonNodeId, n]));
const parentOf = new Map();

function materialize(id, en) {
  const { zh, method } = translateName(en);
  if (method === "override") stats.zhOverrideCount++;
  else if (method === "composed") stats.zhComposedCount++;
  else stats.zhFallbackCount++;
  if (!zh) stats.missingZhCount++;
  if (!en) stats.missingEnCount++;
  return { amazonNodeId: id, zh, en, sellerSpriteSearchTerm: toSearchTerm(en), children: [] };
}

stats.rootCount = rootsOut.length;
let level = rootsOut.map((n) => ({ out: n, depth: 1 }));
while (level.length > 0 && !stats.nodeBudgetReached) {
  const next = [];
  for (const { out, depth } of level) {
    if (depth >= MAX_DEPTH) continue;
    for (const childId of pickChildren(out.amazonNodeId, depth, parentOf.get(out.amazonNodeId) ?? null)) {
      if (placed.has(childId)) continue;
      if (placed.size >= NODE_BUDGET) { stats.nodeBudgetReached = true; break; }
      placed.add(childId);
      const isSupp = !(storefrontChildren.get(out.amazonNodeId) || []).includes(childId) && supplementChildren.get(out.amazonNodeId)?.includes(childId);
      stats.provenanceCounts[isSupp ? "sellersprite_supplement" : "amazon_storefront"]++;
      const child = materialize(childId, names.get(childId) ?? "");
      out.children.push(child);
      outById.set(childId, child);
      parentOf.set(childId, out.amazonNodeId);
      next.push({ out: child, depth: depth + 1 });
    }
  }
  level = next;
}

// 根节点中文/统计（roots.v1.json 已带 zh）
for (const root of raw.roots) {
  const out = outById.get(String(root.amazonNodeId));
  if (!out) continue;
  if ((out.children || []).length === 0) stats.rootsWithoutChildren.push(out.amazonNodeId);
}

// 全树统计（只按树结构统计一次，node ID 唯一性单独校验）
(function walk(nodes, depth) {
  for (const node of nodes) {
    stats.totalNodeCount++;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    if (depth === 2) stats.level2Count++;
    else if (depth === 3) stats.level3Count++;
    else if (depth >= 4) stats.level4PlusCount++;
    walk(node.children || [], depth + 1);
  }
})(rootsOut, 1);

const idList = [];
(function collect(nodes) { for (const n of nodes) { idList.push(n.amazonNodeId); collect(n.children || []); } })(rootsOut);
const seenIds = new Set();
const duplicates = new Set();
for (const id of idList) { if (seenIds.has(id)) duplicates.add(id); seenIds.add(id); }
stats.duplicateAmazonNodeIds = [...duplicates];
stats.zhOverrideCount += stats.rootCount; // 一级类目的中文来自人工校订的 roots.v1.json

// ── 中文覆盖：把「待确认」单独统计，不用 missingZhCount=0 掩盖 ──────────
stats.pendingZhCount = (function countPending(nodes) {
  return nodes.reduce((sum, n) => sum + (n.zh.startsWith(FALLBACK_PREFIX) ? 1 : 0) + countPending(n.children || []), 0);
})(rootsOut);
stats.translatedZhCount = stats.totalNodeCount - stats.pendingZhCount;
stats.zhCoverageRate = Number(((stats.translatedZhCount / stats.totalNodeCount) * 100).toFixed(1));
stats.zhCoveragePercent = stats.zhCoverageRate; // 兼容旧字段名

// ── 每个一级类目的子节点状态（不宣称 Amazon 官方绝对无子类）──────────────
const ROOTS_OUT = rootsOut.map((node) => ({
  amazonNodeId: node.amazonNodeId,
  en: node.en,
  zh: node.zh,
  childStatus: (node.children || []).length > 0 ? "HAS_CHILDREN" : "NO_CHILD_IN_CURRENT_SOURCES",
  childCount: (node.children || []).length,
}));
stats.rootsChildStatus = ROOTS_OUT;

// ── SellerSprite 展示用中文索引：树节点 + 人工词表 + 补充来源的全部英文名 ──
const nameIndex = new Map();
const normalize = (s) => String(s).toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const addIndex = (en, zh) => {
  if (!en || !zh || zh.startsWith(FALLBACK_PREFIX)) return;
  const key = normalize(en);
  if (key && !nameIndex.has(key)) nameIndex.set(key, zh);
};
(function collectNames(nodes) { for (const n of nodes) { addIndex(n.en, n.zh); collectNames(n.children || []); } })(rootsOut);
for (const [en, zh] of Object.entries(overrides)) addIndex(en, zh);
for (const edge of supplement?.edges ?? []) {
  if (edge.parentEn) addIndex(edge.parentEn, translateName(edge.parentEn).zh);
  for (const child of edge.children) addIndex(child.en, translateName(child.en).zh);
}
// 常见等价后缀：把「X & Accessories」这类别名也指向 X 的中文
for (const [key, zh] of [...nameIndex.entries()]) {
  for (const suffix of [" & accessories", " & supplies", " & parts", " products", " store", " and accessories"]) {
    if (key.endsWith(suffix)) addIndex(key.slice(0, -suffix.length), zh);
  }
}

// ── 官方完整性状态：只有与官方完整 Browse Tree diff 完成才允许 COMPLETE ──
const officialStatus = officialDiff?.status ?? "OFFICIAL_SNAPSHOT_UNAVAILABLE";
const taxonomyStatus = officialStatus === "DIFF_COMPLETED" ? "COMPLETE" : "INTERIM_HIGH_COVERAGE";
stats.taxonomyStatus = taxonomyStatus;
stats.officialDiffStatus = officialStatus;


const out = {
  schemaVersion: "amazon-us-taxonomy.v1",
  marketplace: "US",
  generatedAt: new Date().toISOString(),
  generator: "scripts/taxonomy/generate-amazon-us-category-tree.mjs",
  // 只有与 Amazon 官方完整 Browse Tree 完成 diff 才允许 COMPLETE；否则一律 INTERIM_HIGH_COVERAGE。
  taxonomyStatus,
  amazonUsTaxonomy: taxonomyStatus,
  officialDiff: officialDiff ? {
    status: officialDiff.status,
    officialNodeCount: officialDiff.officialNodeCount,
    missingCount: officialDiff.missingCount,
    extraOrSuspiciousCount: officialDiff.extraOrSuspiciousCount,
    idNameConflictCount: officialDiff.idNameConflictCount,
    requiredToComplete: officialDiff.requiredToComplete ?? null,
    attempts: officialDiff.attempts ?? null,
  } : null,
  source: {
    ...raw.source,
    snapshot: "data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json",
    supplement: supplement ? {
      kind: supplement.source.kind,
      description: supplement.source.description,
      queriedAt: supplement.source.queriedAt,
      queryCount: supplement.source.queryCount,
      failureCount: supplement.source.failureCount,
      parentCount: supplementParentCount,
    } : null,
    zhMap: "data/amazon-taxonomy/zh-phrase-overrides.v1.json + zh-terms*.v1.json",
    zhPresentation: "data/amazon-taxonomy/zh-presentation.v1.json",
    officialBrowseTree: officialDiff?.officialSource?.path ?? null,
  },
  stats,
  roots: rootsOut,
};

await mkdir(dirname(OUT_PATH), { recursive: true });
const compact = (n) => ({ i: n.amazonNodeId, z: n.zh, e: n.en, s: n.sellerSpriteSearchTerm, c: (n.children || []).map(compact) });
out.roots = rootsOut.map(compact);
await writeFile(OUT_PATH, JSON.stringify(out), "utf8");

// 客户端展示用中文索引（SellerSprite 路径分段逐段翻译）
await writeFile(ZH_PRESENTATION_PATH, JSON.stringify({
  schemaVersion: "amazon-zh-presentation.v1",
  generatedAt: out.generatedAt,
  nameIndex: Object.fromEntries(nameIndex),
  terms,
  notes: "nameIndex 覆盖 Amazon 门店 + SellerSprite 补充的全部英文名与人工词表；未命中再用 terms 做确定性组合；仍未命中则保留英文原文并计入 untranslatedSegments。",
}), "utf8");

await writeFile(STATS_PATH, JSON.stringify({
  schemaVersion: "amazon-us-taxonomy-stats.v1", generatedAt: out.generatedAt, marketplace: "US", source: out.source, stats,
}, null, 2), "utf8");

const md = `# Amazon US 类目树数据报告（自动生成）

> **TAXONOMY_STATUS = ${taxonomyStatus}**
>
> ${taxonomyStatus === "COMPLETE"
    ? "已与 Amazon 官方完整 Browse Tree 完成 diff 且无差异。"
    : "**这不是 Amazon 官方完整全树**。当前为「多来源采样 + 高覆盖」的中期状态；只有与可验证的 Amazon 官方完整 Browse Tree 完成 diff 并清零差异后，才允许标记 COMPLETE。"}
> 官方 diff 状态：\`${officialStatus}\`${officialDiff?.officialNodeCount ? `（官方节点 ${officialDiff.officialNodeCount}，缺失 ${officialDiff.missingCount}，多余/可疑 ${officialDiff.extraOrSuspiciousCount}，ID/名称冲突 ${officialDiff.idNameConflictCount}）` : ""}

## 数据来源（两个来源，均以 Amazon browse node ID 为键）

1. **Amazon 门店部门子导航**（主）：\`${raw.source.description}\`
   - 入口：${raw.source.urlTemplate}
   - 采集时间：${raw.source.harvestedAt}
2. **SellerSprite 类目搜索补充**（补深，不冒充 Amazon 官方发布数据）：
   ${supplement ? `查询 ${supplement.source.queryCount} 次、失败 ${supplement.source.failureCount} 次，采集时间 ${supplement.source.queriedAt}；入口 \`${supplement.source.endpoint}\`。` : "（本次未提供补充数据）"}

生成时间：${out.generatedAt}

## 关键统计

| 指标 | 值 |
| --- | --- |
| **TAXONOMY_STATUS** | **${taxonomyStatus}** |
| Amazon 一级类目数（rootCount） | ${stats.rootCount} |
| 全树节点数（totalNodeCount） | ${stats.totalNodeCount} |
| 二级节点数（level2Count） | ${stats.level2Count} |
| 三级节点数（level3Count） | ${stats.level3Count} |
| 四级及以上节点数（level4PlusCount） | ${stats.level4PlusCount} |
| 最大深度（maxDepth） | ${stats.maxDepth} |
| 重复 node ID（duplicateAmazonNodeIds） | ${stats.duplicateAmazonNodeIds.length} |
| **translatedZhCount（已翻译）** | **${stats.translatedZhCount}** |
| **pendingZhCount（中文待确认）** | **${stats.pendingZhCount}** |
| **zhCoverageRate** | **${stats.zhCoverageRate}%** |
| 中文来源明细 | 词典覆盖 ${stats.zhOverrideCount} / 词表组合 ${stats.zhComposedCount} / 待确认 ${stats.zhFallbackCount} |
| 缺失英文（missingEnCount） | ${stats.missingEnCount} |
| 来源分布 | Amazon 门店 ${stats.provenanceCounts.amazon_storefront} / SellerSprite 补充 ${stats.provenanceCounts.sellersprite_supplement} |
| 广播边剪枝（非节点专属导航，已丢弃） | ${stats.prunedBroadcastEdges} |

## 一级类目子节点状态

\`NO_CHILD_IN_CURRENT_SOURCES\` 只表示**当前两个来源都没有取到子类目**，不代表 Amazon 官方绝对无子类。

| node ID | 英文名 | 中文名 | 子节点数 | 状态 |
| --- | --- | --- | --- | --- |
${ROOTS_OUT.map((r) => `| ${r.amazonNodeId} | ${r.en} | ${r.zh} | ${r.childCount} | ${r.childStatus} |`).join("\n")}

## Amazon 侧核验（node ID → 英文名）

${verification
    ? `抽样 ${verification.sampleSize} 个 node ID 回 Amazon 门店页面核验：完全匹配 ${verification.verifiedCount}、
语义一致（标题用词不同） ${verification.partialCount}、无法判定 ${verification.inconclusiveCount}、不一致 ${verification.mismatchCount}。
核验时间 ${verification.verifiedAt}，明细见 \`data/amazon-taxonomy/amazon-node-id-verification.v1.json\`。`
    : "（本次未运行核验脚本）"}

${verification?.mismatchInvestigation
    ? `未完全匹配节点已逐个查清（见 \`amazon-node-id-verification-notes.md\`）：调查 ${verification.mismatchInvestigation.investigatedCount} 个，结论分布 ${JSON.stringify(verification.mismatchInvestigation.byVerdict)}；其中 \`wrong_id\` 数量 = ${verification.mismatchInvestigation.byVerdict.wrong_id ?? 0}。`
    : ""}

## 官方完整性 diff 说明

${officialDiff?.status === "OFFICIAL_SNAPSHOT_UNAVAILABLE"
    ? `当前**没有可验证的 Amazon 官方完整 Browse Tree 快照**，因此不能判定 COMPLETE。已尝试并留证：

${(officialDiff.attempts ?? []).map((a) => `- ${a.source} → ${a.result}（${a.sampledAt}）`).join("\n")}

拿到官方快照后运行（只补差异，不改采集系统）：

\`\`\`bash
${(officialDiff.requiredToComplete ?? []).slice(2).join("\n")}
\`\`\``
    : `官方 diff 状态：${officialStatus}；缺失 ${officialDiff?.missingCount ?? "-"}、多余/可疑 ${officialDiff?.extraOrSuspiciousCount ?? "-"}、ID/名称冲突 ${officialDiff?.idNameConflictCount ?? "-"}。`}

## 诚实说明

- Amazon 门店 SSR 只暴露「门店级」子导航：一级类目能稳定拿到二级，部分门店（如 Electronics）
  的门店导航是分层的，可继续拿到三级；但 Home & Kitchen、Toys 等门店是扁平导航，
  需要 SellerSprite 补充才拿得到更深层级。
- 所有 node ID 均为 Amazon browse node ID；SellerSprite 返回的路径由 Amazon node ID 串成，
  其中 \`1055398:284507:510136\` 这类路径与 Amazon 门店可核对的节点一致。
- 中文映射为确定性产物（人工词表 + 词表组合），未命中才落「中文待确认（English）」，
  且 \`pendingZhCount\` 单列统计，不用 \`missingZhCount=0\` 掩盖。
`;
await mkdir(dirname(REPORT_PATH), { recursive: true });
await writeFile(REPORT_PATH, md, "utf8");

console.log(JSON.stringify({ out: OUT_PATH, stats }, null, 2));
