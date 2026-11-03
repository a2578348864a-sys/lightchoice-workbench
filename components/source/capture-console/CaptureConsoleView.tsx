"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import type {
  ConsoleIssueAction,
  ConsoleModel,
  ConsoleScrollTarget,
} from "./captureConsoleModel";
import { CaptureEvidenceRing } from "./CaptureEvidenceRing";
import { CaptureBasicCapabilities, CaptureSupplementaryCapabilities } from "./CaptureModuleGrid";
import { CaptureProgressBar } from "./CaptureProgressBar";
import styles from "./capture-console.module.css";

export type CaptureConsoleViewProps = {
  model: ConsoleModel;
  ariaLabel?: string;
  notice?: ReactNode;
  error?: ReactNode;
  topAlert?: ReactNode;
  planSlot?: ReactNode;
  advanced?: ReactNode;
  footer?: ReactNode;
  noRunContent?: ReactNode;
  busy?: boolean;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onIssueAction: (action: ConsoleIssueAction) => void;
  onOpenPlan: () => void;
  onOpenAdvanced: (target?: ConsoleScrollTarget) => void;
};

function toneOfHero(tone: ConsoleModel["hero"]["tone"]): "ok" | "warn" | "fail" | "idle" {
  if (tone === "run") return "ok";
  return tone;
}

