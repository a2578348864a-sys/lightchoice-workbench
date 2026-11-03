import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UnitEconomicsView, UnitEconomicsViewLine, UnitEconomicsViewMetric } from "@/lib/research/researchContracts";
import { UnitEconomicsResultCard, formatMoney, formatRatio } from "@/components/research/UnitEconomicsResultCard";

function line(
  key: string,
  label: string,
  amountUsd: number | null,
  nature: UnitEconomicsViewLine["nature"] = "USER_INPUT",
  extra: Partial<UnitEconomicsViewLine> = {},
): UnitEconomicsViewLine {
  return {
    key,
    label,
    amountUsd,
    nature,
    source: nature === "CONFIRMED_REFERENCE" ? "sellersprite_plugin" : "user_input",
    effectiveDate: "2026-10-16T00:00:00.000Z",
    state: "READY",
    note: null,
    ...extra,
  };
}

function metric(key: string, label: string, value: number | null, unit: "usd" | "ratio", reason: string | null = null): UnitEconomicsViewMetric {
  return { key, label, value, unit, status: value === null ? "not_computable" : "available", reason };
}

function availableView(): UnitEconomicsView {
  return {
    schema: "unit-economics-view.v1",
    status: "available",
    currency: "USD",
    computedAt: "2026-10-16T00:00:00.000Z",
    isPartialCostBasis: true,
    excludedCosts: ["退货与售后损失", "关税与进口税"],
    conditionalExcludedCosts: [],
    alwaysExcludedCosts: ["退货与售后损失", "关税与进口税"],
    commissionIncluded: true,
    freightBasis: "per_unit",
    chargeableWeightKg: null,
    sellingPrice: line("sellingPrice", "商品售价", 9.99, "CONFIRMED_REFERENCE", { note: "来源事实售价" }),
    costLines: [
      line("procurementCost", "单件采购成本", 2.78),
      line("shipping", "包装与头程成本", 0.83),
      line("landedCost", "到岸成本合计", 3.61),
      line("commission", "平台佣金", 1.5),
      line("fbaFee", "FBA 配送费用", 4.25),
      line("adCost", "广告及其他费用", 1.0),
      line("totalCost", "单件成本合计", 10.36),
    ],
    totalUnitCostUsd: 10.36,
    metrics: [
      metric("grossProfit", "毛利", 0.63, "usd"),
      metric("grossMargin", "毛利率", 0.063, "ratio"),
      metric("netProfit", "单件预计利润（净）", -0.37, "usd"),
      metric("netMargin", "预计利润率（净）", -0.037, "ratio"),
      metric("roi", "ROI（对到岸成本）", -0.1025, "ratio"),
      metric("breakEvenPrice", "保本售价", 10.48, "usd"),
    ],
    inputProvenance: [
      line("sellingPrice", "商品售价", null, "CONFIRMED_REFERENCE"),
      line("procurementCost", "单件采购成本", null, "USER_INPUT"),
      line("fbaFee", "FBA 配送费用", null, "USER_INPUT"),
    ],
    reasons: [],
    formulaNotes: [
      "到岸成本 = 采购成本 + 头程成本 = 2.78 + 0.83 = 3.61 USD",
      "净利 = 售价 − 单件成本合计（含广告费用与平台佣金）",
      "保本售价 = (到岸成本 + FBA 费用) ÷ (1 − 目标广告费率 − 平台佣金率)",
      "ROI = 净利 ÷ 到岸成本",
    ],
  };
}

function notComputableView(): UnitEconomicsView {
  return {
    ...availableView(),
    status: "not_computable",
    isPartialCostBasis: true,
    costLines: [],
    totalUnitCostUsd: null,
    metrics: [
      metric("netProfit", "单件预计利润（净）", null, "usd", "缺少目标广告费率；不默认按 0 计算广告成本。"),
      metric("breakEvenPrice", "保本售价", null, "usd", "缺少目标广告费率；不默认按 0 计算广告成本。"),
    ],
    excludedCosts: ["平台佣金（Amazon 佣金/推荐费）", "退货与售后损失", "关税与进口税"],
    conditionalExcludedCosts: ["平台佣金（Amazon 佣金/推荐费）"],
    alwaysExcludedCosts: ["退货与售后损失", "关税与进口税"],
    reasons: ["缺少目标广告费率；不默认按 0 计算广告成本。"],
    formulaNotes: [],
  };
}

