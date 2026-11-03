import { describe, expect, it } from "vitest";
import { PRODUCT_BRIEF_SCHEMA, type ProductBrief } from "./contract";
import { buildEconomicsStateView } from "./briefEconomicsStates";

const brief = (overrides: Partial<ProductBrief> = {}, economics: Partial<ProductBrief["economics"]> = {}): ProductBrief => ({
  schemaVersion: PRODUCT_BRIEF_SCHEMA,
  status: "READY",
  revision: 3,
  generatedAt: "2026-10-05T00:00:00.000Z",
  sourceBinding: { taskId: "t", researchRevision: 2, reportHash: "r", factHash: "f", evidenceHash: "e", marketScanId: null, marketSampleHash: null },
  identity: { asin: "B0HFS7K4GP", title: "硅胶垫", imageUrl: null, brand: null, category: null, marketplace: "US" },
  projectOverview: null,
  targetUser: null,
  corePainPoints: [],
  benchmarks: [],
  differentiation: [],
  economics: {
    targetPrice: 15.88,
    targetMarginPct: 35,
    referralFee: 2.38,
    fbaFee: null,
    logistics: 1.2,
    estimatedTax: null,
    otherKnownCosts: null,
    currency: "USD",
    purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "x", reason: "缺 FBA 费用" },
    ...economics,
  },
  specsDirection: [],
  vocQaRedlines: [],
  risks: [],
  rationale: [],
  missingValidation: [],
  ...overrides,
});

const byKey = (view: ReturnType<typeof buildEconomicsStateView>, key: string) => view.fields.find((field) => field.key === key)!;

describe("buildEconomicsStateView（经济性四态口径）", () => {
  it("有值且有效：显示真实数值，不写成「尚未填写」", () => {
    const view = buildEconomicsStateView(
      brief({
        economics: {
          ...brief().economics,
          provenance: {
            targetMarginPct: { origin: "USER_INPUT", source: "owner", note: null },
            referralFee: { origin: "USER_INPUT", source: "owner", note: null },
            logistics: { origin: "USER_INPUT", source: "owner", note: null },
          },
        },
      }),
      { stale: false },
    );
    const margin = byKey(view, "targetMarginPct");
    const referral = byKey(view, "referralFee");
    const logistics = byKey(view, "logistics");
    expect(margin.display).toBe("35%");
    expect(margin.state).toBe("EFFECTIVE");
    expect(referral.display).toBe("2.38 USD");
    expect(logistics.display).toBe("1.2 USD");
    expect([margin, referral, logistics].map((field) => field.display).join()).not.toMatch(/未提供/);
  });

  it("有值但来源失效：标为历史保存值，仍显示数值且说明不能直接沿用", () => {
    const view = buildEconomicsStateView(brief(), { stale: true });
    const margin = byKey(view, "targetMarginPct");
    expect(margin.display).toBe("35%");
    expect(margin.state).toBe("SAVED_UNVERIFIED");
    expect(margin.stateLabel).toContain("历史保存值");
    expect(margin.note).toContain("不能直接沿用");
  });

  it("当前缺失：明说缺失，且不把 null 显示成 0", () => {
    const view = buildEconomicsStateView(brief(), { stale: false });
    const fba = byKey(view, "fbaFee");
    expect(fba.display).toBe("未提供");
    expect(fba.state).toBe("MISSING");
    expect(view.gaps.map((field) => field.key)).toContain("fbaFee");
  });

  it("估算 / 商品事实来源的值不算人工确认，标为需人工确认", () => {
    const view = buildEconomicsStateView(
      brief({ economics: { ...brief().economics, provenance: { referralFee: { origin: "RESEARCH_ESTIMATE", source: "卖家精灵", note: null } } } }),
      { stale: false },
    );
    const referral = byKey(view, "referralFee");
    expect(referral.state).toBe("SAVED_UNVERIFIED");
    expect(referral.stateLabel).toContain("非人工确认");
    expect(referral.source).toContain("研究估算");
  });

  it("人工输入且绑定有效才算「已有有效值」", () => {
    const view = buildEconomicsStateView(
      brief({ economics: { ...brief().economics, provenance: { targetMarginPct: { origin: "USER_INPUT", source: "owner", note: null } } } }),
      { stale: false },
    );
    expect(byKey(view, "targetMarginPct").state).toBe("EFFECTIVE");
    expect(byKey(view, "targetMarginPct").source).toBe("人工输入");
  });

  it("旧需求单没有 provenance：值存在但标为历史保存值（既不能说缺失，也不能说已确认）", () => {
    const view = buildEconomicsStateView(brief(), { stale: false });
    const margin = byKey(view, "targetMarginPct");
    expect(margin.display).toBe("35%");
    expect(margin.state).toBe("SAVED_UNVERIFIED");
    expect(margin.stateLabel).toBe("历史保存值（来源未记录）");
    expect(margin.note).toContain("不能当作「当前缺失」");
  });

  it("采购成本上限：可计算显示数值，不可计算给出真实原因", () => {
    const computed = buildEconomicsStateView(
      brief({ economics: { ...brief().economics, purchaseCostCeiling: { status: "COMPUTED", value: 4.2, currency: "USD", formula: "售价 - 费用", reason: null } } }),
      { stale: false },
    );
    expect(computed.ceiling.display).toBe("4.2 USD");
    expect(computed.ceiling.state).toBe("EFFECTIVE");

    const blocked = buildEconomicsStateView(brief(), { stale: false });
    expect(blocked.ceiling.state).toBe("NOT_COMPUTABLE");
    expect(blocked.ceiling.note).toContain("缺 FBA 费用");
  });

  it("概述句区分「有值 / 需补齐 / 已失效」，不把历史值说成从来没填", () => {
    const fresh = buildEconomicsStateView(brief(), { stale: false });
    expect(fresh.summaryLine).toContain("已有值");
    const stale = buildEconomicsStateView(brief(), { stale: true });
    expect(stale.summaryLine).toContain("历史保存值");
    expect(stale.summaryLine).not.toContain("当前缺失 7 项");
  });

  it("缺项时给出粗略上界（缺失项按 0，会高估），并明确不是正式上限", () => {
    const view = buildEconomicsStateView(brief(), { stale: false });
    expect(view.ceiling.state).toBe("NOT_COMPUTABLE");
    expect(view.upperBound).not.toBeNull();
    // 15.88 - 2.38 - 1.2 - 0 - 0 - 15.88*35% = 6.74（税费/其他在本 fixture 为空，按 0 计）
    expect(view.upperBound!.value).toBe(6.74);
    expect(view.upperBound!.missingInputs).toContain("FBA 费用");
    expect(view.upperBound!.note).toContain("不是采购成本上限");
  });

  it("没有需求单时全部缺失，不报错", () => {
    const view = buildEconomicsStateView(null, { stale: false });
    expect(view.fields.every((field) => field.state === "MISSING" || field.state === "NOT_COMPUTABLE")).toBe(true);
    expect(view.effective).toEqual([]);
  });
});
