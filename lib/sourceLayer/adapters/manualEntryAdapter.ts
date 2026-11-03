/**
 * Product Source Layer V1.2 — 人工录入 Adapter（manual_entry）
 *
 * 定位：当用户手上有一条明确的商品链接与观测值，但没有任何导出文件时，
 * 允许以「人工录入」来源建立采集包。人工录入是可信来源（可产出 confirmed），
 * 但必须显式声明操作者与来源 URL，禁止伪装成自动来源。
 *
 * 纯模块：无网络 / 无 DB / 无随机。
 */
import { createHash } from "node:crypto";

import {
  createSourceAdapter,
  registerSourceAdapter,
  type SourceAdapterCaptureResult,
  type SourceAdapterInput,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  defaultCaptureMethodFor,
  type CapturePackageDraft,
} from "@/lib/sourceLayer/capturePackage";

export const MANUAL_ADAPTER_VERSION = "manual-entry-adapter.v1" as const;

export type ManualEntryPayload = {
  asin?: unknown;
  title?: unknown;
  brand?: unknown;
  productUrl?: unknown;
  images?: unknown;
  price?: unknown;
  currency?: unknown;
  rating?: unknown;
  reviewCount?: unknown;
  bsrRank?: unknown;
  bsrCategory?: unknown;
  subCategoryBsr?: unknown;
  estimatedMonthlySales?: unknown;
  estimatedMonthlyRevenueUsd?: unknown;
  keywords?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asText(item)).filter((item): item is string => item !== null);
  }
  const single = asText(value);
  return single ? [single] : [];
}

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const PLACEHOLDER_TITLE = /^(?:-|--|n\/a|na|null|none|unknown|未知|暂无|无)$/i;

export function captureManualEntry(input: SourceAdapterInput): SourceAdapterCaptureResult {
  if (!isRecord(input.payload)) {
    return {
      drafts: [],
      errorCodes: ["SELECTOR_FAILED"],
      quarantinedCount: 0,
      pageDigest: "payload_not_object",
    };
  }
  const payload = input.payload as ManualEntryPayload;
  const rawAsin = asText(payload.asin)?.toUpperCase() ?? null;
  const asin = rawAsin && ASIN_PATTERN.test(rawAsin) ? rawAsin : null;
  const rawTitle = asText(payload.title);
  const title = rawTitle && !PLACEHOLDER_TITLE.test(rawTitle) ? rawTitle : null;
  // fail-closed：没有可用身份就不产出采集包。
  // 非法 ASIN 不会退回匿名主体——那会让不同商品共用一个主体并污染版本历史。
  if (!asin && !title) {
    return {
      drafts: [],
      errorCodes: ["FIELD_MISSING"],
      quarantinedCount: 1,
      pageDigest: "missing_identity",
    };
  }
  const productUrl = asText(payload.productUrl);
  const images = asStringList(payload.images);
  const brand = asText(payload.brand);
  const price = asNumber(payload.price);
  const currency = (asText(payload.currency) ?? "USD").toUpperCase();
  const rating = asNumber(payload.rating);
  const reviewCount = asNumber(payload.reviewCount);
  const bsrRank = asNumber(payload.bsrRank);
  const bsrCategory = asText(payload.bsrCategory);
  const subCategoryBsr = asNumber(payload.subCategoryBsr);
  const estimatedMonthlySales = asNumber(payload.estimatedMonthlySales);
  const estimatedMonthlyRevenueUsd = asNumber(payload.estimatedMonthlyRevenueUsd);
  const keywords = asStringList(payload.keywords);

  const subjectKey = asin
    ? `amazon:US:${asin}`
    // 无可用 ASIN 时用标题指纹作为主体键：确定性、路径安全，且不会让不同商品共享主体。
    : `manual:${createHash("sha256").update(title ?? "").digest("hex").slice(0, 24)}`;
  const manual = "human_manual" as const;
  const field = <T,>(value: T, sourceRef: string, metricNature: "snapshot" | "estimate" = "snapshot") => ({
    value,
    valueOrigin: manual,
    sourceRef,
    metricNature,
    confidence: metricNature === "estimate" ? 0.8 : 1,
  });

  const draft: CapturePackageDraft = {
    subjectKey,
    marketplace: "US",
    fields: {
      asin: field(asin, "manual_form.asin"),
      title: field(title, "manual_form.title"),
      brand: field(brand, "manual_form.brand"),
      images: field(images, "manual_form.images"),
      price: field(
        price === null ? null : { amount: price, currency },
        "manual_form.price",
      ),
      rating: field(rating, "manual_form.rating"),
      reviewCount: field(
        reviewCount === null ? null : Math.round(reviewCount),
        "manual_form.reviewCount",
      ),
      bsr: field(
        bsrRank === null ? null : { rank: Math.round(bsrRank), category: bsrCategory },
        "manual_form.bsrRank",
      ),
      subCategoryBsr: field(
        subCategoryBsr === null ? null : Math.round(subCategoryBsr),
        "manual_form.subCategoryBsr",
      ),
      estimatedMonthlySales: field(
        estimatedMonthlySales === null ? null : Math.round(estimatedMonthlySales),
        "manual_form.estimatedMonthlySales",
        "estimate",
      ),
      estimatedMonthlyRevenueUsd: field(
        estimatedMonthlyRevenueUsd,
        "manual_form.estimatedMonthlyRevenueUsd",
        "estimate",
      ),
      keywords: field(keywords, "manual_form.keywords"),
    },
    sourceProof: {
      sourceType: "manual_entry",
      sourceMethod: "manual",
      sourceUrl: productUrl,
      capturedAt: input.capturedAt,
      captureMethod: defaultCaptureMethodFor("manual_entry"),
      operator: input.operator,
      // 人工录入不得携带文件指纹（Validator 会以 SOURCE_UNTRUSTED 拦下伪装的来源）。
      sourceFingerprint: null,
      sourceRecordRef: null,
    },
    replay: {
      url: productUrl,
      capturedAt: input.capturedAt,
      pageDigest: `manual_entry;asin=${asin ?? "none"};images=${images.length}`,
      warnings: [],
    },
  };

  return {
    drafts: [draft],
    errorCodes: [],
    quarantinedCount: 0,
    pageDigest: draft.replay.pageDigest,
  };
}

export const manualEntryAdapter = createSourceAdapter({
  sourceType: "manual_entry",
  label: "人工录入",
  adapterVersion: MANUAL_ADAPTER_VERSION,
  capture: captureManualEntry,
});

registerSourceAdapter(manualEntryAdapter);
