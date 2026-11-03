/**
 * 采集运行读取的**唯一前端状态**（tri-state + error）。
 *
 * 背景（T03 必须修复的接线缺陷）：
 * 旧实现用 `boolean | undefined` 表示「是否存在自动采集任务」，
 * 于是「尚未读取」「读取失败」「确认无任务」全都显示成「无」，
 * 实际有 BatchCaptureRun 的批次会被历史面板误报为「自动采集任务 无」。
 *
 * 纪律：
 * - 只有 `state: "absent"` 才能显示「无任务」；
 * - `error` 必须显示读取失败，不能回退为 absent；
 * - `created` 表示本轮刚确认创建、运行快照尚未回读，不能当成 absent；
 * - 摘要、运行详情、历史状态消费同一个 snapshot，不另建第二套布尔权威。
 */
import type {
  BatchCaptureRunPresentation,
  BatchCaptureRunView,
} from "./batchCaptureRunPresentation";

export type BatchCaptureRunSnapshot =
  | { state: "unknown" }
  | { state: "loading" }
  | { state: "created"; runStatus: string | null; at: number }
  | { state: "present"; run: BatchCaptureRunView; view: BatchCaptureRunPresentation; at: number }
  | { state: "absent"; at: number }
  | { state: "error"; message: string; at: number };

export function isCaptureRunPresent(
  snapshot: BatchCaptureRunSnapshot | null | undefined,
): snapshot is Extract<BatchCaptureRunSnapshot, { state: "present" }> {
  return snapshot?.state === "present";
}

export function isCaptureRunAbsent(
  snapshot: BatchCaptureRunSnapshot | null | undefined,
): snapshot is Extract<BatchCaptureRunSnapshot, { state: "absent" }> {
  return snapshot?.state === "absent";
}

/** 是否已有运行（含「已创建、快照待回读」），用于菜单/计划面板的保守判断。 */
export function hasCaptureRunEvidence(
  snapshot: BatchCaptureRunSnapshot | null | undefined,
): boolean {
  return snapshot?.state === "present" || snapshot?.state === "created";
}

/** 历史面板的「自动采集任务」文案：读取失败与无任务必须分开。 */
export function describeCaptureRunPresence(
  snapshot: BatchCaptureRunSnapshot | null | undefined,
): { label: string; tone: "ok" | "warn" | "fail" | "idle" } {
  switch (snapshot?.state) {
    case "present":
      return { label: `存在 · ${snapshot.view.statusLabel}`, tone: snapshot.view.tone === "rose" ? "fail" : snapshot.view.tone === "amber" ? "warn" : "ok" };
    case "created":
      return { label: "已创建 · 状态读取中", tone: "warn" };
    case "loading":
      return { label: "正在读取", tone: "idle" };
    case "absent":
      return { label: "无（已确认读取成功）", tone: "idle" };
    case "error":
      return { label: "读取失败（不是无任务）", tone: "fail" };
    default:
      return { label: "尚未读取", tone: "idle" };
  }
}
