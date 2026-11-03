"use client";

import Link from "next/link";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowRight,
  Compass,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { BulkActionBar } from "@/components/ui/BulkActionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { pruneSelection, resolveSelectedItems } from "@/lib/client/stableRowSelection";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import styles from "./MarketAnalysisList.module.css";

export type MarketScanSummary = {
  id: string;
  scanName: string;
  marketplace: string;
  sampleCount: number;
  /** Prisma String（实际值如 market-metrics.v1）；指标算法版本，非资源版本。 */
  metricsVersion: string;
  sampleHash: string;
  medianPrice?: number | null;
  cr5?: number | null;
  archivedAt: string | null;
  createdAt: string;
  resourceVersion?: string;
  updatedAt?: string;
  /** 以下字段来自正式列表接口，用于呈现真实研究主体与门禁状态；缺失时不补造。 */
  nicheDefinition?: { label?: string | null } | null;
  marketGate?: { status?: string | null; chosenAt?: string | null } | null;
  representatives?: { items?: unknown[] | null } | null;
  sampleSufficiency?: { status?: string | null; validSampleCount?: number | null; minimumValidSampleCount?: number | null } | null;
  sourceBatchCoverage?: { sourceBatchId?: string | null } | null;
  sampleDefinition?: { origin?: string | null; productBatchId?: string | null } | null;
};

const GATE_LABELS: Record<string, string> = {
  PROCEED: "允许继续研究",
  VALIDATE_MORE: "补充验证",
  PAUSE: "暂缓",
  DROP: "放弃",
  PENDING: "待人工判断",
};

const GATE_TONES: Record<string, "ok" | "warn" | "muted"> = {
  PROCEED: "ok",
  VALIDATE_MORE: "warn",
  PAUSE: "warn",
  DROP: "muted",
  PENDING: "muted",
};

