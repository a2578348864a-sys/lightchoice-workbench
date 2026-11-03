import { createHash } from "node:crypto";
import { parseXlsxWorkbook, type XlsxWorkbook } from "@/lib/upstream/sellersprite/xlsx";

/**
 * V5.1 Keepa Export Parser MVP
 *
 * 目标：
 * - 纯函数解析器，零外部网络请求，不依赖 Keepa API，不自动登录，不触碰反爬。
 * - 支持解析用户从 Keepa Product Viewer 导出的官方 CSV / XLSX 文件。
 * - 提取 7 大核心时序风控字段：
 *   1. price90dMin: 90天历史最低破位价
 *   2. price90dAvg: 90天均价
 *   3. price360dMin: 360天历史最低破位价
 *   4. bsr90dAvg: 90天平均BSR
 *   5. bsrDrops90d: 90天BSR波动/出单频次
 *   6. buyBoxAmazonSharePercent: 90天Amazon自营BuyBox霸占率(%)
 *   7. dealCount90d: 90天秒杀促销频次
 * - 未提供或非法的字段一律置为 null (保持 missing)，绝不靠 AI 脑补。
 */

export interface KeepaTimeSeriesMetrics {
  readonly price90dMin: number | null;
  readonly price90dAvg: number | null;
  readonly price360dMin: number | null;
  readonly bsr90dAvg: number | null;
  readonly bsrDrops90d: number | null;
  readonly buyBoxAmazonSharePercent: number | null;
  readonly dealCount90d: number | null;
}

export interface KeepaExportRow {
  readonly asin: string;
  readonly title: string | null;
  readonly images: readonly string[];
  readonly currentPrice: number | null;
  readonly currentBsr: number | null;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly metrics: KeepaTimeSeriesMetrics;
  readonly rawRow: Readonly<Record<string, string | null>>;
}

export interface KeepaExportParseResult {
  readonly ok: boolean;
  readonly format: "csv" | "xlsx" | "unknown";
  readonly sourceFileSha256: string;
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rows: readonly KeepaExportRow[];
  readonly errors: readonly string[];
}

const ALIASES: Readonly<Record<keyof KeepaTimeSeriesMetrics | "asin" | "title" | "images" | "currentPrice" | "currentBsr" | "rating" | "reviewCount", readonly string[]>> = {
  asin: [
    "asin",
    "product asin",
    "商品asin",
    "asin code",
  ],
  title: [
    "title",
    "product title",
    "商品标题",
    "name",
    "product name",
  ],
  images: [
    "image",
    "images",
    "product image",
    "main image",
    "商品主图",
    "图片",
  ],
  price90dMin: [
    "buy box: 90 days lowest",
    "buy box: lowest 90 days",
    "buy box: lowest",
    "new: 90 days lowest",
    "new: lowest 90 days",
    "amazon: 90 days lowest",
    "amazon: lowest 90 days",
    "lowest 90 days",
    "lowest: 90 days",
    "price 90d min",
    "price90dmin",
  ],
  price90dAvg: [
    "buy box: 90 days avg",
    "buy box: 90 days average",
    "buy box: avg 90 days",
    "new: 90 days avg",
    "new: 90 days average",
    "90 days avg.: new",
    "90 days avg: new",
    "90 days avg.: buy box",
    "90 days avg: buy box",
    "amazon: 90 days avg",
    "amazon: 90 days average",
    "average 90 days",
    "price 90d avg",
    "price90davg",
  ],
  price360dMin: [
    "buy box: 360 days lowest",
    "buy box: lowest 360 days",
    "new: 360 days lowest",
    "new: lowest 360 days",
    "amazon: 360 days lowest",
    "amazon: lowest 360 days",
    "lowest 360 days",
    "lowest: 360 days",
    "lowest: all time",
    "lowest all time",
    "price 360d min",
    "price360dmin",
  ],
  bsr90dAvg: [
    "sales rank: 90 days avg",
    "sales rank: 90 days average",
    "sales rank: avg 90 days",
    "90 days avg.: sales rank",
    "90 days avg: sales rank",
    "90 days avg.: bsr",
    "bsr: 90 days avg",
    "bsr 90d avg",
    "bsr90davg",
  ],
  bsrDrops90d: [
    "sales rank: drops 90 days",
    "sales rank: 90 days drops",
    "90 days drops: sales rank",
    "90 days drops: bsr",
    "sales rank drops 90 days",
    "bsr drops 90 days",
    "bsr drops: 90 days",
    "bsrdrops90d",
  ],
  buyBoxAmazonSharePercent: [
    "buy box: % amazon 90 days",
    "buy box: amazon 90 days %",
    "buy box % amazon 90 days",
    "buy box: % amazon",
    "% amazon 90 days",
    "buy box % amazon",
    "buyboxamazonsharepercent",
  ],
  dealCount90d: [
    "lightning deals: 90 days count",
    "lightning deal: 90 days count",
    "lightning deals: count 90 days",
    "lightning deal: count 90 days",
    "deals: 90 days count",
    "90 days: deals",
    "90 days deals",
    "deals: 90 days",
    "dealcount90d",
  ],
  currentPrice: [
    "buy box: current",
    "new: current",
    "current: new",
    "current: buy box",
    "current: amazon",
    "amazon: current",
    "price: current",
    "current price",
    "price",
  ],
  currentBsr: [
    "sales rank: current",
    "current: sales rank",
    "current: bsr",
    "bsr: current",
    "current bsr",
    "sales rank",
    "bsr",
  ],
  rating: [
    "reviews: rating",
    "rating",
    "review rating",
    "评分",
  ],
  reviewCount: [
    "reviews: review count",
    "reviews: count",
    "review count",
    "reviews",
    "评分数",
    "评论数",
  ],
};

