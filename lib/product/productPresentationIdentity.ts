import { AMAZON_US_TOP_LEVEL_CATEGORIES } from "@/lib/productBatchPresentation";

/**
 * 商品展示身份（PRESENTATION-ONLY localized display title）。
 *
 * 严格边界：
 * - 本模块只产出**展示层**文案，用于商品卡主标题；
 * - 绝不写入 ProductFact / EvidenceStore，绝不作为 Amazon 已确认事实；
 * - 不调用任何在线翻译服务，不新增依赖；
 * - 只有在有可靠来源（已含中文的权威标题 / 权威中文类目 / 已收录类目表）时才
 *   声明可用；否则返回 null，由调用方如实降级，不得伪造中文。
 */

export type ProductPresentationIdentityStatus =
  | "AUTHORITATIVE_CHINESE_TITLE"
  | "DERIVED_FROM_CATEGORY"
  | "UNAVAILABLE";

export type ProductPresentationIdentity = {
  /** 中文展示主标题；不可靠时为 null。 */
  readonly chineseTitle: string | null;
  /** 英文原始标题（作为灰色副标题保留）。 */
  readonly englishTitle: string | null;
  /** 中文来源强度，供验收区分「真实中文身份」与「无中文来源」。 */
  readonly status: ProductPresentationIdentityStatus;
  /** 展示用中文类目（若有权威类目）。 */
  readonly chineseCategory: string | null;
  /** 是否只是展示层推导（永不为 false 的权威声明）。 */
  readonly presentationOnly: true;
};

const CATEGORY_LABEL_BY_ENGLISH = new Map<string, string>(
  AMAZON_US_TOP_LEVEL_CATEGORIES.map((entry) => [entry.value.toLowerCase(), entry.label]),
);

/**
 * 叶子/子类目别名 → 中文展示名。
 * 采集数据里的 category 常见为叶子类目（如 "Kitchen"），
 * 这里只做「展示名映射」，不改变任何权威类目字段。
 */
const LEAF_CATEGORY_LABELS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /^kitchen(\s*&\s*dining)?$/iu, label: "厨房与餐厨" },
  { pattern: /^home(\s*&\s*kitchen)?$/iu, label: "家居与厨房" },
  { pattern: /^home\s*&\s*decor$/iu, label: "家居装饰" },
  { pattern: /^garden\s*&\s*outdoor$/iu, label: "花园与户外" },
  { pattern: /^tools\s*&\s*home\s*improvement$/iu, label: "工具与家装" },
  { pattern: /^sports\s*&\s*outdoors$/iu, label: "运动与户外" },
  { pattern: /^toys\s*&\s*games$/iu, label: "玩具与游戏" },
  { pattern: /^office\s*products$/iu, label: "办公用品" },
  { pattern: /^pet\s*supplies$/iu, label: "宠物用品" },
  { pattern: /^electronics$/iu, label: "电子产品" },
  { pattern: /^health\s*&\s*household$/iu, label: "健康与家居日用" },
];

function resolveChineseCategoryLabel(raw: string): string | null {
  const direct = CATEGORY_LABEL_BY_ENGLISH.get(raw.toLowerCase());
  if (direct) return direct;
  for (const entry of LEAF_CATEGORY_LABELS) {
    if (entry.pattern.test(raw)) return entry.label;
  }
  return null;
}

/**
 * 常见商品类型词表：仅供展示层把英文品类词映射为中文名。
 * 未命中的词保持英文，宁可部分中文也不臆造品类。
 */
