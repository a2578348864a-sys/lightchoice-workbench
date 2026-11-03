/**
 * 03 商品深研 —— VOC 评论归属投影（只读、确定性、可追溯）。
 *
 * 边界：
 * - 只消费已采集的评论证据附件（kind = v3_review_voc_v1），不采集、不写库、不调用 AI。
 * - 缺失保持 null：评论证据没有 reviewId、也没有变体信息，这些维度不编造。
 * - 去重键只能基于 asin + 规范化文本 + 星级（无 reviewId），并保留附件 attachmentId / contentHash 以追溯。
 * - 情感判定是句级确定性规则（含否定与前后对比处理），不是「命中关键词即负面」。
 * - 强度阈值复用 lib/research/vocThresholds.ts，禁止在本文件另设阈值。
 */

import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  DEEP_RESEARCH_SCHEMA,
  type DeepResearchStrength,
  type DeepResearchVocProjection,
  type DeepResearchVocQuote,
  type DeepResearchVocTheme,
} from "@/lib/research/deepResearchTypes";
import { VOC_STRENGTH_THRESHOLDS, computeThemeStrength } from "@/lib/research/vocThresholds";
import { VOC_RULE_VERSION } from "@/lib/research/vocRuleVersion";

export const VOC_REVIEW_ATTACHMENT_KIND = "v3_review_voc_v1" as const;

/** 只有这两种状态代表「评论可读」，其余一律 fail-closed。 */
const ACCEPTED_PAYLOAD_STATUSES: readonly string[] = ["VALIDATED_AVAILABLE", "AVAILABLE_WITH_LIMITATION"];

const MAX_EXCERPT_CHARS = 200;
const MAX_QUOTES_PER_THEME = 3;
/** 样本偏小的提示线（仅用于 limitations 文案，不参与 strength 判定）。 */
const SMALL_SAMPLE_THRESHOLD = 10;
const HIGH_FIVE_STAR_RATIO = 0.7;

export type VocProjectionInput = {
  attachments: readonly SourceEvidenceAttachment[];
  /**
   * 规范化买家声音（`customer_voice_observation_v1`）只读投影。
   *
   * 为什么需要：同一批 Amazon 评论一旦被归一到 canonical customer voice，bundle 的
   * `reviewEvidence` 会按去重规则把它排除（避免重复计入），只读附件会显示 0 条评论。
   * 这里直接消费 canonical observations，可拿到 reviewId / 日期 / 星级 / 原文。
   */
  observations?: readonly VocObservationInput[];
  /** 本轮研究预期的 ASIN；提供时，其余 ASIN 的附件进 rejectedAttachments（不猜测归属）。 */
  expectedAsins?: readonly string[];
};

/** 与 `CustomerVoiceResearchEvidence.observations` 对齐的最小只读视图。 */
export type VocObservationInput = {
  attachmentId: string;
  contentHash: string;
  subjectKey: string;
  capturedAt: string;
  source: string;
  observations: ReadonlyArray<{
    externalContentId: string;
    contentHash: string;
    source: string;
    text: string;
    title?: string | null;
    rating?: number | null;
    publishedAt?: string | null;
    verifiedPurchase?: boolean | null;
    contentType?: string;
    provenance?: { sourceAttachmentId?: string | null };
  }>;
};

// ============================================================================
// 基础工具
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRating(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 5) return null;
  return value;
}

function asAsin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/u.test(normalized) ? normalized : null;
}

function asinFromSubjectKey(subjectKey: string): string | null {
  const segments = subjectKey.split(":");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const asin = asAsin(segments[index]);
    if (asin) return asin;
  }
  return null;
}