function normalizeHeader(val: string | null | undefined): string {
  if (!val) return "";
  return val.trim().toLowerCase().replace(/[\r\n\t]+/g, " ");
}

export function parseKeepaNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  const lower = str.toLowerCase();
  if (lower === "-1" || lower === "n/a" || lower === "none" || lower === "-" || lower === "--" || lower === "nan") {
    return null;
  }
  const cleaned = str.replace(/[$€£¥,]/g, "").trim();
  const isPercent = cleaned.endsWith("%");
  const numStr = isPercent ? cleaned.slice(0, -1).trim() : cleaned;
  const parsed = Number(numStr);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return isPercent ? parsed : parsed;
}

export function parseKeepaPercent(value: unknown): number | null {
  const num = parseKeepaNumber(value);
  if (num === null) return null;
  // If formatted as 0.45 without % in original, convert to 45%
  const str = String(value).trim();
  if (num <= 1 && num > 0 && !str.endsWith("%")) {
    return Math.round(num * 1000) / 10;
  }
  return Math.min(100, Math.max(0, num));
}

function parseKeepaAsin(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(trimmed)) return trimmed;
  return null;
}

/** RFC-4180 兼容的纯函数 CSV 行切分器 */
export function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const content = text.replace(/^\uFEFF/, "");
  if (!content.trim()) return { headers: [], rows: [] };

  const firstLineEnd = content.search(/\r\n|\r|\n/);
  const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);

  // 探测分隔符
  const countChar = (char: string) => {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '"') inQuotes = !inQuotes;
      else if (!inQuotes && firstLine[i] === char) count++;
    }
    return count;
  };
  const commaCount = countChar(",");
  const semicolonCount = countChar(";");
  const tabCount = countChar("\t");
  let delimiter = ",";
  if (semicolonCount > commaCount && semicolonCount > tabCount) delimiter = ";";
  else if (tabCount > commaCount && tabCount > semicolonCount) delimiter = "\t";

  const allRows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let insideQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === delimiter && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i++;
      }
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((f) => f.length > 0)) {
        allRows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += char;
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      allRows.push(currentRow);
    }
  }

  if (allRows.length === 0) return { headers: [], rows: [] };
  return {
    headers: allRows[0],
    rows: allRows.slice(1),
  };
}

/**
 * 主解析函数：接收 Buffer / Uint8Array / 字符串，输出结构化时序事实。
 */
