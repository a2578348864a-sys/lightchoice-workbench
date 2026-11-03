import type { ResearchEngineInput, ResearchNarrative } from "@/lib/research/researchContracts";

/**
 * 评论星级统计的**确定性**校验。
 *
 * 权威口径只认 `researchInputBundle.customerVoiceEvidence`：它带来源、附件身份、星级、
 * externalContentId 与 contentHash，是本次研究**实际读到**的评论集合。
 * 明确不混用：商品页总体评分、累计评价数、SellerSprite 估算评论数都不是这个口径。
 *
 * 2026-10-29 两轮修正（都是真实数据打出来的）：
 *  1. 旧实现注释说「按 externalContentId 去重」，代码却直接累加观察记录 —— 注释与实现矛盾。
 *     现在按 `source + externalContentId` 去重，并把「同 ID 不同星级/内容」记为冲突。
 *  2. 旧实现用「分项合计 ≠ 总数」判错：会把**正确的部分描述**（「共 9 条，其中 7 条五星」）
 *     判成错误，又会把重复表述（「7 条五星……这 7 条五星」）累加成 14 条。
 *     现在不做合计推断，**逐条声明各自**与权威事实比对；同一事实重复表述不会累加。
 */

export type CommentRatingKey = "1" | "2" | "3" | "4" | "5" | "unknown";

export type CommentIdentityIssue = {
  readonly code: "DUPLICATE_CONFLICTING_RATING" | "DUPLICATE_CONFLICTING_CONTENT" | "MISSING_IDENTITY";
  /** 身份键或原始索引，便于人工回查。 */
  readonly identity: string;
  readonly detail: string;
};

export type AuthoritativeCommentStats = {
  /** 去重后的评论条数；只统计身份可识别的观察。 */
  readonly total: number;
  readonly byRating: Readonly<Record<CommentRatingKey, number>>;
  readonly attachmentCount: number;
  /** 身份有冲突、无法合并的键（保留旧字段名，语义收敛为「有冲突的」）。 */
  readonly duplicateExternalIds: readonly string[];
  /** 被合并掉的重复观察条数。 */
  readonly duplicatesMerged: number;
  /** 缺少/无效 externalContentId 的观察条数。 */
  readonly unidentifiedCount: number;
  readonly conflicts: readonly CommentIdentityIssue[];
  /**
   * 统计是否可作为「硬判错」的权威依据。
   * 有身份冲突或未识别条目时为 false —— 此时不得据此宣布报告写错。
   */
  readonly reliable: boolean;
  /** 来源限制（例如 public_top_reviews_only）。 */
  readonly limitations: readonly string[];
};

const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };

/**
 * 评论身份键：来源 + 外部内容 ID。
 *
 * 不能只用 externalContentId —— 不同来源（amazon_dom / reddit 等）可能给出相同 ID 串；
 * 也不能用数组下标伪造身份。`source` 缺失时退化为 `unknown-source`。
 */
function identityKey(observation: { readonly source?: unknown; readonly externalContentId?: unknown }): string | null {
  const id = typeof observation.externalContentId === "string" ? observation.externalContentId.trim() : "";
  if (!id) return null;
  const source = typeof observation.source === "string" && observation.source.trim() ? observation.source.trim() : "unknown-source";
  return `${source}|${id}`;
}

