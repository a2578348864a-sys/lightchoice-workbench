/**
 * H0 补充回归：同一历史月份、同一指标、不同**采集时刻**出现不同读数。
 *
 * ## 契约前提（已核实 `lib/sourceLayer/v2/contracts.ts` + adapter）
 *
 * - `TrendObservation.capturedAt` = **观察期间**（adapter 把 `2025-04` 映射为
 *   `2025-04-01T00:00:00.000Z`）；`capturedDateOf()` 取其日期部分。
 * - **采集时刻**只存在于 `attachment.capturedAt` 与 `evidenceRefs`，
 *   **不进入趋势时间轴**。
 *
 * 因此「同月不同采集时刻」的正确表现是：两份证据产生**相同 capturedDate**，
 * 摘要不得把它们当成两个历史月份，也不得凭 120→180 得出上涨。
 *
 * 纯 Fixture、确定性；不重新采集、不重构 Historical Trend。
 */
import { describe, expect, it } from "vitest";
import { buildTrendObservation, type TrendObservation } from "@/lib/sourceLayer/v2/contracts";
import {
  deduplicateTrendObservations,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";

const SUBJECT = "amazon:US:B07Z5K2X2C";

/** 观察期间固定为 2025-04；采集日期只体现在 evidenceRefs 上。 */
function obsForApril(value: number, attachmentId: string, _capturedOn: string): TrendObservation {
  return buildTrendObservation({
    observationId: `x:${attachmentId}`,
    subjectKey: SUBJECT,
    field: "自然流量",
    value,
    valueKind: "estimated",
    sourceType: "sellersprite_plugin",
    capturedAt: "2025-04-01T00:00:00.000Z", // 观察期间，与采集日期无关
    evidenceRefs: [`attachment:${attachmentId}`],
  });
}

describe("H0 回归：同月份 + 不同采集时刻", () => {
  it("同月两次采集 → 只覆盖一个历史月份（采集日期不进入趋势时间轴）", () => {
    const a = obsForApril(120, "att-20261009", "2026-10-09T10:00:00.000Z");
    const b = obsForApril(180, "att-20261010", "2026-10-10T10:00:00.000Z");

    const periods = [...new Set([a.capturedDate, b.capturedDate])];
    console.log("[H0] capturedDate A=", a.capturedDate, " B=", b.capturedDate);
    console.log("[H0] DISTINCT_HISTORICAL_PERIODS=", periods.length, JSON.stringify(periods));
    console.log("[H0] evidenceRefs A=", JSON.stringify(a.evidenceRefs), " B=", JSON.stringify(b.evidenceRefs));

    expect(periods, "采集日期不同不得变成两个历史月份").toEqual(["2025-04-01"]);
    // 两份来源身份仍各自保留
    expect(a.evidenceRefs).toEqual(["attachment:att-20261009"]);
    expect(b.evidenceRefs).toEqual(["attachment:att-20261010"]);
  });

  it("同月不同采集时刻的冲突 → unknown，不得得出上涨", () => {
    const a = obsForApril(120, "att-20261009", "2026-10-09T10:00:00.000Z");
    const b = obsForApril(180, "att-20261010", "2026-10-10T10:00:00.000Z");

    const merged = deduplicateTrendObservations([a], [b]);
    const summary = summarizeTrendObservations(merged);
    const metric = summary?.metrics["自然流量"];
    console.log("[H0] mergedCount=", merged.length, " direction=", metric?.direction);
    console.log("[H0] start=", metric?.startValue, " end=", metric?.endValue);
    console.log("[H0] summary.timeWindow=", summary?.timeWindow);

    expect(["rising", "falling"]).not.toContain(metric?.direction);
    expect(metric?.direction, "同一历史月份的两次不同读数属于冲突").toBe("unknown");
    // 时间窗口必须只覆盖该月，不得出现两个月
    expect(summary?.timeWindow).toBe("2025-04-01");
  });

  it("对照：真正跨月份的正常趋势不得被误伤", () => {
    const a = buildTrendObservation({
      observationId: "x:apr", subjectKey: SUBJECT, field: "自然流量", value: 120,
      valueKind: "estimated", sourceType: "sellersprite_plugin",
      capturedAt: "2025-04-01T00:00:00.000Z", evidenceRefs: ["attachment:a"],
    });
    const b = buildTrendObservation({
      observationId: "x:may", subjectKey: SUBJECT, field: "自然流量", value: 180,
      valueKind: "estimated", sourceType: "sellersprite_plugin",
      capturedAt: "2025-05-01T00:00:00.000Z", evidenceRefs: ["attachment:b"],
    });
    const summary = summarizeTrendObservations(deduplicateTrendObservations([], [a, b]));
    console.log("[H0-cross] timeWindow=", summary?.timeWindow, " direction=", summary?.metrics["自然流量"].direction);
    expect(summary?.timeWindow).toBe("2025-04-01 ~ 2025-05-01");
    expect(summary?.metrics["自然流量"].direction).toBe("rising");
  });

  it("对照：Keepa 窗口统计不受影响（单点 → unknown，字段独立）", () => {
    const keepa = buildTrendObservation({
      observationId: "k:1",
      subjectKey: SUBJECT,
      field: "keepa.window.price90dMin",
      value: 179.99,
      valueKind: "observed",
      sourceType: "keepa_export",
      capturedAt: "2026-10-09T10:00:00.000Z",
      evidenceRefs: ["attachment:k"],
    });
    const summary = summarizeTrendObservations([keepa]);
    console.log("[H0-keepa] direction=", summary?.metrics["keepa.window.price90dMin"].direction);
    expect(summary?.metrics["keepa.window.price90dMin"].direction).toBe("unknown");
  });
});