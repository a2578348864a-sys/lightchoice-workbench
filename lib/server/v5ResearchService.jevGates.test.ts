import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 服务层门禁测试（P0-B / 费用前置拦截）：全部断言「命中门禁 = 0 外部请求」。
 * 通过模块级 mock 固定 DB / 策略 / Provider / 运行时护栏，SUT 为真实 runJevReadinessAdvisory。
 */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  candidateFind: vi.fn(),
  policy: vi.fn(),
  resolveProvider: vi.fn(),
  runtimeRun: vi.fn(),
  runtimePeek: vi.fn(),
  buildBundle: vi.fn(),
  getVoc: vi.fn(),
  providerAdvise: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: { findUnique: mocks.record, findFirst: mocks.record },
    opportunityCandidate: { findUnique: mocks.candidateFind },
  },
}));

vi.mock("@/lib/decision/readiness/policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/decision/readiness/policy")>();
  return { ...actual, readJevReadinessPolicy: (...args: unknown[]) => mocks.policy(...args) };
});

vi.mock("@/lib/decision/providers/readinessIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/decision/providers/readinessIndex")>();
  return { ...actual, getReadinessAdviceProvider: (...args: unknown[]) => mocks.resolveProvider(...args) };
});

vi.mock("@/lib/server/research/jevReadinessRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/research/jevReadinessRuntime")>();
  return {
    ...actual,
    getJevReadinessRuntime: () => ({ run: mocks.runtimeRun, peek: mocks.runtimePeek, stats: () => ({}) }),
  };
});

vi.mock("@/lib/server/research/researchInputBundle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/research/researchInputBundle")>();
  return { ...actual, buildResearchInputBundle: (...args: unknown[]) => mocks.buildBundle(...args) };
});

vi.mock("@/lib/server/vocAnalysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/vocAnalysis")>();
  return { ...actual, getVocAnalysis: (...args: unknown[]) => mocks.getVoc(...args) };
});

import { runJevReadinessAdvisory } from "@/lib/server/v5ResearchService";

const OWNER_CONTEXT = { mode: "owner", token: "" } as const;
const BINDING = { reportHash: "r1", factHash: "f1", evidenceHash: "e1", researchRevision: 3 };

function policyFixture(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    providerKind: "offline",
    providerReason: null,
    allowOffline: true,
    budgetAcknowledged: false,
    ...overrides,
  };
}

function taskRow(overrides: { report?: boolean; researchRevision?: number; factHash?: string | null; evidenceHash?: string | null; reportHash?: string | null } = {}) {
  const v5Research: Record<string, unknown> = {
    candidateId: "c1",
    asin: "B0TEST0001",
    marketplace: "US",
    title: "t",
    factHash: overrides.factHash === undefined ? "f1" : overrides.factHash,
    evidenceHash: overrides.evidenceHash === undefined ? "e1" : overrides.evidenceHash,
    evidenceRefs: ["attachment:att-1"],
    researchRevision: overrides.researchRevision ?? 3,
    report: overrides.report === false ? null : { schema: "research-report.v5", summary: null, opportunities: [], risks: [], narrativeBindings: [], unverifiedAssumptions: [] },
    reportHash: overrides.reportHash === undefined ? "r1" : overrides.reportHash,
  };
  return {
    id: "task-1",
    resultJson: JSON.stringify({ v5Research }),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    decisionStatus: "pending",
    title: "t",
    archivedAt: null,
  };
}

function bundleFixture() {
  return {
    schemaVersion: "research-input-bundle.v1",
    taskId: "task-1",
    candidateId: "c1",
    subjectKey: "amazon:US:B0TEST0001",
    productFact: {
      schema: "product-fact.v3",
      subjectKey: "amazon:US:B0TEST0001",
      sourceProof: {
        source: "amazon_dom",
        captureId: "cap-1",
        evidenceId: "ev-1",
        subjectKey: "amazon:US:B0TEST0001",
        capturedAt: "2026-10-01T00:00:00.000Z",
        contentHash: "h",
        sourceUrl: null,
        operator: "owner:v1",
      },
      basic: {},
      market: {},
      profit: {},
    },
    sourceEvidenceRefs: [],
    keywordEvidence: [],
    reviewEvidence: [],
    customerVoiceEvidence: [],
    trendObservations: [],
    missingFields: [],
    conflicts: [],
  };
}

function runResultFixture() {
  return {
    status: "available",
    advice: {
      status: "available",
      readiness: "NEED_MORE_EVIDENCE",
      reviewQuestions: [],
      contradictions: [],
      missingEvidence: ["BSR"],
      limitations: ["离线桩"],
      inputBinding: { ...BINDING },
    },
    provider: "mock-readiness",
    generatedAt: "2026-10-01T00:02:00.000Z",
    sideEffects: { deepseekInvoked: false, externalRequestAttempted: 0, stateWritten: false, reportRegenerated: false },
    sideEffectsVerification: "runtime_measured",
    requestTrackerKind: "scoped",
    rejected: { reason: null, droppedQuestions: 0, droppedContradictions: 0, forbiddenFields: [], bindingMismatch: false },
    semanticSupport: "NOT_VERIFIED",
    notes: [],
  };
}

