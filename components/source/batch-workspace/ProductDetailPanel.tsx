"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import { moduleHasEvidence, moduleWasExecuted } from "@/lib/sourceLayer/moduleCoverageSummary";
import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";
import {
  fieldLabel,
  formatProvenanceTime,
  type FieldProvenanceEntry,
} from "@/components/source/source-provenance/fieldProvenancePresentation";
import {
  MODULE_LIMITATION_LABELS,
  MODULE_STATUS_LABELS,
  moduleAttemptMessage,
  moduleStatusTone,
} from "./modulePresentation";
import {
  amazonProductUrl,
  formatAmazonSalesSignal,
  formatBsrDisplay,
  formatMoneyValue,
  formatRatingDisplay,
  formatReviewCountDisplay,
  marketplaceCode,
  resolveGalleryTitle,
  resolveUsagePresentation,
  type AmazonSalesSignalLike,
  type GalleryItem,
} from "./presentation";
import styles from "./ProductReviewPanel.module.css";

type DetailModuleEntry = {
  module: string;
  label: string;
  status: ProductModuleStatus;
  capturedAt: string | null;
  evidenceId: string | null;
  evidenceOnly: boolean | null;
  limitations: string[];
  errorCode: string | null;
  retryable: boolean | null;
  latestAttempt: { message: string; errorCode: string | null } | null;
};

export type DetailItem = GalleryItem & {
  updatedAt: string;
  moduleCoverage?: DetailModuleEntry[];
  enrichmentFieldProvenance?: FieldProvenanceEntry[];
  estimatedMonthlySales?: number | null;
  amazonSalesSignal?: AmazonSalesSignalLike | null;
  positiveReasons?: string[];
  counterSignals?: string[];
  missingSignals?: string[];
  category?: string | null;
};

type ModuleNotice = { tone: "success" | "error" | "info"; message: string };

const RECOLLECTABLE_MODULES = ["amazon_detail", "variation", "review_voc"];

const BASIC_MODULES = [
  "amazon_detail",
  "variation",
  "review_voc",
  "amazon_search_market",
] as const;

const SUPPLEMENTARY_MODULES = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
] as const;

/** 中文优先的模块名；技术全名保留在高级信息。 */
const REVIEW_MODULE_LABELS: Record<string, string> = {
  amazon_detail: "Amazon 商品详情",
  variation: "父子变体",
  review_voc: "评论与买家声音",
  amazon_search_market: "Amazon 搜索市场",
  sellersprite_product_market: "卖家精灵商品市场",
  reverse_asin: "反查 ASIN",
  keyword_mining_trend: "关键词挖掘与趋势",
  historical_trend: "历史趋势",
};

const BATCH_STATUS_LABELS: Record<string, string> = {
  ready: "批次可执行",
  processing: "批次处理中",
  blocked: "批次受阻",
  invalid: "批次无效",
  not_created: "批次未创建",
  archived: "批次已归档",
};

