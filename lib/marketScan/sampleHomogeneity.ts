/**
 * MarketScan 样本同质性（子类型）确定性识别。
 *
 * 目的：让用户看清「这一批商品到底是不是同一个直接竞争市场」。
 *
 * 硬约束：
 * - **只使用商品标题做确定性关键词匹配**，不使用 AI 推断、不猜测标题未出现的属性；
 * - 未命中任何规则的商品标为 `unknown`（待人工确认），**不得强行归类**；
 * - 本模块**不参与任何统计计算**（价格中位数、集中度、Market Gate 判定等），
 *   只产出「分组视图 + 混杂风险提示」；
 * - 分组结果用于**列表筛选展示**，筛选不改变 MarketScan 的锁定样本与统计口径。
 */

export const SAMPLE_SUBTYPE_IDS = [
  "drawer_organizer",
  "shoe_box",
  "makeup_bathroom",
  "bead_craft",
  "moving_bag",
  "door_hanging",
  "pantry_kitchen",
  "fabric_soft",
  "hard_plastic_bin",
  "unknown",
] as const;

export type SampleSubtypeId = (typeof SAMPLE_SUBTYPE_IDS)[number];

type SubtypeRule = {
  readonly id: Exclude<SampleSubtypeId, "unknown">;
  readonly label: string;
  readonly labelEn: string;
  /** 顺序即优先级：越具体的用途越靠前，避免被宽泛的 "storage bins" 抢占。 */
  readonly patterns: readonly RegExp[];
};

/**
 * 规则顺序 = 匹配优先级。
 * 具体用途（抽屉分隔 / 鞋盒 / 化妆 / 珠串 / 搬家 / 门后）先于材质与通用形态（布艺 / 硬塑料）。
 */
const SUBTYPE_RULES: readonly SubtypeRule[] = [
  {
    id: "drawer_organizer",
    label: "抽屉分隔 / 整理格",
    labelEn: "Drawer Organizer",
    patterns: [
      /\bdrawer\s+organi[sz]ers?\b/iu,
      /\bdrawer\s+divider?s?\b/iu,
      /\bdrawer\s+storage\s+trays?\b/iu,
      /\bdresser\s+organi[sz]er\b/iu,
      /\bsock\s+(?:drawer\s+)?organi[sz]er\b/iu,
      /\bunderwear\s+organi[sz]er\b/iu,
      /\bstackable\s+storage\s+drawers?\b/iu,
    ],
  },
  {
    id: "shoe_box",
    label: "鞋盒 / 鞋类收纳",
    labelEn: "Shoe Storage",
    patterns: [/\bshoe\s+organi[sz]er\b/iu, /\bshoe\s+storage\b/iu, /\bshoe\s+box\b/iu, /\bshoe\s+boxes\b/iu],
  },
  {
    id: "makeup_bathroom",
    label: "化妆 / 浴室收纳",
    labelEn: "Makeup & Bathroom",
    patterns: [
      /\bmakeup\s+organi[sz]er\b/iu,
      /\bcosmetic\s+organi[sz]er\b/iu,
      /\bbathroom\s+(?:storage|organi[sz]er)\b/iu,
      /\bacrylic\s+organi[sz]er\b/iu,
      /\bvanity\s+organi[sz]er\b/iu,
    ],
  },
  {
    id: "bead_craft",
    label: "手工 / 珠串收纳",
    labelEn: "Craft & Bead",
    patterns: [/\bbeads?\s+organi[sz]ers?\b/iu, /\bbeads?\s+storage\b/iu, /\bcraft\s+organi[sz]er\b/iu, /\bcraft\s+storage\b/iu],
  },
  {
    id: "moving_bag",
    label: "搬家 / 大容量转运袋",
    labelEn: "Moving Bag",
    patterns: [/\bmoving\s+bags?\b/iu, /\bmoving\s+boxes?\b/iu, /\bstorage\s+bags?\s+with\s+backpack\b/iu],
  },
  {
    id: "door_hanging",
    label: "门后 / 悬挂收纳",
    labelEn: "Door & Hanging",
    patterns: [/\bover[\s-]+the[\s-]+door\b/iu, /\bover[\s-]+door\b/iu, /\bdoor\s+organi[sz]er\b/iu, /\bhanging\s+organi[sz]er\b/iu],
  },
  {
    id: "pantry_kitchen",
    label: "厨房 / 食品储藏收纳",
    labelEn: "Pantry & Kitchen",
    patterns: [/\bpantry\b/iu, /\bkitchen\s+organi[sz]ers?\b/iu, /\bfood\s+storage\b/iu],
  },
  {
    id: "fabric_soft",
    label: "布艺软体收纳（袋 / 箱 / 篮）",
    labelEn: "Fabric & Soft",
    patterns: [
      /\bfabric\b/iu,
      /\bclothes\s+storage\b/iu,
      /\bblanket\s+storage\b/iu,
      /\bcomforter\b/iu,
      /\blinen\b/iu,
      /\bcloset\s+organi[sz]ers?\b/iu,
      /\bcollapsible\s+storage\s+cubes?\b/iu,
      /\bstorage\s+bags?\b/iu,
      /\bstorage\s+baskets?\b/iu,
      /\bwoven\b/iu,
      /\brope\s+basket\b/iu,
      /\bcotton\s+rope\b/iu,
    ],
  },
  {
    id: "hard_plastic_bin",
    label: "硬质塑料收纳箱 / 盒",
    labelEn: "Hard Plastic Bin",
    patterns: [
      /\bstorage\s+bins?\b/iu,
      /\bstorage\s+boxes?\b/iu,
      /\bstorage\s+cubes?\b/iu,
      /\blatch(?:ing)?\s+(?:lid|box)\b/iu,
      /\blatch\s+bins?\b/iu,
      /\bclip\s+box\b/iu,
      /\bstackable\s+storage\b/iu,
      /\bplastic\s+storage\b/iu,
      /\bquart\b/iu,
      /\bqt\b/iu,
    ],
  },
];

