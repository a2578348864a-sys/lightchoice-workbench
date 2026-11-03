import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VocRequirementsSection } from "@/components/product-brief/VocRequirementsSection";

/**
 * P1-VOC/BR-03 渲染测试（真实 HTML 输出）：
 * 1. recurring 派生项逐条展示，标注「证据推导」并带证据引用；
 * 2. 空数组 = 当前没有 recurring 级痛点（弱信号不升级为改进方向），页面给出解释而不是空白；
 * 3. undefined = 旧版需求单，提示重新生成，不冒充已有结论。
 */
describe("VocRequirementsSection", () => {
  it("渲染 recurring 派生项并带证据引用", () => {
    const html = renderToStaticMarkup(createElement(VocRequirementsSection, {
      vocRequirements: [
        { text: "改进方向：针对买家反馈的「表面滑，清洗时不易固定」问题——多位买家反馈垫子过滑。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["amazon-content:hash-a", "amazon-content:hash-b"] },
      ],
    }));
    expect(html).toContain('data-testid="brief-voc-requirements"');
    expect(html).toContain("改进方向（由 VOC 复现痛点派生 · 待验证假设）");
    expect(html).toContain("待验证的开发假设");
    expect(html).toContain("表面滑，清洗时不易固定");
    expect(html).toContain("amazon-content:hash-a");
    expect(html).toContain("证据推导");
  });

  it("空数组时说明弱信号不会自动成为改进方向", () => {
    const html = renderToStaticMarkup(createElement(VocRequirementsSection, { vocRequirements: [] }));
    expect(html).toContain("没有「反复出现」级别的痛点");
    expect(html).toContain("少量反馈不会自动成为产品要求");
    expect(html).not.toContain("旧版需求单");
  });

  it("undefined（旧版需求单）时提示重新生成，不给出空结论", () => {
    const html = renderToStaticMarkup(createElement(VocRequirementsSection, { vocRequirements: undefined }));
    expect(html).toContain("旧版需求单尚无改进方向段");
    expect(html).not.toContain("没有「反复出现」级别的痛点");
  });
});
