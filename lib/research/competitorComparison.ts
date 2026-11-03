/**
 * 03 商品深研：代表商品可比性与竞品差异投影（纯函数、只读）。
 *
 * 输入只来自已经落库的市场扫描冻结数据：
 * - `MarketScan.sampleDefinitionJson.workflow.representatives.items[]`（代表商品与角色）
 * - `MarketScan.sampleSnapshotJson.items[].factValues`（快照事实，含 present/missing）
 *
 * 架构红线：
 * 1. 不写 ProductFact / EvidenceStore，不新建第二事实库，不做真实采集。
 * 2. `presence !== "present"` 一律视为缺失（null），绝不填 0、绝不猜测。
 * 3. 包装数量只从商品标题解析，解析不到保持 null；禁止默认按 1 件兜底。
 * 4. 每件单价只在「价格、包装数量、品类口径」都可比时计算；否则不计算、不排序。
 * 5. 不生成任何综合评分/竞争力评分/推荐指数，只陈述有事实依据的维度差异。
 */

import {
  DEEP_RESEARCH_SCHEMA,
  type DeepResearchComparabilityLevel,
  type DeepResearchComparisonProjection,
  type DeepResearchCompetitorRow,
} from "./deepResearchTypes";
import { roleLabel, type RepresentativeRole } from "@/lib/marketWorkflow/metadata";

/** 代表商品输入：与 `workflow.representatives.items[]` 结构对应。 */
export type CompetitorRepresentativeInput = {
  asin: string;
  subjectKey: string;
  /** 未知/缺失的角色会被丢弃（不猜测角色）。 */
  role?: string | null;
  note?: string | null;
};

/** 快照条目输入：与 `sampleSnapshotJson.items[]` 结构对应。 */
export type CompetitorSnapshotItemInput = {
  asin: string;
  subjectKey: string;
  capturedAt?: string | null;
  /** 原始 factValues（未知结构按缺失处理）。 */
  factValues?: unknown;
};

export type CompetitorComparisonInput = {
  scanId: string | null;
  scanName: string | null;
  representatives: ReadonlyArray<CompetitorRepresentativeInput>;
  items: ReadonlyArray<CompetitorSnapshotItemInput>;
};

/** 行顺序：基准商品 → 痛点样本 → 新进入者。 */
const ROLE_ORDER: readonly RepresentativeRole[] = ["benchmark", "pain_point", "newcomer"];

type ParsedCapacity = { readonly label: "容量" | "尺寸"; readonly value: string; readonly unit: string };