describe("UnitEconomicsResultCard", () => {
  it("可计算时展示售价、成本构成、合计、利润与保本售价，并显式列出未纳入费用", () => {
    const html = renderToStaticMarkup(createElement(UnitEconomicsResultCard, { view: availableView() }));

    expect(html).toContain("商品售价");
    expect(html).toContain("$9.99");
    expect(html).toContain("单件成本合计");
    expect(html).toContain("$10.36");
    expect(html).toContain("单件预计利润（仅已计费用）");
    expect(html).toContain("预计利润率（仅已计费用）");
    expect(html).toContain("参考保本售价（仅已计费用）");
    expect(html).toContain("ROI（仅已计费用 / 到岸成本）");
    expect(html).not.toContain("单件预计利润（净）");
    expect(html).not.toContain("预计利润率（净）");
    expect(html).not.toContain("净利 = 售价");
    expect(html).toContain("预计利润（仅已计费用） = 售价");
    expect(html).toContain("ROI（仅已计费用） = 预计利润 ÷ 到岸成本");
    expect(html).toContain("$10.48");
    expect(html).toContain("部分成本口径（非完整净利润）");
    expect(html).toContain("退货与售后损失");
    expect(html).toContain("计算依据（可复算）");
    expect(html).toContain("来源引用");
    expect(html).toContain("用户输入");
    expect(html).toContain("不会自动推进人工决策");
  });

  it("完整成本口径沿用服务端标签，不把所有结果都改成部分成本", () => {
    const html = renderToStaticMarkup(createElement(UnitEconomicsResultCard, {
      view: { ...availableView(), isPartialCostBasis: false, excludedCosts: [], alwaysExcludedCosts: [] },
    }));
    expect(html).toContain("单件预计利润（净）");
    expect(html).toContain("净利 = 售价");
    expect(html).not.toContain("部分成本口径（非完整净利润）");
  });

  it("不可计算时明确写出原因，且不产生任何金额", () => {
    const html = renderToStaticMarkup(createElement(UnitEconomicsResultCard, { view: notComputableView() }));

    expect(html).toContain("不可计算");
    expect(html).toContain("缺少目标广告费率");
    expect(html).toContain("平台佣金（Amazon 佣金/推荐费）");
    expect(html).not.toContain("$10.36");
    expect(html).not.toContain("单件成本合计");
  });

  it("无视图时给出中性说明，不编造数据", () => {
    const html = renderToStaticMarkup(createElement(UnitEconomicsResultCard, { view: null }));
    expect(html).toContain("商业成本与利润测算结果");
    expect(html).toContain("暂时无法组装测算结果");
    expect(html).not.toContain("保本售价");
  });

  it("使用内置固定汇率时，在结果旁直接说明假设数值和非实时性质", () => {
    const view = availableView();
    const exchange = line("exchangeRate", "汇率", null, "ESTIMATED", {
      source: "internal_fixed_assumption",
      note: "未填写时使用 7.2 CNY/USD 的内置固定假设，非实时汇率。",
    });
    const html = renderToStaticMarkup(createElement(UnitEconomicsResultCard, {
      view: { ...view, inputProvenance: [...view.inputProvenance, exchange] },
      compactProvenance: true,
    }));
    expect(html).toMatch(/data-testid="ue-fixed-rate-note"[^>]*>[^<]*7\.2 CNY\/USD/);
    expect(html).toContain("非实时汇率");
  });

  it("紧凑阅读保留全部计算结果、缺口与来源元数据", () => {
    for (const view of [availableView(), notComputableView()]) {
      const full = renderToStaticMarkup(createElement(UnitEconomicsResultCard, { view }));
      const compact = renderToStaticMarkup(createElement(UnitEconomicsResultCard, { view, compactProvenance: true }));
      const text = (html: string) => html.replace(/<[^>]*>/g, "");
      expect(text(compact)).toBe(text(full));
      expect(compact).toMatch(/<details[^>]*data-testid="ue-provenance-details"/);
    }
  });

  it("格式化函数遵循币种，缺失值不显示为 0", () => {
    expect(formatMoney(9.99, "USD")).toBe("$9.99");
    expect(formatMoney(9.99, "CNY")).toBe("¥9.99");
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatRatio(0.1234)).toBe("12.34%");
    expect(formatRatio(null)).toBe("—");
  });
});
