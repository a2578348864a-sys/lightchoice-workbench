import { describe, expect, it } from "vitest";
import type { ProductBrief } from "./contract";
import {
  draftChanges,
  draftFromBrief,
  draftIsDirty,
  draftToPatch,
  dirtySections,
  resolveDraft,
  saveLikelyApplied,
} from "./briefEditing";

function makeBrief(overrides: Partial<ProductBrief> = {}, economics: Partial<ProductBrief["economics"]> = {}): ProductBrief {
  const base: ProductBrief = {
    schemaVersion: "product-brief.v1",
    status: "DRAFT",
    revision: 4,
    generatedAt: "2026-10-19T00:00:00.000Z",
    sourceBinding: {
      taskId: "task-1",
      researchRevision: 2,
      reportHash: "a".repeat(64),
      factHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      marketScanId: "scan-1",
      marketSampleHash: "d".repeat(64),
    },
    identity: { asin: "B0HFS7K4GP", title: "测试商品", imageUrl: null, brand: null, category: null, marketplace: "US" },
    projectOverview: null,
    targetUser: { text: "家庭烘焙用户", nature: "ASSUMPTION", evidenceRefs: [] },
    corePainPoints: [],
    benchmarks: [],
    differentiation: [],
    economics: {
      targetPrice: 15.88,
      targetMarginPct: 30,
      referralFee: 2.4,
      fbaFee: 4.1,
      logistics: null,
      estimatedTax: null,
      otherKnownCosts: null,
      currency: "USD",
      purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "f", reason: "r" },
    },
    specsDirection: [],
    vocQaRedlines: [],
    risks: [],
    rationale: [],
    missingValidation: ["供应商报价未知"],
    specifications: [{ id: "spec-1", label: "尺寸", value: "待验证", unit: null, nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] }],
    confirmationItems: [{ id: "cfq-1", item: "报价与 MOQ", status: "待确认", reason: null }],
    benchmarkComparison: { rows: [] },
    verificationPlan: [{ id: "v_1", item: "供应商报价未知", method: "", timing: "", status: "pending" }],
    positioning: null,
  };
  return { ...base, ...overrides, ...(Object.keys(economics).length ? { economics: { ...base.economics, ...economics } } : {}) };
}

