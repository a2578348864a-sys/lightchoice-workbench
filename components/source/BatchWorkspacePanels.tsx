"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";
import {
  moduleHasEvidence,
  summarizeModuleCoverageTotals,
  summarizeSourceModuleCoverage,
} from "@/lib/sourceLayer/moduleCoverageSummary";
import {
  MARKET_CAPTURE_MODULE_LABELS,
  type MarketCaptureModuleId,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";
import {
  describeCaptureRunPresence,
  type BatchCaptureRunSnapshot,
} from "@/lib/sourceLayer/batchCaptureRunSnapshot";

/** 批次状态原始枚举 → 中文；未知值保持原值并明确标注未知。 */
const BATCH_STATUS_DISPLAY: Record<string, string> = {
  processing: "处理中",
  ready: "可执行",
  blocked: "受阻",
  invalid: "无效",
  not_created: "未创建",
  archived: "已归档",
};

/** 历史面板使用的中文优先模块名（不改全局采集计划标签）。 */
const HISTORY_MODULE_LABELS: Record<string, string> = {
  amazon_detail: "Amazon 商品详情",
  amazon_search_market: "Amazon 搜索市场",
  sellersprite_product_market: "卖家精灵商品市场",
  reverse_asin: "反查 ASIN",
  keyword_mining_trend: "关键词挖掘与趋势",
  variation: "父子变体",
  review_voc: "评论与买家声音",
  historical_trend: "历史趋势",
};

/** 四项基础采集能力（业务层统一口径）。 */
export type BasicCaptureCapabilityId =
  | "product_sample"
  | "product_info"
  | "variation_structure"
  | "review_material";

export const BASIC_CAPTURE_CAPABILITIES: ReadonlyArray<{
  id: BasicCaptureCapabilityId;
  label: string;
  description: string;
  modules: readonly MarketCaptureModuleId[];
}> = [
  {
    id: "product_sample",
    label: "商品样本",
    description: "形成商品样本和批次，为市场研究提供研究范围。",
    modules: ["amazon_search_market"],
  },
  {
    id: "product_info",
    label: "商品信息",
    description: "取得商品基础事实及其来源证据。",
    modules: ["amazon_detail"],
  },
  {
    id: "variation_structure",
    label: "变体结构",
    description: "取得有证据支持的父子关系与关联变体信息。",
    modules: ["variation"],
  },
  {
    id: "review_material",
    label: "评论材料 / Review / VOC",
    description: "取得可追溯的原始评论材料；可能受登录或页面范围限制，需人工处理时如实显示。",
    modules: ["review_voc"],
  },
];

export const SUPPLEMENTAL_CAPTURE_MODULES: readonly MarketCaptureModuleId[] = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
];

type ModuleLike = {
  module: string;
  label: string;
  status: ProductModuleStatus;
  evidenceId: string | null;
  latestAttempt: unknown;
};

type ItemLike = {
  id: string;
  asin?: string | null;
  title?: string | null;
  moduleCoverage?: ModuleLike[];
  archivedAt?: string | null;
  evidenceStatus?: string | null;
  enrichmentStatus?: string | null;
  usageStatus?: string | null;
  price?: { value: number | null; status: string } | null;
  rating?: { value: number | null } | null;
  reviewCount?: { value: number | null } | null;
};

function statusLabel(status: string): string {
  switch (status) {
    case "COMPLETE": return "已完成";
    case "CAPTURED_PARTIAL": return "部分完成";
    case "NO_DATA_WITH_EVIDENCE": return "无数据（有证据）";
    case "AVAILABLE_WITH_LIMITATION": return "受限";
    case "BLOCKED_WITH_EVIDENCE": return "受限（有证据）";
    case "FAILED_HUMAN":
    case "HUMAN_ACTION_REQUIRED": return "需人工";
    case "LOGIN_REQUIRED": return "需登录";
    case "NOT_COLLECTED": return "未采集";
    default: return status || "未知";
  }
}

