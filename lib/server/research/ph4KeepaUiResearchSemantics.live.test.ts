/**
 * PH4 Keepa 窗口语义与趋势摘要防误用
 * SPIKE_ONLY
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adaptV3HistoricalTrendAttachment,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";

const LIVE_STORE_ROOT = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_DIR;
const LIVE_FIXTURE_TESTS_ENABLED = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_TESTS === "1" && Boolean(LIVE_STORE_ROOT);
const ATT_B018 = LIVE_STORE_ROOT
  ? join(LIVE_STORE_ROOT, "owner-v1", "subjects", "amazon%3AUS%3AB018FDYGVM", "a-30f851339c5ca6044dcf1fd956d7e88dcc06c1932cff0889d1404a3067476701.json")
  : "";

describe.skipIf(!LIVE_FIXTURE_TESTS_ENABLED)("PH4 Keepa UI fixture → Research 语义", () => {
  it("maps seven window metrics with CSV-strict values and import capturedAt", () => {
    const att = JSON.parse(readFileSync(ATT_B018, "utf8"));
    expect(att.sourceType).toBe("keepa_export");
    expect(att.payload.acquisitionMode).toBe("FILE_EXPORT");
    expect(att.payload.data.sourceFileSha256).toBe(
      "77df393cd391b0a4d838d30aa4fa21f3f9461e088bd5a51eed2e0e9107dc296b",
    );

    const obs = adaptV3HistoricalTrendAttachment(att as never, "amazon:US:B018FDYGVM");
    expect(obs).toHaveLength(7);

    const byField = Object.fromEntries(obs.map((o) => [o.field, o]));
    // 严格对应 CSV，不把 current 混进 window
    expect(byField["keepa.window.price90dMin"].value).toBe(179.99);
    expect(byField["keepa.window.price90dAvg"].value).toBe(190);
    expect(byField["keepa.window.price360dMin"].value).toBe(169.99);
    expect(byField["keepa.window.bsr90dAvg"].value).toBe(12000);
    expect(byField["keepa.window.dealCount90d"].value).toBe(2);
    expect(Object.keys(byField)).not.toContain("keepa.window.currentPrice");

    // capturedAt = 导入时间，不是价格发生日
    expect(byField["keepa.window.price90dMin"].capturedAt).toBe(att.capturedAt);
    expect(byField["keepa.window.price90dMin"].sourceType).toBe("keepa_export");
    expect(byField["keepa.window.price90dMin"].valueKind).toBe("observed");
    expect(byField["keepa.window.price90dMin"].evidenceRefs).toEqual([
      `attachment:${att.attachmentId}`,
    ]);
  });

  it("treats single-shot window metrics as unknown, not rising/falling/stable daily trend", () => {
    const att = JSON.parse(readFileSync(ATT_B018, "utf8"));
    const obs = adaptV3HistoricalTrendAttachment(att as never, "amazon:US:B018FDYGVM");
    const summary = summarizeTrendObservations(obs);
    expect(summary).toBeTruthy();
    expect(summary!.pointsCount).toBe(7);
    // 严格契约：每个 keepa 窗口指标只有一个时间点，
    // 单点无法证明历史稳定 → 必须精确为 unknown（不放宽到 stable）。
    for (const [key, metric] of Object.entries(summary!.metrics)) {
      expect(metric.direction, key).toBe("unknown");
      expect(key.startsWith("keepa.window."), key).toBe(true);
      // 七个不同指标是七个字段，不是一个指标的时间序列
      expect(metric.startValue, key).toBe(metric.endValue);
    }
    expect(summary!.evidenceRefs).toContain(`attachment:${att.attachmentId}`);
    // 字段名互不相同 → 未把七个窗口指标折叠成同一条时间序列
    expect(new Set(obs.map((o) => o.field)).size).toBe(7);
  });

  it("SCREENSHOT_EVIDENCE still produces no window observations", () => {
    const att = JSON.parse(readFileSync(ATT_B018, "utf8"));
    const shot = { ...att, payload: { ...att.payload, acquisitionMode: "SCREENSHOT_EVIDENCE" } };
    expect(adaptV3HistoricalTrendAttachment(shot as never, "amazon:US:B018FDYGVM")).toEqual([]);
  });
});
