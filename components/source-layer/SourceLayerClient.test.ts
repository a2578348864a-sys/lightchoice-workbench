import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 来源层 UI 契约测试。
 *
 * 组件本身是客户端交互组件，端到端行为由真实浏览器验收覆盖（见交付报告）。
 * 这里锁定最容易在重构中丢失的硬契约：
 * - 必须携带鉴权头（否则访客/管理员会读到 401）；
 * - 必须调用来源层三个 API，且不改用其它写入通道；
 * - 校验不通过的商品不得被送去研究池；
 * - 错误与状态提示必须是可被读屏与测试定位的元素。
 */
const SOURCE = readFileSync(
  resolve(process.cwd(), "components/source-layer/SourceLayerClient.tsx"),
  "utf8",
);

const PAGE = readFileSync(resolve(process.cwd(), "app/source/page.tsx"), "utf8");

describe("SourceLayerClient contract", () => {
  it("sends access headers on every source layer call", () => {
    expect(SOURCE).toContain("buildAccessHeaders");
    const fetches = SOURCE.match(/fetch\(\s*"\/api\/source-layer[^)]*\)/g) ?? [];
    expect(fetches.length).toBeGreaterThanOrEqual(3);
  });

  it("talks only to the source layer API for reads and writes", () => {
    expect(SOURCE).toContain('"/api/source-layer"');
    expect(SOURCE).toContain('"/api/source-layer/ingest"');
    expect(SOURCE).toContain('"/api/source-layer/handoff"');
    expect(SOURCE).toContain('"/api/source-layer/from-product-batch"');
    expect(SOURCE).not.toContain("/api/product-batches");
    expect(SOURCE).not.toContain("/api/opportunity-candidates");
  });

  it("offers the Product Batch bridge as a read-only alternative to re-capturing", () => {
    expect(SOURCE).toContain("source-layer-bridge");
    expect(SOURCE).toContain("从当前商品批次接入来源证据");
    expect(SOURCE).toContain("不会修改批次本身");
  });

  it("only hands off captures that passed validation", () => {
    expect(SOURCE).toContain("item.readyForResearch");
    expect(SOURCE).toContain('item.latestVerdict === "passed"');
    expect(SOURCE).toContain("当前没有通过校验的商品，无法进入研究池。");
  });

  it("renders blocking issues, risk flags and the audit timeline", () => {
    expect(SOURCE).toContain("source-issue-list");
    expect(SOURCE).toContain("source-audit-timeline");
    expect(SOURCE).toContain("风险：");
    expect(SOURCE).toContain("阻断");
  });

  it("surfaces server error codes to the operator", () => {
    expect(SOURCE).toContain("source-layer-error");
    expect(SOURCE).toContain("ERROR_LABELS");
    expect(SOURCE).toContain("SOURCE_UNTRUSTED");
    expect(SOURCE).toContain("FIELD_CONFLICT");
  });

  it("explains that captured data is evidence, not a confirmed fact", () => {
    expect(SOURCE).toContain("采集数据不会被当成商品事实");
    expect(SOURCE).toContain("不自动补全");
  });

  it("explains a source conflict instead of silently overwriting evidence", () => {
    expect(SOURCE).toContain("source-layer-handoff-summary");
    expect(SOURCE).toContain("不会自动覆盖");
    expect(SOURCE).toContain("evidenceOnlyNote");
  });

  it("keeps the page entry wired to the sidebar navigation", () => {
    expect(PAGE).toContain("SourceManagementClient");
    expect(PAGE).toContain("01 市场采集");
    const sidebar = readFileSync(resolve(process.cwd(), "components/WorkspaceSidebar.tsx"), "utf8");
    expect(sidebar).toContain("WORKFLOW_STAGE_META.MARKET_CAPTURE.href");
    const resolver = readFileSync(resolve(process.cwd(), "lib/workflow/workflowResolver.ts"), "utf8");
    expect(resolver).toContain('href: "/source"');
  });
});
