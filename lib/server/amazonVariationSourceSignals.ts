import type { RawVariationPage } from "@/tools/collectors/amazon/variation-page-extract";
import { MAX_V3_MODULE_DATA_BYTES } from "@/lib/sourceLayer/v3ModuleEvidence";

const MAX_VARIATION_SOURCE_SIGNALS_BYTES = 64 * 1024;

export type AmazonVariationSourceSignals = Pick<RawVariationPage,
  | "parentAsin"
  | "dimensionToAsinMap"
  | "dimensionValuesDisplayData"
  | "variationDisplayLabels"
  // 页面自己声明的权威维度顺序与值表（twisterJSInitData）。
  // 缺了它们，DOM 无属性组时无法还原 ASIN→维度名→维度值，只能停留在 CAPTURED_PARTIAL。
  | "dimensions"
  | "variationValues"
  | "dimensionOrderSource"
  | "domGroups"
  | "variationRootFound"
  | "explicitNoVariation"
  | "jsonStateFound"
  | "jsonStateDiagnostics"
>;

export type AmazonVariationSourceSignalsStatus = "retained" | "omitted_size_limit" | "unavailable";

export function withAmazonVariationSourceSignals(
  data: Record<string, unknown>,
  raw: RawVariationPage | AmazonVariationSourceSignals | null | undefined,
) {
  if (!raw) {
    const unavailableData = { ...data, rawVariationSignalsStatus: "unavailable" };
    return {
      data: Buffer.byteLength(JSON.stringify(unavailableData), "utf8") <= MAX_V3_MODULE_DATA_BYTES
        ? unavailableData
        : data,
      sourceSignals: null as AmazonVariationSourceSignals | null,
      status: "unavailable" as const,
    };
  }

  const sourceSignals: AmazonVariationSourceSignals = {
    parentAsin: raw.parentAsin,
    dimensionToAsinMap: raw.dimensionToAsinMap,
    dimensionValuesDisplayData: raw.dimensionValuesDisplayData,
    variationDisplayLabels: raw.variationDisplayLabels,
    dimensions: raw.dimensions,
    variationValues: raw.variationValues,
    dimensionOrderSource: raw.dimensionOrderSource,
    domGroups: raw.domGroups,
    variationRootFound: raw.variationRootFound,
    explicitNoVariation: raw.explicitNoVariation,
    jsonStateFound: raw.jsonStateFound,
    jsonStateDiagnostics: raw.jsonStateDiagnostics,
  };
  const sourceBytes = Buffer.byteLength(JSON.stringify(sourceSignals), "utf8");
  const retainedData = { ...data, rawVariationSignals: sourceSignals, rawVariationSignalsStatus: "retained" };
  if (sourceBytes <= MAX_VARIATION_SOURCE_SIGNALS_BYTES
    && Buffer.byteLength(JSON.stringify(retainedData), "utf8") <= MAX_V3_MODULE_DATA_BYTES) {
    return { data: retainedData, sourceSignals, status: "retained" as const };
  }

  const omittedData = { ...data, rawVariationSignalsStatus: "omitted_size_limit" };
  return Buffer.byteLength(JSON.stringify(omittedData), "utf8") <= MAX_V3_MODULE_DATA_BYTES
    ? { data: omittedData, sourceSignals: null as AmazonVariationSourceSignals | null, status: "omitted_size_limit" as const }
    : { data, sourceSignals: null as AmazonVariationSourceSignals | null, status: "omitted_size_limit" as const };
}