/** 从本次真实输入的评论证据计算权威星级分布（按身份去重）。 */
export function authoritativeCommentStats(input: ResearchEngineInput): AuthoritativeCommentStats {
  const voices = input.researchInputBundle?.customerVoiceEvidence ?? [];
  const byRating: Record<CommentRatingKey, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, unknown: 0 };
  const merged = new Map<string, { rating: number | null; contentHash: string | null }>();
  const limitations = new Set<string>();
  const conflicts: CommentIdentityIssue[] = [];
  let duplicatesMerged = 0;
  let unidentifiedCount = 0;

  voices.forEach((voice, voiceIndex) => {
    voice.observations.forEach((observation, index) => {
      for (const limitation of observation.limitations ?? []) limitations.add(limitation);
      const key = identityKey(observation);
      if (!key) {
        unidentifiedCount += 1;
        conflicts.push({
          code: "MISSING_IDENTITY",
          identity: `attachment[${voiceIndex}].observation[${index}]`,
          detail: "评论缺少 externalContentId，无法与其它观察合并，未计入权威统计。",
        });
        return;
      }
      const rating = typeof observation.rating === "number" ? observation.rating : null;
      const contentHash = typeof observation.contentHash === "string" ? observation.contentHash : null;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { rating, contentHash });
        return;
      }
      if (existing.rating !== rating) {
        // 同一条评论被两个附件收录却给了不同星级：不能静默取其一。
        conflicts.push({
          code: "DUPLICATE_CONFLICTING_RATING",
          identity: key,
          detail: `同一条评论出现不同星级（${String(existing.rating)} vs ${String(rating)}），统计不可作为权威依据。`,
        });
        return;
      }
      if (existing.contentHash !== contentHash) {
        conflicts.push({
          code: "DUPLICATE_CONFLICTING_CONTENT",
          identity: key,
          detail: "同一条评论出现不同 contentHash（正文可能是不同版本），统计不可作为权威依据。",
        });
        return;
      }
      duplicatesMerged += 1;
    });
  });

  for (const { rating } of merged.values()) {
    const key = (rating === null ? "unknown" : String(rating)) as CommentRatingKey;
    byRating[key] += 1;
  }

  const blocking = conflicts.filter((item) => item.code !== "MISSING_IDENTITY");
  return {
    total: merged.size,
    byRating,
    attachmentCount: voices.length,
    duplicateExternalIds: [...new Set(blocking.map((item) => item.identity))],
    duplicatesMerged,
    unidentifiedCount,
    conflicts,
    reliable: blocking.length === 0 && unidentifiedCount === 0,
    limitations: [...limitations],
  };
}

export type StarClaimCode =
  | "STAR_TOTAL_MISMATCH"
  | "STAR_DISTRIBUTION_MISMATCH"
  | "STAR_STATISTICS_UNRELIABLE"
  /** 子样本内部的星级数超过它自己声明的子集大小（自相矛盾，但不是全样本错误）。 */
  | "STAR_SUBSAMPLE_INCONSISTENT";

export type StarClaimReview = {
  readonly codes: readonly StarClaimCode[];
  readonly reasons: readonly string[];
  readonly claimedTotal: number | null;
  readonly claimedByRating: Readonly<Record<string, number>>;
  readonly authoritative: AuthoritativeCommentStats;
};

/**
 * 统计范围。
 *  - `full`：明确在讲本次全部评论样本，可与权威事实直接比较；
 *  - `subsample`：明确是某个更小子集（「其中 3 条讨论清洁问题，这 3 条中…」）；
 *  - `ambiguous`：指代不明（裸「其中」），**不比较**，避免制造确定性错误。
 */
export type StarClaimScope = "full" | "subsample" | "ambiguous";

/** 单条声明：文本里明确写出的「N 条 M 星」，附带其统计范围。 */
export type StarClaim = {
  readonly star: number;
  readonly count: number;
  readonly at: number;
  readonly scope: StarClaimScope;
  /** 子样本声明的子集大小（用于检查子样本内部是否自相矛盾）。 */
  readonly subsetSize: number | null;
};

const COUNT = String.raw`([0-9]{1,4}|[一二两三四五六七八九十]{1,3})`;
const PER_STAR_A = new RegExp(String.raw`${COUNT}\s*条(?:评论)?\s*(?:为|是)?\s*([1-5一二三四五])\s*星`, "gu");
const PER_STAR_B = new RegExp(String.raw`([1-5一二三四五])\s*星\s*(?:评论)?\s*${COUNT}\s*条`, "gu");
const TOTAL_CLAIM = new RegExp(String.raw`${COUNT}\s*条[^，。；;、\n]{0,10}?评论`, "gu");
/** 只有把总数限定在「本次样本」上时才校验总数，避免把商品累计评价数当样本数。 */
const SAMPLE_SCOPE = /置顶|白名单|样本|本次|公开|抓取/u;

const CHINESE_NUMERALS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function countValue(token: string): number | null {
  if (/^[0-9]+$/u.test(token)) return Number(token);
  if (token.includes("十")) {
    const [tens, ones] = token.split("十");
    const tensValue = tens === "" ? 1 : CHINESE_NUMERALS[tens!];
    const onesValue = ones === "" || ones === undefined ? 0 : CHINESE_NUMERALS[ones];
    if (tensValue === undefined || onesValue === undefined) return null;
    return tensValue * 10 + onesValue;
  }
  if (token.length !== 1) return null;
  return CHINESE_NUMERALS[token] ?? null;
}

