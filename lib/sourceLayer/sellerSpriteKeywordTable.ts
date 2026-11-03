import { createHash } from "node:crypto";

export type SellerSpriteKeywordPage = "reverse_asin" | "keyword_mining_trend";
export type SellerSpriteKeywordMetric =
  | "trafficShare"
  | "estimatedTraffic"
  | "organicRank"
  | "adRank"
  | "searchVolume"
  | "searchVolumeGrowth"
  | "spr"
  | "titleDensity"
  | "estimatedMonthlyPurchase"
  | "estimatedPurchaseRate"
  | "estimatedMonthlySales"
  | "estimatedMonthlyRevenue";

export type SellerSpriteTypedMetric = {
  readonly raw: string | null;
  readonly value: number | null;
  readonly unit: "count" | "ratio" | "percent" | "currency" | "unknown";
  readonly metricNature: "provider_estimate";
  readonly status: "parsed" | "unknown";
};

export type SellerSpriteKeywordTableInput = {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
};

export type SellerSpriteTypedKeywordRow = {
  readonly rowKey: string;
  /** Query-scoped stable identity: page + normalized keyword, independent of changing estimate cells. */
  readonly sourceRowIndex?: number;
  readonly keyword: string;
  readonly rawCells: Readonly<Record<string, string | null>>;
  readonly metrics: Readonly<Partial<Record<SellerSpriteKeywordMetric, SellerSpriteTypedMetric>>>;
  readonly status: "valid" | "partial";
};

export type SellerSpriteKeywordTableParse = {
  readonly status: "valid" | "partial" | "unavailable";
  readonly page: SellerSpriteKeywordPage;
  readonly rows: readonly SellerSpriteTypedKeywordRow[];
  readonly inputRowCount: number;
  readonly uniqueRowCount: number;
  readonly rejectedRowCount: number;
  readonly duplicateRowCount: number;
  readonly limitations: readonly string[];
};

const ALIASES: Readonly<Record<SellerSpriteKeywordPage, Readonly<Partial<Record<SellerSpriteKeywordMetric | "keyword", readonly string[]>>>>> = {
  reverse_asin: {
    keyword: ["keyword", "关键词", "搜索词"],
    trafficShare: ["traffic share", "流量占比", "流量份额"],
    estimatedTraffic: ["estimated traffic", "预估流量", "估算流量"],
    organicRank: ["organic rank", "自然排名", "自然位"],
    adRank: ["ad rank", "广告排名", "广告位"],
    searchVolume: ["search volume", "月搜索量", "搜索量"],
    // 真实页面把「月搜索量」与「增长率」合并在同一列（表头：月搜索量增长率）。
    // 显式登记为增长率列，避免被更短的「月搜索量」别名抢先命中而误判语义。
    searchVolumeGrowth: ["月搜索量增长率", "搜索量增长率", "search volume growth", "search volume change", "搜索量增长", "搜索量变化"],
    // 以下三列在真实 Reverse ASIN 结果表中确实存在（SPR / 标题密度 / 月购买量）。
    spr: ["spr"],
    titleDensity: ["title density", "标题密度"],
    estimatedMonthlyPurchase: ["estimated monthly purchase", "monthly purchases", "月购买量", "月购买次数"],
    estimatedPurchaseRate: ["purchase rate", "购买率"],
  },
  keyword_mining_trend: {
    keyword: ["keyword", "关键词", "搜索词"],
    searchVolume: ["search volume", "monthly searches", "月搜索量", "搜索量"],
    searchVolumeGrowth: ["search volume growth", "search volume change", "搜索量增长", "搜索量变化"],
    spr: ["spr"],
    titleDensity: ["title density", "标题密度"],
    estimatedMonthlyPurchase: ["estimated monthly purchase", "monthly purchases", "月购买量", "月购买次数"],
    estimatedPurchaseRate: ["purchase rate", "购买率"],
    estimatedMonthlySales: ["estimated monthly sales", "月销量估算", "预估月销量"],
    estimatedMonthlyRevenue: ["estimated monthly revenue", "月销售额估算", "预估月销售额"],
  },
};

const UNIT_BY_METRIC: Readonly<Record<SellerSpriteKeywordMetric, SellerSpriteTypedMetric["unit"]>> = {
  trafficShare: "ratio",
  estimatedTraffic: "count",
  organicRank: "count",
  adRank: "count",
  searchVolume: "count",
  searchVolumeGrowth: "percent",
  spr: "count",
  titleDensity: "count",
  estimatedMonthlyPurchase: "count",
  estimatedPurchaseRate: "ratio",
  estimatedMonthlySales: "count",
  estimatedMonthlyRevenue: "currency",
};

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").trim();
}

function normalizeKeyword(value: string): string {
  return value.normalize("NFC").split("\n", 1)[0]?.replace(/\s+/gu, " ").trim() ?? "";
}

export function sellerSpriteKeywordRowKey(page: SellerSpriteKeywordPage, value: string): string {
  const keyword = normalizeKeyword(value);
  if (!keyword) return "";
  return fingerprint({ page, keyword: normalizeHeader(keyword) });
}

