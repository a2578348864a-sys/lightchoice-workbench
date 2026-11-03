/**
 * SellerSprite 商品历史序列（真实页面合同）
 *
 * 真实页面（2026-10-24 在专用 9222 浏览器实测）：
 *   查竞品 → 结果行 `icon-historical-trend` → 底部抽屉 `.el-drawer.btt`
 *   标签：销量趋势 / 子体销量趋势 / 历史趋势 / 留评率 / 核心关键词趋势
 *   - 「销量趋势」：月份为表头、指标为行（月销量 / 月销售额 / 平均单价）的结构化表格。
 *   - 「历史趋势」：canvas 图表，鼠标悬停后出现 `.chart` 文本浮层，首行
 *     `YYYY-MM-DD HH:mm`，其后每行「指标 值」（Buybox价格/价格/评分/评分数/卖家数/BSR…）。
 *
 * 本模块只做纯解析与校验：不访问网络、不读写存储、不猜测缺值。
 * - 月份必须 `YYYY-MM`、严格递增、唯一，跨度不超过 Provider 支持的 3 年窗口。
 * - 数值只接受严格数字串；`N/A`/`--`/`****`/空 一律 null，绝不写 0。
 * - 月表指标与悬停指标使用不同字段名（月平均单价 ≠ 当日价格），不得互相覆盖。
 * - 同一日期出现多个悬停读数时，只保留**最早时间戳**（确定性规则）并计数，不做平均。
 */

export const SELLERSPRITE_HISTORY_MONTH_METRICS = ["monthlySales", "monthlyRevenue", "avgPrice"] as const;
export const SELLERSPRITE_HISTORY_EVENT_METRICS = ["price", "buyboxPrice", "rating", "reviewCount", "sellerCount", "bsr", "categoryBsr", "monthlySales", "reviewGrowth", "reviewRate"] as const;

export type SellerSpriteHistoryMonthMetric = (typeof SELLERSPRITE_HISTORY_MONTH_METRICS)[number];
export type SellerSpriteHistoryEventMetric = (typeof SELLERSPRITE_HISTORY_EVENT_METRICS)[number];
export type SellerSpriteHistoryMetric = SellerSpriteHistoryMonthMetric | SellerSpriteHistoryEventMetric;

export type SellerSpriteHistoryPoint = { date: string } & Partial<Record<SellerSpriteHistoryMetric, number>>;

export type SellerSpriteHistoryChartSurface = { x: number; y: number; width: number; height: number };

export type SellerSpriteHistoryMonthTable = {
  months: readonly string[];
  rows: readonly { label: string; values: readonly string[] }[];
};

/** 页面里「月份表头 + 数值表体」的原始分组；指标名可能落在独立的标签表。 */
export type SellerSpriteHistoryRawGroup = {
  months: readonly string[];
  rows: readonly { label: string; values: readonly string[] }[];
};

export type SellerSpriteHistoryDrawerRaw = {
  asin: string | null;
  title: string | null;
  headerText: string;
  activeTab: string | null;
  rangeLabel: string | null;
  monthTableGroups: readonly SellerSpriteHistoryRawGroup[];
  labelRows: readonly (readonly string[])[];
  /** 浏览器侧正常交互（鼠标悬停）读到的可见浮层文本。 */
  tooltipTexts: readonly string[];
  chartSurface?: SellerSpriteHistoryChartSurface;
};

export type SellerSpriteHistoryParseIssue = {
  code:
    | "MONTHS_INVALID"
    | "MONTHS_NOT_INCREASING"
    | "MONTHS_DUPLICATED"
    | "MONTHS_SPAN_EXCEEDED"
    | "MONTHS_TOO_FEW"
    | "ROW_LENGTH_MISMATCH"
    | "ROW_LABEL_UNKNOWN"
    | "VALUE_NOT_NUMERIC"
    | "TOOLTIP_DATE_INVALID"
    | "TOOLTIP_METRIC_EMPTY"
    | "POINT_CONFLICT";
  detail: string;
};

export type SellerSpriteHistoryRange = { from: string; to: string; count: number };

