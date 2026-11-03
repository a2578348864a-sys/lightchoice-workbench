import { buildAccessHeaders } from "@/lib/client/accessToken";

const MAX_KEEPA_UPLOAD_BYTES = 5 * 1024 * 1024;

export type KeepaImportResult = {
  importedCount: number;
  failedCount: number;
  quarantinedCount: number;
  omittedByBudgetCount: number;
  sourceFileSha256: string;
  imported: Array<{ asin: string; subjectKey: string }>;
  failed: Array<{ asin: string; reason: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function readImportRows<T extends Record<string, unknown>>(
  value: unknown,
  isRow: (row: Record<string, unknown>) => row is T,
): T[] | null {
  if (!Array.isArray(value) || !value.every((row) => isRecord(row) && isRow(row))) return null;
  return value;
}

export async function uploadKeepaCsv(file: File, request: typeof fetch = fetch, researchScanId?: string): Promise<KeepaImportResult> {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    throw new Error("Keepa 导入仅支持从 Product Viewer 导出的 CSV 文件。");
  }
  if (file.size <= 0) throw new Error("Keepa CSV 文件为空。");
  if (file.size > MAX_KEEPA_UPLOAD_BYTES) throw new Error("Keepa CSV 文件超过 5 MB 上限，请拆分后上传。");

  const formData = new FormData();
  formData.append("file", file);
  formData.append("marketplace", "US");
  if (researchScanId) formData.append("researchScanId", researchScanId);

  const response = await request("/api/source-layer/acquire/keepa", {
    method: "POST",
    headers: buildAccessHeaders(),
    body: formData,
  });
  const payload: unknown = await response.json().catch(() => null);
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    throw new Error(typeof error?.message === "string" ? error.message : "Keepa 导入失败。");
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const imported = readImportRows(data?.imported, (row): row is { asin: string; subjectKey: string } =>
    typeof row.asin === "string" && typeof row.subjectKey === "string");
  const failed = readImportRows(data?.failed, (row): row is { asin: string; reason: string } =>
    typeof row.asin === "string" && typeof row.reason === "string");
  if (
    !data
    || !isCount(data.importedCount)
    || !isCount(data.failedCount)
    || !isCount(data.quarantinedCount)
    || !isCount(data.omittedByBudgetCount)
    || !isSha256(data.sourceFileSha256)
    || !imported
    || !failed
  ) {
    throw new Error("Keepa 导入响应不符合当前计数与行明细契约。");
  }

  return {
    importedCount: data.importedCount,
    failedCount: data.failedCount,
    quarantinedCount: data.quarantinedCount,
    omittedByBudgetCount: data.omittedByBudgetCount,
    sourceFileSha256: data.sourceFileSha256,
    imported,
    failed,
  };
}
