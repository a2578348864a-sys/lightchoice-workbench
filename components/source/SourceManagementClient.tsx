"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  ExternalLink,
  FileSpreadsheet,
  FolderArchive,
  Inbox,
  History,
  Layers,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import sourceStyles from "./cockpit/SourceCockpit.module.css";
import { SourceEntryBento, SourceHero } from "./cockpit/SourceHero";
import { SourceStats } from "./cockpit/SourceStats";
import { Dialog } from "@/components/ui/Dialog";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { AmazonCapturePanel, type AmazonCaptureMode } from "@/components/source-layer/AmazonCapturePanel";
import { SellerSpriteCategoryMarketCapturePanel } from "@/components/source-layer/SellerSpriteCategoryMarketCapturePanel";
import { LatestCategoryMarketCaptureResult } from "@/components/source-layer/LatestCategoryMarketCaptureResult";
import { LatestAmazonCaptureResult } from "@/components/source-layer/LatestAmazonCaptureResult";
import { uploadKeepaCsv, type KeepaImportResult } from "./keepaUpload";
import { PromoteEvidenceModal } from "@/components/source/PromoteEvidenceModal";
import { BatchWorkspaceHeader, type HeaderMenuAction } from "./batch-workspace/BatchWorkspaceHeader";
import { useBatchWorkspaceRecovery } from "./batch-workspace/useBatchWorkspaceRecovery";
import { validSamplePreview, resolveExcludedItem, type BrowseState } from "./batch-workspace/workspaceBrowseState";
import { ProductGallery, type GalleryStatusFilter } from "./batch-workspace/ProductGallery";
import { filterBatchProducts, sortBatchProducts, type ProductSort } from "./batch-workspace/productTablePresentation";
import { PROVENANCE_MODULE_LABELS } from "./source-provenance/sourceProvenanceModel";
import { ProductMaterialMatrix, MATRIX_ISSUES } from "./batch-workspace/ProductMaterialMatrix";
import { DEFAULT_MATRIX_FILTER, matchesMaterialFilter, MATRIX_GROUPS, type MatrixFilter, type MatrixLocation } from "./batch-workspace/materialMatrixPresentation";
import { ProductDetailPanel } from "./batch-workspace/ProductDetailPanel";
import { resolveReviewNavigation } from "./batch-workspace/presentation";
import bwStyles from "./batch-workspace/BatchWorkspace.module.css";
import {
  describeAmazonDetailBatchStatus,
  deriveCaptureStatusBadges,
  summarizeCaptureCompleteness,
  type CaptureStatusBadge,
} from "@/components/source/captureStatusPresentation";
import { summarizeAmazonDetailBatchStatus } from "@/components/source/amazonDetailBatchStatusPresentation";
import { BatchCaptureRunPanel } from "@/components/source/BatchCaptureRunPanel";
import { CapturePlanPanel } from "@/components/source/CapturePlanPanel";
import { FourBasicCapabilitiesStrip } from "@/components/source/BatchWorkspacePanels";
import { SourceProvenancePanel } from "@/components/source/source-provenance/SourceProvenancePanel";
import { ModuleEvidenceDetail } from "@/components/source/source-provenance/ModuleEvidenceDetail";
import { BatchCaptureRunSummary } from "@/components/source/capture-console/BatchCaptureRunSummary";
import { useCaptureRunSnapshotFetcher } from "@/components/source/capture-console/useCaptureRunSnapshotFetcher";
import {
  hasCaptureRunEvidence,
  type BatchCaptureRunSnapshot,
} from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import { CaptureTaskWorkspace } from "@/components/source/CaptureTaskWorkspace";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  reconcileSourceBatchItemCounts,
  sourceBatchQualityPresentation,
  type SourceBatchCountReconciliation,
  type SourceBatchQualityPresentation,
} from "@/lib/sourceBatchReconciliation";
import type { ValidMarketProductSet } from "@/lib/marketScan/marketSamplePolicy";
import { MIN_VALID_SAMPLE_COUNT } from "@/lib/marketScan/marketSampleConstants";
import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";
import {
  summarizeSourceModuleCoverage,
  summarizeModuleCoverageTotals,
  moduleWasExecuted,
  moduleHasEvidence,
} from "@/lib/sourceLayer/moduleCoverageSummary";

const SellerSpriteKeywordCapturePanel = dynamic(
  () => import("@/components/source-layer/SellerSpriteKeywordCapturePanel").then((module) => module.SellerSpriteKeywordCapturePanel),
  { ssr: false },
);

export type FieldStatus = "confirmed" | "estimated" | "missing" | "conflict" | "not_available";

export type SourceModuleId =
  | "amazon_detail"
  | "amazon_search_market"
  | "sellersprite_product_market"
  | "reverse_asin"
  | "keyword_mining_trend"
  | "variation"
  | "review_voc"
  | "historical_trend";

export type SourceModuleStatus = ProductModuleStatus;

export type SourceModuleCoverage = {
  module: SourceModuleId;
  label: string;
  status: SourceModuleStatus;
  capturedAt: string | null;
  evidenceId: string | null;
  contentHash: string | null;
  limitations: string[];
  evidenceOnly: boolean | null;
  errorCode: string | null;
  retryable: boolean | null;
  latestAttempt: {
    receiptId: string;
    traceId: string | null;
    status: string;
    message: string;
    errorCode: string | null;
    attemptedAt: string;
  } | null;
};

export type AmazonSearchSalesSignal = {
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: string | null;
  rawText: string | null;
  capturedAt: string;
  evidenceId: string;
};

export type SourceItemDTO = {
  id: string;
  batchId: string;
  asin: string;
  title: string | null;
  /** 展示层中文主标题（presentation-only，非 ProductFact）。 */
  chineseTitle?: string | null;
  chineseTitleStatus?: "AUTHORITATIVE_CHINESE_TITLE" | "DERIVED_FROM_CATEGORY" | "UNAVAILABLE";
  chineseCategory?: string | null;
  image: string | null;
  /** 图片来源诚实性：缺失时 UI 只能显示统一占位图。 */
  imageStatus?: "AUTHORITATIVE_IMAGE_AVAILABLE" | "AUTHORITATIVE_IMAGE_MISSING";
  brand?: string | null;
  category?: string | null;
  /** 详情补齐状态（来自条目 enrichment 块的只读透出）：enriched / captured_partial / null=未补齐。 */
  enrichmentStatus?: "enriched" | "captured_partial" | null;
  enrichmentCaptureOrigin?: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE" | null;
  /** 字段级来源（只读；服务端已校验完整条目；缺失不推断）。 */
  enrichmentFieldProvenance?: Array<{
    field: string;
    evidenceId: string;
    evidenceVersion: number;
    contentHash: string;
    capturedAt: string;
  }>;
  marketplace?: string | null;
  bsr?: { rank: number; category: string | null } | null;
  evidenceStatus?: string;
  price: { value: number | null; currency: string; status: FieldStatus } | null;
  rating: { value: number | null; status: FieldStatus } | null;
  reviewCount: { value: number | null; status: FieldStatus } | null;
  /** SellerSprite 估算月销量；来源未提供时为 null，UI 诚实显示「暂无数据」。 */
  estimatedMonthlySales?: number | null;
  /** Amazon 搜索页的近月购买信号，与 SellerSprite 月销估算分开保存与展示。 */
  amazonSalesSignal?: AmazonSearchSalesSignal | null;
  /** 来自该 ASIN 正式 EvidenceStore 的八模块最新证据状态。 */
  moduleCoverage?: SourceModuleCoverage[];
  /** 选品信号（复用旧版 productBatchPresentation 展示层，缺失为空数组）。 */
  positiveReasons?: string[];
  counterSignals?: string[];
  missingSignals?: string[];
  fieldCoverage?: Record<string, FieldStatus>;
  usageStatus: "research_ready" | "needs_review" | "blocked";
  referencedBy: {
    marketScanIds: string[];
    candidateIds: string[];
    taskIds: string[];
  };
  archivedAt: string | null;
  evidenceRefs: string[];
  capturedAt: string | null;
  updatedAt: string;
  resourceVersion?: string;
};

export type SourceBatchSummary = {
  id: string;
  batchName: string | null;
  marketplace?: string | null;
  currency?: string | null;
  batchStatus?: string | null;
  dataQualityStatus?: string | null;
  /** 批次来源渠道（服务端从快照契约推导）：卖家精灵导入 / Amazon 搜索采集等。 */
  sourceType?: string | null;
  itemCount: number;
  acceptedCount: number;
  quarantinedCount?: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt?: string;
  resourceVersion?: string;
  // Enriched metrics
  rawCount?: number;
  validSampleCount?: number;
  unverifiedCount?: number;
  excludedCount?: number;
  detailCount?: number;
  reconciliation?: SourceBatchCountReconciliation | null;
  qualityPresentation?: SourceBatchQualityPresentation | null;
  marketScan?: { id: string; scanName: string; sampleCount: number } | null;
  /** 服务端唯一权威的 VALID_PRODUCT_SET 投影；UI 只消费，不再自行计算。 */
  validProductSet?: (ValidMarketProductSet & { isSufficient: boolean }) | null;
};

/** D0-004：GET /api/market-analysis/sample-preview 响应（创建前权威样本口径，只读）。 */
export type MarketSamplePreviewData = {
  productBatchId: string;
  batchName: string;
  marketplace: string;
  sourceItemCount: number;
  preliminaryValidCount: number;
  finalFreezableCount: number;
  minimumRequired: number;
  sufficient: boolean;
  parentVariationNotice: string;
  stages: Array<{
    stage: "status" | "variant" | "evidence" | "deterministic";
    label: string;
    droppedCount: number;
    items: Array<{ id: string; asin: string | null; reason: string; label: string }>;
  }>;
};

type BatchDetailJobStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
type BatchDetailJobView = {
  scheduled: boolean;
  executionMode?: "scheduled" | "manual_only";
  acquisitionEnabled?: boolean;
  job: { jobId: string; status: BatchDetailJobStatus; lastErrorCode: string | null } | null;
  progress: {
    status: BatchDetailJobStatus;
    total: number;
    processed: number;
    enriched: number;
    partial: number;
    failedRetryable: number;
    failedPermanent: number;
    humanRequired: number;
    pending: number;
    running: number;
    reusedEvidence: number;
    newlyCaptured: number;
  };
};

/** 批次删除被依赖保护阻止时，把服务端 deleteBlockedBy 映射为真实原因。 */
const BATCH_DEPENDENCY_LABELS: Record<string, string> = {
  active_selection: "该批次仍是当前生效的商品发现选择批次",
  candidate_origin: "批次内商品已被候选池引用",
  market_sample: "批次内商品已被市场分析锁定为样本",
  task_reference: "批次内商品已进入商品研究任务",
  evidence_immutable: "批次内证据仍被不可变引用",
  report_or_choice: "已存在研报或人工决断记录",
};

/** 批次来源渠道的用户可读标签（与 productBatchContract 的 ProductBatchSourceType 对应）。 */
const BATCH_SOURCE_LABELS: Record<string, string> = {
  amazon_search_capture: "Amazon 搜索采集",
  sellersprite_xlsx: "卖家精灵 XLSX 导入",
  evidence_store_reference: "证据库引用导入",
  legacy_frozen_registration: "历史冻结数据",
};

const BATCH_DETAIL_JOB_STATUS_LABELS: Record<BatchDetailJobStatus, string> = {
  PENDING: "排队中",
  RUNNING: "进行中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
  FAILED: "有未完成商品",
  CANCELLED: "已取消",
};

// 八模块状态/限制原因文案已提取到 ./batch-workspace/modulePresentation（详情面板与工作区共用同一套说法）。

function describeBatchBlockedBy(blockedBy: unknown): string {
  const codes = Array.isArray(blockedBy) ? blockedBy.filter((code): code is string => typeof code === "string") : [];
  if (codes.length === 0) return "该批次仍被下游业务对象引用";
  return codes.map((code) => BATCH_DEPENDENCY_LABELS[code] ?? code).join("；");
}

function extractErrorDetails(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null;
  const error = (json as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const details = (error as Record<string, unknown>).details;
  return details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : null;
}

/**
 * 服务端把批次依赖保护的真实原因放在 `error.details.dependencySummary.deleteBlockedBy`。
 * 旧实现误读 `error.details.deleteBlockedBy`，导致真实原因永远取不到、只显示通用文案。
 * 这里两种形态都接受，保证「展示真实原因」这一既有产品保护真正生效。
 */
function extractDeleteBlockedBy(details: Record<string, unknown> | null): unknown {
  if (!details) return undefined;
  const summary = details.dependencySummary;
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const nested = (summary as Record<string, unknown>).deleteBlockedBy;
    if (nested !== undefined) return nested;
  }
  return details.deleteBlockedBy;
}

function targetResourceVersion(item: SourceItemDTO): string {
  return item.resourceVersion || item.updatedAt;
}

type SourceBulkFailure = { id: string; label: string; reason: string };

function sourceBulkFailureReason(code: unknown): string {
  if (code === "DELETE_DEPENDENCY_BLOCKED") return "已有下游业务引用，不能物理删除；可改为归档。";
  if (code === "CAS_CONFLICT") return "记录已被其他操作更新，请刷新后重试。";
  if (code === "NOT_ARCHIVED") return "记录当前未归档，无需恢复。";
  if (code === "SOURCE_ITEM_NOT_FOUND" || code === "SOURCE_BATCH_NOT_FOUND") return "记录已不存在，请刷新列表确认。";
  return "本项操作未完成，请刷新列表后重试。";
}

function sourceBulkFailures(results: unknown, labelsById: Map<string, string>): SourceBulkFailure[] {  if (!Array.isArray(results)) return [];
  return results.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || (entry as Record<string, unknown>).outcome !== "failed") return [];
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "unknown";
    return [{ id, label: labelsById.get(id) ?? id, reason: sourceBulkFailureReason(row.code) }];
  });
}

