/**
 * PH4 Keepa Evidence → Research TrendObservation 只读回查
 * SPIKE_ONLY / NO_FORMAL_WRITE
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptV3HistoricalTrendAttachment } from "@/lib/server/research/v3EvidenceResearchAdapter";

const LIVE_STORE_ROOT = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_DIR;
const LIVE_FIXTURE_TESTS_ENABLED = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_TESTS === "1" && Boolean(LIVE_STORE_ROOT);
const ATT = LIVE_STORE_ROOT
  ? join(LIVE_STORE_ROOT, "owner-v1", "subjects", "amazon%3AUS%3AB005CXG1X0", "a-7ec3e1d09d40cb947956d6e76c511003c278637b0b40f2d5f810229228abf544.json")
  : "";

describe.skipIf(!LIVE_FIXTURE_TESTS_ENABLED)("PH4 Keepa attachment → Research TrendObservation", () => {
  it("projects keepa_export window metrics without inventing date series", () => {
    const att = JSON.parse(readFileSync(ATT, "utf8"));
    expect(att.kind).toBe("v3_historical_trend_v1");
    expect(att.sourceType).toBe("keepa_export");

    const obs = adaptV3HistoricalTrendAttachment(att as never, "amazon:US:B005CXG1X0");
    expect(obs.length).toBe(7);

    const fields = obs.map((o) => o.field);
    expect(fields).toContain("keepa.window.price90dMin");
    expect(fields).toContain("keepa.window.bsr90dAvg");
    expect(fields).toContain("keepa.window.dealCount90d");

    const price = obs.find((o) => o.field === "keepa.window.price90dMin")!;
    expect(price.value).toBe(249.99);
    expect(price.sourceType).toBe("keepa_export");
    expect(price.valueKind).toBe("observed");
    expect(price.evidenceRefs).toEqual([`attachment:${att.attachmentId}`]);
    expect(price.capturedAt).toBe(att.capturedAt);

    // 截图门禁仍生效：SCREENSHOT 不应产生 keepa 窗口观察
    const screenshot = {
      ...att,
      payload: { ...att.payload, acquisitionMode: "SCREENSHOT_EVIDENCE" },
    };
    expect(adaptV3HistoricalTrendAttachment(screenshot as never, "amazon:US:B005CXG1X0")).toEqual([]);
  });
});
