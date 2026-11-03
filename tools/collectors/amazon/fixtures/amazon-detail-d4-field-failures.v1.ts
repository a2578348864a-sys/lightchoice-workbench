/**
 * Minimal offline observations transcribed from the completed D4 report.
 * No Amazon HTML is stored here. Where the report did not preserve raw candidate
 * text, tests synthesize harmless stand-ins while retaining the observed state.
 */
export type AmazonDetailD4FieldFailureObservation = {
  asin: string;
  titleConflict?: boolean;
  priceConflict?: boolean;
  /** Exact candidate strings were retained only for this reported conflict. */
  observedPriceCandidates?: readonly string[];
  dateFirstAvailablePresent?: boolean;
  itemDimensionsPresent?: boolean;
};

export const AMAZON_DETAIL_D4_FIELD_FAILURE_OBSERVATIONS: readonly AmazonDetailD4FieldFailureObservation[] = [
  {
    asin: "B097NNR535",
    titleConflict: true,
    priceConflict: true,
    observedPriceCandidates: ["$19.97", "$18.97"],
    itemDimensionsPresent: true,
  },
  { asin: "B0CPL24B5X", priceConflict: true, itemDimensionsPresent: true },
  { asin: "B08LR42YZG", priceConflict: true },
  { asin: "B01NCWV3KM", titleConflict: true, priceConflict: true },
  { asin: "B0CKZ4ZWYG", titleConflict: true, dateFirstAvailablePresent: true },
  { asin: "B0FHKRL74F", titleConflict: true },
  { asin: "B0FCXDWY28", titleConflict: true, dateFirstAvailablePresent: true },
];