function summarizeCapability(entries: Array<ModuleLike | undefined>) {
  const defined = entries.filter((entry): entry is ModuleLike => Boolean(entry));
  const withEvidence = defined.filter((entry) => Boolean(entry.evidenceId)).length;
  const executed = defined.filter((entry) => entry.status !== "NOT_COLLECTED" || Boolean(entry.latestAttempt)).length;
  const human = defined.filter((entry) =>
    ["FAILED_HUMAN", "HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED"].includes(entry.status),
  ).length;
  const partial = defined.filter((entry) => entry.status === "CAPTURED_PARTIAL" || entry.status === "AVAILABLE_WITH_LIMITATION").length;
  const missing = entries.length - withEvidence;
  return { total: entries.length, withEvidence, executed, human, partial, missing };
}

function describeCapabilitySummary(summary: ReturnType<typeof summarizeCapability>, itemCount: number): string {
  if (itemCount === 0 || summary.total === 0) return "暂无商品可统计";
  if (summary.missing === 0 && summary.withEvidence > 0) return `${summary.withEvidence}/${summary.total} 件已有证据`;
  if (summary.human > 0) return `${summary.human} 件需人工处理`;
  if (summary.partial > 0) return `${summary.partial} 件部分/受限`;
  if (summary.withEvidence > 0) return `已有证据 ${summary.withEvidence} · 尚缺 ${summary.missing}`;
  return "尚未取得证据";
}

/**
 * 四项基础采集能力：简洁状态列表（非大卡片）。
 * 使用正式 moduleCoverage（执行 ≠ 取得数据），不另算成功率。
 */
