import { describe, expect, it } from "vitest";
import { isCompletedForInputs, parseCommercialInputs } from "@/lib/server/commercialInputs";

describe("商业输入校验（轮 6）", () => {
  it("部分保存：单字段也可保存；0 为合法值（不得当空值）", () => {
    expect(parseCommercialInputs({ moq: 50 })).toEqual({ ok: true, inputs: { moq: 50 } });
    expect(parseCommercialInputs({ purchasePrice: { value: 0, currency: "CNY" } })).toEqual({
      ok: true, inputs: { purchasePrice: { value: 0, currency: "CNY" } },
    });
    expect(parseCommercialInputs({ logisticsCost: { value: 12.5, currency: "USD" } })).toEqual({
      ok: true, inputs: { logisticsCost: { value: 12.5, currency: "USD" } },
    });
  });

  it("MOQ 必须正整数（0/小数/负数/字符串拒绝）", () => {
    for (const bad of [0, -1, 1.5, "5", null, undefined]) {
      const r = parseCommercialInputs({ moq: bad });
      if (bad === undefined) { /* empty→empty error */ }
      expect(r.ok).toBe(false);
    }
    expect(parseCommercialInputs({ moq: 1 })).toEqual({ ok: true, inputs: { moq: 1 } });
  });

  it("未知字段拒绝；备注超长拒绝；货币/合规枚举拒绝；空提交拒绝", () => {
    expect(parseCommercialInputs({ hacker: 1 })).toEqual({ ok: false, error: "unknown_field:hacker" });
    expect(parseCommercialInputs({ compliance: { status: "reviewed_ok", note: "x".repeat(501) } })).toEqual({ ok: false, error: "compliance_note_too_long" });
    expect(parseCommercialInputs({ purchasePrice: { value: 1, currency: "JPY" } })).toEqual({ ok: false, error: "purchasePrice_invalid" });
    expect(parseCommercialInputs({ compliance: { status: "maybe" } })).toEqual({ ok: false, error: "compliance_status_invalid" });
    expect(parseCommercialInputs({})).toEqual({ ok: false, error: "commercial_inputs_empty" });
    expect(parseCommercialInputs({ purchasePrice: { value: -1, currency: "CNY" } })).toEqual({ ok: false, error: "purchasePrice_invalid" });
  });

  it("已完成研究：写入商业输入视为对已完成研究的改动（沿用重新确认机制，不允许直接覆盖）", () => {
    expect(isCompletedForInputs({ researchCompletion: { schema: "research-completion.v1", status: "completed" } })).toBe(true);
    expect(isCompletedForInputs({ researchCompletion: { schema: "research-completion.v1", status: "abandoned" } })).toBe(false);
    expect(isCompletedForInputs({})).toBe(false);
  });
});

describe("V6 单位经济性情景输入校验", () => {
  it("包装重量/尺寸、平台费用与经营假设可保存（0 与 0% 均为合法值）", () => {
    const parsed = parseCommercialInputs({
      targetSellingPrice: { value: 12.99, currency: "USD" },
      packageWeight: { value: 350, unit: "g" },
      packageDimensions: { length: 21, width: 8.5, height: 4, unit: "cm" },
      shippingRatePerKg: 2.5,
      shippingMode: "custom_rate",
      fbaFee: { value: 4.25, currency: "USD" },
      commissionRate: 0.15,
      adCostRate: 0,
      exchangeRate: 7.2,
      platformFeeNature: "official_reference",
      platformFeeSourceNote: "Amazon FBA 费率页",
      platformFeeEffectiveDate: "2026-01-15",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.inputs.commissionRate).toBe(0.15);
    expect(parsed.inputs.adCostRate).toBe(0);
    expect(parsed.inputs.packageWeight).toEqual({ value: 350, unit: "g" });
    expect(parsed.inputs.packageDimensions).toEqual({ length: 21, width: 8.5, height: 4, unit: "cm" });
    expect(parsed.inputs.platformFeeEffectiveDate).toBe("2026-01-15");
  });

  it("非法包装/费率/汇率/日期被拒绝", () => {
    expect(parseCommercialInputs({ packageWeight: { value: 0, unit: "kg" } })).toEqual({ ok: false, error: "packageWeight_invalid" });
    expect(parseCommercialInputs({ packageWeight: { value: 1, unit: "ton" } })).toEqual({ ok: false, error: "packageWeight_invalid" });
    expect(parseCommercialInputs({ packageDimensions: { length: 1, width: 2, height: 0, unit: "cm" } })).toEqual({ ok: false, error: "packageDimensions_invalid" });
    expect(parseCommercialInputs({ packageDimensions: { length: 1, width: 2, height: 3, unit: "mm" } })).toEqual({ ok: false, error: "packageDimensions_invalid" });
    expect(parseCommercialInputs({ commissionRate: 1.5 })).toEqual({ ok: false, error: "commissionRate_out_of_range" });
    expect(parseCommercialInputs({ adCostRate: -0.1 })).toEqual({ ok: false, error: "adCostRate_out_of_range" });
    expect(parseCommercialInputs({ exchangeRate: 0 })).toEqual({ ok: false, error: "exchangeRate_invalid" });
    expect(parseCommercialInputs({ shippingMode: "rocket" })).toEqual({ ok: false, error: "shippingMode_invalid" });
    expect(parseCommercialInputs({ platformFeeNature: "guess" })).toEqual({ ok: false, error: "platformFeeNature_invalid" });
    expect(parseCommercialInputs({ platformFeeEffectiveDate: "2026/01/15" })).toEqual({ ok: false, error: "platformFeeEffectiveDate_invalid" });
    expect(parseCommercialInputs({ platformFeeSourceNote: "x".repeat(201) })).toEqual({ ok: false, error: "platformFeeSourceNote_too_long" });
  });

  it("旧结构（仅采购价/MOQ/物流/合规）继续可读——向后兼容", () => {
    const parsed = parseCommercialInputs({
      purchasePrice: { value: 12, currency: "CNY" },
      moq: 500,
      logisticsCost: { value: 8, currency: "CNY" },
      compliance: { status: "reviewed_ok" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.inputs.purchasePrice).toEqual({ value: 12, currency: "CNY" });
    expect(parsed.inputs.moq).toBe(500);
    expect(parsed.inputs.logisticsCost).toEqual({ value: 8, currency: "CNY" });
    expect(parsed.inputs.compliance).toEqual({ status: "reviewed_ok" });
  });
});
