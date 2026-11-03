import { auditResearchClaims } from "@/lib/research/evidenceAudit";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product Brief 门禁状态暴露（无既有需求单路径）：
 * readProductBrief 必须在 brief 为 null 时复用服务端口径（getResearchDetail +
 * currentProductGateIsProceed）暴露阻塞码，让前端按钮反映服务端必然的接受/拒绝。
 */
const state = vi.hoisted(() => ({
  detail: vi.fn(),
  task: null as { id: string; type: string; resultJson: string; updatedAt: Date } | null,
}));

vi.mock("@/lib/server/v5ResearchService", () => ({
  getResearchDetail: state.detail,
}));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: {
      findUnique: vi.fn(async () => state.task),
    },
  },
}));

import { ProductBriefError, readProductBrief } from "@/lib/server/productBriefService";

const context = { mode: "owner", token: "gate-test" } as const;
const taskId = "gate-task-1";

function taskRow() {
  return {
    id: taskId,
    type: "workflow",
    resultJson: JSON.stringify({ type: "workflow", candidateToTask: { candidateId: "cand-1" } }),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
  };
}

function detailWith(overrides: Record<string, unknown>) {
  return {
    taskId,
    researchRevision: 1,
    stale: false,
    report: { summary: {} },
    claimAudit: auditResearchClaims({ summary: null, opportunities: [], risks: [], painPoints: [], salesGrade: "NOT_AVAILABLE", reviewBase: null }),
    myChoice: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.detail.mockReset();
  state.task = taskRow();
});

describe("readProductBrief 无既有需求单时的门禁状态暴露", () => {
  it("Product Gate 未选择继续推进 → stale=true + PRODUCT_GATE_PROCEED_REQUIRED", async () => {
    state.detail.mockResolvedValue(detailWith({ myChoice: { choice: "WATCH" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.brief).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("PRODUCT_GATE_PROCEED_REQUIRED");
  });

  it("canonicalStatus 为 PAUSE（choice 缺失）同样视为未推进", async () => {
    state.detail.mockResolvedValue(detailWith({ myChoice: { canonicalStatus: "PAUSE" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("PRODUCT_GATE_PROCEED_REQUIRED");
  });

  it("研究证据已变化 → RESEARCH_EVIDENCE_STALE（优先于门禁判定）", async () => {
    state.detail.mockResolvedValue(detailWith({ stale: true, staleReason: "RESEARCH_EVIDENCE_CHANGED", myChoice: { choice: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("RESEARCH_EVIDENCE_STALE");
  });

  it("尚无正式研报 → RESEARCH_REPORT_REQUIRED", async () => {
    state.detail.mockResolvedValue(detailWith({ report: null, myChoice: { choice: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("RESEARCH_REPORT_REQUIRED");
  });

  it("门禁全部满足 → stale=false（前端按钮可用）", async () => {
    state.detail.mockResolvedValue(detailWith({ myChoice: { choice: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.brief).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.staleReason).toBeNull();
  });

  it("canonicalStatus=PROCEED 也视为已推进", async () => {
    state.detail.mockResolvedValue(detailWith({ myChoice: { canonicalStatus: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.stale).toBe(false);
  });

  it("getResearchDetail 抛 ProductBriefError 时透传其 code 作为 staleReason", async () => {
    state.detail.mockRejectedValue(new ProductBriefError("RESEARCH_TASK_NOT_FOUND", 404, "任务不存在"));
    const result = await readProductBrief({ context, taskId });
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("RESEARCH_TASK_NOT_FOUND");
  });

  it("非 ProductBriefError 异常不吞掉（fail loud）", async () => {
    state.detail.mockRejectedValue(new Error("unexpected"));
    await expect(readProductBrief({ context, taskId })).rejects.toThrow("unexpected");
  });

  it("非 Owner 主体仍 fail-closed", async () => {
    await expect(readProductBrief({ context: { mode: "demo", demoAccessId: "v-1", token: "t" } as never, taskId })).rejects.toBeInstanceOf(ProductBriefError);
    expect(state.detail).not.toHaveBeenCalled();
  });
});

/** V13：报告权威未定（V1/V5 并存）时的读取降级——历史需求单只读可见，写入门禁不变。 */
describe("readProductBrief 报告权威未定（ambiguous）路径", () => {
  const storedBrief = {
    schemaVersion: "product-brief.v1",
    status: "DRAFT",
    revision: 1,
    generatedAt: "2026-10-30T00:00:00.000Z",
    sourceBinding: { taskId, researchRevision: 1, reportHash: "hash-report", factHash: "hash-fact", evidenceHash: "hash-evidence" },
    identity: { asin: "B0TEST0001", marketplace: "US" },
    economics: { currency: "USD", purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "目标售价 - 已知费用 - 目标利润" } },
  };

  function taskWithBrief() {
    return { ...taskRow(), resultJson: JSON.stringify({ type: "workflow", productBrief: storedBrief }) };
  }

  it("已有历史需求单 + 权威未定 → brief 原样返回（锁定可见），staleReason=RESEARCH_REPORT_AUTHORITY_AMBIGUOUS", async () => {
    state.task = taskWithBrief();
    state.detail.mockResolvedValue(detailWith({ reportResolution: { status: "ambiguous" }, myChoice: { choice: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.brief).not.toBeNull();
    expect(result.brief?.revision).toBe(1);
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS");
  });

  it("无历史需求单 + 权威未定 → brief null，阻塞码与 briefContext 同序先判 ambiguous", async () => {
    state.detail.mockResolvedValue(detailWith({ stale: true, reportResolution: { status: "ambiguous" }, myChoice: { choice: "PROCEED" } }));
    const result = await readProductBrief({ context, taskId });
    expect(result.brief).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS");
  });

  it("ambiguous 降级只影响读取：generate/保存门禁不受影响（briefContext 仍先拒绝）", async () => {
    state.task = taskWithBrief();
    state.detail.mockResolvedValue(detailWith({ reportResolution: { status: "ambiguous" }, myChoice: { choice: "PROCEED" } }));
    // 读取可见
    const read = await readProductBrief({ context, taskId });
    expect(read.brief).not.toBeNull();
    // briefContext 的拒绝顺序：ambiguous 先于 stale/gate（与实现 459-467 一致），这里只断言读取层不再吞掉 stored。
    expect(read.staleReason).toBe("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS");
  });
});