describe("briefEditing · 04 需求单编辑模型", () => {
  it("刚读取的需求单不算未保存", () => {
    const brief = makeBrief();
    expect(draftIsDirty(draftFromBrief(brief), brief)).toBe(false);
    expect(dirtySections(draftFromBrief(brief), brief).size).toBe(0);
  });

  it("旧版需求单缺少对照/验证计划时，兜底行是确定性的且不算修改", () => {
    const legacy = makeBrief({ benchmarkComparison: undefined, verificationPlan: undefined, specifications: undefined, confirmationItems: undefined });
    const draft = draftFromBrief(legacy);
    expect(draft.benchmarkComparison).toHaveLength(4);
    expect(draft.verificationPlan[0]?.item).toBe("供应商报价未知");
    expect(draftIsDirty(draft, legacy)).toBe(false);
  });

  it("只标记真正改动过的章节", () => {
    const brief = makeBrief();
    const draft = { ...draftFromBrief(brief), positioning: "先验证卡扣密封" };
    expect([...dirtySections(draft, brief)]).toEqual(["definition"]);
    expect([...dirtySections({ ...draft, logistics: "1.2" }, brief)].sort()).toEqual(["definition", "economics"]);
  });

  it("保存补丁把空字符串映射为 null，并过滤空行", () => {
    const brief = makeBrief();
    const draft = {
      ...draftFromBrief(brief),
      logistics: "  ",
      positioning: "  ",
      specifications: [...(brief.specifications ?? []), { id: "spec-2", label: "", value: "", unit: null, nature: "ASSUMPTION" as const, verification: "unverified" as const, evidenceRefs: [] }],
    };
    const patch = draftToPatch(draft);
    expect(patch.logistics).toBeNull();
    expect(patch.positioning).toBeNull();
    expect(patch.specifications).toHaveLength(1);
    expect(patch.benchmarkComparison.rows).toHaveLength(0);
  });

  it("基于旧版只提交修改的经济字段，显式清空仍发送 null", () => {
    const base = makeBrief();
    const draft = { ...draftFromBrief(base), targetPrice: "20", referralFee: "", logistics: "0" };
    const patch = draftToPatch(draft, base);
    expect(patch).toMatchObject({ targetPrice: 20, referralFee: null, logistics: 0 });
    expect(patch).not.toHaveProperty("targetMarginPct");
    expect(patch).not.toHaveProperty("estimatedTax");
  });

  it("超时回读只接受来源佣金因售价变化被精确置空", () => {
    const provenance = { referralFee: { origin: "USER_INPUT" as const, source: "candidateAnalysisContext.commercialInputs.commissionRate", note: null } };
    const base = makeBrief({}, { provenance });
    const submitted = { ...draftFromBrief(base), targetPrice: "20" };
    const applied = makeBrief({ revision: 5, status: "READY" }, { targetPrice: 20, referralFee: null, provenance });
    expect(draftToPatch(submitted, base)).not.toHaveProperty("referralFee");
    expect(saveLikelyApplied(base, submitted, "READY", applied)).toBe(true);
    expect(saveLikelyApplied(base, submitted, "READY", makeBrief({ revision: 5, status: "READY" }, { targetPrice: 20, referralFee: 99, provenance }))).toBe(false);
    const manual = makeBrief({}, { provenance: { referralFee: { origin: "USER_INPUT", source: "product-brief-owner", note: null } } });
    expect(saveLikelyApplied(manual, { ...draftFromBrief(manual), targetPrice: "20" }, "READY", applied)).toBe(false);
    expect(saveLikelyApplied(base, { ...submitted, referralFee: "3" }, "READY", applied)).toBe(false);
  });

  it("区分本地改动、远端改动与真实冲突", () => {
    const base = makeBrief();
    const latest = makeBrief({ revision: 5 }, { targetMarginPct: 25, targetPrice: 15.88 });
    const draft = { ...draftFromBrief(base), targetMarginPct: "35", positioning: "本地新增" };
    const changes = draftChanges(draftFromBrief(base), draft, draftFromBrief(latest));
    const byKey = Object.fromEntries(changes.map((row) => [row.key, row]));
    expect(byKey.targetMarginPct.conflict).toBe(true);
    expect(byKey.positioning.localChanged).toBe(true);
    expect(byKey.positioning.conflict).toBe(false);
  });

  it("未选择冲突字段时拒绝生成新草稿，不做静默覆盖", () => {
    const base = draftFromBrief(makeBrief());
    const latest = draftFromBrief(makeBrief({ revision: 5 }, { targetMarginPct: 25 }));
    const draft = { ...base, targetMarginPct: "35" };
    expect(resolveDraft(base, draft, latest, {})).toBeNull();
    expect(resolveDraft(base, draft, latest, { targetMarginPct: "remote" })?.targetMarginPct).toBe("25");
    expect(resolveDraft(base, draft, latest, { targetMarginPct: "local" })?.targetMarginPct).toBe("35");
  });

  it("非冲突改动自动保留：本地改动保留本地，远端改动采用远端", () => {
    const base = draftFromBrief(makeBrief());
    const latest = draftFromBrief(makeBrief({ revision: 5 }, { referralFee: 3.1 }));
    const draft = { ...base, positioning: "本地定位" };
    const resolved = resolveDraft(base, draft, latest, {});
    expect(resolved?.positioning).toBe("本地定位");
    expect(resolved?.referralFee).toBe("3.1");
  });

  it("超时回读只在版本前进、状态一致且内容一致时判定为已保存", () => {
    const base = makeBrief();
    const submitted = { ...draftFromBrief(base), positioning: "提交内容" };
    const applied = makeBrief({ revision: 5, status: "READY", positioning: { text: "提交内容", nature: "ASSUMPTION", evidenceRefs: [] } });
    expect(saveLikelyApplied(base, submitted, "READY", applied)).toBe(true);
    expect(saveLikelyApplied(base, submitted, "DRAFT", applied)).toBe(false);
    expect(saveLikelyApplied(base, submitted, "READY", makeBrief({ revision: 5, status: "READY" }))).toBe(false);
    expect(saveLikelyApplied(base, submitted, "READY", makeBrief({ revision: 4, status: "READY" }))).toBe(false);
  });
});
