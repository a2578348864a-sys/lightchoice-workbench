/**
 * Amazon DOM Capture Adapter（Phase 1 预留）。
 *
 * 当前只接受调用方已经提取出的结构化页面值，不打开浏览器、不联网、不
 * 自动补字段。字段形状复用人工录入 Adapter；唯一差异是 Evidence 的来源
 * 标识为 amazon_dom、采集方式为 browser_dom。
 */
import {
  createSourceAdapter,
  registerSourceAdapter,
  type SourceAdapterCaptureResult,
  type SourceAdapterInput,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  parseAmazonDetailCaptureEvidence,
  type CaptureFieldDraft,
  type CapturePackageDraft,
  type CapturePackageExtensions,
} from "@/lib/sourceLayer/capturePackage";
import { captureManualEntry } from "@/lib/sourceLayer/adapters/manualEntryAdapter";

export const AMAZON_DOM_ADAPTER_VERSION = "amazon-dom-adapter.v1" as const;

function fieldsWithAmazonProvenance(
  fields: CapturePackageDraft["fields"],
): CapturePackageDraft["fields"] {
  return Object.fromEntries(Object.entries(fields).map(([field, candidate]) => {
    const fieldDraft = candidate as CaptureFieldDraft<unknown>;
    const unprefixedRef = fieldDraft.sourceRef.replace(/^manual_form\./, "");
    const providerEstimate = (field === "estimatedMonthlySales" || field === "estimatedMonthlyRevenueUsd")
      && fieldDraft.value !== null
      && fieldDraft.value !== undefined;
    return [field, {
      ...fieldDraft,
      valueOrigin: fieldDraft.valueOrigin === "human_manual" ? "page_measured" : fieldDraft.valueOrigin,
      ...(providerEstimate ? {
        metricNature: "estimate" as const,
        confidence: Math.min(fieldDraft.confidence ?? 1, 0.9),
      } : {}),
      sourceRef: unprefixedRef.startsWith("amazon_dom.") ? unprefixedRef : `amazon_dom.${unprefixedRef}`,
    }];
  })) as CapturePackageDraft["fields"];
}

function extensionsFromPayload(payload: unknown): CapturePackageExtensions | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const extensions: CapturePackageExtensions = {};
  if (Array.isArray(record.bulletPoints)) {
    extensions.bulletPoints = record.bulletPoints.filter((item): item is string => typeof item === "string");
  }
  if (typeof record.launchedDate === "string") extensions.launchedDate = record.launchedDate;
  if (typeof record.packageWeight === "object" && record.packageWeight !== null && !Array.isArray(record.packageWeight)) {
    const weight = record.packageWeight as Record<string, unknown>;
    if (typeof weight.value === "number" && typeof weight.unit === "string") {
      extensions.packageWeight = { value: weight.value, unit: weight.unit as "kg" | "lb" | "oz" | "g" };
    }
  }
  if (typeof record.packageDimensions === "object" && record.packageDimensions !== null && !Array.isArray(record.packageDimensions)) {
    const dimensions = record.packageDimensions as Record<string, unknown>;
    if (
      typeof dimensions.length === "number"
      && typeof dimensions.width === "number"
      && typeof dimensions.height === "number"
      && typeof dimensions.unit === "string"
    ) {
      extensions.packageDimensions = {
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        unit: dimensions.unit as "cm" | "in",
      };
    }
  }
  if (typeof record.itemWeight === "object" && record.itemWeight !== null && !Array.isArray(record.itemWeight)) {
    const weight = record.itemWeight as Record<string, unknown>;
    if (typeof weight.value === "number" && typeof weight.unit === "string") {
      extensions.itemWeight = { value: weight.value, unit: weight.unit as "kg" | "lb" | "oz" | "g" };
    }
  }
  if (typeof record.itemDimensions === "object" && record.itemDimensions !== null && !Array.isArray(record.itemDimensions)) {
    const dimensions = record.itemDimensions as Record<string, unknown>;
    if (typeof dimensions.length === "number" && typeof dimensions.width === "number"
      && typeof dimensions.height === "number" && typeof dimensions.unit === "string") {
      extensions.itemDimensions = {
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        unit: dimensions.unit as "cm" | "in",
      };
    }
  }
  const listOfText = (key: "categoryPath" | "includedComponents" | "galleryImageUrls" | "variations") => {
    const value = record[key];
    if (Array.isArray(value)) extensions[key] = value.filter((item): item is string => typeof item === "string");
  };
  listOfText("categoryPath");
  listOfText("includedComponents");
  listOfText("galleryImageUrls");
  listOfText("variations");
  for (const key of ["parentAsin", "material", "seller", "shipsFrom", "fulfillment"] as const) {
    if (typeof record[key] === "string") extensions[key] = record[key] as string;
  }
  for (const key of ["listPrice", "coupon", "buyBox"] as const) {
    if (typeof record[key] === "object" && record[key] !== null && !Array.isArray(record[key])) {
      extensions[key] = record[key] as never;
    }
  }
  if (typeof record.ratingDistribution === "object" && record.ratingDistribution !== null && !Array.isArray(record.ratingDistribution)) {
    const distribution: Record<string, number> = {};
    for (const [key, value] of Object.entries(record.ratingDistribution)) {
      if (typeof value === "number" && Number.isFinite(value)) distribution[key] = value;
    }
    extensions.ratingDistribution = distribution;
  }
  if (typeof record.boughtPastMonth === "number" && Number.isSafeInteger(record.boughtPastMonth) && record.boughtPastMonth >= 0) {
    extensions.boughtPastMonth = record.boughtPastMonth;
  } else if (typeof record.boughtPastMonth === "object" && record.boughtPastMonth !== null && !Array.isArray(record.boughtPastMonth)) {
    const estimate = record.boughtPastMonth as Record<string, unknown>;
    const validBound = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    if (typeof estimate.rawText === "string" && estimate.rawText.trim()
      && validBound(estimate.lowerBound) && validBound(estimate.upperBound)
      && ["exact", "at_least", "range", "approximate", "unknown"].includes(String(estimate.qualifier))
      && estimate.metricNature === "estimate") {
      extensions.boughtPastMonth = record.boughtPastMonth as NonNullable<CapturePackageExtensions["boughtPastMonth"]>;
    }
  }
  if (Array.isArray(record.bsrRanks)) {
    extensions.bsrRanks = record.bsrRanks.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const rank = (item as Record<string, unknown>).rank;
      const category = (item as Record<string, unknown>).category;
      return typeof rank === "number" && Number.isSafeInteger(rank) && rank > 0
        && typeof category === "string" && category.trim()
        ? [{ rank, category }]
        : [];
    }).slice(0, 40);
  }
  if (record.amazonDetail !== undefined) {
    const amazonDetail = parseAmazonDetailCaptureEvidence(record.amazonDetail);
    if (!amazonDetail) throw new Error("AMAZON_DETAIL_EVIDENCE_INVALID");
    extensions.amazonDetail = amazonDetail;
  }
  if (typeof record.sourceMethod === "string") extensions.sourceMethod = record.sourceMethod;
  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