export function SourceManagementClient() {
  const router = useRouter();
  // 唯一门槛常量：与服务端 VALID_PRODUCT_SET / MarketScan 创建共用同一政策模块。
  const minimumRequired = MIN_VALID_SAMPLE_COUNT;

  // Batches state
  const [batches, setBatches] = useState<SourceBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Expanded batch items state (per-batch lazy cache)
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  // V6：不再使用三 Tab；采集控制台与依据历史改为抽屉，商品画廊常驻主区。
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [detailHistoryOpen, setDetailHistoryOpen] = useState(false);
  /** 单件商品详情展开（同一时间最多一件；详情在整行下方，不挤压列表列宽）。 */
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [batchItemsMap, setBatchItemsMap] = useState<Record<string, SourceItemDTO[]>>({});
  const [loadingBatchItems, setLoadingBatchItems] = useState<Record<string, boolean>>({});
  const [batchDetailJobMap, setBatchDetailJobMap] = useState<Record<string, BatchDetailJobView>>({});
  const [batchDetailJobErrorMap, setBatchDetailJobErrorMap] = useState<Record<string, string>>({});
  /**
   * 该批次 BatchCaptureRun 的唯一前端快照（unknown/loading/created/present/absent/error）。
   * 摘要、运行详情、历史状态都消费这一份结果；只有成功读取且 run=null 才能显示「无任务」。
   */
  const [captureRunSnapshots, setCaptureRunSnapshots] = useState<Record<string, BatchCaptureRunSnapshot>>({});
  const recordCaptureRunSnapshot = useCallback((batchId: string, snapshot: BatchCaptureRunSnapshot) => {
    setCaptureRunSnapshots((prev) => ({ ...prev, [batchId]: snapshot }));
  }, []);
  /**
   * D2-1E：采集计划确认后递增该令牌，驱动「采集进度」面板立即重新读取权威状态。
   * 解决「确认创建后必须手动刷新才能看到任务出现」的同步缺口。
   */
  const [captureRunRefreshTokens, setCaptureRunRefreshTokens] = useState<Record<string, number>>({});
  const [batchDetailJobBusy, setBatchDetailJobBusy] = useState<Record<string, boolean>>({});
  const [batchItemsErrorMap, setBatchItemsErrorMap] = useState<Record<string, string | null>>({});
  const [batchDetailConfirmTarget, setBatchDetailConfirmTarget] = useState<SourceBatchSummary | null>(null);
  const [batchDetailBusyId, setBatchDetailBusyId] = useState<string | null>(null);
  const [batchDetailNotice, setBatchDetailNotice] = useState<Record<string, { tone: "success" | "error" | "info"; message: string }>>({});
  const [variationEnrichBusy, setVariationEnrichBusy] = useState<Record<string, boolean>>({});
  const [variationEnrichNotice, setVariationEnrichNotice] = useState<Record<string, { tone: "success" | "error"; message: string }>>({});
  const [moduleBatchBusy, setModuleBatchBusy] = useState<Record<string, boolean>>({});
  const [moduleBatchNotice, setModuleBatchNotice] = useState<Record<string, { tone: "success" | "error" | "info"; message: string }>>({});
  const [reviewBatchBusy, setReviewBatchBusy] = useState<Record<string, boolean>>({});
  const [reviewBatchNotice, setReviewBatchNotice] = useState<Record<string, { tone: "success" | "error" | "info"; message: string }>>({});
  const [moduleRecollectBusy, setModuleRecollectBusy] = useState<Record<string, boolean>>({});
  const [moduleActionNotice, setModuleActionNotice] = useState<Record<string, { tone: "success" | "error" | "info"; message: string }>>({});
  const [moduleEvidenceViewer, setModuleEvidenceViewer] = useState<{
    batch: SourceBatchSummary;
    item: SourceItemDTO;
    module: SourceModuleId;
    coverage: SourceModuleCoverage | null;
    loading: boolean;
    error: string | null;
    data: unknown;
  } | null>(null);
  const [matrixOpenMap, setMatrixOpenMap] = useState<Record<string, boolean>>({});
  const [matrixFilterMap, setMatrixFilterMap] = useState<Record<string, MatrixFilter>>({});
  const [matrixLocation, setMatrixLocation] = useState<MatrixLocation | null>(null);
  const [reviewModuleFocus, setReviewModuleFocus] = useState<MatrixLocation | null>(null);
  const [matrixNotice, setMatrixNotice] = useState("");
  const [browseViewMap, setBrowseViewMap] = useState<Record<string, "gallery" | "table">>({});
  const [browsePageMap, setBrowsePageMap] = useState<Record<string, number>>({});
  const [restoreNotice, setRestoreNotice] = useState("");
  const [pendingBrowseRestore, setPendingBrowseRestore] = useState<BrowseState | null>(null);
  const [batchSortMap, setBatchSortMap] = useState<Record<string, ProductSort>>({});
  const [batchSearchMap, setBatchSearchMap] = useState<Record<string, string>>({});
  const [batchStatusFilterMap, setBatchStatusFilterMap] = useState<Record<string, "all" | "ready" | "review" | "blocked">>({});
  // Stable shared data reference: checking a row must not reset TanStack pagination.
  const baseVisibleBatchProducts = useMemo(() => {
    const id = expandedBatchId ?? "";
    return sortBatchProducts(filterBatchProducts(batchItemsMap[id] ?? [], batchSearchMap[id] ?? "", batchStatusFilterMap[id] ?? "all"), batchSortMap[id] ?? "original");
  }, [expandedBatchId, batchItemsMap, batchSearchMap, batchStatusFilterMap, batchSortMap]);
  const currentMatrixSnapshot = captureRunSnapshots[expandedBatchId ?? ""];
  const matrixAllowedKey = currentMatrixSnapshot?.state === "present" ? currentMatrixSnapshot.run.allowedModules.join("|") : null;
  const visibleBatchProducts = useMemo(() => {
    const filter = matrixFilterMap[expandedBatchId ?? ""] ?? DEFAULT_MATRIX_FILTER;
    if (filter.issue === "all") return baseVisibleBatchProducts;
    return baseVisibleBatchProducts.filter(item => matchesMaterialFilter(item, filter, matrixAllowedKey === null ? null : matrixAllowedKey.split("|")));
  }, [expandedBatchId, baseVisibleBatchProducts, matrixFilterMap, matrixAllowedKey]);



  // Top modals & drawers
  const [amazonCaptureOpen, setAmazonCaptureOpen] = useState(false);
  const [amazonCaptureMode, setAmazonCaptureMode] = useState<AmazonCaptureMode>("detail");
  const [categoryMarketCaptureOpen, setCategoryMarketCaptureOpen] = useState(false);
  const [sellerSpriteDepthCaptureOpen, setSellerSpriteDepthCaptureOpen] = useState(false);
  const [researchCapture, setResearchCapture] = useState<{ scanId: string; module: string; keyword: string; asin: string } | null>(null);
  const [keepaOpen, setKeepaOpen] = useState(false);

  const expandedBatchForRun = useMemo(
    () => batches.find((batch) => batch.id === expandedBatchId) ?? null,
    [batches, expandedBatchId],
  );
  const expandedRunSnapshot: BatchCaptureRunSnapshot = expandedBatchId
    ? captureRunSnapshots[expandedBatchId] ?? { state: "unknown" }
    : { state: "unknown" };
  useCaptureRunSnapshotFetcher({
    batchId: expandedBatchId,
    enabled: Boolean(expandedBatchForRun?.sourceType === "amazon_search_capture" && !consoleOpen),
    refreshToken: expandedBatchId ? captureRunRefreshTokens[expandedBatchId] ?? 0 : 0,
    snapshot: expandedRunSnapshot,
    onSnapshot: recordCaptureRunSnapshot,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search), scanId = params.get("marketScanId") ?? "", sourceModule = params.get("module") ?? "";
    if (!/^[A-Za-z0-9_-]{8,96}$/u.test(scanId) || !["reverse_asin", "keyword_mining_trend", "sellersprite_product_market", "historical_trend"].includes(sourceModule)) return;
    const keyword = (params.get("keyword") ?? "").slice(0,120), asin = (params.get("asin") ?? "").toUpperCase();
    setResearchCapture({ scanId, module: sourceModule, keyword, asin: /^[A-Z0-9]{10}$/u.test(asin) ? asin : "" });
    if (sourceModule === "reverse_asin" || sourceModule === "keyword_mining_trend") setSellerSpriteDepthCaptureOpen(true);
    // Historical research now uses SellerSprite in 02; never auto-open legacy Keepa import.
    const batchId = params.get("batchId");
    if (sourceModule === "sellersprite_product_market" && batchId && /^[A-Za-z0-9_-]{8,96}$/u.test(batchId)) { setExpandedBatchId(batchId); }
  }, []);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const moreToolsRef = useRef<HTMLDivElement | null>(null);
  const moreToolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreToolsPopoverRef = useRef<HTMLDivElement | null>(null);
  const [moreToolsPosition, setMoreToolsPosition] = useState({ left: 0, top: 0 });
  /** 标记「本次 expandedBatchId 变化由用户点击触发」，据此决定是否滚动定位。 */
  const pendingBatchScrollRef = useRef<null | "workspace" | "list">(null);

  // 更多工具：Escape 关闭并回焦点；外部点击关闭（disclosure + 普通按钮组，非完整 ARIA Menu）
  useEffect(() => {
    if (!moreToolsOpen) return;
    moreToolsPopoverRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMoreToolsOpen(false);
      moreToolsButtonRef.current?.focus();
    }
    function onPointer(event: MouseEvent | PointerEvent) {
      const root = moreToolsRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      if (event.target instanceof Node && moreToolsPopoverRef.current?.contains(event.target)) return;
      setMoreToolsOpen(false);
    }
    const onViewportChange = () => setMoreToolsOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [moreToolsOpen]);
  const [keepaFile, setKeepaFile] = useState<File | null>(null);
  const [keepaBusy, setKeepaBusy] = useState(false);
  const [keepaError, setKeepaError] = useState<string | null>(null);
  const [keepaResult, setKeepaResult] = useState<KeepaImportResult | null>(null);
  const [recordsDrawerOpen, setRecordsDrawerOpen] = useState(false);

  function openAmazonCapture(mode: AmazonCaptureMode) {
    setAmazonCaptureMode(mode);
    setAmazonCaptureOpen(true);
  }

  // MarketScan creation confirmation dialog
  const [createScanModalOpen, setCreateScanModalOpen] = useState(false);
  const [targetBatchForScan, setTargetBatchForScan] = useState<SourceBatchSummary | null>(null);
  const [createScanName, setCreateScanName] = useState("");
  const [createScanBusy, setCreateScanBusy] = useState(false);
  const [createScanError, setCreateScanError] = useState<string | null>(null);
  // D0-004：创建前消费服务端「最终权威样本口径」预检（只读）
  const [createScanPreview, setCreateScanPreview] = useState<{
    loading: boolean;
    data: MarketSamplePreviewData | null;
    error: string | null;
  }>({ loading: false, data: null, error: null });

  const previewRequest = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const createScanKey = useRef("");
  const closeCreateScan = () => {
    if (createScanBusy) return;
    previewRequest.current.sequence++; previewRequest.current.controller?.abort();
    setCreateScanModalOpen(false); setCreateScanPreview({ loading: false, data: null, error: null });
  };
  const fetchSamplePreview = useCallback(async (batch: SourceBatchSummary) => {
    previewRequest.current.controller?.abort();
    const controller = new AbortController(), sequence = ++previewRequest.current.sequence;
    previewRequest.current.controller = controller;
    setCreateScanPreview({ loading: true, data: null, error: null });
    try {
      const params = new URLSearchParams({
        productBatchId: batch.id,
        marketplace: (batch.marketplace || "US").toUpperCase(),
      });
      const response = await fetch(`/api/market-analysis/sample-preview?${params.toString()}`, {
        signal: controller.signal,
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        throw new Error(json?.error?.message || `样本预检失败 (${response.status})`);
      }
      if (!validSamplePreview(json.data, batch.id)) throw new Error("预检返回不完整或批次不匹配，请重新预检。");
      if (sequence !== previewRequest.current.sequence) return;
      setCreateScanPreview({ loading: false, data: json.data as MarketSamplePreviewData, error: null });
    } catch (error) {
      if (controller.signal.aborted || sequence !== previewRequest.current.sequence) return;
      setCreateScanPreview({
        loading: false,
        data: null,
        error: error instanceof Error ? error.message : "样本预检失败，无法确认最终可冻结样本数。",
      });
    }
  }, []);

  // Item actions
  const [actionBusy, setActionBusy] = useState(false);
  const [protectionWarning, setProtectionWarning] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [itemBulkAction, setItemBulkAction] = useState<"archive" | "restore" | "delete">("archive");
  const [itemBulkConfirmOpen, setItemBulkConfirmOpen] = useState(false);
  const [itemBulkBusy, setItemBulkBusy] = useState(false);
  const [itemBulkNotice, setItemBulkNotice] = useState<{ tone: "success" | "error"; message: string; failures?: SourceBulkFailure[] } | null>(null);

  // Batch lifecycle actions (drawer table)
  const [batchSelection, setBatchSelection] = useState<RowSelectionState>({});
  const [batchActionBusy, setBatchActionBusy] = useState(false);
  const [batchNotice, setBatchNotice] = useState<{ tone: "info" | "success" | "error"; message: string; failures?: SourceBulkFailure[] } | null>(null);
  const [amazonCaptureRevision, setAmazonCaptureRevision] = useState(0);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [targetBatchToDelete, setTargetBatchToDelete] = useState<SourceBatchSummary | null>(null);
  const [batchProtectionWarning, setBatchProtectionWarning] = useState<string | null>(null);
  /**
   * 拦截种类：区分「依赖保护」「版本冲突」「其它失败」。
   * 只有依赖保护才应给出「改为归档」引导 —— 版本冲突时归档同样会失败，属错误建议。
   */
  const [batchDeleteBlockedKind, setBatchDeleteBlockedKind] = useState<
    "dependency" | "version_conflict" | "error" | null
  >(null);
  const [batchBulkConfirmOpen, setBatchBulkConfirmOpen] = useState(false);
  const [batchBulkAction, setBatchBulkAction] = useState<"archive" | "restore" | "delete">("archive");

  // Load batches
  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const batchesRes = await fetch("/api/source/batches?include=" + (showArchived ? "all" : "active"), {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });

      if (batchesRes.ok) {
        const json = await batchesRes.json().catch(() => null);
        if (json?.ok && Array.isArray(json.data?.items)) {
          setBatches(json.data.items);
        } else {
          setBatches([]);
          setErrorMsg(json?.error?.message || "读取正式来源批次失败：响应格式不符合 V5 契约。");
        }
      } else {
        const json = await batchesRes.json().catch(() => null);
        setBatches([]);
        setErrorMsg(
          json?.error?.message ||
            (batchesRes.status === 404
              ? "正式来源批次接口不存在（404）。"
              : `读取正式来源批次失败 (${batchesRes.status})。`)
        );
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "加载商品来源批次失败");
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Fetch items for a specific batch when expanded
  const fetchBatchItems = useCallback(async (batchId: string, quiet = false) => {
    if (!quiet) setLoadingBatchItems((prev) => ({ ...prev, [batchId]: true }));
    setBatchItemsErrorMap((prev) => ({ ...prev, [batchId]: null }));
    try {
      const res = await fetch(`/api/source/batches/${encodeURIComponent(batchId)}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok || !Array.isArray(json.data?.items)) {
        throw new Error(json?.error?.message || `读取批次商品状态失败 (${res.status})。`);
      }
      setBatchItemsMap((prev) => ({ ...prev, [batchId]: json.data.items }));
    } catch (err) {
      console.error(`Failed to load items for batch ${batchId}`, err);
      // A refused refresh cannot leave an older authorized projection on screen.
      setBatchItemsMap(prev => { const next = { ...prev }; delete next[batchId]; return next; });
      setBatchItemsErrorMap((prev) => ({
        ...prev,
        [batchId]: err instanceof Error ? err.message : "读取批次商品状态失败，请重试。",
      }));
    } finally {
      if (!quiet) setLoadingBatchItems((prev) => ({ ...prev, [batchId]: false }));
    }
  }, []);

  const fetchBatchDetailJob = useCallback(async (batchId: string): Promise<BatchDetailJobView | null> => {
    try {
      const response = await fetch("/api/source-layer/enrich/batch-detail/jobs?batchId=" + encodeURIComponent(batchId), {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok || !json.data?.progress) {
        throw new Error(json?.error?.message || "读取 Amazon 详情补齐状态失败 (" + response.status + ")。");
      }
      const view = json.data as BatchDetailJobView;
      setBatchDetailJobMap((current) => ({ ...current, [batchId]: view }));
      setBatchDetailJobErrorMap((current) => {
        const next = { ...current };
        delete next[batchId];
        return next;
      });
      return view;
    } catch (error) {
      setBatchDetailJobErrorMap((current) => ({
        ...current,
        [batchId]: error instanceof Error ? error.message : "读取 Amazon 详情补齐状态失败。",
      }));
      return null;
    }
  }, []);

  const handleBatchDetailJobAction = async (
    batch: SourceBatchSummary,
    action: "ensure" | "pause" | "resume" | "run-one",
  ) => {
    setBatchDetailJobBusy((current) => ({ ...current, [batch.id]: true }));
    setBatchDetailJobErrorMap((current) => {
      const next = { ...current };
      delete next[batch.id];
      return next;
    });
    try {
      const response = await fetch("/api/source-layer/enrich/batch-detail/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildAccessHeaders() },
        body: JSON.stringify({ batchId: batch.id, action }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        throw new Error(json?.error?.message || "Amazon 详情补齐任务操作失败 (" + response.status + ")。");
      }
      await fetchBatchDetailJob(batch.id);
      await fetchBatchItems(batch.id, true);
    } catch (error) {
      setBatchDetailJobErrorMap((current) => ({
        ...current,
        [batch.id]: error instanceof Error ? error.message : "Amazon 详情补齐任务操作失败。",
      }));
    } finally {
      setBatchDetailJobBusy((current) => ({ ...current, [batch.id]: false }));
    }
  };
async function handleBatchDetailEnrichmentConfirm(batch: SourceBatchSummary) {
    const itemsLoaded = Object.prototype.hasOwnProperty.call(batchItemsMap, batch.id);
    const items = batchItemsMap[batch.id] ?? [];
    const summary = summarizeAmazonDetailBatchStatus(items, batch.batchStatus);
    if (!itemsLoaded || loadingBatchItems[batch.id] || !summary.canContinue) {
      setBatchDetailNotice((current) => ({
        ...current,
        [batch.id]: {
          tone: "info",
          message: !itemsLoaded
            ? "尚未读取完整商品状态，已取消操作；请先重新读取。"
            : summary.disabledReason ?? "当前批次不能继续详情补齐。",
        },
      }));
      setBatchDetailConfirmTarget(null);
      return;
    }

    setBatchDetailBusyId(batch.id);
    setBatchDetailNotice((current) => {
      const next = { ...current };
      delete next[batch.id];
      return next;
    });

    try {
      const idempotencyKey = globalThis.crypto.randomUUID();
      const response = await fetch("/api/source-layer/enrich/batch-detail", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": idempotencyKey,
          ...buildAccessHeaders(),
        },
        body: JSON.stringify({
          batchId: batch.id,
          limit: 30,
          forceRecapture: false,
          idempotencyKey,
        }),
      });
      const json = await response.json().catch(() => null);
      const result = json?.summary;
      if (!response.ok || !json?.ok || !result || typeof result.total !== "number") {
        throw new Error(json?.error?.message || `详情补齐未完成 (${response.status})。`);
      }

      const failureCount = (result.failedRetryable ?? 0) + (result.failedPermanent ?? 0) + (result.failedHuman ?? 0);
      const message = [
        `本次处理 ${result.total} 条`,
        `完整补齐 ${result.enriched ?? 0} 条`,
        `部分保存 ${result.capturedPartial ?? 0} 条`,
        `失败 ${failureCount} 条`,
        `已有详情跳过 ${result.skippedEnriched ?? 0} 条`,
      ].join("；") + (result.humanAborted ? "。遇到登录或验证码门槛，后续采集已停止。" : "。状态已按商品记录刷新。");
      setBatchDetailNotice((current) => ({
        ...current,
        [batch.id]: { tone: result.humanAborted || failureCount > 0 ? "info" : "success", message },
      }));
      setBatchDetailConfirmTarget(null);
      await fetchBatchItems(batch.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "详情补齐遇到异常；请重新读取商品状态后再试。";
      setBatchDetailNotice((current) => ({ ...current, [batch.id]: { tone: "error", message } }));
      setBatchDetailConfirmTarget(null);
      await fetchBatchItems(batch.id);
    } finally {
      setBatchDetailBusyId(null);
    }
  }

  async function handleKeepaImport() {
    if (!keepaFile) return;
    setKeepaBusy(true);
    setKeepaError(null);
    setKeepaResult(null);
    try {
      const result = await uploadKeepaCsv(keepaFile);
      setKeepaResult(result);
      await loadData();
      if (expandedBatchId) await fetchBatchItems(expandedBatchId);
    } catch (error) {
      setKeepaError(error instanceof Error ? error.message : "Keepa 导入失败。");
    } finally {
      setKeepaBusy(false);
    }
  }

  const handleEnrichBatchVariations = async (batch: SourceBatchSummary) => {
    setVariationEnrichBusy((current) => ({ ...current, [batch.id]: true }));
    setVariationEnrichNotice((current) => {
      const next = { ...current };
      delete next[batch.id];
      return next;
    });
    const totals = { processed: 0, complete: 0, capturedPartial: 0, noDataWithEvidence: 0, failedHuman: 0, failedRetryable: 0, skippedExisting: 0, notAttempted: 0 };
    let humanAborted = false;
    try {
      const itemCount = Math.max(0, batch.itemCount ?? 0);
      const maxRuns = Math.ceil(itemCount / 30);
      for (let run = 0; run < maxRuns; run += 1) {
        const idempotencyKey = `variation_${batch.id}_${Date.now()}_${run}`;
        const response = await fetch("/api/source-layer/enrich/batch-variation", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildAccessHeaders(),
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ batchId: batch.id, limit: Math.min(30, itemCount) }),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || !json?.ok || !json.summary) {
          throw new Error(json?.error?.message || `变体补齐失败 (${response.status})。`);
        }
        const summary = json.summary as Partial<typeof totals> & { humanAborted?: boolean };
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
          totals[key] += typeof summary[key] === "number" ? summary[key]! : 0;
        }
        humanAborted = summary.humanAborted === true;
        const covered = (summary.processed ?? 0) + (summary.skippedExisting ?? 0);
        if (humanAborted || covered === 0 || covered >= itemCount) break;
      }
      const message = `本次处理 ${totals.processed} 件：完整 ${totals.complete}、部分 ${totals.capturedPartial}、确认无变体 ${totals.noDataWithEvidence}、可重试受限 ${totals.failedRetryable}、需人工 ${totals.failedHuman}、已有记录跳过 ${totals.skippedExisting}、未尝试 ${totals.notAttempted}。${humanAborted ? "遇到人工验证门槛，后续商品已暂停。" : ""}`;
      setVariationEnrichNotice((current) => ({ ...current, [batch.id]: { tone: "success", message } }));
      await fetchBatchItems(batch.id);
    } catch (error) {
      setVariationEnrichNotice((current) => ({
        ...current,
        [batch.id]: { tone: "error", message: error instanceof Error ? error.message : "变体补齐遇到异常。" },
      }));
    } finally {
      setVariationEnrichBusy((current) => ({ ...current, [batch.id]: false }));
    }
  };

  const handleRecollectModule = async (batch: SourceBatchSummary, item: SourceItemDTO, module: SourceModuleId) => {
    const recollectableModules: SourceModuleId[] = ["amazon_detail", "variation", "review_voc"];
    if (!recollectableModules.includes(module) || !item.asin) return;
    const actionKey = `${batch.id}:${item.id}:${module}`;
    setModuleRecollectBusy((current) => ({ ...current, [actionKey]: true }));
    setModuleActionNotice((current) => {
      const next = { ...current };
      delete next[actionKey];
      return next;
    });
    try {
      const response = await fetch("/api/source-layer/orchestrate/module", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `module_${module}_${batch.id}_${item.id}_${Date.now()}`,
        },
        body: JSON.stringify({
          batchId: batch.id,
          modules: [module],
          targetAsin: item.asin,
          limit: 1,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        throw new Error(json?.error?.message || "该模块本次没有完成采集，请查看页面提示后重试。");
      }
      const moduleRun = Array.isArray(json.modules) ? json.modules[0] as Record<string, unknown> | undefined : undefined;
      const resultItems = Array.isArray(moduleRun?.items) ? moduleRun.items as Array<Record<string, unknown>> : [];
      const result = resultItems.find((row) => typeof row.asin === "string" && row.asin.toUpperCase() === item.asin.toUpperCase())
        ?? resultItems[0];
      const rawStatus = typeof result?.status === "string" ? result.status : "unknown";
      const statusLabels: Record<string, string> = {
        enriched: "详情证据与商品投影已更新",
        captured_partial: "已保存部分详情证据",
        complete: "已保存完整模块证据",
        no_data_with_evidence: "已确认无数据，并保存页面证据",
        failed_human: "需要人工登录或完成人机验证；自动采集已停止",
        not_attempted: "本商品未打开采集页面，因此没有生成商品级失败证据",
        failed_retryable: "本次未拿到可验证数据，可稍后重试",
        failed_permanent: "页面身份校验未通过，未将数据绑定到此商品",
        blocked_with_evidence: "页面限制已记录，本次未完成采集",
        skipped_enriched: "当前详情已完成，没有重复写入",
        skipped_existing: "已有终态证据，本次没有重复采集",
      };
      const message = result
        ? `${item.asin} · ${statusLabels[rawStatus] ?? "已返回模块结果"}${typeof result.evidenceId === "string" ? ` · 证据 ${result.evidenceId}` : ""}`
        : `${item.asin} · 接口已完成，但没有返回商品级状态。`;
      const tone = ["failed_human", "not_attempted", "failed_retryable", "failed_permanent", "blocked_with_evidence"].includes(rawStatus)
        ? "info" as const
        : "success" as const;
      setModuleActionNotice((current) => ({ ...current, [actionKey]: { tone, message } }));
      await fetchBatchItems(batch.id);
    } catch (error) {
      setModuleActionNotice((current) => ({
        ...current,
        [actionKey]: { tone: "error", message: error instanceof Error ? error.message : "模块采集遇到异常。" },
      }));
    } finally {
      setModuleRecollectBusy((current) => ({ ...current, [actionKey]: false }));
    }
  };

  const handleRunBatchModule = async (batch: SourceBatchSummary, module: SourceModuleId) => {
    const actionKey = `${batch.id}:${module}`;
    setModuleBatchBusy((current) => ({ ...current, [actionKey]: true }));
    setModuleBatchNotice((current) => {
      const next = { ...current };
      delete next[actionKey];
      return next;
    });
    try {
      const response = await fetch("/api/source-layer/orchestrate/module", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `module_${module}_${batch.id}_${Date.now()}`,
        },
        body: JSON.stringify({ batchId: batch.id, modules: [module], limit: 30 }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok || !Array.isArray(json.modules)) {
        throw new Error(json?.error?.message || "本模块本轮没有完成采集，请查看商品状态和限制说明。");
      }
      const result = json.modules[0] as Record<string, unknown> | undefined;
      const status = typeof result?.status === "string" ? result.status : "unknown";
      const message = typeof result?.message === "string" ? result.message : "模块执行已返回结果。";
      const tone = ["human_action_required", "source_input_required", "partial"].includes(status)
        ? "info" as const
        : status === "failed_retryable" ? "error" as const : "success" as const;
      setModuleBatchNotice((current) => ({ ...current, [actionKey]: { tone, message } }));
      await fetchBatchItems(batch.id);
    } catch (error) {
      setModuleBatchNotice((current) => ({
        ...current,
        [actionKey]: { tone: "error", message: error instanceof Error ? error.message : "模块采集遇到异常。" },
      }));
    } finally {
      setModuleBatchBusy((current) => ({ ...current, [actionKey]: false }));
    }
  };

  const handleEnrichBatchReview = async (batch: SourceBatchSummary) => {
    const noticeKey = batch.id;
    setReviewBatchBusy((current) => ({ ...current, [noticeKey]: true }));
    setReviewBatchNotice((current) => {
      const next = { ...current };
      delete next[noticeKey];
      return next;
    });
    const totals = { processed: 0, complete: 0, partial: 0, noData: 0, retryable: 0, permanent: 0, human: 0, unattempted: 0 };
    let humanGate = false;
    try {
      const itemCount = Math.max(0, batch.itemCount ?? 0);
      const maxRuns = Math.ceil(itemCount / 5);
      for (let run = 0; run < maxRuns; run += 1) {
        const response = await fetch("/api/source-layer/orchestrate/module", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildAccessHeaders(),
            "Idempotency-Key": `review_batch_${batch.id}_${Date.now()}_${run}`,
          },
          body: JSON.stringify({ batchId: batch.id, modules: ["review_voc"], limit: 5 }),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || !json?.ok || !Array.isArray(json.modules)) throw new Error(json?.error?.message || `评论/买家声音采集失败 (${response.status})。`);
        const moduleRun = json.modules[0] as Record<string, unknown> | undefined;
        const runItems = Array.isArray(moduleRun?.items) ? moduleRun.items as Array<Record<string, unknown>> : [];
        const newlyProcessed = runItems.filter((row) => !["skipped_existing", "not_attempted"].includes(String(row.status)));
        totals.processed += typeof moduleRun?.processed === "number" ? moduleRun.processed : newlyProcessed.length;
        totals.complete += newlyProcessed.filter((row) => row.status === "complete").length;
        totals.partial += newlyProcessed.filter((row) => row.status === "captured_partial").length;
        totals.noData += newlyProcessed.filter((row) => row.status === "no_data_with_evidence").length;
        totals.retryable += newlyProcessed.filter((row) => row.status === "failed_retryable").length;
        totals.permanent += newlyProcessed.filter((row) => row.status === "failed_permanent").length;
        totals.human += newlyProcessed.filter((row) => row.status === "failed_human").length;
        totals.unattempted += runItems.filter((row) => row.status === "not_attempted" || row.status === "blocked_with_evidence" && row.errorCode === "HUMAN_GATE_PAUSE").length;
        humanGate = moduleRun?.status === "human_action_required" || totals.human > 0;
        if (humanGate || !moduleRun?.processed || moduleRun.processed === 0) break;
      }
      const message = `评论/买家声音本次处理 ${totals.processed} 件：真实评论 ${totals.complete + totals.partial} 件（完整 ${totals.complete}、片段 ${totals.partial}），确认无公开评论 ${totals.noData} 件，可重试 ${totals.retryable} 件，身份阻断 ${totals.permanent} 件。${humanGate ? `遇到登录或验证码门槛，未继续导航${totals.unattempted ? `，另有 ${totals.unattempted} 件未尝试` : ""}。` : ""}`;
      setReviewBatchNotice((current) => ({ ...current, [noticeKey]: { tone: humanGate ? "info" : "success", message } }));
      await fetchBatchItems(batch.id);
    } catch (error) {
      setReviewBatchNotice((current) => ({ ...current, [noticeKey]: { tone: "error", message: error instanceof Error ? error.message : "评论/买家声音批次采集遇到异常。" } }));
    } finally {
      setReviewBatchBusy((current) => ({ ...current, [noticeKey]: false }));
    }
  };

  const evidenceReadSequence = useRef(0);
  const closeModuleEvidence = () => {
    if (moduleEvidenceViewer && expandedItemId === moduleEvidenceViewer.item.id && expandedBatchId === moduleEvidenceViewer.batch.id) {
      setReviewModuleFocus({ itemId: moduleEvidenceViewer.item.id, module: moduleEvidenceViewer.module, token: Date.now() });
    }
    setModuleEvidenceViewer(null);
  };
  const handleViewModuleEvidence = async (batch: SourceBatchSummary, item: SourceItemDTO, module: SourceModuleId) => {
    const sequence = ++evidenceReadSequence.current;
    const subjectKey = `amazon:${(batch.marketplace || "US").toUpperCase()}:${item.asin.toUpperCase()}`;
    const coverage = item.moduleCoverage?.find((entry) => entry.module === module) ?? null;
    setModuleEvidenceViewer({ batch, item, module, coverage, loading: true, error: null, data: null });
    try {
      const params = new URLSearchParams({ subjectKey, module });
      const response = await fetch(`/api/source-layer/acquire/module?${params.toString()}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) throw new Error(json?.error?.message || "读取 EvidenceStore 证据失败。");
      if (sequence !== evidenceReadSequence.current) return;
      setModuleEvidenceViewer(current => current ? { batch, item, module, coverage, loading: false, error: null, data: json.data } : null);
    } catch (error) {
      if (sequence !== evidenceReadSequence.current) return;
      setModuleEvidenceViewer(current => current ? {
        batch, item, module, coverage, loading: false,
        error: error instanceof Error ? error.message : "读取正式证据失败。",
        data: null,
      } : null);
    }
  };

  const browseSnapshot = useMemo<BrowseState | null>(() => expandedBatchId ? ({
    batchId: expandedBatchId, view: matrixOpenMap[expandedBatchId] ? "matrix" : browseViewMap[expandedBatchId] ?? "gallery",
    search: batchSearchMap[expandedBatchId] ?? "", status: batchStatusFilterMap[expandedBatchId] ?? "all", sort: batchSortMap[expandedBatchId] ?? "original",
    page: browsePageMap[expandedBatchId] ?? 0, itemId: expandedItemId, module: moduleEvidenceViewer?.item.id === expandedItemId ? moduleEvidenceViewer?.module ?? null : reviewModuleFocus?.module ?? null,
    matrix: matrixFilterMap[expandedBatchId] ?? DEFAULT_MATRIX_FILTER,
    location: matrixLocation ? { itemId: matrixLocation.itemId, module: matrixLocation.module } : null,
    scroll: { page: 0, matrixTop: 0, matrixLeft: 0, review: 0 },
  }) : null, [expandedBatchId, matrixOpenMap, browseViewMap, batchSearchMap, batchStatusFilterMap, batchSortMap, browsePageMap, expandedItemId, reviewModuleFocus, matrixFilterMap, matrixLocation, moduleEvidenceViewer]);
  const restoreBrowse = useCallback((state: BrowseState | null) => {
    setSelectedItemIds([]); setExpandedItemId(null); setReviewModuleFocus(null); setMatrixLocation(null);
    setCreateScanModalOpen(false); setConsoleOpen(false); setEvidenceOpen(false); setModuleEvidenceViewer(null);
    setItemBulkConfirmOpen(false); setBatchDetailConfirmTarget(null);
    setBatchSelection({}); setBatchDeleteOpen(false); setBatchBulkConfirmOpen(false);
    setProtectionWarning(null); setBatchProtectionWarning(null);
    setExpandedBatchId(state?.batchId ?? null); setPendingBrowseRestore(state); setRestoreNotice("");
    if (!state) return;
    const id = state.batchId;
    setBrowseViewMap(prev => ({ ...prev, [id]: state.view === "table" ? "table" : "gallery" }));
    setMatrixOpenMap(prev => ({ ...prev, [id]: state.view === "matrix" }));
    setBrowsePageMap(prev => ({ ...prev, [id]: state.page }));
    setBatchSearchMap(prev => ({ ...prev, [id]: state.search }));
    setBatchStatusFilterMap(prev => ({ ...prev, [id]: state.status }));
    setBatchSortMap(prev => ({ ...prev, [id]: state.sort }));
    setMatrixFilterMap(prev => ({ ...prev, [id]: state.matrix }));
    void fetchBatchItems(id);
  }, [fetchBatchItems]);
  const recovery = useBatchWorkspaceRecovery({ current: browseSnapshot,
    ready: Boolean(expandedBatchId && batchItemsMap[expandedBatchId] && !loadingBatchItems[expandedBatchId] && !pendingBrowseRestore && (expandedBatchForRun?.sourceType !== "amazon_search_capture" || ["present", "absent", "error"].includes(expandedRunSnapshot.state))),
    listReady: !loading && !errorMsg, batches, restore: restoreBrowse, notice: setRestoreNotice });
  useEffect(() => {
    const saved = pendingBrowseRestore;
    if (!saved || expandedBatchId !== saved.batchId || !batchItemsMap[saved.batchId] || loadingBatchItems[saved.batchId] || batchItemsErrorMap[saved.batchId]) return;
    const items = batchItemsMap[saved.batchId];
    const item = items.find(entry => entry.id === saved.itemId && !entry.archivedAt);
    setExpandedItemId(item?.id ?? null);
    setReviewModuleFocus(item && saved.module ? { itemId: item.id, module: saved.module, token: Date.now() } : null);
    const located = items.find(entry => entry.id === saved.location?.itemId && !entry.archivedAt);
    setMatrixLocation(located && saved.location ? { ...saved.location, token: Date.now() } : null);
    setRestoreNotice(saved.itemId && !item ? "原检阅商品已不存在或已归档，已恢复批次浏览。" : "已恢复浏览位置；资料与运行状态按当前读取结果显示，未恢复批量勾选或操作确认。");
    setPendingBrowseRestore(null);
  }, [pendingBrowseRestore, expandedBatchId, batchItemsMap, loadingBatchItems, batchItemsErrorMap]);

  // When expandedBatchId changes and items not loaded, fetch them
  useEffect(() => {
    if (expandedBatchId && !batchItemsMap[expandedBatchId] && !loadingBatchItems[expandedBatchId] && !batchItemsErrorMap[expandedBatchId]) {
      fetchBatchItems(expandedBatchId);
    }
  }, [expandedBatchId, batchItemsMap, loadingBatchItems, batchItemsErrorMap, fetchBatchItems]);

  useEffect(() => {
    const batch = batches.find((candidate) => candidate.id === expandedBatchId);
    if (!batch || batch.sourceType !== "amazon_search_capture") return;
    let active = true;
    let ticks = 0;
    const refresh = async () => {
      const view = await fetchBatchDetailJob(batch.id);
      ticks += 1;
      if (active && view?.scheduled && (view.job?.status === "PENDING" || view.job?.status === "RUNNING") && ticks % 3 === 0) {
        await fetchBatchItems(batch.id, true);
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // 依赖只保留「展开目标 + 其来源类型」：批次列表每次刷新都会换新数组，
    // 若把 batches 放进依赖，effect 会每 5s 重订阅并立刻补一次请求（双请求 + 重渲染 = 页面跳动）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedBatchId, batches.find((candidate) => candidate.id === expandedBatchId)?.sourceType, fetchBatchDetailJob, fetchBatchItems]);

  /**
   * 展开/收起的滚动定位：只在**用户主动点击**时发生一次。
   * 原实现把 setTimeout + scrollIntoView 写在 setState 的 updater 里（副作用位于 updater 内，
   * StrictMode/重复调用会执行两次），且任何导致 expandedBatchId 变化的路径都会滚动。
   * 现在由 ref 标记「这次变化是用户发起的」，定时刷新与计划确认都不会改变滚动位置。
   */
  const toggleExpandBatch = (batchId: string) => {
    // 筛选/排序仍按批次保留；进入批次时清空跨批选择。
    if (expandedBatchId !== batchId) { setSelectedItemIds([]); setMatrixLocation(null); setReviewModuleFocus(null); setMatrixNotice(""); }
    setExpandedItemId(null);
    const next = expandedBatchId === batchId ? null : batchId;
    pendingBatchScrollRef.current = next ? "workspace" : "list";
    recovery.navigate(next);
  };

  useEffect(() => {
    const target = pendingBatchScrollRef.current;
    if (!target) return;
    pendingBatchScrollRef.current = null;
    const timer = window.setTimeout(() => {
      document.getElementById(target === "workspace" ? "batch-workspace" : "batch-list-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [expandedBatchId]);

  /**
   * T02 同屏检阅：
   * - 打开不滚动页面（面板在右侧 sticky，商品区与检阅区同时可见）；
   * - 关闭后把当前商品卡滚回可见区域，并把焦点还给该卡的「详情」按钮；
   * - 商品被删除/不再存在时静默关闭，避免对不存在的节点滚动。
   */
  const closeReview = () => {
    const closingId = expandedItemId;
    setExpandedItemId(null);
    if (!closingId) return;
    window.setTimeout(() => {
      const matrixRow = document.querySelector<HTMLElement>(`[data-testid="product-material-matrix"][data-active="true"] [data-matrix-item="${closingId}"]`);
      if (matrixRow) {
        (matrixRow.querySelector<HTMLElement>(`[data-matrix-module="${matrixLocation?.module ?? "amazon_detail"}"]`) ?? matrixRow.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
        return;
      }
      const card = document.querySelector<HTMLElement>(`[data-item-id="${closingId}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const detailButton = card?.querySelector<HTMLElement>('[data-testid="toggle-product-detail"]');
      if (detailButton) detailButton.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-testid="batch-product-search"]')?.focus({ preventScroll: true });
    }, 60);
  };

  const openReviewItem = (id: string) => {
    setReviewModuleFocus(null);
    if (expandedItemId === id) {
      closeReview();
      return;
    }
    setExpandedItemId(id);
  };

  useEffect(() => {
    if (!expandedItemId || !expandedBatchId) return;
    const items = batchItemsMap[expandedBatchId];
    if (!items) return;
    if (!items.some((item) => item.id === expandedItemId)) {
      setExpandedItemId(null);
      setRestoreNotice("当前检阅商品已不存在，已返回批次浏览。");
    }
  }, [batchItemsMap, expandedBatchId, expandedItemId]);

  // Open Create MarketScan modal（打开即预检最终权威样本口径）
  const handleOpenCreateScan = (batch: SourceBatchSummary) => {
    if (batch.marketScan?.id) { recovery.save(); router.push(`/market-analysis/${encodeURIComponent(batch.marketScan.id)}`); return; }
    createScanKey.current = `market_create_${batch.id}_${Date.now()}`;
    setTargetBatchForScan(batch);
    setCreateScanName(`${batch.batchName || "市场采集"} 市场研究`);
    setCreateScanError(null);
    setCreateScanModalOpen(true);
    void fetchSamplePreview(batch);
  };

  // Confirm Create MarketScan using the batch's valid deterministic product set
  const handleConfirmCreateScan = async () => {
    if (!targetBatchForScan || createScanBusy) return;
    if (batches.find(batch => batch.id === targetBatchForScan.id)?.marketScan?.id) { setCreateScanError("该批次已关联研究，请关闭窗口后进入已有研究。"); return; }
    // 权威口径未就绪或不足时禁止提交；服务端门禁保持最终权威。
    if (createScanPreview.loading || createScanPreview.error) return;
    if (!createScanPreview.data || !validSamplePreview(createScanPreview.data, targetBatchForScan.id) || !createScanPreview.data.sufficient) return;
    setCreateScanBusy(true);
    setCreateScanError(null);
    try {
      const payload = {
        source: {
          productBatchId: targetBatchForScan.id,
        },
        marketplace: targetBatchForScan.marketplace || "US",
        scanName: createScanName.trim() || `${targetBatchForScan.batchName || "市场分析"} 市场研究`,
        idempotencyKey: createScanKey.current,
      };

      const res = await fetch("/api/market-analysis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message || "建立市场研究失败");
      }

      const scanId = json.data?.id || json.data?.scanId;
      recovery.save();
      setCreateScanModalOpen(false);
      if (scanId) {
        router.push(`/market-analysis/${encodeURIComponent(scanId)}`);
      } else {
        router.push("/market-analysis");
      }
    } catch (err) {
      setCreateScanError(err instanceof Error ? err.message : "建立市场研究发生异常");
      setCreateScanPreview({ loading: false, data: null, error: "创建未完成。请重新预检当前来源；不会覆盖已有研究。" });
      void loadData();
    } finally {
      setCreateScanBusy(false);
    }
  };

  // Single Item Archive / Restore / Delete
  const handleArchiveItem = async (item: SourceItemDTO) => {
    setActionBusy(true);
    try {
      const res = await fetch(`/api/source/items/${encodeURIComponent(item.id)}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `source_archive_${item.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: targetResourceVersion(item) }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || "归档失败");
      }
      setBatchItemsMap((prev) => {
        const items = prev[item.batchId] || [];
        return {
          ...prev,
          [item.batchId]: items.map((i) => (i.id === item.id ? { ...i, archivedAt: new Date().toISOString() } : i)),
        };
      });
      loadData();
    } catch (e) {
      alert(e instanceof Error ? e.message : "归档请求失败");
    } finally {
      setActionBusy(false);
    }
  };

  const handleRestoreItem = async (item: SourceItemDTO) => {
    setActionBusy(true);
    try {
      const res = await fetch(`/api/source/items/${encodeURIComponent(item.id)}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `source_restore_${item.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: targetResourceVersion(item) }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || "恢复失败");
      }
      setBatchItemsMap((prev) => {
        const items = prev[item.batchId] || [];
        return {
          ...prev,
          [item.batchId]: items.map((i) => (i.id === item.id ? { ...i, archivedAt: null } : i)),
        };
      });
      loadData();
    } catch (e) {
      alert(e instanceof Error ? e.message : "恢复请求失败");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDeleteItem = async (item: SourceItemDTO) => {
    const isReferenced =
      item.referencedBy &&
      (item.referencedBy.marketScanIds?.length > 0 ||
        item.referencedBy.candidateIds?.length > 0 ||
        item.referencedBy.taskIds?.length > 0);

    if (isReferenced) {
      setProtectionWarning(
        `该商品已被下游业务引用（市场分析: ${item.referencedBy.marketScanIds?.length || 0}，候选池: ${
          item.referencedBy.candidateIds?.length || 0
        }，任务: ${item.referencedBy.taskIds?.length || 0}）。系统禁止物理删除，请改为归档。`
      );
      return;
    }

    if (!confirm(`确定要彻底删除商品 "${item.title || item.asin}" 吗？此操作无法撤销。`)) return;

    setActionBusy(true);
    try {
      const res = await fetch(`/api/source/items/${encodeURIComponent(item.id)}/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `source_del_${item.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: targetResourceVersion(item) }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || "删除失败");
      }
      setBatchItemsMap((prev) => {
        const items = prev[item.batchId] || [];
        return { ...prev, [item.batchId]: items.filter((i) => i.id !== item.id) };
      });
      // 删除当前检阅商品时关闭面板；不滚动到不存在的卡片。
      setExpandedItemId((prev) => (prev === item.id ? null : prev));
      loadData();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除请求失败");
    } finally {
      setActionBusy(false);
    }
  };

  // Batch lifecycle actions (archive / restore / delete)
  const handleArchiveBatch = async (batch: SourceBatchSummary) => {
    setBatchActionBusy(true);
    setBatchNotice(null);
    try {
      const res = await fetch(`/api/source/batches/${encodeURIComponent(batch.id)}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `batch_archive_${batch.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: batch.resourceVersion || batch.updatedAt }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || "批次归档失败");
      setBatchNotice({ tone: "success", message: `批次 "${batch.batchName || batch.id}" 已归档。` });
      await loadData();
    } catch (e) {
      setBatchNotice({ tone: "error", message: e instanceof Error ? e.message : "批次归档未完成" });
    } finally {
      setBatchActionBusy(false);
    }
  };

  const handleRestoreBatch = async (batch: SourceBatchSummary) => {
    setBatchActionBusy(true);
    setBatchNotice(null);
    try {
      const res = await fetch(`/api/source/batches/${encodeURIComponent(batch.id)}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `batch_restore_${batch.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: batch.resourceVersion || batch.updatedAt }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || "批次恢复失败");
      setBatchNotice({ tone: "success", message: `批次 "${batch.batchName || batch.id}" 已恢复为活跃状态。` });
      await loadData();
    } catch (e) {
      setBatchNotice({ tone: "error", message: e instanceof Error ? e.message : "批次恢复未完成" });
    } finally {
      setBatchActionBusy(false);
    }
  };

  const handleDeleteBatch = (batch: SourceBatchSummary) => {
    setTargetBatchToDelete(batch);
    setBatchProtectionWarning(null);
    setBatchDeleteBlockedKind(null);
    setBatchDeleteOpen(true);
  };

  const confirmDeleteBatch = async () => {
    if (!targetBatchToDelete) return;
    setBatchActionBusy(true);
    setBatchProtectionWarning(null);
    setBatchDeleteBlockedKind(null);
    try {
      const res = await fetch(`/api/source/batches/${encodeURIComponent(targetBatchToDelete.id)}/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `batch_del_${targetBatchToDelete.id}_${Date.now()}`,
        },
        body: JSON.stringify({ expectedVersion: targetBatchToDelete.resourceVersion || targetBatchToDelete.updatedAt }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        // 409 至少有三种成因：依赖保护、版本冲突（CAS_CONFLICT）、以及其它业务拒绝。
        // 必须按 error code 分流，否则会把版本冲突误报成「依赖保护」并给出必然再次失败的「改为归档」引导。
        const code = typeof json?.error?.code === "string" ? json.error.code : "";
        if (code === "DELETE_DEPENDENCY_BLOCKED" || code === "CAS_CONFLICT") {
          const details = extractErrorDetails(json);
          const blockedBy = extractDeleteBlockedBy(details);
          setBatchDeleteBlockedKind(code === "CAS_CONFLICT" ? "version_conflict" : "dependency");
          setBatchProtectionWarning(
            code === "CAS_CONFLICT"
              ? "该批次已被其他操作更新（版本冲突），请关闭弹窗刷新后重试。"
              : `该批次受到业务依赖保护，无法物理删除：${describeBatchBlockedBy(blockedBy)}。系统已拦截物理删除，请改为「归档」。底层不可变证据将始终完整保留。`
          );
          return;
        }
        throw new Error(json?.error?.message || "删除批次失败");
      }
      setBatchDeleteOpen(false);
      setTargetBatchToDelete(null);
      setBatchNotice({ tone: "success", message: `批次 "${targetBatchToDelete.batchName || targetBatchToDelete.id}" 已彻底删除。` });
      await loadData();
    } catch (e) {
      // 非依赖保护的失败必须如实归类，不得笼统显示成「依赖保护拦截」。
      setBatchDeleteBlockedKind("error");
      setBatchProtectionWarning(e instanceof Error ? e.message : "删除批次请求失败");
    } finally {
      setBatchActionBusy(false);
    }
  };

  // Bulk batch actions in Drawer
  const selectedBatches = useMemo(() => {
    const indices = Object.keys(batchSelection)
      .filter((k) => batchSelection[k])
      .map(Number);
    return indices.map((i) => batches[i]).filter(Boolean);
  }, [batchSelection, batches]);

  const selectedSourceItems = useMemo(() => {
    if (!expandedBatchId) return [];
    const selected = new Set(selectedItemIds);
    return (batchItemsMap[expandedBatchId] ?? []).filter((item) => selected.has(item.id));
  }, [batchItemsMap, expandedBatchId, selectedItemIds]);

  const handleItemBulkActionConfirm = async () => {
    const batchId = expandedBatchId;
    if (!batchId || selectedSourceItems.length === 0) return;
    if (selectedSourceItems.length > 100) {
      setItemBulkNotice({ tone: "error", message: "一次最多处理 100 条商品，请缩小选择范围。" });
      setItemBulkConfirmOpen(false);
      return;
    }
    setItemBulkBusy(true);
    setItemBulkNotice(null);
    const actionLabel = itemBulkAction === "archive" ? "归档" : itemBulkAction === "restore" ? "恢复" : "删除";
    try {
      const res = await fetch("/api/source/items/bulk-actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `source_item_bulk_${itemBulkAction}_${Date.now()}`,
        },
        body: JSON.stringify({
          resource: "source_item",
          action: itemBulkAction,
          items: selectedSourceItems.map((item) => ({ id: item.id, expectedVersion: targetResourceVersion(item) })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || `批量${actionLabel}失败`);
      const results = Array.isArray(json.data?.results) ? json.data.results : [];
      const labels = new Map(selectedSourceItems.map((item) => [item.id, `${item.title || item.asin}（${item.asin}）`]));
      const failures = sourceBulkFailures(results, labels);
      const succeeded = results.filter((result: { outcome?: string }) => result?.outcome !== "failed").length;
      setItemBulkNotice({
        tone: failures.length > 0 ? "error" : "success",
        message: failures.length > 0
          ? `批量${actionLabel}部分完成：成功 ${succeeded} 项，失败 ${failures.length} 项。已完成的项目保留成功结果，没有回滚。`
          : `已批量${actionLabel} ${succeeded} 项。`,
        ...(failures.length > 0 ? { failures } : {}),
      });
      setSelectedItemIds(failures.map((failure) => failure.id));
      setItemBulkConfirmOpen(false);
      await loadData();
      await fetchBatchItems(batchId);
    } catch (error) {
      setItemBulkNotice({ tone: "error", message: error instanceof Error ? error.message : `批量${actionLabel}未完成，请刷新确认。` });
      setItemBulkConfirmOpen(false);
    } finally {
      setItemBulkBusy(false);
    }
  };

  const handleBatchBulkActionConfirm = async () => {
    if (selectedBatches.length === 0) return;
    setBatchActionBusy(true);
    setBatchNotice(null);
    const actionLabel = batchBulkAction === "archive" ? "归档" : batchBulkAction === "restore" ? "恢复" : "删除";
    try {
      const payload = {
        resource: "source_batch",
        action: batchBulkAction,
        items: selectedBatches.map((b) => ({ id: b.id, expectedVersion: b.resourceVersion || b.updatedAt })),
      };
      const res = await fetch("/api/source/batches/bulk-actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
          "Idempotency-Key": `batch_bulk_${batchBulkAction}_${Date.now()}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || `批量${actionLabel}失败`);

      const results = Array.isArray(json.data?.results) ? json.data.results : [];
      const labels = new Map(selectedBatches.map((batch) => [batch.id, batch.batchName || batch.id]));
      const failed = sourceBulkFailures(results, labels);
      const succeeded = results.filter((result: { outcome?: string }) => result?.outcome !== "failed").length;

      if (failed.length > 0) {
        setBatchNotice({
          tone: "error",
          message: `批量${actionLabel}部分完成：成功 ${succeeded} 个，失败 ${failed.length} 个。已完成的项目保留成功结果，没有回滚。`,
          failures: failed,
        });
      } else {
        setBatchNotice({ tone: "success", message: `已批量${actionLabel} ${succeeded} 个批次。` });
      }

      setBatchSelection({});
      setBatchBulkConfirmOpen(false);
      await loadData();
    } catch (e) {
      setBatchNotice({ tone: "error", message: e instanceof Error ? e.message : "批次批量操作未完成" });
    } finally {
      setBatchActionBusy(false);
    }
  };

  // Columns for Drawer batch management table
  const drawerBatchColumns: ColumnDef<SourceBatchSummary>[] = [
    {
      accessorKey: "batchName",
      header: "来源批次",
      cell: ({ row }) => {
        const batch = row.original;
        const isArchived = !!batch.archivedAt;
        const pres = batch.qualityPresentation || sourceBatchQualityPresentation(batch.dataQualityStatus, {
          itemCount: batch.itemCount,
        });

        return (
          <div className="py-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-900">{batch.batchName || "未命名批次"}</span>
              {isArchived && <Badge tone="slate">已归档</Badge>}
              <Badge tone={pres.tone}>{pres.text}</Badge>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[13px] text-slate-500">
              <span className="font-mono text-slate-400">{batch.id.slice(0, 8)}...</span>
              {batch.marketplace && (
                <>
                  <span>·</span>
                  <span>站点: {batch.marketplace}</span>
                </>
              )}
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "itemCount",
      header: "商品数",
      cell: ({ row }) => {
        const raw = row.original.rawCount ?? row.original.itemCount;
        const valid = row.original.validSampleCount ?? row.original.acceptedCount;
        return (
          <div className="text-xs">
            <span className="text-sm font-bold text-slate-900">{raw}</span>
            <span className="ml-1 text-slate-500">款商品</span>
            <span className="ml-2 text-[13px] text-emerald-600 font-medium">有效 {valid}</span>
          </div>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: "导入时间",
      cell: ({ row }) => (
        <span className="text-[13px] text-slate-500 font-mono">
          {new Date(row.original.createdAt).toLocaleString("zh-CN")}
        </span>
      ),
    },
    {
      id: "drawerBatchActions",
      header: "操作",
      cell: ({ row }) => {
        const batch = row.original;
        const isArchived = !!batch.archivedAt;
        return (
          <div className="flex items-center gap-1.5">
            {isArchived ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => handleRestoreBatch(batch)}
                disabled={batchActionBusy}
              >
                恢复
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => handleArchiveBatch(batch)}
                disabled={batchActionBusy}
              >
                归档
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2 text-rose-600 hover:bg-rose-50 hover:text-rose-800"
              onClick={() => handleDeleteBatch(batch)}
              disabled={batchActionBusy}
            >
              删除
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className={sourceStyles.sourceCockpit} data-source-cockpit>
      <SourceHero
        onKeyword={() => openAmazonCapture("search")}
        onCategory={() => setCategoryMarketCaptureOpen(true)}
        onSingleAsin={() => openAmazonCapture("detail")}
        toolsMenu={<div data-testid="more-tools-menu" ref={moreToolsRef}
          onBlur={event => {
            const next = event.relatedTarget as Node | null;
            if (!event.currentTarget.contains(next) && !moreToolsPopoverRef.current?.contains(next)) setMoreToolsOpen(false);
          }}>
          <button type="button" className={sourceStyles.secondaryCta}
            ref={moreToolsButtonRef} data-testid="more-tools-button"
            aria-expanded={moreToolsOpen} aria-controls="more-tools-popover"
            onClick={() => {
              const box = moreToolsButtonRef.current?.getBoundingClientRect();
              if (box) setMoreToolsPosition({ left: Math.min(box.left, window.innerWidth - 288), top: Math.min(box.bottom + 8, window.innerHeight - 112) });
              setMoreToolsOpen(open => !open);
            }}>
            <Layers size={15} aria-hidden="true" />更多工具<ChevronDown size={13} aria-hidden="true" />
          </button>
          {moreToolsOpen ? createPortal(<div id="more-tools-popover" role="group" aria-label="更多工具"
            ref={moreToolsPopoverRef} data-testid="more-tools-popover" className={sourceStyles.toolsPopover}
            style={{ position: "fixed", ...moreToolsPosition }}
            onKeyDown={event => {
              if (event.key !== "Tab") return;
              const trigger = moreToolsButtonRef.current;
              if (!trigger) return;
              const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'))
                .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
              const next = event.shiftKey ? trigger : controls[controls.indexOf(trigger) + 1] ?? trigger;
              event.preventDefault(); setMoreToolsOpen(false); next.focus();
            }}
            onBlur={event => {
              const next = event.relatedTarget as Node | null;
              if (!event.currentTarget.contains(next) && !moreToolsRef.current?.contains(next)) setMoreToolsOpen(false);
            }}>
            <button type="button" data-testid="start-sellersprite-depth-capture-button"
              onClick={() => {
                moreToolsButtonRef.current?.focus();
                setMoreToolsOpen(false);
                setSellerSpriteDepthCaptureOpen(true);
              }}>
              SellerSprite 竞品与关键词
              <small>竞品反查 · 关键词挖掘 · 采集任务</small>
            </button>
            <button type="button" data-testid="start-keepa-trend-import-button" hidden disabled
              onClick={() => {
                setMoreToolsOpen(false); setKeepaError(null); setKeepaResult(null); setKeepaOpen(true);
              }}>导入 Keepa 趋势 CSV</button>
          </div>, document.body) : null}
        </div>}
        onOpenRecords={() => setRecordsDrawerOpen(true)}
        onRefresh={loadData}
        loading={loading}
        minimumRequired={minimumRequired}
        lastBatchLabel={batches[0]?.batchName ?? null}
      />
      <SourceEntryBento
        onKeyword={() => openAmazonCapture("search")}
        onCategory={() => setCategoryMarketCaptureOpen(true)}
        onSingleAsin={() => openAmazonCapture("detail")}
      />
      <SourceStats batches={batches} minimumRequired={minimumRequired} loading={loading} />

      {/* D2-1B：最近采集结果默认折叠，数据保留在可访问入口内 */}
      <details className={`${sourceStyles.panel} ${sourceStyles.recentPanel}`} data-testid="latest-capture-results">
        <summary className={sourceStyles.panelHead}>
          <div>
            <h2 className={sourceStyles.panelTitle}>最近采集结果</h2>
            <p className={sourceStyles.panelSub}>类目指标快照与 Amazon 搜索结果，默认收起</p>
          </div>
          <span className={sourceStyles.recentChevron} aria-hidden="true">▾</span>
        </summary>
        <div className={sourceStyles.recentBody}>
          <LatestCategoryMarketCaptureResult />
          <LatestAmazonCaptureResult refreshKey={amazonCaptureRevision} />
        </div>
      </details>

      {/* 错误提示 */}
      {errorMsg && (
        <div
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
          role="alert"
          data-testid="source-batches-error"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* ── Zone 2 · 批次工作区：商品画廊是第一视觉主体；运行区/证据区保留原抽屉入口 ── */}
      {restoreNotice ? <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-[14px] text-emerald-900" role="status" data-testid="workspace-restore-notice"><span>{restoreNotice}</span><button type="button" aria-label="关闭恢复提示" onClick={() => setRestoreNotice("")}>×</button></div> : null}
      {expandedBatchId && batches.some((candidate) => candidate.id === expandedBatchId) ? (
        <section id="batch-workspace" aria-label="批次工作区" data-testid="batch-workspace" className={`scroll-mt-4 ${bwStyles.scope}`}>
          <div className={bwStyles.backRow}>
            <button
              type="button"
              className={bwStyles.backBtn}
              data-testid="batch-workspace-back"
              onClick={() => toggleExpandBatch(expandedBatchId)}
            >
              ← 返回批次列表
            </button>
          </div>

          {batches.filter((batch) => batch.id === expandedBatchId).map((batch) => {
            const rawCount = batch.rawCount ?? batch.itemCount;
            const validSampleCount = batch.validSampleCount ?? batch.acceptedCount;
            const unverifiedCount = batch.unverifiedCount ?? 0;
            // 只消费服务端唯一权威判定（VALID_PRODUCT_SET），UI 不再自行比较阈值，
            // 从根本上消除「前端绿灯 / 后端 409」。
            const samplePolicy = batch.validProductSet ?? null;
            const isSampleSufficient = samplePolicy ? samplePolicy.isSufficient : validSampleCount >= minimumRequired;
            const sampleShortfall = Math.max(0, minimumRequired - validSampleCount);
            const hasMarketScan = !!batch.marketScan;
            // 历史空批次：从未产出商品记录（采集失败或质检拦截），itemCount 可能为 null。
            const isEmptyBatch = !hasMarketScan && !rawCount;
            const items = batchItemsMap[batch.id] || [];
            const itemsLoading = loadingBatchItems[batch.id];
            const detailJobView = batchDetailJobMap[batch.id];
            const detailJobStatus = detailJobView?.job?.status;
            const detailJobProgress = detailJobView?.progress;
            const detailJobAction = !detailJobView?.scheduled
              ? "ensure"
              : detailJobStatus === "PAUSED" || detailJobStatus === "FAILED" || detailJobStatus === "CANCELLED"
                ? "resume"
                : null;
            const detailBatchIncomplete = detailJobProgress
              ? detailJobProgress.enriched + detailJobProgress.partial < detailJobProgress.total || detailJobProgress.partial > 0
              : items.some((item) => !item.enrichmentStatus || item.enrichmentStatus === "captured_partial");
            const batchItemsLoaded = Object.prototype.hasOwnProperty.call(batchItemsMap, batch.id);
            const detailEnrichmentItems = items.filter((item) => !item.archivedAt && typeof item.asin === "string" && item.asin.trim().length > 0);
            const detailEnrichmentSummary = summarizeAmazonDetailBatchStatus(detailEnrichmentItems, batch.batchStatus);
            const detailEnrichmentBusy = batchDetailBusyId === batch.id;
            const detailEnrichmentCanContinue = batchItemsLoaded
              && !itemsLoading
              && !batchItemsErrorMap[batch.id]
              && !detailEnrichmentBusy
              && detailEnrichmentSummary.canContinue;
            const detailEnrichmentBadge = detailEnrichmentSummary.unknown > 0
              ? { tone: "amber" as const, label: "状态需核对" }
              : detailEnrichmentSummary.pending > 0
                ? batch.batchStatus === "ready"
                  ? { tone: "blue" as const, label: `待补齐 ${detailEnrichmentSummary.pending} 条` }
                  : { tone: "amber" as const, label: "批次暂不可执行" }
                : detailEnrichmentSummary.partial > 0
                  ? { tone: "amber" as const, label: "含部分完成项" }
                  : detailEnrichmentSummary.total > 0
                    ? { tone: "emerald" as const, label: "详情已完整补齐" }
                    : { tone: "slate" as const, label: "暂无可处理商品" };

            // 画廊检索与既有状态筛选（语义不变；检索额外支持中文类目辅助词）。
            const batchStatusFilter = (batchStatusFilterMap[batch.id] || "all") as GalleryStatusFilter;
            const batchSort = batchSortMap[batch.id] || "original";
            const filteredBatchItems = visibleBatchProducts;
            const galleryCounts: Record<GalleryStatusFilter, number> = {
              all: items.length,
              ready: items.filter((entry) => entry.usageStatus === "research_ready").length,
              review: items.filter((entry) => entry.usageStatus === "needs_review").length,
              blocked: items.filter((entry) => entry.usageStatus === "blocked").length,
            };
            const galleryLoading = Boolean(itemsLoading) && !batchItemsLoaded;

            const completeness = summarizeCaptureCompleteness(items);
            const moduleCoverageSummary = summarizeSourceModuleCoverage(items);
            const coverageTotals = summarizeModuleCoverageTotals(moduleCoverageSummary);

            const expandedItem = expandedItemId ? items.find((entry) => entry.id === expandedItemId) ?? null : null;
            const expandedDetailEvidence = expandedItem?.moduleCoverage?.find((entry) => entry.module === "amazon_detail");
            const expandedDetailStatus = expandedItem
              ? describeAmazonDetailBatchStatus({
                  currentBatchStatus: expandedItem.enrichmentStatus,
                  captureOrigin: expandedItem.enrichmentCaptureOrigin,
                  hasUnlinkedDetailEvidence: Boolean(expandedDetailEvidence?.evidenceId),
                  evidenceCapturedAt: expandedDetailEvidence?.capturedAt,
                  batchCreatedAt: batch.createdAt,
                })
              : null;

            // T02 同屏检阅：上下件严格跟随当前搜索/筛选后的可见商品顺序。
            const reviewNav = resolveReviewNavigation(filteredBatchItems, expandedItem?.id ?? null);
            const reviewIndex = reviewNav.index;
            const reviewTotal = reviewNav.total;
            const reviewVisible = reviewNav.visible;
            const reviewShortcutsEnabled = !consoleOpen
              && !evidenceOpen
              && !moduleEvidenceViewer
              && !batchDetailConfirmTarget
              && !createScanModalOpen
              && !protectionWarning
              && !itemBulkConfirmOpen
              && !batchDeleteBlockedKind
              && !batchBulkConfirmOpen;
            const goPrevReview = () => {
              if (reviewNav.prevId) setExpandedItemId(reviewNav.prevId);
            };
            const goNextReview = () => {
              if (reviewNav.nextId) setExpandedItemId(reviewNav.nextId);
            };
            const clearReviewFilters = () => {
              setMatrixLocation(previous => previous ? { ...previous, token: Date.now() } : previous);
              setMatrixFilterMap(prev => ({ ...prev, [batch.id]: { ...(prev[batch.id] ?? DEFAULT_MATRIX_FILTER), issue: "all", module: "all" } }));
              setMatrixNotice("");
              setSelectedItemIds([]);
              setBatchSearchMap((prev) => ({ ...prev, [batch.id]: "" }));
              setBatchStatusFilterMap((prev) => ({ ...prev, [batch.id]: "all" }));
            };

            const matrixFilter = matrixFilterMap[batch.id] ?? DEFAULT_MATRIX_FILTER;
            const matrixSnapshot = captureRunSnapshots[batch.id];
            const matrixAllowed = matrixSnapshot?.state === "present" ? matrixSnapshot.run.allowedModules : null;
            const locateMatrixProduct = (itemId: string, module: string) => {
              const target = { itemId, module, token: Date.now() };
              setMatrixLocation(target);
              setReviewModuleFocus(target);
              setExpandedItemId(itemId);
            };
            const locateFromReview = (module: string) => {
              if (!expandedItem) return;
              setReviewModuleFocus(null);
              setMatrixOpenMap(prev => ({ ...prev, [batch.id]: true }));
              setMatrixFilterMap(prev => ({ ...prev, [batch.id]: { ...(prev[batch.id] ?? DEFAULT_MATRIX_FILTER), group: (MATRIX_GROUPS.supplementary as readonly string[]).includes(module) ? "supplementary" : "basic", module } }));
              setMatrixLocation({ itemId: expandedItem.id, module, token: Date.now() });
            };

            const sourceLabel = batch.sourceType ? BATCH_SOURCE_LABELS[batch.sourceType] ?? batch.sourceType : "来源未记录";
            const statusPill = hasMarketScan
              ? { label: "已建立市场研究", tone: "ok" as const }
              : isEmptyBatch
                ? { label: "空批次（无商品记录）", tone: "off" as const }
                : { label: "研究资格待预检", tone: "warn" as const };
            const qualityPill = batch.qualityPresentation
              ? {
                  label: batch.qualityPresentation.text,
                  tone: (batch.qualityPresentation.tone === "emerald"
                    ? "ok"
                    : batch.qualityPresentation.tone === "amber" || batch.qualityPresentation.tone === "rose"
                      ? "warn"
                      : "off") as "ok" | "warn" | "off",
                }
              : null;
            const thresholdText = hasMarketScan
              ? "样本已用于市场研究"
              : isEmptyBatch
                ? "无有效样本"
                : "研究资格待预检";
            const primaryAction = hasMarketScan
              ? { label: "查看市场研究 →", testId: "view-market-scan-button", href: `/market-analysis/${batch.marketScan?.id}` }
              : isEmptyBatch
                ? { label: "归档批次", testId: "noise-batch-archive-button", onClick: () => handleArchiveBatch(batch), busy: batchActionBusy, busyLabel: "正在归档…" }
                : { label: isSampleSufficient ? "建立市场研究 →" : "检查研究资格 →", testId: "create-market-scan-button", onClick: () => handleOpenCreateScan(batch) };
            const gateAction = undefined;

            const menuItems: HeaderMenuAction[] = [
              {
                key: "amazon-search-recollect",
                label: "重采原搜索词",
                testId: "batch-amazon-search-recollect-button",
                icon: <RefreshCw size={13} aria-hidden="true" />,
                hidden: batch.sourceType !== "amazon_search_capture",
                disabled: batch.batchStatus !== "ready",
                disabledReason: "当前批次状态不可执行采集",
                busy: Boolean(moduleBatchBusy[`${batch.id}:amazon_search_market`]),
                busyLabel: "正在重采搜索…",
                onSelect: () => handleRunBatchModule(batch, "amazon_search_market"),
              },
              {
                key: "review-enrich",
                label: "补齐评论/买家声音",
                testId: "batch-review-voc-enrich-button",
                icon: <MessagesSquare size={13} aria-hidden="true" />,
                hidden: batch.itemCount <= 0,
                disabled: batch.batchStatus !== "ready",
                disabledReason: "当前批次状态不可执行采集",
                busy: Boolean(reviewBatchBusy[batch.id]),
                busyLabel: "评论/买家声音采集中…",
                onSelect: () => handleEnrichBatchReview(batch),
              },
              {
                key: "variation-enrich",
                label: "补齐父子变体",
                testId: "batch-variation-enrich-button",
                icon: <Layers size={13} aria-hidden="true" />,
                hidden: batch.itemCount <= 0,
                disabled: batch.batchStatus !== "ready",
                disabledReason: "当前批次状态不可执行采集",
                busy: Boolean(variationEnrichBusy[batch.id]),
                busyLabel: "正在补齐变体…",
                onSelect: () => handleEnrichBatchVariations(batch),
              },
              {
                key: "detail-history",
                label: detailHistoryOpen ? "收起详情补齐记录" : "详情补齐记录",
                testId: "open-detail-history",
                icon: <History size={13} aria-hidden="true" />,
                hidden: !(batch.sourceType === "amazon_search_capture" && hasCaptureRunEvidence(captureRunSnapshots[batch.id])),
                onSelect: () => setDetailHistoryOpen((prev) => !prev),
              },
              {
                key: "delete-batch",
                label: "删除批次",
                testId: "batch-delete-button",
                icon: <Trash2 size={13} aria-hidden="true" />,
                tone: "danger",
                separatorBefore: true,
                hidden: !isEmptyBatch,
                disabled: batchActionBusy,
                disabledReason: "批次操作进行中",
                onSelect: () => handleDeleteBatch(batch),
              },
            ];

            const bulkNoticeNode = itemBulkNotice ? (
              <div
                role={itemBulkNotice.tone === "error" ? "alert" : "status"}
                data-testid="source-item-bulk-result"
                className={bwStyles.notice}
                data-tone={itemBulkNotice.tone === "error" ? "error" : "success"}
              >
                <AlertCircle size={14} aria-hidden="true" />
                <div>
                  <p style={{ margin: 0 }}>{itemBulkNotice.message}</p>
                  {itemBulkNotice.failures?.length ? (
                    <details style={{ marginTop: 6 }} data-testid="source-item-bulk-failures">
                      <summary style={{ cursor: "pointer", fontWeight: 650 }}>查看逐项失败原因（{itemBulkNotice.failures.length}）</summary>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                        {itemBulkNotice.failures.map((failure) => (
                          <li key={failure.id}>{failure.label}：{failure.reason}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </div>
            ) : null;

            return (
              <div
                key={batch.id}
                data-testid="capture-batch-card"
                data-batch-id={batch.id}
                className={bwStyles.shell}
              >
                <BatchWorkspaceHeader
                  batchName={batch.batchName || "未命名批次"}
                  createdAt={batch.createdAt}
                  marketplace={batch.marketplace ?? null}
                  sourceLabel={sourceLabel}
                  archivedAt={batch.archivedAt}
                  statusPill={statusPill}
                  qualityPill={qualityPill}
                  rawCount={rawCount}
                  validSampleCount={validSampleCount}
                  thresholdText={thresholdText}
                  thresholdTone={isSampleSufficient || hasMarketScan ? "ok" : "warn"}
                  unverifiedCount={unverifiedCount}
                  primaryAction={primaryAction}
                  gateAction={gateAction}
                  onOpenConsole={() => setConsoleOpen(true)}
                  onOpenEvidence={() => setEvidenceOpen(true)}
                  menuItems={menuItems}
                />

                {batch.sourceType === "amazon_search_capture" ? (
                  <BatchCaptureRunSummary
                    snapshot={captureRunSnapshots[batch.id] ?? { state: "unknown" }}
                    onOpenConsole={() => setConsoleOpen(true)}
                    onReload={() => setCaptureRunRefreshTokens((prev) => ({
                      ...prev,
                      [batch.id]: (prev[batch.id] ?? 0) + 1,
                    }))}
                  />
                ) : null}

                {moduleBatchNotice[`${batch.id}:amazon_search_market`] ? (
                  <div
                    className={bwStyles.notice}
                    data-tone={moduleBatchNotice[`${batch.id}:amazon_search_market`]!.tone === "error" ? "error" : moduleBatchNotice[`${batch.id}:amazon_search_market`]!.tone === "success" ? "success" : undefined}
                    role={moduleBatchNotice[`${batch.id}:amazon_search_market`]!.tone === "error" ? "alert" : "status"}
                    data-testid="batch-amazon-search-recollect-result"
                  >
                    <AlertCircle size={14} aria-hidden="true" />
                    <span>{moduleBatchNotice[`${batch.id}:amazon_search_market`]!.message}</span>
                  </div>
                ) : null}
                {reviewBatchNotice[batch.id] ? (
                  <div
                    className={bwStyles.notice}
                    data-tone={reviewBatchNotice[batch.id]!.tone === "error" ? "error" : reviewBatchNotice[batch.id]!.tone === "success" ? "success" : undefined}
                    role={reviewBatchNotice[batch.id]!.tone === "error" ? "alert" : "status"}
                    data-testid="batch-review-voc-enrich-result"
                  >
                    <AlertCircle size={14} aria-hidden="true" />
                    <span>{reviewBatchNotice[batch.id]!.message}</span>
                  </div>
                ) : null}
                {variationEnrichNotice[batch.id] ? (
                  <div
                    className={bwStyles.notice}
                    data-tone={variationEnrichNotice[batch.id]!.tone === "error" ? "error" : "success"}
                    role={variationEnrichNotice[batch.id]!.tone === "error" ? "alert" : "status"}
                    data-testid="batch-variation-enrich-result"
                  >
                    <AlertCircle size={14} aria-hidden="true" />
                    <span>{variationEnrichNotice[batch.id]!.message}</span>
                  </div>
                ) : null}
                {unverifiedCount > 0 ? (
                  <div className={bwStyles.notice} data-testid="source-batch-reconciliation">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>该批次存在 {unverifiedCount} 条记录待核对，可在画廊中按「待核对」筛选确认可用状态。</span>
                  </div>
                ) : null}

                {batchItemsErrorMap[batch.id] ? (
                  <div className={bwStyles.notice} data-tone="error" role="alert" data-testid="batch-items-load-error">
                    <AlertCircle size={14} aria-hidden="true" />
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                      <span>商品列表读取失败：{batchItemsErrorMap[batch.id]}</span>
                      <button type="button" className={bwStyles.textBtn} onClick={() => { void fetchBatchItems(batch.id); }}>
                        重新读取
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className={bwStyles.infoRow}>
                  <details className={bwStyles.infoDetails} data-testid="capture-completeness-strip">
                    <summary>
                      采集完整度
                      <b>详情 {completeness.detailEnriched + completeness.detailPartial}/{completeness.total}</b>
                      <span>· 品牌 {completeness.brandHit}/{completeness.total}</span>
                      <span>· BSR {completeness.bsrHit}/{completeness.total}</span>
                      {completeness.detailPartial > 0 ? <span>（部分 {completeness.detailPartial}）</span> : null}
                    </summary>
                    <div className={bwStyles.infoPanel}>
                      {moduleCoverageSummary.length ? (
                        <details data-testid="batch-module-coverage-summary">
                          <summary style={{ cursor: "pointer", fontWeight: 650 }}>
                            模块执行与证据覆盖：执行 {coverageTotals.executedModules}/{coverageTotals.moduleCount} 项 · 有证据 {coverageTotals.evidenceCells}/{coverageTotals.totalCells} 单元 · 仅回执 {coverageTotals.receiptOnlyCells} 单元
                          </summary>
                          <p style={{ margin: "6px 0 0" }}>
                            执行 ≠ 取得数据：只有「有证据记录」的模块持有证据库附件；「仅回执 / 外部条件」只代表系统已尝试，本机未取得可用数据。
                          </p>
                          <div className={bwStyles.moduleGrid}>
                            {moduleCoverageSummary.map((entry) => (
                              <div key={entry.module} className={bwStyles.moduleCell} data-testid={`batch-module-summary-${entry.module}`}>
                                <b>{entry.label}</b>
                                <p style={{ margin: "3px 0 0" }}>执行记录 {entry.executedCount}/{entry.itemCount} · 有证据 {entry.evidenceCount} · 仅回执 {entry.receiptOnlyCount}</p>
                                <p style={{ margin: "2px 0 0" }}>
                                  已完成 {entry.completeCount} · 部分完成 {entry.partialCount} · 受阻 {entry.blockedCount} · 无数据 {entry.noDataCount} · 受限 {entry.limitedCount} · 需人工 {entry.humanActionCount} · 未执行 {entry.notCollectedCount}
                                </p>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : (
                        <p style={{ margin: 0 }}>尚未读取到模块覆盖信息。</p>
                      )}
                    </div>
                  </details>

                  <details className={bwStyles.infoDetails} data-testid="basic-material-details">
                    <summary>四项基础资料取得情况</summary>
                    <div className={bwStyles.infoPanel}>
                      <FourBasicCapabilitiesStrip items={items} sourceType={batch.sourceType} />
                    </div>
                  </details>

                  <span className={bwStyles.infoHint}>状态来自采集记录，缺失字段不做推断</span>
                </div>

                {consoleOpen && batch.sourceType === "amazon_search_capture" ? (
                  <CaptureTaskWorkspace
                    batchId={batch.id}
                    batchName={batch.batchName || "未命名批次"}
                    marketplace={batch.marketplace ?? null}
                    sourceLabel={sourceLabel}
                    batchCapacity={items.filter((entry) => !entry.archivedAt && entry.asin).length}
                    moduleCoverage={moduleCoverageSummary}
                    sampleGate={{
                      sufficient: isSampleSufficient,
                      current: validSampleCount,
                      required: minimumRequired,
                    }}
                    deepResearchItems={Object.prototype.hasOwnProperty.call(batchItemsMap, batch.id)
                      ? {
                          ready: items.filter((entry) => entry.usageStatus === "research_ready").length,
                          total: items.length,
                        }
                      : null}
                    legacyJob={detailJobView?.job
                      ? {
                          status: detailJobView.job.status,
                          total: detailJobView.progress.total,
                          processed: detailJobView.progress.processed,
                        }
                      : null}
                    existingRunStatus={hasCaptureRunEvidence(captureRunSnapshots[batch.id]) ? "已创建" : null}
                    refreshToken={captureRunRefreshTokens[batch.id] ?? 0}
                    onClose={() => setConsoleOpen(false)}
                    onOpenSingleAsin={() => {
                      setConsoleOpen(false);
                      openAmazonCapture("detail");
                    }}
                    onCreateMarketScan={!hasMarketScan ? () => {
                      setConsoleOpen(false);
                      handleOpenCreateScan(batch);
                    } : undefined}
                    onConfirmed={(result) => {
                      // 刚创建：先进入「已创建、快照待回读」，绝不写成 absent/false。
                      recordCaptureRunSnapshot(batch.id, {
                        state: "created",
                        runStatus: result.runStatus ?? null,
                        at: Date.now(),
                      });
                      setCaptureRunRefreshTokens((prev) => ({
                        ...prev,
                        [batch.id]: (prev[batch.id] ?? 0) + 1,
                      }));
                    }}
                    onSnapshot={(snapshot) => recordCaptureRunSnapshot(batch.id, snapshot)}
                    onExpansionComplete={async () => {
                      await fetchBatchItems(batch.id, true);
                      setCaptureRunRefreshTokens((prev) => ({
                        ...prev,
                        [batch.id]: (prev[batch.id] ?? 0) + 1,
                      }));
                    }}
                  />
                ) : null}

                {consoleOpen ? (
                  <Drawer
                    isOpen={consoleOpen && batch.sourceType !== "amazon_search_capture"}
                    onClose={() => setConsoleOpen(false)}
                    title={batch.batchName || "采集控制台"}
                    description={`采集控制台 · ${sourceLabel}${batch.marketplace ? ` · ${batch.marketplace} 站` : ""}`}
                    width="3xl"
                  >
                    <>
                      
                      {batch.sourceType !== "amazon_search_capture" ? (
                        <section
                          aria-labelledby={`amazon-detail-enrichment-title-${batch.id}`}
                          data-testid="amazon-detail-enrichment-card"
                          className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3 sm:p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 id={`amazon-detail-enrichment-title-${batch.id}`} className="text-sm font-semibold text-slate-900">
                                  数据补齐 / Evidence Enrichment
                                </h4>
                                <Badge tone={detailEnrichmentBadge.tone}>{detailEnrichmentBadge.label}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-slate-600">
                                进度来自当前批次商品记录；页面不会在后台自动采集。
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="重新读取 Amazon 商品详情补齐状态"
                                data-testid="refresh-amazon-detail-enrichment-status"
                                onClick={() => { void fetchBatchItems(batch.id); }}
                                disabled={itemsLoading || detailEnrichmentBusy}
                              >
                                {itemsLoading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                                重新读取状态
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                data-testid="amazon-detail-enrichment-continue"
                                onClick={() => setBatchDetailConfirmTarget(batch)}
                                disabled={!detailEnrichmentCanContinue}
                                title={batchItemsErrorMap[batch.id]
                                  ? "最近一次读取失败；请重新读取商品状态后再操作。"
                                  : detailEnrichmentSummary.disabledReason ?? undefined}
                              >
                                {detailEnrichmentBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                                {detailEnrichmentBusy ? "正在补齐详情…" : "继续详情补齐"}
                              </Button>
                            </div>
                          </div>

                          {itemsLoading && !batchItemsLoaded ? (
                            <p role="status" className="text-xs text-slate-600">正在读取商品详情补齐状态…</p>
                          ) : batchItemsErrorMap[batch.id] ? (
                            <p role="alert" data-testid="amazon-detail-enrichment-load-error" className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-800">
                              {batchItemsErrorMap[batch.id]} 请点击“重新读取状态”后再判断是否可以继续。
                            </p>
                          ) : !batchItemsLoaded ? (
                            <p role="status" className="text-xs text-slate-600">尚未读取商品状态；请重新读取后查看进度。</p>
                          ) : (
                            <>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                <div className="rounded-lg border border-white/80 bg-white/80 p-2.5">
                                  <p className="text-[13px] text-slate-500">完整补齐</p>
                                  <p className="mt-0.5 text-base font-semibold text-emerald-700">{detailEnrichmentSummary.complete} / {detailEnrichmentSummary.total}</p>
                                </div>
                                <div className="rounded-lg border border-white/80 bg-white/80 p-2.5">
                                  <p className="text-[13px] text-slate-500">部分详情已保存</p>
                                  <p className="mt-0.5 text-base font-semibold text-amber-700">{detailEnrichmentSummary.partial}</p>
                                </div>
                                <div className="rounded-lg border border-white/80 bg-white/80 p-2.5">
                                  <p className="text-[13px] text-slate-500">尚未补齐</p>
                                  <p className="mt-0.5 text-base font-semibold text-slate-800">{detailEnrichmentSummary.pending}</p>
                                </div>
                                <div className="rounded-lg border border-white/80 bg-white/80 p-2.5">
                                  <p className="text-[13px] text-slate-500">已有详情证据</p>
                                  <p className="mt-0.5 text-base font-semibold text-sky-700">{detailEnrichmentSummary.evidenceBacked}</p>
                                </div>
                              </div>
                              <div>
                                <div
                                  role="progressbar"
                                  aria-label="完整商品详情补齐进度"
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={detailEnrichmentSummary.completePercent}
                                  className="h-2 overflow-hidden rounded-full bg-white"
                                >
                                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${detailEnrichmentSummary.completePercent}%` }} />
                                </div>
                                <p className="mt-1 text-[13px] text-slate-600">
                                  完整补齐进度 {detailEnrichmentSummary.completePercent}%（部分结果单独计数，不算完整）。
                                </p>
                              </div>
                              {detailEnrichmentSummary.disabledReason ? (
                                <p role="note" data-testid="amazon-detail-enrichment-disabled-reason" className="text-xs text-slate-600">
                                  {detailEnrichmentSummary.disabledReason}
                                </p>
                              ) : detailEnrichmentSummary.partial > 0 ? (
                                <p role="note" className="text-xs text-amber-800">
                                  本次操作只补齐尚未补齐的商品；已有部分详情不会在此入口自动重采。
                                </p>
                              ) : null}
                            </>
                          )}

                          {batchDetailNotice[batch.id] ? (
                            <p
                              role={batchDetailNotice[batch.id]!.tone === "error" ? "alert" : "status"}
                              data-testid="amazon-detail-enrichment-result"
                              className={`rounded-lg border p-2.5 text-xs ${batchDetailNotice[batch.id]!.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : batchDetailNotice[batch.id]!.tone === "info" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}
                            >
                              {batchDetailNotice[batch.id]!.message}
                            </p>
                          ) : null}
                        </section>
                      ) : null}
                    </>
                  </Drawer>
                ) : null}

                {evidenceOpen ? (
                  <Drawer
                    isOpen
                    onClose={() => { closeModuleEvidence(); setEvidenceOpen(false); }}
                    title={moduleEvidenceViewer ? "资料证据" : "资料与来源"}
                    width="3xl"
                  >
                    {moduleEvidenceViewer ? (
                      <div>
                        <button type="button" className="mb-5 text-[14px] font-medium text-emerald-800 hover:underline" onClick={closeModuleEvidence}>← 返回资料与来源</button>
                        <ModuleEvidenceDetail
                          item={moduleEvidenceViewer.item}
                          module={moduleEvidenceViewer.module}
                          coverage={moduleEvidenceViewer.coverage}
                          data={moduleEvidenceViewer.data}
                          loading={moduleEvidenceViewer.loading}
                          error={moduleEvidenceViewer.error}
                          onRetry={() => { const viewer = moduleEvidenceViewer; if (viewer) void handleViewModuleEvidence(viewer.batch, viewer.item, viewer.module); }}
                        />
                      </div>
                    ) : <SourceProvenancePanel
                      batch={{
                        id: batch.id,
                        batchName: batch.batchName,
                        batchStatus: batch.batchStatus,
                        sourceType: batch.sourceType,
                        marketplace: batch.marketplace,
                        createdAt: batch.createdAt,
                        itemCount: batch.itemCount,
                        acceptedCount: batch.acceptedCount,
                        validSampleCount,
                        validSetSufficient: isSampleSufficient,
                        marketScan: batch.marketScan,
                      }}
                      sourceLabel={sourceLabel}
                      items={items}
                      captureRunSnapshot={captureRunSnapshots[batch.id] ?? null}
                      detailJobView={detailJobView ?? null}
                      onViewModuleEvidence={(module, item) => {
                        void handleViewModuleEvidence(batch, item as SourceItemDTO, module as SourceModuleId);
                      }}
                    />}
                  </Drawer>
                ) : null}

                {detailHistoryOpen ? (
                  <div className="mt-3 space-y-3">
                    {batch.sourceType === "amazon_search_capture" && hasCaptureRunEvidence(captureRunSnapshots[batch.id]) ? (
                      <details
                        data-testid="amazon-detail-job-history"
                        className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"
                      >
                        <summary className="cursor-pointer font-medium text-slate-700">
                          历史记录：旧详情补齐任务（只读，不会被自动领取）
                        </summary>
                        <p className="mt-2">
                          {detailJobView
                            ? `历史任务状态 ${detailJobView.job ? BATCH_DETAIL_JOB_STATUS_LABELS[detailJobView.job.status] : "尚未排队"} · 已处理 ${detailJobView.progress.processed}/${detailJobView.progress.total}。`
                            : "暂无历史任务记录。"}
                          该记录仅用于追溯历史批次，不是本批次主进度，也不会被自动领取。
                        </p>
                      </details>
                    ) : null}
                    {batch.sourceType === "amazon_search_capture" && !hasCaptureRunEvidence(captureRunSnapshots[batch.id]) ? (
                      <section data-testid="amazon-detail-job-panel" className="space-y-2 rounded-xl border border-sky-200 bg-sky-50/70 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="text-sm font-semibold text-slate-800">详情补齐 / Detail Enrichment</h4>
                              <Badge tone={
                                detailJobStatus === "COMPLETED" ? "emerald"
                                  : detailJobStatus === "RUNNING" || detailJobStatus === "PENDING" ? "blue"
                                    : detailJobStatus === "PAUSED" || detailJobStatus === "FAILED" ? "amber"
                                      : "slate"
                              }>
                                {detailJobView
                                  ? detailJobView.job
                                    ? detailJobView.executionMode === "manual_only" && detailJobView.job.status === "PENDING"
                                      ? "等待手动执行" : BATCH_DETAIL_JOB_STATUS_LABELS[detailJobView.job.status]
                                    : "尚未排队"
                                  : "读取中"}
                              </Badge>
                            </div>
                            {detailJobProgress ? (
                              <>
                                <p className="mt-1 text-xs text-slate-600" data-testid="amazon-detail-job-progress">
                                  已处理 {detailJobProgress.processed}/{detailJobProgress.total} · 已补齐 {detailJobProgress.enriched} · 部分完成 {detailJobProgress.partial}
                                </p>
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-slate-600">
                                  <span>待处理 {detailJobProgress.pending}</span>
                                  <span>运行中 {detailJobProgress.running}</span>
                                  <span>可重试失败 {detailJobProgress.failedRetryable}</span>
                                  <span>失败终止 {detailJobProgress.failedPermanent}</span>
                                  <span>需人工 {detailJobProgress.humanRequired}</span>
                                  <span>复用有效证据 {detailJobProgress.reusedEvidence}</span>
                                  <span>本次新采集 {detailJobProgress.newlyCaptured}</span>
                                </div>
                                {detailJobView?.job?.lastErrorCode ? (
                                  <p className="mt-1 text-[13px] text-amber-800">
                                    最近阻塞代码：{detailJobView.job.lastErrorCode}
                                  </p>
                                ) : null}
                              </>
                            ) : (
                              <p className="mt-1 text-xs text-slate-500">正在读取商品批次和持久任务进度。</p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {detailJobView?.executionMode === "manual_only" && detailJobStatus === "PENDING" ? (
                              <Button variant="primary" size="sm" data-testid="amazon-detail-job-run-one"
                                onClick={() => handleBatchDetailJobAction(batch, "run-one")}
                                disabled={batchDetailJobBusy[batch.id] || !detailJobView.acquisitionEnabled || batch.batchStatus !== "ready"}>
                                {batchDetailJobBusy[batch.id] ? "正在补齐1件…" : "手动补齐1件"}
                              </Button>
                            ) : null}
                            {detailJobAction ? (
                              <Button
                                variant="primary"
                                size="sm"
                                data-testid="amazon-detail-job-resume-button"
                                onClick={() => handleBatchDetailJobAction(batch, detailJobAction)}
                                disabled={batchDetailJobBusy[batch.id] || batch.batchStatus !== "ready"}
                              >
                                {batchDetailJobBusy[batch.id] ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                                {batchDetailJobBusy[batch.id]
                                  ? "正在提交…"
                                  : detailJobAction === "ensure"
                                    ? "继续详情补齐"
                                    : detailJobStatus === "PAUSED" && ["CAPTCHA_DETECTED", "LOGIN_REQUIRED", "HUMAN_ACTION_REQUIRED"].includes(detailJobView?.job?.lastErrorCode ?? "")
                                      ? "人工处理后继续"
                                      : detailJobStatus === "FAILED"
                                        ? "重试失败商品"
                                        : "继续详情补齐"}
                              </Button>
                            ) : null}
                            {detailJobView?.scheduled && (detailJobStatus === "PENDING" || detailJobStatus === "RUNNING") ? (
                              <Button
                                variant="outline"
                                size="sm"
                                data-testid="amazon-detail-job-pause-button"
                                onClick={() => handleBatchDetailJobAction(batch, "pause")}
                                disabled={batchDetailJobBusy[batch.id]}
                              >
                                暂停
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label="重新读取 Amazon 详情补齐状态"
                              onClick={() => { void fetchBatchDetailJob(batch.id); }}
                              disabled={batchDetailJobBusy[batch.id]}
                            >
                              <RefreshCw className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        {batchDetailJobErrorMap[batch.id] ? (
                          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
                            {batchDetailJobErrorMap[batch.id]}
                          </p>
                        ) : null}
                        {detailJobView?.executionMode === "manual_only" ? (
                          <p data-testid="detail-manual-mode" className="text-xs text-slate-600">
                            后台自动采集未开启。每次“手动补齐1件”只处理本批次一个商品，不会运行其他排队任务。
                            {detailJobView.acquisitionEnabled ? "" : " Amazon 主动采集尚未开启，请先处理采集环境提示。"}
                          </p>
                        ) : null}
                        {isSampleSufficient && detailBatchIncomplete ? (
                          <p data-testid="market-sample-detail-warning" className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
                            市场样本数量已达研究门槛，但商品详情仍在补齐，部分字段尚不可用。
                          </p>
                        ) : null}
                      </section>
                    ) : null}
                  </div>
                ) : null}

                <div className={`${bwStyles.reviewLayout}${expandedItem ? ` ${bwStyles.reviewLayoutOpen}` : ""}`}>
                <ProductGallery
                  key={batch.id}
                  matrixOpen={Boolean(matrixOpenMap[batch.id])}
                  onMatrixOpenChange={value => setMatrixOpenMap(prev => ({ ...prev, [batch.id]: value }))}
                  browseView={browseViewMap[batch.id] ?? "gallery"}
                  onBrowseViewChange={value => setBrowseViewMap(prev => ({ ...prev, [batch.id]: value }))}
                  tablePage={browsePageMap[batch.id] ?? 0}
                  onTablePageChange={page => setBrowsePageMap(prev => prev[batch.id] === page ? prev : ({ ...prev, [batch.id]: page }))}
                  matrixFilterLabel={matrixFilter.issue === "all" ? "" : `${matrixFilter.module === "all" ? "全部资料" : PROVENANCE_MODULE_LABELS[matrixFilter.module] ?? matrixFilter.module} · ${MATRIX_ISSUES.find(issue => issue.value === matrixFilter.issue)?.label ?? "资料问题"}`}
                  matrixNotice={matrixNotice}
                  onClearMatrixFilter={() => { setMatrixFilterMap(prev => ({ ...prev, [batch.id]: { ...matrixFilter, issue: "all" } })); setSelectedItemIds([]); setMatrixNotice(""); }}
                  matrixNode={<ProductMaterialMatrix
                    active={Boolean(matrixOpenMap[batch.id])} batchId={batch.id} allItems={items} baseItems={baseVisibleBatchProducts} items={filteredBatchItems}
                    allowedModules={matrixAllowed} filter={matrixFilter} location={matrixLocation}
                    loaded={batchItemsLoaded} loading={galleryLoading} loadError={batchItemsErrorMap[batch.id] ?? null}
                    onFilter={value => { if (selectedItemIds.length) setMatrixNotice(`资料筛选已变更，已清除之前的 ${selectedItemIds.length} 项选择。`); setSelectedItemIds([]); setMatrixFilterMap(prev => ({ ...prev, [batch.id]: value })); }}
                    onLocate={(item, module) => locateMatrixProduct(item.id, module)}
                    onEvidence={(item, module) => { void handleViewModuleEvidence(batch, item as SourceItemDTO, module as SourceModuleId); }}
                    onSources={() => setEvidenceOpen(true)} onRun={() => setConsoleOpen(true)}
                    onReveal={clearReviewFilters} onReloadItems={() => { void fetchBatchItems(batch.id, true); }}
                  />}
                  sort={batchSort}
                  onSortChange={(value) => { setBrowsePageMap(prev => ({ ...prev, [batch.id]: 0 })); setBatchSortMap(prev => ({ ...prev, [batch.id]: value })); }}
                  items={items}
                  filteredItems={filteredBatchItems}
                  search={batchSearchMap[batch.id] || ""}
                  onSearchChange={(value) => {
                    setSelectedItemIds([]);
                    setBrowsePageMap(prev => ({ ...prev, [batch.id]: 0 }));
                    setBatchSearchMap((prev) => ({ ...prev, [batch.id]: value }));
                  }}
                  statusFilter={batchStatusFilter}
                  onStatusFilterChange={(value) => {
                    setSelectedItemIds([]);
                    setBrowsePageMap(prev => ({ ...prev, [batch.id]: 0 }));
                    setBatchStatusFilterMap((prev) => ({ ...prev, [batch.id]: value }));
                  }}
                  counts={galleryCounts}
                  selectedIds={selectedItemIds}
                  onToggleSelect={(id) => {
                    setSelectedItemIds((current) => current.includes(id)
                      ? current.filter((entry) => entry !== id)
                      : [...current, id]);
                  }}
                  onSelectAllFiltered={(checked) => {
                    const selected = new Set(selectedItemIds);
                    for (const item of filteredBatchItems) {
                      if (checked) selected.add(item.id);
                      else selected.delete(item.id);
                    }
                    setSelectedItemIds(Array.from(selected));
                  }}
                  onClearSelection={() => setSelectedItemIds([])}
                  expandedItemId={expandedItemId}
                  onOpenDetail={openReviewItem}
                  onArchive={(item) => { void handleArchiveItem(item as SourceItemDTO); }}
                  onRestore={(item) => { void handleRestoreItem(item as SourceItemDTO); }}
                  onDelete={(item) => { void handleDeleteItem(item as SourceItemDTO); }}
                  busy={actionBusy}
                  loading={galleryLoading}
                  bulkBusy={itemBulkBusy}
                  onBulk={(action) => {
                    setItemBulkAction(action);
                    setItemBulkConfirmOpen(true);
                  }}
                  bulkNoticeNode={bulkNoticeNode}
                  marketplace={batch.marketplace ?? "US"}
                  itemsLoaded={batchItemsLoaded}
                  loadError={batchItemsErrorMap[batch.id] ?? null}
                  onRetryLoad={() => { void fetchBatchItems(batch.id); }}
                />

                {expandedItem && expandedDetailStatus ? (
                  <ProductDetailPanel
                    item={expandedItem}
                    moduleFocus={reviewModuleFocus?.itemId === expandedItem.id ? reviewModuleFocus : null}
                    onLocateMatrix={locateFromReview}
                    marketplace={batch.marketplace ?? "US"}
                    sourceLabel={sourceLabel}
                    batchStatus={batch.batchStatus ?? null}
                    detailBatchStatus={expandedDetailStatus}
                    moduleCoverage={expandedItem.moduleCoverage}
                    moduleRecollectBusy={(module) => Boolean(moduleRecollectBusy[`${batch.id}:${expandedItem.id}:${module}`])}
                    moduleActionNotice={(module) => moduleActionNotice[`${batch.id}:${expandedItem.id}:${module}`]}
                    onViewModuleEvidence={(module) => { void handleViewModuleEvidence(batch, expandedItem, module as SourceModuleId); }}
                    onRecollect={(module) => { void handleRecollectModule(batch, expandedItem, module as SourceModuleId); }}
                    onClose={closeReview}
                    reviewIndex={reviewIndex}
                    reviewTotal={reviewTotal}
                    onPrev={goPrevReview}
                    onNext={goNextReview}
                    isVisibleInFilter={reviewVisible}
                    onClearFilters={clearReviewFilters}
                    onArchive={() => { void handleArchiveItem(expandedItem as SourceItemDTO); }}
                    onRestore={() => { void handleRestoreItem(expandedItem as SourceItemDTO); }}
                    onDelete={() => { void handleDeleteItem(expandedItem as SourceItemDTO); }}
                    itemBusy={actionBusy}
                    shortcutsEnabled={reviewShortcutsEnabled}
                  />
                ) : null}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* ── Zone 3 · 批次列表：精致表格，保留全部状态与入口 ── */}
      <section id="batch-list-section" aria-label="批次列表" data-testid="capture-batches-section" className={`${sourceStyles.panel} scroll-mt-4`}>
        <div className={sourceStyles.panelHead}>
          <div>
            <h2 className={sourceStyles.panelTitle}>批次列表</h2>
            <p className={sourceStyles.panelSub}>点击任意批次进入工作区：先看商品结果与当前缺口，再处理采集任务。</p>
          </div>
          <span className={sourceStyles.panelMeta}>共 {batches.length} 个批次</span>
        </div>

        {loading ? (
          <div className="space-y-3" style={{ padding: "0 20px 20px" }}>
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : batches.length === 0 ? (
          <div style={{ padding: "0 20px 20px" }}>
            <EmptyState
              icon={<Database className="size-8 text-slate-400" />}
              title="暂无采集批次"
              description="当前数据源中还没有采集批次。点击「开始采集」录入一批商品，系统会自动整理为一个采集批次，用于后续市场研究。"
              actionText="商品事实（输入 ASIN）"
              onAction={() => openAmazonCapture("detail")}
              secondaryActionText="关键词市场（输入关键词）"
              onSecondaryAction={() => openAmazonCapture("search")}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <p className="text-[13px] text-slate-500">类目市场采集会生成独立的 SellerSprite 类目机会批次。</p>
              <Button variant="outline" size="sm" onClick={() => setCategoryMarketCaptureOpen(true)} data-testid="empty-state-category-market-capture-button">
                类目市场（选择 Amazon 类目）
              </Button>
            </div>
          </div>
        ) : (
          <div className={sourceStyles.tableWrap}>
            <table className={sourceStyles.table}>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>状态</th>
                  <th className={sourceStyles.num}>商品</th>
                  <th className={sourceStyles.num}>有效样本</th>
                  <th>市场研究</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch, index) => {
                  const rawCount = batch.rawCount ?? batch.itemCount;
                  const validSampleCount = batch.validSampleCount ?? batch.acceptedCount;
                  const samplePolicy = batch.validProductSet ?? null;
                  const isSampleSufficient = samplePolicy ? samplePolicy.isSufficient : validSampleCount >= minimumRequired;
                  const hasMarketScan = !!batch.marketScan;
                  const isEmptyBatch = !hasMarketScan && !rawCount;
                  const isSelected = expandedBatchId === batch.id;
                  return (
                    <tr
                      key={batch.id}
                      data-testid="capture-batch-row"
                      data-batch-id={batch.id}
                      data-selected={isSelected ? "true" : undefined}
                      onClick={() => toggleExpandBatch(batch.id)}
                    >
                      <td>
                        {index === 0 && <span data-testid="source-current-batch" className="sr-only" />}
                        <p className={sourceStyles.batchName}>{batch.batchName || "未命名批次"}</p>
                        <p className={sourceStyles.batchMeta}>
                          {new Date(batch.createdAt).toLocaleDateString("zh-CN")} · Amazon {batch.marketplace || "US"} · 来源：
                          {batch.sourceType ? BATCH_SOURCE_LABELS[batch.sourceType] ?? batch.sourceType : "未记录"} · ID {batch.id.slice(0, 8)}…
                        </p>
                      </td>
                      <td>
                        {hasMarketScan ? (
                          <span className={`${sourceStyles.statusPill} ${sourceStyles.statusScan}`} data-testid="batch-status-badge">已建立市场研究</span>
                        ) : isEmptyBatch ? (
                          <span className={`${sourceStyles.statusPill} ${sourceStyles.statusEmpty}`} data-testid="batch-status-badge">空批次</span>
                        ) : isSampleSufficient ? (
                          <span className={`${sourceStyles.statusPill} ${sourceStyles.statusReady}`} data-testid="batch-status-badge">可以建立市场研究</span>
                        ) : (
                          <span className={`${sourceStyles.statusPill} ${sourceStyles.statusWarn}`} data-testid="batch-status-badge">样本不足</span>
                        )}
                        {batch.qualityPresentation ? (
                          <div className="mt-1">
                            <Badge tone={batch.qualityPresentation.tone}>{batch.qualityPresentation.text}</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td className={sourceStyles.numCell}>
                        <span className={sourceStyles.numMain}>{rawCount ?? 0}</span>
                        <span className={sourceStyles.numSub}> 款</span>
                      </td>
                      <td className={sourceStyles.numCell}>
                        <span className={isSampleSufficient ? sourceStyles.validOk : sourceStyles.validWarn}>{validSampleCount}</span>
                        <span className={sourceStyles.numSub}> / {minimumRequired}</span>
                      </td>
                      <td>
                        {hasMarketScan ? (
                          <Link
                            href={`/market-analysis/${batch.marketScan?.id}`}
                            onClick={(event) => event.stopPropagation()}
                            className={sourceStyles.rowLink}
                          >
                            查看市场研究
                          </Link>
                        ) : isEmptyBatch ? (
                          <span className={sourceStyles.numSub}>—</span>
                        ) : isSampleSufficient ? (
                          <span className={sourceStyles.validOk} style={{ fontSize: 12.5 }}>可建立</span>
                        ) : (
                          <span className={sourceStyles.validWarn} style={{ fontSize: 12.5 }}>还差 {Math.max(0, minimumRequired - validSampleCount)} 款</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          data-testid="enter-batch-workspace-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpandBatch(batch.id);
                          }}
                          className={`${sourceStyles.rowAction}${isSelected ? ` ${sourceStyles.rowActionActive}` : ""}`}
                        >
                          {isSelected ? "工作区中" : "进入工作区 →"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </div>

      {/* 右上角抽屉：采集记录与批次管理（保留批次生命周期动作，不占用主页面空间） */}
      <Drawer
        isOpen={recordsDrawerOpen}
        onClose={() => setRecordsDrawerOpen(false)}
        title="采集记录与批次管理"
        width="2xl"
      >
        <section aria-label="来源批次生命周期管理" className="space-y-4 p-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-slate-500">
              管理所有历史采集批次。批次可归档、恢复或受控删除。若被下游业务（市场分析、候选池、研究任务）引用，系统将拦截物理删除并引导归档。
            </p>
            <PromoteEvidenceModal onPromoted={loadData} />
          </div>

          <div className="flex items-center justify-between text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 select-none">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="size-3.5 rounded border-slate-300 text-emerald-600"
              />
              <span>包含已归档批次</span>
            </label>
            <span className="text-slate-400">共 {batches.length} 个批次</span>
          </div>

          {batchNotice && (
            <div
              className={`rounded-xl border p-3 text-xs ${
                batchNotice.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : batchNotice.tone === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-900"
                  : "border-slate-200 bg-slate-50 text-slate-700"
              }`}
              role="status"
            >
              {batchNotice.message}
              {batchNotice.failures?.length ? (
                <details className="mt-2" data-testid="batch-bulk-failures">
                  <summary className="cursor-pointer font-semibold">查看逐项失败原因（{batchNotice.failures.length}）</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">{batchNotice.failures.map((failure) => <li key={failure.id}>{failure.label}：{failure.reason}</li>)}</ul>
                </details>
              ) : null}
            </div>
          )}

          {/* 批量操作条 */}
          {selectedBatches.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-white">
              <span className="text-xs font-medium">
                已选 <strong className="font-bold text-emerald-400">{selectedBatches.length}</strong> 个批次
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-600 bg-slate-800 text-xs text-slate-100 hover:bg-slate-700"
                  disabled={batchActionBusy}
                  onClick={() => {
                    setBatchBulkAction("archive");
                    setBatchBulkConfirmOpen(true);
                  }}
                >
                  <Archive className="mr-1 size-3.5" />
                  批量归档
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-600 bg-slate-800 text-xs text-slate-100 hover:bg-slate-700"
                  disabled={batchActionBusy}
                  onClick={() => {
                    setBatchBulkAction("restore");
                    setBatchBulkConfirmOpen(true);
                  }}
                >
                  <RefreshCw className="mr-1 size-3.5" />
                  批量恢复
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-slate-600 bg-slate-800 text-xs text-rose-300 hover:bg-rose-950/60"
                  disabled={batchActionBusy}
                  onClick={() => {
                    setBatchBulkAction("delete");
                    setBatchBulkConfirmOpen(true);
                  }}
                >
                  <Trash2 className="mr-1 size-3.5" />
                  批量删除
                </Button>
                <button
                  type="button"
                  onClick={() => setBatchSelection({})}
                  className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                  aria-label="取消批次选择"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="mt-2">
            <DataTable
              columns={drawerBatchColumns}
              data={batches}
              enableRowSelection={true}
              rowSelection={batchSelection}
              setRowSelection={setBatchSelection}
              getRowId={(row) => row.id}
              pageSize={8}
            />
          </div>
        </section>
      </Drawer>

      {/* 建立市场研究确认弹窗（使用整批有效商品直接建立；创建前消费最终权威样本预检） */}
      <Dialog
        isOpen={createScanModalOpen}
        onClose={closeCreateScan}
        title="建立市场研究"
      >
        <div className="space-y-4 py-1 text-slate-800">
          <p className="text-xs text-slate-600 leading-relaxed">
            使用整批经服务端确定的有效商品建立研究。当前勾选、筛选和正在检阅的商品不会改变研究样本。
          </p>

          {/* D0-004：来源数 / 初步有效 / 最终可冻结 / 门槛，四段口径同屏对账 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs space-y-2" data-testid="create-scan-sample-preview">
            {createScanPreview.loading && (
              <div className="flex items-center gap-2 text-slate-500">
                <Loader2 className="size-3.5 animate-spin" />
                正在按服务端最终权威口径预检样本…
              </div>
            )}
            {!createScanPreview.loading && createScanPreview.error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-rose-800">
                <p>{createScanPreview.error}</p>
                <p className="mt-1 text-[13px] text-rose-600">预检失败时不能确认最终权威样本数，已暂停创建入口。</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => targetBatchForScan && void fetchSamplePreview(targetBatchForScan)}
                >
                  重新预检
                </Button>
              </div>
            )}
            {!createScanPreview.loading && createScanPreview.data && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
                    <p className="text-[13px] text-slate-500">来源商品数</p>
                    <p className="text-sm font-bold text-slate-800">{createScanPreview.data.sourceItemCount}</p>
                  </div>
                  <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
                    <p className="text-[13px] text-slate-500">初步有效（状态口径）</p>
                    <p className="text-sm font-bold text-slate-800">{createScanPreview.data.preliminaryValidCount}</p>
                  </div>
                  <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2 col-span-2">
                    <p className="text-[13px] text-slate-500">最终可冻结的市场样本（创建权威口径）</p>
                    <p className={`text-base font-bold ${createScanPreview.data.sufficient ? "text-emerald-700" : "text-rose-700"}`}>
                      {createScanPreview.data.finalFreezableCount}
                      <span className="ml-1 text-[13px] font-medium text-slate-500">
                        / 最低 {createScanPreview.data.minimumRequired} 款
                      </span>
                    </p>
                  </div>
                </div>

                {createScanPreview.data.sufficient ? (
                  <p className="text-[13px] text-emerald-700 font-medium">
                    ✓ 达到最低样本门槛，可建立市场研究。
                  </p>
                ) : (
                  <p className="text-[13px] text-rose-700 font-semibold">
                    ✗ 最终有效样本不足 {createScanPreview.data.minimumRequired} 款（缺{" "}
                    {createScanPreview.data.minimumRequired - createScanPreview.data.finalFreezableCount} 款），
                    需先补齐有效商品，服务端也将拒绝创建。
                  </p>
                )}

                <p className="text-[13px] text-slate-500">{createScanPreview.data.parentVariationNotice}</p>

                {createScanPreview.data.stages.some((stage) => stage.droppedCount > 0) && (
                  <details className="rounded-lg border border-slate-200 bg-white p-2.5" data-testid="create-scan-exclusions">
                    <summary className="cursor-pointer text-[13px] font-semibold text-slate-600">
                      查看被排除商品与原因（按阶段，共{" "}
                      {createScanPreview.data.stages.reduce((sum, stage) => sum + stage.droppedCount, 0)} 项）
                    </summary>
                    <div className="mt-2 space-y-2">
                      {createScanPreview.data.stages.filter((stage) => stage.droppedCount > 0).map((stage) => (
                        <div key={stage.stage}>
                          <p className="text-[13px] font-semibold text-slate-700">
                            {stage.label}：排除 {stage.droppedCount} 项
                          </p>
                          <ul className="mt-0.5 space-y-0.5 text-[13px] text-slate-500">
                            {stage.items.map((item) => {
                              const linkedItem = targetBatchForScan && expandedBatchId === targetBatchForScan.id ? resolveExcludedItem(batchItemsMap[targetBatchForScan.id] ?? [], item, targetBatchForScan.marketplace || "US") : null;
                              return (
                              <li key={`${stage.stage}:${item.id}`}>
                                <code className="text-slate-400">{item.asin ?? item.id.slice(0, 8)}</code>
                                {" — "}
                                {item.label}
                                {linkedItem ? <button type="button" className="ml-2 text-emerald-700 underline underline-offset-4" onClick={() => { closeCreateScan(); setExpandedItemId(linkedItem.id); setReviewModuleFocus(null); }}>查看商品</button> : <span className="ml-2">请在批次中核对</span>}
                              </li>
                            ); })}
                            {stage.droppedCount > stage.items.length && (
                              <li className="text-slate-400">…等共 {stage.droppedCount} 项</li>
                            )}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">市场研究名称</label>
            <input
              type="text"
              value={createScanName}
              onChange={(e) => setCreateScanName(e.target.value)}
              className="h-9 w-full rounded-xl border border-slate-200 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              placeholder="请输入本次市场研究名称"
            />
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">来源批次：</span>
              <span className="font-semibold text-slate-800">{targetBatchForScan?.batchName || "未命名批次"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">目标市场：</span>
              <span className="font-semibold text-slate-800">
                Amazon {targetBatchForScan?.marketplace || "美国站 (US)"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">最终可冻结样本：</span>
              <span className={`font-semibold ${createScanPreview.data?.sufficient ? "text-emerald-700" : "text-slate-800"}`}>
                {createScanPreview.loading
                  ? "预检中…"
                  : createScanPreview.data
                  ? `${createScanPreview.data.finalFreezableCount} 款商品`
                  : "未知（预检失败）"}
              </span>
            </div>
          </div>

          {createScanError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-900">
              {createScanError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={closeCreateScan}
              disabled={createScanBusy}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirmCreateScan}
              disabled={
                createScanBusy
                || createScanPreview.loading
                || Boolean(createScanPreview.error)
                || (!createScanPreview.data || !createScanPreview.data.sufficient)
              }
              data-testid="confirm-create-market-scan-button"
            >
              {createScanBusy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              确认建立并进入市场研究
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Amazon 采集弹窗 */}
      <Dialog
        isOpen={amazonCaptureOpen}
        onClose={() => setAmazonCaptureOpen(false)}
        title={amazonCaptureMode === "detail" ? "商品事实采集（ASIN）" : "关键词市场采集"}
        maxWidth={amazonCaptureMode === "search" ? "5xl" : "2xl"}
        scrollable
      >
        <AmazonCapturePanel
          initialMode={amazonCaptureMode}
          showHeading={false}
          showModeSelector={false}
          onCaptured={(_msg) => {
            setAmazonCaptureRevision(revision => revision + 1);
          }}
          onRefresh={loadData}
        />
      </Dialog>

      <Dialog
        isOpen={categoryMarketCaptureOpen}
        onClose={() => setCategoryMarketCaptureOpen(false)}
        title="类目市场采集"
        maxWidth="5xl"
        scrollable
      >
        <SellerSpriteCategoryMarketCapturePanel />
      </Dialog>

      <Dialog
        isOpen={sellerSpriteDepthCaptureOpen}
        onClose={() => setSellerSpriteDepthCaptureOpen(false)}
        title="SellerSprite 深度采集"
        maxWidth="2xl"
      >
        {sellerSpriteDepthCaptureOpen ? <SellerSpriteKeywordCapturePanel initialModule={researchCapture?.module === "keyword_mining_trend" ? "keyword_mining_trend" : "reverse_asin"} initialKeyword={researchCapture?.keyword} initialAsin={researchCapture?.asin} researchScanId={researchCapture?.scanId} /> : null}
      </Dialog>

      <Dialog
        isOpen={keepaOpen}
        onClose={() => setKeepaOpen(false)}
        title="导入 Keepa 历史趋势 CSV"
        maxWidth="lg"
      >
        <div className="space-y-4 text-xs text-slate-700">
          <p className="text-slate-600">
            选择从 Keepa Product Viewer 导出的 CSV。系统会校验文件结构、ASIN 与字段映射，但无法独立证明文件来源或文件未被编辑；每条 Evidence 保留原始数据行和整份文件的 SHA-256，不保存整份 CSV，请保留原文件供复核。不会调用 Keepa API，也不会覆盖 Amazon 页面观察值。
          </p>
          <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
            <Upload className="mx-auto mb-2 size-8 text-slate-400" />
            <label className="cursor-pointer">
              <span className="font-semibold text-sky-700 hover:underline">点击选择 Keepa CSV</span>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="选择 Keepa CSV 文件"
                onChange={(event) => {
                  setKeepaFile(event.target.files?.[0] ?? null);
                  setKeepaError(null);
                  setKeepaResult(null);
                }}
                className="hidden"
              />
            </label>
            <p className="mt-1 text-[13px] text-slate-500">
              {keepaFile ? `已选择：${keepaFile.name}` : "仅支持 CSV，单文件最大 5 MB。"}
            </p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            当前按 Amazon US 绑定商品。每次最多处理前 50 条有效商品记录。若导表超过 50 条，请先拆分文件；超出部分不会入库。上传结果会分别报告成功、失败和解析隔离数量。
          </div>
          {keepaError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800" role="alert">
              {keepaError}
            </div>
          ) : null}
          {keepaBusy ? (
            <div className="flex items-center justify-center gap-2 py-3 text-slate-500" role="status">
              <Loader2 className="size-4 animate-spin text-sky-600" />正在按当前访问上下文保存趋势 Evidence…
            </div>
          ) : null}
          {keepaResult ? (
            <div
              className={`rounded-lg border p-3 ${keepaResult.failedCount > 0 || keepaResult.quarantinedCount > 0 || keepaResult.omittedByBudgetCount > 0 ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}
              role="status"
            >
              <p className="font-semibold">
                本次实际写入 {keepaResult.importedCount} 条；写入失败 {keepaResult.failedCount} 条；解析隔离 {keepaResult.quarantinedCount} 条；预算未尝试 {keepaResult.omittedByBudgetCount} 条。
              </p>
              <p className="mt-1 text-[13px]">每次最多处理 50 条有效行；更大文件的超出部分不会入库。趋势数据保留 Keepa 来源和历史性质。</p>
              <p className="mt-1 break-all text-[12px]">来源文件 SHA-256：<code>{keepaResult.sourceFileSha256}</code></p>
              {keepaResult.failed.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {keepaResult.failed.slice(0, 3).map((item, index) => (
                    <li key={`${item.asin}-${index}`}>{item.asin || "未识别 ASIN"}：{item.reason}</li>
                  ))}
                  {keepaResult.failed.length > 3 ? <li>另有 {keepaResult.failed.length - 3} 条失败明细。</li> : null}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <Button variant="outline" size="sm" onClick={() => setKeepaOpen(false)} disabled={keepaBusy}>
              关闭
            </Button>
            <Button variant="primary" size="sm" onClick={handleKeepaImport} disabled={!keepaFile || keepaBusy}>
              {keepaBusy ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
              导入趋势证据
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        isOpen={batchDetailConfirmTarget !== null}
        onClose={() => {
          if (!batchDetailConfirmTarget || batchDetailBusyId !== batchDetailConfirmTarget.id) {
            setBatchDetailConfirmTarget(null);
          }
        }}
        title="开始 Amazon 商品详情补齐？"
        description="确认后会通过当前 PH4 详情补齐入口访问 Amazon 商品页面，并保存合法详情证据；本次最多实际处理 30 条待补齐商品。已有详情会跳过，部分详情不会自动重采；遇到登录或验证码门槛时会停止。取消或关闭此窗口不会发送请求。"
        confirmText="确认开始详情补齐"
        cancelText="暂不开始"
        onConfirm={() => batchDetailConfirmTarget
          ? handleBatchDetailEnrichmentConfirm(batchDetailConfirmTarget)
          : undefined}
        isLoading={batchDetailBusyId === batchDetailConfirmTarget?.id}
      />

      {/* 依赖保护拦截提示弹窗 */}
      <ConfirmDialog
        isOpen={!!protectionWarning}
        onClose={() => setProtectionWarning(null)}
        title="删除受阻：业务依赖保护生效"
        description={protectionWarning || ""}
        confirmText="我知道了"
        onConfirm={() => setProtectionWarning(null)}
        isDestructive={false}
      />

      {/* 单批次删除拦截弹窗 */}
      <Dialog
        isOpen={batchDeleteOpen}
        onClose={() => setBatchDeleteOpen(false)}
        title="删除来源批次"
      >
        <div className="space-y-4 py-1 text-slate-800">
          <p className="text-xs text-slate-600 leading-relaxed">
            确定要物理删除批次{" "}
            <strong className="text-slate-900 font-bold">
              &ldquo;{targetBatchToDelete?.batchName || targetBatchToDelete?.id}&rdquo;
            </strong>{" "}
            吗？
          </p>

          {batchProtectionWarning && (
            <div
              className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1"
              data-testid="batch-delete-blocked-panel"
              data-blocked-kind={batchDeleteBlockedKind ?? "unknown"}
            >
              <div className="flex items-center gap-1.5 font-bold">
                <ShieldAlert className="size-4 text-amber-600" />
                <span>
                  {batchDeleteBlockedKind === "dependency"
                    ? "依赖保护拦截"
                    : batchDeleteBlockedKind === "version_conflict"
                      ? "版本冲突拦截"
                      : "删除未完成"}
                </span>
              </div>
              <p className="leading-relaxed">{batchProtectionWarning}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBatchDeleteOpen(false)}
              disabled={batchActionBusy}
            >
              取消
            </Button>
            {batchDeleteBlockedKind === "dependency" ? (
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  if (targetBatchToDelete) {
                    setBatchDeleteOpen(false);
                    await handleArchiveBatch(targetBatchToDelete);
                  }
                }}
              >
                改为归档该批次
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-rose-600 hover:bg-rose-50"
                onClick={confirmDeleteBatch}
                disabled={batchActionBusy}
              >
                {batchActionBusy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                彻底删除
              </Button>
            )}
          </div>
        </div>
      </Dialog>

      {/* 批量操作确认弹窗 */}
      <ConfirmDialog
        isOpen={batchBulkConfirmOpen}
        onClose={() => setBatchBulkConfirmOpen(false)}
        title={`批量${batchBulkAction === "archive" ? "归档" : batchBulkAction === "restore" ? "恢复" : "删除"}确认`}
        description={`确定对选中的 ${selectedBatches.length} 个批次执行${
          batchBulkAction === "archive" ? "归档" : batchBulkAction === "restore" ? "恢复" : "受控删除"
        }操作吗？`}
        confirmText={`确认${batchBulkAction === "archive" ? "归档" : batchBulkAction === "restore" ? "恢复" : "删除"}`}
        onConfirm={handleBatchBulkActionConfirm}
        isDestructive={batchBulkAction === "delete"}
      />

      <ConfirmDialog
        isOpen={itemBulkConfirmOpen}
        onClose={() => setItemBulkConfirmOpen(false)}
        title={`批量${itemBulkAction === "archive" ? "归档" : itemBulkAction === "restore" ? "恢复" : "删除"}商品`}
        description={itemBulkAction === "delete"
          ? `确定检查并删除所选 ${selectedSourceItems.length} 条未被下游业务引用的来源记录吗？有引用的记录会逐项被拦截；不可变 EvidenceStore 证据不会删除。`
          : `确定对所选 ${selectedSourceItems.length} 条来源记录执行批量${itemBulkAction === "archive" ? "归档" : "恢复"}吗？`}
        confirmText={`确认${itemBulkAction === "archive" ? "归档" : itemBulkAction === "restore" ? "恢复" : "删除"}`}
        onConfirm={handleItemBulkActionConfirm}
        isDestructive={itemBulkAction === "delete"}
      />

      <Dialog
        isOpen={moduleEvidenceViewer !== null && !evidenceOpen}
        onClose={closeModuleEvidence}
        title="资料证据"
        maxWidth="2xl"
        scrollable
      >
        {moduleEvidenceViewer ? (
          <ModuleEvidenceDetail
            item={moduleEvidenceViewer.item}
            module={moduleEvidenceViewer.module}
            coverage={moduleEvidenceViewer.coverage}
            data={moduleEvidenceViewer.data}
            loading={moduleEvidenceViewer.loading}
            error={moduleEvidenceViewer.error}
            onRetry={() => {
              const viewer = moduleEvidenceViewer;
              if (viewer) void handleViewModuleEvidence(viewer.batch, viewer.item, viewer.module);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

