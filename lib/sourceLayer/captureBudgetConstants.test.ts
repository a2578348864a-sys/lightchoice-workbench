import { describe, expect, it } from "vitest";

import {
  AUTO_CAPTURE_MODULE_COUNT,
  HARD_MAX_AUTHORIZED_ITEMS,
  MIN_NAVIGATION_BUDGET,
  deriveNavigationBudget,
  deriveSearchPages,
} from "./captureBudgetConstants";
import { deriveSearchBudget } from "@/components/source-layer/AmazonCapturePanel";

/**
 * 前后端预算一致性：UI 与服务端必须使用同一推导函数，
 * 历史上曾出现「前端显示 210 / 后端执行 607」的两套数字。
 */
describe("采集预算单一来源（前后端一致）", () => {
  it.each([5, 10, 30, 60, 80, 100, 150, 200])("授权 %i 件：UI 预算 == 服务端预算", (limit) => {
    const ui = deriveSearchBudget(limit);
    const serverSearchPages = deriveSearchPages(limit);
    const serverNav = deriveNavigationBudget(limit, AUTO_CAPTURE_MODULE_COUNT, serverSearchPages);
    // UI 使用的就是同一个函数
    const uiNav = deriveNavigationBudget(limit, AUTO_CAPTURE_MODULE_COUNT, ui.pages);
    expect(ui.pages).toBe(serverSearchPages);
    expect(uiNav).toBe(serverNav);
  });

  it("授权 5 件：1 页搜索、30 次导航（安全下限）", () => {
    expect(deriveSearchPages(5)).toBe(1);
    expect(deriveNavigationBudget(5, AUTO_CAPTURE_MODULE_COUNT, 1)).toBe(MIN_NAVIGATION_BUDGET);
  });

  it("授权 200 件：导航预算有限且等于四个自动模块加搜索页预算（807）", () => {
    const pages = deriveSearchPages(200);
    expect(pages).toBe(7);
    expect(deriveNavigationBudget(200, AUTO_CAPTURE_MODULE_COUNT, pages)).toBe(807);
    expect(deriveNavigationBudget(200, AUTO_CAPTURE_MODULE_COUNT, pages)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("搜索页数不超过硬上限", () => {
    expect(deriveSearchPages(HARD_MAX_AUTHORIZED_ITEMS)).toBeLessThanOrEqual(10);
    expect(deriveSearchPages(10_000)).toBe(10);
  });
});