export function captureAmazonDom(input: SourceAdapterInput): SourceAdapterCaptureResult {
  const payload = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
    ? { ...(input.payload as Record<string, unknown>) }
    : input.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    delete (payload as Record<string, unknown>).fbaFee;
    delete (payload as Record<string, unknown>).estimatedMonthlySales;
    delete (payload as Record<string, unknown>).estimatedMonthlyRevenueUsd;
  }
  const captured = captureManualEntry({ ...input, payload });
  const searchObservation = typeof input.payload === "object"
    && input.payload !== null
    && !Array.isArray(input.payload)
    && typeof (input.payload as { searchObservation?: unknown }).searchObservation === "object"
    && (input.payload as { searchObservation?: unknown }).searchObservation !== null
    ? (input.payload as { searchObservation: { appearanceKey?: unknown; sponsored?: unknown; page?: unknown; position?: unknown; query?: unknown } }).searchObservation
    : null;
  const sourceRecordRef = searchObservation && typeof searchObservation.appearanceKey === "string"
    ? searchObservation.appearanceKey.slice(0, 160)
    : null;
  const observationDigest = searchObservation
    ? `;searchObservation=${JSON.stringify({
      appearanceKey: typeof searchObservation.appearanceKey === "string" ? searchObservation.appearanceKey : null,
      sponsored: typeof searchObservation.sponsored === "boolean" ? searchObservation.sponsored : null,
      page: typeof searchObservation.page === "number" ? searchObservation.page : null,
      position: typeof searchObservation.position === "number" ? searchObservation.position : null,
      query: typeof searchObservation.query === "string" ? searchObservation.query.slice(0, 120) : null,
    })}`
    : "";
  return {
    ...captured,
    drafts: captured.drafts.map((draft) => ({
      ...draft,
      fields: fieldsWithAmazonProvenance(draft.fields),
      sourceProof: {
        ...draft.sourceProof,
        sourceType: "amazon_dom",
        sourceMethod: "amazon_dom_observed",
        captureMethod: "browser_dom",
        sourceFingerprint: input.sourceFingerprint ?? null,
        sourceRecordRef: sourceRecordRef ?? draft.sourceProof.sourceRecordRef,
      },
      replay: {
        ...draft.replay,
        pageDigest: draft.replay.pageDigest.replace(/^manual_entry/, "amazon_dom"),
        warnings: [...draft.replay.warnings, ...(observationDigest ? [observationDigest] : [])].slice(0, 20),
      },
      extensions: extensionsFromPayload(input.payload),
    })),
  };
}

export const amazonDomAdapter = createSourceAdapter({
  sourceType: "amazon_dom",
  label: "Amazon 详情页 DOM",
  adapterVersion: AMAZON_DOM_ADAPTER_VERSION,
  capture: captureAmazonDom,
});

registerSourceAdapter(amazonDomAdapter);
