import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { shouldDisableSellerSpriteCapture, marketCaptureStorageKey } from "@/components/source-layer/SellerSpriteKeywordCapturePanel";

const panel = readFileSync(new URL("./SellerSpriteKeywordCapturePanel.tsx", import.meta.url), "utf8");
const sourcePage = readFileSync(new URL("../source/SourceManagementClient.tsx", import.meta.url), "utf8");

describe("SellerSprite Reverse ASIN and Keyword Mining depth capture", () => {
  it("restores a seed query even when formal product membership changes, while isolating another research or ASIN", () => {
    expect(marketCaptureStorageKey("research-1", "keyword_mining_trend", "B01ACUA8HC", " Silicone Baking Mat ")).toBe(marketCaptureStorageKey("research-1", "keyword_mining_trend", "B077XTPWZ5", "silicone baking mat"));
    expect(marketCaptureStorageKey("research-1", "reverse_asin", "B01ACUA8HC", "mat")).not.toBe(marketCaptureStorageKey("research-1", "reverse_asin", "B077XTPWZ5", "mat"));
    expect(marketCaptureStorageKey("research-1", "keyword_mining_trend", "", "mat")).not.toBe(marketCaptureStorageKey("research-2", "keyword_mining_trend", "", "mat"));
  });
  it("uses explicit ASIN subject binding while keeping the keyword query identity separate", () => {
    expect(panel).toContain("商品 ASIN");
    expect(panel).toContain("subjectKey: `amazon:US:${asin}`");
    expect(panel).toContain("identity: { keyword }");
    expect(panel).toContain("queryInput: { module, seedKeyword: keyword, marketplace: \"US\" }");
    expect(panel).toContain("二者保持独立");
  });

  it("creates a persistent job before the user starts a bounded visible-page run", () => {
    expect(panel).toContain('action: "prepare"');
    // prepare 只创建任务，不立即采集——文案必须与副作用一致
    expect(panel).toContain("准备采集");
    expect(panel).toContain("开始采集（下一段）");
    expect(panel).toContain("执行下一窗口");
    expect(panel).toContain("/v3/keyword-reverse/");
    expect(panel).toContain("/v3/keyword-miner/");
    expect(panel).toContain("windowBudget");
  });

  it("exposes persisted job controls and the seven exact coverage counters", () => {
    for (const label of [
      "当前页可见行", "本快照去重行", "来源报告总量", "来源可访问行",
      "有效解析行", "已保存可用行", "未开放行", "已拒绝重复行",
      "CursorRestored", "来源限制",
    ]) expect(panel).toContain(label);
    for (const action of ["status", "pause", "resume", "cancel"]) expect(panel).toContain(`performAction(\"${action}\")`);
    expect(panel).toContain('job?.limitationReason !== "source_limit_declared"');
    expect(panel).toContain('job?.limitationReason === "source_limit_declared"');
    expect(panel).toContain("旧任务未记录恢复结果");
  });

  it("restores job state without automatically reopening SellerSprite", () => {
    expect(panel).toContain('sessionStorage.getItem(storageKey)');
    expect(panel).toContain('sessionStorage.setItem(storageKey');
    expect(panel).toContain('researchScanId');
    expect(panel).toContain('post({ action: "status", jobId: savedJobId })');
    expect(panel).toContain("不会自动开始新的采集");
    expect(panel).toContain('cache: "no-store"');
  });

  it("keeps advanced settings available without hiding package limits", () => {
    expect(panel).toContain("采集范围与任务详情");
    expect(panel).toContain("本次采集范围");
    expect(panel).toContain("套餐访问限制");
  });

  it("places the depth capture in the source management workflow", () => {
    expect(sourcePage).toContain("SellerSpriteKeywordCapturePanel");
    expect(sourcePage).toContain("start-sellersprite-depth-capture-button");
    expect(sourcePage).toContain("more-tools");
    expect(sourcePage).toContain("start-keepa-trend-import-button");
    const hero = readFileSync(new URL("../source/cockpit/SourceHero.tsx", import.meta.url), "utf8");
    for (const id of ["start-product-capture-button", "entry-keyword-market", "entry-category-market"]) expect(hero).toContain(id);
    expect(sourcePage).toContain('onKeyword={() => openAmazonCapture("search")}');
    expect(sourcePage).toContain('onCategory={() => setCategoryMarketCaptureOpen(true)}');
    expect(sourcePage).toContain('onSingleAsin={() => openAmazonCapture("detail")}');
  });
});

describe("SellerSprite 关键词采集 CDP 前置禁用", () => {
  it("cdpReachable=false 才禁用开始采集；prepare 不受影响", () => {
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: false })).toBe(true);
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: true })).toBe(false);
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: null })).toBe(false);
    expect(shouldDisableSellerSpriteCapture({ canCapture: false, cdpReachable: true })).toBe(true);
  });

  it("挂载时只读预检一次、超时静默，并保留 prepare 行为", () => {
    expect(panel).toContain('fetch("/api/source-layer/capture-environment"');
    expect(panel).toContain("setTimeout(() => controller.abort(), 1500)");
    expect(panel).toContain("shouldDisableSellerSpriteCapture({ canCapture: canRun, cdpReachable })");
    expect(panel).toContain("SellerSprite CDP 不可达：先启动专用浏览器并登录");
    expect(panel).toContain("sellersprite-depth-cdp-blocked");
    // prepare 按钮不纳入 CDP 禁用条件
    expect(panel).not.toContain("disabled={restoring || preparing || capturing || cdpBlocked}");
  });
});