type ParsedRow = {
  readonly row: DeepResearchCompetitorRow;
  readonly capacity: ParsedCapacity | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRepresentativeRole(value: unknown): value is RepresentativeRole {
  return value === "benchmark" || value === "newcomer" || value === "pain_point";
}

function roleRank(role: RepresentativeRole): number {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读取 `MarketFactValueV1<T>`；缺失或类型不符 → null。 */
function readFactValue(factValues: Record<string, unknown> | null, key: string): unknown {
  if (!factValues) return null;
  const field = factValues[key];
  if (!isRecord(field) || field.presence !== "present") return null;
  return field.value ?? null;
}

function readFactText(factValues: Record<string, unknown> | null, key: string): string | null {
  return text(readFactValue(factValues, key));
}

function readFactNumber(factValues: Record<string, unknown> | null, key: string): number | null {
  return finiteNumber(readFactValue(factValues, key));
}

/** 价格只在 presence=present、金额有限、币种非空时成立；否则 null（不填 0）。 */
function readPrice(
  factValues: Record<string, unknown> | null,
): { amount: number; currency: string } | null {
  const raw = readFactValue(factValues, "price");
  if (!isRecord(raw)) return null;
  const amount = finiteNumber(raw.amount);
  const currency = text(raw.currency);
  if (amount === null || currency === null) return null;
  return { amount, currency };
}

const PACK_PATTERNS: ReadonlyArray<RegExp> = [
  // "(6 pack)" / "(6 packs)"
  /\((\d+)\s*packs?\)/i,
  // "6-Pack" / "2 pack" / "6 pk"
  /(\d+)\s*[- ]?(?:packs?|pk)\b/i,
  // "Set of 4"
  /\bset\s+of\s+(\d+)\b/i,
  // "Pack of 2"
  /\bpack\s+of\s+(\d+)\b/i,
  // 中文 "4件装" / "4只装"
  /(\d+)\s*(?:件装|只装)/,
];

/**
 * 从商品标题保守解析包装数量。仅接受白名单模式，且多个模式给出不同数值时视为歧义 → null。
 * 禁止「没写就当作 1 件」。
 */
export function parseTitlePackCount(
  title: string | null,
): { value: number; source: "title"; raw: string } | null {
  if (!title) return null;
  const matched = new Map<number, string>();
  for (const pattern of PACK_PATTERNS) {
    const match = title.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? "", 10);
    // 合理范围外视为噪声（如年份/型号），不当作包装数量。
    if (!Number.isInteger(value) || value < 1 || value > 100) continue;
    if (!matched.has(value)) matched.set(value, match[0].trim());
  }
  if (matched.size !== 1) return null;
  const [entry] = [...matched.entries()];
  return { value: entry[0], source: "title", raw: entry[1] };
}

const CAPACITY_PATTERN =
  /(\d+(?:\.\d+)?)\s*(quarts?|qt|gallons?|gal|liters?|litres?|ml|oz)\b/i;
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(inches?|inch|in|cm|mm)\b/i;

/**
 * 从标题提取容量/尺寸。只提数字+单位这类可核对的字面量，不推断材质/结构。
 */
function extractCapacity(title: string | null): ParsedCapacity | null {
  if (!title) return null;
  const capacity = title.match(CAPACITY_PATTERN);
  if (capacity) {
    return { label: "容量", value: capacity[0].trim(), unit: (capacity[2] ?? "").toLowerCase() };
  }
  const size = title.match(SIZE_PATTERN);
  if (size) {
    return { label: "尺寸", value: size[0].trim(), unit: (size[2] ?? "").toLowerCase() };
  }
  return null;
}

function buildSpecs(title: string | null, packCount: DeepResearchCompetitorRow["packCount"], capacity: ParsedCapacity | null): DeepResearchCompetitorRow["specs"] {
  const specs: DeepResearchCompetitorRow["specs"] = [];
  if (capacity) specs.push({ label: capacity.label, value: capacity.value, source: "title" });
  if (packCount) specs.push({ label: "件数", value: packCount.raw, source: "title" });
  return specs;
}

function buildMissing(
  title: string | null,
  brand: string | null,
  category: string | null,
  price: DeepResearchCompetitorRow["price"],
  rating: number | null,
  reviewCount: number | null,
  bsr: unknown,
  packCount: DeepResearchCompetitorRow["packCount"],
): string[] {
  const missing: string[] = [];
  if (!title) missing.push("title");
  if (!brand) missing.push("brand");
  if (!category) missing.push("category");
  if (!price) missing.push("price");
  if (rating === null) missing.push("rating");
  if (reviewCount === null) missing.push("reviewCount");
  if (bsr === null || bsr === undefined) missing.push("bsr");
  if (!packCount) missing.push("packCount");
  return missing;
}

/** 输出货币金额的文本（最多保留两位，去掉浮点噪声）。 */
function formatAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

function formatMoney(amount: number, currency: string): string {
  return currency.toUpperCase() === "USD" ? `$${formatAmount(amount)}` : `${currency} ${formatAmount(amount)}`;
}

function roundUnitPrice(amount: number, packCount: number): number {
  return Math.round((amount / packCount) * 100) / 100;
}

function normalizeCategory(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

/**
 * 判定整组可比性，并在可行时为每行写入 unitPrice。
 * 优先级：缺包装数量 → 缺价格 → 品类/币种口径不同 → 可比。
 */
function assignComparability(rows: ParsedRow[]): void {
  if (rows.length === 0) return;

  const missingPackCount = rows.some((item) => item.row.packCount === null);
  const missingPrice = rows.some((item) => item.row.price === null);
  const categories = rows.map((item) => normalizeCategory(item.row.category));
  const categoriesPresent = categories.every((value) => value !== null);
  const sameCategory = categoriesPresent && new Set(categories).size === 1;
  const currencies = rows.map((item) => item.row.price?.currency.toUpperCase() ?? null);
  const sameCurrency = currencies.every((value) => value !== null) && new Set(currencies).size === 1;

  const apply = (level: DeepResearchComparabilityLevel, reason: string, allowUnitPrice: boolean): void => {
    for (const item of rows) {
      item.row.unitPrice = null;
      if (allowUnitPrice && item.row.price && item.row.packCount) {
        item.row.unitPrice = {
          amount: roundUnitPrice(item.row.price.amount, item.row.packCount.value),
          currency: item.row.price.currency,
          unitLabel: "每件",
        };
      }
      item.row.comparability = { level, reason };
    }
  };

  if (missingPackCount) {
    apply(
      "unknown",
      missingPrice ? "缺包装数量，无法计算每件单价（同时缺价格）" : "缺包装数量，无法计算每件单价",
      false,
    );
    return;
  }
  if (missingPrice) {
    apply("unknown", "缺价格，无法计算每件单价", false);
    return;
  }
  if (!sameCategory) {
    apply("spec_differs", "品类或规格口径不同，暂不可直接比较", false);
    return;
  }
  if (!sameCurrency) {
    apply("spec_differs", "品类或规格口径不同，暂不可直接比较（币种不同，无法直接比价）", false);
    return;
  }
  apply("comparable", "同品类且包装数量已知，可按每件单价比较", true);
}

function buildDifferences(rows: ParsedRow[]): DeepResearchComparisonProjection["differences"] {
  const differences: DeepResearchComparisonProjection["differences"] = [];

  // 价格区间（只在同一币种、至少两个价格时）
  const priced = rows.filter((item) => item.row.price !== null);
  if (priced.length >= 2) {
    const currency = priced[0].row.price!.currency.toUpperCase();
    const sameCurrency = priced.every((item) => item.row.price!.currency.toUpperCase() === currency);
    if (sameCurrency) {
      const amounts = priced.map((item) => item.row.price!.amount);
      const min = Math.min(...amounts);
      const max = Math.max(...amounts);
      const summary =
        min === max
          ? `价格一致 ${formatMoney(min, currency)}（${priced.length} 件）`
          : `价格区间 ${formatMoney(min, currency)}–${formatMoney(max, currency)}（${priced.length} 件）`;
      differences.push({ dimension: "价格", summary, asins: priced.map((item) => item.row.asin) });
    }
  }

  // 包装数量差异（存在不同件数才有意义）
  const packed = rows.filter((item) => item.row.packCount !== null);
  const packValues = [...new Set(packed.map((item) => item.row.packCount!.value))];
  if (packed.length >= 2 && packValues.length >= 2) {
    differences.push({
      dimension: "包装数量",
      summary: `包装数量 ${packValues.join(" vs ")} 件，单品不可直接比价`,
      asins: packed.map((item) => item.row.asin),
    });
  }

  // 评分与评论样本（只在至少两个评分时）
  const rated = rows.filter((item) => item.row.rating !== null);
  if (rated.length >= 2) {
    const ratings = rated.map((item) => item.row.rating!.toFixed(1));
    const reviewCounts = rated.map((item) => item.row.reviewCount);
    const allReviewCountsKnown = reviewCounts.every((count): count is number => count !== null);
    const summary = allReviewCountsKnown
      ? `评分 ${ratings.join(" vs ")}，样本 ${reviewCounts.join(" vs ")} 条`
      : `评分 ${ratings.join(" vs ")}（评论样本数不完整，暂不比较样本量）`;
    differences.push({ dimension: "评分", summary, asins: rated.map((item) => item.row.asin) });
  }

  // 容量/尺寸（只在同一单位、至少两行时）
  const capacityRows = rows.filter((item) => item.capacity !== null);
  if (capacityRows.length >= 2) {
    const units = new Set(capacityRows.map((item) => item.capacity!.unit));
    const labels = new Set(capacityRows.map((item) => item.capacity!.label));
    if (units.size === 1 && labels.size === 1) {
      const values = capacityRows.map((item) => item.capacity!.value);
      differences.push({
        dimension: capacityRows[0].capacity!.label,
        summary: `${capacityRows[0].capacity!.label} ${values.join(" vs ")}`,
        asins: capacityRows.map((item) => item.row.asin),
      });
    }
  }

  return differences;
}

function buildLimitations(rows: ParsedRow[], noRepresentatives: boolean, rowsWithoutSnapshot: number): string[] {
  const limitations: string[] = [];

  if (noRepresentatives || rows.length === 0) {
    limitations.push("未选择代表商品：没有可比较的竞品行，rows 为空。");
    return limitations;
  }

  if (rowsWithoutSnapshot > 0) {
    limitations.push(
      `有 ${rowsWithoutSnapshot} 个代表商品没有对应的样本快照事实，相关字段按缺失处理，不做推测。`,
    );
  }

  const missingPriceCount = rows.filter((item) => item.row.price === null).length;
  if (missingPriceCount > 0) {
    limitations.push(`有 ${missingPriceCount} 行缺少价格（presence=missing），价格与每件单价无法比较。`);
  }

  const missingTitleCount = rows.filter((item) => item.row.title === null).length;
  if (missingTitleCount > 0) {
    limitations.push(`有 ${missingTitleCount} 行缺少标题，无法解析包装数量与容量/尺寸。`);
  }

  const missingPackCount = rows.filter((item) => item.row.packCount === null).length;
  if (missingPackCount > 0) {
    limitations.push(
      `有 ${missingPackCount} 行标题未明确标注包装数量，未按 1 件兜底，每件单价不可计算。`,
    );
  }

  const hasMissingCategory = rows.some((item) => item.row.category === null);
  if (hasMissingCategory) {
    limitations.push("有代表商品缺失品类，无法确认单品比较口径是否一致。");
  }

  if (rows.length >= 2) {
    const levels = new Set(rows.map((item) => item.row.comparability.level));
    if (levels.size === 1 && levels.has("spec_differs")) {
      limitations.push("代表商品品类不一致或币种不同，未给出每件单价排序结论。");
    }
  }

  const capacityRows = rows.filter((item) => item.capacity !== null);
  if (capacityRows.length >= 2) {
    const units = new Set(capacityRows.map((item) => item.capacity!.unit));
    if (units.size > 1) {
      limitations.push("容量/尺寸单位不一致，未做容量归一化，未按容量比较单价。");
    } else {
      const values = new Set(capacityRows.map((item) => item.capacity!.value));
      if (values.size > 1) {
        limitations.push("容量/尺寸存在差异，但每件单价仅按件数折算，未覆盖容量差异。");
      }
    }
  }

  const reviewCounts = rows
    .map((item) => item.row.reviewCount)
    .filter((count): count is number => count !== null);
  if (reviewCounts.length >= 2) {
    const min = Math.min(...reviewCounts);
    const max = Math.max(...reviewCounts);
    if (min > 0 && max / min >= 5) {
      limitations.push(`评论样本差异较大（${min} vs ${max} 条），评分与热度对比需谨慎。`);
    }
  }

  const ratedCount = rows.filter((item) => item.row.rating !== null).length;
  if (ratedCount < rows.length) {
    limitations.push("部分代表商品缺少评分，评分对比不完整。");
  }

  if (rows.some((item) => item.row.packCount !== null)) {
    limitations.push("包装数量仅由标题字面解析，未经包装规格或实物核验。");
  }

  return limitations;
}

/**
 * 构建「代表商品可比性与竞品差异」投影。纯函数：无 I/O、无时钟、无随机。
 */
export function buildCompetitorComparison(
  input: CompetitorComparisonInput,
): DeepResearchComparisonProjection {
  const representatives: ReadonlyArray<unknown> = Array.isArray(input.representatives)
    ? input.representatives
    : [];
  const items: ReadonlyArray<unknown> = Array.isArray(input.items) ? input.items : [];

  type SnapshotItem = {
    asin: string;
    subjectKey: string;
    capturedAt: string | null;
    factValues: Record<string, unknown> | null;
  };

  const itemByAsin = new Map<string, SnapshotItem>();
  const itemBySubjectKey = new Map<string, SnapshotItem>();
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const snapshot: SnapshotItem = {
      asin: text(raw.asin) ?? "",
      subjectKey: text(raw.subjectKey) ?? "",
      capturedAt: text(raw.capturedAt),
      factValues: isRecord(raw.factValues) ? raw.factValues : null,
    };
    if (snapshot.asin && !itemByAsin.has(snapshot.asin)) itemByAsin.set(snapshot.asin, snapshot);
    if (snapshot.subjectKey && !itemBySubjectKey.has(snapshot.subjectKey)) {
      itemBySubjectKey.set(snapshot.subjectKey, snapshot);
    }
  }

  const candidates = representatives.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const asin = text(raw.asin);
    const role = isRepresentativeRole(raw.role) ? raw.role : null;
    if (!asin || !role) return [];
    return [{ asin, role, note: text(raw.note), subjectKey: text(raw.subjectKey), index }];
  });

  candidates.sort((left, right) => roleRank(left.role) - roleRank(right.role) || left.index - right.index);

  const seenAsins = new Set<string>();
  const rows: ParsedRow[] = [];
  let rowsWithoutSnapshot = 0;

  for (const candidate of candidates) {
    if (seenAsins.has(candidate.asin)) continue;
    seenAsins.add(candidate.asin);

    const snapshot = itemByAsin.get(candidate.asin) ?? (candidate.subjectKey ? itemBySubjectKey.get(candidate.subjectKey) : undefined);
    if (!snapshot) rowsWithoutSnapshot += 1;

    const factValues = snapshot?.factValues ?? null;
    const title = readFactText(factValues, "title");
    const brand = readFactText(factValues, "brand");
    const category = readFactText(factValues, "category");
    const price = readPrice(factValues);
    const rating = readFactNumber(factValues, "rating");
    const reviewCount = readFactNumber(factValues, "reviewCount");
    const bsr = readFactNumber(factValues, "bsr");
    const packCount = parseTitlePackCount(title);
    const capacity = extractCapacity(title);

    const row: DeepResearchCompetitorRow = {
      asin: candidate.asin,
      // 身份字段缺失时保持空串，不猜测市场节点。
      subjectKey: candidate.subjectKey ?? (snapshot && snapshot.subjectKey ? snapshot.subjectKey : null) ?? "",
      role: candidate.role,
      roleLabel: roleLabel(candidate.role),
      roleNote: text(candidate.note),
      title,
      brand,
      category,
      price,
      packCount,
      unitPrice: null,
      rating,
      reviewCount,
      bsr,
      specs: buildSpecs(title, packCount, capacity),
      capturedAt: snapshot?.capturedAt ?? null,
      missing: buildMissing(title, brand, category, price, rating, reviewCount, bsr, packCount),
      // 稍后由 assignComparability 统一填充整组判定。
      comparability: { level: "unknown", reason: "待判定" },
    };

    rows.push({ row, capacity });
  }

  assignComparability(rows);

  const roleCoverage: Array<RepresentativeRole> = ROLE_ORDER.filter((role) =>
    rows.some((item) => item.row.role === role),
  );

  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA,
    scanId: input.scanId,
    scanName: input.scanName,
    representativesSelected: rows.length > 0,
    roleCoverage,
    rows: rows.map((item) => item.row),
    differences: buildDifferences(rows),
    limitations: buildLimitations(rows, candidates.length === 0, rowsWithoutSnapshot),
  };
}