function moduleLabel(module: string, fallback?: string): string {
  return REVIEW_MODULE_LABELS[module] ?? fallback ?? module;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function emptyModuleEntry(module: string): DetailModuleEntry {
  return {
    module,
    label: moduleLabel(module),
    status: "NOT_COLLECTED",
    capturedAt: null,
    evidenceId: null,
    evidenceOnly: null,
    limitations: [],
    errorCode: null,
    retryable: null,
    latestAttempt: null,
  };
}

function chipTone(tone: "ok" | "warn" | "bad" | "off"): "ok" | "warn" | "fail" | "off" {
  return tone === "bad" ? "fail" : tone;
}

/** 真实图片：无 src / 加载失败都使用占位，不出现破图。 */
function ReviewThumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  const normalized = typeof src === "string" && src.trim() ? src.trim() : null;
  const [state, setState] = useState<"loading" | "loaded" | "failed">(normalized ? "loading" : "failed");

  useEffect(() => {
    setState(normalized ? "loading" : "failed");
  }, [normalized]);

  if (!normalized || state === "failed") {
    return (
      <div className={styles.thumb} data-testid="review-product-image" data-image-state="PLACEHOLDER">
        <span className={styles.thumbPlaceholder}>
          <ImageOff size={22} strokeWidth={1.5} aria-hidden="true" />
          <span>{normalized ? "图片加载失败" : "暂无图片"}</span>
        </span>
      </div>
    );
  }

  return (
    <div className={styles.thumb} data-testid="review-product-image" data-image-state={state === "loaded" ? "REAL_IMAGE" : "LOADING"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={normalized}
        alt={alt}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        style={{ opacity: state === "loaded" ? 1 : 0 }}
        onLoad={(event) => {
          const img = event.currentTarget;
          setState(img.naturalWidth > 0 && img.naturalHeight > 0 ? "loaded" : "failed");
        }}
        onError={() => setState("failed")}
      />
    </div>
  );
}

function ModuleRow({
  entry,
  batchStatus,
  busy,
  notice,
  onViewEvidence,
  onRecollect,
  onLocateMatrix,
  focused,
}: {
  entry: DetailModuleEntry;
  batchStatus: string | null;
  busy: boolean;
  notice: ModuleNotice | undefined;
  onViewEvidence: () => void;
  onRecollect: () => void;
  onLocateMatrix?: () => void;
  focused?: boolean;
}) {
  const limitationText = entry.limitations
    .map((limitation) => MODULE_LIMITATION_LABELS[limitation] ?? limitation)
    .join("；");
  const latestAttemptText = entry.latestAttempt
    ? moduleAttemptMessage(entry.latestAttempt.message, entry.latestAttempt.errorCode)
    : null;
  const limitationAlreadyVisible = Boolean(limitationText && limitationText === latestAttemptText);
  const hasProblem = Boolean(limitationText || entry.errorCode);
  const statusLabel = MODULE_STATUS_LABELS[entry.status] ?? entry.status;
  const tone = chipTone(moduleStatusTone(entry.status));

  return (
    <div className={styles.moduleRow} data-testid={`source-module-${entry.module}`} data-module-focused={focused} tabIndex={-1}>
      <div className={styles.moduleHead}>
        <span className={styles.moduleName}>{moduleLabel(entry.module, entry.label)}</span>
        <span className={styles.moduleStatus} data-tone={tone}>{statusLabel}</span>
      </div>

      <p className={styles.moduleMeta}>
        {entry.evidenceId ? (
          <>已保存证据{entry.evidenceOnly ? " · 可供研究参考" : ""}{entry.capturedAt ? ` · ${formatShortDate(entry.capturedAt)}` : ""}</>
        ) : (
          <>无证据附件</>
        )}
        {entry.latestAttempt ? (
          <span data-testid={`source-module-attempt-${entry.module}`}> · 最近尝试：{latestAttemptText}</span>
        ) : null}
      </p>

      {limitationText && !limitationAlreadyVisible ? (
        <p className={styles.moduleProblem}>
          {limitationText}
          {entry.retryable === true ? " · 可重试" : ""}
        </p>
      ) : null}

      <div className={styles.moduleActions}>
        {onLocateMatrix ? <button type="button" className={styles.textBtn} onClick={onLocateMatrix}>在矩阵定位</button> : null}
        {entry.evidenceId ? (
          <button type="button" className={styles.textBtn} onClick={onViewEvidence}>
            查看证据
          </button>
        ) : null}
        {RECOLLECTABLE_MODULES.includes(entry.module) ? (
          <button
            type="button"
            className={styles.textBtn}
            onClick={onRecollect}
            disabled={busy || batchStatus !== "ready"}
            title={batchStatus !== "ready" ? "当前批次状态不可执行采集" : undefined}
            data-testid={`source-module-recollect-${entry.module}`}
          >
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
            重新采集
          </button>
        ) : null}
        {entry.module === "amazon_search_market" ? (
          <span className={styles.textBtn} data-tone="muted">按批次原关键词执行；用批次「更多」重采</span>
        ) : null}
        {["reverse_asin", "keyword_mining_trend"].includes(entry.module) && entry.status === "NOT_COLLECTED" ? (
          <span className={styles.textBtn} data-tone="muted">需要 SellerSprite 页面或官方导出；不从 Amazon 结果推断</span>
        ) : null}
        {hasProblem ? (
          <details>
            <summary className={styles.textBtn} data-tone="muted">查看限制原因</summary>
            <p className={styles.moduleProblem} style={{ marginTop: 4 }}>
              {limitationAlreadyVisible
                ? `上述最近尝试就是当前限制原因。${entry.retryable === true ? "此项可重试。" : ""}`
                : limitationText
                  || (entry.status === "LOGIN_REQUIRED" ? "需要登录数据来源后重试。"
                    : entry.status === "EXTENSION_REQUIRED" ? "需要安装并启用对应浏览器插件。"
                      : entry.status === "PLAN_LIMITED" ? "当前套餐未开放此能力；未推测具体套餐。"
                        : entry.status === "HUMAN_ACTION_REQUIRED" || entry.status === "FAILED_HUMAN" ? "需要人工处理页面提示；系统不会绕过验证码或自动输入凭据。"
                          : "本模块没有取得可用证据。")}
            </p>
          </details>
        ) : null}
      </div>

      {notice ? (
        <p
          className={styles.moduleProblem}
          style={{ color: notice.tone === "error" ? "#8f342b" : notice.tone === "info" ? "#96620c" : "#0a604a" }}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}

export function ProductDetailPanel({
  item,
  moduleFocus,
  onLocateMatrix,
  marketplace,
  sourceLabel,
  batchStatus,
  detailBatchStatus,
  moduleCoverage,
  moduleRecollectBusy,
  moduleActionNotice,
  onViewModuleEvidence,
  onRecollect,
  onClose,
  reviewIndex,
  reviewTotal,
  onPrev,
  onNext,
  isVisibleInFilter,
  onClearFilters,
  onArchive,
  onRestore,
  onDelete,
  itemBusy,
  shortcutsEnabled,
}: {
  item: DetailItem;
  moduleFocus?: { module: string; token: number } | null;
  onLocateMatrix?: (module: string) => void;
  marketplace: string | null;
  sourceLabel: string;
  batchStatus: string | null;
  detailBatchStatus: { batchLabel: string; evidenceLabel: string };
  moduleCoverage: DetailModuleEntry[] | undefined;
  moduleRecollectBusy: (module: string) => boolean;
  moduleActionNotice: (module: string) => ModuleNotice | undefined;
  onViewModuleEvidence: (module: string) => void;
  onRecollect: (module: string) => void;
  onClose: () => void;
  reviewIndex: number;
  reviewTotal: number;
  onPrev: () => void;
  onNext: () => void;
  isVisibleInFilter: boolean;
  onClearFilters: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  itemBusy: boolean;
  shortcutsEnabled: boolean;
}) {
  const title = resolveGalleryTitle(item);
  const usage = resolveUsagePresentation(item);
  const price = formatMoneyValue(item.price?.value, item.price?.currency);
  const rating = formatRatingDisplay(item.rating);
  const review = formatReviewCountDisplay(item.reviewCount);
  const reviewCountText = review.text ? review.text.replace(/条评价$/u, "条") : null;
  const reviewPendingText = review.text ? review.text.replace(/^评论数/u, "") : null;
  const bsr = formatBsrDisplay(item.bsr);
  const market = marketplaceCode(item.marketplace ?? marketplace);
  const amazonUrl = amazonProductUrl(item.asin, item.marketplace ?? marketplace);
  const coverage = moduleCoverage ?? item.moduleCoverage ?? [];
  const coverageByModule = new Map(coverage.map((entry) => [entry.module, entry]));
  const basicEntries = BASIC_MODULES.map((module) => coverageByModule.get(module) ?? emptyModuleEntry(module));
  const supplementaryEntries = SUPPLEMENTARY_MODULES.map((module) => coverageByModule.get(module) ?? emptyModuleEntry(module));
  const allEntries = [...basicEntries, ...supplementaryEntries];
  const evidenceModules = allEntries.filter(moduleHasEvidence).length;
  const executedModules = allEntries.filter(moduleWasExecuted).length;
  const receiptOnlyModules = allEntries.filter((entry) => moduleWasExecuted(entry) && !moduleHasEvidence(entry)).length;
  const notCollectedModules = allEntries.filter((entry) => entry.status === "NOT_COLLECTED").length;
  const canPrev = reviewIndex > 0;
  const canNext = reviewIndex >= 0 && reviewIndex < reviewTotal - 1;
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const focusedOnce = useRef(false);

  useEffect(() => {
    if (!focusedOnce.current) {
      focusedOnce.current = true;
      closeRef.current?.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [item.id]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='true'], [data-testid='product-material-matrix']"))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && canPrev) {
        event.preventDefault();
        onPrev();
        return;
      }
      if (event.key === "ArrowRight" && canNext) {
        event.preventDefault();
        onNext();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcutsEnabled, canPrev, canNext, onClose, onPrev, onNext]);

  useEffect(() => {
    if (!moduleFocus || !panelRef.current) return;
    const panel = panelRef.current;
    const row = panel.querySelector<HTMLElement>(`[data-testid="source-module-${moduleFocus.module}"]`);
    if (!row) return;
    let ancestor = row.parentElement;
    while (ancestor && ancestor !== panel) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
    const header = panel.querySelector("header")?.getBoundingClientRect().height ?? 190;
    panel.scrollTop += row.getBoundingClientRect().top - panel.getBoundingClientRect().top - header - 12;
    row.focus({ preventScroll: true });
  }, [item.id, moduleFocus]);

  const fieldProvenance = item.enrichmentFieldProvenance ?? [];
  const batchLabel = batchStatus ? BATCH_STATUS_LABELS[batchStatus] ?? `批次状态 ${batchStatus}` : "批次状态未知";
  const evidenceLabel = detailBatchStatus.evidenceLabel;

  return (
    <aside
      id={`gallery-detail-${item.id}`}
      data-testid="batch-product-detail"
      className={styles.panel}
      aria-label={`${title.primary} 商品检阅`}
      ref={panelRef}
    >
      <header className={styles.head}>
        <div className={styles.headTop}>
          <span className={styles.eyebrow}>商品检阅</span>
          <span className={styles.index} data-testid="review-index" aria-live="polite">
            {reviewIndex >= 0 ? `${reviewIndex + 1} / ${reviewTotal}` : "不在当前筛选"}
          </span>
        </div>

        <h2 className={styles.title} title={title.primary} data-testid="review-title">{title.primary}</h2>
        {title.secondaryOriginal ? (
          <p className={styles.original} title={title.secondaryOriginal}>{title.secondaryOriginal}</p>
        ) : null}
        <p className={styles.meta}>
          <span className={styles.mono}>{item.asin}</span>
          <span>·</span>
          <span>{title.categoryNote || "类目未记录"}</span>
          <span>·</span>
          <span>Amazon {market}</span>
        </p>

        <div className={styles.nav}>
          <button
            type="button"
            className={styles.navBtn}
            onClick={onPrev}
            disabled={!canPrev}
            aria-label="上一件商品"
            title="上一件商品（←）"
            data-testid="review-prev"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={onNext}
            disabled={!canNext}
            aria-label="下一件商品"
            title="下一件商品（→）"
            data-testid="review-next"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <span className={styles.navSpacer} />
          {amazonUrl ? (
            <a
              className={styles.navBtn}
              href={amazonUrl}
              target="_blank"
              rel="noreferrer noopener"
              title="在 Amazon 查看来源"
              aria-label="在 Amazon 查看来源"
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : null}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="关闭商品检阅"
            title="关闭（Esc）"
            data-testid="review-close"
            ref={closeRef}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {!isVisibleInFilter ? (
          <div className={styles.warning} role="status" data-testid="review-filtered-out">
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <strong>当前商品已被搜索或筛选条件隐藏</strong>
              <p>上下件只会在当前可见商品中切换；不会静默跳到另一件商品。</p>
            </div>
            <button type="button" className={styles.warningAction} onClick={onClearFilters}>
              清除筛选并继续
            </button>
          </div>
        ) : null}

        {item.archivedAt ? (
          <div className={styles.warning} role="status" data-testid="review-archived">
            <Archive size={15} aria-hidden="true" />
            <div>
              <strong>该商品已归档</strong>
              <p>归档不改变市场研究样本；恢复后仍按原条目身份与证据引用展示。</p>
            </div>
            <button type="button" className={styles.warningAction} onClick={onRestore} disabled={itemBusy}>
              恢复商品
            </button>
          </div>
        ) : null}

        <section className={styles.hero} aria-label="价格与状态">
          <ReviewThumb src={item.image} alt={title.primary} />
          <div className={styles.heroMain}>
            <div className={styles.priceRow}>
              {price ? (
                <span className={styles.price} data-testid="review-price">{price.text}</span>
              ) : (
                <span className={styles.priceUnknown}>价格未知</span>
              )}
              {item.price?.status === "estimated" ? <span className={styles.priceNote}>估算</span> : null}
              {item.price?.status === "conflict" ? <span className={styles.priceNote}>待核对</span> : null}
            </div>

            <div className={styles.heroFacts}>
              <span className={styles.heroFact} data-tone={!rating || rating.pending ? "warn" : undefined}>
                评分 <b>{rating ? (rating.pending ? "待核对" : rating.text) : "暂无"}</b>
              </span>
              <span className={styles.heroFact} data-tone={!reviewCountText || review.pending ? "warn" : undefined}>
                评价 <b>{review.pending ? (reviewPendingText ?? "待核对") : (reviewCountText ?? "暂无")}</b>
              </span>
            </div>

            <div className={styles.statusRow} data-testid="batch-product-capture-status">
              <span className={styles.chip} data-tone={usage.tone === "ok" ? "ok" : usage.tone === "warn" ? "warn" : "off"}>{usage.label}</span>

            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="review-core-title">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="review-core-title">核心资料</h3>

          </div>
          <dl className={styles.factGrid}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>品牌</dt>
              <dd className={styles.factValue} data-tone={item.brand ? undefined : "muted"}>{item.brand?.trim() || "品牌未记录"}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>类目</dt>
              <dd className={styles.factValue} data-tone={title.categoryNote ? undefined : "muted"}>{title.categoryNote || "类目未记录"}</dd>
            </div>
            <div className={styles.fact} data-testid="batch-product-bsr">
              <dt className={styles.factLabel}>BSR 排名</dt>
              <dd className={styles.factValue} data-tone={bsr ? undefined : "muted"}>
                {bsr ?? "暂无可靠 BSR"}
                {item.chineseCategory || item.bsr?.category ? (
                  <span className={styles.factNote}> · {item.chineseCategory ?? item.bsr?.category}</span>
                ) : null}
              </dd>
            </div>
            <div className={styles.fact} data-testid="batch-product-sales">
              <dt className={styles.factLabel}>月销估算（第三方）</dt>
              <dd className={styles.factValue} data-tone={item.estimatedMonthlySales != null ? undefined : "muted"}>
                {item.estimatedMonthlySales != null
                  ? `${Number(item.estimatedMonthlySales).toLocaleString("en-US")} 件/月`
                  : "暂无数据"}
              </dd>
            </div>
            <div className={styles.fact} data-testid="batch-product-amazon-sales-signal">
              <dt className={styles.factLabel}>Amazon 购买量提示</dt>
              <dd className={styles.factValue} data-tone={item.amazonSalesSignal ? undefined : "muted"}>
                {item.amazonSalesSignal
                  ? <span title={item.amazonSalesSignal.rawText ?? undefined}>{formatAmazonSalesSignal(item.amazonSalesSignal)}</span>
                  : "暂无数据"}
              </dd>
            </div>

          </dl>
          {item.amazonSalesSignal ? (
            <p className={styles.factNote}>Amazon 购买量提示来自搜索页，是页面提示，不是月销估算；月销估算为第三方数据。</p>
          ) : null}
        </section>

        {((item.positiveReasons?.length ?? 0) > 0 || (item.counterSignals?.length ?? 0) > 0 || (item.missingSignals?.length ?? 0) > 0) ? (
          <section className={styles.section} aria-labelledby="review-signals-title" data-testid="batch-product-signals">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle} id="review-signals-title">选品信号</h3>
              <span className={styles.sectionHint}>既有记录 · 非自动决策</span>
            </div>
            <div className={styles.statusRow}>
              {(item.positiveReasons ?? []).slice(0, 3).map((reason, index) => (
                <span key={`p-${index}`} className={styles.chip} data-tone="ok" title={reason}>
                  <Check size={11} aria-hidden="true" />
                  {reason}
                </span>
              ))}
              {(item.counterSignals ?? []).slice(0, 2).map((signal, index) => (
                <span key={`c-${index}`} className={styles.chip} data-tone="warn" title={signal}>
                  <AlertTriangle size={11} aria-hidden="true" />
                  {signal}
                </span>
              ))}
              {(item.missingSignals?.length ?? 0) > 0 ? (
                <details>
                  <summary className={styles.chip} data-tone="off">缺失信号 {item.missingSignals!.length}</summary>
                  <p className={styles.factNote}>{item.missingSignals!.join("、")}</p>
                </details>
              ) : null}
            </div>
          </section>
        ) : null}

        {basicEntries.some((entry) => entry.status !== "COMPLETE" && entry.status !== "NOT_COLLECTED") ? (
          <div className={styles.gaps} data-testid="review-real-gaps">
            <strong>资料待处理</strong>
            {basicEntries.filter((entry) => entry.status !== "COMPLETE" && entry.status !== "NOT_COLLECTED").map((entry) => (
              <button type="button" key={entry.module} onClick={() => { if (entry.evidenceId) onViewModuleEvidence(entry.module); else panelRef.current?.querySelector<HTMLDetailsElement>('[data-testid="source-module-coverage"]')?.setAttribute("open", ""); }}>
                {moduleLabel(entry.module, entry.label)} · {MODULE_STATUS_LABELS[entry.status]}
              </button>
            ))}
          </div>
        ) : null}

        <details className={styles.more} data-testid="source-module-coverage">
          <summary>资料状态 · {evidenceModules}/8 类有证据｜查看模块</summary>
          <div className={styles.moreBody}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="review-status-title">资料状态</h3>
            <span className={styles.sectionHint}>基础能力 {basicEntries.filter((entry) => entry.evidenceId).length}/4 有证据</span>
          </div>
          <div className={styles.moduleList}>
            {basicEntries.map((entry) => (
              <ModuleRow
                key={entry.module}
                entry={entry}
                batchStatus={batchStatus}
                busy={moduleRecollectBusy(entry.module)}
                notice={moduleActionNotice(entry.module)}
                onViewEvidence={() => onViewModuleEvidence(entry.module)}
                onRecollect={() => onRecollect(entry.module)}
                onLocateMatrix={onLocateMatrix ? () => onLocateMatrix(entry.module) : undefined}
                focused={moduleFocus?.module === entry.module}
              />
            ))}
          </div>

          <details className={styles.more}>
            <summary>
              <span>补充能力与全部 8 个模块</span>
              <span className={styles.sectionHint}>
                有证据 {supplementaryEntries.filter((entry) => entry.evidenceId).length}/4
              </span>
            </summary>
            <div className={styles.moreBody}>
              {supplementaryEntries.map((entry) => (
                <ModuleRow
                  key={entry.module}
                  entry={entry}
                  batchStatus={batchStatus}
                  busy={moduleRecollectBusy(entry.module)}
                  notice={moduleActionNotice(entry.module)}
                  onViewEvidence={() => onViewModuleEvidence(entry.module)}
                  onRecollect={() => onRecollect(entry.module)}
                  onLocateMatrix={onLocateMatrix ? () => onLocateMatrix(entry.module) : undefined}
                  focused={moduleFocus?.module === entry.module}
                />
              ))}
            </div>
          </details>
          </div>
        </details>

        <details className={styles.more}>
          <summary>证据与来源 · {evidenceModules}/8 类｜查看</summary>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="review-evidence-title">证据与来源</h3>
            <span className={styles.sectionHint}>以 EvidenceStore 为准</span>
          </div>
          <div className={styles.evidenceBox}>
            <div className={styles.evidenceStats}>
              <span>{detailBatchStatus.batchLabel} · {batchLabel}</span>
              <span>有证据 <b>{evidenceModules}</b>/8</span>
              <span>已执行 <b>{executedModules}</b>/8</span>
              <span>仅回执 <b>{receiptOnlyModules}</b></span>
              <span>未采集 <b>{notCollectedModules}</b></span>
            </div>
            <p className={styles.note}>
              执行 ≠ 取得数据；有附件也不等于资料完整。商品级证据按既有边界进入研究输入，
              是否已被研报实际消费需在研究侧另行核对。
            </p>
            <p className={styles.note}>
              来源：{sourceLabel} · 详情证据：<span data-testid="amazon-detail-evidence-linkage">{evidenceLabel}</span>
            </p>
            <p className={styles.monoSmall}>
              条目 {item.id} · ASIN {item.asin} · Amazon {market}
              {item.batchId ? ` · 批次 ${item.batchId.slice(0, 8)}…` : ""}
            </p>
          </div>
        </details>

        <details className={styles.more} data-testid="review-field-provenance">
          <summary>字段来源 · {fieldProvenance.length} 条｜查看</summary>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="review-provenance-title">字段来源</h3>
            <span className={styles.sectionHint}>{fieldProvenance.length} 个字段有来源记录</span>
          </div>
          {fieldProvenance.length > 0 ? (
            <div className={styles.evidenceBox}>
              <div className={styles.provenanceList}>
                {fieldProvenance.slice(0, 6).map((entry) => (
                  <div key={`${entry.field}:${entry.evidenceId}:${entry.evidenceVersion}`} className={styles.provenanceRow}>
                    <span className={styles.provenanceField}>{fieldLabel(entry.field)}</span>
                    <span className={styles.provenanceMeta}>版本 {entry.evidenceVersion} · {formatProvenanceTime(entry.capturedAt)}</span>
                  </div>
                ))}
              </div>
              {fieldProvenance.length > 6 ? (
                <p className={styles.note}>另有 {fieldProvenance.length - 6} 个字段来源记录，详见资料证据高级信息。</p>
              ) : null}
              <p className={styles.note}>
                字段来源记录指向具体证据版本；当前接口按商品 + 模块读取最新模块，历史版本内容暂不可直接读取，
                不能把最新模块内容当作该字段的历史版本内容。
              </p>
              <button type="button" className={styles.textBtn} onClick={() => onViewModuleEvidence("amazon_detail")}>
                查看最新详情证据
              </button>
            </div>
          ) : (
            <p className={styles.note} data-testid="review-field-provenance-empty">
              当前商品没有字段级来源记录；这不等于没有模块证据，可查看下方模块证据。
            </p>
          )}
        </details>

        <section className={styles.section} aria-labelledby="review-actions-title">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="review-actions-title">可执行操作</h3>

          </div>
          <div className={styles.actionRow}>
            {amazonUrl ? (
              <a className={styles.actionBtn} href={amazonUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} aria-hidden="true" />
                在 Amazon 查看
              </a>
            ) : null}
            {item.archivedAt ? (
              <button type="button" className={styles.actionBtn} onClick={onRestore} disabled={itemBusy}>
                <RotateCcw size={14} aria-hidden="true" />
                恢复商品
              </button>
            ) : (
              <button type="button" className={styles.actionBtn} onClick={onArchive} disabled={itemBusy}>
                <Archive size={14} aria-hidden="true" />
                归档商品
              </button>
            )}
            <button type="button" className={`${styles.actionBtn} ${styles.dangerBtn}`} onClick={onDelete} disabled={itemBusy}>
              <Trash2 size={14} aria-hidden="true" />
              删除商品
            </button>
            <button type="button" className={styles.actionBtn} onClick={onClose}>
              <X size={14} aria-hidden="true" />
              关闭检阅
            </button>
          </div>

        </section>

        <details className={styles.advanced} data-testid="batch-product-detail-full">
          <summary>完整模块记录与技术信息</summary>
          <div className={styles.advancedBody}>
            <ul className={styles.advancedList}>
              {allEntries.map((entry) => (
                <li key={entry.module}>
                  <span>{moduleLabel(entry.module, entry.label)}</span>
                  <b>
                    {MODULE_STATUS_LABELS[entry.status]}
                    {entry.evidenceId ? " · 有证据" : " · 无证据"}
                  </b>
                </li>
              ))}
            </ul>
            <p className={styles.monoSmall}>
              条目 ID {item.id} · ASIN {item.asin} · 站点 {market} · 更新 {formatDateTime(item.updatedAt)}
            </p>
          </div>
        </details>
      </div>
    </aside>
  );
}
