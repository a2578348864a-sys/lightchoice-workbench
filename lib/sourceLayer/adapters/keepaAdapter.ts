/**
 * Product Source Layer V5.1 — Keepa Adapter
 *
 * 核心原则：
 * - 纯模块：不发起任何网络请求，不调用 Keepa API，不自动登录，不触碰反爬。
 * - 仅解析用户通过 Keepa Product Viewer 合法导出的 CSV/XLSX 文件。
 * - 提取 90/360 天破位价、均价、BSR 波动、Amazon 自营占有率与 Deal 频次。
 * - 字段性质显式声明为 snapshot（Keepa 记录的历史真实数据）或 estimate，绝不脑补。
 */
import {
  createSourceAdapter,
  registerSourceAdapter,
  type SourceAdapterCaptureResult,
  type SourceAdapterInput,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  defaultCaptureMethodFor,
  type CaptureFieldDraft,
  type CapturePackageDraft,
} from "@/lib/sourceLayer/capturePackage";
import {
  parseKeepaExport,
  type KeepaTimeSeriesMetrics,
} from "@/lib/upstream/keepa/keepaExportParser";
import {
  buildSourceEvidenceAttachment,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";

export const KEEPA_ADAPTER_VERSION = "keepa-adapter.v1" as const;
export const KEEPA_MARKETPLACE = "US" as const;

export function captureKeepaExport(input: SourceAdapterInput): SourceAdapterCaptureResult {
  const errorCodes: SourceAdapterCaptureResult["errorCodes"] = [];

  let payload = input.payload;
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
    return {
      drafts: [],
      errorCodes: ["SELECTOR_FAILED"],
      quarantinedCount: 0,
      pageDigest: "payload_not_csv_or_xlsx",
    };
  }

  const parsed = parseKeepaExport(payload as Uint8Array | string);
  if (!parsed.ok || parsed.rows.length === 0) {
    return {
      drafts: [],
      errorCodes: ["DOM_CHANGED"],
      quarantinedCount: parsed.totalRows,
      pageDigest: `keepa_export_failed;errors=${parsed.errors.join(",")}`,
    };
  }

  const providerExport = "provider_export" as const;
  const drafts: CapturePackageDraft[] = [];

  for (const row of parsed.rows) {
    const field = <T>(
      value: T,
      sourceRef: string,
      metricNature: "snapshot" | "estimate" = "snapshot",
    ): CaptureFieldDraft<T> => ({
      value,
      valueOrigin: providerExport,
      metricNature,
      sourceRef: `keepa.export.${sourceRef}`,
      confidence: 1,
    });

    const m = row.metrics;
    const timeSeriesMetrics: KeepaTimeSeriesMetrics = {
      price90dMin: m.price90dMin,
      price90dAvg: m.price90dAvg,
      price360dMin: m.price360dMin,
      bsr90dAvg: m.bsr90dAvg,
      bsrDrops90d: m.bsrDrops90d,
      buyBoxAmazonSharePercent: m.buyBoxAmazonSharePercent,
      dealCount90d: m.dealCount90d,
    };

    const extensionMetadata = (fieldKey: string) => ({
      metricNature: "snapshot" as const,
      valueOrigin: providerExport,
      confidence: 1,
      sourceRef: `keepa.export.${fieldKey}`,
    });

    drafts.push({
      subjectKey: `amazon:${KEEPA_MARKETPLACE}:${row.asin}`,
      marketplace: KEEPA_MARKETPLACE,
      fields: {
        asin: field(row.asin, "asin"),
        title: field(row.title, "title"),
        brand: field(null, "brand"),
        images: field([...row.images], "images"),
        price: field(
          row.currentPrice === null ? null : { amount: row.currentPrice, currency: "USD" },
          "price",
        ),
        rating: field(row.rating, "rating"),
        reviewCount: field(row.reviewCount === null ? null : Math.round(row.reviewCount), "reviewCount"),
        bsr: field(
          row.currentBsr === null ? null : { rank: row.currentBsr, category: null },
          "bsr",
        ),
        subCategoryBsr: field(null, "subCategoryBsr"),
        estimatedMonthlySales: field(null, "estimatedMonthlySales"),
        estimatedMonthlyRevenueUsd: field(null, "estimatedMonthlyRevenueUsd"),
        keywords: field([], "keywords"),
      },
      extensions: {
        timeSeriesMetrics,
        fieldMetadata: {
          price90dMin: extensionMetadata("price90dMin"),
          price90dAvg: extensionMetadata("price90dAvg"),
          price360dMin: extensionMetadata("price360dMin"),
          bsr90dAvg: extensionMetadata("bsr90dAvg"),
          bsrDrops90d: extensionMetadata("bsrDrops90d"),
          buyBoxAmazonSharePercent: extensionMetadata("buyBoxAmazonSharePercent"),
          dealCount90d: extensionMetadata("dealCount90d"),
        },
        keepaRaw: {
          schemaVersion: "keepa-export-raw.v1",
          sourceFileSha256: parsed.sourceFileSha256,
          rows: [row.rawRow],
        },
      },
      sourceProof: {
        sourceType: "keepa_export",
        sourceMethod: "keepa_official_export",
        sourceUrl: input.sourceUrl ?? `https://www.amazon.com/dp/${row.asin}`,
        capturedAt: input.capturedAt,
        captureMethod: defaultCaptureMethodFor("keepa_export"),
        operator: input.operator,
        sourceFingerprint: input.sourceFingerprint ?? parsed.sourceFileSha256,
        sourceRecordRef: `asin=${row.asin}`,
      },
      replay: {
        url: input.sourceUrl ?? `https://www.amazon.com/dp/${row.asin}`,
        capturedAt: input.capturedAt,
        pageDigest: `keepa_export;accepted=${parsed.acceptedRows};total=${parsed.totalRows};format=${parsed.format}`,
        warnings: [],
      },
    });
  }

  return {
    drafts,
    errorCodes,
    quarantinedCount: parsed.totalRows - parsed.acceptedRows,
    pageDigest: `keepa_export;accepted=${parsed.acceptedRows};total=${parsed.totalRows};format=${parsed.format}`,
  };
}

export function buildKeepaTimeseriesAttachment(input: {
  subjectKey: string;
  asin: string;
  metrics: KeepaTimeSeriesMetrics;
  capturedAt: string;
  sourceUrl?: string | null;
  sourceFingerprint?: string | null;
  rawRow?: Record<string, string | null>;
}): SourceEvidenceAttachment {
  const attachmentId = `keepa_ts_${input.asin}_${input.capturedAt.replace(/[^a-zA-Z0-9]/g, "")}`;
  return buildSourceEvidenceAttachment({
    attachmentId,
    subjectKey: input.subjectKey,
    kind: "keepa_timeseries_v1",
    sourceType: "keepa_export",
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl ?? null,
    sourceFingerprint: input.sourceFingerprint ?? null,
    payload: {
      schema: "keepa-timeseries-attachment.v1",
      asin: input.asin,
      metrics: input.metrics,
      rawRow: input.rawRow ?? {},
    },
  });
}

export const keepaAdapter = createSourceAdapter({
  sourceType: "keepa_export",
  label: "Keepa 官方导表",
  adapterVersion: KEEPA_ADAPTER_VERSION,
  capture: captureKeepaExport,
});

registerSourceAdapter(keepaAdapter);