const PRODUCT_TYPE_TERMS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /\bcutting\s+boards?\b/iu, label: "砧板" },
  { pattern: /\bchopping\s+boards?\b/iu, label: "剁肉砧板" },
  { pattern: /\bserving\s+boards?\b/iu, label: "摆盘木板" },
  { pattern: /\bcheese\s+boards?\b/iu, label: "奶酪板" },
  { pattern: /\bstring\s+lights?\b/iu, label: "灯串" },
  { pattern: /\bfairy\s+lights?\b/iu, label: "装饰灯串" },
  { pattern: /\bchristmas\s+trees?\b/iu, label: "圣诞树" },
  { pattern: /\bwreaths?\b/iu, label: "花环" },
  { pattern: /\bwater\s+bottles?\b/iu, label: "水瓶" },
  { pattern: /\btumblers?\b/iu, label: "保温杯" },
  { pattern: /\bmugs?\b/iu, label: "马克杯" },
  { pattern: /\bstorage\s+bins?\b/iu, label: "收纳箱" },
  { pattern: /\bstorage\s+baskets?\b/iu, label: "收纳篮" },
  { pattern: /\borgani[sz]ers?\b/iu, label: "收纳架" },
  { pattern: /\bshel(?:f|ves)\b/iu, label: "置物架" },
  { pattern: /\bknife\s+sets?\b/iu, label: "刀具套装" },
  { pattern: /\bkitchen\s+knives?\b/iu, label: "厨刀" },
  { pattern: /\butensil\s+sets?\b/iu, label: "厨具套装" },
  { pattern: /\bdish\s+racks?\b/iu, label: "沥水架" },
  { pattern: /\bdrain(?:er|ing)?\s+racks?\b/iu, label: "沥水架" },
  { pattern: /\bmats?\b/iu, label: "垫" },
  { pattern: /\btrivets?\b/iu, label: "隔热垫" },
  { pattern: /\bpillows?\b/iu, label: "枕头" },
  { pattern: /\bblankets?\b/iu, label: "毯子" },
  { pattern: /\bcurtains?\b/iu, label: "窗帘" },
  { pattern: /\blamps?\b/iu, label: "灯具" },
  { pattern: /\bchairs?\b/iu, label: "椅子" },
  { pattern: /\btables?\b/iu, label: "桌子" },
  { pattern: /\bshoes?\b/iu, label: "鞋" },
  { pattern: /\bsocks?\b/iu, label: "袜子" },
  { pattern: /\bt-?shirts?\b/iu, label: "T 恤" },
  { pattern: /\bbackpacks?\b/iu, label: "背包" },
  { pattern: /\bheadphones?\b/iu, label: "耳机" },
  { pattern: /\bchargers?\b/iu, label: "充电器" },
  { pattern: /\bcables?\b/iu, label: "数据线" },
  { pattern: /\btoys?\b/iu, label: "玩具" },
  { pattern: /\bpuzzles?\b/iu, label: "拼图" },
  { pattern: /\bfood\s+storage\s+containers?\b/iu, label: "食品保鲜盒" },
  { pattern: /\bcontainers?\b/iu, label: "容器" },
  { pattern: /\bwrap(?:ping)?\s+paper\b/iu, label: "包装纸" },
];

/**
 * 材质词表：与「品类词」分开维护，因为材质词常常已经存在于品牌名里
 * （例如品牌 "Royal Bamboo"），此时不应再翻译一次造成 "Royal Bamboo 竹制" 这类噪音。
 */
const PRODUCT_MATERIAL_TERMS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /\borganic\b/iu, label: "有机" },
  { pattern: /\bbamboo\b/iu, label: "竹制" },
  { pattern: /\bacacia\b/iu, label: "相思木" },
  { pattern: /\bwalnut\b/iu, label: "胡桃木" },
  { pattern: /\bstainless\s+steel\b/iu, label: "不锈钢" },
  { pattern: /\bsilicone\b/iu, label: "硅胶" },
  { pattern: /\bceramic\b/iu, label: "陶瓷" },
];


/** 从英文原标题中提取「中文材质短语 + 中文品类」，不臆造、不翻译无法识别的词。 */
function deriveChineseDescriptors(englishTitle: string, brand: string | null): string[] {
  const descriptors: string[] = [];
  const brandLower = brand?.toLowerCase() ?? "";
  // 先材质（定语），再品类（中心词），符合中文语序：有机竹制砧板。
  for (const term of PRODUCT_MATERIAL_TERMS) {
    // 品牌名里已经包含的材质词不再重复翻译（避免 "Royal Bamboo 竹制" 这类噪音）。
    if (brandLower && term.pattern.test(brandLower)) continue;
    if (term.pattern.test(englishTitle) && !descriptors.includes(term.label)) {
      descriptors.push(term.label);
    }
  }
  for (const term of PRODUCT_TYPE_TERMS) {
    if (term.pattern.test(englishTitle) && !descriptors.includes(term.label)) {
      descriptors.push(term.label);
    }
  }
  return descriptors;
}

