import { describe, expect, it } from "vitest";
import { canSubmitAgentRunSave, getAgentRunSaveErrorMessage } from "@/lib/agentRunSave";

describe("agentRunSave", () => {
  it("maps auth loss to a recovery-safe save message", () => {
    expect(getAgentRunSaveErrorMessage(401, "invalid_access", "Please login")).toBe(
      "当前访问主体无法保存任务。分析结果已保留，请刷新后重试。",
    );
  });

  it("keeps forbidden saves clear without implying result loss", () => {
    expect(getAgentRunSaveErrorMessage(403, "demo_action_forbidden")).toBe(
      "当前访问主体无权保存任务。分析结果已保留，请确认工作区权限后重试。",
    );
  });

  it("blocks duplicate or incomplete save submissions", () => {
    expect(canSubmitAgentRunSave({ hasResult: true, saving: false, savedTaskId: "", manualReady: true })).toBe(true);
    expect(canSubmitAgentRunSave({ hasResult: false, saving: false, savedTaskId: "", manualReady: true })).toBe(false);
    expect(canSubmitAgentRunSave({ hasResult: true, saving: true, savedTaskId: "", manualReady: true })).toBe(false);
    expect(canSubmitAgentRunSave({ hasResult: true, saving: false, savedTaskId: "task-1", manualReady: true })).toBe(false);
    expect(canSubmitAgentRunSave({ hasResult: true, saving: false, savedTaskId: "", manualReady: false })).toBe(false);
  });
});
