"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ExternalLink,
  KeyRound,
  LayoutGrid,
  LineChart,
  MessageSquare,
  Package,
  Search,
  Store,
} from "lucide-react";

import {
  summarizeModuleCoverageTotals,
  summarizeSourceModuleCoverage,
} from "@/lib/sourceLayer/moduleCoverageSummary";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import {
  buildBatchProvenanceSummary,
  buildCoverageRows,
  buildProvenanceTimeline,
  formatProvenanceDateTime,
  formatProvenanceShortTime,
  moduleStatusLabel,
  PROVENANCE_BATCH_STATUS_LABELS,
  PROVENANCE_MODULE_LABELS,
  type ProvenanceCoverageRow,
  type ProvenanceEvent,
  type ProvenanceItem,
} from "./sourceProvenanceModel";
import styles from "./SourceProvenancePanel.module.css";

const ICONS = {
  amazon_detail: Package,
  amazon_search_market: Search,
  variation: LayoutGrid,
  review_voc: MessageSquare,
  sellersprite_product_market: Store,
  reverse_asin: ArrowLeftRight,
  keyword_mining_trend: KeyRound,
  historical_trend: LineChart,
} as const;

function moduleIcon(module: string) {
  return ICONS[module as keyof typeof ICONS] ?? Package;
}

function sampleItemFor(items: readonly ProvenanceItem[], module: string): ProvenanceItem | null {
  return items.find((item) => !item.archivedAt
    && item.moduleCoverage?.some((entry) => entry.module === module && entry.evidenceId)) ?? null;
}

function CoverageRowView({
  row,
  sampleItem,
  onViewEvidence,
}: {
  row: ProvenanceCoverageRow;
  sampleItem: ProvenanceItem | null;
  onViewEvidence: (module: string, item: ProvenanceItem) => void;
}) {
  const Icon = moduleIcon(row.module);
  const counts = row.counts;
  return (
    <div
      className={styles.row}
      data-tone={row.tone}
      data-testid={`source-provenance-row-${row.module}`}
    >
      <span className={styles.rowIcon} aria-hidden="true"><Icon /></span>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span className={styles.rowName}>{row.label}</span>
          <span className={styles.pill} data-tone={row.tone}>{row.statusLabel}</span>
        </div>
        <div className={styles.rowMeta}>
          <span>有证据 <b>{row.evidenceCount}</b>/{row.itemCount} 件</span>
          <details className={styles.rowDetails}>
            <summary>状态明细</summary>
            <p>{row.note}</p>
            <p>部分 {counts.partial} · 受限 {counts.limited} · 需人工 {counts.human} · 受阻 {counts.blocked} · 未采集 {counts.notCollected} · 仅回执 {counts.receiptOnly}</p>
            {row.status === "not_in_scope" ? <p>未纳入本轮，需在采集计划中单独授权。</p> : null}
            {row.status === "scope_unknown" ? <p>本轮运行范围尚未读取。</p> : null}
          </details>
        </div>
      </div>
      {sampleItem ? (
        <button
          type="button"
          className={styles.rowAction}
          onClick={() => onViewEvidence(row.module, sampleItem)}
          data-testid={`source-provenance-view-${row.module}`}
        >
          查看证据
        </button>
      ) : (
        <span className={styles.rowMuted}>暂无证据</span>
      )}
    </div>
  );
}

function EventRow({
  event,
  item,
  onViewEvidence,
}: {
  event: ProvenanceEvent;
  item: ProvenanceItem | null;
  onViewEvidence: (module: string, item: ProvenanceItem) => void;
}) {
  return (
    <li className={styles.event} data-tone={event.tone} data-testid={`source-provenance-event-${event.id}`}>
      <div className={styles.eventMain}>
        <p className={styles.eventTitle}>{event.title}</p>
        <p className={styles.eventDetail}>{PROVENANCE_MODULE_LABELS[event.module] ?? "资料记录"}{item ? ` · ${item.asin}` : ""}</p>
        <details className={styles.scopeDetails}><summary>事件详情</summary><p className={styles.eventDetail}>{event.detail}</p></details>
        <p className={styles.eventTime}>{formatProvenanceDateTime(event.at)}</p>
      </div>
      {event.canViewEvidence && item ? (
        <button
          type="button"
          className={styles.eventAction}
          onClick={() => onViewEvidence(event.module, item)}
        >
          查看证据
        </button>
      ) : null}
    </li>
  );
}

