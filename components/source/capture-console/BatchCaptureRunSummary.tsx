"use client";

import type { CSSProperties } from "react";
import { AlertTriangle, Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";

import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import styles from "./capture-console.module.css";

function pillTone(tone: "emerald" | "blue" | "amber" | "rose" | "slate"): "ok" | "warn" | "fail" | "idle" {
  if (tone === "emerald" || tone === "blue") return "ok";
  if (tone === "amber") return "warn";
  if (tone === "rose") return "fail";
  return "idle";
}

/**
 * 商品区上方的轻量运行摘要。
 *
 * 只显示服务端真实快照；未知/读取失败/确认无任务/已创建待回读分别表达。
 * 完整结果、问题与实际动作在「查看运行详情」展开的控制台内，摘要不伪造按钮。
 */
export function BatchCaptureRunSummary({
  snapshot,
  onOpenConsole,
  onReload,
}: {
  snapshot: BatchCaptureRunSnapshot;
  onOpenConsole: () => void;
  onReload: () => void;
}) {
  const busy = snapshot.state === "loading";

  if (snapshot.state === "present") {
    const { view } = snapshot;
    const progress = view.progress;
    const percent = progress.itemsInBatch > 0
      ? Math.min(100, Math.round((progress.uniqueItemsVisited / progress.itemsInBatch) * 100))
      : 0;
    const nextStep = view.actions.canPause
      ? "可暂停"
      : view.actions.canResume
        ? "可继续"
        : view.actions.canRetry
          ? "可重试失败单元"
          : view.actions.canDrive
            ? "可继续推进"
            : null;

    return (
      <section className={styles.summaryRoot} data-testid="batch-capture-run-summary" data-state="present">
        <div className={styles.summaryCard}>
          <div className={styles.summaryMain}>
            <div className={styles.summaryHead}>
              <span className={styles.statusPill} data-tone={pillTone(view.tone)} data-testid="batch-capture-run-summary-status">
                <i className={styles.liveDot} aria-hidden="true" />
                {view.statusLabel}
              </span>
              <span className={styles.summaryMeta}>
                {view.runGeneration ? `第 ${view.runGeneration} 次运行` : null}
                {view.current ? ` · 当前 ${view.current.asin} · ${view.current.moduleLabel}` : null}
              </span>
            </div>
            <div className={styles.summaryMetrics}>
              <div className={styles.summaryMetric}>
                <span>本轮处理</span>
                <b data-testid="batch-capture-run-summary-processed">{progress.uniqueItemsVisited} / {progress.itemsInBatch}</b>
              </div>
              <div className={styles.summaryMetric}>
                <span>本轮资料证据</span>
                <b data-testid="batch-capture-run-summary-evidence">{progress.validEvidenceCells} / {progress.totalCells} 单元</b>
              </div>
              {progress.failedCells > 0 ? (
                <span className={styles.chip} data-tone="rose" data-testid="batch-capture-run-summary-failed">失败 {progress.failedCells}</span>
              ) : null}
              {progress.partialCells > 0 ? (
                <span className={styles.chip} data-tone="warn" data-testid="batch-capture-run-summary-partial">部分 {progress.partialCells}</span>
              ) : null}
            </div>
            <div
              className={styles.summaryBar}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.itemsInBatch || undefined}
              aria-valuenow={progress.itemsInBatch > 0 ? progress.uniqueItemsVisited : undefined}
              aria-label="本轮任务处理进度"
            >
              <i style={{ "--p": `${percent}%` } as CSSProperties} />
            </div>
          </div>
          <div className={styles.summaryActions}>
            {nextStep ? <span className={styles.summaryNext}>下一步：{nextStep}</span> : null}
            <button type="button" className={`${styles.btn} ${styles.btnIcon}`} onClick={onReload} disabled={busy} aria-label="重新读取运行状态" title="只读：重新读取服务端运行状态">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </button>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onOpenConsole} data-testid="batch-capture-run-summary-open">
              查看运行详情
            </button>
          </div>
        </div>
        {view.completionHint ? <p className={styles.summaryNote}>{view.completionHint}</p> : null}
      </section>
    );
  }

  if (snapshot.state === "absent") {
    return (
      <section className={styles.summaryRoot} data-testid="batch-capture-run-summary" data-state="absent">
        <div className={styles.summaryCard}>
          <div className={styles.summaryMain}>
            <div className={styles.summaryHead}>
              <span className={styles.statusPill} data-tone="idle">
                <i className={styles.liveDot} aria-hidden="true" />
                尚未开始自动采集
              </span>
              <span className={styles.summaryMeta}>已成功读取运行状态，确认本批次没有自动采集任务</span>
            </div>
          </div>
          <div className={styles.summaryActions}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onOpenConsole} data-testid="batch-capture-run-summary-open">
              <SlidersHorizontal className="size-4" />配置采集计划
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (snapshot.state === "error") {
    return (
      <section className={styles.summaryRoot} data-testid="batch-capture-run-summary" data-state="error">
        <div className={styles.summaryCard} data-tone="fail">
          <div className={styles.summaryMain}>
            <div className={styles.summaryHead}>
              <span className={styles.statusPill} data-tone="fail">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                运行状态读取失败
              </span>
              <span className={styles.summaryMeta}>{snapshot.message}</span>
            </div>
            <p className={styles.summaryErrorNote}>这是读取失败，不是「没有自动采集任务」；历史与摘要不会把未知状态写成无任务。</p>
          </div>
          <div className={styles.summaryActions}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onReload} data-testid="batch-capture-run-summary-retry">
              <RefreshCw className="size-4" />重新读取
            </button>
          </div>
        </div>
      </section>
    );
  }

  const created = snapshot.state === "created";
  return (
    <section className={styles.summaryRoot} data-testid="batch-capture-run-summary" data-state={created ? "created" : "loading"}>
      <div className={styles.summaryCard}>
        <div className={styles.summaryMain}>
          <div className={styles.summaryHead}>
            <span className={styles.statusPill} data-tone={created ? "warn" : "idle"}>
              {busy || created ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <i className={styles.liveDot} aria-hidden="true" />}
              {created ? "任务已创建" : "正在读取采集运行状态"}
            </span>
            <span className={styles.summaryMeta}>
              {created ? "运行快照尚未回读；读取成功前不会显示为「无任务」" : "以服务端持久化回执为准"}
            </span>
          </div>
        </div>
        {created ? (
          <div className={styles.summaryActions}>
            <button type="button" className={styles.btn} onClick={onReload}>重新读取</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
