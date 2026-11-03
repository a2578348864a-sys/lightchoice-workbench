/**
 * PH4 Variation：多维属性映射来源证明回归
 *
 * 覆盖任务要求的正例与负例。权威来源 = 页面自己声明的
 * `twisterJSInitData.dimensions` + `variation_values` + `dimToAsinMapData`。
 */
import { describe, expect, it } from "vitest";

import { normalizeAmazonVariationPageCapture } from "./variation-page-extract";

const ASIN = "B0CLY1KWLB";
const PARENT = "B0DMQ2YQLJ";

function identity(pageAsin = ASIN) {
  return { urlAsin: ASIN, pageAsin, productContainerFound: true, pageStatus: "ok" };
}

function run(raw: Record<string, unknown>, pageAsin = ASIN) {
  return normalizeAmazonVariationPageCapture({
    expectedAsin: ASIN,
    sourceUrl: `https://www.amazon.com/dp/${ASIN}?th=1`,
    capturedAt: "2026-10-09T13:00:00.000Z",
    identity: identity(pageAsin),
    raw,
  });
}

/** 真实页面形状（B0CLY1KWLB 实测）：2 维、尺寸 6 值、颜色 26 值、32 个唯一 ASIN。 */
const SIZES = ["18 Ounces", "NBA 25oz", "25 Ounces", "25 Ounces (Pack of 3)", "32 Ounces", "32 Ounces (Pack of 3)"];
const COLORS = ["Neon Crush", "Navy", "Utah Jazz", "Lavender", "Jade", "Black"];
const TWO_DIM = {
  parentAsin: PARENT,
  dimensionToAsinMap: { "0_0": ASIN, "0_1": "B0BB3KD2JD", "2_2": "B0DNG17K2D" },
  variationDisplayLabels: { size_name: "Size", color_name: "Color" },
  dimensions: ["size_name", "color_name"],
  variationValues: { size_name: SIZES, color_name: COLORS },
  dimensionOrderSource: "twister_js_init_data",
  variationRootFound: true,
  jsonStateFound: true,
};