/** 提取型号 / 关键规格（Model N、数字规格），保留英文以免误译。 */
function extractModelToken(englishTitle: string): string | null {
  const model = /\bmodel\s*([A-Za-z0-9][A-Za-z0-9-]{0,15})\b/iu.exec(englishTitle);
  if (model) return `Model ${model[1]!.toUpperCase()}`;
  return null;
}

/**
 * 提取关键规格（尺寸 / 容量 / 数量 / 长度），保留原始英文写法以避免误译，
 * 例如 "6ft"、"7.5ft"、"24 oz"、"300 Lights"、"4 Pack"。
 * 只取**首个**规格，保持标题简短可读。
 */
function extractKeySpec(englishTitle: string): string | null {
  const patterns: readonly RegExp[] = [
    /\b\d+(?:\.\d+)?\s?(?:ft|feet|foot|in|inch|inches|cm|mm|m)\b/iu,
    /\b\d+(?:\.\d+)?\s?(?:oz|fl\s?oz|ml|l|liter|litre|gal|gallon|qt|quart)\b/iu,
    /\b\d+(?:\.\d+)?\s?(?:pack|pcs|pieces|count|ct|set)\b/iu,
    /\b\d{2,4}\s?(?:lights?|leds?|tips?|branches?)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(englishTitle);
    if (match) return match[0].replace(/\s+/gu, " ").trim();
  }
  return null;
}

function resolveChineseCategory(category: string | null | undefined): string | null {
  const raw = typeof category === "string" ? category.trim() : "";
  if (!raw) return null;
  if (/[\u4e00-\u9fa5]/u.test(raw)) return raw;
  return resolveChineseCategoryLabel(raw);
}

/**
 * 解析商品展示身份。
 *
 * 优先级：
 * 1. 权威标题本身已含中文 → 直接作为中文主标题（AUTHORITATIVE_CHINESE_TITLE）；
 * 2. 有权威中文类目（或已收录类目表可映射）+ 英文标题可提取品类短语 →
 *    组合为「品牌 + 中文品类 + 型号」（DERIVED_FROM_CATEGORY，展示层推导）；
 * 3. 否则 UNAVAILABLE，调用方必须如实降级（显示原文 + 标注暂无中文名）。
 */
export function resolveProductPresentationIdentity(input: {
  readonly title?: string | null;
  readonly brand?: string | null;
  readonly category?: string | null;
  readonly asin?: string | null;
}): ProductPresentationIdentity {
  const englishTitle = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
  const brand = typeof input.brand === "string" && input.brand.trim() ? input.brand.trim() : null;
  const chineseCategory = resolveChineseCategory(input.category);

  const base = {
    englishTitle,
    chineseCategory,
    presentationOnly: true as const,
  };

  if (englishTitle && /[\u4e00-\u9fa5]/u.test(englishTitle)) {
    return { ...base, chineseTitle: englishTitle, status: "AUTHORITATIVE_CHINESE_TITLE" };
  }

  if (!chineseCategory) {
    return { ...base, chineseTitle: null, status: "UNAVAILABLE" };
  }

  const descriptors = englishTitle ? deriveChineseDescriptors(englishTitle, brand) : [];
  const model = englishTitle ? extractModelToken(englishTitle) : null;
  const spec = englishTitle ? extractKeySpec(englishTitle) : null;
  // 关键规格：型号优先，其次尺寸/数量等；两者都有时都保留。
  const specSegment = [model, spec && spec !== model ? spec : null]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const core = descriptors.length > 0 ? descriptors.join("") : chineseCategory;
  const segments = [brand, core, specSegment || null]
    .filter((value): value is string => Boolean(value && value.trim()));

  // 更保守的兜底：没有可识别的品类短语时，直接用「品牌 + 权威中文类目」，
  // 而不是把类目当成商品名的替代品（例如不要输出裸「圣诞树」）。
  const chineseTitle = descriptors.length > 0
    ? (segments.length > 0 ? segments.join(" ") : null)
    : (brand ? `${brand} ${chineseCategory}` : chineseCategory);

  if (!chineseTitle) return { ...base, chineseTitle: null, status: "UNAVAILABLE" };
  return { ...base, chineseTitle, status: "DERIVED_FROM_CATEGORY" };
}
