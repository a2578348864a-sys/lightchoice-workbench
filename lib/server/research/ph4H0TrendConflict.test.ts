/**
 * 任务三：趋势重复与冲突处理（纯 Fixture，确定性）
 *
 * 核心问题：同一 (subject, 期间, 字段) 出现**不同数值**时，
 * 摘要是否把它当作两个时间点，从而虚构出确定性的上涨/下跌结论。
 */
import { describe, expect, it } from "vitest";

import { buildTrendObservation, type TrendObservation } from "@/lib/sourceLayer/v2/contracts";
import {
  deduplicateTrendObservations,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";

const SUBJECT = "amazon:US:B0FIXT0001";
const OTHER_SUBJECT = "amazon:US:B0FIXT0002";

function obs(input: {
  period: string;
  field: string;
  value: number;
  ref: string;
  subjectKey?: string;
sourceType?: "sellersprite_plugin" | "keepa_export";
  }): TrendObservation {
  return buildTrendObservation({
    observationId: `x:${input.subjectKey ?? SUBJECT}:${input.period}:${input.field}:${input.ref}`,
    subjectKey: input.subjectKey ?? SUBJECT,
    field: input.field,
    value: input.value,
    valueKind: "estimated",
    sourceType: input.sourceType ?? "sellersprite_plugin",
    capturedAt: `${input.period}-01T00:00:00.000Z`,
    evidenceRefs: [input.ref],
  });
}

describe("PH4-H0 趋势冲突与重复", () => {
  it("同商品+同月+同指标+同值 → 不重复计数", () => {
    const a = obs({ period: "2025-04", field: "自然流量", value: 120, ref: "attachment:a" });
    const b = obs({ period: "2025-04", field: "自然流量", value: 120, ref: "attachment:b" });
    const merged = deduplicateTrendObservations([b], [a]);
    const semantic = merged.map((o) => `${o.subjectKey}|${o.capturedDate}|${o.field}`);
    console.log("[C1] semanticKeys=", JSON.stringify(semantic));
    // 同一时间点不得被计成两个
    expect(new Set(semantic).size).toBe(1);
    const summary = summarizeTrendObservations(merged);
    console.log("[C1] direction=", summary?.metrics["自然流量"].direction);
    // 两个附件对同一月份给出同一读数 → 无冲突，可判为稳定；
    // 关键不得出现 rising / falling（那会把一个时间点当两个月）。
    expect(["rising", "falling"]).not.toContain(summary?.metrics["自然流量"].direction);
  });

  it("同商品+同月+同指标+不同值 → 不得虚构确定性方向（同一时间点冲突）", () => {
    // 两条观察的 capturedAt **完全相同**（同一时间点），但数值不同 → 真冲突
    const mk = (value: number, ref: string) => buildTrendObservation({
      observationId: `x:${ref}`,
      subjectKey: SUBJECT,
      field: "自然流量",
      value,
      valueKind: "estimated",
      sourceType: "sellersprite_plugin",
      capturedAt: "2025-04-01T00:00:00.000Z",
      evidenceRefs: [ref],
    });
    const a = mk(120, "attachment:a");
    const b = mk(180, "attachment:b");
    const merged = deduplicateTrendObservations([b], [a]);
    console.log(
      "[C2] mergedCount=",
      merged.length,
      "values=",
      JSON.stringify(merged.map((o) => o.value)),
      "instants=",
      JSON.stringify([...new Set(merged.map((o) => o.capturedAt))]),
    );
    const summary = summarizeTrendObservations(merged);
    const metric = summary?.metrics["自然流量"];
    console.log("[C2] direction=", metric?.direction, "start=", metric?.startValue, "end=", metric?.endValue);

    // 同一时间点只有两个冲突读数 → 绝不能得出 rising / falling / stable 的确定结论
    expect(["rising", "falling", "stable"]).not.toContain(metric?.direction);
    expect(metric?.direction).toBe("unknown");
    // 原始读数仍保留，供人工裁决
    expect([metric?.startValue, metric?.endValue]).toEqual([120, 180]);
  });

  it("跨 ASIN → 不混合", () => {
    const a = obs({ period: "2025-04", field: "自然流量", value: 100, ref: "attachment:a" });
    const b = obs({ period: "2025-04", field: "自然流量", value: 999, ref: "attachment:b", subjectKey: OTHER_SUBJECT });
    const merged = deduplicateTrendObservations([b], [a]);
    console.log("[C3] subjects=", JSON.stringify([...new Set(merged.map((o) => o.subjectKey))]));
    expect(new Set(merged.map((o) => o.subjectKey)).size).toBe(2);
  });

  it("不同 Provider → 不无条件合并为同一指标时间序列", () => {
    const a = obs({ period: "2025-04", field: "自然流量", value: 100, ref: "attachment:a", sourceType: "sellersprite_plugin" });
    const b = obs({ period: "2025-04", field: "自然流量", value: 100, ref: "attachment:b", sourceType: "keepa_export" });
    const merged = deduplicateTrendObservations([b], [a]);
    console.log("[C4] sourceTypes=", JSON.stringify([...new Set(merged.map((o) => o.sourceType))]));
    // sourceType 参与 semanticContentHash → 不应被合并成一个点
    expect(new Set(merged.map((o) => o.sourceType)).size).toBe(2);
  });

  it("不同单位 → 不混算（不同字段名各自独立）", () => {
    const a = obs({ period: "2025-04", field: "自然流量", value: 120, ref: "attachment:a" });
    const b = obs({ period: "2025-04", field: "自然流量_sharePct", value: 46.96, ref: "attachment:b" });
    const summary = summarizeTrendObservations([a, b]);
    console.log("[C5] metrics=", JSON.stringify(Object.keys(summary?.metrics ?? {})));
    expect(Object.keys(summary?.metrics ?? {}).sort()).toEqual(["自然流量", "自然流量_sharePct"]);
  });

  it("不同月份 → 保留独立时间点", () => {
    const a = obs({ period: "2025-04", field: "自然流量", value: 100, ref: "attachment:a" });
    const b = obs({ period: "2025-05", field: "自然流量", value: 150, ref: "attachment:b" });
    const summary = summarizeTrendObservations([a, b]);
    console.log("[C6] periods=2 direction=", summary?.metrics["自然流量"].direction);
    expect(summary?.metrics["自然流量"].direction).toBe("rising");
  });

  it("单个有效时间点 → unknown", () => {
    const summary = summarizeTrendObservations([obs({ period: "2025-04", field: "自然流量", value: 42, ref: "attachment:a" })]);
    expect(summary?.metrics["自然流量"].direction).toBe("unknown");
  });
});