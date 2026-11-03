import { describe, expect, it } from "vitest";

import { diffBriefVersions, summarizeBriefDiff } from "./diff";
import type { ProductBrief } from "./contract";

function makeBrief(overrides: Partial<ProductBrief> = {}): ProductBrief {
  return {
    schemaVersion: "product-brief.v1" as ProductBrief["schemaVersion"],
    status: "DRAFT",
    revision: 1,
    generatedAt: "2026-10-28T00:00:00.000Z",
    sourceBinding: {
      taskId: "task-1",
      researchRevision: 1,
      reportHash: "r1",
      factHash: "f1",
      evidenceHash: "e1",
      marketScanId: null,
      marketSampleHash: null,
    },
    identity: { asin: "B000000001", title: "Fixture", imageUrl: null, brand: null, category: null, marketplace: "US" },
    projectOverview: { text: "旧概述", nature: "EVIDENCE_DERIVED", evidenceRefs: [] },
    targetUser: { text: "人工写的目标用户", nature: "ASSUMPTION", evidenceRefs: [] },
    corePainPoints: [{ text: "旧痛点", nature: "EVIDENCE_DERIVED", evidenceRefs: [] }],
    benchmarks: [],
    differentiation: [],
    economics: {
      targetPrice: 19.99,
      targetMarginPct: 30,
      referralFee: null,
      fbaFee: null,
      logistics: null,
      estimatedTax: null,
      otherKnownCosts: null,
      currency: "USD",
      purchaseCostCeiling: { value: null, currency: "USD", reason: "no_input" },
    } as ProductBrief["economics"],
    specsDirection: [],
    vocQaRedlines: [],
    risks: [],
    rationale: [],
    missingValidation: ["缺报价"],
    specifications: [
      { id: "spec_1", label: "容量", value: "500ml", unit: null, nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] },
    ],
    confirmationItems: [{ id: "cfq_moq", item: "MOQ", status: "待确认", reason: "待供应商" }],
    verificationPlan: [{ id: "v_1", item: "打样", method: "", timing: "", status: "pending" }],
    ...overrides,
  } as ProductBrief;
}

describe("P3-02 Brief 版本差异", () => {
  it("来源版本与状态变化必须出现，且新版本不继承旧批准", () => {
    const before = makeBrief({ status: "APPROVED" });
    const after = makeBrief({ status: "DRAFT", revision: 2, sourceBinding: { ...before.sourceBinding, researchRevision: 2 } });
    const rows = diffBriefVersions(before, after);
    const keys = rows.map((row) => row.key);
    expect(keys).toContain("binding.researchRevision");
    expect(keys).toContain("status");
    expect(rows.find((row) => row.key === "status")?.after).toBe("DRAFT");
  });

  it("人工字段单独标注，供用户决定保留还是替换", () => {
    const before = makeBrief();
    const after = makeBrief({
      revision: 2,
      specifications: [{ id: "spec_2", label: "容量", value: "600ml", unit: null, nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] }],
      confirmationItems: [],
    });
    const rows = diffBriefVersions(before, after);
    const specRow = rows.find((row) => row.key === "specifications");
    const confirmRow = rows.find((row) => row.key === "confirmationItems");
    expect(specRow?.kind).toBe("manual");
    expect(confirmRow?.kind).toBe("manual");
    expect(confirmRow?.after).toBe("0 项");
  });

  it("内容完全一致时不产生噪音行", () => {
    const rows = diffBriefVersions(makeBrief(), makeBrief());
    expect(rows).toHaveLength(0);
    expect(summarizeBriefDiff(rows)).toEqual({ total: 0, manual: 0, source: 0 });
  });

  it("汇总同时给出总数、人工项与来源项", () => {
    const before = makeBrief();
    const after = makeBrief({
      revision: 2,
      sourceBinding: { ...before.sourceBinding, researchRevision: 2 },
      projectOverview: { text: "新概述", nature: "EVIDENCE_DERIVED", evidenceRefs: [] },
      specifications: [],
    });
    const rows = diffBriefVersions(before, after);
    const summary = summarizeBriefDiff(rows);
    expect(summary.total).toBe(rows.length);
    expect(summary.manual).toBe(1);
    expect(summary.source).toBeGreaterThanOrEqual(2);
  });
});
