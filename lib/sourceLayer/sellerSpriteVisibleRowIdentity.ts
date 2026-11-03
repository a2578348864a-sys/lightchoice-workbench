import { createHash } from "node:crypto";
import {
  parseSellerSpriteKeywordTable,
  type SellerSpriteKeywordPage,
  type SellerSpriteTypedKeywordRow,
} from "@/lib/sourceLayer/sellerSpriteKeywordTable";

export type SellerSpriteVisibleTable = {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
};

export type SellerSpriteVisibleRowIdentity = {
  readonly rowKeys: readonly string[];
  readonly structuredValidRowKeys: readonly string[];
  readonly capturedUniqueRows: number;
  readonly structuredValidRows: number;
};

export type SellerSpriteVisibleKeywordRow = {
  readonly rowKey: string;
  readonly tableIndex: number;
  readonly rowIndex: number;
  readonly headers: readonly string[];
  readonly rawCells: readonly (string | null)[];
  readonly typedRow: SellerSpriteTypedKeywordRow;
};

export type SellerSpriteVisibleKeywordRows = {
  readonly rows: readonly SellerSpriteVisibleKeywordRow[];
  readonly actualVisibleRows: number;
  readonly rejectedRows: number;
  readonly duplicatesRejected: number;
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function productMarketRows(tables: readonly SellerSpriteVisibleTable[]): SellerSpriteVisibleRowIdentity {
  const asins = new Set<string>();
  for (const table of tables) {
    const asinColumns = table.headers.flatMap((header, index) =>
      ["asin", "asin码", "产品asin"].includes(normalized(header)) ? [index] : []);
    if (asinColumns.length !== 1) continue;
    for (const row of table.rows) {
      const asin = row[asinColumns[0]]?.normalize("NFKC").trim().toUpperCase() ?? "";
      if (/^[A-Z0-9]{10}$/u.test(asin)) asins.add(asin);
    }
  }
  const keys = [...asins].map((asin) => "asin:" + createHash("sha256").update(asin).digest("hex"));
  return { rowKeys: keys, structuredValidRowKeys: keys, capturedUniqueRows: keys.length, structuredValidRows: keys.length };
}

export function identifySellerSpriteVisibleRows(
  module: SellerSpriteKeywordPage | "sellersprite_product_market",
  tables: readonly SellerSpriteVisibleTable[],
): SellerSpriteVisibleRowIdentity {
  if (module === "sellersprite_product_market") return productMarketRows(tables);
  const rowKeys = new Set<string>();
  const structuredValidRowKeys = new Set<string>();
  for (const table of tables) {
    const parsed = parseSellerSpriteKeywordTable({ page: module, table: { headers: table.headers, rows: table.rows } });
    for (const row of parsed.rows) {
      rowKeys.add(row.rowKey);
      if (row.status === "valid") structuredValidRowKeys.add(row.rowKey);
    }
  }
  const keys = [...rowKeys];
  const validKeys = [...structuredValidRowKeys];
  return { rowKeys: keys, structuredValidRowKeys: validKeys, capturedUniqueRows: keys.length, structuredValidRows: validKeys.length };
}

/**
 * Returns row-level source bindings for each logical visible table window. Identity is
 * query-scoped (the job fingerprint supplies the query) and remains stable when
 * provider estimate cells change between virtual-list windows or retries.
 */
export function identifySellerSpriteVisibleKeywordRows(
  module: SellerSpriteKeywordPage,
  tables: readonly SellerSpriteVisibleTable[],
): SellerSpriteVisibleKeywordRows {
  const rows: SellerSpriteVisibleKeywordRow[] = [];
  const seen = new Set<string>();
  let actualVisibleRows = 0;
  let rejectedRows = 0;
  let duplicatesRejected = 0;
  tables.forEach((table, tableIndex) => {
    actualVisibleRows += table.rows.length;
    const parsed = parseSellerSpriteKeywordTable({ page: module, table });
    rejectedRows += parsed.rejectedRowCount;
    duplicatesRejected += parsed.duplicateRowCount;
    for (const typedRow of parsed.rows) {
      if (seen.has(typedRow.rowKey)) {
        duplicatesRejected += 1;
        continue;
      }
      seen.add(typedRow.rowKey);
      const sourceRowIndex = typedRow.sourceRowIndex;
      if (!Number.isSafeInteger(sourceRowIndex) || sourceRowIndex === undefined) {
        rejectedRows += 1;
        continue;
      }
      const rawCells = table.rows[sourceRowIndex];
      if (!rawCells) {
        rejectedRows += 1;
        continue;
      }
      rows.push({
        rowKey: typedRow.rowKey,
        tableIndex,
        rowIndex: sourceRowIndex,
        headers: table.headers,
        rawCells,
        typedRow,
      });
    }
  });
  return { rows, actualVisibleRows, rejectedRows, duplicatesRejected };
}