export function CaptureConsoleView({
  model,
  ariaLabel = "采集进度 / Capture Progress",
  notice,
  error,
  topAlert,
  planSlot,
  advanced,
  footer,
  noRunContent,
  busy = false,
  advancedOpen,
  onAdvancedOpenChange,
  onIssueAction,
  onOpenPlan,
  onOpenAdvanced,
}: CaptureConsoleViewProps) {
  const { hero, progress, evidence, sample } = model;
  const running = hero.progressState === "running";

  return (
    <section
      className={styles.root}
      data-testid="capture-console"
      aria-label={ariaLabel}
    >
      {error}

      <section
        className={styles.hero}
        data-tone={hero.tone}
        data-running={running ? "true" : "false"}
        aria-labelledby="capture-console-hero-title"
      >
        <div className={styles.heroTop}>
          <span className={styles.statusPill} data-tone={toneOfHero(hero.tone)} data-testid="capture-console-status">
            <i className={styles.liveDot} aria-hidden="true" />
            {hero.statusLabel}
          </span>
          <span className={styles.runMeta}>
            {[hero.runLabel, hero.updatedLabel ? `${hero.updatedLabel} 更新` : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <h2 className={styles.heroTitle} id="capture-console-hero-title" data-testid="capture-console-hero-title">
          {hero.title}
        </h2>
        <p className={styles.heroSub} data-testid="capture-console-hero-subtitle">{hero.subtitle}</p>
        <div className={styles.heroFoot}>
          <span className={styles.heroNote}>
            {model.hasRun ? "处理 ≠ 资料完整" : "计划确认后才会创建任务"}
          </span>
          {hero.suggestion ? <span className={styles.heroHint}>建议：{hero.suggestion}</span> : null}
          {hero.issueLabel ? (
            <button
              type="button"
              className={styles.heroIssue}
              onClick={() => onIssueAction({ kind: "scroll", label: "查看", target: "issues" })}
              data-testid="capture-console-hero-issue"
            >
              <i className={styles.issueDot} aria-hidden="true" />
              {hero.issueLabel}
            </button>
          ) : null}
        </div>
      </section>

      {topAlert}

      {model.hasRun ? (
        <>
          <CaptureProgressBar progress={progress} />

          <div className={styles.two}>
            <CaptureEvidenceRing evidence={evidence} />
            <section className={styles.card} aria-label="批次有效样本（市场研究门槛）">
              <div className={styles.sampleCard}>
                <p className={styles.k}>批次有效样本</p>
                <p className={styles.v} data-testid="capture-console-sample">
                  {sample.current ?? "—"}
                  <small> / {sample.required}</small>
                </p>
                <p
                  className={styles.sampleState}
                  data-tone={sample.sufficient === true ? "ok" : sample.sufficient === false ? "warn" : "idle"}
                  data-testid="capture-console-sample-state"
                >
                  {sample.label}
                </p>
                <p className={styles.sampleNote}>{sample.note}</p>
              </div>
            </section>
          </div>

          <CaptureBasicCapabilities capabilities={model.basic} summary={model.basicSummary} />
          <CaptureSupplementaryCapabilities
            capabilities={model.supplementary}
            summary={model.supplementarySummary}
          />

          <section className={styles.section} id="capture-console-issues" aria-labelledby="capture-console-issues-title">
            <div className={styles.sectionHead}>
              <h3 id="capture-console-issues-title">需要你处理</h3>
              <span>{model.issues.length ? `${model.issues.length} 项` : "无阻塞"}</span>
            </div>
            {model.issues.length ? (
              <div className={styles.issueList}>
                {model.issues.map((issue) => {
                  const action = issue.action;
                  const actionDisabled = busy && action != null && (action.kind === "retry" || action.kind === "resume");
                  return (
                    <div
                      key={issue.id}
                      className={styles.issueCard}
                      data-tone={issue.tone}
                      data-testid={`capture-console-issue-${issue.id}`}
                    >
                      <span className={styles.issueIcon} aria-hidden="true">
                        <AlertTriangle size={13} />
                      </span>
                      <div className={styles.issueCopy}>
                        <b>{issue.title}</b>
                        <p>{issue.description}</p>
                      </div>
                      {action ? (
                        <button
                          type="button"
                          className={styles.issueAction}
                          disabled={actionDisabled}
                          onClick={() => onIssueAction(action)}
                        >
                          {action.label}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.quiet} data-testid="capture-console-quiet">
                <i className={styles.quietDot} aria-hidden="true" />
                {running
                  ? "暂无阻塞，采集会按服务端快照自动推进"
                  : "当前没有受限、失败或需人工处理的记录"}
              </div>
            )}
          </section>

          <section className={styles.section} aria-labelledby="capture-console-plan-title">
            <div className={styles.sectionHead}>
              <h3 id="capture-console-plan-title">本轮计划</h3>
            </div>
            <div className={styles.planRow}>
              <div className={`${styles.planCol} ${styles.planGrow}`}>
                <span>范围</span>
                <b data-testid="capture-console-plan-scope">{model.plan.scope}</b>
              </div>
              <div className={styles.planCol}>
                <span>授权</span>
                <b data-testid="capture-console-plan-authorized">{model.plan.authorized}</b>
              </div>
              <div className={styles.planCol}>
                <span>导航预算</span>
                <b data-testid="capture-console-plan-navigation">{model.plan.navigation}</b>
                {model.plan.navigationDetail ? <span>{model.plan.navigationDetail}</span> : null}
              </div>
              <button type="button" className={styles.link} onClick={onOpenPlan}>
                查看计划
              </button>
            </div>
          </section>

          {planSlot}

          <details
            className={styles.advanced}
            id="capture-console-advanced"
            data-testid="capture-console-advanced"
            open={advancedOpen}
            onToggle={(event) => onAdvancedOpenChange((event.target as HTMLDetailsElement).open)}
          >
            <summary>
              <span>高级信息</span>
              <span>执行统计 · 模块矩阵 · 查询任务 · 研究资格</span>
            </summary>
            <div className={styles.advancedBody}>{advanced}</div>
          </details>
        </>
      ) : (
        <>
          {model.noRunGuidance ? (
            <div className={styles.noRun} data-testid="capture-console-no-run">
              <p className={styles.noRunKicker}>尚未开始</p>
              <p className={styles.noRunTitle}>{model.noRunGuidance.title}</p>
              <p className={styles.noRunBody}>{model.noRunGuidance.body}</p>
              <p className={styles.noRunHint}>{model.noRunGuidance.planHint}</p>
            </div>
          ) : null}
          {noRunContent}
        </>
      )}

      {notice}
      {footer}
    </section>
  );
}
