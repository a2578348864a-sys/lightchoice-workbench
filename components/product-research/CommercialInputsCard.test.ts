import { describe, expect, it } from "vitest";
import { commercialInputsSaveState, type CommercialInputsForm } from "./CommercialInputsCard";

const empty: CommercialInputsForm = {
  targetSellingPriceValue: "", targetSellingPriceCurrency: "USD",
  purchasePriceValue: "", purchasePriceCurrency: "CNY", moq: "",
  logisticsValue: "", logisticsCurrency: "CNY",
  packageWeightValue: "", packageWeightUnit: "kg",
  packageLength: "", packageWidth: "", packageHeight: "", packageDimensionUnit: "cm",
  shippingRatePerKg: "", shippingMode: "custom_rate", fbaFeeValue: "", fbaFeeCurrency: "USD",
  commissionRatePercent: "", adCostRatePercent: "", exchangeRate: "",
  platformFeeNature: "user_scenario", platformFeeSourceNote: "", platformFeeEffectiveDate: "",
  complianceStatus: "not_reviewed", complianceNote: "",
};
const loaded = { loaded: true, saving: false, error: "" };

describe("成本表单保存反馈", () => {
  it("仅输入与撤回输入不会冒充服务端保存", () => {
    const typed = { ...empty, purchasePriceValue: "12.34" };
    expect(commercialInputsSaveState(typed, empty, loaded).kind).toBe("dirty");
    expect(commercialInputsSaveState(typed, empty, loaded).label).not.toContain("已保存");
    expect(commercialInputsSaveState(empty, empty, loaded).kind).toBe("empty");
  });

  it("已有服务端确认内容再次修改时，仍提示未保存", () => {
    const confirmed = { ...empty, purchasePriceValue: "12.34" };
    expect(commercialInputsSaveState(confirmed, confirmed, loaded).kind).toBe("saved");
    expect(commercialInputsSaveState({ ...confirmed, purchasePriceValue: "13" }, confirmed, loaded).kind).toBe("dirty");
    expect(commercialInputsSaveState(confirmed, confirmed, loaded).kind).toBe("saved");
  });

  it("确认的0是有效保存值，缺失仍保持空值", () => {
    const confirmed = { ...empty, purchasePriceValue: "0" };
    expect(commercialInputsSaveState(confirmed, confirmed, loaded).kind).toBe("saved");
    expect(commercialInputsSaveState(empty, empty, loaded).kind).toBe("empty");
  });

  it("保存响应尚未返回时不能提前显示成功", () => {
    const typed = { ...empty, purchasePriceValue: "12.34" };
    expect(commercialInputsSaveState(typed, empty, { ...loaded, saving: true }).kind).toBe("saving");
    expect(commercialInputsSaveState(typed, empty, loaded).kind).toBe("dirty");
    expect(commercialInputsSaveState(typed, { ...typed }, loaded).kind).toBe("saved");
  });

  it("失败与CAS冲突不改变输入或上次已确认内容", () => {
    const typed = { ...empty, purchasePriceValue: "12.34" };
    const state = commercialInputsSaveState(typed, empty, { ...loaded, error: "资料已被其它操作更新" });
    expect(state.kind).toBe("error");
    expect(state.label).toContain("输入已保留");
    expect(typed.purchasePriceValue).toBe("12.34");
    expect(empty.purchasePriceValue).toBe("");
  });

  it("读取中与读取失败不能显示为没有保存内容", () => {
    expect(commercialInputsSaveState(empty, empty, { ...loaded, loaded: false }).kind).toBe("loading");
    expect(commercialInputsSaveState(empty, empty, { ...loaded, loaded: false, error: "读取失败" }).kind).toBe("load_error");
  });
});
