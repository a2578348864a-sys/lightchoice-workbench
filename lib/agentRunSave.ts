export function getAgentRunSaveErrorMessage(
  status: number,
  code?: string,
  message?: string,
): string {
  if (status === 401 || code === "invalid_access" || code === "unauthorized") {
    return "当前访问主体无法保存任务。分析结果已保留，请刷新后重试。";
  }
  if (status === 403) {
    return message || "当前访问主体无权保存任务。分析结果已保留，请确认工作区权限后重试。";
  }
  return message || "保存任务失败，请稍后重试。";
}

export function canSubmitAgentRunSave(input: {
  hasResult: boolean;
  saving: boolean;
  savedTaskId: string;
  manualReady: boolean;
}): boolean {
  return input.hasResult && !input.saving && !input.savedTaskId && input.manualReady;
}
