import { createHash } from "node:crypto";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com"]);
const REDDIT_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/u;

export type RedditVisiblePostCard = {
  readonly title: string | null;
  readonly body: string | null;
  readonly permalink: string;
  readonly subreddit?: string | null;
  readonly publishedAt?: string | null;
  readonly authorRef?: string | null;
  readonly score?: number | null;
  readonly commentCount?: number | null;
};

export type RedditVisibleComment = {
  readonly externalContentId: string;
  readonly parentContentId: string;
  readonly threadId: string;
  readonly subreddit: string | null;
  readonly depth: number;
  readonly text: string;
  readonly sourceUrl: string | null;
  readonly publishedAt: string | null;
  readonly authorRef: string | null;
  readonly score: number | null;
};

export type RedditVisiblePost = {
  externalContentId: string;
  sourceUrl: string;
  subreddit: string | null;
  title: string | null;
  text: string;
  publishedAt: string | null;
  authorRef: string | null;
  score: number | null;
  commentCount: number | null;
  comments: RedditVisibleComment[];
};

function clean(value: string | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeRedditUrl(value: string, base = "https://www.reddit.com"): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || !REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function postIdFromUrl(value: string): string | null {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const commentsIndex = parts.indexOf("comments");
    const candidate = commentsIndex >= 0 ? parts[commentsIndex + 1] : null;
    return candidate && REDDIT_ID.test(candidate) ? candidate.replace(/^t3_/u, "") : null;
  } catch {
    return null;
  }
}

function subredditFromUrl(value: string): string | null {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part.toLowerCase() === "r");
    const candidate = index >= 0 ? parts[index + 1] : null;
    return candidate && SUBREDDIT.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^t[13]_/u, "") ?? "";
  return REDDIT_ID.test(normalized) ? normalized : null;
}

export function opaqueRedditAuthorRef(authorIdentity: string | null | undefined, captureSalt: string): string | null {
  const identity = clean(authorIdentity ?? null, 200);
  if (!identity || !captureSalt.trim()) return null;
  return `anon:${createHash("sha256").update(`${captureSalt}\0${identity.toLocaleLowerCase("en-US")}`).digest("hex").slice(0, 24)}`;
}