async function callRun(overrides: Partial<{ expectedRevision: number; expectedFactHash: string; expectedEvidenceHash: string; confirmRerun: boolean; context: unknown }> = {}) {
  return runJevReadinessAdvisory({
    context: (overrides.context ?? OWNER_CONTEXT) as never,
    taskId: "task-1",
    expectedRevision: overrides.expectedRevision ?? 3,
    expectedFactHash: overrides.expectedFactHash ?? "f1",
    expectedEvidenceHash: overrides.expectedEvidenceHash ?? "e1",
    confirmRerun: overrides.confirmRerun ?? false,
    idempotencyKey: "jev-gate-1",
  });
}

async function captureRejectCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeEach(() => {
  mocks.record.mockReset();
  mocks.candidateFind.mockReset();
  mocks.policy.mockReset();
  mocks.resolveProvider.mockReset();
  mocks.runtimeRun.mockReset();
  mocks.runtimePeek.mockReset();
  mocks.buildBundle.mockReset();
  mocks.getVoc.mockReset();
  mocks.providerAdvise.mockReset();

  mocks.policy.mockReturnValue(policyFixture());
  mocks.resolveProvider.mockReturnValue({
    kind: "offline",
    reason: null,
    provider: { providerId: "mock-readiness", advise: mocks.providerAdvise },
  });
  mocks.record.mockResolvedValue(taskRow());
  mocks.candidateFind.mockResolvedValue(null);
  mocks.buildBundle.mockResolvedValue(bundleFixture());
  mocks.getVoc.mockResolvedValue(null);
  mocks.runtimeRun.mockResolvedValue({ ok: true, result: runResultFixture(), cached: false, deduped: false, replayed: false });
});

describe("runJevReadinessAdvisory 门禁（命中 = 0 外部请求）", () => {
  it("功能未启用（默认关闭）→ JEV_READINESS_DISABLED，Provider 与运行时均未被触发", async () => {
    mocks.policy.mockReturnValue(policyFixture({ enabled: false, providerKind: "unavailable", providerReason: "JEV_READINESS_PROVIDER_NOT_CONFIGURED" }));
    const code = await captureRejectCode(callRun());
    expect(code).toBe("JEV_READINESS_DISABLED");
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
    expect(mocks.providerAdvise).not.toHaveBeenCalled();
  });

  it("Provider 不可用（未确认预算）→ JEV_READINESS_PROVIDER_UNAVAILABLE，0 请求", async () => {
    mocks.resolveProvider.mockReturnValue({
      kind: "unavailable",
      reason: "JEV_READINESS_BUDGET_NOT_ACKNOWLEDGED",
      provider: { providerId: "readiness-unavailable", advise: mocks.providerAdvise },
    });
    const code = await captureRejectCode(callRun());
    expect(code).toBe("JEV_READINESS_PROVIDER_UNAVAILABLE");
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
    expect(mocks.providerAdvise).not.toHaveBeenCalled();
  });

  it("研究版本失效 → RESEARCH_REVISION_STALE，0 请求", async () => {
    mocks.record.mockResolvedValue(taskRow({ researchRevision: 5 }));
    const code = await captureRejectCode(callRun({ expectedRevision: 3 }));
    expect(code).toBe("RESEARCH_REVISION_STALE");
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
  });

  it("事实绑定失效 → FACT_STALE，0 请求", async () => {
    const code = await captureRejectCode(callRun({ expectedFactHash: "old-fact" }));
    expect(code).toBe("FACT_STALE");
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
  });

  it("证据绑定失效 → EVIDENCE_STALE，0 请求", async () => {
    const code = await captureRejectCode(callRun({ expectedEvidenceHash: "old-evidence" }));
    expect(code).toBe("EVIDENCE_STALE");
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
  });

  it("缺少正式研报 → JEV_READINESS_INPUT_UNAVAILABLE，0 请求", async () => {
    mocks.record.mockResolvedValue(taskRow({ report: false, reportHash: null }));
    const code = await captureRejectCode(callRun());
    expect(code).toBe("JEV_READINESS_INPUT_UNAVAILABLE");
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
  });

  it("非 Owner 上下文 → FORBIDDEN，任何依赖均不被触发", async () => {
    const code = await captureRejectCode(callRun({ context: { mode: "demo", demoAccessId: "visitor-a" } }));
    expect(code).toBe("FORBIDDEN");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.runtimeRun).not.toHaveBeenCalled();
  });

  it("合法路径：输入构建 → 运行时护栏被调用一次；结果不写任何状态", async () => {
    const result = await callRun();
    expect(result.jevStatus).toBe("available");
    expect(result.providerKind).toBe("offline");
    expect(result.meta.cached).toBe(false);
    expect(result.binding).toEqual(BINDING);
    expect(mocks.runtimeRun).toHaveBeenCalledTimes(1);
    const runtimeArg = mocks.runtimeRun.mock.calls[0]?.[0] as { taskId: string; input: { binding: unknown } };
    expect(runtimeArg.taskId).toBe("task-1");
    expect(runtimeArg.input.binding).toEqual(BINDING);
    expect(result.sideEffects).toEqual({ deepseekInvoked: false, externalRequestAttempted: 0, stateWritten: false, reportRegenerated: false });
  });
});
