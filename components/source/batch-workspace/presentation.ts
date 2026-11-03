/**
 * T01 批次商品画廊 · 展示层纯函数（presentation-only，不写回任何事实）。
 *
 * 设计约束（对应 T01 设计与业务要求）：
 * - 中文标题只有在 AUTHORITATIVE_CHINESE_TITLE 时才可作为商品主名；
 *   DERIVED_FROM_CATEGORY 只是类目辅助，不得冒充精确中文商品名。
 * - 缺失值保持未知：不补 0、不猜币种、不把冲突读数当事实。
 * - 价格按真实 currency 格式化；未知币种显示币种代码而非硬编码 $。
 */

export type GalleryFieldStatus = "confirmed" | "estimated" | "missing" | "conflict" | "not_available";

export type GalleryItem = {
  id: string;
  batchId?: string;
  asin: string;
  marketplace?: string | null;
  title?: string | null;
  chineseTitle?: string | null;
  chineseTitleStatus?: "AUTHORITATIVE_CHINESE_TITLE" | "DERIVED_FROM_CATEGORY" | "UNAVAILABLE" | null;
  chineseCategory?: string | null;
  category?: string | null;
  image?: string | null;
  imageStatus?: "AUTHORITATIVE_IMAGE_AVAILABLE" | "AUTHORITATIVE_IMAGE_MISSING" | null;
  brand?: string | null;
  bsr?: { rank?: number | null; category?: string | null } | null;
  price?: { value: number | null; currency: string; status: GalleryFieldStatus } | null;
  rating?: { value: number | null; status: GalleryFieldStatus } | null;
  reviewCount?: { value: number | null; status: GalleryFieldStatus } | null;
  enrichmentStatus?: "enriched" | "captured_partial" | null;
  usageStatus: "research_ready" | "needs_review" | "blocked";
  archivedAt?: string | null;
};

export type GalleryTitle = {
  /** 卡片主标题（权威中文 > 原始标题 > 兜底）。 */
  primary: string;
  /** 主标题是否为权威中文；为 false 时主标题是原始（英文）标题。 */
  primaryIsChinese: boolean;
  /** 需要保留可查看的原始英文标题（当主标题为权威中文时）。 */
  secondaryOriginal: string | null;
  /** 类目辅助（中文类目优先），不得当作商品名。 */
  categoryNote: string | null;
  titleSource: "AUTHORITATIVE_CHINESE_TITLE" | "ORIGINAL_TITLE" | "FALLBACK";
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
  JPY: "\u00a5",
  CNY: "\u00a5",
  CAD: "CA$",
  AUD: "A$",
  MXN: "MX$",
  INR: "\u20b9",
  BRL: "R$",
  SEK: "SEK ",
  PLN: "PLN ",
  TRY: "TRY ",
  AED: "AED ",
  SAR: "SAR ",
  SGD: "S$",
};

/**
 * 标题分层：DERIVED_FROM_CATEGORY 只进类目辅助，绝不进主标题。
 * 没有原始标题时才退到「品牌 · 类目」或 ASIN，避免出现空标题卡片。
 */
export function resolveGalleryTitle(item: GalleryItem): GalleryTitle {
  const original = typeof item.title === "string" && item.title.trim() ? item.title.trim() : null;
  const chinese = typeof item.chineseTitle === "string" && item.chineseTitle.trim() ? item.chineseTitle.trim() : null;
  const hasAuthoritativeChinese = item.chineseTitleStatus === "AUTHORITATIVE_CHINESE_TITLE" && Boolean(chinese);

  if (hasAuthoritativeChinese) {
    return {
      primary: chinese as string,
      primaryIsChinese: true,
      secondaryOriginal: original && original !== chinese ? original : null,
      categoryNote: null,
      titleSource: "AUTHORITATIVE_CHINESE_TITLE",
    };
  }

  const categoryNote = (item.chineseCategory && item.chineseCategory.trim())
    || (item.chineseTitleStatus === "DERIVED_FROM_CATEGORY" ? chinese : null)
    || (item.category && item.category.trim())
    || null;

  if (original) {
    return {
      primary: original,
      primaryIsChinese: false,
      secondaryOriginal: null,
      categoryNote,
      titleSource: "ORIGINAL_TITLE",
    };
  }

  const fallback = [item.brand?.trim(), categoryNote].filter(Boolean).join(" · ")
    || item.asin
    || "未提供标题";
  return {
    primary: fallback,
    primaryIsChinese: false,
    secondaryOriginal: null,
    categoryNote,
    titleSource: "FALLBACK",
  };
}

