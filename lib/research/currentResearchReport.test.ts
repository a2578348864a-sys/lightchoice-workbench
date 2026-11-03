import { describe, expect, it } from "vitest";
import { resolveCurrentResearchReport, type ResearchReportCandidate } from "./currentResearchReport";

const v1: ResearchReportCandidate = { source: "v1", reportHash: "hash-v1", generatedAt: "2026-10-28T00:00:00.000Z", researchRevision: null };
const v5: ResearchReportCandidate = { source: "v5", reportHash: "hash-v5", generatedAt: "2026-10-28T01:00:00.000Z", researchRevision: 3 };

describe("当前正式研报权威判定", () => {
  it("只有 V1：直接作为当前报告", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1], pointer: null });
    expect(result).toMatchObject({ status: "current", source: "v1", reportHash: "hash-v1", reason: "only_candidate", otherPresent: false });
  });

  it("只有 V5：维持既有行为", () => {
    const result = resolveCurrentResearchReport({ candidates: [v5], pointer: null });
    expect(result).toMatchObject({ status: "current", source: "v5", reportHash: "hash-v5" });
  });

  it("两份并存且指针指向 V5：V5 权威，V1 只作其他存在标记", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1, v5], pointer: { source: "v5", reportHash: "hash-v5" } });
    expect(result).toMatchObject({ status: "current", source: "v5", reportHash: "hash-v5", otherPresent: true, reason: "pointer_match" });
  });

  it("两份并存且指针指向 V1：V1 权威，不被 V5 字段存在覆盖", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1, v5], pointer: { source: "v1", reportHash: "hash-v1" } });
    expect(result).toMatchObject({ status: "current", source: "v1", reportHash: "hash-v1", otherPresent: true });
  });

  it("两份并存但没有指针：不得按版本名猜，必须暴露歧义", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1, v5], pointer: null });
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.reason).toBe("both_present_without_pointer");
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("指针与现有报告都对不上（报告被外部替换）：判为歧义而不是挑一份", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1, v5], pointer: { source: "v5", reportHash: "hash-unknown" } });
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.reason).toBe("pointer_mismatch");
  });

  it("指针来源与命中报告格式不一致时也不采信", () => {
    const result = resolveCurrentResearchReport({ candidates: [v1, v5], pointer: { source: "v1", reportHash: "hash-v5" } });
    expect(result.status).toBe("ambiguous");
  });

  it("没有任何报告：缺失", () => {
    expect(resolveCurrentResearchReport({ candidates: [], pointer: null })).toEqual({ status: "missing", reason: "no_report" });
  });

  it("空哈希不构成候选，避免用空值伪造报告", () => {
    const result = resolveCurrentResearchReport({ candidates: [{ ...v1, reportHash: "  " }], pointer: null });
    expect(result.status).toBe("missing");
  });
});
