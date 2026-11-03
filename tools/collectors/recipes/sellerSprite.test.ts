import { describe, expect, it } from "vitest";
import { planSellerSpriteReport } from "./sellerSprite";
import { GOLDEN_KEYWORD_MINING_HEADERS, GOLDEN_KEYWORD_MINING_ROWS } from "@/lib/upstream/sellersprite/golden/golden-keyword-reports";

describe("SellerSprite report recipe bridge", () => {
  it("parses only the official report shape and preserves metric nature", () => {
    const result = planSellerSpriteReport({
      headers: GOLDEN_KEYWORD_MINING_HEADERS,
      rows: GOLDEN_KEYWORD_MINING_ROWS.map((row) => GOLDEN_KEYWORD_MINING_HEADERS.map((header) => row[header] ?? null)),
      capturedAt: "2026-09-21T00:00:00.000Z",
      sourceRef: "sellersprite-export:test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reportType).toBe("keyword_mining");
    expect(result.evidence.rows.length).toBeGreaterThan(0);
    expect(result.evidence.rows[0]?.fields.monthlySearches?.metricNature).toBe("snapshot");
  });

  it("stops at a missing panel instead of guessing selectors or permission", () => {
    expect(planSellerSpriteReport({
      headers: null,
      rows: null,
      capturedAt: "2026-09-21T00:00:00.000Z",
      sourceRef: "none",
    })).toMatchObject({ ok: false, status: "human_required", errorCode: "PLUGIN_NOT_LOADED" });
  });

  it("records quota and permission as non-bypassable human gates", () => {
    expect(planSellerSpriteReport({ headers: null, rows: null, capturedAt: "x", sourceRef: "x", unavailableReason: "quota_exhausted" })).toMatchObject({ errorCode: "PROVIDER_QUOTA_EXHAUSTED" });
    expect(planSellerSpriteReport({ headers: null, rows: null, capturedAt: "x", sourceRef: "x", unavailableReason: "permission_denied" })).toMatchObject({ errorCode: "PROVIDER_PERMISSION_DENIED" });
  });
});
