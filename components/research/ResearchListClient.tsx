"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  Compass,
  LayoutGrid,
  List,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";

import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { BulkActionBar } from "@/components/ui/BulkActionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { ProductIdentity } from "@/components/ui/ProductIdentity";
import { AnchoredMenu } from "./AnchoredMenu";
import { ResearchListCard } from "./ResearchListCard";
import styles from "./research-list.module.css";
import { formatTeamRecommendationPullFeedback } from "@/lib/client/feishuTeamRecommendation";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { pruneSelection, resolveSelectedItems } from "@/lib/client/stableRowSelection";
import {
  toCanonicalDecisionStatus,
  getDecisionStatusDisplay,
} from "@/lib/types/v5DecisionStatus";
import {
  BUSINESS_STAGES,
  BUSINESS_STAGE_TABS,
  type V5BusinessStage,
  type V5BusinessStageTab,
} from "@/lib/types/v5BusinessStage";
import {
  researchCardCtaOf,
  researchCardSystemSuggestionLabel,
  researchFindingOf,
  type ResearchListRow,
} from "./researchListRow";

export type ResearchViewTab = V5BusinessStageTab;

/** 行类型与状态投影已抽到 researchListRow，列表页、卡片与测试共用同一份口径。 */
export type { ResearchListRow } from "./researchListRow";
export { researchCardChoiceLabel } from "./researchListRow";

export const VIEW_TABS = BUSINESS_STAGE_TABS;