const SUBTYPE_LABELS: Record<SampleSubtypeId, { label: string; labelEn: string }> = {
  drawer_organizer: { label: "抽屉分隔 / 整理格", labelEn: "Drawer Organizer" },
  shoe_box: { label: "鞋盒 / 鞋类收纳", labelEn: "Shoe Storage" },
  makeup_bathroom: { label: "化妆 / 浴室收纳", labelEn: "Makeup & Bathroom" },
  bead_craft: { label: "手工 / 珠串收纳", labelEn: "Craft & Bead" },
  moving_bag: { label: "搬家 / 大容量转运袋", labelEn: "Moving Bag" },
  door_hanging: { label: "门后 / 悬挂收纳", labelEn: "Door & Hanging" },
  pantry_kitchen: { label: "厨房 / 食品储藏收纳", labelEn: "Pantry & Kitchen" },
  fabric_soft: { label: "布艺软体收纳（袋 / 箱 / 篮）", labelEn: "Fabric & Soft" },
  hard_plastic_bin: { label: "硬质塑料收纳箱 / 盒", labelEn: "Hard Plastic Bin" },
  unknown: { label: "待人工确认（标题未命中任何类型）", labelEn: "Unclassified" },
};

export type SampleSubtypeAssignment = {
  readonly asin: string;
  readonly title: string | null;
  readonly subtype: SampleSubtypeId;
  readonly subtypeLabel: string;
  /** 命中的标题片段，用于人工复核；为空表示未命中任何规则。 */
  readonly matchedSignals: readonly string[];
  /** 同时命中、但因优先级未被采用的其它类型。 */
  readonly competingSubtypes: readonly SampleSubtypeId[];
};

export type SampleSubtypeGroup = {
  readonly id: SampleSubtypeId;
  readonly label: string;
  readonly labelEn: string;
  readonly count: number;
  readonly share: number;
  readonly asins: readonly string[];
};

export type SampleHomogeneityReport = {
  readonly total: number;
  readonly assignments: readonly SampleSubtypeAssignment[];
  readonly groups: readonly SampleSubtypeGroup[];
  readonly unknownCount: number;
  /** 最大单一类型的占比（0–1）；总数为 0 时为 0。 */
  readonly dominantShare: number;
  readonly mixedRisk: "high" | "medium" | "low" | "insufficient";
  readonly headline: string;
  readonly caveats: readonly string[];
};

function collectSignals(title: string, rule: SubtypeRule): string[] {
  const signals: string[] = [];
  for (const pattern of rule.patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    for (const match of title.matchAll(global)) {
      const text = match[0]?.trim();
      if (text && !signals.includes(text)) signals.push(text);
    }
  }
  return signals;
}