/** 时间只做展示：来源观察时间、建立时间与最近更新时间是三种不同语义，分开标注。 */
const formatTime = (value?: string | null) => {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const priceText = (value?: number | null, marketplace?: string) => {
  if (value === null || value === undefined) return null;
  const currency = marketplace === "US" ? "$" : marketplace === "UK" ? "£" : marketplace === "DE" ? "€" : "";
  return `${currency}${value.toFixed(2)}`;
};

const batchOf = (scan: MarketScanSummary) => scan.sourceBatchCoverage?.sourceBatchId ?? scan.sampleDefinition?.productBatchId ?? null;
const representativeCount = (scan: MarketScanSummary) => scan.representatives?.items?.length ?? 0;

export function MarketAnalysisListClient() {
  const router = useRouter();
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [cardLimit, setCardLimit] = useState(12);
  const [scans, setScans] = useState<MarketScanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Filters
  const [viewFilter, setViewFilter] = useState<"active" | "archived" | "all">("active");
  const [searchQuery, setSearchQuery] = useState("");

  // Selection & bulk（选中 key = 稳定 scanId；确认与提交都用打开确认框时快照的对象）
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<"archive" | "restore" | "delete">("archive");
  const [bulkTargets, setBulkTargets] = useState<MarketScanSummary[]>([]);
  const [actionBusy, setActionBusy] = useState(false);

  const getScanRowId = useCallback((scan: MarketScanSummary) => scan.id, []);

  // 统一策略：刷新后的数据集中已不存在的选中 ID 在此清除（搜索隐藏的保留）。
  useEffect(() => {
    setRowSelection((prev) => pruneSelection(prev, scans, (scan) => scan.id));
  }, [scans]);

  // Single delete state with dependency protection
  const [singleDeleteOpen, setSingleDeleteOpen] = useState(false);
  const [targetScanToDelete, setTargetScanToDelete] = useState<MarketScanSummary | null>(null);
  const [deleteBlockedWarning, setDeleteBlockedWarning] = useState<string | null>(null);

  // 单条归档 / 恢复确认（P1）：点击只打开确认框，确认后才发 POST。
  // 与批量一致复用 ConfirmDialog，不新增确认组件；CAS / 幂等键 / 服务端门禁均保持不变。
  const [singleArchiveOpen, setSingleArchiveOpen] = useState(false);
  const [targetScanToArchive, setTargetScanToArchive] = useState<MarketScanSummary | null>(null);

  const fetchScans = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Fetch /api/market-analysis
      const res = await fetch(`/api/market-analysis?include=${viewFilter}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });

      if (!res.ok) {
        // 正式 V5 契约：canonical 接口失败时如实报错，不再回退旧的 market-scan 兼容接口。
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `读取市场研究列表失败 (${res.status})`);
      }

      const json = await res.json().catch(() => null);
      if (json?.ok && Array.isArray(json.data?.items)) {
        setScans(json.data.items);
      } else {
        setScans([]);
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "获取市场研究失败");
      setScans([]);
    } finally {
      setLoading(false);
    }
  }, [viewFilter]);

  useEffect(() => {
    fetchScans();
  }, [fetchScans]);

  const filteredScans = useMemo(() => {
    return scans.filter((s) => {
      if (viewFilter === "active" && s.archivedAt) return false;
      if (viewFilter === "archived" && !s.archivedAt) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return s.scanName.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [scans, viewFilter, searchQuery]);

  // D0-001：按稳定 ID 在完整数据集上解析选中对象；搜索/排序/翻页不会改变对象身份。
  const selectedScans = useMemo(
    () => resolveSelectedItems(rowSelection, scans, (scan) => scan.id),
    [rowSelection, scans],
  );

  // Bulk actions on MarketScans（只提交打开确认框时确认的对象）
  async function executeBulkAction() {
    if (bulkTargets.length === 0) {
      setBulkConfirmOpen(false);
      return;
    }
    setActionBusy(true);
    try {
      const payload = {
        resource: "market_scan" as const,
        action: bulkAction,
        items: bulkTargets.map((s) => ({
          id: s.id,
          expectedVersion: s.resourceVersion || s.updatedAt || s.metricsVersion || 1, // 指标算法版本不是资源版本，不应作为 CAS expectedVersion；此处保留既有兜底行为
        })),
        idempotencyKey: `market_bulk_${bulkAction}_${Date.now()}`,
      };

      const res = await fetch("/api/market-analysis/bulk-actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok && res.status !== 207) {
        throw new Error(json?.error?.message || "批量操作失败");
      }

      // 正式 envelope 为 { ok, data: { succeeded, failed, results } }；逐项真实统计。
      const bulk = json?.data ?? json ?? {};
      const succeeded = bulk.succeeded ?? 0;
      const failed = bulk.failed ?? 0;
      if (failed > 0) {
        setActionNotice(
          `批量操作部分完成：成功 ${succeeded} 项，失败 ${failed} 项。失败项已被下游引用，只允许归档。`
        );
      }

      setRowSelection({});
      setBulkConfirmOpen(false);
      fetchScans();
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : "批量操作未完成");
    } finally {
      setActionBusy(false);
    }
  }

  // 单条归档 / 恢复（useCallback：配合下方 columns useMemo，避免打开弹窗时行按钮整批重挂载——
  // 重挂载会销毁弹层触发按钮节点，导致关闭后焦点无法归还（D0-005 连带根因）。
  const handleSingleArchive = useCallback(async (scan: MarketScanSummary) => {
    setActionBusy(true);
    try {
      const action = scan.archivedAt ? "restore" : "archive";
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `scan_${action}_${scan.id}_${Date.now()}`,
        },
        body: JSON.stringify({
          expectedVersion: scan.resourceVersion || scan.updatedAt || scan.metricsVersion || 1, // 指标算法版本不是资源版本，不应作为 CAS expectedVersion；此处保留既有兜底行为
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || "操作失败");
      }
      fetchScans();
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : "操作未完成");
    } finally {
      setActionBusy(false);
    }
  }, [fetchScans]);

  // 单条删除（带依赖保护）：仅使用 setter，identity 稳定。
  const handleSingleDelete = useCallback((scan: MarketScanSummary) => {
    setTargetScanToDelete(scan);
    setDeleteBlockedWarning(null);
    setSingleDeleteOpen(true);
  }, []);

  /** 单条归档 / 恢复入口：只记录操作对象并打开确认框，不产生任何写请求。 */
  const requestSingleArchive = useCallback((scan: MarketScanSummary) => {
    setTargetScanToArchive(scan);
    setSingleArchiveOpen(true);
  }, []);

  const confirmArchiveScan = useCallback(async () => {
    const scan = targetScanToArchive;
    if (!scan) {
      setSingleArchiveOpen(false);
      return;
    }
    setSingleArchiveOpen(false);
    setTargetScanToArchive(null);
    await handleSingleArchive(scan);
  }, [targetScanToArchive, handleSingleArchive]);

  async function confirmDeleteScan() {
    if (!targetScanToDelete) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(targetScanToDelete.id)}/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `scan_del_${targetScanToDelete.id}_${Date.now()}`,
        },
        body: JSON.stringify({
          expectedVersion: targetScanToDelete.resourceVersion || targetScanToDelete.updatedAt || targetScanToDelete.metricsVersion || 1, // 指标算法版本不是资源版本，不应作为 CAS expectedVersion；此处保留既有兜底行为
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        if (json?.error?.code === "DELETE_DEPENDENCY_BLOCKED" || json?.error?.code === "SCAN_REFERENCED_BY_RESEARCH") {
          setDeleteBlockedWarning(
            `该市场研究已被下游商品研究引用，无法彻底物理删除。${json.error.message || "建议改为移入归档。"}`
          );
          return;
        }
        throw new Error(json?.error?.message || "删除操作未完成");
      }
      setSingleDeleteOpen(false);
      setTargetScanToDelete(null);
      fetchScans();
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : "删除请求失败");
    } finally {
      setActionBusy(false);
    }
  }

  // 列定义 memo：打开确认弹窗触发的父级重渲染不再重建行按钮 DOM（保持触发节点存活，焦点可归还）。
  const columns = useMemo<ColumnDef<MarketScanSummary>[]>(() => [
    {
      id: "select",
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          onChange={(e) => table.toggleAllPageRowsSelected(!!e.target.checked)}
          aria-label="全选本页"
          className="size-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={(e) => row.toggleSelected(!!e.target.checked)}
          aria-label="选择此项"
          className="size-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
        />
      ),
      enableSorting: false,
    },
    {
      accessorKey: "scanName",
      header: "市场研究名称",
      cell: ({ row }) => {
        const scan = row.original;
        const niche = scan.nicheDefinition?.label;
        return (
          <div className="py-1">
            <Link
              href={`/market-analysis/${scan.id}`}
              className="font-bold text-sm text-slate-900 hover:text-emerald-700 hover:underline block"
            >
              {scan.scanName}
            </Link>
            <div className="flex flex-wrap items-center gap-2 mt-0.5 text-xs text-slate-500">
              {niche && niche !== scan.scanName ? <span className="text-emerald-800">{niche}</span> : null}
              <span className="font-mono text-[13px] text-slate-400">{scan.id.slice(0, 8)}…</span>
              <span>·</span>
              <span>站点 {scan.marketplace}</span>
              {scan.archivedAt && (
                <Badge tone="slate" className="text-[12px]">已归档</Badge>
              )}
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "sampleCount",
      header: "锁定样本",
      cell: ({ row }) => (
        <div className="text-xs">
          <span className="font-bold text-slate-900 text-sm">{row.original.sampleCount}</span>
          <span className="text-slate-500 ml-1">款</span>
        </div>
      ),
    },
    {
      id: "marketGate",
      header: "市场判断",
      enableSorting: false,
      cell: ({ row }) => {
        const gate = row.original.marketGate?.status ?? null;
        if (!gate) return <span className="text-xs text-slate-400">未记录</span>;
        return (
          <div className="flex flex-col text-xs">
            <span className={gate === "PROCEED" ? "font-semibold text-emerald-700 whitespace-nowrap" : "text-slate-600 whitespace-nowrap"}>{GATE_LABELS[gate] ?? gate}</span>
            <span className="text-[12px] text-slate-400">{row.original.marketGate?.chosenAt ? formatTime(row.original.marketGate.chosenAt) : "尚未保存判断"}</span>
          </div>
        );
      },
    },
    {
      id: "representatives",
      header: "已保存代表",
      enableSorting: false,
      cell: ({ row }) => {
        const count = representativeCount(row.original);
        return <span className="text-xs text-slate-700">{count > 0 ? `${count} 款` : <span className="text-slate-400">0 款</span>}</span>;
      },
    },
    {
      accessorKey: "medianPrice",
      header: "价格中位数",
      cell: ({ row }) => {
        const p = row.original.medianPrice;
        if (p === null || p === undefined) {
          return <span className="text-xs text-slate-400">暂无数据</span>;
        }
        return <span className="text-xs font-semibold text-slate-900 font-mono">${p.toFixed(2)}</span>;
      },
    },
    {
      accessorKey: "cr5",
      header: "品牌集中度 CR5",
      cell: ({ row }) => {
        const cr5 = row.original.cr5;
        if (cr5 === null || cr5 === undefined) {
          return <span className="text-xs text-slate-400">暂无数据</span>;
        }
        const pct = (cr5 * 100).toFixed(1);
        const tone = cr5 > 0.7 ? "rose" : cr5 > 0.5 ? "amber" : "emerald";
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-900 font-mono">{pct}%</span>
            <Badge tone={tone}>
              {cr5 > 0.7 ? "高度垄断" : cr5 > 0.5 ? "中度集中" : "适度竞争"}
            </Badge>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const scan = row.original;
        const isArchived = !!scan.archivedAt;
        return (
          <div className="flex items-center gap-1 whitespace-nowrap">
            <Link href={`/market-analysis/${scan.id}`}>
              <Button size="sm" variant="primary" className="h-7 text-xs px-2.5">
                查看
              </Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2"
              onClick={() => requestSingleArchive(scan)}
              disabled={actionBusy}
              title={scan.archivedAt ? "恢复前需要确认；确认后才会写库" : "归档前需要确认；确认后才会写库"}
            >
              {isArchived ? "恢复" : "归档"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-7 px-0 text-rose-600 hover:text-rose-700 hover:border-rose-300"
              onClick={() => handleSingleDelete(scan)}
              disabled={actionBusy}
              title={actionBusy ? "上一个操作正在处理，完成后才能删除" : "删除此市场研究（被下游研究引用时会被拦截，需改为归档）"}
              aria-label={"删除市场 " + scan.scanName}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      },
    },
  ], [requestSingleArchive, handleSingleDelete, actionBusy]);

  const summary = useMemo(() => {
    const totalSamples = scans.reduce((sum, scan) => sum + (Number.isFinite(scan.sampleCount) ? scan.sampleCount : 0), 0);
    const proceed = scans.filter((scan) => scan.marketGate?.status === "PROCEED").length;
    const reps = scans.reduce((sum, scan) => sum + representativeCount(scan), 0);
    return { totalSamples, proceed, reps };
  }, [scans]);

  const viewLabel = viewFilter === "active" ? "日常可见" : viewFilter === "archived" ? "已归档" : "全部";

  return (
    <WorkspaceFrame
      modeLabel="MarketScan · 只消费已采集事实"
      footerNote="02 市场研究 · MarketBatch 与 MarketScan 身份分离"
      header={
        <>
          {actionNotice && (
            <div className={styles.notice} role="status">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>{actionNotice}</span>
            </div>
          )}
          <section className={styles.hero} aria-label="市场研究概览">
            <div className={styles.heroMain}>
              <span className={styles.kicker}>02 · 市场研究<em className={styles.kickerEn}>Market Research</em></span>
              <h1>哪些市场值得现在打开？</h1>
              <p className={styles.heroLead}>
                每个研究都是一批锁定样本上的市场判断。先看已通过判断、已有代表商品的那几个，其余继续补证或重新确认。
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryAction} href="/source">
                  <Plus size={16} aria-hidden="true" />
                  去 01 市场采集建立研究
                </Link>
                <button type="button" className={styles.secondaryAction} onClick={fetchScans} disabled={loading}>
                  <RefreshCw size={15} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
                  刷新已保存研究
                </button>
              </div>
            </div>
            <dl className={styles.summary} aria-label="当前视角的真实研究摘要">
              <div className={styles.summaryCell} data-tone="brand">
                <dt>当前视角研究</dt>
                <dd><b>{loading ? "—" : scans.length}<small>个</small></b></dd>
                <dd><em>{viewLabel}视角；筛选只改变列表，不改研究本身</em></dd>
              </div>
              <div className={styles.summaryCell}>
                <dt>锁定样本合计</dt>
                <dd><b>{loading ? "—" : summary.totalSamples}<small>款</small></b></dd>
                <dd><em>按记录内已锁定样本累加，非去重后市场规模</em></dd>
              </div>
              <div className={styles.summaryCell}>
                <dt>已通过市场判断</dt>
                <dd><b>{loading ? "—" : summary.proceed}<small>个</small></b></dd>
                <dd><em>人工确认 PROCEED 的记录；其余待判断或已失效</em></dd>
              </div>
              <div className={styles.summaryCell}>
                <dt>已保存代表商品</dt>
                <dd><b>{loading ? "—" : summary.reps}<small>款</small></b></dd>
                <dd><em>只有已保存代表能进入 03；草稿不计入</em></dd>
              </div>
            </dl>
          </section>
        </>
      }
    >
          <div className={styles.toolbar}>
            <div className={styles.toolbarLeft}>
              <div className={styles.segmented} role="group" aria-label="研究视角">
                {([["active", "日常可见"], ["archived", "已归档"], ["all", "全部"]] as const).map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={viewFilter === id} onClick={() => setViewFilter(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <label className={styles.search}>
                <Search size={15} aria-hidden="true" />
                <input
                  type="text"
                  placeholder="搜索研究名称、关键词或 ID"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="搜索市场研究"
                />
              </label>
            </div>
            <div className={styles.toolbarRight}>
              <span className={styles.count}>
                共 <b>{loading || (errorMsg && scans.length === 0) ? "—" : filteredScans.length}</b> 个研究
                {searchQuery.trim() ? `（已按「${searchQuery.trim()}」筛选）` : ""}
              </span>
              <div className={styles.viewToggle} role="group" aria-label="市场显示方式">
                <button type="button" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>
                  <LayoutGrid size={14} aria-hidden="true" />卡片
                </button>
                <button type="button" aria-pressed={layout === "table"} onClick={() => setLayout("table")}>
                  <List size={14} aria-hidden="true" />表格
                </button>
              </div>
            </div>
          </div>

          <div>
            {loading ? (
              <div className={styles.skeletonGrid} aria-busy="true" aria-label="正在读取市场研究">
                {[0, 1, 2].map((index) => <div key={index} className={styles.skeletonCard} />)}
              </div>
            ) : errorMsg && scans.length === 0 ? (
              <div className={styles.errorCard} role="alert">
                <h3>读取市场研究失败</h3>
                <p>{errorMsg}</p>
                <button type="button" className={styles.secondaryAction} onClick={fetchScans}>重试读取</button>
              </div>
            ) : filteredScans.length === 0 ? (
              searchQuery.trim() ? (
                <div className={styles.stateCard}>
                  <span className={styles.stateIcon}><Search size={20} aria-hidden="true" /></span>
                  <h3>没有匹配当前搜索的研究</h3>
                  <p>当前视角共 {scans.length} 个研究，没有名称、关键词或 ID 包含「{searchQuery.trim()}」的记录。数据未丢失，可清除搜索或换关键词。</p>
                  <button type="button" className={styles.secondaryAction} onClick={() => setSearchQuery("")}>清除搜索条件</button>
                </div>
              ) : viewFilter === "archived" ? (
                <div className={styles.stateCard}>
                  <span className={styles.stateIcon}><Archive size={20} aria-hidden="true" /></span>
                  <h3>已归档中没有研究</h3>
                  <p>日常列表中的研究被归档后会出现在这里；归档不影响已有下游研究与飞书记录。</p>
                  <button type="button" className={styles.secondaryAction} onClick={() => setViewFilter("active")}>回到日常可见</button>
                </div>
              ) : scans.length === 0 ? (
                <div className={styles.stateCard}>
                  <span className={styles.stateIcon}><Compass size={20} aria-hidden="true" /></span>
                  <h3>还没有市场研究</h3>
                  <p>市场研究只消费 01 已采集并锁定的商品事实。先去市场采集建立一批样本，再回到这里形成判断；这里不会凭空生成市场事实。</p>
                  <Link className={styles.primaryAction} href="/source">前往 01 市场采集</Link>
                </div>
              ) : (
                <div className={styles.stateCard}>
                  <span className={styles.stateIcon}><Compass size={20} aria-hidden="true" /></span>
                  <h3>当前视角没有研究</h3>
                  <p>可切换到「全部」查看，或前往 01 市场采集建立新的研究。</p>
                  <button type="button" className={styles.secondaryAction} onClick={() => setViewFilter("all")}>切换到全部</button>
                </div>
              )
            ) : layout === "cards" ? (
              <>
                <div className={styles.cardGrid}>
                  {filteredScans.slice(0, cardLimit).map((scan) => {
                    const gate = scan.marketGate?.status ?? null;
                    const niche = scan.nicheDefinition?.label;
                    const price = priceText(scan.medianPrice, scan.marketplace);
                    const reps = representativeCount(scan);
                    const batch = batchOf(scan);
                    return (
                      <article className={styles.card} key={scan.id} data-gate={gate ?? "NONE"} data-testid="market-scan-card">
                        <div className={styles.cardTop}>
                          <div className={styles.chips}>
                            {niche && niche !== scan.scanName ? <span className={styles.chip} data-kind="niche" title={niche}>{niche}</span> : null}
                            <span className={styles.chip}>{scan.marketplace} 站</span>
                            {scan.archivedAt ? <span className={styles.chip} data-kind="archived">已归档</span> : null}
                          </div>
                          <label className={styles.selectBox}>
                            <input
                              type="checkbox"
                              aria-label={"选择市场 " + scan.scanName}
                              checked={Boolean(rowSelection[scan.id])}
                              onChange={(event) => setRowSelection((prev) => ({ ...prev, [scan.id]: event.target.checked }))}
                            />
                            选择
                          </label>
                        </div>

                        <h3 className={styles.cardTitle}><Link href={"/market-analysis/" + scan.id}>{scan.scanName}</Link></h3>

                        <div className={styles.statusRow}>
                          <span className={styles.status} data-tone={gate ? GATE_TONES[gate] ?? "muted" : "muted"}>
                            {gate ? GATE_LABELS[gate] ?? gate : "未记录市场判断"}
                          </span>
                          <span className={styles.status} data-tone={reps > 0 ? "ok" : "muted"}>
                            {reps > 0 ? `已保存代表 ${reps} 款` : "尚无已保存代表"}
                          </span>
                        </div>

                        <dl className={styles.metrics}>
                          <div>
                            <dt>价格中位数</dt>
                            <dd data-unknown={price ? undefined : true}>{price ?? "未知"}</dd>
                          </div>
                          <div>
                            <dt>锁定样本</dt>
                            <dd>{scan.sampleCount}<small>款</small></dd>
                          </div>
                          <div>
                            <dt>来源批次</dt>
                            <dd data-unknown={batch ? undefined : true} title={batch ?? undefined}>{batch ? batch.slice(0, 8) : "未记录"}</dd>
                          </div>
                        </dl>

                        <div className={styles.cardFoot}>
                          <div className={styles.times}>
                            <span>最近更新 <b>{formatTime(scan.updatedAt ?? scan.resourceVersion)}</b></span>
                            <span>建立于 <b>{formatTime(scan.createdAt)}</b></span>
                          </div>
                          <div className={styles.cardActions}>
                            <Link className={styles.enter} href={"/market-analysis/" + scan.id}>
                              进入市场研究 <ArrowRight size={14} aria-hidden="true" />
                            </Link>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => requestSingleArchive(scan)}
                              disabled={actionBusy}
                              aria-label={`${scan.archivedAt ? "恢复" : "归档"}市场 ${scan.scanName}`}
                              title={scan.archivedAt ? "恢复前需要确认；确认后才会写库" : "归档前需要确认；确认后才会写库"}
                            >
                              <Archive size={13} aria-hidden="true" />{scan.archivedAt ? "恢复" : "归档"}
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              data-danger
                              onClick={() => handleSingleDelete(scan)}
                              disabled={actionBusy}
                              aria-label={"删除市场 " + scan.scanName}
                              title={actionBusy ? "上一个操作正在处理，完成后才能删除" : "删除此市场研究（被下游研究引用时会被拦截，需改为归档）"}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {filteredScans.length > cardLimit && (
                  <div className={styles.moreCards}>
                    <button type="button" className={styles.secondaryAction} onClick={() => setCardLimit((value) => value + 12)}>
                      再看 12 个研究（还有 {filteredScans.length - cardLimit} 个）
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.tableCard}>
                <DataTable
                  columns={columns}
                  data={filteredScans}
                  enableRowSelection={true}
                  rowSelection={rowSelection}
                  setRowSelection={setRowSelection}
                  getRowId={getScanRowId}
                  pageSize={10}
                />
              </div>
            )}
          </div>

          <details className={styles.origin}>
            <summary>研究从哪来：来源观察 → 待验证假设 → 代表商品验证</summary>
            <div className={styles.originBody}>
              <div className={styles.originStep}>
                <b>来源观察</b>
                <span>商品文案、规格与评论各有来源；这里只读已采集并锁定的样本，不生成事实。</span>
                <Link href="/source">去 01 市场采集 →</Link>
              </div>
              <div className={styles.originStep}>
                <b>待验证假设</b>
                <span>先看样本范围、价格与竞争分布，再写下值得验证的问题；缺失字段保持未知。</span>
              </div>
              <div className={styles.originStep}>
                <b>代表商品验证</b>
                <span>通过市场判断并保存代表商品后，才进入 03 深研核实差异与未知条件。</span>
                <Link href="/research">查看 03 商品深研 →</Link>
              </div>
            </div>
          </details>

          {/* 底部悬浮批量栏 */}
          <BulkActionBar
            selectedCount={selectedScans.length}
            onClearSelection={() => setRowSelection({})}
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBulkAction("archive");
                    setBulkTargets(selectedScans);
                    setBulkConfirmOpen(true);
                  }}
                  className="bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                >
                  <Archive className="size-3.5 mr-1" />
                  批量移入归档
                </Button>

                {viewFilter === "archived" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setBulkAction("restore");
                      setBulkTargets(selectedScans);
                      setBulkConfirmOpen(true);
                    }}
                    className="bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                  >
                    <RefreshCw className="size-3.5 mr-1" />
                    批量恢复
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBulkAction("delete");
                    setBulkTargets(selectedScans);
                    setBulkConfirmOpen(true);
                  }}
                  className="bg-slate-800 border-slate-700 text-rose-300 hover:bg-rose-950/60"
                >
                  <Trash2 className="size-3.5 mr-1" />
                  批量删除
                </Button>
              </>
            }
          />

          {/* 批量确认弹窗（列出实际操作对象：名称 + 稳定 ID） */}
          <ConfirmDialog
            isOpen={bulkConfirmOpen}
            onClose={() => setBulkConfirmOpen(false)}
            onConfirm={executeBulkAction}
            title={bulkAction === "archive" ? "批量归档市场研究画像" : bulkAction === "restore" ? "批量恢复市场研究画像" : "批量删除市场研究画像"}
            description={
              bulkAction === "archive"
                ? "归档后画像将从日常列表中隐藏，不影响下游已建立的研究任务与飞书同步记录。"
                : bulkAction === "restore"
                ? "确认将选中的已归档市场研究画像恢复到日常可见列表？"
                : "仅无任何候选品或研究任务引用的空扫描才可物理删除。已被引用的画像将被安全拦截保护。"
            }
            confirmText={bulkAction === "archive" ? "确认归档" : bulkAction === "restore" ? "确认恢复" : "确认删除"}
            isDestructive={bulkAction === "delete"}
            isLoading={actionBusy}
            metrics={{ totalCount: bulkTargets.length }}
            selectedItems={bulkTargets.map((scan) => ({
              id: scan.id,
              label: `${scan.scanName}（${scan.marketplace} · ${scan.id.slice(0, 8)}）`,
            }))}
          />

          {/* 单条归档 / 恢复确认弹窗（P1：取消不产生任何写请求） */}
          <ConfirmDialog
            isOpen={singleArchiveOpen}
            onClose={() => {
              setSingleArchiveOpen(false);
              setTargetScanToArchive(null);
            }}
            onConfirm={confirmArchiveScan}
            title={
              targetScanToArchive?.archivedAt
                ? "确认恢复这个市场研究？"
                : "确认归档这个市场研究？"
            }
            description={
              targetScanToArchive?.archivedAt
                ? `将「${targetScanToArchive?.scanName ?? "所选研究"}」恢复到日常可见列表。恢复只改变它在本页的可见性，不改变样本、市场判断与下游研究。`
                : `将「${targetScanToArchive?.scanName ?? "所选研究"}」移入归档，日常列表不再显示。已有下游研究与研报记录保持完整，可随时恢复。`
            }
            confirmText={targetScanToArchive?.archivedAt ? "确认恢复" : "确认归档"}
            isDestructive={false}
            isLoading={actionBusy}
          />

          {/* 单条删除确认弹窗（带依赖拦截与归档后退兜底） */}
          <ConfirmDialog
            isOpen={singleDeleteOpen}
            onClose={() => {
              setSingleDeleteOpen(false);
              setTargetScanToDelete(null);
              setDeleteBlockedWarning(null);
            }}
            onConfirm={
              deleteBlockedWarning && targetScanToDelete
                ? async () => {
                    const scan = targetScanToDelete;
                    setSingleDeleteOpen(false);
                    setTargetScanToDelete(null);
                    setDeleteBlockedWarning(null);
                    await handleSingleArchive(scan);
                  }
                : confirmDeleteScan
            }
            title={deleteBlockedWarning ? "无法彻底删除（依赖保护）" : "确认删除市场研究画像"}
            description={
              deleteBlockedWarning
                ? "该市场研究已被下游商品研究引用。为了保证已有研究与研报记录完整，系统不允许物理删除。可以改为归档，归档后不会继续出现在日常列表中。"
                : `确定要删除市场研究 [${targetScanToDelete?.scanName || targetScanToDelete?.id}] 吗？删除后该画像将从工作区永久移除。`
            }
            confirmText={deleteBlockedWarning ? "改为移入归档" : "确认彻底删除"}
            isDestructive={!deleteBlockedWarning}
            isLoading={actionBusy}
          />
    </WorkspaceFrame>
  );
}