function starValue(token: string): number | null {
  const digit = Number(token);
  if (Number.isSafeInteger(digit) && digit >= 1 && digit <= 5) return digit;
  return CHINESE_DIGITS[token] ?? null;
}

/**
 * 抽取文本中的星级声明。
 *
 * 返回**逐条声明**而不是累加结果：同一事实被重复表述（「7 条五星……这 7 条五星」）时，
 * 累加会凭空造出 14 条。调用方对每条声明各自与权威事实比对。
 */
/** 句子边界（声明范围不会跨句）。 */
const CLAUSE_BOUNDARY = /[。；;！？\n]/u;
/** 全样本锚点：出现这些词时，才认为在讲本次样本。 */
const FULL_SAMPLE_ANCHOR = /白名单|置顶|本次|样本|全部|公开/u;
/** 「这/该 N 条」= 指代前面已定义的子集。 */
const SUBSET_THIS = new RegExp(String.raw`(?:这|该)\s*${COUNT}\s*条`, "u");
/** 「N 条讨论/提到…」= 按主题圈出的子集。 */
const SUBSET_TOPIC = new RegExp(String.raw`${COUNT}\s*条[^。；，]{0,8}?(?:讨论|提到|涉及|属于|关于|抱怨|反馈)`, "u");

/**
 * 判定一条星级声明属于哪个统计范围。
 *
 * 只在声明之前、同一句内的文字里找线索：
 *  - 「这/该 N 条」或「N 条讨论…」且 N < 总数 → 子样本；
 *  - N == 总数 → 就是全样本（「这 9 条评论中 8 条五星」仍然是全样本声明）；
 *  - 有全样本锚点（白名单/置顶/本次/样本/全部/公开）→ 全样本；
 *  - 都没有（裸「其中有 2 条五星」）→ 指代不明，**不比较**。
 */
function claimScope(text: string, at: number, total: number): { scope: StarClaimScope; subsetSize: number | null } {
  const clauseStart = (() => {
    let index = at;
    while (index > 0 && !CLAUSE_BOUNDARY.test(text[index - 1]!)) index -= 1;
    return index;
  })();
  const clause = text.slice(clauseStart, at);

  const thisMatch = SUBSET_THIS.exec(clause);
  const topicMatch = SUBSET_TOPIC.exec(clause);
  const cueCount = (() => {
    if (thisMatch) return countValue(thisMatch[1]!);
    if (topicMatch) return countValue(topicMatch[1]!);
    return null;
  })();
  if (cueCount !== null) {
    if (cueCount === total) return { scope: "full", subsetSize: null };
    if (cueCount < total) return { scope: "subsample", subsetSize: cueCount };
  }
  if (FULL_SAMPLE_ANCHOR.test(clause)) return { scope: "full", subsetSize: null };
  return { scope: "ambiguous", subsetSize: null };
}

export function extractStarClaims(
  text: string,
  authoritativeTotal = 0,
): {
  total: number | null;
  totalScoped: boolean;
  claims: readonly StarClaim[];
} {
  const claims: StarClaim[] = [];
  for (const match of text.matchAll(PER_STAR_A)) {
    const star = starValue(match[2]!);
    const count = countValue(match[1]!);
    if (star === null || count === null) continue;
    const at = match.index ?? 0;
    const { scope, subsetSize } = claimScope(text, at, authoritativeTotal);
    claims.push({ star, count, at, scope, subsetSize });
  }
  for (const match of text.matchAll(PER_STAR_B)) {
    const star = starValue(match[1]!);
    const count = countValue(match[2]!);
    if (star === null || count === null) continue;
    const at = match.index ?? 0;
    const { scope, subsetSize } = claimScope(text, at, authoritativeTotal);
    claims.push({ star, count, at, scope, subsetSize });
  }
  claims.sort((left, right) => left.at - right.at);

  let total: number | null = null;
  let totalScoped = false;
  for (const match of text.matchAll(TOTAL_CLAIM)) {
    const matched = text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length);
    if (/星/u.test(matched)) continue; // 「8 条 5 星」不是总数声明
    total = countValue(match[1]!);
    // 同一句里必须出现「置顶/白名单/样本」等限定词，才认为说的是本次样本。
    const at = match.index ?? 0;
    const sentenceStart = text.lastIndexOf("。", at) + 1;
    const sentenceEnd = text.indexOf("。", at);
    const sentence = text.slice(sentenceStart, sentenceEnd < 0 ? text.length : sentenceEnd + 1);
    totalScoped = SAMPLE_SCOPE.test(sentence);
    break;
  }
  return { total, totalScoped, claims };
}

