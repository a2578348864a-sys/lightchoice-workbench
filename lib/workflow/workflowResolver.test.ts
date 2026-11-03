import { describe, expect, it } from "vitest";
import {
  resolveWorkflowActionTarget,
  resolveWorkflowStage,
  type WorkflowActionCandidates,
  type WorkflowFacts,
} from "./workflowResolver";

const empty: WorkflowFacts = {
  sourceBatchCount: 0,
  sourceItemCount: 0,
  marketScanCount: 0,
  marketSampleCount: 0,
  marketDecisionPendingCount: 0,
  marketProceedCount: 0,
  representativeCount: 0,
  researchTaskCount: 0,
  productDecisionCount: 0,
  productGateProceedCount: 0,
  productBriefCount: 0,
};

describe("resolveWorkflowStage", () => {
  it("follows the recovery chain from capture to brief", () => {
    expect(resolveWorkflowStage(empty).stage).toBe("MARKET_CAPTURE");
    expect(resolveWorkflowStage({ ...empty, sourceItemCount: 4 }).stage).toBe("MARKET_CAPTURE");
    expect(resolveWorkflowStage({ ...empty, marketScanCount: 1, marketSampleCount: 4 }).stage).toBe("MARKET_RESEARCH");
    expect(resolveWorkflowStage({ ...empty, marketDecisionPendingCount: 1 }).stage).toBe("MARKET_DECISION");
    expect(resolveWorkflowStage({ ...empty, marketProceedCount: 1 }).stage).toBe("BENCHMARK_SELECTION");
    expect(resolveWorkflowStage({ ...empty, researchTaskCount: 1 }).stage).toBe("PRODUCT_RESEARCH");
    expect(resolveWorkflowStage({ ...empty, productDecisionCount: 1 }).stage).toBe("PRODUCT_DECISION");
    expect(resolveWorkflowStage({ ...empty, productGateProceedCount: 1 }).stage).toBe("PRODUCT_BRIEF");
  });

  it("仅有 Brief、无 PROCEED 时使用查看文案，不暗示已通过商品闸门", () => {
    const result = resolveWorkflowStage({ ...empty, researchTaskCount: 1, productBriefCount: 1 });
    expect(result.stage).toBe("PRODUCT_BRIEF");
    expect(result.action.title).toBe("查看产品开发需求单");
    expect(result.action.description).toContain("需补充验证");
    expect(result.action.ctaLabel).not.toContain("形成");
  });

  it("Brief + PROCEED 时使用查看已生成需求单文案", () => {
    const result = resolveWorkflowStage({
      ...empty,
      productBriefCount: 1,
      productGateProceedCount: 1,
    });
    expect(result.stage).toBe("PRODUCT_BRIEF");
    expect(result.action.title).toBe("查看产品开发需求单");
    expect(result.action.description).toContain("可编辑");
  });

  it("仅 PROCEED、无 Brief 时仍提示形成需求单", () => {
    const result = resolveWorkflowStage({ ...empty, productGateProceedCount: 1 });
    expect(result.stage).toBe("PRODUCT_BRIEF");
    expect(result.action.title).toBe("形成产品开发需求单");
  });

  it("prefers the furthest actionable product stage", () => {
    const result = resolveWorkflowStage({
      ...empty,
      marketDecisionPendingCount: 2,
      researchTaskCount: 1,
      productDecisionCount: 1,
    });
    expect(result.stage).toBe("PRODUCT_DECISION");
    expect(result.action.href).toBe("/research?view=needs_decision");
  });
});

