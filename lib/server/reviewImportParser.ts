/**
 * V5 Capture Coverage Expansion — G3-A: 离线评论导表解析器
 *
 * 纯解析工具函数：支持 CSV / XLSX 离线导表（卖家精灵、H10 或通用导出格式）解析为 ReviewImportInput[]。
 *
 * 铁律约束：
 * - 纯解析工具，零网络请求、不自动翻页爬取 Amazon、不调用外部 API、不绕过 Amazon 风控；
 * - 字段防御性清洗：去除空白、reviewText 上限 2000 字符、严格校验 10 位 ASIN；
 * - 纯数据产出，直接适配既有 importReviews() 流程，写入 EvidenceStore (kind="review_evidence")。
 */

import { parseXlsxWorkbook } from "@/lib/upstream/sellersprite/xlsx";
import type { ReviewImportInput, ReviewSourceProductRole } from "@/lib/server/reviewEvidence";

export const REVIEW_IMPORT_PARSER_VERSION = "review-import-parser.v1" as const;
export const MAX_REVIEW_TEXT_LENGTH = 2000;
export const MAX_REVIEW_TITLE_LENGTH = 200;

export type ReviewImportParserOptions = {
  /** 如果导表行中没有 ASIN 字段或为空，使用的兜底 ASIN */
  defaultAsin?: string | null;
  /** 候选商品角色，默认为 "current_candidate" */
  sourceProductRole?: ReviewSourceProductRole;
  /** 导入条数上限（默认 100） */
  maxReviews?: number;
};

export type ReviewImportParseResult = {
  ok: boolean;
  reviews: ReviewImportInput[];
  rejectedCount: number;
  reasons: Array<{ rowNumber: number; reason: string }>;
  stats: {
    totalRows: number;
    validReviews: number;
    skippedEmpty: number;
    invalidAsin: number;
    truncatedReviews: number;
  };
};

/* ── 表头别名字典 ─────────────────────────────────────────── */

const HEADER_ALIASES: Record<string, string[]> = {
  asin: [
    "asin",
    "asin码",
    "商品asin",
    "product asin",
    "parent asin",
    "child asin",
    "子asin",
    "父asin",
  ],
  reviewText: [
    "reviewtext",
    "review_text",
    "review text",
    "reviewcontent",
    "review_content",
    "content",
    "评论内容",
    "评论正文",
    "正文",
    "review body",
    "review_body",
    "body",
    "comment",
    "评论",
  ],
  rating: [
    "rating",
    "star rating",
    "star_rating",
    "stars",
    "星级",
    "评分",
    "review_rating",
    "star",
  ],
  reviewTitle: [
    "reviewtitle",
    "review_title",
    "review title",
    "title",
    "评论标题",
    "标题",
    "headline",
  ],
  reviewDate: [
    "reviewdate",
    "review_date",
    "review date",
    "date",
    "评论日期",
    "日期",
    "reviewed at",
    "review time",
  ],
  verifiedPurchase: [
    "verifiedpurchase",
    "verified_purchase",
    "verified purchase",
    "vp",
    "是否vp",
    "购买认证",
    "is_vp",
    "verified",
  ],
  reviewId: [
    "reviewid",
    "review_id",
    "review id",
    "id",
    "评论id",
  ],
};

function normalizeHeaderName(header: string): string {
  return header.replace(/[\uFEFF]/g, "").trim().toLowerCase();
}

function resolveCanonicalField(header: string): string | null {
  const normalized = normalizeHeaderName(header);
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) {
      return canonical;
    }
  }
  return null;
}

function isValidAsin(val: string): boolean {
  return /^[A-Z0-9]{10}$/.test(val.trim());
}

function parseRating(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/([0-9](?:\.[0-9])?)/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  return rounded >= 1 && rounded <= 5 ? rounded : null;
}

function parseVerifiedPurchase(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const s = value.trim().toLowerCase();
  if (["true", "yes", "1", "是", "vp", "verified", "verified purchase"].includes(s)) return true;
  if (["false", "no", "0", "否"].includes(s)) return false;
  return null;
}

/* ── CSV 状态机解析器（遵循 RFC 4180） ───────────────────────── */

