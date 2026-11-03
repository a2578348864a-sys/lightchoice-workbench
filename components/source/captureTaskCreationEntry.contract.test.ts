import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * D2-1C：同一批次只能有一个清晰的主创建入口。
 * - 创建任务 = 采集计划确认（CapturePlanPanel）唯一入口，带计划指纹与自动推进；
 * - 执行面板（BatchCaptureRunPanel）不再提供第二套「创建批次采集任务」按钮，
 *   未启动/已结束时只给出去往计划面板的指引（兼容旧 API 不删除）。
 */
describe("采集任务创建入口统一（D2-1C 合同）", () => {
  const runPanel = source("components/source/BatchCaptureRunPanel.tsx");
  const planPanel = source("components/source/CapturePlanPanel.tsx");
  const sourceClient = source("components/source/SourceManagementClient.tsx");

  it("执行面板不再包含独立创建按钮与授权数量输入", () => {
    expect(runPanel).not.toContain('data-testid="batch-capture-run-start-button"');
    expect(runPanel).not.toContain("batch-capture-run-authorized-input");
    expect(runPanel).not.toContain("postBatchCaptureRunActionRaw");
  });

  it("执行面板保留未启动/新一轮的计划指引（双语标题）", () => {
    expect(runPanel).toContain("尚未创建采集任务");
    expect(runPanel).toContain("Capture Plan");
    expect(runPanel).toContain("采集进度 / Capture Progress");
  });

  it("计划面板是唯一创建入口（确认按钮 + 双语标题）", () => {
    expect(planPanel).toContain('data-testid="capture-plan-confirm"');
    expect(planPanel).toContain("确认计划并创建任务");
    expect(planPanel).toContain("市场采集计划 / Capture Plan");
  });

  it("D2-1E：已中止/失败的任务不锁死重建入口（运行面板指引「重新确认」必须真正可走通）", () => {
    // 若 CANCELLED/FAILED 仍按「绑定计划」锁定，确认按钮会被禁用，
    // 与控制面板的「请在上方重新确认创建新代次」指引互相矛盾。
    expect(planPanel).toContain('existingRun.status === "CANCELLED" || existingRun.status === "FAILED"');
    expect(planPanel).toContain('data-testid="capture-plan-previous-terminal-hint"');
    // 提示文案必须承诺「新代次」而不是复用旧代次。
    expect(planPanel).toContain("新的运行代次");
  });

  it("批次列表 sr-only 标记位于单元格内（修复首行列错位）", () => {
    // 旧实现把 span 直接放在 <tr> 下，浏览器会提升节点导致首行列错位。
    expect(sourceClient).not.toMatch(/<tr[^>]*>\s*\{index === 0 && <span data-testid="source-current-batch"/);
    expect(sourceClient).toContain('data-testid="source-current-batch"');
  });
});