export type SellerSpriteHistorySeriesResult = {
  series: SellerSpriteHistoryPoint[];
  points: number;
  monthlyPoints: number;
  eventPoints: number;
  sameDateVariants: number;
  /** 同月既有月份表又有留评率悬停读数时，以月份表为准的次数。 */
  tablePreferredSales: number;
  metrics: SellerSpriteHistoryMetric[];
  monthlyRange: SellerSpriteHistoryRange | null;
  eventRange: SellerSpriteHistoryRange | null;
  issues: SellerSpriteHistoryParseIssue[];
  accepted: boolean;
  rejection: string | null;
};

/** Provider 明确支持最近 3 年历史；超过即视为解析错位，而不是更长序列。 */
export const SELLERSPRITE_HISTORY_MAX_MONTH_SPAN = 37;
export const SELLERSPRITE_HISTORY_MIN_MONTHS = 3;
const MAX_EVENT_POINTS = 240;
const MAX_ISSUES = 40;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const DATETIME_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u;
const NUMBER_PATTERN = /^(?:-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.\d+)?$/u;
const EMPTY_VALUE_PATTERN = /^(?:n\/a|na|--|-|—|\*\*\*\*)$/iu;

const MONTH_ROW_ALIASES: Record<SellerSpriteHistoryMonthMetric, readonly string[]> = {
  monthlySales: ["月销量", "monthlysales", "月销量估算"],
  monthlyRevenue: ["月销售额", "monthlyrevenue", "月销售额估算"],
  avgPrice: ["平均单价", "avgprice", "平均价格", "均价"],
};

const EVENT_LABEL_ALIASES: readonly { metric: SellerSpriteHistoryEventMetric; pattern: RegExp }[] = [
  { metric: "buyboxPrice", pattern: /^buybox\s*价格(?:\s|$)/iu },
  { metric: "price", pattern: /^(?:价格|售价)(?:\s|$)/u },
  { metric: "rating", pattern: /^(?:评分|星级)(?:\s|$)/u },
  { metric: "reviewCount", pattern: /^(?:评分数|评论数|评价数)(?:\s|$)/u },
  { metric: "reviewGrowth", pattern: /^(?:当月)?评分数增长值(?:\s|$)/u },
  { metric: "reviewRate", pattern: /^(?:当月)?留评率(?:\s|$)/u },
  { metric: "monthlySales", pattern: /^(?:当月)?月?销量(?:\s|$)/u },
  { metric: "sellerCount", pattern: /^卖家数(?:\s|$)/u },
  { metric: "categoryBsr", pattern: /^大类\s*bsr/iu },
  { metric: "bsr", pattern: /^小类\s*bsr|^bsr/iu },
];

/** 历史指标的中文标签与单位（只用于展示，不参与数值判定）。 */
export const SELLERSPRITE_HISTORY_METRIC_LABELS: Record<SellerSpriteHistoryMetric, { label: string; unit: string }> = {
  monthlySales: { label: "月销量估算", unit: "件/月" },
  monthlyRevenue: { label: "月销售额估算", unit: "USD/月" },
  avgPrice: { label: "月平均单价", unit: "USD" },
  price: { label: "当时价格", unit: "USD" },
  buyboxPrice: { label: "Buybox 价格", unit: "USD" },
  rating: { label: "评分", unit: "星" },
  reviewCount: { label: "评分数", unit: "条" },
  sellerCount: { label: "卖家数", unit: "个" },
  bsr: { label: "小类 BSR", unit: "名" },
  categoryBsr: { label: "大类 BSR", unit: "名" },
  reviewGrowth: { label: "当月评分数增长", unit: "条/月" },
  reviewRate: { label: "当月留评率", unit: "percent" },
};