/** 对单个标题做确定性分类；不命中任何规则时返回 `unknown`。 */
export function classifySampleTitle(title: string | null | undefined): {
  subtype: SampleSubtypeId;
  matchedSignals: string[];
  competingSubtypes: SampleSubtypeId[];
} {
  const text = (title ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return { subtype: "unknown", matchedSignals: [], competingSubtypes: [] };

  const hits: Array<{ id: Exclude<SampleSubtypeId, "unknown">; signals: string[] }> = [];
  for (const rule of SUBTYPE_RULES) {
    const signals = collectSignals(text, rule);
    if (signals.length > 0) hits.push({ id: rule.id, signals });
  }
  if (hits.length === 0) return { subtype: "unknown", matchedSignals: [], competingSubtypes: [] };

  const [primary, ...rest] = hits;
  return {
    subtype: primary!.id,
    matchedSignals: primary!.signals,
    competingSubtypes: rest.map((hit) => hit.id),
  };
}

function riskOf(dominantShare: number, total: number, groupCount: number): SampleHomogeneityReport["mixedRisk"] {
  if (total < 5) return "insufficient";
  if (dominantShare < 0.5 || groupCount >= 5) return "high";
  if (dominantShare < 0.75) return "medium";
  return "low";
}

/**
 * 生成样本同质性报告。
 *
 * 注意：`mixedRisk` 只是**提示**，不参与 Market Gate、不改变样本数量、不影响任何指标。
 */
export function analyzeSampleHomogeneity(
  items: ReadonlyArray<{ asin: string; title?: string | null }>,
): SampleHomogeneityReport {
  const assignments: SampleSubtypeAssignment[] = items.map((item) => {
    const result = classifySampleTitle(item.title ?? null);
    return {
      asin: String(item.asin ?? "").toUpperCase(),
      title: item.title ?? null,
      subtype: result.subtype,
      subtypeLabel: SUBTYPE_LABELS[result.subtype].label,
      matchedSignals: result.matchedSignals,
      competingSubtypes: result.competingSubtypes,
    };
  });

  const total = assignments.length;
  const grouped = new Map<SampleSubtypeId, string[]>();
  for (const assignment of assignments) {
    const list = grouped.get(assignment.subtype) ?? [];
    list.push(assignment.asin);
    grouped.set(assignment.subtype, list);
  }

  const groups: SampleSubtypeGroup[] = [...grouped.entries()]
    .map(([id, asins]) => ({
      id,
      label: SUBTYPE_LABELS[id].label,
      labelEn: SUBTYPE_LABELS[id].labelEn,
      count: asins.length,
      share: total === 0 ? 0 : asins.length / total,
      asins,
    }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));

  const nonUnknown = groups.filter((group) => group.id !== "unknown");
  const unknownCount = grouped.get("unknown")?.length ?? 0;
  const dominantShare = groups[0]?.share ?? 0;
  const mixedRisk = riskOf(dominantShare, total, nonUnknown.length);

  const dominant = groups[0];
  const headline = total === 0
    ? "当前没有锁定样本。"
    : dominant && dominant.id !== "unknown"
      ? `共 ${total} 款样本，识别出 ${nonUnknown.length} 类商品；最大同类「${dominant.label}」占 ${Math.round(dominant.share * 100)}%（${dominant.count} 款）${unknownCount > 0 ? `，另有 ${unknownCount} 款待人工确认` : ""}。`
      : `共 ${total} 款样本，标题均未命中已知类型，全部待人工确认。`;

  const caveats: string[] = [
    "分类只依据商品标题中的确定性关键词，不使用 AI 推断；标题未体现的用途不会被猜测。",
    "分类与风险提示只用于展示与筛选，不参与价格中位数、集中度等统计计算，也不改变 Market Gate 判定。",
  ];
  if (mixedRisk === "high") {
    caveats.push("样本混合了多个细分市场：整体价格中位数与竞争强度不能直接当作某一具体产品的确定结论。");
  } else if (mixedRisk === "medium") {
    caveats.push("样本存在一定混合：使用整体指标时请确认它是否仍能代表你要研究的具体产品。");
  }
  if (unknownCount > 0) {
    caveats.push(`${unknownCount} 款商品的标题未命中任何类型，已标为「待人工确认」，未强行归类。`);
  }

  return {
    total,
    assignments,
    groups,
    unknownCount,
    dominantShare,
    mixedRisk,
    headline,
    caveats,
  };
}

/** 供 UI 使用：按类型筛选样本（仅视图过滤，不改变统计口径）。 */
export function filterSamplesBySubtype<T extends { asin: string }>(
  items: readonly T[],
  assignments: readonly SampleSubtypeAssignment[],
  subtype: SampleSubtypeId | "all",
): T[] {
  if (subtype === "all") return [...items];
  const allowed = new Set(
    assignments.filter((assignment) => assignment.subtype === subtype).map((assignment) => assignment.asin),
  );
  return items.filter((item) => allowed.has(String(item.asin ?? "").toUpperCase()));
}