/** 去重用的文本规范化：全半角统一 + 压空白 + 小写；原文另存在 text 中。 */
function normalizeForDedupe(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * canonical 观察的去重键：与附件路径保持同一口径（ASIN + 文本 + 星级），
 * 这样同一条评论同时出现在 canonical 与 v3 附件里时只计一次；
 * 仅在正文为空（不应发生）时才退回评论标识。
 */
function externalContentDedupeKey(reviewAsin: string, externalContentId: string, text: string, rating: number | null): string {
  const normalized = normalizeForDedupe(text);
  if (normalized) return `${reviewAsin}|${normalized}|${rating === null ? "na" : String(rating)}`;
  const id = externalContentId?.trim();
  return `${reviewAsin}|id:${id ?? "unknown"}`;
}

// ============================================================================
// 主题词典（中英双语；一条评论可命中多个主题）
// ============================================================================

type ThemeDimension = {
  id: string;
  label: string;
  positiveLabel: string;
  /** 触发「该句在谈这个维度」的关键词（极性由句级情感判定，不由关键词决定）。 */
  keywords: readonly RegExp[];
};

/**
 * 部件松脱结构：提手/盖子/卡扣等配件反复脱落。
 * 要求部件名词与脱落动词邻近（之间不超过 60 字符），避免食物/贴纸等无关主语误入。
 */
const PART_DETACHMENT_SOURCE =
  "\\b(?:handle|handles|lid|lids|cap|caps|knob|knobs|part|parts|piece|pieces|wheel|wheels|leg|legs|clip|clips|buckle|buckles|strap|straps|button|buttons|drawer|drawers)\\b[^.]{0,60}?\\b(?:fall|falls|falling|fell|come|comes|coming|came|detach(?:es|ed|ing)?|snap(?:s|ped|ping)?)\\s+(?:off|apart|loose|out)\\b";

const THEME_DIMENSIONS: readonly ThemeDimension[] = [
  {
    id: "clean_difficulty",
    label: "清洁困难",
    positiveLabel: "清洁便利（正面反馈）",
    keywords: [
      /\bclean(?:ing|ed|s)?\b/iu,
      /\bscrub(?:bing|bed|s)?\b/iu,
      /\bwash(?:ing|ed|able)?\b/iu,
      /难洗|难清洁|难清理|不好洗|洗不干净|不好清洁|刷不干净|清洁|清洗/u,
    ],
  },
  {
    id: "slip_resistance",
    label: "防滑/稳定不足",
    positiveLabel: "防滑稳定（正面反馈）",
    keywords: [
      /\bslip(?:s|ped|pery|ping)?\b/iu,
      /\bslid(?:es|ing)?\b/iu,
      /\bslide(?:s|d)?\b/iu,
      /\bmoves?\s+(?:all\s+)?(?:over|around|across)\b/iu,
      /\bwobbl(?:e|es|y|ing)\b/iu,
      /\bunstable\b/iu,
      /\bbase\b/iu,
      /打滑|很滑|太滑|不稳|晃动|会移动|底座/u,
    ],
  },
  {
    id: "durability",
    label: "耐用性不足",
    positiveLabel: "耐用性（正面反馈）",
    keywords: [
      /\bdurab(?:le|ility)\b/iu,
      /\bbroke(?:n)?\b/iu,
      /\bbreak(?:s|ing)?\b/iu,
      /\bcrack(?:s|ed|ing)?\b/iu,
      /\btore\b/iu,
      /\btear(?:s|ing)?\b/iu,
      /\brip(?:s|ped|ping)?\b/iu,
      /\bflimsy\b/iu,
      /\bfell apart\b/iu,
      /\bfalls? apart\b/iu,
      /\brust(?:s|y|ed)?\b/iu,
      /\bwarp(?:s|ed|ing)?\b/iu,
      /\bpeel(?:s|ing|ed)?\b/iu,
      // 部件松脱：提手/盖子/卡扣等配件反复脱落是结构/装配缺陷，归入耐用性主题。
      new RegExp(PART_DETACHMENT_SOURCE, "iu"),
      /耐用|不耐用|坏了|坏掉|破了|裂开|开裂|断裂|生锈|变形|掉漆|褪色/u,
    ],
  },
  {
    id: "size_fit",
    label: "尺寸不符",
    positiveLabel: "尺寸合适（正面反馈）",
    keywords: [
      /\bsize[sd]?\b/iu,
      /\bdimension(?:s)?\b/iu,
      /too small/iu,
      /too large/iu,
      /too big/iu,
      /doesn'?t fit/iu,
      /didn'?t fit/iu,
      /尺寸|太小|太大|偏小|偏大|不合适|装不下|放不下|对不上/u,
    ],
  },
  {
    id: "odor",
    label: "异味",
    positiveLabel: "无异味（正面反馈）",
    keywords: [
      /\bsmell(?:s|ed|y|ing)?\b/iu,
      /\bodou?r\b/iu,
      /\bstink(?:s|y)?\b/iu,
      /\bchemical\b/iu,
      /异味|味道|塑料味|刺鼻|难闻|臭味|发臭/u,
    ],
  },
  {
    id: "functionality",
    label: "功能缺失/渗漏",
    positiveLabel: "功能正常（正面反馈）",
    keywords: [
      // leak-proof / leak proof 是正面宣称，不是渗漏主题；真正的渗漏由 leak 动词形式与上下文判定。
      /\bleak(?:s|ed|ing)?\b(?![- ]?proof)/iu,
      /\bspill(?:s|ed|ing)?\b/iu,
      /\bseal(?:s|ed|ing)?\b/iu,
      /doesn'?t seal/iu,
      /\bmissing\b/iu,
      /no lid/iu,
      /\blid\b/iu,
      /漏水|漏液|渗漏|密封|盖子|缺件|少了|打不开|盖不严/u,
    ],
  },
  {
    id: "capacity_storage",
    label: "容量/收纳不便",
    positiveLabel: "容量收纳（正面反馈）",
    keywords: [
      /\bstack(?:s|ed|able|ing)?\b/iu,
      /\bbulky\b/iu,
      /\bbulk(?:y)?\b/iu,
      /\blarge\b/iu,
      /\bcapacity\b/iu,
      /\bstorage\b/iu,
      /\bholds?\b/iu,
      /容量|收纳|占地方|占地|堆叠|装得多|装不下/u,
    ],
  },
  {
    id: "material_feel",
    label: "材质/手感不佳",
    positiveLabel: "材质手感（正面反馈）",
    keywords: [
      /\bthin\b/iu,
      /\bplastic\b/iu,
      /\btexture\b/iu,
      /\bcheap(?:ly)?\b/iu,
      /\bquality\b/iu,
      /\bfeel(?:s)?\b/iu,
      /\bbrittle\b/iu,
      /材质|手感|做工|很薄|太薄|廉价|塑料感|质感/u,
    ],
  },
];

// ============================================================================
// 句级情感判定（确定性规则）
// ============================================================================

type CuePolarity = "negative" | "positive";
type SentenceSentiment = "negative" | "positive" | "neutral";

const NEGATIVE_CUE_SOURCES: readonly string[] = [
  "hard", "difficult", "tough", "struggl(?:e|es|ed|ing)", "annoying", "terrible", "horrible", "awful",
  "bad", "poor(?:ly)?", "broke(?:n)?", "break(?:s|ing)?", "crack(?:s|ed|ing)?", "tore", "tear(?:s|ing)?",
  "rip(?:s|ped|ping)?", "flimsy", "cheap(?:ly)?", "thin", "leak(?:s|ed|ing)?", "slipp(?:y|ed|ing)?",
  "slip(?:s|ped)?", "slide(?:s|d|ing)?", "slid", "smell(?:s|ed|y|ing)?", "odou?r", "stink(?:s|y)?",
  "stain(?:s|ed|ing)?", "rust(?:s|y|ed)?", "wobbl(?:e|es|y|ing)", "unstable", "missing", "defect(?:ive)?",
  "chipped", "dented", "warp(?:s|ed|ing)?", "peel(?:s|ing|ed)?", "scratch(?:es|ed|ing)?", "mold(?:y)?",
  "mildew", "chemical", "spill(?:s|ed|ing)?", "waste", "disappoint(?:ed|ing|ment)?", "return(?:ed)?",
  "useless", "hassle", "impossible", "too small", "too large", "too big", "doesn'?t fit", "didn'?t fit",
  "fell apart", "falls? apart", "not worth", "overpriced", "messy", "sweat(?:s|ing|y)?", "condensation",
  "moves?\\s+(?:all\\s+)?(?:over|around|across)", "stuck", "sticks", "snapped", "discolo(?:r|red|ration)", "faded", "bent",
  "worr(?:y|ied|ies)", "concern(?:ed|s)?",
  // don't fit 与 doesn't fit / didn't fit 同为否定式不合表达，缩写形式不得漏判。
  "don'?t fit",
  "难洗", "难清洁", "难清理", "不好洗", "洗不干净", "不好", "不行", "很差", "太差", "差劲", "质量差",
  "漏水", "漏液", "渗漏", "打滑", "很滑", "太滑", "异味", "味道大", "塑料味", "刺鼻", "难闻",
  "破了", "裂开", "开裂", "坏了", "坏掉", "掉漆", "生锈", "变形", "褪色", "太小", "太大", "偏小", "偏大",
  "不合适", "尺寸不对", "装不下", "放不下", "松动", "掉下来", "不稳", "晃动", "缺件", "少了", "发霉",
  "脏", "退货", "失望", "廉价", "做工差", "很薄", "太薄", "不耐用", "发臭",
];

const POSITIVE_CUE_SOURCES: readonly string[] = [
  "easy", "easily", "love(?:d)?", "great", "good", "perfect(?:ly)?", "fine", "sturdy", "solid",
  "durab(?:le|ility)", "works?", "worked", "excellent", "amazing", "awesome", "happy", "recommend",
  "nice", "well[ -]made", "no problem", "leak[ -]?proof", "convenient", "simple", "smooth", "holds",
  "keeps", "worth", "impressed", "satisfied", "quality",
  "很好", "好用", "不错", "容易", "方便", "满意", "喜欢", "结实", "耐用", "牢固", "干净", "推荐",
  "完美", "不漏", "无异味", "好洗", "好看", "漂亮", "值",
];

const POLARITY_CUES: ReadonlyArray<{ regex: RegExp; polarity: CuePolarity }> = [
  ...NEGATIVE_CUE_SOURCES.map((source) => ({ regex: new RegExp(source, "giu"), polarity: "negative" as CuePolarity })),
  ...POSITIVE_CUE_SOURCES.map((source) => ({ regex: new RegExp(source, "giu"), polarity: "positive" as CuePolarity })),
];

const NEGATOR_TOKENS = new Set([
  "no", "not", "never", "none", "nothing", "zero", "hardly", "barely", "rarely", "without",
  "doesn't", "don't", "didn't", "isn't", "wasn't", "aren't", "weren't", "won't", "can't",
  "cannot", "hasn't", "haven't", "doesnt", "dont", "didnt", "isnt", "wasnt", "arent",
  "werent", "wont", "cant", "hasnt", "havent",
]);

/** 中文「否定 = 好事」框架：不难 / 没问题 / 无问题。 */
const CJK_POSITIVE_FRAME = /(?:不难|没问题|没毛病|无问题)/u;
/** 中文「否定 = 抱怨」框架：不好 / 不易 / 很难 / 难以。 */
const CJK_NEGATIVE_FRAME = /(?:不好|不易|很难|难以|难|费劲|费力)/u;
const CJK_NEGATION_CHAR = /[不没無无未]/u;

const CLAUSE_BOUNDARY = /([,;]|\bbut\b|\bhowever\b|\byet\b|\balthough\b|\bthough\b|，|；|但是|但|不过|然而)/giu;
const CONTRAST_BOUNDARY = /^(?:but|however|yet|although|though|但是|但|不过|然而)$/iu;

type PolaritySignal = { index: number; polarity: CuePolarity; cue: string };

function isNegated(clause: string, cueIndex: number): boolean {
  const window = clause.slice(Math.max(0, cueIndex - 24), cueIndex);
  if (!window.trim()) return false;
  // 逗号/中文逗号之后重新起算，避免把上一句的否定词带过来（"No, it leaks"）。
  const local = window.split(/[,，]/u).pop() ?? window;
  if (!local.trim()) return false;
  if (CJK_POSITIVE_FRAME.test(local)) return true;
  if (CJK_NEGATIVE_FRAME.test(local)) return false;
  // 统一弯引号（doesn’t / don’t），否则否定词表无法命中。
  const normalized = local.replace(/[’‘]/gu, "'");
  const tokens = normalized.split(/[^\p{L}\p{N}']+/u).filter(Boolean).slice(-3);
  for (const token of tokens) {
    if (NEGATOR_TOKENS.has(token.toLowerCase())) return true;
  }
  return CJK_NEGATION_CHAR.test(local.slice(-6));
}

function polaritySignals(clause: string): PolaritySignal[] {
  const signals: PolaritySignal[] = [];
  for (const cue of POLARITY_CUES) {
    for (const match of clause.matchAll(cue.regex)) {
      const index = match.index ?? 0;
      const negated = isNegated(clause, index);
      const polarity: CuePolarity = negated
        ? (cue.polarity === "negative" ? "positive" : "negative")
        : cue.polarity;
      signals.push({ index, polarity, cue: match[0] });
    }
  }
  return signals;
}

function classifyClause(clause: string, keywordIndexInClause: number): SentenceSentiment {
  const signals = polaritySignals(clause);
  if (signals.length === 0) return "neutral";
  const negatives = signals.filter((signal) => signal.polarity === "negative");
  const positives = signals.filter((signal) => signal.polarity === "positive");
  if (negatives.length === 0) return "positive";
  if (positives.length === 0) return "negative";
  const nearest = (list: readonly PolaritySignal[]) => Math.min(
    ...list.map((signal) => Math.abs(signal.index - keywordIndexInClause)),
  );
  return nearest(negatives) <= nearest(positives) ? "negative" : "positive";
}

type Clause = { text: string; start: number; end: number; contrastBefore: boolean };

function splitClauses(sentence: string): Clause[] {
  const clauses: Clause[] = [];
  let cursor = 0;
  let pendingContrast = false;
  for (const match of sentence.matchAll(CLAUSE_BOUNDARY)) {
    const boundaryIndex = match.index ?? 0;
    const text = sentence.slice(cursor, boundaryIndex);
    const boundaryText = match[1] ?? "";
    if (text.trim()) {
      clauses.push({ text, start: cursor, end: boundaryIndex, contrastBefore: pendingContrast });
      pendingContrast = false;
    }
    if (CONTRAST_BOUNDARY.test(boundaryText)) pendingContrast = true;
    cursor = boundaryIndex + boundaryText.length;
  }
  const tail = sentence.slice(cursor);
  if (tail.trim()) {
    clauses.push({ text: tail, start: cursor, end: sentence.length, contrastBefore: pendingContrast });
  }
  if (clauses.length === 0) {
    clauses.push({ text: sentence, start: 0, end: sentence.length, contrastBefore: false });
  }
  return clauses;
}

/**
 * 主题提及的真正态度（五类）。
 *
 * 为什么要分这五类：关键词命中只能证明「用户提到了这个属性」，
 * 不能证明「用户不满意」。旧实现把提及直接当作负面抱怨，
 * 于是「just a little slippery, which is fine by me」被算成一条防滑投诉。
 */
export type VocIntent = "complaint" | "tolerated" | "mention" | "positive" | "uncertain";

/** 用户明确表示「可以接受 / 不介意」的让步语句。 */
const ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  /(?:which is|that'?s|it'?s|it is|still)\s+(?:perfectly\s+)?(?:fine|ok|okay|acceptable)\b/iu,
  /\bfine\s+by\s+me\b/iu,
  /(?:i\s+)?(?:don'?t|do not|didn'?t|wouldn'?t|would\s+not)\s+(?:really\s+)?(?:mind|care)/iu,
  /(?:doesn'?t|does not|didn'?t)\s+(?:really\s+)?(?:bother|matter)/iu,
  /not\s+(?:a\s+)?(?:big\s+)?(?:deal|issue|problem)/iu,
  /no\s+(?:big\s+)?(?:deal|problem|issue)/iu,
  /(?:can|could)\s+live\s+with/iu,
  /good\s+enough/iu,
  /still\s+(?:works?|usable|use it)/iu,
  /(?:不介意|不碍事|没关系|无所谓|可以接受|能接受|不影响使用|还能用|凑合)/u,
];

/** 明确的使用障碍：出现问题并影响实际操作。 */
const OBSTACLE_PATTERNS: readonly RegExp[] = [
  /moves?\s+(?:all\s+)?(?:over|around|across)/iu,
  /(?:slides?|slid)\s+(?:all\s+)?(?:over|around|across|everywhere|off)/iu,
  /won'?t\s+stay\s+(?:in\s+place|flat|put)/iu,
  /(?:can'?t|cannot|unable to)\s+(?:get|clean|use|keep|hold)/iu,
  /only\s+place\s+to\s+clean/iu,
  /(?:hard|difficult|tough)\s+to\s+(?:clean|use|remove|hold|get|keep|stay|wipe)/iu,
  /struggl(?:e|ed|ing)\s+(?:to|with)/iu,
  /have\s+to\s+hold/iu,
  /takes?\s+(?:forever|too\s+long)/iu,
  /affects?\s+(?:my\s+)?(?:use|usage|operation|baking)/iu,
  /(?:leak(?:s|ed)?|spill(?:s|ed)?)\s+(?:onto|all\s+over|through)/iu,
  /(?:ruined|destroyed)\s+(?:my|the)/iu,
  /(?:一直|老是)(?:移动|滑动|跑)|无法(?:使用|固定|清洁)|影响(?:操作|使用)|固定不住|放不稳/u,
];

/** 强负面措辞：即使没有具体障碍，也可作为明确抱怨候选。 */
const STRONG_NEGATIVE_PATTERNS: readonly RegExp[] = [
  /(?:my|the|main)\s+(?:issue|problem|complaint)/iu,
  /problem\s+is/iu,
  /(?:terrible|horrible|awful|worst|useless|impossible|defective)/iu,
  /fell\s+apart/iu,
  /broke(?:n)?\s+after/iu,
  /waste\s+of\s+money/iu,
  /would(?:n'?t|\s+not)\s+recommend/iu,
  /(?:returned|returning)\s+(?:it|them|these)/iu,
  // 结构性缺陷（漏、裂、锈、霉、缺件）本身就是功能问题，即使语气轻描淡写也算明确负面。
  // 注意：不能只凭裸词 leak 判定——"zero leaks / no leaks / leak-proof" 是正面或否定语义。
  /\b(?:it|this|the\s+(?:mat|liner|sheet|seal|product))\s+leak(?:s|ed|ing)?\b/iu,
  /\bleak(?:s|ed|ing)?\s+(?:a\s+lot|badly|everywhere|onto|through|all\s+over)\b/iu,
  /\b(?:started|began|keeps?)\s+leaking\b/iu,
  /\b(?:broke(?:n)?|crack(?:s|ed|ing)?|tore|torn|rusted|mold(?:y)?|mildew)\b/iu,
  /won'?t\s+(?:close|seal|stay\s+closed)/iu,
  /doesn'?t\s+(?:close|seal|hold)/iu,
  /missing\s+(?:lid|piece|part|pieces|parts|accessory|accessories)/iu,
  /\b(?:lid|piece|part|pieces|parts|accessory|accessories)\s+(?:is|are|was|were)?\s*missing\b/iu,
  // 明确描述气味/材质缺陷（strong/chemical/awful smell），不是「有一点味道」的轻微观察。
  /(?:strong|bad|awful|terrible|chemical|burnt?)\s+(?:chemical\s+)?(?:smell|odor|odour)/iu,
  /(?:smell|smells|smelled|odor|odour)\s+(?:bad|awful|terrible|like\s+chemicals?|of\s+chemicals?)/iu,
  /(?:很难|难用|坏了|退货|质量差|太差|漏水|渗漏|开裂|刺鼻|异味)/u,
];

/** 弱化/模糊措辞：只有轻微观察、没有使用障碍时，保留待核对。 */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\ba\s+(?:little|bit|touch|slight(?:ly)?)\b/iu,
  /\bslightly\b/iu,
  /\bsomewhat\b/iu,
  /\bminor\b/iu,
  /\bstart(?:s|ed)?\s+off\b/iu,
  /\binitially\b/iu,
  /\bat\s+first\b/iu,
  /\boccasionally\b/iu,
  /\bsometimes\b/iu,
  /\bused\s+to\b/iu,
  /(?:有点|稍微|略微|偶尔|一开始)/u,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** 部件松脱的否定形式：don't/doesn't/didn't/never/won't/can't + （可选副词）+ 脱落动词 + off/apart/loose/out。 */
const NEGATED_PART_DETACHMENT =
  /\b(?:don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|never)\s+(?:\w+ly\s+|really\s+|actually\s+|just\s+)?(?:fall|falls|falling|fell|come|comes|coming|came|detach(?:es|ed|ing)?|snap(?:s|ped|ping)?)\s+(?:off|apart|loose|out)\b/iu;

/**
 * 部件松脱缺陷判定：提手/盖子/卡扣等配件反复脱落是结构性缺陷（明确负面），
 * 但否定形式（"handles don't fall off"）是正面/中性陈述，不算缺陷。
 */
function isPartDetachmentDefect(text: string): boolean {
  for (const match of text.matchAll(new RegExp(PART_DETACHMENT_SOURCE, "giu"))) {
    if (NEGATED_PART_DETACHMENT.test(match[0])) continue;
    return true;
  }
  return false;
}

/**
 * 关键字所在分句的“局部上下文”：
 * - 同一句内用逗号连接的连续分句可以互相补充（"Cleaning is hard, it takes forever"）；
 * - 遇到 but/however/yet 等转折边界就截断，避免后一分句的负面词污染前一分句。
 */
function contextTextForClause(clauses: readonly Clause[], index: number): string {
  let start = index;
  while (start > 0 && !clauses[start].contrastBefore) start -= 1;
  let end = index;
  while (end + 1 < clauses.length && !clauses[end + 1].contrastBefore) end += 1;
  return clauses.slice(start, end + 1).map((item) => item.text).join(" ");
}

/** 担忧动词：表达购买前的担心（不是实际故障陈述）。 */
const WORRY_VERB_PATTERN = /\b(?:worried|worry|worries|concerned|afraid|nervous|hesitant|skeptical)\b/iu;
/** 情态动词紧邻关键词之前（之间不超过 4 个词）："would arrive broken" 是假设；词数过多时后面是事实陈述。 */
const MODAL_NEAR_KEYWORD = /\b(?:would|could|might)\b(?:\s+\S+){0,4}\s*$/iu;

/**
 * 假设性担忧判定：「担心……会破损」是购买前的想象，不是实际发生的故障。
 *
 * - 担忧动词出现在关键词之前；
 * - 情态动词（would/could/might）要么紧邻关键词之前（"would arrive broken"），
 *   要么位于关键词匹配内部（"handles would fall off"）；
 * - 关键词与情态动词之间词数过多时（"would break because the last ones cracked"），
 *   说明后半是事实陈述，按实际故障处理。
 *
 * 实际故障由评论中陈述结果的分句/句子另行判定；纯担忧最多记 uncertain，不升级为 complaint。
 */
function isHypotheticalWorry(sentence: string, matchStart: number, matchEnd: number): boolean {
  const before = sentence.slice(0, matchStart);
  const worry = before.match(WORRY_VERB_PATTERN);
  if (!worry) return false;
  const afterWorry = before.slice((worry.index ?? 0) + worry[0].length);
  const modalBefore = MODAL_NEAR_KEYWORD.test(afterWorry);
  const modalInside = /\b(?:would|could|might)\b/iu.test(sentence.slice(matchStart, matchEnd));
  return modalBefore || modalInside;
}

/**
 * 判定包含关键词的句子对「该主题」的真实态度。
 *
 * 判定顺序（保守优先）：
 * 1. 明确接受（fine by me / 不介意）→ tolerated；
 * 2. 假设性担忧（担心……会破损，无实际结果）→ uncertain，不当投诉；
 * 3. 句内正面 → positive；
 * 4. 句内无正负线索 → mention（只算提及）；
 * 5. 负面：有使用障碍、强负面措辞或部件松脱缺陷 → complaint；
 * 6. 负面但只有弱化观察（a little / start off）→ uncertain；
 * 7. 其余负面 → uncertain（不升级为投诉）。
 */
function classifyIntent(sentence: string, match: { index: number; keyword: string }): VocIntent {
  const keywordIndex = match.index;
  const matchEnd = match.index + match.keyword.length;
  const clauses = splitClauses(sentence);
  let keywordClause = clauses.findIndex((clause) => keywordIndex >= clause.start && keywordIndex < clause.end);
  if (keywordClause < 0) keywordClause = clauses.length - 1;
  const clause = clauses[keywordClause];
  const sentiment = classifyClause(clause.text, keywordIndex - clause.start);
  // 统一弯引号，避免 does’nt/don’t 这类文本绕过否定与接受措辞。
  const lowered = sentence.toLowerCase().replace(/[’‘]/gu, "'");

  // 句内任何位置出现明确接受措辞，都说明用户自己可以接受，不算投诉。
  if (matchesAny(ACCEPTANCE_PATTERNS, lowered)) {
    return sentiment === "positive" ? "positive" : "tolerated";
  }
  // 假设性担忧：购买前的想象不构成实际投诉；纯担忧记 uncertain，
  // 实际故障由陈述结果的分句/句子另行判定（担忧不掩盖事实，事实也不被担忧污染）。
  if (isHypotheticalWorry(sentence, keywordIndex, matchEnd)) {
    return sentiment === "positive" ? "positive" : "uncertain";
  }
  // 「main issue / problem is / 漏了 / 裂了」这类强负面措辞本身就是投诉，
  // 即使同一分句里没有词表内的负面形容词（例如 "My main issue arises in cleaning them"）。
  //
  // 用「同句内非转折分句」的局部上下文判断障碍/强负面：
  // 逗号连续分句可互补（"Cleaning is hard, it takes forever"），
  // 但 but/however 之后的内容不能传播到前一分句。接受语气仍按整句判断。
  const localText = contextTextForClause(clauses, keywordClause).replace(/[’‘]/gu, "'");
  if (matchesAny(STRONG_NEGATIVE_PATTERNS, localText)) {
    return sentiment === "positive" ? "positive" : "complaint";
  }
  // 部件松脱（提手/盖子/卡扣等配件反复脱落）是结构性缺陷，算明确负面；
  // 否定形式（handles don't fall off）由 isPartDetachmentDefect 排除。
  if (isPartDetachmentDefect(localText)) {
    return sentiment === "positive" ? "positive" : "complaint";
  }
  if (sentiment === "positive") return "positive";
  if (sentiment === "neutral") return "mention";

  // 负面措辞：有明显使用障碍才算投诉。
  if (matchesAny(OBSTACLE_PATTERNS, localText)) return "complaint";
  if (matchesAny(HEDGE_PATTERNS, localText)) return "uncertain";
  // 负面措辞但没有任何使用影响说明：不升级为投诉，交给人工核对。
  return "uncertain";
}


function splitSentences(text: string): string[] {
  return text.split(/[.!?;。！？；\n\r]+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * 同一句内可能出现多次同一主题（例如 "doesn't leak, but the lid is missing"）：
 * 逐次匹配并分别判定，最后按“最强意图”合并到一条评论，避免只取第一个关键词而漏掉后面的真实投诉。
 */
function keywordMatches(dimension: ThemeDimension, sentence: string): Array<{ index: number; keyword: string }> {
  const matches: Array<{ index: number; keyword: string }> = [];
  const seen = new Set<string>();
  for (const keyword of dimension.keywords) {
    const flags = keyword.flags.includes("g") ? keyword.flags : `${keyword.flags}g`;
    for (const match of sentence.matchAll(new RegExp(keyword.source, flags))) {
      const index = match.index ?? 0;
      const key = `${index}:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ index, keyword: match[0] });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

/**
 * 食物从垫子上滑落 ≠ 垫子在台面/烤盘上滑动。
 *
 * "Teriyaki salmon slid right off" 描述的是不粘/易脱离（通常是正面性能）；
 * "the mat slid across the counter" 才可能是防滑稳定性问题。
 * 只在有明确食物主语、且没有垫子自身移动描述时跳过 slip 主题；
 * 主语不清（it / everything）不强行判断，保留给人工复核。
 */
function isFoodReleaseSlip(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  const food = /\b(?:food|salmon|teriyaki|cookie|cookies|bread|pastry|pastries|dough|cheese|vegetables?|baked goods?)\b/iu.test(lower);
  if (!food) return false;
  if (!/\b(?:slid|slide|slides|slip|slipped|slips)\b/iu.test(lower)) return false;
  if (!/\boff\b/iu.test(lower)) return false;
  // 垫子自身移动的描述：保留为防滑主题。
  const matMoves = /\b(?:mat|liner|sheet|silicone)\s+(?:also\s+|still\s+|keeps?\s+)?(?:moves?|moving|slid|slides?|slip|slipped)\b/iu.test(lower)
    || /\b(?:mat|liner|sheet|silicone)\b[^.]{0,30}\b(?:moves?|moving)\b/iu.test(lower)
    || /\bit\s+(?:moves?|moving|slid|slides?|slip|slipped)\b/iu.test(lower);
  return !matMoves;
}

// ============================================================================
// 附件解析与评论规范化
// ============================================================================

type ReviewRecord = {
  asin: string;
  attachmentId: string;
  contentHash: string;
  capturedAt: string;
  rating: number | null;
  reviewDate: string | null;
  title: string | null;
  verifiedPurchase: boolean | null;
  text: string;
  dedupeKey: string;
};

type ParsedAttachment = {
  asin: string;
  reviews: ReviewRecord[];
  skippedRows: number;
};

type Rejection = { attachmentId: string; reason: string };

function parseReviewText(raw: Record<string, unknown>): string | null {
  // 真实 v3 评论行使用 reviewText；历史/兼容快照可能落在 body / text（同样的评论正文，非新字段）。
  for (const candidate of [raw.reviewText, raw.body, raw.text]) {
    const text = asText(candidate);
    if (text) return text.replace(/\s+/gu, " ").trim();
  }
  return null;
}

function parseAttachment(
  attachment: SourceEvidenceAttachment,
  expectedAsins: ReadonlySet<string> | null,
): { parsed: ParsedAttachment } | { rejection: Rejection } {
  const reject = (reason: string) => ({ rejection: { attachmentId: attachment.attachmentId, reason } });

  if (attachment.kind !== VOC_REVIEW_ATTACHMENT_KIND) {
    return reject(`附件类型不是评论证据（kind=${attachment.kind}），已跳过`);
  }
  const payload = attachment.payload;
  if (!isRecord(payload)) return reject("评论证据 payload 结构无法解析");
  if (payload.module !== "review_voc") {
    return reject(`评论证据 payload 的 module 不是 review_voc（module=${String(payload.module)}），无法确认字段含义`);
  }
  const status = typeof payload.status === "string" ? payload.status : null;
  if (!status || !ACCEPTED_PAYLOAD_STATUSES.includes(status)) {
    return reject(`评论附件状态为 ${status ?? "未知"}，不是可读状态（需 VALIDATED_AVAILABLE 或 AVAILABLE_WITH_LIMITATION）`);
  }
  const identity = isRecord(payload.identity) ? payload.identity : {};
  const payloadSubjectKey = asText(payload.subjectKey) ?? attachment.subjectKey;
  const asin = asAsin(identity.asin) ?? asinFromSubjectKey(payloadSubjectKey) ?? asinFromSubjectKey(attachment.subjectKey);
  if (!asin) return reject("评论证据缺少可用 ASIN（identity.asin 与 subjectKey 都无法解析）");
  if (expectedAsins && !expectedAsins.has(asin)) {
    return reject(`评论证据 ASIN ${asin} 不在本轮预期范围（${[...expectedAsins].join("、")}）`);
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.reviews)) {
    return reject("评论证据缺少可解析的 data.reviews 数组");
  }
  const reviews: ReviewRecord[] = [];
  let skippedRows = 0;
  for (const raw of data.reviews) {
    if (!isRecord(raw)) {
      skippedRows += 1;
      continue;
    }
    const text = parseReviewText(raw);
    if (!text) {
      skippedRows += 1;
      continue;
    }
    const rating = asRating(raw.rating);
    const reviewAsin = asAsin(raw.asin) ?? asin;
    reviews.push({
      asin: reviewAsin,
      attachmentId: attachment.attachmentId,
      contentHash: attachment.contentHash,
      capturedAt: attachment.capturedAt,
      rating,
      reviewDate: asText(raw.reviewDate) ?? asText(raw.date),
      title: asText(raw.title) ?? asText(raw.reviewTitle),
      verifiedPurchase: typeof raw.verifiedPurchase === "boolean" ? raw.verifiedPurchase : null,
      text,
      dedupeKey: `${reviewAsin}|${normalizeForDedupe(text)}|${rating === null ? "na" : String(rating)}`,
    });
  }
  if (reviews.length === 0) {
    return reject("评论证据 data.reviews 中没有可用正文（全部为空或结构不符）");
  }
  return { parsed: { asin, reviews, skippedRows } };
}

// ============================================================================
// 主题聚合
// ============================================================================

/** 同一评论同一主题出现多种态度时，取「最强」的一种（依次为投诉 > 接受 > 待核对 > 提及 > 正面）。 */
const INTENT_PRIORITY: Record<VocIntent, number> = {
  complaint: 0,
  tolerated: 1,
  uncertain: 2,
  mention: 3,
  positive: 4,
};

const STRENGTH_ORDER: Record<DeepResearchStrength, number> = {
  recurring: 0,
  weak: 1,
  isolated: 2,
  mention_only: 3,
  insufficient: 4,
};

/**
 * 证据强度只由「明确负面反馈」条数决定；提及数单独展示，不参与门槛。
 * 0 条投诉但有提及 → mention_only（只算观察，不算痛点）。
 */
function themeStrength(complaintCount: number, sampleDenominator: number, mentionCount: number): DeepResearchStrength {
  if (sampleDenominator <= 0) return "insufficient";
  if (complaintCount <= 0) return mentionCount > 0 ? "mention_only" : "insufficient";
  // 单一权威推导（isolated / weak / recurring），阈值来自 vocThresholds，不在此另设。
  return computeThemeStrength(complaintCount);
}

type QuoteCandidate = { review: ReviewRecord; sentence: string; matchedKeyword: string };

function quoteSort(a: QuoteCandidate, b: QuoteCandidate): number {
  const ratingA = a.review.rating ?? Number.POSITIVE_INFINITY;
  const ratingB = b.review.rating ?? Number.POSITIVE_INFINITY;
  if (ratingA !== ratingB) return ratingA - ratingB;
  if (a.review.reviewDate !== b.review.reviewDate) {
    return (b.review.reviewDate ?? "").localeCompare(a.review.reviewDate ?? "");
  }
  return a.review.capturedAt.localeCompare(b.review.capturedAt);
}

function toQuote(candidate: QuoteCandidate, intent: VocIntent): DeepResearchVocQuote {
  return {
    asin: candidate.review.asin,
    attachmentId: candidate.review.attachmentId,
    contentHash: candidate.review.contentHash,
    capturedAt: candidate.review.capturedAt,
    rating: candidate.review.rating,
    reviewDate: candidate.review.reviewDate,
    excerpt: candidate.sentence.replace(/\s+/gu, " ").trim().slice(0, MAX_EXCERPT_CHARS),
    matchedKeyword: candidate.matchedKeyword,
    intent,
    sentenceSentiment: intent === "positive" ? "positive" : intent === "complaint" ? "negative" : "neutral",
  };
}

// ============================================================================
// 主入口
// ============================================================================

export function buildVocProjection(input: VocProjectionInput): DeepResearchVocProjection {
  const rejectedAttachments: Rejection[] = [];
  const expectedAsins = input.expectedAsins && input.expectedAsins.length > 0
    ? new Set(input.expectedAsins.map((asin) => asin.trim().toUpperCase()).filter((asin) => asin.length > 0))
    : null;

  const dedupedReviews = new Map<string, ReviewRecord>();
  let attachmentsRead = 0;
  let rawReviewCount = 0;
  let skippedReviewRows = 0;

  for (const attachment of input.attachments) {
    const result = parseAttachment(attachment, expectedAsins);
    if ("rejection" in result) {
      rejectedAttachments.push(result.rejection);
      continue;
    }
    attachmentsRead += 1;
    rawReviewCount += result.parsed.reviews.length;
    skippedReviewRows += result.parsed.skippedRows;
    for (const review of result.parsed.reviews) {
      const existing = dedupedReviews.get(review.dedupeKey);
      if (!existing || Date.parse(review.capturedAt) > Date.parse(existing.capturedAt)) {
        dedupedReviews.set(review.dedupeKey, review);
      }
    }
  }

  // 规范化买家声音：Amazon 评论若已被 canonical 归一，只在这里出现（reviewEvidence 为空）。
  for (const group of input.observations ?? []) {
    const groupAsin = asinFromSubjectKey(group.subjectKey);
    if (!groupAsin) {
      rejectedAttachments.push({ attachmentId: group.attachmentId, reason: "买家声音附件的主体键无法解析出 ASIN" });
      continue;
    }
    if (expectedAsins && !expectedAsins.has(groupAsin)) {
      rejectedAttachments.push({ attachmentId: group.attachmentId, reason: `附件 ASIN ${groupAsin} 不在本次研究范围内` });
      continue;
    }
    let usable = 0;
    for (const observation of group.observations) {
      // 只把 Amazon 评论计入商品级 VOC；帖子/评论（Reddit 等）没有 ASIN 归属，不混入。
      if (observation.source !== "amazon_review") continue;
      const text = asText(observation.text);
      if (!text) { skippedReviewRows += 1; continue; }
      const rating = asRating(observation.rating);
      const reviewAsin = groupAsin;
      rawReviewCount += 1;
      usable += 1;
      const review: ReviewRecord = {
        asin: reviewAsin,
        attachmentId: group.attachmentId,
        contentHash: observation.contentHash || group.contentHash,
        capturedAt: group.capturedAt,
        rating,
        reviewDate: asText(observation.publishedAt),
        title: asText(observation.title),
        verifiedPurchase: typeof observation.verifiedPurchase === "boolean" ? observation.verifiedPurchase : null,
        text,
        dedupeKey: externalContentDedupeKey(reviewAsin, observation.externalContentId, text, rating),
      };
      const existing = dedupedReviews.get(review.dedupeKey);
      if (!existing || Date.parse(review.capturedAt) > Date.parse(existing.capturedAt)) {
        dedupedReviews.set(review.dedupeKey, review);
      }
    }
    if (usable > 0) attachmentsRead += 1;
    else rejectedAttachments.push({ attachmentId: group.attachmentId, reason: "买家声音附件中没有可用的 Amazon 评论正文" });
  }

  const reviews = [...dedupedReviews.values()];
  const duplicateReviewsSuppressed = Math.max(0, rawReviewCount - reviews.length);

  const asinDenominator = new Map<string, number>();
  for (const review of reviews) {
    asinDenominator.set(review.asin, (asinDenominator.get(review.asin) ?? 0) + 1);
  }
  const asins = [...asinDenominator.keys()].sort();

  // 逐条评论 → 逐句 → 主题 → 该评论对该主题的最强态度（每条评论每主题只计一次）
  const perReviewIntent = new Map<string, Map<string, { intent: VocIntent; sentence: string; matchedKeyword: string }>>();
  for (const review of reviews) {
    for (const sentence of splitSentences(review.text)) {
      for (const dimension of THEME_DIMENSIONS) {
        const matches = keywordMatches(dimension, sentence);
        if (matches.length === 0) continue;
        // 食物从垫子表面滑落是“不粘/易脱离”语境，不能算垫子防滑不足。
        if (dimension.id === "slip_resistance" && isFoodReleaseSlip(sentence)) continue;
        let reviewMap = perReviewIntent.get(review.dedupeKey);
        if (!reviewMap) { reviewMap = new Map(); perReviewIntent.set(review.dedupeKey, reviewMap); }
        for (const match of matches) {
          const intent = classifyIntent(sentence, match);
          const existing = reviewMap.get(dimension.id);
          if (!existing || INTENT_PRIORITY[intent] < INTENT_PRIORITY[existing.intent]) {
            reviewMap.set(dimension.id, { intent, sentence, matchedKeyword: match.keyword });
          }
        }
      }
    }
  }

  const themes: DeepResearchVocTheme[] = [];
  for (const dimension of THEME_DIMENSIONS) {
    const members: Array<{ review: ReviewRecord; sentence: string; matchedKeyword: string; intent: VocIntent }> = [];
    for (const review of reviews) {
      const decision = perReviewIntent.get(review.dedupeKey)?.get(dimension.id);
      if (!decision) continue;
      members.push({ review, sentence: decision.sentence, matchedKeyword: decision.matchedKeyword, intent: decision.intent });
    }
    if (members.length === 0) continue;

    const complaintMembers = members.filter((item) => item.intent === "complaint");
    const toleratedMembers = members.filter((item) => item.intent === "tolerated");
    const uncertainMembers = members.filter((item) => item.intent === "uncertain");
    const mentionMembers = members.filter((item) => item.intent === "mention");
    const positiveMembers = members.filter((item) => item.intent === "positive");
    const negativeMembers = members.filter((item) => item.intent !== "positive");

    // 负面主题：至少要有人提到该属性（提及 / 抱怨 / 接受 / 待核对）。
    if (negativeMembers.length > 0) {
      const themeAsins = [...new Set(negativeMembers.map((item) => item.review.asin))].sort();
      const perAsin = themeAsins.map((asin) => ({
        asin,
        count: negativeMembers.filter((item) => item.review.asin === asin).length,
        denominator: asinDenominator.get(asin) ?? 0,
      }));
      const sampleDenominator = perAsin.reduce((total, item) => total + item.denominator, 0);
      const complaintCount = complaintMembers.length;
      const strength = themeStrength(complaintCount, sampleDenominator, negativeMembers.length);
      const ordered = [...complaintMembers, ...toleratedMembers, ...uncertainMembers, ...mentionMembers];
      themes.push({
        id: dimension.id,
        label: dimension.label,
        polarity: "negative",
        asins: themeAsins,
        independentReviewCount: complaintCount,
        mentionCount: negativeMembers.length,
        complaintCount,
        toleratedCount: toleratedMembers.length,
        uncertainCount: uncertainMembers.length,
        positiveCount: positiveMembers.length,
        sampleDenominator,
        perAsin,
        strength,
        quotes: ordered.slice(0, MAX_QUOTES_PER_THEME).map((item) => toQuote(item, item.intent)),
        limitations: buildThemeLimitations({
          dimension,
          complaintCount,
          mentionCount: negativeMembers.length,
          toleratedCount: toleratedMembers.length,
          uncertainCount: uncertainMembers.length,
          sampleDenominator,
          asinCount: themeAsins.length,
          strength,
        }),
      });
    }

    // 正面主题：单独一组，不参与负面复现判断。
    if (positiveMembers.length > 0) {
      const positiveAsins = [...new Set(positiveMembers.map((item) => item.review.asin))].sort();
      const positivePerAsin = positiveAsins.map((asin) => ({
        asin,
        count: positiveMembers.filter((item) => item.review.asin === asin).length,
        denominator: asinDenominator.get(asin) ?? 0,
      }));
      const positiveDenominator = positivePerAsin.reduce((total, item) => total + item.denominator, 0);
      const positiveStrength = themeStrength(positiveMembers.length, positiveDenominator, positiveMembers.length);
      themes.push({
        id: `${dimension.id}_positive`,
        label: dimension.positiveLabel,
        polarity: "positive",
        asins: positiveAsins,
        independentReviewCount: positiveMembers.length,
        mentionCount: positiveMembers.length,
        complaintCount: 0,
        toleratedCount: 0,
        uncertainCount: 0,
        positiveCount: positiveMembers.length,
        sampleDenominator: positiveDenominator,
        perAsin: positivePerAsin,
        strength: positiveStrength,
        quotes: [...positiveMembers]
          .sort((a, b) => (b.review.rating ?? Number.NEGATIVE_INFINITY) - (a.review.rating ?? Number.NEGATIVE_INFINITY))
          .slice(0, MAX_QUOTES_PER_THEME)
          .map((item) => toQuote(item, "positive")),
        limitations: [],
      });
    }
  }

  themes.sort((a, b) => {
    const byStrength = STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength];
    if (byStrength !== 0) return byStrength;
    const aCount = a.polarity === "negative" ? a.complaintCount : a.positiveCount;
    const bCount = b.polarity === "negative" ? b.complaintCount : b.positiveCount;
    if (aCount !== bCount) return bCount - aCount;
    if (a.mentionCount !== b.mentionCount) return b.mentionCount - a.mentionCount;
    const polarityOrder = { negative: 0, positive: 1, neutral: 2 } as const;
    if (polarityOrder[a.polarity] !== polarityOrder[b.polarity]) {
      return polarityOrder[a.polarity] - polarityOrder[b.polarity];
    }
    return a.id.localeCompare(b.id);
  });

  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA,
    ruleVersion: VOC_RULE_VERSION,
    attachmentsRead,
    reviewsRead: reviews.length,
    duplicateReviewsSuppressed,
    asins,
    themes,
    limitations: buildProjectionLimitations({
      attachmentsRead,
      reviewsRead: reviews.length,
      asins,
      reviews,
      rejectedAttachments,
      skippedReviewRows,
    }),
    rejectedAttachments,
  };
}

function buildThemeLimitations(input: {
  dimension: ThemeDimension;
  complaintCount: number;
  mentionCount: number;
  toleratedCount: number;
  uncertainCount: number;
  sampleDenominator: number;
  asinCount: number;
  strength: DeepResearchStrength;
}): string[] {
  const limitations: string[] = [];
  if (input.strength === "mention_only") {
    limitations.push(
      `共 ${input.mentionCount} 条评论提到该属性，但没有一条构成明确的使用障碍或不满，因此只能算「主题提及」，不能算痛点。`,
    );
  } else if (input.strength === "isolated") {
    limitations.push(`仅 ${input.complaintCount} 条明确负面反馈，未达弱信号门槛（≥ ${VOC_STRENGTH_THRESHOLDS.weakMin} 条），只能作为待观察线索。`);
  } else if (input.strength === "weak") {
    limitations.push(`共 ${input.complaintCount} 条明确负面反馈，尚未达到系统复现门槛（≥ ${VOC_STRENGTH_THRESHOLDS.recurringMin} 条），不足以支撑开发投入。`);
  } else if (input.strength === "recurring") {
    limitations.push(`共 ${input.complaintCount} 条明确负面反馈，已达系统复现门槛；但复现只说明该反馈在样本中重复出现，不等于市场普遍需求。`);
  } else {
    limitations.push("样本分母为零，无法计算该主题的证据强度。");
  }
  if (input.toleratedCount > 0) {
    limitations.push(`${input.toleratedCount} 条评论提到该缺点但明确表示可以接受，不计入负面复现。`);
  }
  if (input.uncertainCount > 0) {
    limitations.push(`${input.uncertainCount} 条评论只有轻微或语境不足的表述，暂列为待人工核对，不计入负面复现。`);
  }
  if (input.asinCount <= 1) {
    limitations.push("仅覆盖 1 个 ASIN，无法区分是个体批次问题还是类目共性问题。");
  }
  limitations.push(
    `主题按固定中英关键词词典判定（本句匹配「${input.dimension.label}」相关词），可能漏掉同义表达；样本分母为这些 ASIN 的去重评论总数（${input.sampleDenominator} 条）。`,
  );
  return limitations;
}

function buildProjectionLimitations(input: {
  attachmentsRead: number;
  reviewsRead: number;
  asins: readonly string[];
  reviews: readonly ReviewRecord[];
  rejectedAttachments: readonly Rejection[];
  skippedReviewRows: number;
}): string[] {
  const limitations: string[] = [];
  if (input.attachmentsRead === 0) {
    limitations.push("本轮没有任何可用的评论证据附件，VOC 主题无法生成。");
  }
  if (input.rejectedAttachments.length > 0) {
    limitations.push(
      `${input.rejectedAttachments.length} 个评论附件被拒收（状态不允许或结构无法解析），未计入任何主题：${
        input.rejectedAttachments.map((item) => `${item.attachmentId}（${item.reason}）`).join("；")
      }。`,
    );
  }
  if (input.reviewsRead > 0 && input.asins.length <= 1) {
    limitations.push(`评论仅覆盖 ${input.asins.length} 个 ASIN${input.asins.length === 1 ? `（${input.asins[0]}）` : ""}，跨商品/变体的差异无法判断。`);
  }
  if (input.reviewsRead > 0 && input.reviewsRead < SMALL_SAMPLE_THRESHOLD) {
    limitations.push(
      `本轮仅读到 ${input.reviewsRead} 条去重评论（不足 ${SMALL_SAMPLE_THRESHOLD} 条），主题计数只能作为线索，不能换算成买家比例。`,
    );
  }
  if (input.reviewsRead > 0) {
    const fiveStar = input.reviews.filter((review) => review.rating !== null && review.rating >= 5).length;
    const ratio = fiveStar / input.reviewsRead;
    if (ratio > HIGH_FIVE_STAR_RATIO) {
      limitations.push(
        `五星评论占比 ${Math.round(ratio * 100)}%（${fiveStar}/${input.reviewsRead}），好评明显偏斜，负面主题容易被低估。`,
      );
    }
    const missingRating = input.reviews.filter((review) => review.rating === null).length;
    if (missingRating > 0) {
      limitations.push(`${missingRating} 条评论缺少星级，无法按评分核对抱怨的严重程度。`);
    }
    const missingDate = input.reviews.filter((review) => review.reviewDate === null).length;
    if (missingDate > 0) {
      limitations.push(`${missingDate} 条评论缺少评论日期，无法判断问题是否集中在近期批次。`);
    }
    if (input.skippedReviewRows > 0) {
      limitations.push(`${input.skippedReviewRows} 条评论行缺少正文或结构不符，已跳过，未计入分母。`);
    }
  }
  limitations.push(
    "评论证据不含 reviewId 与变体（颜色/尺寸）字段，去重只能基于 ASIN + 规范化文本 + 星级；同文不同星的评论会被计为两条。",
  );
  limitations.push("情感判定为固定规则的句级判定，不排除反讽、翻译腔和行业惯用语造成的误判，关键结论需人工回看原文。");
  return limitations;
}