function issue(code: SellerSpriteHistoryParseIssue["code"], detail: string): SellerSpriteHistoryParseIssue {
  return { code, detail: detail.slice(0, 160) };
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/** 严格数字解析：只接受数字串（可带千分位）；其它（含区间、带后缀）一律 null。 */
export function parseSellerSpriteHistoryNumber(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.normalize("NFKC").trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(/,/gu, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 表格单元格可能带货币前缀（真实页面的月销售额/平均单价列）；只剥离货币符号，不做四舍五入。 */
export function parseSellerSpriteHistoryMoneyCell(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  return parseSellerSpriteHistoryNumber(raw.normalize("NFKC").trim().replace(/^(?:US\$|\$)\s*/iu, ""));
}

function monthIndex(value: string): number {
  const [year, month] = value.split("-").map((part) => Number(part));
  return year * 12 + (month - 1);
}

function monthMetricOf(label: string): SellerSpriteHistoryMonthMetric | null {
  const normalized = normalizeLabel(label);
  for (const metric of SELLERSPRITE_HISTORY_MONTH_METRICS) {
    if (MONTH_ROW_ALIASES[metric].some((alias) => normalizeLabel(alias) === normalized)) return metric;
  }
  return null;
}

/** 校验月份表头：格式、唯一、递增、跨度。 */
export function validateSellerSpriteHistoryMonths(months: readonly string[]): { months: string[]; issues: SellerSpriteHistoryParseIssue[] } {
  const issues: SellerSpriteHistoryParseIssue[] = [];
  const provided = months.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
  const clean = provided.filter((value) => MONTH_PATTERN.test(value));
  if (clean.length !== provided.length) issues.push(issue("MONTHS_INVALID", "月份表头含非 YYYY-MM 内容"));
  const unique = [...new Set(clean)];
  if (unique.length !== clean.length) issues.push(issue("MONTHS_DUPLICATED", "月份表头重复"));
  if (unique.length < SELLERSPRITE_HISTORY_MIN_MONTHS) {
    issues.push(issue("MONTHS_TOO_FEW", `有效月份少于 ${SELLERSPRITE_HISTORY_MIN_MONTHS} 个`));
    return { months: [], issues };
  }
  for (let index = 1; index < unique.length; index += 1) {
    if (monthIndex(unique[index]) <= monthIndex(unique[index - 1])) {
      issues.push(issue("MONTHS_NOT_INCREASING", `月份未严格递增：${unique[index - 1]} → ${unique[index]}`));
      return { months: [], issues };
    }
  }
  const span = monthIndex(unique[unique.length - 1]) - monthIndex(unique[0]) + 1;
  if (span > SELLERSPRITE_HISTORY_MAX_MONTH_SPAN) {
    issues.push(issue("MONTHS_SPAN_EXCEEDED", `月份跨度 ${span} 超过 Provider 支持的 3 年窗口`));
    return { months: [], issues };
  }
  return { months: unique, issues };
}

/**
 * 把「表头分组 + 独立标签表」拼成可解析的月份表。
 * 真实页面的列头表与数值表分离，指标名可能只出现在另一张只有首列的标签表里；
 * 只有整组行都没有标签时才按行号对齐拼接，绝不猜测错位。
 */
export function resolveSellerSpriteHistoryMonthTables(raw: Pick<SellerSpriteHistoryDrawerRaw, "monthTableGroups" | "labelRows">): { tables: SellerSpriteHistoryMonthTable[]; issues: SellerSpriteHistoryParseIssue[] } {
  const issues: SellerSpriteHistoryParseIssue[] = [];
  const tables: SellerSpriteHistoryMonthTable[] = [];
  const signatures = new Set<string>();
  for (const group of raw.monthTableGroups) {
    if (!Array.isArray(group.months) || group.months.length < 3) continue;
    const rows = group.rows.map((row) => ({ label: row.label ?? "", values: [...(row.values ?? [])] }));
    if (!rows.length) continue;
    if (rows.every((row) => !row.label.trim())) {
      // 真实页面的标签表一行只有一个指标名（其余列全空）。
      const cleaned = raw.labelRows
        .map((cells) => (cells[0] ?? "").trim())
        .filter((value) => value && !MONTH_PATTERN.test(value) && !/^(?:月份|时间)$/u.test(value));
      rows.forEach((row, index) => { row.label = cleaned[index] ?? ""; });
      if (rows.some((row) => !row.label.trim())) issues.push(issue("ROW_LABEL_UNKNOWN", "数值表缺少可对齐的指标名"));
    }
    const signature = `${group.months.join("|")}::${rows.map((row) => `${row.label}:${row.values.join(",")}`).join(";")}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    tables.push({ months: [...group.months], rows });
  }
  return { tables, issues };
}

/**
 * 解析「销量趋势」月份表。
 * 真实页面同屏存在多张表（表头表 / 数值表 / 标签表 / 另一标签页的副本），
 * 因此按「有数值的单元格数」选最佳候选，绝不把不同月份表串接。
 */
export function parseSellerSpriteHistoryMonthTables(tables: readonly SellerSpriteHistoryMonthTable[]): { points: SellerSpriteHistoryPoint[]; months: string[]; issues: SellerSpriteHistoryParseIssue[] } {
  let best: { months: string[]; points: SellerSpriteHistoryPoint[]; issues: SellerSpriteHistoryParseIssue[]; numericCells: number } | null = null;
  for (const table of tables) {
    const validated = validateSellerSpriteHistoryMonths(table.months);
    const issues = [...validated.issues];
    if (!validated.months.length) continue;
    const months = validated.months;
    const byMonth = new Map<string, SellerSpriteHistoryPoint>(months.map((month) => [month, { date: month }]));
    const metricsSeen = new Set<SellerSpriteHistoryMonthMetric>();
    let numericCells = 0;
    for (const row of table.rows) {
      const metric = monthMetricOf(row.label);
      if (!metric) {
        if (row.label.trim()) issues.push(issue("ROW_LABEL_UNKNOWN", `未识别的月份指标：${row.label}`));
        continue;
      }
      // 表头可能带一个尾随空列；按月份个数截取末尾对齐值。
      const aligned = row.values.length >= months.length ? row.values.slice(row.values.length - months.length) : row.values;
      if (aligned.length !== months.length) {
        issues.push(issue("ROW_LENGTH_MISMATCH", `${row.label} 的值个数 ${row.values.length} 与月份 ${months.length} 不一致`));
        continue;
      }
      metricsSeen.add(metric);
      aligned.forEach((raw, index) => {
        const value = parseSellerSpriteHistoryMoneyCell(raw);
        if (value === null) {
          if (typeof raw === "string" && raw.trim() && !EMPTY_VALUE_PATTERN.test(raw.trim())) {
            issues.push(issue("VALUE_NOT_NUMERIC", `${row.label} ${months[index]} 的值不是确定数字：${raw.slice(0, 20)}`));
          }
          return;
        }
        numericCells += 1;
        byMonth.get(months[index])![metric] = value;
      });
    }
    if (!metricsSeen.size || numericCells === 0) continue;
    const points = months.map((month) => byMonth.get(month)!).filter((point) => Object.keys(point).length > 1);
    if (!points.length) continue;
    const candidate = { months, points, issues, numericCells };
    if (!best || candidate.numericCells > best.numericCells) best = candidate;
  }
  return best
    ? { points: best.points, months: best.months, issues: best.issues }
    : { points: [], months: [], issues: [issue("MONTHS_INVALID", "没有可用的月份历史表")] };
}

/** 解析悬停浮层：首行时间 + 指标/值。
 * 真实页面有两种排版：
 *  1) 历史趋势（Keepa 风格）：`2026-07-30 06:32` 后每行「指标 值」；
 *  2) 留评率：`202207`（YYYYMM）后「指标」与「值」交替各占一行。
 */
export function parseSellerSpriteHistoryTooltip(text: string): { datetime: string; date: string; metrics: Partial<Record<SellerSpriteHistoryEventMetric, number>> } | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.normalize("NFKC").split(/\r?\n/u).map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const monthOnly = /^(\d{4})(0[1-9]|1[0-2])$/u.exec(first);
  let datetime: string;
  let date: string;
  if (monthOnly) {
    date = `${monthOnly[1]}-${monthOnly[2]}`;
    datetime = date;
  } else if (DATETIME_PATTERN.test(first)) {
    datetime = first.replace(" ", "T");
    date = first.slice(0, 10);
    if (!DATE_PATTERN.test(date)) return null;
  } else {
    return null;
  }
  const metrics: Partial<Record<SellerSpriteHistoryEventMetric, number>> = {};
  const body = lines.slice(1);
  const readValue = (raw: string): number | null => {
    const tail = raw.replace(/^[^\d$]*/u, "").replace(/^US\$/iu, "").replace(/^\$/u, "");
    if (/[+~]/u.test(tail)) return null;
    return /%$/u.test(tail.trim()) ? parseSellerSpriteHistoryNumber(tail.trim().replace(/%$/u, "")) : parseSellerSpriteHistoryNumber(tail);
  };
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    let matched = false;
    for (const alias of EVENT_LABEL_ALIASES) {
      if (!alias.pattern.test(line)) continue;
      matched = true;
      const inline = line.replace(alias.pattern, "").trim();
      const raw = inline || body[index + 1] || "";
      const consumedNext = !inline && Boolean(body[index + 1]);
      const value = readValue(raw);
      if (value !== null && metrics[alias.metric] === undefined) metrics[alias.metric] = value;
      if (consumedNext) index += 1;
      break;
    }
    if (matched) continue;
    // 单行「标签 值」未命中时，尝试下一行的纯数值与前一行标签无关，直接跳过。
  }
  return Object.keys(metrics).length ? { datetime, date, metrics } : null;
}

/**
 * 组装历史序列：月表点（`YYYY-MM`）与悬停点（`YYYY-MM-DD`）各自保留粒度，按日期升序合并。
 * 同一日期多次悬停读数：只保留最早时间戳（确定性），并记录 sameDateVariants。
 */
export function buildSellerSpriteHistorySeries(raw: SellerSpriteHistoryDrawerRaw): SellerSpriteHistorySeriesResult {
  const issues: SellerSpriteHistoryParseIssue[] = [];
  const resolved = resolveSellerSpriteHistoryMonthTables(raw);
  issues.push(...resolved.issues);
  const months = parseSellerSpriteHistoryMonthTables(resolved.tables);
  issues.push(...months.issues);
  const monthlyPoints: SellerSpriteHistoryPoint[] = [...months.points];

  const eventByDate = new Map<string, { point: SellerSpriteHistoryPoint; datetime: string }>();
  let sameDateVariants = 0;
  let parsedCount = 0;
  // 「销量趋势」月份表是月销量的权威来源；留评率图的悬停读数只在表格缺该月时补位，避免同月两个值静默覆盖。
  const monthTableSales = new Map<string, number>();
  for (const point of monthlyPoints) if (point.monthlySales !== undefined) monthTableSales.set(point.date, point.monthlySales);
  let tablePreferredSales = 0;
  for (const text of raw.tooltipTexts) {
    if (parsedCount >= MAX_EVENT_POINTS) break;
    const parsed = parseSellerSpriteHistoryTooltip(text);
    if (!parsed) {
      if (/\d{4}-?\d{2}/u.test(text)) issues.push(issue("TOOLTIP_METRIC_EMPTY", "悬停浮层有日期但没有可识别数值"));
      continue;
    }
    parsedCount += 1;
    const metrics: Partial<Record<SellerSpriteHistoryEventMetric, number>> = { ...parsed.metrics };
    if (metrics.monthlySales !== undefined && monthTableSales.has(parsed.date)) {
      delete metrics.monthlySales;
      tablePreferredSales += 1;
    }
    if (!Object.keys(metrics).length) continue;
    const existing = eventByDate.get(parsed.date);
    if (!existing) {
      eventByDate.set(parsed.date, { point: { date: parsed.date, ...metrics }, datetime: parsed.datetime });
      continue;
    }
    const sameReadings = Object.entries(metrics).every(([metric, value]) => (existing.point as Record<string, unknown>)[metric] === value);
    if (!sameReadings) sameDateVariants += 1;
    // 只保留最早时间戳的读数：较晚的同日读数可能来自别的点，不能覆盖已记录值。
    if (parsed.datetime < existing.datetime) eventByDate.set(parsed.date, { point: { date: parsed.date, ...metrics }, datetime: parsed.datetime });
  }
  const eventPoints = [...eventByDate.values()].map((entry) => entry.point).sort((a, b) => a.date.localeCompare(b.date));

  const merged = new Map<string, SellerSpriteHistoryPoint>();
  for (const point of [...monthlyPoints, ...eventPoints]) {
    const metrics = Object.keys(point).filter((key) => key !== "date").sort();
    const key = `${point.date}:${metrics.join(",")}`;
    if (!merged.has(key)) merged.set(key, point);
  }
  const series = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  const metrics = [...new Set(series.flatMap((point) => Object.keys(point).filter((key) => key !== "date")))] as SellerSpriteHistoryMetric[];
  const monthlyRange = rangeOf(monthlyPoints);
  const eventRange = rangeOf(eventPoints);
  const accepted = series.length > 0 && (monthlyRange !== null || eventRange !== null);
  return {
    series,
    points: series.length,
    monthlyPoints: monthlyPoints.length,
    eventPoints: eventPoints.length,
    sameDateVariants,
    tablePreferredSales,
    metrics,
    monthlyRange,
    eventRange,
    issues: dedupeIssues(issues),
    accepted,
    rejection: accepted ? null : "SELLERSPRITE_HISTORY_NO_VERIFIED_POINTS",
  };
}

function rangeOf(points: readonly SellerSpriteHistoryPoint[]): SellerSpriteHistoryRange | null {
  if (points.length === 0) return null;
  const dates = points.map((point) => point.date).sort();
  return { from: dates[0], to: dates[dates.length - 1], count: points.length };
}

function dedupeIssues(issues: readonly SellerSpriteHistoryParseIssue[]): SellerSpriteHistoryParseIssue[] {
  const seen = new Set<string>();
  const out: SellerSpriteHistoryParseIssue[] = [];
  for (const item of issues) {
    const key = `${item.code}:${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/**
 * 读取历史抽屉快照（在页面上下文执行；只读可见 DOM，不发起网络请求）。
 * 找不到抽屉返回 null —— 由调用方如实报告「当前页没有打开的历史抽屉」，不猜测。
 */
export function collectSellerSpriteHistoryDrawer(): SellerSpriteHistoryDrawerRaw | null {
  const textOf = (element: Element | null | undefined): string => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
  const drawers = Array.from(document.querySelectorAll(".el-drawer.btt")).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 200 && rect.height > 200;
  });
  const drawer = drawers[0];
  if (!drawer) return null;
  const header = drawer.querySelector(".media-body-f, .media-body, .product-info");
  const headerText = textOf(header).slice(0, 2000);
  const asinMatches = [...new Set(headerText.toUpperCase().match(/\bB[A-Z0-9]{9}\b/gu) ?? [])];
  const asin = asinMatches.length === 1 ? asinMatches[0] : null;
  const title = (drawer.querySelector(".media-body") as HTMLElement | null)?.innerText?.split(/\r?\n/u)[0]?.trim() || null;
  const activeTab = textOf(drawer.querySelector(".el-tabs__item.is-active")) || null;
  const rangeLabel = textOf(drawer.querySelector(".keepa-sub-range .active, .keepa-sub-range .is-active")) || null;

  const tables = Array.from(drawer.querySelectorAll("table"));
  const monthHeadOf = (table: Element): string[] => Array.from(table.querySelectorAll("thead th"))
    .map((cell) => textOf(cell))
    .filter((value) => /^\d{4}-\d{2}$/u.test(value));
  const bodyRowsOf = (table: Element): string[][] => Array.from(table.querySelectorAll("tbody tr"))
    .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => textOf(cell)));
  const allHeads = tables.map((table) => [...new Set(monthHeadOf(table))]);
  const monthTableGroups: { months: string[]; rows: { label: string; values: string[] }[] }[] = [];
  const labelRows: string[][] = [];
  for (const cells of tables.flatMap((table) => bodyRowsOf(table))) {
    if (cells.length >= 2 && cells[0] && cells.slice(1).every((value) => !value)) labelRows.push(cells);
  }
  allHeads.forEach((months, headIndex) => {
    if (months.length < 3) return;
    const rows: { label: string; values: string[] }[] = [];
    for (const table of tables.slice(headIndex + 1)) {
      const bodyRows = bodyRowsOf(table).filter((cells) => cells.length > 1);
      if (!bodyRows.length) continue;
      for (const cells of bodyRows) {
        const label = cells[0];
        if (label && /^\d{4}-\d{2}$/u.test(label)) continue;
        rows.push({ label, values: cells.slice(1) });
      }
      break;
    }
    if (!rows.length) return;
    monthTableGroups.push({ months, rows });
  });

  const canvases = Array.from(drawer.querySelectorAll("canvas"));
  const visibleCanvas = canvases.map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
    .find((entry) => entry.rect.width > 100 && entry.rect.height > 100) ?? null;
  const tooltip = Array.from(drawer.querySelectorAll(".chart"))
    .map((node) => ((node as HTMLElement).innerText ?? "").replace(/[ \t]+/gu, " ").trim())
    .find((text) => /^\d{4}-?\d{2}(?:-\d{2})?(?:[ T]\d{2}:\d{2})?/u.test(text)) ?? "";
  const raw: SellerSpriteHistoryDrawerRaw = {
    asin,
    title: title ? title.slice(0, 300) : null,
    headerText,
    activeTab,
    rangeLabel,
    monthTableGroups,
    labelRows,
    tooltipTexts: tooltip ? [tooltip] : [],
  };
  if (visibleCanvas) {
    const rect = visibleCanvas.rect;
    raw.chartSurface = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  return raw;
}