/**
 * 校验一段叙事里的星级统计。
 *
 * 返回 null 表示「没有可核实的聚合声明」——不判错，也不假装通过。
 * 统计不可靠（身份冲突/未识别）时只给 `STAR_STATISTICS_UNRELIABLE`，不宣布报告写错。
 */
export function reviewStarClaims(text: string, authoritative: AuthoritativeCommentStats): StarClaimReview | null {
  const { total, totalScoped, claims } = extractStarClaims(text, authoritative.total);
  if (claims.length === 0 && total === null) return null;

  const claimedByRating: Record<string, number> = {};
  for (const claim of claims) claimedByRating[String(claim.star)] = claim.count;

  if (!authoritative.reliable) {
    return {
      codes: ["STAR_STATISTICS_UNRELIABLE"],
      reasons: [
        `本次评论样本存在身份冲突或未识别条目（冲突 ${authoritative.conflicts.length} 项、未识别 ${authoritative.unidentifiedCount} 条），不能据此判定报告的星级统计对错，需人工核对。`,
        ...authoritative.conflicts.slice(0, 3).map((item) => `${item.code}: ${item.detail}`),
      ],
      claimedTotal: total,
      claimedByRating,
      authoritative,
    };
  }

  const codes: StarClaimCode[] = [];
  const reasons: string[] = [];

  // 逐条声明各自比对：重复表述既不累加，也不互相抵消。
  // **只比全样本声明**：子样本（「其中 3 条讨论清洁问题，这 3 条中 2 条五星」）
  // 与指代不明（裸「其中有 2 条五星」）都不与全样本比较，否则会制造假阳性。
  const reported = new Set<string>();
  for (const claim of claims) {
    if (claim.scope !== "full") continue;
    const expected = authoritative.byRating[String(claim.star) as CommentRatingKey] ?? 0;
    const marker = `${claim.star}:${claim.count}`;
    if (claim.count === expected || reported.has(marker)) continue;
    reported.add(marker);
    codes.push("STAR_DISTRIBUTION_MISMATCH");
    reasons.push(`声称 ${claim.star} 星 ${claim.count} 条，权威证据为 ${expected} 条。`);
  }

  // 子样本只查「自相矛盾」：分项之和超过它自己声明的子集大小。
  // 不把它升级为全样本事实错误，只交人工复核。
  const subsampleSums = new Map<number, number>();
  for (const claim of claims) {
    if (claim.scope !== "subsample" || claim.subsetSize === null) continue;
    subsampleSums.set(claim.subsetSize, (subsampleSums.get(claim.subsetSize) ?? 0) + claim.count);
  }
  for (const [subsetSize, sum] of subsampleSums) {
    if (sum <= subsetSize) continue;
    codes.push("STAR_SUBSAMPLE_INCONSISTENT");
    reasons.push(`子样本声明 ${subsetSize} 条，但分项合计 ${sum} 条，子样本内部自相矛盾；不据此判定全样本统计对错，需人工核对。`);
  }

  // 只校验明确限定在本次样本上的总数；不推断「分项是否穷尽」，因此不做合计判断。
  if (total !== null && totalScoped && total !== authoritative.total) {
    codes.push("STAR_TOTAL_MISMATCH");
    reasons.push(`声称样本总数 ${total} 条，权威证据为 ${authoritative.total} 条。`);
  }

  if (codes.length === 0) return null;

  const distribution = Object.entries(authoritative.byRating)
    .filter(([, count]) => count > 0)
    .map(([rating, count]) => `${rating} 星 ${count} 条`)
    .join("、");
  reasons.push(`权威口径：${authoritative.attachmentCount} 个评论凭据、去重后共 ${authoritative.total} 条（${distribution}）；仅统计本次研究实际读到的评论，不含商品页累计评价数与第三方估算。`);

  return {
    codes: [...new Set(codes)],
    reasons,
    claimedTotal: total,
    claimedByRating,
    authoritative,
  };
}

/** 把校验结果写进现有 semanticReview，保留原文不改写。 */
export function markStarClaimReview(
  narrative: ResearchNarrative,
  review: StarClaimReview,
): ResearchNarrative {
  const reasons = [...(narrative.semanticReview?.reasons ?? []), ...review.reasons];
  return {
    ...narrative,
    semanticReview: {
      ...narrative.semanticReview,
      status: "human_review_required",
      reasons: [...new Set(reasons)],
    },
  };
}