describe("PH4 Variation 权威维度顺序（DOM 无属性组时）", () => {
  it("双维合法映射 → 每个ASIN 拿到真实维度名与值，且不依赖 DOM", () => {
    const r = run(TWO_DIM);
    console.log("[V1] status=", r.status, "diag.authoritative=", r.diagnostics.authoritativeDimensionOrder);
    const byAsin = new Map(r.variants.map((v) => [v.asin, v.options]));
    console.log("[V1] current options=", JSON.stringify(byAsin.get(ASIN)));
    console.log("[V1] dimensions=", JSON.stringify(r.dimensions));

    expect(r.status).toBe("COMPLETE");
    expect(r.diagnostics.authoritativeDimensionOrder).toBe(true);
    expect(r.diagnostics.authoritativeDimensionOrderSource).toBe("twister_js_init_data");
    // 索引 0_0 → sizes[0] + colors[0]
    expect(byAsin.get(ASIN)).toEqual([
      { dimensionKey: "size_name", label: "Size", value: "18 Ounces" },
      { dimensionKey: "color_name", label: "Color", value: "Neon Crush" },
    ]);
    // 维度表用页面声明的值
    expect(r.dimensions.find((d) => d.key === "size_name")?.options).toEqual(SIZES);
    expect(r.dimensions.find((d) => d.key === "color_name")?.options).toEqual(COLORS);
  });

  it("维度顺序声明了没有值表的维度 → 顺序证明不完整，必须拒绝", () => {
    const r = run({
      ...TWO_DIM,
      // 页面声明了第三个维度，但没有它的值表 → 无法证明每个 ASIN 在该维度的取值
      dimensions: ["size_name", "color_name", "style_name"],
      dimensionToAsinMap: { "0_0_0": ASIN },
      variationValues: { size_name: SIZES, color_name: COLORS },
    });
    console.log("[V2] status=", r.status, "diag.authoritative=", r.diagnostics.authoritativeDimensionOrder);
    expect(r.diagnostics.authoritativeDimensionOrder).toBe(false);
    expect(r.status).not.toBe("COMPLETE");
  });

  it("缺少维度顺序声明（无 dimensions）→ 退回 PARTIAL，不盲配", () => {
    const r = run({ ...TWO_DIM, dimensions: undefined });
    console.log("[V3] status=", r.status, "diag.authoritative=", r.diagnostics.authoritativeDimensionOrder);
    expect(r.diagnostics.authoritativeDimensionOrder).toBe(false);
    expect(r.status).not.toBe("COMPLETE");
  });

  it("维度值表有空缺 → 顺序证明不完整，必须拒绝", () => {
    const r = run({ ...TWO_DIM, variationValues: { size_name: SIZES, color_name: [] } });
    console.log("[V4] status=", r.status, "diag.authoritative=", r.diagnostics.authoritativeDimensionOrder);
    expect(r.diagnostics.authoritativeDimensionOrder).toBe(false);
    expect(r.status).not.toBe("COMPLETE");
  });

  it("维度值表内部重复 → 索引不再唯一，拒绝权威绑定", () => {
    const r = run({ ...TWO_DIM, variationValues: { size_name: ["A", "A"], color_name: ["X", "Y"] } });
    console.log("[V5] status=", r.status, "diag.authoritative=", r.diagnostics.authoritativeDimensionOrder);
    expect(r.diagnostics.authoritativeDimensionOrder).toBe(false);
  });

  it("索引越界（组合键维度数与维度数不符）→ 不得为该 ASIN 编造维度值", () => {
    const r = run({ ...TWO_DIM, dimensionToAsinMap: { "0_0_0": ASIN, "0_1": "B0BB3KD2JD" } });
    const current = r.variants.find((v) => v.asin === ASIN);
    console.log("[V6] status=", r.status, "current options=", JSON.stringify(current?.options));
    expect(current?.options ?? []).toHaveLength(0);
    expect(r.status).not.toBe("COMPLETE");
  });

  it("父子身份不匹配 → REJECT", () => {
    const r = run({ ...TWO_DIM, parentAsin: "NOT-AN-ASIN" });
    console.log("[V7] parentAsin=", r.parentAsin, "status=", r.status);
    expect(r.parentAsin).toBeNull();
  });

  it("页面商品身份变化（pageAsin 不同）→ 不绑定", () => {
    const r = run(TWO_DIM, "B0OTHER0001");
    console.log("[V8] identityProof=", JSON.stringify(r.identityProof), "status=", r.status);
    expect(r.identityProof.bound).toBe(false);
  });

  it("重复 ASIN → 不重复成员", () => {
    const r = run({ ...TWO_DIM, dimensionToAsinMap: { "0_0": ASIN } });
    const asins = r.variantAsins;
    console.log("[V9] variantAsins=", JSON.stringify(asins));
    expect(new Set(asins).size).toBe(asins.length);
  });

  it("无变体且有明确来源证明 → NO_VARIATION", () => {
    const r = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-09T13:00:00.000Z",
      identity: identity(),
      raw: {
        parentAsin: null,
        dimensionToAsinMap: {},
        variationDisplayLabels: {},
        variationRootFound: true,
        explicitNoVariation: true,
        jsonStateFound: false,
      },
    });
    console.log("[V10] status=", r.status);
    expect(["NO_VARIATION_WITH_EVIDENCE", "NO_VARIATION"]).toContain(r.status);
  });

  it("页面无法证明无变体 → 不得误判 NO_VARIATION", () => {
    const r = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-09T13:00:00.000Z",
      identity: identity(),
      raw: {
        parentAsin: null,
        dimensionToAsinMap: {},
        variationDisplayLabels: {},
        variationRootFound: false,
        explicitNoVariation: false,
        jsonStateFound: false,
      },
    });
    console.log("[V11] status=", r.status);
    expect(["NO_VARIATION_WITH_EVIDENCE", "NO_VARIATION"]).not.toContain(r.status);
  });

  it("单维合法映射 → PASS（权威顺序，单维度）", () => {
    const r = run({
      parentAsin: PARENT,
      dimensionToAsinMap: { "0": ASIN, "1": "B0BB3KD2JD" },
      variationDisplayLabels: { size_name: "Size" },
      dimensions: ["size_name"],
      variationValues: { size_name: ["Small", "Large"] },
      variationRootFound: true,
      jsonStateFound: true,
    });
    const current = r.variants.find((v) => v.asin === ASIN);
    console.log("[V12] status=", r.status, "current=", JSON.stringify(current?.options));
    expect(r.status).toBe("COMPLETE");
    expect(current?.options).toEqual([{ dimensionKey: "size_name", label: "Size", value: "Small" }]);
  });
});