type KeywordColumnKey = SellerSpriteKeywordMetric | "keyword";

/**
 * 解析表头 → 指标列。
 *
 * 规则（确定性、不猜测）：
 * 1. 归一化后做**包含匹配**：真实页面表头常带徽标/提示词，例如
 *    `关键词 数据解释`、`内测版流量占比`（真实列语义仍是「关键词」「流量占比」）；
 * 2. **最长别名优先**：跨全部指标竞争，避免 `月搜索量增长率` 被更短的 `月搜索量`
 *    抢先命中而误判语义；
 * 3. 同一表头命中两组长度的别名 → 记为歧义，**不分配**；
 * 4. 同一指标命中多个表头 → 记为重复，**返回 null**（不猜）。
 */
function resolveColumns(
  headers: readonly string[],
  aliases: Readonly<Partial<Record<KeywordColumnKey, readonly string[]>>>,
): Map<KeywordColumnKey, { index: number | null; ambiguous: boolean }> {
  const entries: Array<{ key: KeywordColumnKey; alias: string }> = [];
  for (const [key, names] of Object.entries(aliases)) {
    for (const name of names ?? []) {
      const alias = normalizeHeader(name);
      if (alias) entries.push({ key: key as KeywordColumnKey, alias });
    }
  }

  const assigned = new Map<KeywordColumnKey, number[]>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    let best: { key: KeywordColumnKey; length: number } | null = null;
    let tie = false;
    for (const entry of entries) {
      if (!normalized.includes(entry.alias)) continue;
      if (!best || entry.alias.length > best.length) {
        best = { key: entry.key, length: entry.alias.length };
        tie = false;
      } else if (entry.alias.length === best.length && entry.key !== best.key) {
        tie = true;
      }
    }
    if (!best || tie) return; // 无匹配或等长冲突 → 不分配
    const list = assigned.get(best.key) ?? [];
    list.push(index);
    assigned.set(best.key, list);
  });

  const columns = new Map<KeywordColumnKey, { index: number | null; ambiguous: boolean }>();
  for (const key of Object.keys(aliases) as KeywordColumnKey[]) {
    const list = assigned.get(key) ?? [];
    columns.set(key, { index: list.length === 1 ? list[0] : null, ambiguous: list.length > 1 });
  }
  return columns;
}