export function parseCsvRows(csvText: string): string[][] {
  const cleanText = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    const nextChar = cleanText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++; // 跳过转义的双引号
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\r") {
        if (nextChar === "\n") {
          i++;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else if (char === "\n") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/* ── 核心导表解析入口 ────────────────────────────────────────── */

/**
 * 解析 CSV / XLSX 评论导出内容为 ReviewImportInput[]
 */
export function parseReviewImportContent(
  content: string | Buffer | Uint8Array,
  options?: ReviewImportParserOptions,
): ReviewImportParseResult {
  const defaultAsin = options?.defaultAsin?.trim().toUpperCase() ?? null;
  const sourceProductRole = options?.sourceProductRole ?? "current_candidate";
  const maxReviews = options?.maxReviews ?? 100;

  let rawTable: string[][] = [];

  // 判断是否为 XLSX 二进制包（PK Zip 标头：0x50, 0x4B, 0x03, 0x04）
  const isZip =
    (Buffer.isBuffer(content) || content instanceof Uint8Array) &&
    content.length >= 4 &&
    content[0] === 0x50 &&
    content[1] === 0x4b &&
    content[2] === 0x03 &&
    content[3] === 0x04;

  if (isZip) {
    const workbook = parseXlsxWorkbook(Buffer.from(content));
    const sheet = workbook.sheets[0];
    if (sheet) {
      rawTable = sheet.rows.map((r) => r.values.map((v) => v ?? ""));
    }
  } else {
    const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    rawTable = parseCsvRows(text);
  }

  const result: ReviewImportParseResult = {
    ok: true,
    reviews: [],
    rejectedCount: 0,
    reasons: [],
    stats: {
      totalRows: 0,
      validReviews: 0,
      skippedEmpty: 0,
      invalidAsin: 0,
      truncatedReviews: 0,
    },
  };

  if (rawTable.length === 0) {
    return result;
  }

  // 首行为表头
  const headers = rawTable[0].map(normalizeHeaderName);
  const columnMap = new Map<string, number>();
  headers.forEach((h, index) => {
    const canonical = resolveCanonicalField(h);
    if (canonical && !columnMap.has(canonical)) {
      columnMap.set(canonical, index);
    }
  });

  const textCol = columnMap.get("reviewText");
  // 若未匹配到标准 reviewText 表头，但只有一列且内容非空，则默认第 0 列为正文
  const fallbackTextCol = textCol === undefined && headers.length === 1 ? 0 : textCol;

  const dataRows = rawTable.slice(1);
  result.stats.totalRows = dataRows.length;

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    if (result.reviews.length >= maxReviews) break;
    const rowNumber = rowIndex + 2; // 1-indexed (第1行为表头)
    const row = dataRows[rowIndex];

    // 全空行跳过
    if (row.every((cell) => !cell || !cell.trim())) {
      result.stats.skippedEmpty++;
      continue;
    }

    const rawText = fallbackTextCol !== undefined ? (row[fallbackTextCol] ?? "").trim() : "";
    if (!rawText) {
      result.stats.skippedEmpty++;
      result.rejectedCount++;
      result.reasons.push({ rowNumber, reason: "EMPTY_REVIEW_TEXT" });
      continue;
    }

    // 处理正文截断
    let reviewText = rawText;
    if (reviewText.length > MAX_REVIEW_TEXT_LENGTH) {
      reviewText = reviewText.slice(0, MAX_REVIEW_TEXT_LENGTH);
      result.stats.truncatedReviews++;
    }

    // 解析 ASIN
    const asinCol = columnMap.get("asin");
    let rowAsin = asinCol !== undefined ? (row[asinCol] ?? "").trim().toUpperCase() : "";
    if (!isValidAsin(rowAsin)) {
      if (defaultAsin && isValidAsin(defaultAsin)) {
        rowAsin = defaultAsin;
      } else {
        result.stats.invalidAsin++;
        result.rejectedCount++;
        result.reasons.push({ rowNumber, reason: "INVALID_ASIN" });
        continue;
      }
    }

    // 解析其他字段
    const ratingCol = columnMap.get("rating");
    const rating = ratingCol !== undefined ? parseRating(row[ratingCol]) : null;

    const titleCol = columnMap.get("reviewTitle");
    let reviewTitle: string | null = titleCol !== undefined ? (row[titleCol] ?? "").trim() : null;
    if (reviewTitle && reviewTitle.length > MAX_REVIEW_TITLE_LENGTH) {
      reviewTitle = reviewTitle.slice(0, MAX_REVIEW_TITLE_LENGTH);
    }
    if (!reviewTitle) reviewTitle = null;

    const dateCol = columnMap.get("reviewDate");
    const reviewDate = dateCol !== undefined && row[dateCol]?.trim() ? row[dateCol].trim() : null;

    const vpCol = columnMap.get("verifiedPurchase");
    const verifiedPurchase = vpCol !== undefined ? parseVerifiedPurchase(row[vpCol]) : null;

    const idCol = columnMap.get("reviewId");
    const reviewId = idCol !== undefined && row[idCol]?.trim() ? row[idCol].trim() : null;

    const reviewItem: ReviewImportInput = {
      asin: rowAsin,
      sourceProductRole,
      reviewText,
      rating,
      reviewTitle,
      reviewDate,
      verifiedPurchase,
      reviewId,
      sourceType: "manual_import",
      bindingKind: "manual_confirmed",
    };

    result.reviews.push(reviewItem);
    result.stats.validReviews++;
  }

  result.ok = result.reviews.length > 0;
  return result;
}
