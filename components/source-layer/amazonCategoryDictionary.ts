/**
 * Amazon US 类目树（运行时读取生成产物）。
 *
 * 数据不是手写的：由 `scripts/taxonomy/harvest-amazon-us-taxonomy.mjs` 从 Amazon 门店
 * 部门子导航采集真实 browse node，再由 `scripts/taxonomy/generate-amazon-us-category-tree.mjs`
 * 生成 `data/amazon-taxonomy/amazon-us-taxonomy.v1.json`（含来源、快照时间、统计、状态）。
 *
 * 公开仓库**不附带任何第三方类目数据**：默认两份 JSON 只有空 schema（roots: []），
 * 使用者用自己合法取得的类目树运行生成脚本后才会出现数据。
 * 因此 `TAXONOMY_STATUS` 可能是 `NOT_IMPORTED`；此时界面必须展示空状态与导入提示，而不是崩溃。
 *
 * 边界：这里只承载 Amazon 自己的 browse node ID 与名称；SellerSprite 的节点 ID 来自
 * SellerSprite 接口，两者永不混用。
 */
import taxonomyData from "@/data/amazon-taxonomy/amazon-us-taxonomy.v1.json";
import zhPresentation from "@/data/amazon-taxonomy/zh-presentation.v1.json";

export type AmazonCategoryNode = {
  amazonNodeId: string;
  zh: string;
  en: string;
  sellerSpriteSearchTerm: string;
  children: AmazonCategoryNode[];
};

type CompactAmazonCategoryNode = {
  i: string;
  z: string;
  e: string;
  s: string;
  c: CompactAmazonCategoryNode[];
};

function toAmazonCategoryNode(node: CompactAmazonCategoryNode): AmazonCategoryNode {
  return {
    amazonNodeId: node.i,
    zh: node.z,
    en: node.e,
    sellerSpriteSearchTerm: node.s,
    children: node.c.map(toAmazonCategoryNode),
  };
}

export const AMAZON_CATEGORY_DICTIONARY: AmazonCategoryNode[] =
  (taxonomyData.roots as CompactAmazonCategoryNode[]).map(toAmazonCategoryNode);

export type AmazonTaxonomyStats = {
  rootCount: number;
  totalNodeCount: number;
  maxDepth: number;
  zhCoverageRate: number;
  translatedZhCount: number;
  pendingZhCount: number;
  missingZhCount: number;
  missingEnCount: number;
  rootsChildStatus: ReadonlyArray<{ amazonNodeId: string; childStatus: string; childCount: number }>;
  rootsWithoutChildren: ReadonlyArray<string>;
  level2Count?: number;
  level3Count?: number;
  duplicateAmazonNodeIds?: number;
};

/** 数据来源与覆盖统计（用于展示与测试门禁）。空数据时为零值，不虚构统计。 */
export const AMAZON_CATEGORY_TAXONOMY_META = {
  schemaVersion: taxonomyData.schemaVersion as string,
  taxonomyStatus: taxonomyData.taxonomyStatus as TaxonomyStatus,
  amazonUsTaxonomy: taxonomyData.amazonUsTaxonomy as string,
  officialDiff: taxonomyData.officialDiff as { status?: string } & Record<string, unknown>,
  marketplace: taxonomyData.marketplace as string,
  generatedAt: taxonomyData.generatedAt as string | null,
  source: taxonomyData.source as { kind: string; harvestedAt: string | null } & Record<string, unknown>,
  stats: taxonomyData.stats as unknown as AmazonTaxonomyStats,
};

export type TaxonomyStatus = "NOT_IMPORTED" | "INTERIM_HIGH_COVERAGE" | "COMPLETE";
export const TAXONOMY_STATUS = AMAZON_CATEGORY_TAXONOMY_META.taxonomyStatus as TaxonomyStatus;

/** 是否已导入类目数据（公开仓库默认 false）。 */
export const AMAZON_TAXONOMY_IMPORTED = AMAZON_CATEGORY_DICTIONARY.length > 0;

export function findAmazonCategoryByAmazonNodeId(amazonNodeId: string): AmazonCategoryNode | null {
  function visit(nodes: AmazonCategoryNode[]): AmazonCategoryNode | null {
    for (const node of nodes) {
      if (node.amazonNodeId === amazonNodeId) return node;
      const child = visit(node.children);
      if (child) return child;
    }
    return null;
  }

  return visit(AMAZON_CATEGORY_DICTIONARY);
}