/** 金额格式化：未知币种保留代码，绝不默认成美元。 */
export function formatMoneyValue(
  value: number | null | undefined,
  currency: string | null | undefined,
): { text: string; currencyCode: string } | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const code = (currency || "").trim().toUpperCase();
  const fractionDigits = code === "JPY" || code === "CNY" ? 0 : 2;
  const amount = numeric.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  if (!code) return { text: amount, currencyCode: "" };
  const symbol = CURRENCY_SYMBOLS[code];
  return {
    text: symbol ? `${symbol}${amount}` : `${amount} ${code}`,
    currencyCode: code,
  };
}

export type RatingDisplay = { text: string; pending: boolean };

/** 评分展示：冲突/未复核不冒充确认值。 */
export function formatRatingDisplay(rating: GalleryItem["rating"]): RatingDisplay | null {
  if (!rating) return null;
  const status = String(rating.status);
  if (status === "conflict" || status === "unverified") {
    return { text: "评分待核对", pending: true };
  }
  if (rating.value === null || rating.value === undefined || !Number.isFinite(Number(rating.value))) {
    return null;
  }
  const value = Number(rating.value);
  return { text: value.toFixed(1), pending: false };
}

export type ReviewCountDisplay = { text: string | null; pending: boolean };

/**
 * 评论数展示：只有 confirmed 读数进入正文；冲突/未复核只显示状态，不显示数字。
 * 依据项目既有评论量口径（verified / conflict / unverified / missing）。
 */
export function formatReviewCountDisplay(reviewCount: GalleryItem["reviewCount"]): ReviewCountDisplay {
  if (!reviewCount) return { text: null, pending: false };
  const status = String(reviewCount.status);
  if (status === "conflict") return { text: "评论数待核对", pending: true };
  if (status === "unverified") return { text: "评论数未复核", pending: true };
  if (status === "missing") return { text: "评论数缺失", pending: false };
  if (reviewCount.value === null || reviewCount.value === undefined) return { text: null, pending: false };
  return { text: `${Number(reviewCount.value).toLocaleString("en-US")} 条评价`, pending: false };
}

export type UsagePresentation = { label: string; tone: "ok" | "warn" | "off" };

export function resolveUsagePresentation(item: Pick<GalleryItem, "usageStatus" | "archivedAt">): UsagePresentation {
  if (item.archivedAt) return { label: "已归档", tone: "off" };
  if (item.usageStatus === "research_ready") return { label: "有效商品", tone: "ok" };
  if (item.usageStatus === "needs_review") return { label: "待核对", tone: "warn" };
  return { label: "已排除", tone: "off" };
}

export type GalleryGap = { key: string; label: string; tone: "warn" | "info" };

/**
 * 卡片只保留 2 个最重要缺口，避免把八模块状态全部塞进卡片。
 * 品牌缺失由卡片品牌行直接表达（「品牌未记录」），不重复堆同一个缺口。
 * 优先级：无图 > 详情 > BSR。
 */
export function resolveGalleryGaps(item: GalleryItem): GalleryGap[] {
  const gaps: GalleryGap[] = [];
  if (item.imageStatus === "AUTHORITATIVE_IMAGE_MISSING" || !item.image) {
    gaps.push({ key: "image", label: "无商品图", tone: "warn" });
  }
  if (item.enrichmentStatus === "captured_partial") {
    gaps.push({ key: "detail", label: "详情部分完成", tone: "info" });
  } else if (!item.enrichmentStatus) {
    gaps.push({ key: "detail", label: "详情待补齐", tone: "info" });
  }
  if (!item.bsr || item.bsr.rank === null || item.bsr.rank === undefined) {
    gaps.push({ key: "bsr", label: "BSR 缺失", tone: "info" });
  }
  return gaps.slice(0, 2);
}