export function parseKeepaExport(input: Uint8Array | string): KeepaExportParseResult {
  const errors: string[] = [];
  let buffer: Buffer;
  let text = "";
  let isXlsx = false;

  if (typeof input === "string") {
    text = input;
    buffer = Buffer.from(input, "utf8");
  } else {
    buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    // 检测 ZIP / XLSX 魔数 PK\x03\x04
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      isXlsx = true;
    } else {
      // 检查 UTF-16LE BOM: 0xFF, 0xFE
      if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        text = buffer.toString("utf16le");
      } else {
        text = buffer.toString("utf8");
      }
    }
  }

  const sourceFileSha256 = createHash("sha256").update(buffer).digest("hex");

  let rawHeaders: string[] = [];
  let rawDataRows: (string | null)[][] = [];

  if (isXlsx) {
    try {
      const workbook: XlsxWorkbook = parseXlsxWorkbook(input as Uint8Array);
      if (!workbook.sheets || workbook.sheets.length === 0) {
        return {
          ok: false,
          format: "xlsx",
          sourceFileSha256,
          totalRows: 0,
          acceptedRows: 0,
          rows: [],
          errors: ["xlsx_has_no_sheets"],
        };
      }
      // 优先选取首个具有数据的 sheet
      const sheet = workbook.sheets.find((s) => s.rows.length > 1) ?? workbook.sheets[0];
      if (sheet.rows.length > 0) {
        rawHeaders = sheet.rows[0].values.map((v) => (v ? String(v) : ""));
        rawDataRows = sheet.rows.slice(1).map((r) => [...r.values]);
      }
    } catch (err) {
      return {
        ok: false,
        format: "xlsx",
        sourceFileSha256,
        totalRows: 0,
        acceptedRows: 0,
        rows: [],
        errors: [`xlsx_parse_failed:${err instanceof Error ? err.message : String(err)}`],
      };
    }
  } else {
    const csv = parseCsvText(text);
    rawHeaders = csv.headers;
    rawDataRows = csv.rows;
  }

  if (rawHeaders.length === 0 || rawDataRows.length === 0) {
    return {
      ok: false,
      format: isXlsx ? "xlsx" : "csv",
      sourceFileSha256,
      totalRows: 0,
      acceptedRows: 0,
      rows: [],
      errors: ["empty_export_data"],
    };
  }

  // 建立表头归一化索引映射
  const columnIndexMap = new Map<string, number>();
  rawHeaders.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    if (norm && !columnIndexMap.has(norm)) {
      columnIndexMap.set(norm, idx);
    }
  });

  const resolveColumnIndex = (candidateAliases: readonly string[]): number | null => {
    for (const alias of candidateAliases) {
      const norm = normalizeHeader(alias);
      if (columnIndexMap.has(norm)) {
        return columnIndexMap.get(norm)!;
      }
    }
    return null;
  };

  const asinCol = resolveColumnIndex(ALIASES.asin);
  if (asinCol === null) {
    return {
      ok: false,
      format: isXlsx ? "xlsx" : "csv",
      sourceFileSha256,
      totalRows: rawDataRows.length,
      acceptedRows: 0,
      rows: [],
      errors: ["asin_column_not_found"],
    };
  }

  const titleCol = resolveColumnIndex(ALIASES.title);
  const imagesCol = resolveColumnIndex(ALIASES.images);
  const price90dMinCol = resolveColumnIndex(ALIASES.price90dMin);
  const price90dAvgCol = resolveColumnIndex(ALIASES.price90dAvg);
  const price360dMinCol = resolveColumnIndex(ALIASES.price360dMin);
  const bsr90dAvgCol = resolveColumnIndex(ALIASES.bsr90dAvg);
  const bsrDrops90dCol = resolveColumnIndex(ALIASES.bsrDrops90d);
  const buyBoxAmazonShareCol = resolveColumnIndex(ALIASES.buyBoxAmazonSharePercent);
  const dealCount90dCol = resolveColumnIndex(ALIASES.dealCount90d);
  const currentPriceCol = resolveColumnIndex(ALIASES.currentPrice);
  const currentBsrCol = resolveColumnIndex(ALIASES.currentBsr);
  const ratingCol = resolveColumnIndex(ALIASES.rating);
  const reviewCountCol = resolveColumnIndex(ALIASES.reviewCount);

  const acceptedList: KeepaExportRow[] = [];

  for (let rowIndex = 0; rowIndex < rawDataRows.length; rowIndex++) {
    const row = rawDataRows[rowIndex];
    const asinRaw = row[asinCol];
    const asin = parseKeepaAsin(asinRaw);
    if (!asin) {
      continue; // 过滤无有效 ASIN 的行
    }

    const cellAt = (col: number | null): string | null => {
      if (col === null || col < 0 || col >= row.length) return null;
      const v = row[col];
      return v !== null && v !== undefined && String(v).trim().length > 0 ? String(v).trim() : null;
    };

    const title = cellAt(titleCol);
    const imageVal = cellAt(imagesCol);
    const images = imageVal ? [imageVal] : [];
    const currentPrice = parseKeepaNumber(cellAt(currentPriceCol));
    const currentBsr = parseKeepaNumber(cellAt(currentBsrCol));
    const rating = parseKeepaNumber(cellAt(ratingCol));
    const reviewCount = parseKeepaNumber(cellAt(reviewCountCol));

    const price90dMin = parseKeepaNumber(cellAt(price90dMinCol));
    const price90dAvg = parseKeepaNumber(cellAt(price90dAvgCol));
    const price360dMin = parseKeepaNumber(cellAt(price360dMinCol));
    const bsr90dAvg = parseKeepaNumber(cellAt(bsr90dAvgCol));
    const bsrDrops90d = parseKeepaNumber(cellAt(bsrDrops90dCol));
    const buyBoxAmazonSharePercent = parseKeepaPercent(cellAt(buyBoxAmazonShareCol));
    const dealCount90d = parseKeepaNumber(cellAt(dealCount90dCol));

    const rawRow: Record<string, string | null> = {};
    rawHeaders.forEach((h, idx) => {
      const val = row[idx];
      rawRow[h] = val !== null && val !== undefined ? String(val) : null;
    });

    acceptedList.push({
      asin,
      title,
      images,
      currentPrice,
      currentBsr,
      rating,
      reviewCount,
      metrics: {
        price90dMin,
        price90dAvg,
        price360dMin,
        bsr90dAvg,
        bsrDrops90d,
        buyBoxAmazonSharePercent,
        dealCount90d,
      },
      rawRow,
    });
  }

  return {
    ok: acceptedList.length > 0,
    format: isXlsx ? "xlsx" : "csv",
    sourceFileSha256,
    totalRows: rawDataRows.length,
    acceptedRows: acceptedList.length,
    rows: acceptedList,
    errors,
  };
}
