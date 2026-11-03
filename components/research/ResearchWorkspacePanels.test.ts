import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionRail, ResearchOverviewHero } from "./ResearchWorkspacePanels";

describe("ResearchOverviewHero 决定有效性", () => {
  const props = {
    decisionStatus: "PROCEED",
    decisionReason: "保留历史理由",
    hasDecision: true,
    suggestion: { status: "available" as const, nextAction: "补充数据", blocking: 0, warning: 1, notComputable: 0 },
    hasReport: true,
    onOpenDecision: () => {},
    briefHref: "/product-brief?taskId=fixture",
    onOpenComparison: () => {},
  };

  it("失效时展示历史决定与恢复提示，不把它说成当前有效判断", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewHero, { ...props, decisionStale: true }));
    expect(html).toContain("历史决定");
    expect(html).toContain("需重新确认");
    expect(html).toContain("保留历史理由");
    expect(html).not.toContain("以已保存的人工决定为准");
  });

  it("有效决定仍显示已保存并保留原理由", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewHero, { ...props, decisionStale: false }));
    expect(html).toContain("已保存");
    expect(html).toContain("保留历史理由");
  });

  it("人工决定侧栏也标明历史状态", () => {
    const html = renderToStaticMarkup(createElement(DecisionRail, {
      missing: [], blocking: 0, warning: 0, notComputable: 0,
      currentLabel: "继续推进", briefHref: null, decisionStale: true,
    }));
    expect(html).toContain("历史决定");
    expect(html).toContain("需重新确认");
    expect(html).not.toContain("当前已保存：继续推进");
  });
});
