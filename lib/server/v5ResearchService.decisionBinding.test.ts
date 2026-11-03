import { describe, expect, it } from "vitest";
import { researchRootStaleState } from "./v5ResearchService";

/**
 * P2-04：研究报告、人工决定、版本与证据的一致性判定。
 *
 * 只验证读侧纯函数，不触库、不调模型：
 * 报告重生成后，旧的人工决定必须被判为「需要重新确认」，不能被自动恢复有效。
 */
function state(overrides: Record<string, unknown> = {}) {
  return {
    report: { schema: "research-report.v1" },
    reportHash: "report-hash-new",
    factHash: "fact-hash-1",
    evidenceHash: "evidence-hash-1",
    researchRevision: 3,
    myChoice: null,
    reportBindingHashes: null,
    ...overrides,
  } as never;
}

describe("P2-04 决定与版本绑定", () => {
  it("报告重生成后，绑定旧 reportHash 的人工决定必须失效而不是自动恢复", () => {
    const result = researchRootStaleState({}, state({
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "report-hash-old", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 2 } },
    }));
    expect(result.decisionStale).toBe(true);
    expect(result.reportStale).toBe(false);
  });

  it("决定绑定当前报告与版本时不算失效", () => {
    const result = researchRootStaleState({}, state({
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "report-hash-new", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 3 } },
    }));
    expect(result.decisionStale).toBe(false);
  });

  it("研究版本前进（revision 变化）同样使旧决定失效", () => {
    const result = researchRootStaleState({}, state({
      myChoice: { canonicalStatus: "VALIDATE_MORE", bindingHashes: { reportHash: "report-hash-new", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 2 } },
    }));
    expect(result.decisionStale).toBe(true);
  });

  it("证据或事实变化时旧决定失效，不被「状态相同」掩盖", () => {
    const factChanged = researchRootStaleState({}, state({
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "report-hash-new", factHash: "fact-hash-old", evidenceHash: "evidence-hash-1", researchRevision: 3 } },
    }));
    const evidenceChanged = researchRootStaleState({}, state({
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "report-hash-new", factHash: "fact-hash-1", evidenceHash: "evidence-hash-old", researchRevision: 3 } },
    }));
    expect(factChanged.decisionStale).toBe(true);
    expect(evidenceChanged.decisionStale).toBe(true);
  });

  it("尚无人工决定时不伪造失效，也不把空决定当成已确认", () => {
    const result = researchRootStaleState({}, state({ myChoice: null }));
    expect(result.decisionStale).toBe(false);
  });

  it("v1 正式研报（researchReport）也能承载人工决定，不被判为无报告或永久失效", () => {
    const root = {
      researchReport: {
        reportJson: { schema: "research-report.v1", taskId: "task-v1" },
        reportHash: "v1-report-hash",
        generatedAt: "2026-10-28T00:00:00.000Z",
      },
      // 只有记录过事实/证据绑定的 v1 报告才可作为正式绑定。
      researchReportBindingHashes: { factHash: "fact-hash-1", evidenceHash: "evidence-hash-1" },
    };
    const bound = researchRootStaleState(root, state({
      report: null,
      reportHash: null,
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "v1-report-hash", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 3 } },
    }));
    expect(bound.decisionStale).toBe(false);

    const rebind = researchRootStaleState(root, state({
      report: null,
      reportHash: null,
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "another-hash", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 3 } },
    }));
    expect(rebind.decisionStale).toBe(true);
  });

  it("没有绑定哈希的历史 v1 报告不得被当成正式绑定（避免伪造来源确认）", () => {
    const legacyRoot = {
      researchReport: {
        reportJson: { schema: "research-report.v1", taskId: "task-legacy" },
        reportHash: "legacy-v1-hash",
        generatedAt: "2026-10-28T00:00:00.000Z",
      },
    };
    const result = researchRootStaleState(legacyRoot, state({
      report: null,
      reportHash: null,
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "legacy-v1-hash", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1", researchRevision: 3 } },
    }));
    expect(result.decisionStale).toBe(true);
  });
});