export function findAmazonCategoryPathByAmazonNodeId(amazonNodeId: string): AmazonCategoryNode[] {
  function visit(nodes: AmazonCategoryNode[], path: AmazonCategoryNode[]): AmazonCategoryNode[] | null {
    for (const node of nodes) {
      const nextPath = [...path, node];
      if (node.amazonNodeId === amazonNodeId) return nextPath;
      const childPath = visit(node.children, nextPath);
      if (childPath) return childPath;
    }
    return null;
  }

  return visit(AMAZON_CATEGORY_DICTIONARY, []) ?? [];
}

// ── SellerSprite 类目路径的中文优先展示 ─────────────────────────────
// 用生成期产出的确定性中文索引（覆盖 Amazon 门店 + SellerSprite 补充的全部英文名与人工词表），
// 未命中再用词表做最长匹配组合；仍无法翻译才保留英文原文，并计入 untranslatedSegments。
const NAME_INDEX: Record<string, string> = zhPresentation.nameIndex as Record<string, string>;
const TERMS: Record<string, string> = zhPresentation.terms as Record<string, string>;

const SEGMENT_SPLIT = /[:>]|\s+>\s+/;
const GENERIC_SUFFIXES = [" & accessories", " & supplies", " & parts", " & equipment", " products", " store", " and accessories"];

function normalizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 词表最长匹配组合（与生成期同一算法）；任一片段未登录即放弃，避免生造。 */
function composeSegment(segment: string): string | null {
  const norm = segment.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === " ") { i += 1; continue; }
    if (ch === "'" || ch === "\u2019") { i += 1; continue; }
    if (ch === "&" || ch === "/") { parts.push("与"); i += 1; continue; }
    if (ch === ",") { parts.push("、"); i += 1; continue; }
    let matched: { len: number; zh: string } | null = null;
    for (let len = Math.min(30, norm.length - i); len >= 2; len -= 1) {
      const slice = norm.slice(i, i + len).toLowerCase();
      const hit = TERMS[slice];
      if (hit) { matched = { len, zh: hit }; break; }
    }
    if (!matched) return null;
    parts.push(matched.zh);
    i += matched.len;
  }
  const joined = parts.join("");
  return joined.length > 0 && joined.length <= 60 ? joined : null;
}

/** 把单个英文类目段翻成中文；无法可靠翻译返回 null。 */
export function translateCategorySegment(segment: string): string | null {
  const key = normalizeSegment(segment);
  if (!key) return null;
  const direct = NAME_INDEX[key];
  if (direct) return direct;
  for (const suffix of GENERIC_SUFFIXES) {
    if (key.endsWith(suffix)) {
      const hit = NAME_INDEX[key.slice(0, -suffix.length).trim()];
      if (hit) return hit;
    }
  }
  if (key.endsWith("s")) {
    const hit = NAME_INDEX[key.slice(0, -1)];
    if (hit) return hit;
  }
  return composeSegment(segment);
}

export type BilingualCategoryLabel = {
  /** 中文优先路径；确实无法翻译的片段保留英文原文。 */
  zhPath: string;
  /** 英文原始路径（SellerSprite 返回的原始 label 语义，仅分隔符规范化）。 */
  enPath: string;
  matchedSegmentCount: number;
  totalSegmentCount: number;
  fullyMatched: boolean;
  /** 仍然裸露英文的片段（应为「确实无译名」才出现）。 */
  untranslatedSegments: string[];
};

/**
 * 把 SellerSprite 的类目 label（如 `Collectibles & Fine Art:Sports:Trading Cards`）
 * 转成中文优先的双语展示。原始 label 只做分隔符展示层规范化，不做任何篡改。
 */
export function presentSellerSpriteCategoryLabel(label: string): BilingualCategoryLabel {
  const segments = label
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const translated = segments.map((segment) => translateCategorySegment(segment));
  const untranslatedSegments = segments.filter((segment, index) => translated[index] === null);
  const zhSegments = segments.map((segment, index) => translated[index] ?? segment);

  return {
    zhPath: zhSegments.join(" > "),
    enPath: segments.join(" > "),
    matchedSegmentCount: segments.length - untranslatedSegments.length,
    totalSegmentCount: segments.length,
    fullyMatched: segments.length > 0 && untranslatedSegments.length === 0,
    untranslatedSegments,
  };
}
