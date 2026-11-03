/**
 * Amazon 选中类目 ↔ SellerSprite 候选节点 的确定性匹配。
 *
 * 约束：
 * - 禁止 `candidates[0]` / 返回顺序 / 单词相同 / 同属大类 作为匹配依据。
 * - Amazon `amazonNodeId` 与 SellerSprite `node.id` 在存储契约上严格分离
 *   （采集 `categoryId` 始终是 SellerSprite 节点 ID）。
 * - SellerSprite `node.id` 本身是 Amazon browse node ID 路径（`:` 串联），
 *   因此允许用路径末段 / 路径包含关系做可信对应，但不把两者写成同一个字段。
 */

export type SellerSpriteMatchType =
  | "EXACT_NODE_MATCH"
  | "PATH_MATCH"
  | "SEMANTIC_PATH_MATCH"
  | "UNCONFIRMED";

export type SellerSpriteCandidateMatch = {
  matchType: SellerSpriteMatchType;
  /** 可信对应（EXACT / PATH / SEMANTIC）才允许采集。 */
  trusted: boolean;
  score: number;
  reason: string;
  /** 与当前 Amazon 选择明显冲突（如 Automotive vs Cell Phones）。 */
  conflicting: boolean;
  /** 验收/报告用：末级 ID、路径段、归一化英文路径。 */
  details: {
    sellerSpriteIdPathSegments: string[];
    sellerSpriteLeafId: string | null;
    sellerSpriteLabelSegments: string[];
    amazonNodeId: string;
    amazonPathEn: string[];
    normalizedAmazonPath: string;
    normalizedSellerSpritePath: string;
  };
};

export type SellerSpriteCandidateInput = {
  id: string;
  label: string;
};

export type AmazonCategorySelectionInput = {
  amazonNodeId: string;
  /** 英文完整路径段，自根到叶。 */
  amazonPathEn: readonly string[];
};

const MAX_AMAZON_PATH_SEGMENTS = 12;
const SEMANTIC_PATH_MIN_SCORE = 0.84;

