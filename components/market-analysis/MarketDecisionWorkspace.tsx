"use client";

import type { ReactNode } from "react";
import { ArrowLeft, CheckCircle2, CircleDashed, ClipboardCheck, RefreshCw } from "lucide-react";
import styles from "./MarketDecisionWorkspace.module.css";

export type DecisionStage = "gate" | "representatives" | "handoff";

/**
 * 02「决策与交接」独立工作区（P1-HANDOFF-UX）。
 * 只提供版式与状态呈现；人工判断、样本选择、代表保存与 03 交接仍由详情页既有 handler 执行，
 * 本组件不持有业务状态、不复制保存 API。
 */
export function MarketDecisionWorkspace({
  scanName,
  marketplace,
  scanId,
  gateStatus,
  gateStale,
  savedCount,
  draftCount,
  draftSaved,
  stage,
  busy,
  onBack,
  onRefresh,
  children,
}: {
  scanName: string;
  marketplace: string;
  scanId: string;
  gateStatus?: string | null;
  gateStale?: boolean;
  savedCount: number;
  draftCount: number;
  draftSaved: boolean;
  stage: DecisionStage;
  busy: boolean;
  onBack: () => void;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const gatePassed = gateStatus === "PROCEED" && !gateStale;
  const gateLabel = gateStale ? "判断已失效" : gateStatus === "PROCEED" ? "已通过" : gateStatus ? "待通过" : "未判断";

  return (
    <div className={styles.workspace}>
      <header className={styles.hero}>
        <div className={styles.heroMain}>
          <span className={styles.kicker}>市场研究 → 商品研究</span>
          <h1>决策与交接</h1>
          <p className={styles.meta}>
            <span className={styles.marketName} title={scanName}>{scanName}</span>
            <span className={styles.dot} aria-hidden="true" />
            <span>{marketplace} 站</span>
            <span className={styles.dot} aria-hidden="true" />
            <span className="font-mono">{scanId.slice(0, 8)}…</span>
          </p>
          <p className={styles.metaNote}>这里只做人工确认、正式代表保存与推进商品研究；研究阅读仍在五区。</p>
          <div className={styles.heroActions}>
            <button type="button" className={styles.backBtn} onClick={onBack}>
              <ArrowLeft size={15} aria-hidden="true" />
              返回研究区
            </button>
            <button type="button" className={styles.ghostBtn} onClick={onRefresh} disabled={busy}>
              <RefreshCw size={14} aria-hidden="true" />
              重新读取最新状态
            </button>
          </div>
        </div>
      </header>

      <ol className={styles.rail} aria-label="决策与交接步骤">
        <li data-state={stage === "gate" ? "current" : "done"}>
          <span className={styles.railIcon}>{stage === "gate" ? <CircleDashed size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}</span>
          <b>人工市场判断</b>
          <em>{gatePassed ? "已通过，可继续选代表" : gateLabel}</em>
        </li>
        <li data-state={stage === "representatives" ? "current" : stage === "handoff" ? "done" : "todo"}>
          <span className={styles.railIcon}>{stage === "handoff" ? <CheckCircle2 size={15} aria-hidden="true" /> : <CircleDashed size={15} aria-hidden="true" />}</span>
          <b>选择并保存代表</b>
          <em>{savedCount > 0 ? `已保存 ${savedCount} 款${draftSaved ? "" : "，草稿有未保存修改"}` : draftCount > 0 ? `草稿 ${draftCount} 款待保存` : "尚未选择"}</em>
        </li>
        <li data-state={stage === "handoff" ? "current" : "todo"}>
          <span className={styles.railIcon}>{stage === "handoff" ? <ClipboardCheck size={15} aria-hidden="true" /> : <CircleDashed size={15} aria-hidden="true" />}</span>
          <b>进入商品研究</b>
          <em>{gatePassed && savedCount > 0 ? `可交接已保存的 ${savedCount} 款` : "需先通过判断并保存代表"}</em>
        </li>
      </ol>

      <div className={styles.sections}>{children}</div>
    </div>
  );
}
