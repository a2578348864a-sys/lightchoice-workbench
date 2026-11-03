import { describe, expect, it } from "vitest";

import {
  BROWSER_VISIBLE_V3_SCHEMA,
  parseBrowserVisibleV3Envelope,
} from "@/lib/sourceLayer/browserVisibleModuleCapture";

const envelope = {
  schemaVersion: BROWSER_VISIBLE_V3_SCHEMA,
  module: "historical_trend",
  subjectKey: "amazon:US:B0GATEWAY1",
  marketplace: "US",
  capturedAt: "2026-09-26T08:00:00.000Z",
  provider: "SellerSprite",
  sourceSurface: "historical chart visible tooltip",
  sourceUrl: "https://www.sellersprite.com/v3/product-research/?q=B0GATEWAY1",
  acquisitionMode: "VISIBLE_CHART",
  metricNature: "provider_estimate",
  status: "AVAILABLE_WITH_LIMITATION",
  limitations: ["history:visible_window_only"],
  identity: { asin: "B0GATEWAY1" },
  data: { points: [{ capturedDate: "2026-09-01", bsr: 88 }] },
  providerUpdatedAt: null,
  freshnessMetricKey: null,
  evidenceOnly: true,
};

describe("Browser Visible V3 envelope", () => {
  it("accepts chart evidence without upgrading it to Amazon confirmed facts", () => {
    expect(parseBrowserVisibleV3Envelope(envelope)).toMatchObject({
      module: "historical_trend",
      acquisitionMode: "VISIBLE_CHART",
      metricNature: "provider_estimate",
      evidenceOnly: true,
    });
  });

  it("rejects non-HTTPS sources before Gateway", () => {
    expect(() => parseBrowserVisibleV3Envelope({ ...envelope, sourceUrl: "http://127.0.0.1/hidden" }))
      .toThrow("BROWSER_VISIBLE_SOURCE_URL_INVALID");
  });
});
