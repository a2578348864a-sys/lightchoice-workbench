import { describe, expect, it } from "vitest";
import { HISTORY_METRICS, historyChartPoints } from "./marketTrendPresentation";

describe("historical chart presentation", () => {
  it("inserts null calendar gaps without modifying original observations", () => {
    const input = [{ date: "2026-01-01", value: 10 }, { date: "2026-03-01", value: 30 }];
    const before = JSON.stringify(input), output = historyChartPoints(input, true);
    expect(output.map((point) => point.value)).toEqual([10, null, 30]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("keeps every irregular observation and true time spacing", () => {
    const input = [{ date: "2026-03-20", value: 11 }, { date: "2026-01-01", value: 8 }];
    const output = historyChartPoints(input, false);
    expect(output).toHaveLength(2);
    expect(output[1].timestamp - output[0].timestamp).toBe(78 * 86400000);
  });
  it("does not collapse multiple observations in a month", () => {
    const output = historyChartPoints([{ date: "2026-01-01", value: 1 }, { date: "2026-01-20", value: 2 }, { date: "2026-03-01", value: 3 }], true);
    expect(output.map((point) => point.value)).toEqual([1, 2, null, 3]);
  });
  it("keeps observed zero and negative growth, rejects invalid dates", () => {
    expect(historyChartPoints([{ date: "bad", value: 7 }, { date: "2026-01-01", value: 0 }, { date: "2026-02-01", value: -2 }], true).map((p) => p.value)).toEqual([0, -2]);
  });
  it("does not multiply already stored percentage values", () => {
    expect(HISTORY_METRICS.reviewRate.unit).toBe("%");
    expect(historyChartPoints([{ date: "2026-01-01", value: 11.69 }], true)[0].value).toBe(11.69);
  });
});