export type SourceProvenancePanelProps = {
  batch: {
    id: string;
    batchName: string | null;
    batchStatus?: string | null;
    sourceType?: string | null;
    marketplace?: string | null;
    createdAt: string;
    itemCount: number;
    acceptedCount: number;
    validSampleCount: number;
    validSetSufficient: boolean;
    marketScan?: { id: string; scanName: string; sampleCount: number } | null;
  };
  sourceLabel: string;
  items: readonly ProvenanceItem[];
  captureRunSnapshot?: BatchCaptureRunSnapshot | null;
  detailJobView?: {
    job?: { status?: string | null } | null;
    progress?: { processed: number; total: number } | null;
  } | null;
  onViewModuleEvidence: (module: string, item: ProvenanceItem) => void;
};

export function SourceProvenancePanel({
  batch,
  sourceLabel,
  items,
  captureRunSnapshot = null,
  detailJobView = null,
  onViewModuleEvidence,
}: SourceProvenancePanelProps) {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const activeItems = items.filter((item) => !item.archivedAt);
  const coverageSummary = summarizeSourceModuleCoverage(activeItems);
  const totals = summarizeModuleCoverageTotals(coverageSummary);
  const runScopeKnown = captureRunSnapshot?.state === "present";
  const allowedModules = captureRunSnapshot?.state === "present"
    ? captureRunSnapshot.run.allowedModules
    : null;
  const rows = buildCoverageRows({
    summary: coverageSummary,
    activeItemCount: activeItems.length,
    runScopeKnown,
    allowedModules,
  });
  const summary = buildBatchProvenanceSummary({
    items,
    summary: coverageSummary,
    totals,
    rows,
    captureRunSnapshot,
  });
  const timeline = buildProvenanceTimeline(activeItems, showAllEvents ? Number.MAX_SAFE_INTEGER : 3);
  const batchStatusLabel = batch.batchStatus
    ? PROVENANCE_BATCH_STATUS_LABELS[batch.batchStatus] ?? `未知（${batch.batchStatus}）`
    : "未知";
  const evidenceRefCount = items.reduce((sum, item) => sum + (item.evidenceRefs?.length ?? 0), 0);
  const attempts = activeItems
    .flatMap((item) => (item.moduleCoverage ?? [])
      .filter((entry) => entry.latestAttempt?.attemptedAt)
      .map((entry) => ({
        key: `${item.id}:${entry.module}:${entry.latestAttempt!.attemptedAt}`,
        asin: item.asin,
        module: entry.module,
        status: entry.status,
        attemptedAt: entry.latestAttempt!.attemptedAt,
        message: entry.latestAttempt!.message,
        errorCode: entry.latestAttempt!.errorCode,
      })))
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))
    .slice(0, 8);

  return (
    <section className={styles.root} data-testid="source-provenance-panel" aria-label="资料与来源">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>{batch.batchName || "未命名批次"}</h2>
          <p className={styles.meta}>
            {sourceLabel} · {batch.marketplace || "US"} 站 · {batch.itemCount} 件商品
          </p>
        </div>
        <div className={styles.headActions}>
          {batch.marketScan ? (
            <a
              className={styles.headLink}
              href={`/market-analysis/${encodeURIComponent(batch.marketScan.id)}`}
            >
              <ExternalLink size={14} aria-hidden="true" />
              查看市场研究
            </a>
          ) : null}
        </div>
      </header>

      <section className={styles.overview} aria-label="资料概况">
        <div className={styles.overviewLine}>
          <span>已有资料 <b data-testid="source-provenance-modules">{summary.evidenceModules}/{summary.moduleCount} 类</b></span>
          <span>按商品覆盖 <b data-testid="source-provenance-cells">{summary.evidenceCells}/{summary.totalCells}</b></span>
        </div>
        <p className={styles.runLine} data-testid="source-provenance-run-scope">{summary.runScope.label}</p>
        <details className={styles.scopeDetails}>
          <summary>统计口径与更新</summary>
          <p className={styles.note}>{summary.scopeNote}</p>
          <p className={styles.note}>共 <span data-testid="source-provenance-total">{summary.totalItems}</span> 件 · 有效 {batch.validSampleCount} · 已归档 {summary.archivedItems}</p>
          <p className={styles.note}>最近证据更新 <span data-testid="source-provenance-last-update">{summary.lastEvidenceLabel}</span></p>
        </details>
      </section>

      <section className={styles.section} aria-labelledby="source-provenance-coverage-title">
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle} id="source-provenance-coverage-title">基础资料</h3>
          <span className={styles.sectionHint}>4 类</span>
        </div>
        <div className={styles.rows}>
          {rows.basic.map((row) => (
            <CoverageRowView
              key={row.module}
              row={row}
              sampleItem={sampleItemFor(activeItems, row.module)}
              onViewEvidence={onViewModuleEvidence}
            />
          ))}
        </div>

        <details className={styles.more} data-testid="source-provenance-supplementary">
          <summary>
            <span>补充来源 · 4 类</span>
            <span className={styles.sectionHint}>
              {rows.supplementary.filter((row) => row.evidenceCount > 0).length}/4 有证据
            </span>
          </summary>
          <div className={styles.moreBody}>
            {rows.supplementary.map((row) => (
              <CoverageRowView
                key={row.module}
                row={row}
                sampleItem={sampleItemFor(activeItems, row.module)}
                onViewEvidence={onViewModuleEvidence}
              />
            ))}
          </div>
        </details>
      </section>

      <section className={styles.section} aria-labelledby="source-provenance-problems-title">
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle} id="source-provenance-problems-title">需要关注</h3>
          <span className={styles.sectionHint}>按资料类型</span>
        </div>
        {summary.hasProblems ? (
          <div className={styles.problemChips} data-testid="source-provenance-problems">
            {summary.problemChips.map((chip) => (
              <span
                key={chip.key}
                className={styles.problemChip}
                data-tone={chip.tone}
                title={chip.detail}
              >
                <AlertTriangle size={12} aria-hidden="true" />
                {chip.label}
              </span>
            ))}
          </div>
        ) : (
          <div className={styles.quiet} data-testid="source-provenance-quiet">
            <i className={styles.quietDot} aria-hidden="true" />
            当前没有需要关注的资料问题
          </div>
        )}
        <details className={styles.scopeDetails}><summary>计数说明</summary><p className={styles.note}>同一资料类型可能包含不同状态单元。未纳入本轮不计作失败；有证据不等于资料完整。</p></details>
      </section>

      <section className={styles.section} aria-labelledby="source-provenance-timeline-title">
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle} id="source-provenance-timeline-title">最近记录</h3>
          <span className={styles.sectionHint}>
            最近 {timeline.events.length} 条{timeline.total > timeline.events.length ? ` / 共 ${timeline.total} 条` : ""}
          </span>
        </div>
        {timeline.events.length > 0 ? (
          <ol className={styles.timeline} data-testid="source-provenance-timeline">
            {timeline.events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                item={items.find((item) => item.id === event.itemId) ?? null}
                onViewEvidence={onViewModuleEvidence}
              />
            ))}
          </ol>

        ) : (
          <p className={styles.empty} data-testid="source-provenance-timeline-empty">
            暂无有依据的时间记录。没有真实 capturedAt / attemptedAt 时不生成事件。
          </p>
        )}
      </section>

      {timeline.total > 3 ? <button type="button" className={styles.historyToggle} onClick={() => setShowAllEvents(!showAllEvents)}>{showAllEvents ? "收起历史" : `查看全部 ${timeline.total} 条记录`}</button> : null}
      <details className={styles.advanced}>
        <summary>来源与批次信息</summary>
        <div className={styles.advancedBody}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle} id="source-provenance-identity-title">来源与身份</h3>
          <span className={styles.sectionHint}>只读 · 不改研究资格</span>
        </div>
        <div className={styles.identityGrid}>
          <div className={styles.identityItem}><span>来源</span><b>{sourceLabel}</b></div>
          <div className={styles.identityItem}><span>站点</span><b>{batch.marketplace || "US"}</b></div>
          <div className={styles.identityItem}><span>批次状态</span><b>{batchStatusLabel}</b></div>
          <div className={styles.identityItem}><span>批次创建</span><b>{formatProvenanceDateTime(batch.createdAt)}</b></div>
          <div className={styles.identityItem}>
            <span>有效样本</span>
            <b>{batch.validSampleCount} / {batch.itemCount} · {batch.validSetSufficient ? "已达研究门槛" : "未达研究门槛"}</b>
          </div>
          <div className={styles.identityItem}>
            <span>市场研究</span>
            <b>
              {batch.marketScan ? (
                <a className={styles.identityLink} href={`/market-analysis/${encodeURIComponent(batch.marketScan.id)}`}>
                  {batch.marketScan.scanName || "已关联"}
                </a>
              ) : "尚未建立"}
            </b>
          </div>
          <div className={styles.identityItem}>
            <span>批次 ID</span>
            <b className={styles.mono}>{batch.id}</b>
          </div>
          <div className={styles.identityItem}><span>商品记录</span><b>{batch.itemCount} 条 · 接受 {batch.acceptedCount}</b></div>
        </div>
        </div>
      </details>

      <details className={styles.advanced} data-testid="source-provenance-advanced">
        <summary>高级信息</summary>
        <div className={styles.advancedBody}>
          <h4>来源与证据边界</h4>
          <p className={styles.note} style={{ margin: 0 }}>
            EvidenceStore 是唯一原始证据权威；Research 只消费已采集事实，不重新采集。
            查询级证据（sellersprite:* 主体）不进入 ResearchInputBundle；商品级附件按既有边界进入研究输入，
            是否已被研报实际消费需在研究侧另行核对。
          </p>

          <ul className={styles.advancedList}>
            <li><span>批次 ID</span><b className={styles.mono}>{batch.id}</b></li>
            <li><span>证据引用</span><b>{evidenceRefCount} 条</b></li>
            <li>
              <span>历史详情任务</span>
              <b>
                {detailJobView?.job
                  ? `${detailJobView.job.status || "未知"} · 已处理 ${detailJobView.progress?.processed ?? 0}/${detailJobView.progress?.total ?? 0}`
                  : "暂无详情任务回执"}
              </b>
            </li>
            <li><span>批次记录</span><b>{summary.totalItems} 条 · 活跃 {summary.activeItems} · 归档 {summary.archivedItems}</b></li>
          </ul>

          <h4>模块最新尝试（按真实 attemptedAt）</h4>
          {attempts.length > 0 ? (
            <ul className={styles.attemptList} data-testid="source-provenance-attempts">
              {attempts.map((attempt) => (
                <li key={attempt.key}>
                  <span className={styles.mono}>{attempt.asin}</span>
                  {" · "}{PROVENANCE_MODULE_LABELS[attempt.module] ?? attempt.module}
                  {" · "}{moduleStatusLabel(attempt.status)}
                  {" · "}<span className={styles.attemptMeta}>{formatProvenanceShortTime(attempt.attemptedAt)}</span>
                  {" · "}{attempt.message}
                  {attempt.errorCode ? `（${attempt.errorCode}）` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>暂无模块尝试记录。</p>
          )}
          <p className={styles.note}>
            最新尝试不等于完整历史；没有真实时间戳的记录不会画成连续过程或完整趋势。
          </p>
        </div>
      </details>
    </section>
  );
}
