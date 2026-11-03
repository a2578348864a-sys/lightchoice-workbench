import type { SourceEvidenceAttachment, SourceEvidenceAttachmentKind } from "@/lib/sourceLayer/evidenceAttachment";

const SUBJECT_KEY = "amazon:US:B07G4VTV2F";
const CAPTURED_AT = "2026-09-26T08:20:00.000Z";

type FixtureModule = "review_voc" | "reverse_asin" | "keyword_mining_trend" | "historical_trend";
type FixtureMetricNature = "source_observed" | "provider_observed" | "provider_estimate";
type FixtureStatus = "VALIDATED_AVAILABLE" | "BLOCKED_WITH_EVIDENCE";

function fixtureAttachment(input: {
  id: string;
  kind: SourceEvidenceAttachmentKind;
  module: FixtureModule;
  data: Record<string, unknown>;
  status?: FixtureStatus;
  metricNature?: FixtureMetricNature;
}): SourceEvidenceAttachment {
  const status = input.status ?? "VALIDATED_AVAILABLE";
  return {
    schemaVersion: "source-evidence-attachment.v1",
    attachmentId: `fixture-${input.id}`,
    subjectKey: SUBJECT_KEY,
    sourceType: input.module === "review_voc" ? "amazon_dom" : "sellersprite_plugin",
    kind: input.kind,
    capturedAt: CAPTURED_AT,
    contentHash: input.id.padEnd(64, "0").slice(0, 64),
    sourceUrl: null,
    sourceFingerprint: null,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: input.module,
      subjectKey: SUBJECT_KEY,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: input.module === "review_voc" ? "amazon" : "sellersprite",
      sourceSurface: "synthetic_test_fixture",
      sourceUrl: null,
      providerUpdatedAt: null,
      freshness: { cadenceKey: null },
      acquisitionMode: input.module === "historical_trend" ? "VISIBLE_CHART" : "DOM_DIRECT",
      metricNature: input.metricNature ?? (input.module === "review_voc" ? "source_observed" : "provider_observed"),
      status,
      limitations: status === "BLOCKED_WITH_EVIDENCE" ? ["synthetic blocked-state fixture"] : [],
      identity: { asin: "B07G4VTV2F" },
      data: input.data,
      evidenceOnly: true,
    },
  } as SourceEvidenceAttachment;
}

export function syntheticReviewAttachment(status: FixtureStatus = "VALIDATED_AVAILABLE") {
  return fixtureAttachment({
    id: status === "BLOCKED_WITH_EVIDENCE" ? "blocked-review" : "available-review",
    kind: "v3_review_voc_v1",
    module: "review_voc",
    status,
    data: {
      reviews: [1, 2, 3, 4].map((number) => ({
        rating: number === 1 ? 5 : 4,
        title: number === 1 ? "Synthetic sample title" : `Fixture review ${number}`,
        body: number === 1 ? "Synthetic fixture review text for adapter verification." : `Synthetic fixture review body ${number}.`,
        verifiedPurchase: true,
      })),
    },
  });
}

export function syntheticReverseAsinAttachment() {
  return fixtureAttachment({
    id: "reverse-asin-keywords",
    kind: "v3_reverse_asin_v1",
    module: "reverse_asin",
    data: {
      tables: [{
        headers: ["Rank", "Keyword"],
        rows: [
          ["1", "kinto water bottle"],
          ["2", "kinto travel tumbler"],
          ["3", "kinto tumbler"],
          ...Array.from({ length: 9 }, (_, index) => [`${index + 4}`, `synthetic related keyword ${index + 1}`]),
        ],
      }],
    },
  });
}

export function syntheticKeywordMiningAttachment() {
  return fixtureAttachment({
    id: "keyword-mining-search-volume",
    kind: "v3_keyword_mining_trend_v1",
    module: "keyword_mining_trend",
    metricNature: "provider_estimate",
    data: {
      tables: [{
        headers: ["Rank", "Keyword", "Monthly Searches"],
        rows: [
          ["1", "synthetic tumbler keyword", "3,040"],
          ["2", "synthetic bottle keyword", "1,250"],
          ["3", "synthetic travel mug keyword", "980"],
          ["4", "synthetic insulated cup keyword", "640"],
          ["5", "synthetic drinkware keyword", "320"],
        ],
      }],
    },
  });
}

export function syntheticHistoricalTrendAttachment() {
  return fixtureAttachment({
    id: "historical-trend-series",
    kind: "v3_historical_trend_v1",
    module: "historical_trend",
    metricNature: "provider_estimate",
    data: {
      series: [
        { date: "2025-04", organicTraffic: 1, searchRank: 120 },
        { date: "2025-07", organicTraffic: 0, searchRank: 150 },
        { date: "2025-10", organicTraffic: 1, searchRank: 120 },
      ],
    },
  });
}