export function formatBsrDisplay(bsr: GalleryItem["bsr"]): string | null {
  if (!bsr || bsr.rank === null || bsr.rank === undefined) return null;
  return `#${Number(bsr.rank).toLocaleString("en-US")}`;
}

const AMAZON_DOMAINS: Record<string, string> = {
  US: "www.amazon.com",
  CA: "www.amazon.ca",
  MX: "www.amazon.com.mx",
  BR: "www.amazon.com.br",
  UK: "www.amazon.co.uk",
  GB: "www.amazon.co.uk",
  DE: "www.amazon.de",
  FR: "www.amazon.fr",
  IT: "www.amazon.it",
  ES: "www.amazon.es",
  NL: "www.amazon.nl",
  SE: "www.amazon.se",
  PL: "www.amazon.pl",
  TR: "www.amazon.com.tr",
  JP: "www.amazon.co.jp",
  IN: "www.amazon.in",
  AU: "www.amazon.com.au",
  SG: "www.amazon.sg",
  AE: "www.amazon.ae",
  SA: "www.amazon.sa",
};

/** 按市场站点生成来源链接；未知站点按美国站（页面既有默认）而不是猜测其他域名。 */
export function amazonProductUrl(asin: string | null | undefined, marketplace: string | null | undefined): string | null {
  const normalizedAsin = typeof asin === "string" ? asin.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{10}$/u.test(normalizedAsin)) return null;
  const code = (marketplace || "US").trim().toUpperCase();
  const domain = AMAZON_DOMAINS[code] ?? AMAZON_DOMAINS.US;
  return `https://${domain}/dp/${normalizedAsin}`;
}

export function marketplaceCode(marketplace: string | null | undefined): string {
  const code = (marketplace || "US").trim().toUpperCase();
  return code || "US";
}

export type AmazonSalesSignalLike = {
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: string | null;
  rawText: string | null;
};

/**
 * Amazon 搜索页「过去一个月购买量」提示的展示文本。
 * 与 SellerSprite 月销估算严格分开：这里只复述搜索页原始提示，不做换算。
 */
export function formatAmazonSalesSignal(signal: AmazonSalesSignalLike): string {
  if (signal.rawText?.trim()) return signal.rawText.trim();
  if (signal.lowerBound !== null && signal.upperBound !== null) {
    return `${signal.lowerBound.toLocaleString("en-US")}–${signal.upperBound.toLocaleString("en-US")}`;
  }
  if (signal.lowerBound !== null && signal.qualifier === "at_least") {
    return `≥${signal.lowerBound.toLocaleString("en-US")}`;
  }
  if (signal.value !== null) return `约 ${signal.value.toLocaleString("en-US")}（页面解析值）`;
  if (signal.lowerBound !== null) return `≥${signal.lowerBound.toLocaleString("en-US")}`;
  return "暂无数据";
}

/**
 * T02 同屏检阅的上下件导航（纯函数，按当前筛选后的可见顺序）。
 * 当前商品不在可见集合时 visible=false，prev/next 均为 null；
 * 调用方必须显示「已被筛选隐藏」提示，不能静默跳到另一件商品。
 */
export type ReviewNavigation = {
  index: number;
  total: number;
  visible: boolean;
  canPrev: boolean;
  canNext: boolean;
  prevId: string | null;
  nextId: string | null;
};

export function resolveReviewNavigation(
  items: ReadonlyArray<{ id: string }>,
  currentId: string | null | undefined,
): ReviewNavigation {
  const total = items.length;
  const index = currentId ? items.findIndex((item) => item.id === currentId) : -1;
  const visible = index >= 0;
  return {
    index,
    total,
    visible,
    canPrev: visible && index > 0,
    canNext: visible && index < total - 1,
    prevId: visible && index > 0 ? items[index - 1].id : null,
    nextId: visible && index < total - 1 ? items[index + 1].id : null,
  };
}