function parseNumber(raw: string | null, unit: SellerSpriteTypedMetric["unit"]): number | null {
  if (raw === null) return null;
  const text = raw.normalize("NFKC").trim();
  if (!text || /^(?:-|—|n\/a|na|unknown|\?)$/iu.test(text)) return null;
  const countWithEmbeddedGrowth = /^\s*\d[\d,]*(?:\.\d+)?\s*\(\s*[+-]?\d+(?:\.\d+)?\s*%\s*\)/u.test(text);
  if (/%/u.test(text) && unit !== "percent" && unit !== "ratio" && !countWithEmbeddedGrowth) return null;
  const percent = /(-?\d+(?:[.,]\d+)?)\s*%/u.exec(text);
  if (unit === "percent" || unit === "ratio") {
    if (!percent) return null;
    const value = Number(percent[1].replace(/,/gu, ""));
    if (!Number.isFinite(value)) return null;
    return unit === "ratio" ? value / 100 : value / 100;
  }
  const match = /-?\d[\d,]*(?:\.\d+)?/u.exec(text);
  if (!match) return null;
  const value = Number(match[0].replace(/,/gu, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function typedMetric(raw: string | null, unit: SellerSpriteTypedMetric["unit"]): SellerSpriteTypedMetric {
  const value = parseNumber(raw, unit);
  return { raw, value, unit, metricNature: "provider_estimate", status: value === null ? "unknown" : "parsed" };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Converts only page-labeled columns into typed SellerSprite estimates. It never
 * guesses a keyword by column position or longest text; unrecognized cells stay raw.
 */
export function parseSellerSpriteKeywordTable(input: {
  readonly page: SellerSpriteKeywordPage;
  readonly table: SellerSpriteKeywordTableInput;
}): SellerSpriteKeywordTableParse {
  const headers = input.table.headers.map((value) => value.trim());
  const aliases = ALIASES[input.page];
  const resolved = resolveColumns(headers, aliases);
  const keywordColumn = resolved.get("keyword") ?? { index: null, ambiguous: false };
  const columns = new Map<SellerSpriteKeywordMetric, number | null>();
  const limitations = new Set<string>();
  if (keywordColumn.ambiguous) limitations.add("duplicate_keyword_header");
  if (keywordColumn.index === null) limitations.add("keyword_header_unidentified");

  for (const metric of Object.keys(aliases)) {
    if (metric === "keyword") continue;
    const column = resolved.get(metric as SellerSpriteKeywordMetric) ?? { index: null, ambiguous: false };
    columns.set(metric as SellerSpriteKeywordMetric, column.index);
    if (column.ambiguous) limitations.add(`duplicate_${metric}_header`);
  }
  if (headers.length === 0) limitations.add("headers_missing");

  const deduped = new Map<string, SellerSpriteTypedKeywordRow>();
  let rejectedRowCount = 0;
  let duplicateRowCount = 0;
  for (const [sourceRowIndex, row] of input.table.rows.entries()) {
    const rawKeyword = keywordColumn.index === null ? null : row[keywordColumn.index] ?? null;
    const keyword = typeof rawKeyword === "string" ? normalizeKeyword(rawKeyword) : "";
    const repeatsHeader = headers.filter((header, index) =>
      header && normalizeHeader(typeof row[index] === "string" ? row[index] as string : "") === normalizeHeader(header),
    ).length >= 2;
    const placeholder = /^(?:loading|no results|no data|暂无数据|加载中|--+|—+)$/iu.test(keyword);
    if (!keyword || keywordColumn.index === null || repeatsHeader || placeholder) {
      rejectedRowCount += 1;
      continue;
    }
    const rawCells: Record<string, string | null> = {};
    headers.forEach((header, index) => {
      const key = header || `unknown_column_${index + 1}`;
      rawCells[key] = typeof row[index] === "string" ? row[index] : null;
    });
    const metrics: Partial<Record<SellerSpriteKeywordMetric, SellerSpriteTypedMetric>> = {};
    for (const [metric, index] of columns) {
      if (index === null) continue;
      const raw = typeof row[index] === "string" ? row[index] : null;
      metrics[metric] = typedMetric(raw, UNIT_BY_METRIC[metric]);
      // Only this named purchase column carries a count + purchase rate. Do not
      // relax the generic number parser (e.g. SPR/price must reject a percent).
      if (metric === "estimatedMonthlyPurchase" && raw) {
        const compound = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\s+(\d+(?:\.\d+)?)\s*%|\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\))$/u.exec(raw.normalize("NFKC").trim());
        if (compound) {
          metrics.estimatedMonthlyPurchase = { ...typedMetric(compound[1], "count"), raw };
          if (columns.get("estimatedPurchaseRate") === null && !resolved.get("estimatedPurchaseRate")?.ambiguous) {
            const rate = typedMetric(`${compound[2] ?? compound[3]}%`, "ratio");
            metrics.estimatedPurchaseRate = { ...rate, raw, ...(rate.value !== null && rate.value > 1 ? { value: null, status: "unknown" as const } : {}) };
          }
        }
      }
      if (metric === "estimatedPurchaseRate" && metrics[metric]?.value !== null
        && ((metrics[metric]?.value ?? 0) < 0 || (metrics[metric]?.value ?? 0) > 1)) {
        metrics[metric] = { ...metrics[metric]!, value: null, status: "unknown" };
      }
      // Real SellerSprite combines a count and growth in this explicitly named column.
      // Recover the count only from an exact integer + percentage cell, never from a lone rate.
      if(metric==="searchVolumeGrowth"&&normalizeHeader(headers[index])===normalizeHeader("月搜索量增长率")&&columns.get("searchVolume")===null&&!resolved.get("searchVolume")?.ambiguous&&raw){
        const compound=/^\s*(\d{1,3}(?:,\d{3})+|\d+)\s+([+-]?\d+(?:\.\d+)?)\s*%\s*$/u.exec(raw.normalize("NFKC"));
        if(compound)metrics.searchVolume=typedMetric(compound[1],"count");
      }

      if (metric === "searchVolume" && columns.get("searchVolumeGrowth") === null && raw) {
        const embeddedGrowth = /\(\s*([+-]?\d+(?:\.\d+)?)\s*%\s*\)/u.exec(raw);
        if (embeddedGrowth) {
          const percentage = Number(embeddedGrowth[1]) / 100;
          if (Number.isFinite(percentage)) {
            metrics.searchVolumeGrowth = {
              raw: embeddedGrowth[0],
              value: percentage,
              unit: "percent",
              metricNature: "provider_estimate",
              status: "parsed",
            };
          }
        }
      }
    }
    const rowKey = sellerSpriteKeywordRowKey(input.page, keyword);
    if (deduped.has(rowKey)) {
      duplicateRowCount += 1;
      continue;
    }
    const parsedMetrics = Object.values(metrics).filter((metric) => metric?.status === "parsed").length;
    deduped.set(rowKey, {
      rowKey,
      sourceRowIndex,
      keyword,
      rawCells,
      metrics,
      status: parsedMetrics > 0 ? "valid" : "partial",
    });
  }
  const rows = [...deduped.values()];
  if (rows.length === 0) limitations.add("no_structured_keyword_rows");
  const status = rows.length === 0 ? "unavailable" : limitations.size > 0 || rows.some((row) => row.status === "partial") ? "partial" : "valid";
  return {
    status,
    page: input.page,
    rows,
    inputRowCount: input.table.rows.length,
    uniqueRowCount: rows.length,
    rejectedRowCount,
    duplicateRowCount,
    limitations: [...limitations].sort(),
  };
}