export function parseVisibleRedditCount(value: string | null | undefined): number | null {
  const normalized = value?.normalize("NFC").trim().replace(/\s+/gu, " ") ?? "";
  // Rounded labels such as 1.2k are deliberately unknown, never silently converted to an exact count.
  const match = normalized.match(/^([+-]?(?:\d+|\d{1,3}(?:,\d{3})+))(?:\s*(?:points?|comments?|votes?|upvotes?))?$/iu);
  if (!match) return null;
  const numeric = Number(match[1].replace(/,/gu, ""));
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function normalizedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function parseVisibleRedditPostCard(card: RedditVisiblePostCard): RedditVisiblePost | null {
  const sourceUrl = safeRedditUrl(card.permalink);
  const title = clean(card.title, 500);
  const body = clean(card.body, 5_000) ?? title;
  if (!sourceUrl || !body) return null;
  const id = postIdFromUrl(sourceUrl)
    ?? `post-${createHash("sha256").update(`${title ?? ""}\n${body}`).digest("hex").slice(0, 24)}`;
  const declaredSubreddit = clean(card.subreddit ?? null, 64);
  const subreddit = declaredSubreddit && SUBREDDIT.test(declaredSubreddit)
    ? declaredSubreddit
    : subredditFromUrl(sourceUrl);
  return {
    externalContentId: id,
    sourceUrl,
    subreddit,
    title,
    text: body,
    publishedAt: normalizedDate(card.publishedAt),
    authorRef: card.authorRef && /^anon:[a-f0-9]{24}$/u.test(card.authorRef) ? card.authorRef : null,
    score: typeof card.score === "number" && Number.isSafeInteger(card.score) ? card.score : null,
    commentCount: typeof card.commentCount === "number" && Number.isSafeInteger(card.commentCount) && card.commentCount >= 0
      ? card.commentCount
      : null,
    comments: [],
  };
}

export function redditCommentIdFromUrl(value: string | null, base: string, fallbackText: string): string {
  if (value) {
    try {
      const url = new URL(value, base);
      if (url.protocol === "https:" && !url.username && !url.password && REDDIT_HOSTS.has(url.hostname.toLowerCase())) {
        const parts = url.pathname.split("/").filter(Boolean);
        const commentsIndex = parts.indexOf("comments");
        const candidate = commentsIndex >= 0 ? parts.at(-1) : null;
        const normalized = candidate?.replace(/^t1_/u, "") ?? "";
        if (REDDIT_ID.test(normalized) && normalized !== parts[commentsIndex + 1]) return normalized;
      }
    } catch {
      // DOM-provided malformed links get a stable content-addressed local reference.
    }
  }
  return `comment-${createHash("sha256").update(fallbackText.normalize("NFC").trim()).digest("hex").slice(0, 24)}`;
}

export function parseVisibleRedditComment(input: {
  readonly externalContentId: string;
  readonly parentId: string | null;
  readonly threadId: string;
  readonly subreddit?: string | null;
  readonly depth?: number | null;
  readonly text: string;
  readonly permalink: string | null;
  readonly publishedAt?: string | null;
  readonly authorRef?: string | null;
  readonly score?: number | null;
}): RedditVisibleComment | null {
  const text = clean(input.text, 1_000);
  const externalContentId = normalizeId(input.externalContentId);
  const threadId = normalizeId(input.threadId);
  const suppliedParent = normalizeId(input.parentId);
  if (!text || !externalContentId || !threadId) return null;
  const sourceUrl = input.permalink ? safeRedditUrl(input.permalink) : null;
  if (input.permalink && !sourceUrl) return null;
  const parentContentId = suppliedParent ?? threadId;
  const declaredSubreddit = clean(input.subreddit ?? null, 64);
  const subreddit = declaredSubreddit && SUBREDDIT.test(declaredSubreddit)
    ? declaredSubreddit
    : sourceUrl ? subredditFromUrl(sourceUrl) : null;
  const depth = typeof input.depth === "number" && Number.isSafeInteger(input.depth) && input.depth >= 0 && input.depth <= 32
    ? input.depth
    : 0;
  return {
    externalContentId,
    parentContentId,
    threadId,
    subreddit,
    depth,
    text,
    sourceUrl,
    publishedAt: normalizedDate(input.publishedAt),
    authorRef: input.authorRef && /^anon:[a-f0-9]{24}$/u.test(input.authorRef) ? input.authorRef : null,
    score: typeof input.score === "number" && Number.isSafeInteger(input.score) ? input.score : null,
  };
}

export function shouldExpandRedditComments(label: string, visible: boolean): boolean {
  return visible && /(more replies|view more comments|load more comments|continue this thread)/iu.test(label);
}

export function safeRedditSearchNextHref(href: string | null, currentUrl: string, query: string): string | null {
  if (!href) return null;
  const safeHref = safeRedditUrl(href, currentUrl);
  if (!safeHref) return null;
  try {
    const next = new URL(safeHref);
    const current = new URL(currentUrl);
    if (next.origin !== "https://www.reddit.com" || current.origin !== next.origin
      || next.pathname.replace(/\/$/u, "") !== "/search"
      || next.searchParams.get("q") !== query
      || next.searchParams.get("type") !== "link") return null;
    return next.toString();
  } catch {
    return null;
  }
}

export function classifyRedditIdentity(text: string, asin: string, title: string): "EXACT" | "PROBABLE" | "UNRESOLVED" {
  const normalizedText = text.toUpperCase();
  const normalizedAsin = asin.toUpperCase();
  let exactOffset = /^[A-Z0-9]{10}$/u.test(normalizedAsin) ? normalizedText.indexOf(normalizedAsin) : -1;
  while (exactOffset >= 0) {
    const before = exactOffset === 0 ? "" : normalizedText[exactOffset - 1] ?? "";
    const after = normalizedText[exactOffset + normalizedAsin.length] ?? "";
    if (!/[A-Z0-9]/u.test(before) && !/[A-Z0-9]/u.test(after)) return "EXACT";
    exactOffset = normalizedText.indexOf(normalizedAsin, exactOffset + 1);
  }
  const tokens = title.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? [];
  const stop = new Set(["with", "from", "this", "that", "your", "pack", "inch", "inches", "black", "white", "new"]);
  const identifying = [...new Set(tokens.filter((token) => !stop.has(token)))].slice(0, 8);
  if (identifying.length >= 4 && identifying.filter((token) => text.toLowerCase().includes(token)).length >= Math.ceil(identifying.length * 0.85)) return "PROBABLE";
  return "UNRESOLVED";
}

export function extractOwnerExperience(text: string) {
  const firstPerson = /\b(?:i own|i bought|i purchased|i have|i've used|i used|my (?:unit|one|experience)|we own|we bought)\b/iu.test(text);
  if (!firstPerson) return null;
  const duration = text.match(/\b(?:after|for|within)\s+(\d+\s*(?:days?|weeks?|months?|years?))\b/iu)?.[1] ?? null;
  const useCase = text.match(/\b(?:for|using it for|use it for)\s+([^.!?\n]{3,80})/iu)?.[1]?.trim() ?? null;
  const failureMode = /\b(?:broke|broken|cracked|failed|stopped working|leaking|rusted|wore out)\b/iu.test(text)
    ? text.match(/\b(?:broke|broken|cracked|failed|stopped working|leaking|rusted|wore out)\b[^.!?\n]{0,90}/iu)?.[0] ?? null
    : null;
  const replacementProduct = text.match(/\b(?:replaced it with|switched to|bought a)\s+([^.!?\n]{2,70})/iu)?.[1]?.trim() ?? null;
  const switchReason = text.match(/\b(?:because|since)\s+([^.!?\n]{3,100})/iu)?.[1]?.trim() ?? null;
  return {
    claimedOwnership: true,
    ownershipDuration: duration,
    useCase,
    failureMode,
    timeToFailure: failureMode ? duration : null,
    replacementProduct,
    switchReason,
  };
}

/** Builds a bounded DOM-derived reply tree; no missing/fuzzy edge is promoted to an exact parent. */
export function parseVisibleRedditCommentTree(input: {
  readonly threadId: string;
  readonly subreddit?: string | null;
  readonly comments: readonly {
    readonly externalContentId: string;
    readonly parentId: string | null;
    readonly depth?: number | null;
    readonly text: string;
    readonly permalink: string | null;
    readonly publishedAt?: string | null;
    readonly authorRef?: string | null;
    readonly score?: number | null;
  }[];
  readonly maxDepth?: number;
}): RedditVisibleComment[] {
  const maximumDepth = Math.max(0, Math.min(input.maxDepth ?? 6, 32));
  const byId = new Map<string, RedditVisibleComment>();
  for (const comment of input.comments) {
    const parsed = parseVisibleRedditComment({ ...comment, threadId: input.threadId, subreddit: input.subreddit });
    if (parsed && !byId.has(parsed.externalContentId)) byId.set(parsed.externalContentId, parsed);
  }

  const depths = new Map<string, number | null>();
  const resolving = new Set<string>();
  const depthFor = (id: string): number | null => {
    if (depths.has(id)) return depths.get(id) ?? null;
    const comment = byId.get(id);
    if (!comment) return 0;
    if (resolving.has(id)) return null;
    resolving.add(id);
    const parentId = comment.parentContentId;
    let depth: number | null;
    if (parentId === comment.threadId) {
      depth = 0;
    } else if (byId.has(parentId)) {
      const parentDepth = depthFor(parentId);
      depth = parentDepth === null ? null : Math.min(maximumDepth + 1, parentDepth + 1);
    } else {
      depth = comment.depth;
    }
    resolving.delete(id);
    depths.set(id, depth);
    return depth;
  };

  return [...byId.values()]
    .flatMap((comment) => {
      const depth = depthFor(comment.externalContentId);
      return depth === null || depth > maximumDepth ? [] : [{ ...comment, depth }];
    });
}
