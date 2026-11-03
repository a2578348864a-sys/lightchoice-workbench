import { describe, expect, it } from "vitest";
import { calculatePurchaseCostCeiling, parseProductBrief, PRODUCT_BRIEF_MAX_BENCHMARKS } from "./contract";

describe("Product Brief contract", () => {
  it("calculates a deterministic purchase cost ceiling from explicit inputs", () => {
    expect(calculatePurchaseCostCeiling({ targetPrice: 40, targetMarginPct: 25, referralFee: 6, fbaFee: 8, logistics: 3, estimatedTax: 1 }).value).toBe(12);
  });

  it("fails closed when known economics are missing", () => {
    expect(calculatePurchaseCostCeiling({ targetPrice: 40, targetMarginPct: 25, referralFee: null, fbaFee: 8, logistics: 3, estimatedTax: 1 }).status).toBe("NOT_COMPUTABLE");
  });

  it("does not accept an arbitrary object as a saved brief", () => {
    expect(parseProductBrief({ schemaVersion: "product-brief.v1" })).toBeNull();
  });

  it("limits a Product Brief to at most three benchmark identities", () => {
    const benchmarks = Array.from({ length: 5 }, (_, index) => ({
      asin: `B00000000${index}`,
      marketplace: "US",
      role: "benchmark",
      evidenceRefs: [],
    }));
    const parsed = parseProductBrief({
      schemaVersion: "product-brief.v1",
      sourceBinding: { taskId: "task-1" },
      identity: { asin: "B000000001" },
      economics: { purchaseCostCeiling: {} },
      benchmarks,
    });
    expect(PRODUCT_BRIEF_MAX_BENCHMARKS).toBe(3);
    expect(parsed?.benchmarks).toHaveLength(3);
  });

  const baseBrief = () => ({
    schemaVersion: "product-brief.v1",
    sourceBinding: { taskId: "task-1" },
    identity: { asin: "B000000001" },
    economics: { purchaseCostCeiling: {} },
  });

  it("P0-BR-A1/A4/A5 + 确认事项: 解析新增可选段（规格/确认事项/对照/验证计划）", () => {
    const parsed = parseProductBrief({
      ...baseBrief(),
      specifications: [
        { id: "spec_1", label: "单品尺寸", value: "10×5×3", unit: "cm", nature: "FACT", verification: "unverified", evidenceRefs: ["evidence:ev-1"] },
        { id: "spec_2", label: "材质", value: "304 不锈钢", unit: null, nature: "ASSUMPTION", verification: "verified", evidenceRefs: [] },
      ],
      confirmationItems: [
        { id: "cfq_moq", item: "起订量（MOQ）与阶梯报价是否满足首单需求", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_custom", item: "是否支持结构优化", status: "已确认", reason: null },
      ],
      benchmarkComparison: {
        rows: [
          { id: "cmp_price", label: "价格", ours: "24.75 USD", theirs: null, nature: "FACT", note: "对照基准：B000000002" },
          { id: "cmp_custom", label: "差异点", ours: null, theirs: "更厚杯壁", nature: "ASSUMPTION", note: null },
        ],
      },
      verificationPlan: [
        { id: "v1", item: "目标售价待确认", method: "竞品价格带复核", timing: "本周", status: "pending" },
        { id: "v2", item: "包装跌落测试", method: "", timing: "", status: "done" },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.specifications).toHaveLength(2);
    expect(parsed?.specifications?.[0].nature).toBe("FACT");
    // 无引用的人工规格不得凭下拉选择保留「已验证」。
    expect(parsed?.specifications?.[1].verification).toBe("unverified");
    expect(parsed?.confirmationItems).toHaveLength(2);
    expect(parsed?.confirmationItems?.[0].status).toBe("待确认");
    expect(parsed?.confirmationItems?.[0].reason).toBe("需要供应商确认");
    expect(parsed?.confirmationItems?.[1].status).toBe("已确认");
    expect(parsed?.benchmarkComparison?.rows).toHaveLength(2);
    // 对照行没有逐字段来源绑定，读取时不得保留 FACT。
    expect(parsed?.benchmarkComparison?.rows[0].nature).toBe("ASSUMPTION");
    expect(parsed?.benchmarkComparison?.rows[0].ours).toBe("24.75 USD");
    expect(parsed?.verificationPlan).toHaveLength(2);
    expect(parsed?.verificationPlan?.[1].status).toBe("done");
  });

  it("P0-BR-A1 红线：无证据引用的规格行不得保持 FACT（强制 ASSUMPTION）", () => {
    const parsed = parseProductBrief({
      ...baseBrief(),
      specifications: [{ id: "spec_x", label: "重量", value: "1.2", unit: "kg", nature: "FACT", verification: "unverified", evidenceRefs: [] }],
    });
    expect(parsed?.specifications?.[0].nature).toBe("ASSUMPTION");
  });

  it("P0-BR: 旧版快照（无新增字段）解析后新增段为缺省，不报错", () => {
    const parsed = parseProductBrief(baseBrief());
    expect(parsed).not.toBeNull();
    expect(parsed?.specifications).toBeUndefined();
    expect(parsed?.confirmationItems).toBeUndefined();
    expect(parsed?.benchmarkComparison).toBeUndefined();
    expect(parsed?.verificationPlan).toBeUndefined();
  });

  it("P0-BR（追加修正）: 确认事项非法状态回落为待确认、缺 item 行被过滤；不存在任何供应链数值字段", () => {
    const parsed = parseProductBrief({
      ...baseBrief(),
      confirmationItems: [
        { id: "cfq_1", item: "合法事项", status: "奇怪的枚举", reason: null },
        { id: "cfq_2", item: "", status: "待确认", reason: "缺 item 被过滤" },
      ],
    });
    expect(parsed?.confirmationItems).toHaveLength(1);
    expect(parsed?.confirmationItems?.[0].status).toBe("待确认");
    // 追加修正红线：旧 supplyChain 结构不再解析（未知键被忽略），moq 数值不进入 Brief
    const legacy = parseProductBrief({ ...baseBrief(), supplyChain: { moq: 9999, inquiryPoints: [{ text: "x", nature: "ASSUMPTION", evidenceRefs: [] }] } });
    expect(legacy?.confirmationItems).toBeUndefined();
    expect(JSON.stringify(legacy)).not.toContain("9999");
    expect(JSON.stringify(legacy)).not.toContain("supplyChain");
  });

  it("P0-BR-A5: 非法状态/缺 item 的验证计划行被过滤（fail-closed）", () => {
    const parsed = parseProductBrief({
      ...baseBrief(),
      verificationPlan: [
        { id: "v1", item: "合法项", method: "", timing: "", status: "unknown_enum" },
        { id: "v2", item: "", method: "缺 item", timing: "", status: "pending" },
      ],
    });
    expect(parsed?.verificationPlan).toHaveLength(1);
    expect(parsed?.verificationPlan?.[0].status).toBe("pending");
  });

  it("P0-BR-BR02: positioning/userScenarios 解析（研报搬运、显式 null、人工填写按 ASSUMPTION 降级）", () => {
    const withSegments = parseProductBrief({
      ...baseBrief(),
      positioning: { text: "以加固结构为核心卖点的户外水杯", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:ev-9"] },
      userScenarios: [
        { text: "露营场景下的保温需求", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:ev-10"] },
        { text: "", nature: "ASSUMPTION", evidenceRefs: [] },
      ],
    });
    expect(withSegments?.positioning?.nature).toBe("EVIDENCE_DERIVED");
    expect(withSegments?.userScenarios).toHaveLength(1);
    const manual = parseProductBrief({ ...baseBrief(), positioning: { text: "人工填写的定位", nature: "FACT", evidenceRefs: [] } });
    expect(manual?.positioning?.nature).toBe("ASSUMPTION");
    const explicitNull = parseProductBrief({ ...baseBrief(), positioning: null });
    expect(explicitNull?.positioning).toBeNull();
  });

  it("P0-BR-BR02: 旧版快照无 positioning/userScenarios 键时保持缺省（兼容读）", () => {
    const parsed = parseProductBrief(baseBrief());
    expect(parsed?.positioning).toBeUndefined();
    expect(parsed?.userScenarios).toBeUndefined();
  });

  it("P3-03: 经济性输入解析并保留来源性质，非法性质收敛为 MISSING", () => {
    const parsed = parseProductBrief({
      ...baseBrief(),
      economics: {
        targetPrice: 29.9,
        targetMarginPct: null,
        purchaseCostCeiling: {},
        provenance: {
          targetPrice: { origin: "PRODUCT_FACT", source: "ProductFact.basic.price", note: "仅作目标价草案" },
          targetMarginPct: { origin: "not-a-real-origin", source: "owner", note: "待填写" },
          logistics: { origin: "USER_INPUT", source: "product-brief-owner", note: "人工输入" },
        },
      },
    });
    expect(parsed?.economics.provenance?.targetPrice).toEqual({ origin: "PRODUCT_FACT", source: "ProductFact.basic.price", note: "仅作目标价草案" });
    expect(parsed?.economics.provenance?.targetMarginPct?.origin).toBe("MISSING");
    expect(parsed?.economics.provenance?.logistics?.origin).toBe("USER_INPUT");
  });
});