describe("D0-006 resolveWorkflowActionTarget 动作与对象同主体", () => {
  const noCandidates: WorkflowActionCandidates = {
    decisionTargets: [],
    briefTargets: [],
    pendingScanTargets: [],
    proceedScanTargets: [],
  };
  const koolstuffs = { taskId: "task-kool", asin: "B0KOOL1234", title: "硅胶烘焙垫", image: null };
  const luckyiren = { taskId: "task-lucky", asin: "B0LUCKY123", title: "防烫手套", image: null };

  it("需求单阶段：绑定已通过门禁的研究，而不是仍在待决策队列的商品", () => {
    // 复现 D0-006：Koolstuffs 仍 needs_decision，但首页建议进入需求单，
    // 旧版把 Koolstuffs 卡片拼在旁边、CTA 却进入不带 taskId 的需求单中心。
    const target = resolveWorkflowActionTarget("PRODUCT_BRIEF", {
      ...noCandidates,
      decisionTargets: [koolstuffs], // 待决策队列里是 Koolstuffs
      briefTargets: [{ ...luckyiren, hasBrief: false, businessStage: "proceed" }], // 已 proceed、尚无 Brief
    });
    expect(target.href).toBe("/product-brief?taskId=task-lucky");
    expect(target.subject?.subjectId).toBe("task-lucky");
    expect(target.subject?.asin).toBe("B0LUCKY123");
  });

  it("需求单阶段：已有 Brief 且 PROCEED 的优先于仅有 Brief 的 VALIDATE_MORE 草稿", () => {
    const validateMoreWithBrief = { ...koolstuffs, hasBrief: true, businessStage: "validate_more" as const };
    const proceedWithBrief = { ...luckyiren, hasBrief: true, businessStage: "proceed" as const };
    const target = resolveWorkflowActionTarget("PRODUCT_BRIEF", {
      ...noCandidates,
      briefTargets: [validateMoreWithBrief, proceedWithBrief],
    });
    expect(target.href).toBe("/product-brief?taskId=task-lucky");
    expect(target.subject?.subjectId).toBe("task-lucky");
  });

  it("需求单阶段：没有合格对象时只给阶段性动作，不携带 subject", () => {
    const target = resolveWorkflowActionTarget("PRODUCT_BRIEF", noCandidates);
    expect(target.href).toBe("/product-brief");
    expect(target.subject).toBeUndefined();
  });

  it("商品决策阶段：绑定待决策的具体研究 taskId", () => {
    const target = resolveWorkflowActionTarget("PRODUCT_DECISION", {
      ...noCandidates,
      decisionTargets: [koolstuffs, luckyiren],
    });
    expect(target.href).toBe("/research/task-kool");
    expect(target.subject?.subjectId).toBe("task-kool");
  });

  it("市场决策/代表商品阶段：绑定具体 scanId", () => {
    const pending = resolveWorkflowActionTarget("MARKET_DECISION", {
      ...noCandidates,
      pendingScanTargets: [{ scanId: "scan-1", scanName: "硅胶烘焙垫市场" }],
    });
    expect(pending.href).toBe("/market-analysis/scan-1");
    expect(pending.subject?.subjectId).toBe("scan-1");

    const benchmark = resolveWorkflowActionTarget("BENCHMARK_SELECTION", {
      ...noCandidates,
      proceedScanTargets: [{ scanId: "scan-2", scanName: "手套市场" }],
    });
    expect(benchmark.href).toBe("/market-analysis/scan-2");
    expect(benchmark.subject?.subjectId).toBe("scan-2");
  });

  it("采集/市场研究等阶段动作保持原 href（阶段性建议不拼接对象）", () => {
    for (const stage of ["MARKET_CAPTURE", "MARKET_RESEARCH", "PRODUCT_RESEARCH"] as const) {
      const target = resolveWorkflowActionTarget(stage, noCandidates);
      expect(target.subject).toBeUndefined();
    }
  });

  it("保留调用方改写后的查看文案，同时绑定 proceed+brief 对象", () => {
    const custom = {
      ...resolveWorkflowActionTarget("PRODUCT_BRIEF", noCandidates),
      title: "查看产品开发需求单",
      description: "已有可编辑的需求单。",
      ctaLabel: "打开产品开发需求单 ➔",
    };
    const target = resolveWorkflowActionTarget(
      "PRODUCT_BRIEF",
      { ...noCandidates, briefTargets: [{ ...luckyiren, hasBrief: true, businessStage: "proceed" }] },
      custom,
    );
    expect(target.title).toBe("查看产品开发需求单");
    expect(target.href).toBe("/product-brief?taskId=task-lucky");
  });
});