export function ResearchListClient() {
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [cardLimit, setCardLimit] = useState(12);
  const [staleOnly, setStaleOnly] = useState(false);
  const [currentTab, setCurrentTab] = useState<V5BusinessStageTab>("all");
  /**
   * 列表请求时序守卫：URL 同步会先触发默认 tab 请求再触发目标 tab 请求，
   * 响应乱序到达时旧响应会覆盖新响应（表现为 ?view=archived 空态但 API 有数据）。
   * 每次请求递增序号，只有「最新一次请求」的响应才允许落地。
   */
  const listRequestSeq = useRef(0);
  const [items, setItems] = useState<ResearchListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Synchronize initial tab from URL query (?view=...)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      const view = searchParams.get("view");
      if (view) {
        if (view === "needs_choice") setCurrentTab("needs_decision");
        else if (view === "watch") setCurrentTab("pause");
        else if (view === "in_progress") setCurrentTab("ready");
        else if (BUSINESS_STAGE_TABS.some((t) => t.key === view)) {
          setCurrentTab(view as V5BusinessStageTab);
        }
      }
    }
  }, []);

  const handleTabChange = useCallback((tabKey: V5BusinessStageTab) => {
    // 切换阶段 = 清除附加筛选：否则「需复核」会悄悄留在新阶段上，
    // 用户看到的列表比页签承诺的更少（P2 计数/筛选混乱的直接成因之一）。
    setStaleOnly(false);
    setCardLimit(12);
    if (tabKey !== currentTab) {
      setCurrentTab(tabKey);
      // 立刻清空旧阶段行：新请求在途或失败时都不会把上一阶段的条目当作本阶段结果。
      setItems([]);
      setLoading(true);
    }
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", tabKey);
      window.history.replaceState({}, "", url.toString());
    }
  }, [currentTab]);

  // Counts for tabs
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});

  // TanStack table selection
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [pullingFeishu, setPullingFeishu] = useState(false);
  const [pullFeedback, setPullFeedback] = useState<{
    type: "success" | "warning" | "error";
    message: string;
    details?: {
      scannedRecords?: number;
      applied?: number;
      unchanged?: number;
      skipped?: number;
      failedOrSkipped?: number;
      mirrorStatus?: string;
    };
  } | null>(null);

  // Bulk confirm dialog（items = 打开确认框时的快照：名称 + 稳定 ID）
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    isDestructive: boolean;
    action: () => Promise<void>;
    items?: Array<{ id: string; label: string }>;
  }>({
    open: false,
    title: "",
    description: "",
    isDestructive: false,
    action: async () => {},
  });

  // Single delete state with dependency protection
  const [singleDeleteOpen, setSingleDeleteOpen] = useState(false);
  const [targetTaskToDelete, setTargetTaskToDelete] = useState<ResearchListRow | null>(null);
  const [deleteBlockedWarning, setDeleteBlockedWarning] = useState<string | null>(null);

  // 单条归档 / 恢复确认（P1）：卡片与表格入口共用，确认前不产生任何写请求。
  const [singleArchiveOpen, setSingleArchiveOpen] = useState(false);
  const [targetRowToArchive, setTargetRowToArchive] = useState<ResearchListRow | null>(null);
  // 飞书可用性：拉取菜单在不可用时要说明真实原因，而不是只给一个灰按钮。
  const [feishuHub, setFeishuHub] = useState<{ configured: boolean; status: string } | null>(null);

  const fetchResearchList = useCallback(async () => {
    const seq = ++listRequestSeq.current;
    setLoading(true);
    setErrorMsg(null);
    try {
      // 1. Try canonical /api/research?view={currentTab}
      const res = await fetch(`/api/research?view=${currentTab}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      if (seq !== listRequestSeq.current) return; // 过期响应：已有更新请求在途，弃用旧结果

      if (res.ok) {
        const json = await res.json();
        const rows: ResearchListRow[] = json.items || json.data?.items || [];
        setItems(rows);
        if (json.data?.counts) {
          setTabCounts(json.data.counts);
        }
        return;
      }

      // 正式 V5 契约：canonical 接口失败时如实报错，不再回退旧的 tasks 兼容接口。
      const errJson = await res.json().catch(() => null);
      throw new Error(errJson?.error?.message || `读取商品研究列表失败 (${res.status})`);
    } catch (err) {
      if (seq !== listRequestSeq.current) return;
      setErrorMsg(err instanceof Error ? err.message : "获取商品研究失败");
    } finally {
      if (seq === listRequestSeq.current) setLoading(false);
    }
  }, [currentTab]);

  const handleFeishuPull = useCallback(async () => {
    setPullingFeishu(true);
    setPullFeedback(null);
    try {
      const res = await fetch("/api/feishu-hub/decisions/pull", {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error?.message || `接收飞书端建议失败 (${res.status})`);
      }
      const data = json?.data || json;
      setPullFeedback(formatTeamRecommendationPullFeedback(data));
      await fetchResearchList();
    } catch (err) {
      setPullFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "检查飞书端建议更新失败",
      });
    } finally {
      setPullingFeishu(false);
    }
  }, [fetchResearchList]);

  useEffect(() => {
    fetchResearchList();
    setRowSelection({});
  }, [fetchResearchList]);

  // 飞书可用性只读探测：只用于解释「为什么这个菜单现在拉不了」，不参与任何门禁。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/feishu-hub/status", { headers: buildAccessHeaders(), cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok) return;
        setFeishuHub({
          configured: Boolean(json.data?.configured),
          status: typeof json.data?.status === "string" ? json.data.status : "unknown",
        });
      })
      .catch(() => { /* 读不到状态不阻断列表；菜单会说明当前不可用原因 */ });
    return () => { cancelled = true; };
  }, []);

  // Filtered rows
  const searchedRows = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.trim().toLowerCase();
    return items.filter(
      (r) =>
        r.asin.toLowerCase().includes(q) ||
        (r.title && r.title.toLowerCase().includes(q))
    );
  }, [items, searchQuery]);

  /**
   * 「需复核」是数据新鲜度，不是业务阶段，因此单独做成开关而不是第四个阶段页签：
   * 计数取当前搜索范围内、开关生效前的行数，标签与筛选结果保持一致。
   */
  const staleRowCount = useMemo(() => searchedRows.filter((row) => row.stale).length, [searchedRows]);
  const filteredRows = useMemo(
    () => (staleOnly ? searchedRows.filter((row) => row.stale) : searchedRows),
    [searchedRows, staleOnly]
  );

  // Selected items list（D0-001：稳定业务 ID + 完整数据集解析；搜索隐藏的保留、刷新消失的清除）
  const getResearchRowId = useCallback(
    (row: ResearchListRow) => row.taskId || row.candidateId,
    [],
  );

  useEffect(() => {
    setRowSelection((prev) => pruneSelection(prev, items, getResearchRowId));
  }, [items, getResearchRowId]);

  const selectedRows = useMemo(
    () => resolveSelectedItems(rowSelection, items, getResearchRowId),
    [rowSelection, items, getResearchRowId],
  );

  // Bulk actions (Archive / Restore / Safe Delete)
  const handleBulkAction = useCallback(
    (action: "archive" | "restore" | "delete") => {
      if (selectedRows.length === 0) return;
      const targets = selectedRows;
      const targetItems = targets.map((r) => {
        const id = r.taskId || r.candidateId;
        return { id, label: `${r.title || r.asin}（${r.marketplace} · ${id.slice(0, 8)}）` };
      });
      const actionName = action === "archive" ? "批量归档" : action === "restore" ? "批量恢复" : "批量删除";

      setConfirmDialog({
        open: true,
        title: `确认${actionName}选中的 ${targets.length} 项商品研究？`,
        description:
          action === "delete"
            ? "注意：只有无正式研报且无用户决策的草稿才可物理删除。已产出研报或已做决断的任务受系统保护，禁止物理删除，请改为归档。"
            : `归档后条目将移入【已归档】列表，历史版本与研报结论保持完整。`,
        isDestructive: action === "delete",
        items: targetItems,
        action: async () => {
          setActionBusy(true);
          try {
            const payload = {
              resource: "research_task" as const,
              action,
              items: targets.map((r) => ({
                id: r.taskId || r.candidateId,
                expectedVersion: r.resourceVersion || r.updatedAt || r.researchRevision || 1,
              })),
              idempotencyKey: crypto.randomUUID(),
            };

            const res = await fetch("/api/research/bulk-actions", {
              method: "POST",
              headers: {
                ...buildAccessHeaders(),
                "Content-Type": "application/json",
                "Idempotency-Key": payload.idempotencyKey,
              },
              body: JSON.stringify(payload),
            });

            const json = await res.json().catch(() => null);
            if (!res.ok) {
              throw new Error(json?.error?.message || `${actionName}失败`);
            }

            // 正式 envelope 为 { ok, data: { succeeded, failed, results } }；逐项真实统计。
            const bulk = json?.data ?? json ?? {};
            const succeeded = bulk.succeeded ?? 0;
            const failed = bulk.failed ?? 0;
            const failedCodes: string[] = Array.isArray(bulk.results)
              ? bulk.results
                  .filter((r: { outcome?: string }) => r?.outcome === "failed")
                  .map((r: { code?: string | null }) => r?.code || "UNKNOWN")
              : [];

            if (failed > 0) {
              setActionNotice({
                type: "error",
                message: `${actionName}部分完成：成功 ${succeeded} 项，失败 ${failed} 项${
                  failedCodes.length ? `（原因：${[...new Set(failedCodes)].join("、")}）` : ""
                }。失败项受系统保护，请改为归档。`,
              });
            } else {
              setActionNotice({
                type: "success",
                message: `成功${actionName} ${succeeded} 个商品研究任务。`,
              });
            }

            setRowSelection({});
            fetchResearchList();
          } catch (err) {
            setActionNotice({
              type: "error",
              message: err instanceof Error ? err.message : `${actionName}失败`,
            });
          } finally {
            setActionBusy(false);
            setConfirmDialog((prev) => ({ ...prev, open: false }));
          }
        },
      });
    },
    [selectedRows, fetchResearchList]
  );

  // Single item action
  const handleSingleArchive = useCallback(
    async (row: ResearchListRow) => {
      const isArchived = Boolean(row.archivedAt);
      const action = isArchived ? "restore" : "archive";
      const targetId = row.taskId || row.candidateId;
      setActionBusy(true);
      try {
        const res = await fetch(`/api/research/${encodeURIComponent(targetId)}/${action}`, {
          method: "POST",
          headers: {
            ...buildAccessHeaders(),
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedVersion: row.resourceVersion || row.updatedAt || row.researchRevision || 1,
            idempotencyKey: crypto.randomUUID(),
          }),
        });

        if (!res.ok) {
          const json = await res.json().catch(() => null);
          throw new Error(json?.error?.message || "操作失败");
        }

        fetchResearchList();
      } catch (err) {
        setActionNotice({
          type: "error",
          message: err instanceof Error ? err.message : "操作失败",
        });
      } finally {
        setActionBusy(false);
      }
    },
    [fetchResearchList]
  );

  // Single delete with dependency protection
  const handleSingleDelete = useCallback((item: ResearchListRow) => {
    setTargetTaskToDelete(item);
    setDeleteBlockedWarning(null);
    setSingleDeleteOpen(true);
  }, []);

  /** 单条归档 / 恢复入口：只打开确认框，不写库。 */
  const requestSingleArchive = useCallback((row: ResearchListRow) => {
    setTargetRowToArchive(row);
    setSingleArchiveOpen(true);
  }, []);

  const confirmArchiveRow = useCallback(async () => {
    const row = targetRowToArchive;
    if (!row) {
      setSingleArchiveOpen(false);
      return;
    }
    setSingleArchiveOpen(false);
    setTargetRowToArchive(null);
    await handleSingleArchive(row);
  }, [targetRowToArchive, handleSingleArchive]);

  const confirmDeleteTask = useCallback(async () => {
    if (!targetTaskToDelete) return;
    const targetId = targetTaskToDelete.taskId || targetTaskToDelete.candidateId;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(targetId)}/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `task_del_${targetId}_${Date.now()}`,
        },
        body: JSON.stringify({
          expectedVersion: targetTaskToDelete.resourceVersion || targetTaskToDelete.updatedAt || 1,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        if (json?.error?.code === "DELETE_DEPENDENCY_BLOCKED" || json?.error?.code === "TASK_REFERENCED_PROTECTED") {
          setDeleteBlockedWarning(
            `该研究任务已被下游流程或历史引用，无法彻底物理删除。${json.error.message || "建议改为移入归档。"}`
          );
          return;
        }
        throw new Error(json?.error?.message || "删除操作未完成");
      }
      setSingleDeleteOpen(false);
      setTargetTaskToDelete(null);
      fetchResearchList();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除请求失败");
    } finally {
      setActionBusy(false);
    }
  }, [targetTaskToDelete, fetchResearchList]);

  // Table Columns
  const columns = useMemo<ColumnDef<ResearchListRow>[]>(
    () => [
      {
        id: "product",
        header: "商品识别",
        accessorFn: (row) => `${row.title || ""} ${row.asin}`,
        cell: ({ row }) => (
          <div style={{ minWidth: 300, maxWidth: 380 }}><ProductIdentity
            image={row.original.image ?? row.original.displayOnlyIdentity?.imageUrl}
            title={row.original.title}
            asin={row.original.asin}
            marketplace={row.original.marketplace}
            brand={row.original.brand ?? row.original.displayOnlyIdentity?.brand}
            category={row.original.category ?? row.original.displayOnlyIdentity?.category}
            stale={row.original.stale}
            size="md"
            preferProductTitle
          />
          <p className="mt-1 text-[12px] text-slate-400">
            {row.original.researchRevision !== null ? `rev.${row.original.researchRevision}` : "未开始研究"}
            {" · "}
            {new Date(row.original.updatedAt).toLocaleDateString("zh-CN")} 更新
          </p>
          {(row.original.displayOnlyIdentity?.brand || row.original.displayOnlyIdentity?.category || row.original.displayOnlyIdentity?.imageUrl) && <p className="text-[12px] text-amber-800">候选资料 · 非证据值</p>}</div>
        ),
      },
      {
        id: "finding",
        header: "关键发现",
        accessorFn: (row) => row.finding?.text ?? row.findingPreview ?? "",
        cell: ({ row }) => {
          const finding = researchFindingOf(row.original);
          const toneClass =
            finding.status === "CURRENT"
              ? "text-emerald-800 bg-emerald-50 border-emerald-200"
              : finding.status === "HISTORICAL"
                ? "text-amber-800 bg-amber-50 border-amber-200"
                : "text-slate-500 bg-slate-50 border-slate-200";
          return (
            <div style={{ maxWidth: 380 }}>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[12.5px] font-semibold ${toneClass}`}>
                {finding.label}
              </span>
              {finding.text ? (
                <p className="mt-1 line-clamp-2 text-[13.5px] leading-relaxed text-slate-700">{finding.text}</p>
              ) : null}
              {finding.basis ? (
                <span className="mt-1 block text-[12.5px] text-slate-400">{finding.basis}</span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "stageAndDecision",
        header: "研究状态与人工决定",
        accessorFn: (row) => row.businessStage ?? toCanonicalDecisionStatus({ myChoice: row.myChoice }),
        cell: ({ row }) => {
          const stage = row.original.businessStage;
          const stageMeta = stage ? BUSINESS_STAGES[stage] : null;
          const notStarted = row.original.researchState === "not_started";
          const choice = row.original.myChoice;
          const canonical = toCanonicalDecisionStatus({ myChoice: choice });
          const display = canonical ? getDecisionStatusDisplay(canonical) : null;
          const isFinal = choice?.scope === "FINAL";

          const stageTone =
            stage === "needs_decision"
              ? "amber"
              : stage === "proceed"
              ? "emerald"
              : stage === "validate_more"
              ? "blue"
              : stage === "pause"
              ? "amber"
              : stage === "drop"
              ? "rose"
              : "slate";

          return (
            <div className="flex flex-col items-start gap-1" style={{ minWidth: 190 }}>
              <div className="flex items-center gap-1.5 flex-wrap">
                {notStarted ? (
                  // E-1B：任务壳还没有研报 → 如实显示「未开始研究」，不冒充已准备/进行中
                  <Badge tone="slate" data-testid="research-stage-not-started">
                    未开始研究
                  </Badge>
                ) : stageMeta ? (
                  <Badge tone={stageTone}>
                    {stageMeta.label}
                  </Badge>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                    <Clock className="size-3 text-amber-600" />
                    待决策
                  </span>
                )}
                {row.original.reportConsumptionBlocked ? (
                  <Badge tone="rose">报告暂停采信</Badge>
                ) : row.original.reportAuditVerdict === "NEEDS_DOWNGRADE" ? (
                  <Badge tone="amber">报告需复核</Badge>
                ) : null}
                {display && stage !== "needs_decision" && (
                  <span className="text-[13px] text-slate-500 font-medium">
                    ({display.label}{isFinal ? "·正式" : "·临时"})
                  </span>
                )}
              </div>
              {choice?.chosenAt && (
                <span className="text-[12px] text-slate-400">
                  {new Date(choice.chosenAt).toLocaleDateString("zh-CN")} 决断
                </span>
              )}
              <span className="text-[12.5px] text-slate-500">
                系统建议：{researchCardSystemSuggestionLabel(row.original.systemSuggestion)}
              </span>
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "操作",
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original;
          const isArchived = Boolean(item.archivedAt);
          const cta = researchCardCtaOf(item);

          return (
            <div className="flex items-center gap-1.5" style={{ whiteSpace: "nowrap" }}>
              {item.taskId ? (
                <Link href={cta.href}>
                  <Button
                    size="sm"
                    variant="primary"
                    className="h-7 text-xs px-2.5"
                  >
                    {cta.label} <ArrowRight className="size-3 ml-0.5" />
                  </Button>
                </Link>
              ) : (
                <Link href="/source">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2 text-slate-500"
                  >
                    待生成任务
                  </Button>
                </Link>
              )}
              <AnchoredMenu
                ariaLabel={"更多操作 " + item.asin}
                title="更多操作"
                triggerClassName={styles.moreTrigger}
                triggerContent={<MoreHorizontal className="size-4" aria-hidden="true" />}
                panelClassName={styles.menuPanel}
                testId="research-row-menu"
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => {
                        close();
                        requestSingleArchive(item);
                      }}
                    >
                      <Archive className="size-3.5" aria-hidden="true" />
                      {isArchived ? "恢复到研究清单" : "归档（不影响研报）"}
                    </button>
                    <button
                      type="button"
                      data-danger
                      disabled={actionBusy}
                      onClick={() => {
                        close();
                        handleSingleDelete(item);
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      删除研究任务
                    </button>
                  </>
                )}
              </AnchoredMenu>
            </div>
          );
        },
      },
    ],
    [actionBusy, requestSingleArchive, handleSingleDelete]
  );

  const needsDecisionCount =
    tabCounts["needs_decision"] ??
    tabCounts["needs_choice"] ??
    items.filter((i) => i.viewState === "needs_choice").length;
  /**
   * 总研究数只认服务端全局计数（与当前阶段筛选无关）。
   * 取不到全局数时退回当前阶段条数，并在文案里标注口径，不拿局部数冒充全局。
   */
  const globalTotalCount = typeof tabCounts["all"] === "number" ? tabCounts["all"] : null;
  const totalResearchCount = globalTotalCount ?? items.length;
  const totalScopeLabel = globalTotalCount === null ? "当前阶段" : "全部研究";
  // 已拿到全局计数后，切阶段不应把总数显示成「—」：列表在加载，总数并没有变化。
  const countLabel = (value: number) => (loading && globalTotalCount === null ? "—" : String(value));
  const currentTabLabel = VIEW_TABS.find((tab) => tab.key === currentTab)?.label ?? "全部";
  const shownCardCount = Math.min(cardLimit, filteredRows.length);
  /**
   * 飞书菜单的禁用原因必须可见：打开菜单却只看到一个灰按钮，用户无法判断是
   * 「正在拉取」「列表还没加载完」还是「本机没配飞书」。原因只解释、不参与门禁。
   */
  const feishuDisabledReason = pullingFeishu
    ? "正在拉取飞书建议，本次完成后才能再次拉取。"
    : loading
      ? "研究清单正在加载，加载完成后才能拉取飞书建议。"
      : feishuHub && !feishuHub.configured
        ? "本机未配置飞书应用凭据，无法拉取团队建议；这不影响本页的研究与人工决定。"
        : feishuHub && feishuHub.status !== "ready"
          ? `飞书连接当前为 ${feishuHub.status}，连接可用后才能拉取。`
          : null;
  // 常用阶段常驻，其余阶段收进「更多阶段」，避免工具条堆满按钮；筛选能力不变。
  const primaryTabs = VIEW_TABS.filter((tab) => ["all", "ready", "needs_decision"].includes(tab.key));
  const secondaryTabs = VIEW_TABS.filter((tab) => !["all", "ready", "needs_decision"].includes(tab.key));
  const currentTabIsSecondary = secondaryTabs.some((tab) => tab.key === currentTab);
  const tabCountOf = (key: V5BusinessStageTab): number | undefined =>
    key === "needs_decision" ? needsDecisionCount : tabCounts[key];
  const listStateMode = loading
    ? "loading"
    : errorMsg && items.length === 0
      ? "error"
      : filteredRows.length === 0
        ? "empty"
        : null;

  return (
    <WorkspaceFrame
      modeLabel="VOC 规则版本 + 人工决策门禁"
      footerNote="03 商品深研 · 只消费正式证据，AI 提议 ≠ 人工确认"
      header={
        <header className={styles.hero}>
          <div className={styles.heroMain}>
            <p className={styles.kicker}>03 · 商品深研<em className={styles.kickerEn}>Product Deep Research</em></p>
            <h1 className={styles.heroTitle}>商品深研</h1>
            <p className={styles.heroLead}>
              共 <b>{countLabel(totalResearchCount)}</b> 个商品研究任务
              {globalTotalCount === null ? <span className={styles.heroScope}>（当前阶段口径）</span> : null}
              。先处理待决策与需复核，其余继续推进。
            </p>
          </div>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/market-analysis">
              <Compass size={16} aria-hidden="true" />
              选择代表商品
            </Link>
            <button type="button" className={styles.secondaryAction} onClick={fetchResearchList} disabled={loading}>
              <RefreshCw size={15} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
              刷新
            </button>
            <AnchoredMenu
              ariaLabel="飞书建议"
              title="从飞书情报中心拉取团队建议"
              triggerClassName={styles.toolsTrigger}
              triggerContent={<>飞书建议<ChevronDown size={14} aria-hidden="true" /></>}
              panelClassName={`${styles.menuPanel} ${styles.toolsPanel}`}
              testId="research-feishu-menu"
            >
              {(close) => (
                <>
                  <p className={styles.menuHint}>把飞书情报中心里团队给出的建议拉回本机，只作参考，不改变你的决定。</p>
                  {feishuDisabledReason ? (
                    <p className={styles.menuHint} data-tone="warn" data-testid="research-feishu-disabled-reason">
                      {feishuDisabledReason}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    disabled={Boolean(feishuDisabledReason)}
                    onClick={() => {
                      close();
                      void handleFeishuPull();
                    }}
                  >
                    <RefreshCw size={14} className={pullingFeishu ? "animate-spin" : undefined} aria-hidden="true" />
                    检查飞书最新决策
                  </button>
                </>
              )}
            </AnchoredMenu>
          </div>
        </header>
      }
    >

      <div className={styles.page}>
      {/* 工具条：阶段筛选（含更多阶段）+ 需复核新鲜度开关 + 搜索 + 视图 */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <div className={styles.segmented} role="group" aria-label="研究阶段筛选">
            {primaryTabs.map((tab) => {
              const isActive = currentTab === tab.key;
              const badgeCount = tabCountOf(tab.key);
              return (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => handleTabChange(tab.key)}
                >
                  <span>{tab.label}</span>
                  {badgeCount !== undefined && badgeCount > 0 ? <em>{badgeCount}</em> : null}
                </button>
              );
            })}
          </div>

          <AnchoredMenu
            ariaLabel="更多阶段"
            title="其它研究阶段"
            triggerClassName={styles.stageTrigger}
            triggerContent={
              <>
                更多阶段
                {currentTabIsSecondary ? <em>· 已选「{VIEW_TABS.find((tab) => tab.key === currentTab)?.label}」</em> : null}
                <ChevronDown size={14} aria-hidden="true" />
              </>
            }
            panelClassName={`${styles.menuPanel} ${styles.stagePanel}`}
            align="start"
            testId="research-stage-menu"
          >
            {(close) =>
              secondaryTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={currentTab === tab.key}
                  onClick={() => {
                    close();
                    handleTabChange(tab.key);
                  }}
                >
                  <span>{tab.label}</span>
                  {tabCounts[tab.key] !== undefined ? <em>{tabCounts[tab.key]}</em> : null}
                </button>
              ))
            }
          </AnchoredMenu>

          {staleOnly || staleRowCount > 0 ? (
            <button
              type="button"
              className={styles.staleChip}
              aria-pressed={staleOnly}
              title={
                `「需复核」指来源数据已变化、研报结论需要重新确认的研究；计数仅限当前阶段「${currentTabLabel}」与当前搜索范围，` +
                `不是全站复核总数。${staleOnly ? "再次点击可取消该附加筛选。" : "点击只显示这些研究。"}`
              }
              onClick={() => {
                setStaleOnly((value) => !value);
                setCardLimit(12);
              }}
            >
              <AlertCircle size={14} aria-hidden="true" />
              {staleOnly ? "仅看需复核" : "需复核"}
              <em>{staleRowCount}</em>
            </button>
          ) : null}
        </div>

        <div className={styles.toolbarRight}>
          <span className={styles.resultCount} title={`${totalScopeLabel}共 ${totalResearchCount} 条；当前阶段「${currentTabLabel}」筛选后显示 ${filteredRows.length} 条`}>
            {loading ? (
              "正在加载本阶段…"
            ) : (
              <>
                显示 <b>{filteredRows.length}</b> 个 · 共 <b>{countLabel(totalResearchCount)}</b> 条
                {searchQuery.trim() ? `（搜索「${searchQuery.trim()}」）` : ""}
              </>
            )}
          </span>
          <label className={styles.search}>
            <Search size={15} aria-hidden="true" />
            <input
              type="text"
              aria-label="搜索商品深研列表"
              placeholder="搜索商品名称或 ASIN"
              value={searchQuery}
              onChange={(event) => { setSearchQuery(event.target.value); setCardLimit(12); }}
            />
          </label>
          <div className={styles.viewToggle} role="group" aria-label="研究显示方式">
            <button type="button" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>
              <LayoutGrid size={14} aria-hidden="true" />
              卡片
            </button>
            <button type="button" aria-pressed={layout === "table"} onClick={() => setLayout("table")}>
              <List size={14} aria-hidden="true" />
              表格
            </button>
          </div>
        </div>
      </div>

      {staleOnly ? (
        <div className={styles.filterBar} role="status">
          <AlertCircle size={14} aria-hidden="true" />
          <span>
            已启用附加筛选：<b>仅看需复核</b>（当前阶段「{currentTabLabel}」共 {staleRowCount} 条；这是本阶段口径，不是全站复核总数）
          </span>
          <button
            type="button"
            onClick={() => { setStaleOnly(false); setCardLimit(12); }}
          >
            取消筛选
          </button>
        </div>
      ) : null}

      {pullFeedback ? (
        <div
          className={styles.notice}
          data-tone={pullFeedback.type === "success" ? "success" : pullFeedback.type === "error" ? "error" : undefined}
          role="status"
        >
          {pullFeedback.type === "success" ? (
            <CheckCircle2 size={16} className="shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
          )}
          <span className="flex-1">
            {pullFeedback.message}
            {pullFeedback.details?.mirrorStatus ? `（镜像状态：${pullFeedback.details.mirrorStatus}）` : ""}
          </span>
          <button type="button" onClick={() => setPullFeedback(null)} aria-label="关闭提示">✕</button>
        </div>
      ) : null}

      {actionNotice ? (
        <div className={styles.notice} data-tone={actionNotice.type === "success" ? "success" : "error"} role="status">
          {actionNotice.type === "success" ? (
            <CheckCircle2 size={16} className="shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
          )}
          <span className="flex-1">{actionNotice.message}</span>
        </div>
      ) : null}

      {/* 主列表区域 */}
      <div data-state={listStateMode ?? undefined}>
        {loading ? (
          <div className={styles.skeletonGrid} aria-busy="true" aria-label="正在读取商品研究清单">
            {[0, 1, 2].map((index) => <div key={index} className={styles.skeletonCard} />)}
          </div>
        ) : errorMsg && items.length === 0 ? (
          <div className={styles.errorCard} role="alert">
            <h3>读取商品研究失败</h3>
            <p>{errorMsg}</p>
            <button type="button" className={styles.secondaryAction} onClick={fetchResearchList}>
              <RefreshCw size={14} aria-hidden="true" />
              重试读取
            </button>
          </div>
        ) : filteredRows.length === 0 ? (
          items.length === 0 ? (
            <div className={styles.stateCard}>
              <span className={styles.stateIcon}><Sparkles size={20} aria-hidden="true" /></span>
              <h3>还没有商品研究</h3>
              <p>这里只展示从市场研究挑出来的代表商品。先去 02 市场研究挑一个代表商品，深研任务才会出现在这里。</p>
              <Link className={styles.primaryAction} href="/market-analysis">前往市场研究挑选</Link>
            </div>
          ) : searchQuery.trim() ? (
            <div className={styles.stateCard}>
              <span className={styles.stateIcon}><Search size={20} aria-hidden="true" /></span>
              <h3>没有匹配当前搜索的商品</h3>
              <p>当前共 {items.length} 个研究，没有名称或 ASIN 包含「{searchQuery.trim()}」的商品。数据未丢失，可换个关键词或清除搜索。</p>
              <button type="button" className={styles.secondaryAction} onClick={() => setSearchQuery("")}>清除搜索条件</button>
            </div>
          ) : staleOnly ? (
            <div className={styles.stateCard}>
              <span className={styles.stateIcon}><AlertCircle size={20} aria-hidden="true" /></span>
              <h3>当前范围内没有需要复核的研究</h3>
              <p>「需复核」指来源数据已变化、研报结论需要重新确认的研究；当前分组与搜索范围内没有这类条目。</p>
              <button type="button" className={styles.secondaryAction} onClick={() => setStaleOnly(false)}>取消「需复核」筛选</button>
            </div>
          ) : (
            <div className={styles.stateCard}>
              <span className={styles.stateIcon}><Compass size={20} aria-hidden="true" /></span>
              <h3>{currentTab === "archived" ? "已归档中没有研究" : "这个阶段暂时没有商品"}</h3>
              <p>可切换上方阶段查看其它研究，或去市场研究挑选新的代表商品发起深研。</p>
              <button type="button" className={styles.secondaryAction} onClick={() => handleTabChange("all")}>查看全部研究</button>
            </div>
          )
        ) : layout === "cards" ? (
          <>
            <p className={styles.gridCount} data-testid="research-card-count">
              共 {filteredRows.length} 条，已显示 {shownCardCount} 条
              {staleOnly ? `（仅看需复核 · 当前阶段「${currentTabLabel}」）` : ""}
            </p>
            <div className={styles.grid}>
              {filteredRows.slice(0, cardLimit).map((item) => {
                const rowId = getResearchRowId(item);
                return (
                  <ResearchListCard
                    key={rowId}
                    row={item}
                    selected={Boolean(rowSelection[rowId])}
                    busy={actionBusy}
                    onSelect={(checked) => setRowSelection((prev) => ({ ...prev, [rowId]: checked }))}
                    onArchive={requestSingleArchive}
                    onDelete={handleSingleDelete}
                  />
                );
              })}
            </div>
            {filteredRows.length > cardLimit ? (
              <div className={styles.moreCards}>
                <button type="button" className={styles.secondaryAction} onClick={() => setCardLimit((value) => value + 12)}>
                  加载更多（剩余 {Math.max(0, filteredRows.length - cardLimit)} 项）
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className={styles.tableCard}>
            <DataTable
              columns={columns}
              data={filteredRows}
              enableRowSelection={true}
              rowSelection={rowSelection}
              setRowSelection={setRowSelection}
              getRowId={getResearchRowId}
              pageSize={10}
            />
          </div>
        )}
      </div>

      </div>

          {/* 底部悬浮批量操作栏 */}
          <BulkActionBar
            selectedCount={selectedRows.length}
            onClearSelection={() => setRowSelection({})}
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBulkAction("archive")}
                  disabled={actionBusy}
                  className="bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                >
                  <Archive className="size-3.5 mr-1" />
                  批量移入归档
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBulkAction("restore")}
                  disabled={actionBusy}
                  className="bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700"
                >
                  <RefreshCw className="size-3.5 mr-1" />
                  批量恢复
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBulkAction("delete")}
                  disabled={actionBusy}
                  className="bg-slate-800 border-slate-700 text-rose-300 hover:bg-rose-950/60"
                >
                  <Trash2 className="size-3.5 mr-1" />
                  批量删除草稿
                </Button>
              </>
            }
          />

          {/* 统一操作确认弹窗 */}
          <ConfirmDialog
            isOpen={confirmDialog.open}
            onClose={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
            onConfirm={confirmDialog.action}
            title={confirmDialog.title}
            description={confirmDialog.description}
            isDestructive={confirmDialog.isDestructive}
            confirmText={confirmDialog.isDestructive ? "确认彻底删除" : "确认执行"}
            isLoading={actionBusy}
            metrics={{ totalCount: confirmDialog.items?.length ?? selectedRows.length }}
            selectedItems={confirmDialog.items}
          />

          {/* 单条归档 / 恢复确认弹窗（P1：卡片与表格共用；取消不产生任何写请求） */}
          <ConfirmDialog
            isOpen={singleArchiveOpen}
            onClose={() => {
              setSingleArchiveOpen(false);
              setTargetRowToArchive(null);
            }}
            onConfirm={confirmArchiveRow}
            title={targetRowToArchive?.archivedAt ? "确认恢复这个商品研究？" : "确认归档这个商品研究？"}
            description={
              targetRowToArchive
                ? targetRowToArchive.archivedAt
                  ? `将「${targetRowToArchive.title || targetRowToArchive.asin}」（${targetRowToArchive.asin} · ${targetRowToArchive.marketplace} · ${(targetRowToArchive.taskId || targetRowToArchive.candidateId).slice(0, 8)}）恢复到研究清单。恢复只改变可见性，正式研报、人工决定与下游需求单引用都不变。`
                  : `将「${targetRowToArchive.title || targetRowToArchive.asin}」（${targetRowToArchive.asin} · ${targetRowToArchive.marketplace} · ${(targetRowToArchive.taskId || targetRowToArchive.candidateId).slice(0, 8)}）移入【已归档】。它不再出现在日常清单，正式研报、人工决定与下游引用保持完整，可随时恢复。`
                : ""
            }
            confirmText={targetRowToArchive?.archivedAt ? "确认恢复" : "确认归档"}
            isDestructive={false}
            isLoading={actionBusy}
          />

          {/* 单条删除确认弹窗（带依赖拦截与归档后退兜底） */}
          <ConfirmDialog
            isOpen={singleDeleteOpen}
            onClose={() => {
              setSingleDeleteOpen(false);
              setTargetTaskToDelete(null);
              setDeleteBlockedWarning(null);
            }}
            onConfirm={
              deleteBlockedWarning && targetTaskToDelete
                ? async () => {
                    const task = targetTaskToDelete;
                    setSingleDeleteOpen(false);
                    setTargetTaskToDelete(null);
                    setDeleteBlockedWarning(null);
                    await handleSingleArchive(task);
                  }
                : confirmDeleteTask
            }
            title={deleteBlockedWarning ? "无法彻底删除（依赖保护）" : "确认删除研究任务"}
            description={
              deleteBlockedWarning
                ? "该研究任务已被下游流程引用。为了保证已有记录与证据完整，系统不允许物理删除。可以改为归档，归档后不会继续出现在日常列表中。"
                : `确定要删除商品 [${targetTaskToDelete?.asin || "所选商品"}] 的研究任务吗？删除后该任务将从工作区永久移除。`
            }
            confirmText={deleteBlockedWarning ? "改为移入归档" : "确认彻底删除"}
            isDestructive={!deleteBlockedWarning}
            isLoading={actionBusy}
          />
    </WorkspaceFrame>
  );
}