export function FourBasicCapabilitiesStrip({
  items,
  sourceType,
}: {
  items: readonly ItemLike[];
  sourceType?: string | null;
}) {
  const activeItems = useMemo(
    () => items.filter((item) => !item.archivedAt && item.asin),
    [items],
  );

  return (
    <section
      data-testid="four-basic-capabilities"
      aria-label="四项基础采集能力"
      className="rounded-xl border border-slate-200/90 bg-white px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">四项基础采集能力</h3>
        <span className="text-[13px] text-slate-400">
          商品 {activeItems.length}{sourceType ? ` · ${sourceType === "amazon_search_capture" ? "Amazon 搜索" : "其他来源"}` : ""} · 执行结束 ≠ 资料完整
        </span>
      </div>
      <ul className="mt-2 divide-y divide-slate-100" data-testid="four-basic-capabilities-list">
        {BASIC_CAPTURE_CAPABILITIES.map((capability) => {
          const entries = activeItems.map((item) =>
            capability.modules
              .map((module) => item.moduleCoverage?.find((coverage) => coverage.module === module))
              .find(Boolean),
          );
          const summary = summarizeCapability(entries.filter(Boolean) as ModuleLike[]);
          const tone =
            summary.total === 0
              ? "slate"
              : summary.missing === 0 && summary.withEvidence > 0
                ? "emerald"
                : summary.human > 0
                  ? "amber"
                  : summary.withEvidence > 0
                    ? "blue"
                    : "slate";
          return (
            <li
              key={capability.id}
              data-testid={`basic-capability-${capability.id}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 text-[13px]"
            >
              <span className="font-semibold text-slate-800">{capability.label}</span>
              <Badge tone={tone}>{describeCapabilitySummary(summary, activeItems.length)}</Badge>
              {summary.human > 0 ? (
                <span className="text-amber-700">需人工处理，不会默认完成</span>
              ) : summary.withEvidence > 0 && summary.missing > 0 ? (
                <span className="text-slate-500">证据不完整</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type DetailJobLike = {
  job?: {
    status: string | null;
    createdAt?: string | null;
    lastErrorCode?: string | null;
  } | null;
  progress?: {
    processed: number;
    total: number;
    enriched: number;
    partial: number;
    reusedEvidence?: number;
  } | null;
} | null;

type CaptureRunPresence = BatchCaptureRunSnapshot | null | undefined;

/**
 * 依据与历史：模块覆盖汇总 + 来源身份 + 历史任务回执（默认可折叠的按需查看区）。
 */
export function BatchEvidenceHistoryPanel({
  batchId,
  batchName,
  batchStatus,
  sourceType,
  marketplace,
  createdAt,
  itemCount,
  acceptedCount,
  validSampleCount,
  validSetSufficient,
  marketScanId,
  items,
  detailJobView,
  captureRunSnapshot,
  onViewModuleEvidence,
}: {
  batchId: string;
  batchName: string | null;
  batchStatus?: string | null;
  sourceType?: string | null;
  marketplace?: string | null;
  createdAt: string;
  itemCount: number;
  acceptedCount: number;
  validSampleCount: number;
  validSetSufficient: boolean;
  marketScanId?: string | null;
  items: readonly ItemLike[];
  detailJobView?: DetailJobLike;
  captureRunSnapshot?: CaptureRunPresence;
  onViewModuleEvidence?: (module: string, sampleItem: ItemLike) => void;
}) {
  const activeItems = useMemo(() => items.filter((item) => !item.archivedAt), [items]);
  const coverage = useMemo(() => summarizeSourceModuleCoverage(activeItems), [activeItems]);
  const totals = useMemo(() => summarizeModuleCoverageTotals(coverage), [coverage]);
  const sampleItemWithEvidence = useMemo(
    () => activeItems.find((item) => item.moduleCoverage?.some(moduleHasEvidence)) ?? activeItems[0] ?? null,
    [activeItems],
  );

  return (
    <section
      data-testid="batch-evidence-history-panel"
      aria-label="依据与历史"
      className="space-y-3"
    >
      <div className="rounded-xl border border-slate-200/90 bg-white p-3.5">
        <h3 className="text-sm font-bold text-slate-900">依据与历史</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          默认按需查看。证据以 EvidenceStore 附件为准；执行回执与模块记录不等于已取得数据。
        </p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <dt className="text-[13px] text-slate-500">批次</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-800">{batchName || batchId}</dd>
            <dd className="text-[13px] text-slate-500">
              {new Date(createdAt).toLocaleString("zh-CN")} · {marketplace || "US"} ·
              {" "}{sourceType === "amazon_search_capture" ? "Amazon 搜索采集" : sourceType || "来源未记录"}
            </dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <dt className="text-[13px] text-slate-500">商品与样本</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-800">
              {itemCount} 条记录 · 有效 {validSampleCount} · 接受 {acceptedCount}
            </dd>
            <dd className="text-[13px] text-slate-500">
              研究准入：{validSetSufficient ? "样本足够" : "样本不足"} ·
              {marketScanId ? " 已关联市场研究" : " 尚未建立市场研究"}
            </dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <dt className="text-[13px] text-slate-500">执行状态</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-800">
              <span>批次状态 {batchStatus ? BATCH_STATUS_DISPLAY[batchStatus] ?? `未知（${batchStatus}）` : "未知"} · 自动采集任务</span>
              {(() => {
                const presence = describeCaptureRunPresence(captureRunSnapshot);
                return (
                  <Badge
                    tone={presence.tone === "ok" ? "emerald" : presence.tone === "warn" ? "amber" : presence.tone === "fail" ? "rose" : "slate"}
                    size="sm"
                    data-testid="batch-evidence-capture-run-presence"
                  >
                    {presence.label}
                  </Badge>
                );
              })()}
            </dd>
            <dd className="text-[13px] text-slate-500">
              {detailJobView?.job
                ? `历史详情任务 ${detailJobView.job.status || "未知"} · 已处理 ${detailJobView.progress?.processed ?? 0}/${detailJobView.progress?.total ?? 0}`
                : "暂无详情任务回执"}
            </dd>
            {captureRunSnapshot?.state === "present" ? (
              <dd className="text-[13px] text-slate-500" data-testid="batch-evidence-run-scope">
                本轮运行口径：商品处理 {captureRunSnapshot.view.progress.uniqueItemsVisited}/{captureRunSnapshot.view.progress.itemsInBatch} ·
                资料证据 {captureRunSnapshot.view.progress.validEvidenceCells}/{captureRunSnapshot.view.progress.totalCells} 单元
                （与下方按商品口径不同）
              </dd>
            ) : null}
          </div>
        </dl>
      </div>

      <details
        className="rounded-xl border border-slate-200/90 bg-white"
        data-testid="module-coverage-details"
        open
      >
        <summary className="cursor-pointer px-3.5 py-3 text-sm font-bold text-slate-800">
          八模块证据覆盖（按商品，含历史复用；执行 ≠ 取得数据）
          <span className="ml-2 text-[13px] font-normal text-slate-500">
            有证据模块 {totals.evidenceModules}/{totals.moduleCount} ·
            有证据 {totals.evidenceCells}/{totals.totalCells} 商品×模块单元
          </span>
        </summary>
        <div className="border-t border-slate-100 px-3.5 py-3">
          <p className="mb-2 text-[12px] leading-relaxed text-slate-500" data-testid="batch-evidence-coverage-scope-note">
            此口径按当前批次商品记录统计（每件商品 × 8 模块），含历史复用；
            {captureRunSnapshot?.state === "present"
              ? `运行面板的「资料证据 ${captureRunSnapshot.view.progress.validEvidenceCells}/${captureRunSnapshot.view.progress.totalCells} 单元」是本轮 BatchCaptureRun 单元口径，两者不能直接比较。`
              : "运行面板的「资料证据 x/y 单元」是本轮 BatchCaptureRun 单元口径，两者不能直接比较。"}
          </p>
          {coverage.length === 0 ? (
            <p className="text-xs text-slate-500">尚未读取到模块覆盖信息。</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {coverage.map((entry) => (
                <li
                  key={entry.module}
                  data-testid={`evidence-module-${entry.module}`}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold text-slate-800">{HISTORY_MODULE_LABELS[entry.module] ?? entry.label}</p>
                    {onViewModuleEvidence && sampleItemWithEvidence && Boolean(
                      sampleItemWithEvidence.moduleCoverage?.find((coverageEntry) => coverageEntry.module === entry.module)?.evidenceId,
                    ) ? (
                      <button
                        type="button"
                        className="text-[12px] font-medium text-emerald-700 hover:underline"
                        onClick={() => onViewModuleEvidence(entry.module, sampleItemWithEvidence)}
                      >
                        查看样例证据
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    有证据 {entry.evidenceCount}/{entry.itemCount} ·
                    仅回执 {entry.receiptOnlyCount} ·
                    未采集 {entry.notCollectedCount}
                    {entry.humanActionCount > 0 ? ` · 需人工 ${entry.humanActionCount}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
            补充能力（SellerSprite 深度、反查 ASIN、关键词、历史趋势）不在四项基础能力内；
            需在采集计划中单独授权，不会因隐藏入口而静默扩大或缩小正式范围。
          </p>
        </div>
      </details>

      <details
        className="rounded-xl border border-slate-200/90 bg-white"
        data-testid="batch-source-history-details"
      >
        <summary className="cursor-pointer px-3.5 py-3 text-sm font-bold text-slate-800">
          来源明细与历史执行记录
        </summary>
        <div className="border-t border-slate-100 px-3.5 py-3 space-y-3 text-xs text-slate-600">
          <div>
            <p className="font-semibold text-slate-800">批次身份</p>
            <p className="mt-1 font-mono text-[13px] text-slate-500 break-all">{batchId}</p>
            <p className="mt-1">
              进入 02 市场研究时沿用同一 batchId 与有效样本集合；历史授权与旧运行不会被本轮展示改写。
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-800">模块最新尝试（有记录的商品）</p>
            <ul className="mt-1 space-y-1">
              {activeItems.slice(0, 8).map((item) => {
                const attempts = (item.moduleCoverage ?? [])
                  .filter((entry) => entry.latestAttempt)
                  .map((entry) => `${HISTORY_MODULE_LABELS[entry.module] ?? entry.label ?? entry.module}：${statusLabel(entry.status)}`);
                if (attempts.length === 0) return null;
                return (
                  <li key={item.id}>
                    <span className="font-mono text-slate-500">{item.asin || item.id}</span>
                    {" · "}
                    {attempts.join("；")}
                  </li>
                );
              })}
              {activeItems.length > 8 ? <li>…等共 {activeItems.length} 件商品</li> : null}
              {attemptsEmpty(activeItems) ? <li>尚无模块尝试记录。</li> : null}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

function attemptsEmpty(items: readonly ItemLike[]): boolean {
  return items.every((item) => !(item.moduleCoverage ?? []).some((entry) => entry.latestAttempt));
}
