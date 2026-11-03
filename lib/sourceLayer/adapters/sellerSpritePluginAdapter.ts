/**
 * SellerSprite Browser Plugin Capture Adapter。
 *
 * 插件行在 API 路由中已经经过白名单、类型、边界、HMAC/Preview Token 与
 * Confirm 校验；本 Adapter 仍只接受服务端重建的 SellerSpriteImportRow，
 * 把它们转换成旧 CapturePackage 草稿，再由统一 Validator/EvidenceStore
 * 继续处理。这里不创建 Candidate，也不调用任何外部服务。
 */
import {
  createSourceAdapter,
  registerSourceAdapter,
  type SourceAdapterCaptureResult,
  type SourceAdapterInput,
} from "@/lib/sourceLayer/sourceAdapter";
import type { CapturePackageDraft } from "@/lib/sourceLayer/capturePackage";
import type { SellerSpriteImportRow } from "@/lib/server/sellerSpriteImportContract";
import { contentHashOf } from "@/lib/sourceLayer/sourceAdapter";

export const SELLERSPRITE_PLUGIN_ADAPTER_VERSION = "sellersprite-plugin-adapter.v1" as const;
export const SELLERSPRITE_PLUGIN_SOURCE_TYPE = "sellersprite_plugin" as const;

type PluginPayload = SellerSpriteImportRow[] | { rows?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(payload: unknown): SellerSpriteImportRow[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.rows)
      ? payload.rows
      : null;
  if (!rows) return [];
  return rows.filter((row): row is SellerSpriteImportRow => {
    if (!isRecord(row)) return false;
    return typeof row.asin === "string"
      && typeof row.title === "string"
      && typeof row.amazonUrl === "string"
      && typeof row.rowHash === "string";
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imageList(row: SellerSpriteImportRow): string[] {
  return typeof row.imageUrl === "string" && row.imageUrl.trim()
    ? [row.imageUrl.trim()]
    : [];
}

export function captureSellerSpritePlugin(
  input: SourceAdapterInput,
): SourceAdapterCaptureResult {
  const rows = rowsOf(input.payload as PluginPayload);
  if (rows.length === 0) {
    return {
      drafts: [],
      errorCodes: ["FIELD_MISSING"],
      quarantinedCount: 0,
      pageDigest: "sellersprite_plugin;no_rows",
    };
  }

  const drafts: CapturePackageDraft[] = rows.map((row) => {
    const plugin = row.pluginCapture;
    const sourceRef = (field: string) => `sellersprite.plugin.${field}`;
    const providerExport = "provider_export" as const;
    const field = <T,>(
      value: T,
      name: string,
      metricNature: "snapshot" | "estimate" | "derived" | "unknown" = "snapshot",
    ) => ({
      value,
      valueOrigin: providerExport,
      metricNature,
      sourceRef: sourceRef(name),
      // 插件同时承载第三方估算指标；0.9 保留来源值但避免伪装为 confirmed。
      confidence: 0.9,
    });
    const bsr = numberOrNull(plugin?.bsr);
    const subCategoryBsr = numberOrNull(plugin?.subCategoryBsr ?? row.subCategoryBsr);

    return {
      subjectKey: `amazon:US:${row.asin}`,
      marketplace: "US",
      fields: {
        asin: field(row.asin, "asin"),
        title: field(row.title, "title"),
        brand: field(row.brand, "brand"),
        images: field(imageList(row), "imageUrl"),
        price: field(
          row.priceUsd === null ? null : { amount: row.priceUsd, currency: "USD" },
          "priceUsd",
        ),
        rating: field(row.rating, "rating"),
        reviewCount: field(
          row.reviewCount === null ? null : Math.round(row.reviewCount),
          "reviewCount",
        ),
        bsr: field(
          bsr === null ? null : { rank: Math.round(bsr), category: row.category },
          "bsr",
        ),
        subCategoryBsr: field(
          subCategoryBsr === null ? null : Math.round(subCategoryBsr),
          "subCategoryBsr",
        ),
        estimatedMonthlySales: field(
          row.estimatedMonthlySales === null ? null : Math.round(row.estimatedMonthlySales),
          "estimatedMonthlySales",
          "estimate",
        ),
        estimatedMonthlyRevenueUsd: field(row.estimatedMonthlyRevenueUsd, "estimatedMonthlyRevenueUsd", "estimate"),
        keywords: field([], "keywords"),
      },
      sourceProof: {
        sourceType: SELLERSPRITE_PLUGIN_SOURCE_TYPE,
        // 插件入口承载的是用户在 SellerSprite 官方页面看到并导出的
        // 页面表格语境；它与官方 XLSX 文件入口必须保持可审计区分。
        sourceMethod: row.sourceMethod ?? "sellersprite_page_manual_tsv",
        sourceUrl: row.amazonUrl,
        capturedAt: input.capturedAt,
        captureMethod: "browser_dom",
        operator: input.operator,
        sourceFingerprint: input.sourceFingerprint ?? null,
        sourceRecordRef: row.rowHash,
      },
      replay: {
        url: row.amazonUrl,
        capturedAt: input.capturedAt,
        pageDigest: `sellersprite_plugin;rowHash=${row.rowHash};payload=${contentHashOf(row).slice(0, 16)}`,
        warnings: [],
      },
    };
  });

  return {
    drafts,
    errorCodes: [],
    quarantinedCount: 0,
    pageDigest: `sellersprite_plugin;rows=${drafts.length};payload=${contentHashOf(rows).slice(0, 16)}`,
  };
}

export const sellerSpritePluginAdapter = createSourceAdapter({
  sourceType: SELLERSPRITE_PLUGIN_SOURCE_TYPE,
  label: "SellerSprite 浏览器插件",
  adapterVersion: SELLERSPRITE_PLUGIN_ADAPTER_VERSION,
  capture: captureSellerSpritePlugin,
});

registerSourceAdapter(sellerSpritePluginAdapter);