/** Query text only: retain the full selected path; identity still uses original IDs/labels. */
export function buildSellerSpriteCategoryLookupQuery(amazonPathEn: readonly string[]): string {
  const tokens = amazonPathEn.join(" ").replace(/&amp;/g, " ").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/);
  const seen = new Set<string>();
  return tokens.filter(token => {
    const key = token.toLowerCase();
    if (!key || key === "and" || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(" ").slice(0, 120).trim();
}

/** 归一化英文类目段：小写、去标点、统一 & 与空白。 */
export function normalizeCategoryPathSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategoryPath(path: readonly string[]): string {
  return path
    .map(normalizeCategoryPathSegment)
    .filter((segment) => segment.length > 0)
    .join(" > ");
}

function splitSellerSpriteIdPath(id: string): string[] {
  return id
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitSellerSpriteLabel(label: string): string[] {
  return label
    .split(/[:>]|\s+>\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 路径相似度：按段对齐的加权 Jaccard（尾段权重更高）。 */
function pathSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left.map(normalizeCategoryPathSegment).filter(Boolean));
  const rightSet = new Set(right.map(normalizeCategoryPathSegment).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  const leftTail = normalizeCategoryPathSegment(left.at(-1) ?? "");
  const rightTail = normalizeCategoryPathSegment(right.at(-1) ?? "");
  const tailBonus = leftTail && leftTail === rightTail ? 0.25 : 0;

  // 根段完全一致才有基础可信度；仅同大类不足以匹配。
  const leftRoot = normalizeCategoryPathSegment(left[0] ?? "");
  const rightRoot = normalizeCategoryPathSegment(right[0] ?? "");
  const rootPenalty = leftRoot && rightRoot && leftRoot !== rightRoot ? 0.45 : 0;

  return Math.max(0, Math.min(1, jaccard * 0.9 + tailBonus - rootPenalty));
}

function isObviousCrossDepartmentConflict(
  amazonPath: readonly string[],
  sellerSpritePath: readonly string[],
): boolean {
  const amazonRoot = normalizeCategoryPathSegment(amazonPath[0] ?? "");
  const sellerRoot = normalizeCategoryPathSegment(sellerSpritePath[0] ?? "");
  if (!amazonRoot || !sellerRoot) return false;
  if (amazonRoot === sellerRoot) return false;
  // 根段不同且无任何叶子/中间段重合 → 明显跨部门冲突。
  const amazonSet = new Set(amazonPath.map(normalizeCategoryPathSegment).filter(Boolean));
  const overlap = sellerSpritePath.some((segment) => amazonSet.has(normalizeCategoryPathSegment(segment)));
  return !overlap;
}

/**
 * 确定性匹配。绝不回落到「第一条候选」。
 */
export function matchSellerSpriteCandidate(input: {
  amazon: AmazonCategorySelectionInput;
  candidate: SellerSpriteCandidateInput;
}): SellerSpriteCandidateMatch {
  const amazonNodeId = typeof input?.amazon?.amazonNodeId === "string" ? input.amazon.amazonNodeId.trim() : "";
  const amazonPathEn = Array.isArray(input?.amazon?.amazonPathEn)
    ? input.amazon.amazonPathEn
      .slice(0, MAX_AMAZON_PATH_SEGMENTS)
      .map((segment) => String(segment ?? "").trim())
      .filter((segment) => segment.length > 0)
    : [];

  const candidateId = typeof input?.candidate?.id === "string" ? input.candidate.id.trim() : "";
  const candidateLabel = typeof input?.candidate?.label === "string" ? input.candidate.label.trim() : "";

  const idSegments = splitSellerSpriteIdPath(candidateId);
  const labelSegments = splitSellerSpriteLabel(candidateLabel);
  const leafId = idSegments.at(-1) ?? null;
  const normalizedAmazonPath = normalizeCategoryPath(amazonPathEn);
  const normalizedSellerSpritePath = normalizeCategoryPath(labelSegments.length > 0 ? labelSegments : idSegments);

  const details = {
    sellerSpriteIdPathSegments: idSegments,
    sellerSpriteLeafId: leafId,
    sellerSpriteLabelSegments: labelSegments,
    amazonNodeId,
    amazonPathEn,
    normalizedAmazonPath,
    normalizedSellerSpritePath,
  };

  if (!amazonNodeId || !candidateId || amazonPathEn.length === 0) {
    return {
      matchType: "UNCONFIRMED",
      trusted: false,
      score: 0,
      reason: "缺少 Amazon 类目或 SellerSprite 候选的完整上下文，无法建立可信对应。",
      conflicting: false,
      details,
    };
  }

  // A. 末级 ID === Amazon amazonNodeId
  if (leafId && leafId === amazonNodeId) {
    return {
      matchType: "EXACT_NODE_MATCH",
      trusted: true,
      score: 1,
      reason: "SellerSprite ID 路径末级与当前 Amazon 节点 ID 一致。",
      conflicting: false,
      details,
    };
  }

  const idPathContainsAmazon = idSegments.includes(amazonNodeId);
  const labelPath = labelSegments.length > 0 ? labelSegments : idSegments;
  const semanticScore = pathSimilarity(amazonPathEn, labelPath);
  const conflicting = isObviousCrossDepartmentConflict(amazonPathEn, labelPath);

  // B. ID path 包含 amazonNodeId + 英文路径语义一致
  if (idPathContainsAmazon && !conflicting && semanticScore >= 0.45) {
    return {
      matchType: "PATH_MATCH",
      trusted: true,
      score: Math.max(0.72, semanticScore),
      reason: "SellerSprite ID 路径包含当前 Amazon 节点 ID，且英文类目路径语义一致。",
      conflicting: false,
      details,
    };
  }

  // C. 英文完整路径归一化后高度一致
  if (!conflicting && semanticScore >= SEMANTIC_PATH_MIN_SCORE) {
    return {
      matchType: "SEMANTIC_PATH_MATCH",
      trusted: true,
      score: semanticScore,
      reason: "英文完整类目路径归一化后高度一致。",
      conflicting: false,
      details,
    };
  }

  if (conflicting) {
    return {
      matchType: "UNCONFIRMED",
      trusted: false,
      score: semanticScore,
      reason: "该 SellerSprite 节点与当前 Amazon 类目不匹配（跨部门冲突）。",
      conflicting: true,
      details,
    };
  }

  return {
    matchType: "UNCONFIRMED",
    trusted: false,
    score: semanticScore,
    reason: "未找到可信的 Amazon ↔ SellerSprite 节点对应关系，需人工确认。",
    conflicting: false,
    details,
  };
}

export function isTrustedSellerSpriteMatch(match: SellerSpriteCandidateMatch | null | undefined): boolean {
  return Boolean(match && match.trusted && !match.conflicting && match.matchType !== "UNCONFIRMED");
}

export function sellerSpriteMatchBadge(match: SellerSpriteCandidateMatch): string | null {
  if (match.matchType === "EXACT_NODE_MATCH") return "精确节点匹配";
  if (match.matchType === "PATH_MATCH" || match.matchType === "SEMANTIC_PATH_MATCH") return "推荐匹配";
  return null;
}
