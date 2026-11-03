import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * BatchCaptureRunPanel 操作可靠性合同（源码契约，与项目现有组件测试风格一致）。
 * 覆盖：busy 必解除、重试失败回读、drive 失败不得当成功、卸载竞态不 setState。
 */
describe("BatchCaptureRunPanel 操作可靠性合同", () => {
  const panel = source("components/source/BatchCaptureRunPanel.tsx");

  it("onAction 使用 try/finally，任何路径都会 setBusy(null)", () => {
    expect(panel).toContain("const onAction = useCallback");
    expect(panel).toContain("setBusy(action)");
    expect(panel).toMatch(/try\s*\{[\s\S]*finally\s*\{[\s\S]*setBusy\(null\)/);
  });

  it("重试失败（result.ok=false）会 reload 服务端状态", () => {
    expect(panel).toContain('action === "retry" || action === "resume" || action === "recover_stalled_execution"');
    expect(panel).toMatch(/result\.ok\)\s*\{[\s\S]*\}[\s\S]*reload\(\)/);
  });

  it("执行器启动失败（drive.errorCode）显示错误，不报成功", () => {
    expect(panel).toContain("drive.errorCode");
    expect(panel).toContain('tone: "error"');
    expect(panel).not.toMatch(
      /drive\.errorCode[\s\S]{0,400}重试已授权，执行器已启动/,
    );
  });

  it("drive 未启动时成功文案不得宣称已开始采集", () => {
    expect(panel).toContain("执行器未启动（服务端未进入可自动推进状态）");
    expect(panel).toContain("不是已开始采集");
  });

  it("操作异常/网络失败也会显示错误并尝试 reload", () => {
    expect(panel).toMatch(/catch \(error\)/);
    expect(panel).toMatch(/reload\(\)\.catch/);
  });
});
