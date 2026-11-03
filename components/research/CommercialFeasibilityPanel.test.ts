import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommercialFeasibilityPanel } from "./CommercialFeasibilityPanel";

describe("CommercialFeasibilityPanel 的来源和决定提示", () => {
  it("标题材质不会被统一标题说成已确认事实，旧决定与当前研究建议分开", () => {
    const html = renderToStaticMarkup(createElement(CommercialFeasibilityPanel, {
      input: {
        asin: "B0TESTPANEL",
        title: "Silicone Product",
        humanDecision: { choice: "PROCEED", canonicalStatus: "PROCEED", decisionStale: true },
        recommendedNextAction: "继续研究",
      },
    }));
    expect(html).toContain("来自商品标题的材质声明");
    expect(html).not.toContain("已确认商品与市场事实");
    expect(html).toContain("历史人工决定（需重新确认）");
    expect(html).toContain("继续研究");
    expect(html).not.toContain("系统建议 VALIDATE_MORE");
  });
});
