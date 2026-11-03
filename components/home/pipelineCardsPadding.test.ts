import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowProgress } from "./WorkbenchOverviewClient";

// The former source-string checks described the removed V5 card markup.
// Verify the retained business counts and destinations in the actual rendered component.
describe("首页主线摘要", () => {
  it("按服务端摘要显示四条入口，不把样本数误作研究数量", () => {
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { data: {
      counts: { sourceBatches: 2, sourceItems: 30, marketScans: 3, marketSamples: 75, researchInProgress: 4, researchNeedsChoice: 5, choiceProceed: 2, choiceWatch: 3, choiceDrop: 1 },
      decision: { paused: 1, validateMore: 2 },
    } }));
    for (const href of ["/source", "/market-analysis", "/research?view=needs_decision", "/research"]) expect(html).toContain('href="' + href + '"');
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).toContain("<strong>2</strong>");
    expect(html).toContain("30 款来源商品");
    expect(html).toContain("<strong>3</strong>");
    expect(html).toContain("75 款研究样本");
    expect(html).toContain("<strong>5</strong>");
    expect(html).toContain("4 项研究进行中");
    expect(html).toContain("<strong>6</strong>");
    expect(html).toContain("暂缓观察 1 · 需补充验证 2");
  });
  it("空摘要保留零与明确入口，不填充示例商品或虚构成果", () => {
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { data: { counts: {} } }));
    expect(html.match(/<strong>0<\/strong>/g)).toHaveLength(4);
    expect(html).not.toContain("示例商品");
    expect(html).toContain("0 款来源商品");
  });
});
