"use client";

import { useCallback, useEffect, useRef } from "react";

import { fetchBatchCaptureRun } from "@/lib/client/batchCaptureRunClient";
import { describeBatchCaptureRun } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";

const POLL_INTERVAL_MS = 3_000;

/**
 * 读取「当前展开批次」的 BatchCaptureRun 快照，并把结果写入唯一 snapshot。
 *
 * - 只有成功读取且 run=null 才写 absent；
 * - 读取失败写 error，绝不写 absent/false；
 * - 运行中（RUNNING/WAITING）每 3 秒刷新一次；
 * - 控制台打开时由控制台自己轮询，本 hook 通过 enabled=false 暂停，避免重复请求；
 * - 已有快照时后台刷新不写 loading，避免摘要闪烁。
 */
export function useCaptureRunSnapshotFetcher(input: {
  batchId: string | null;
  enabled: boolean;
  refreshToken: number;
  snapshot: BatchCaptureRunSnapshot;
  onSnapshot: (batchId: string, snapshot: BatchCaptureRunSnapshot) => void;
}): { reload: () => void } {
  const { batchId, enabled, refreshToken, snapshot, onSnapshot } = input;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const inFlight = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const fetchNow = useCallback(async () => {
    if (!batchId || inFlight.current) return;
    inFlight.current = true;
    const current = snapshotRef.current;
    if (current.state === "unknown" || current.state === "error") {
      onSnapshot(batchId, { state: "loading" });
    }
    try {
      const payload = await fetchBatchCaptureRun(batchId);
      if (!alive.current) return;
      if (!payload.ok) {
        onSnapshot(batchId, { state: "error", message: payload.errorMessage, at: Date.now() });
        return;
      }
      if (!payload.run) {
        onSnapshot(batchId, { state: "absent", at: Date.now() });
        return;
      }
      onSnapshot(batchId, {
        state: "present",
        run: payload.run,
        view: describeBatchCaptureRun({ run: payload.run }),
        at: Date.now(),
      });
    } catch (error) {
      if (!alive.current) return;
      onSnapshot(batchId, {
        state: "error",
        message: error instanceof Error ? error.message : "读取采集运行状态失败。",
        at: Date.now(),
      });
    } finally {
      inFlight.current = false;
    }
  }, [batchId, onSnapshot]);

  // 展开批次、打开/关闭控制台、外部刷新令牌变化时立即读取一次。
  useEffect(() => {
    if (!enabled || !batchId) return;
    void fetchNow();
  }, [enabled, batchId, refreshToken, fetchNow]);

  const runStatus = snapshot.state === "present" ? snapshot.run.status : null;
  useEffect(() => {
    if (!enabled || !batchId) return;
    if (runStatus !== "RUNNING" && runStatus !== "WAITING") return;
    const timer = window.setInterval(() => { void fetchNow(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, batchId, runStatus, fetchNow]);

  return { reload: () => { void fetchNow(); } };
}
