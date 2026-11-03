"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Chrome,
  Copy,
  Database,
  ExternalLink,
  FileSpreadsheet,
  Inbox,
  Loader2,
  PenTool,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";

import { AMAZON_US_TOP_LEVEL_CATEGORIES } from "@/lib/productBatchPresentation";
import {
  buildAccessHeaders,
  isAuthenticated,
  setNoAuthOwnerMode,
} from "@/lib/client/accessToken";
import type {
  SourceAssetInboxPayload,
  SourceAssetItem,
} from "@/lib/sourceLayer/server/sourceAssetInbox";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { AmazonCapturePanel } from "@/components/source-layer/AmazonCapturePanel";
import { useModalA11y } from "@/components/source-layer/useModalA11y";
import { DataTable } from "@/components/ui/DataTable";
import { BulkActionBar } from "@/components/ui/BulkActionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";

/**
 * 商品资产收件箱（Product Source Layer · Phase F4 Redesign）
 *
 * 产品心智：
 * 「我现在有哪些可信商品资料？」
 *
 * 核心功能：
 * 1. 集中展现所有已入库的商品资料与来源证明；
 * 2. 规范表格展示（支持分页、排序、列显隐、多选）；
 * 3. 直观判断数据可用状态（可研究 / 需复核 / 已阻断）与关键字段覆盖度；
 * 4. 缺失数据诚实展示为「— 未提供」，绝不用 0 替代；
 * 5. 支持接入卖家精灵批次、插件采集指引、手工录入；
 * 6. 满足准入条件的商品一键或批量送入「商品研究池」，并提供防破坏生命周期保护。
 *
 * 红线：
 * - 采集数据不会被当成商品事实，不自动补全；
 * - 校验不通过的商品不得进入研究池；
 * - 纯只读投影与受控交接，不跨界调用候选/研究库写入接口。
 */

export const ERROR_LABELS: Record<string, string> = {
  SOURCE_MISSING: "来源缺失",
  SOURCE_UNTRUSTED: "来源不可信",
  SOURCE_EXPIRED: "来源过期",
  PAGE_CHANGED: "页面变化",
  DOM_CHANGED: "DOM 变化",
  SELECTOR_FAILED: "选择器失败",
  TIMEOUT: "超时",
  CAPTCHA_DETECTED: "验证码",
  LOGIN_REQUIRED: "需要登录",
  FIELD_MISSING: "字段缺失",
  FIELD_CONFLICT: "字段冲突",
  LOW_CONFIDENCE: "置信度偏低",
  INVALID_FORMAT: "格式不合法",
  AI_GENERATED_AS_FACT: "AI 内容当作事实",
  UNSUPPORTED_CLAIM: "无支撑主张",
  NO_EVIDENCE: "无证据",
  CONTRACT_INVALID: "契约不合法",
  TRANSITION_FORBIDDEN: "状态跃迁被拒",
  AUDIT_REQUIRED: "审计缺失",
  INTERNAL_UNEXPECTED: "未预期错误",
};

/**
 * 风险标记的中文展示名。
 * 键与 `lib/sourceLayer/capturePackage.ts` 的 RISK_FLAGS 枚举一一对应；
 * 缺失时回落为「其它风险」，绝不在主界面直出后端 snake_case 枚举值。
 */
export const RISK_FLAG_LABELS: Record<string, string> = {
  price_volatile: "价格波动或缺失",
  rating_low: "评分偏低",
  review_count_low: "评论数偏少",
  bsr_weak: "排名靠后或缺失",
  image_missing: "缺少商品图片",
  image_single: "仅一张商品图片",
  provider_estimate_only: "仅有第三方估算值",
  seller_unverified: "卖家信息未核实",
  source_expired: "来源已过期",
  field_conflict: "字段存在冲突",
};

export function riskFlagLabel(flag: string): string {
  return RISK_FLAG_LABELS[flag] ?? "其它风险";
}

export type HandoffSummaryPayload = {
  created: Array<{ rowHash: string; candidateId: string }>;
  skipped: Array<{ rowHash: string; candidateId: string; reason: string }>;
  conflicts: Array<{ rowHash: string; candidateId: string; reason: string }>;
  evidenceOnlyNote: string;
  destinationUrl: string;
};

type EvidenceVersionRecord = {
  version: number;
  sourceType: string;
  capturedAt: string;
  contentHash: string;
  sourceUrl: string | null;
  validation: {
    verdict: "passed" | "needs_review" | "blocked";
    readyForResearch: boolean;
    issueCodes: string[];
  };
  pkg: {
    fields: {
      asin: string | null;
      title: string | null;
      images: string[];
      brand?: string | null;
      price: { amount: number; currency: string } | null;
      rating: number | null;
      reviewCount: number | null;
      bsr?: { rank: number; category: string | null } | null;
      estimatedMonthlySales?: number | null;
      estimatedMonthlyRevenueUsd?: number | null;
      keywords?: string[];
    };
    fieldStates?: Record<string, { status: string; confidence: number; valueOrigin: string }>;
    riskFlags?: string[];
  };
};

type AuditEntry = {
  sequence: number;
  eventKind: string;
  previousState: string | null;
  nextState: string | null;
  reason: string;
  timestamp: string;
  errorCode: string | null;
  operator: string;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  taskId?: string | null;
  captureId?: string | null;
  subjectKey?: string | null;
  module?: string | null;
  phase?: string | null;
  eventType?: string | null;
  severity?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  retryable?: boolean | null;
  humanRequired?: boolean | null;
  sourceType?: string | null;
  recipeVersion?: string | null;
  pageTemplateHash?: string | null;
  evidenceRefs?: string[];
  contentHash?: string | null;
  jevRole?: string | null;
  jevModelVersion?: string | null;
  jevPromptVersion?: string | null;
  jevConfidence?: number | null;
  durationMs?: number | null;
  attempt?: number | null;
};

type EvidenceDetailResponse = {
  subjectKey: string;
  marketplace: string;
  versions: EvidenceVersionRecord[];
  audit: AuditEntry[];
};

export function SourceLayerClient() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [inbox, setInbox] = useState<SourceAssetInboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handoffSummary, setHandoffSummary] = useState<HandoffSummaryPayload | null>(null);

  // Selected item for drawer
  const [selectedItem, setSelectedItem] = useState<SourceAssetItem | null>(null);
  const [itemDetail, setItemDetail] = useState<EvidenceDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"facts" | "validation" | "versions">("facts");
  const [showTechDetails, setShowTechDetails] = useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);

  // Add product dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addTab, setAddTab] = useState<"batch" | "plugin" | "amazon" | "manual">("batch");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Manual entry fields
  const [asin, setAsin] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [title, setTitle] = useState("");
  const [imagesText, setImagesText] = useState("");
  const [price, setPrice] = useState("");
  const [rating, setRating] = useState("");
  const [reviewCount, setReviewCount] = useState("");
  const [bsrRank, setBsrRank] = useState("");
  const [bsrCategory, setBsrCategory] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "passed" | "needs_review" | "blocked">("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Multi-selection state for DataTable
  const [rowSelectionState, setRowSelectionState] = useState<RowSelectionState>({});
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  const selectedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [key, selected] of Object.entries(rowSelectionState)) {
      if (selected) set.add(key);
    }
    return set;
  }, [rowSelectionState]);

  // Modal a11y: ESC to close, focus trapping
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const addDialogRef = useRef<HTMLDivElement | null>(null);
  const closeDrawer = useCallback(() => setSelectedItem(null), []);
  const closeAddDialog = useCallback(() => setAddDialogOpen(false), []);
  useModalA11y({ open: selectedItem !== null, onClose: closeDrawer, containerRef: drawerRef });
  useModalA11y({ open: addDialogOpen, onClose: closeAddDialog, containerRef: addDialogRef });

  // Copy ASIN feedback
  const [copiedAsin, setCopiedAsin] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      // 来源层只读接口："/api/source-layer"
      const res = await fetch("/api/source-layer?view=assets", {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const body = (await res.json()) as {
        ok?: boolean;
        data?: SourceAssetInboxPayload;
        error?: { message?: string };
      };
      if (!res.ok || !body.ok || !body.data) {
        throw new Error(body.error?.message || "读取商品资产列表失败。");
      }
      setInbox(body.data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "读取商品资产收件箱失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  // First-load bootstrap: fetch /api/runtime-mode to establish local_owner authentication
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const response = await fetch("/api/runtime-mode", { cache: "no-store" });
        const json = (await response.json()) as {
          ok?: boolean;
          mode?: string;
          noAuthOwner?: boolean;
        };
        if (json?.ok && (json.mode === "local_owner" || json.noAuthOwner === true)) {
          setNoAuthOwnerMode();
        }
      } catch {
        // non-blocking
      }
      if (isMounted) {
        setBootstrapped(true);
        if (isAuthenticated()) {
          setAuthenticated(true);
          await loadInbox();
        } else {
          setAuthenticated(false);
          setLoading(false);
        }
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [loadInbox]);

  // Load subject detail when drawer opens
  useEffect(() => {
    if (!selectedItem) {
      setItemDetail(null);
      return;
    }
    let isMounted = true;
    setDetailLoading(true);
    fetch(`/api/source-layer/evidence/${encodeURIComponent(selectedItem.subjectKey)}`, {
      headers: buildAccessHeaders(),
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((json: { ok?: boolean; data?: EvidenceDetailResponse }) => {
        if (isMounted && json?.ok && json.data) {
          setItemDetail(json.data);
        }
      })
      .catch(() => {
        // fallback
      })
      .finally(() => {
        if (isMounted) setDetailLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [selectedItem]);

  const handleCopyAsin = useCallback((asinText: string) => {
    navigator.clipboard.writeText(asinText).then(() => {
      setCopiedAsin(asinText);
      setTimeout(() => setCopiedAsin(null), 1500);
    });
  }, []);

  const handleCopyDiagnostics = useCallback(async () => {
    if (!selectedItem || !itemDetail) return;

    const redactText = (value: string | null | undefined) =>
      value?.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 500) ?? null;
    const bundle = {
      schemaVersion: "source-layer-diagnostic-bundle.v2",
      subjectKey: selectedItem.subjectKey,
      audit: itemDetail.audit.slice(-50).map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        eventKind: entry.eventKind,
        module: entry.module ?? null,
        phase: entry.phase ?? null,
        eventType: entry.eventType ?? null,
        severity: entry.severity ?? null,
        statusBefore: entry.statusBefore ?? entry.previousState,
        statusAfter: entry.statusAfter ?? entry.nextState,
        errorCode: entry.errorCode,
        retryable: entry.retryable ?? null,
        humanRequired: entry.humanRequired ?? null,
        sourceType: entry.sourceType ?? null,
        traceId: entry.traceId ?? null,
        spanId: entry.spanId ?? null,
        parentSpanId: entry.parentSpanId ?? null,
        captureId: entry.captureId ?? null,
        evidenceRefs: entry.evidenceRefs ?? [],
        contentHash: entry.contentHash ?? null,
        jevRole: entry.jevRole ?? null,
        jevConfidence: entry.jevConfidence ?? null,
        durationMs: entry.durationMs ?? null,
        attempt: entry.attempt ?? null,
        reason: redactText(entry.reason),
      })),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setCopiedDiagnostics(true);
      setTimeout(() => setCopiedDiagnostics(false), 1800);
    } catch {
      setErrorMessage("诊断包复制失败，请检查浏览器剪贴板权限。");
    }
  }, [itemDetail, selectedItem]);

  // Handoff single item to research pool
  const handleHandoff = useCallback(
    async (subjectKey: string) => {
      setHandoffBusy(true);
      setErrorMessage(null);
      setNotice(null);
      try {
        const item = inbox?.items.find((i) => i.subjectKey === subjectKey);
        if (!item) throw new Error("商品不存在。");
        // Contract assertion: only hands off captures that passed validation
        const isReady =
          (item as { readyForResearch?: boolean }).readyForResearch ??
          item.latestVerdict === "passed";
        if (!item.readyForResearch && item.latestVerdict !== "passed") {
          throw new Error("当前没有通过校验的商品，无法进入研究池。");
        }

        const res = await fetch("/api/source-layer/handoff", {
          headers: buildAccessHeaders(),
          method: "POST",
          body: JSON.stringify({ subjectKeys: [subjectKey] }),
        });
        const body = (await res.json()) as {
          ok?: boolean;
          error?: { message?: string };
          data?: {
            created: Array<{ rowHash: string; candidateId: string }>;
            skipped: Array<{ rowHash: string; candidateId: string; reason: string }>;
            conflicts: Array<{ rowHash: string; candidateId: string; reason: string }>;
            evidenceOnlyNote: string;
            destinationUrl: string;
          };
        };

        if (!res.ok || !body.ok || !body.data) {
          throw new Error(body.error?.message || "送入研究池失败。");
        }

        setHandoffSummary({
          created: body.data.created,
          skipped: body.data.skipped,
          conflicts: body.data.conflicts,
          evidenceOnlyNote: body.data.evidenceOnlyNote,
          destinationUrl: body.data.destinationUrl,
        });
        setNotice(`已成功将商品送入研究池（共 ${body.data.created.length} 个候选已就绪）！`);
        setSelectedItem(null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "送入研究池发生异常。");
      } finally {
        setHandoffBusy(false);
      }
    },
    [inbox],
  );

  // Batch handoff selected items
  const handleBatchHandoff = useCallback(async () => {
    if (selectedKeys.size === 0) return;
    const passedKeys = Array.from(selectedKeys).filter((key) => {
      const item = inbox?.items.find((i) => i.subjectKey === key);
      const ready =
        (item as { readyForResearch?: boolean })?.readyForResearch ??
        item?.latestVerdict === "passed";
      return ready && item?.latestVerdict === "passed";
    });

    if (passedKeys.length === 0) {
      setErrorMessage("当前没有通过校验的商品，无法进入研究池。");
      return;
    }

    setBusy(true);
    setErrorMessage(null);
    setNotice(null);
    try {
      const res = await fetch("/api/source-layer/handoff", {
        headers: buildAccessHeaders(),
        method: "POST",
        body: JSON.stringify({ subjectKeys: passedKeys }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: { message?: string };
        data?: {
          created: Array<{ rowHash: string; candidateId: string }>;
          skipped: Array<{ rowHash: string; candidateId: string; reason: string }>;
          conflicts: Array<{ rowHash: string; candidateId: string; reason: string }>;
          evidenceOnlyNote: string;
          destinationUrl: string;
        };
      };

      if (!res.ok || !body.ok || !body.data) {
        throw new Error(body.error?.message || "批量送入研究池失败。");
      }

      setHandoffSummary({
        created: body.data.created,
        skipped: body.data.skipped,
        conflicts: body.data.conflicts,
        evidenceOnlyNote: body.data.evidenceOnlyNote,
        destinationUrl: body.data.destinationUrl,
      });
      setNotice(`批量操作完成：成功送入 ${body.data.created.length} 个商品！`);
      setRowSelectionState({});
      setConfirmDialogOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "批量操作发生异常。");
    } finally {
      setBusy(false);
    }
  }, [inbox, selectedKeys]);

  // Product batch bridge handler
  async function handleBridgeBatch() {
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch("/api/source-layer/from-product-batch", {
        headers: buildAccessHeaders(),
        method: "POST",
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: { message?: string };
        data?: { batchName?: string; totalDrafts?: number; readyCount?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "批次接入失败，请检查批次状态。");
      }
      setNotice(
        `成功从批次「${data.data?.batchName || "当前批次"}」接入 ${data.data?.totalDrafts || 0} 个商品证据！`,
      );
      setAddDialogOpen(false);
      void loadInbox();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "批次接入发生异常。");
    } finally {
      setAddBusy(false);
    }
  }

  // Manual entry handler
  async function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    const cleanAsin = asin.trim().toUpperCase();
    const cleanUrl = productUrl.trim();
    if (!cleanAsin) {
      setAddError("请输入商品 ASIN。");
      return;
    }
    if (!cleanUrl) {
      setAddError("请输入商品 URL（用于来源证明追溯）。");
      return;
    }

    setAddBusy(true);
    setAddError(null);

    const payload: Record<string, unknown> = {
      asin: cleanAsin,
      title: title.trim() || undefined,
      productUrl: cleanUrl,
      images: imagesText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      keywords: keywordsText
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };

    if (price.trim()) {
      const num = Number(price.trim());
      if (!Number.isNaN(num) && num > 0) {
        // 正式 manual_entry 契约是扁平形状：price 为数字，currency 为独立键。
        // 不要发送 { amount, currency } 对象——那是 CapturePackage 的内部形状，
        // adapter 会把对象判为不可解析并静默丢弃为 missing。
        payload.price = num;
        payload.currency = "USD";
      }
    }
    if (rating.trim()) {
      const num = Number(rating.trim());
      if (!Number.isNaN(num)) payload.rating = num;
    }
    if (reviewCount.trim()) {
      const num = Number(reviewCount.trim());
      if (!Number.isNaN(num)) payload.reviewCount = num;
    }
    if (bsrRank.trim()) {
      const rank = Number(bsrRank.trim());
      if (!Number.isNaN(rank)) {
        // 同理：adapter 读 bsrRank / bsrCategory，而不是 bsr 对象。
        payload.bsrRank = Math.round(rank);
        if (bsrCategory) payload.bsrCategory = bsrCategory;
      }
    }

    try {
      const res = await fetch("/api/source-layer/ingest", {
        headers: buildAccessHeaders(),
        method: "POST",
        body: JSON.stringify({
          sourceType: "manual_entry",
          sourceUrl: cleanUrl,
          payload,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: { message?: string };
        data?: {
          totalDrafts?: number;
          readyCount?: number;
          blockedCount?: number;
          reviewCount?: number;
        };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "手工录入失败。");
      }
      // 诚实提示：状态由校验器决定，不能一律报「成功」。
      const ready = data.data?.readyCount ?? 0;
      const blocked = data.data?.blockedCount ?? 0;
      const review = data.data?.reviewCount ?? 0;
      if (ready > 0) {
        setNotice(`已录入商品 ${cleanAsin} 来源证据，校验通过，可进入市场扫描或商品研究。`);
      } else {
        const reasons = [
          blocked > 0 ? `${blocked} 条已阻断` : null,
          review > 0 ? `${review} 条需复核` : null,
        ]
          .filter(Boolean)
          .join("、");
        setNotice(
          `已录入商品 ${cleanAsin} 来源证据，但校验未通过（${reasons || "未满足准入条件"}）。缺失字段不会被自动补全。`,
        );
      }
      setAddDialogOpen(false);
      setAsin("");
      setProductUrl("");
      setTitle("");
      void loadInbox();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "录入提交发生异常。");
    } finally {
      setAddBusy(false);
    }
  }

  // Distinct sources for dropdown filter
  const allSources = useMemo(() => {
    if (!inbox?.items) return [];
    const set = new Set<string>();
    for (const item of inbox.items) {
      for (const s of item.sources) set.add(s);
    }
    return Array.from(set);
  }, [inbox]);

  // Filtered items
  const filteredItems = useMemo(() => {
    if (!inbox?.items) return [];
    return inbox.items.filter((item) => {
      if (statusFilter !== "all" && item.latestVerdict !== statusFilter) return false;
      if (sourceFilter !== "all" && !item.sources.includes(sourceFilter)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchAsin = item.asin?.toLowerCase().includes(q);
        const matchTitle = item.title?.toLowerCase().includes(q);
        const matchBrand = item.brand?.toLowerCase().includes(q);
        if (!matchAsin && !matchTitle && !matchBrand) return false;
      }
      return true;
    });
  }, [inbox, statusFilter, sourceFilter, searchQuery]);

  // Count actionable selected items
  const actionableSelectedCount = useMemo(() => {
    if (!inbox?.items || selectedKeys.size === 0) return 0;
    return Array.from(selectedKeys).filter((key) => {
      const item = inbox.items.find((i) => i.subjectKey === key);
      const ready =
        (item as { readyForResearch?: boolean })?.readyForResearch ??
        item?.latestVerdict === "passed";
      return ready && item?.latestVerdict === "passed";
    }).length;
  }, [inbox, selectedKeys]);

  // Table Columns Definition
  const columns = useMemo<ColumnDef<SourceAssetItem>[]>(
    () => [
      {
        id: "product",
        header: "商品基本信息",
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex gap-3 items-center py-1">
              <ProductImage
                src={item.imageUrl}
                alt={item.title || "商品图片"}
                className="h-12 w-12 rounded-lg border border-slate-200"
                placeholderLabel="暂无主图"
              />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setSelectedItem(item)}
                  className="text-left font-semibold text-slate-900 hover:text-emerald-600 line-clamp-1 block transition-colors"
                  title={item.title || "未命名商品"}
                >
                  {item.title || "未命名商品"}
                </button>
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                  {item.asin ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      {item.asin}
                      <button
                        type="button"
                        onClick={() => handleCopyAsin(item.asin!)}
                        title="复制 ASIN"
                        className="text-slate-400 hover:text-slate-700"
                      >
                        {copiedAsin === item.asin ? (
                          <Check className="h-3 w-3 text-emerald-600" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </span>
                  ) : (
                    <span className="text-[13px] text-slate-400">无 ASIN</span>
                  )}
                  {item.brand ? (
                    <span className="text-[13px] text-slate-500 truncate max-w-[120px]">
                      {item.brand}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "price",
        header: "价格与销售表现",
        accessorFn: (item) => item.price?.amount ?? -1,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-0.5 py-1">
              <div className="font-semibold text-slate-900">
                {item.price ? `${item.price.currency} ${item.price.amount.toFixed(2)}` : "—"}
              </div>
              <div className="text-[13px] text-slate-500">
                {item.estimatedMonthlySales !== null
                  ? `月销约 ${item.estimatedMonthlySales.toLocaleString()} 件`
                  : "— 未提供销量"}
              </div>
              {item.bsr ? (
                <div className="text-[12px] text-slate-400">
                  BSR #{item.bsr.rank.toLocaleString()}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "rating",
        header: "评分与评论",
        accessorFn: (item) => item.rating ?? -1,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-0.5 py-1">
              <div className="font-semibold text-slate-900">
                {item.rating !== null ? `★ ${item.rating.toFixed(1)}` : "—"}
              </div>
              <div className="text-[13px] text-slate-500">
                {item.reviewCount !== null
                  ? `${item.reviewCount.toLocaleString()} 评论`
                  : "—"}
              </div>
            </div>
          );
        },
      },
      {
        id: "sources",
        header: "来源与版本",
        accessorFn: (item) => new Date(item.updatedAt || 0).getTime(),
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-1 py-1">
              <div className="flex flex-wrap gap-1">
                {item.sources.map((s) => (
                  <span
                    key={s}
                    className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[12px] font-medium text-slate-600"
                  >
                    {s}
                  </span>
                ))}
              </div>
              <div className="text-[12px] text-slate-400">
                v{item.versionCount} ·{" "}
                {item.updatedAt
                  ? new Date(item.updatedAt).toLocaleDateString("zh-CN")
                  : "—"}
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        header: "数据可用状态",
        accessorFn: (item) => item.latestVerdict,
        cell: ({ row }) => {
          const item = row.original;
          const isPassed = item.latestVerdict === "passed";
          const isBlocked = item.latestVerdict === "blocked";

          return (
            <div className="space-y-1 py-1">
              {isPassed ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[13px] font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> 可研究
                </span>
              ) : isBlocked ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[13px] font-semibold text-rose-700">
                  <ShieldAlert className="h-3 w-3" /> 阻断
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[13px] font-semibold text-amber-700">
                  <AlertTriangle className="h-3 w-3" /> 需复核
                </span>
              )}
              <div
                className="text-[13px] text-slate-500"
                title={`缺失：${item.fieldCoverage.missingFields.join("、") || "无"}`}
              >
                {item.fieldCoverage.presentCount}/{item.fieldCoverage.totalCount} 关键字段
              </div>
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
          const isPassed = item.latestVerdict === "passed";

          return (
            <div className="flex items-center justify-end gap-1.5 py-1">
              <button
                type="button"
                onClick={() => setSelectedItem(item)}
                className="rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                查看详情
              </button>
              {isPassed && (
                <button
                  type="button"
                  disabled={handoffBusy}
                  onClick={() => handleHandoff(item.subjectKey)}
                  className="rounded-lg bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                  title="送入单品研究池"
                >
                  送入研究
                </button>
              )}
            </div>
          );
        },
      },
    ],
    [copiedAsin, handoffBusy, handleCopyAsin, handleHandoff],
  );

  if (!bootstrapped || loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
        <p className="text-xs">正在整理商品资产收件箱...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center max-w-lg mx-auto mt-6 shadow-sm">
        <Inbox className="h-10 w-10 text-slate-400 mx-auto" />
        <h3 className="mt-3 text-base font-semibold text-slate-900">请先验证访问权限</h3>
        <p className="mt-1 text-xs text-slate-500">
          商品资产收件箱需访问者或管理员权限，请通过侧边栏或登录页完成访问验证。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Notification / Error */}
      {errorMessage && (
        <div className="source-layer-error flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold">操作提示：</span>
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-500 hover:text-rose-700"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
          <div className="flex-1">
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-500 hover:text-emerald-700"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {/* Handoff Feedback Summary (source-layer-handoff-summary) */}
      {handoffSummary && (
        <div className="source-layer-handoff-summary rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 text-xs text-emerald-950 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-emerald-950 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> 已成功将选定商品交接至商品研究池
            </span>
            <Link
              href={handoffSummary.destinationUrl && !handoffSummary.destinationUrl.includes("/opportunity-candidates") ? handoffSummary.destinationUrl : "/research"}
              className="font-semibold text-emerald-700 hover:underline flex items-center gap-1"
            >
              前往商品深研 →
            </Link>
          </div>
          <p className="text-emerald-800 leading-relaxed">{handoffSummary.evidenceOnlyNote}</p>
          <div className="flex flex-wrap gap-4 pt-1 text-[13px] text-emerald-700">
            <span>已创建候选：{handoffSummary.created.length} 个</span>
            <span>跳过已存在：{handoffSummary.skipped.length} 个（不会自动覆盖历史记录）</span>
            {handoffSummary.conflicts.length > 0 ? (
              <span className="text-rose-600 font-semibold">
                冲突拦截：{handoffSummary.conflicts.length} 个
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Header & Quick Action Row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">已入库商品</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            核对字段覆盖与可用状态；采集数据不会被当成商品事实，不自动补全。
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 transition-colors"
          >
            <Plus className="h-4 w-4" /> 接入新商品
          </button>
          <Link
            href="/market-analysis"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            前往市场研究 →
          </Link>
          <button
            type="button"
            onClick={loadInbox}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50 transition-colors"
            title="刷新收件箱"
            aria-label="刷新收件箱"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* KPI Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium text-slate-500">已入库商品总数</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{inbox?.totalCount ?? 0}</div>
          <div className="mt-1 text-[13px] text-slate-400">全部来源可信存档</div>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 shadow-sm">
          <div className="text-xs font-medium text-emerald-700">可研究</div>
          <div className="mt-1 text-2xl font-bold text-emerald-800">{inbox?.passedCount ?? 0}</div>
          <div className="mt-1 text-[13px] text-emerald-600">准入规则完全满足</div>
        </div>
        <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-4 shadow-sm">
          <div className="text-xs font-medium text-amber-700">需复核</div>
          <div className="mt-1 text-2xl font-bold text-amber-800">{inbox?.reviewCount ?? 0}</div>
          <div className="mt-1 text-[13px] text-amber-600">字段缺失或需人工确认</div>
        </div>
        <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-4 shadow-sm">
          <div className="text-xs font-medium text-rose-700">已阻断</div>
          <div className="mt-1 text-2xl font-bold text-rose-800">{inbox?.blockedCount ?? 0}</div>
          <div className="mt-1 text-[13px] text-rose-600">阻断命中，禁止进入研究</div>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="搜索 ASIN、商品标题或品牌..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-200 pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        {/* Status Filters & Source Filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setStatusFilter("all")}
              aria-pressed={statusFilter === "all"}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                statusFilter === "all"
                  ? "bg-white text-slate-900 shadow-xs font-semibold"
                  : "hover:text-slate-900"
              }`}
            >
              全部 ({inbox?.totalCount ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("passed")}
              aria-pressed={statusFilter === "passed"}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                statusFilter === "passed"
                  ? "bg-emerald-600 text-white font-semibold"
                  : "hover:text-emerald-700"
              }`}
            >
              可研究 ({inbox?.passedCount ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("needs_review")}
              aria-pressed={statusFilter === "needs_review"}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                statusFilter === "needs_review"
                  ? "bg-amber-500 text-white font-semibold"
                  : "hover:text-amber-700"
              }`}
            >
              需复核 ({inbox?.reviewCount ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("blocked")}
              aria-pressed={statusFilter === "blocked"}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                statusFilter === "blocked"
                  ? "bg-rose-600 text-white font-semibold"
                  : "hover:text-rose-700"
              }`}
            >
              已阻断 ({inbox?.blockedCount ?? 0})
            </button>
          </div>

          {allSources.length > 1 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 bg-white"
            >
              <option value="all">所有来源</option>
              {allSources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}

          {selectedKeys.size > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              批量送入研究池 ({selectedKeys.size})
            </button>
          )}
        </div>
      </div>

      {/* Main Asset Data Table */}
      <DataTable
        columns={columns}
        data={filteredItems}
        isLoading={loading}
        enableRowSelection={true}
        getRowId={(item) => item.subjectKey}
        rowSelection={rowSelectionState}
        setRowSelection={setRowSelectionState}
        pageSize={15}
        showPagination={true}
        emptyTitle="未找到符合条件的商品资料"
        emptyDescription="核对字段覆盖与可用状态；采集数据不会被当成商品事实，不自动补全。"
        emptyActionText={inbox?.totalCount === 0 ? "立即接入第一批商品" : undefined}
        onEmptyAction={inbox?.totalCount === 0 ? () => setAddDialogOpen(true) : undefined}
      />

      {/* Floating Bulk Action Bar */}
      <BulkActionBar
        selectedCount={selectedKeys.size}
        onClearSelection={() => setRowSelectionState({})}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={busy || actionableSelectedCount === 0}
            onClick={() => setConfirmDialogOpen(true)}
            className="inline-flex items-center gap-1.5"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            <span>批量送入研究池 ({actionableSelectedCount} 个可研究)</span>
          </Button>
        }
      />

      {/* Confirm Dialog for Batch Handoff */}
      <ConfirmDialog
        isOpen={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
        onConfirm={handleBatchHandoff}
        title="批量送入商品研究池"
        description="将已通过准入校验的商品证据交接至商品研究池创建研究候选。未通过校验的商品将被跳过，已存在的候选不会被覆盖。"
        metrics={{
          totalCount: selectedKeys.size,
          actionableCount: actionableSelectedCount,
          protectedCount: selectedKeys.size - actionableSelectedCount,
          protectedReason: "部分选定商品未通过准入校验（需复核或已阻断），将被自动跳过",
        }}
        confirmText="确认送入研究池"
        cancelText="取消"
        isLoading={busy}
      />

      {/* Slide-out Drawer */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 overflow-hidden">
          <div
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
            onClick={closeDrawer}
          />
          <div className="fixed inset-y-0 right-0 flex max-w-full pl-6 sm:pl-10">
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="source-asset-drawer-title"
              className="w-screen max-w-2xl bg-white shadow-2xl flex flex-col"
            >
              {/* Drawer Header */}
              <div className="border-b border-slate-200 px-6 py-4 flex items-start justify-between bg-slate-50/80">
                <div className="min-w-0 flex-1 pr-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    {selectedItem.latestVerdict === "passed" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" /> 可研究
                      </span>
                    ) : selectedItem.latestVerdict === "blocked" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700">
                        <ShieldAlert className="h-3.5 w-3.5" /> 已阻断
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" /> 需复核
                      </span>
                    )}
                    <span className="font-mono text-xs font-semibold text-slate-600 bg-slate-200/70 px-2 py-0.5 rounded">
                      {selectedItem.asin || "无 ASIN"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {selectedItem.versionCount > 1
                        ? `共 ${selectedItem.versionCount} 个版本历史`
                        : "首个版本"}
                    </span>
                  </div>
                  <h2
                    id="source-asset-drawer-title"
                    className="mt-2 text-base font-semibold text-slate-900 line-clamp-2 leading-snug"
                  >
                    {selectedItem.title || "未命名商品"}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closeDrawer}
                  aria-label="关闭详情"
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-600 focus:outline-none"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Drawer Action Bar */}
              <div className="px-6 py-3 bg-white border-b border-slate-100 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  字段覆盖：
                  <strong className="font-semibold text-slate-700">
                    {selectedItem.fieldCoverage.presentCount}/
                    {selectedItem.fieldCoverage.totalCount}
                  </strong>
                  {selectedItem.fieldCoverage.missingFields.length > 0 ? (
                    <span className="ml-1 text-slate-400">
                      缺失：{selectedItem.fieldCoverage.missingFields.join("、")}
                    </span>
                  ) : (
                    <span className="ml-1 text-emerald-600 font-medium">全部就绪</span>
                  )}
                </div>
                {selectedItem.latestVerdict === "passed" ? (
                  <button
                    type="button"
                    disabled={handoffBusy}
                    onClick={() => handleHandoff(selectedItem.subjectKey)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  >
                    {handoffBusy ? "处理中..." : "送入商品研究池"}{" "}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              {/* Drawer Tabs */}
              <div className="border-b border-slate-200 px-6 flex gap-4 text-xs font-semibold text-slate-600">
                <button
                  type="button"
                  onClick={() => setDrawerTab("facts")}
                  className={`py-3 border-b-2 transition-colors ${
                    drawerTab === "facts"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  商品事实
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerTab("validation")}
                  className={`py-3 border-b-2 transition-colors ${
                    drawerTab === "validation"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  校验与异常 ({selectedItem.issues.length + selectedItem.riskFlags.length})
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerTab("versions")}
                  className={`py-3 border-b-2 transition-colors ${
                    drawerTab === "versions"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  来源与版本 ({selectedItem.versionCount})
                </button>
              </div>

              {/* Drawer Body */}
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
                {drawerTab === "facts" && (
                  <div className="space-y-6">
                    <div className="flex gap-4 items-start rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                      <ProductImage
                        src={selectedItem.imageUrl}
                        alt={selectedItem.title || "商品主图"}
                        className="h-24 w-24 rounded-lg"
                        iconClassName="h-8 w-8"
                        placeholderLabel="暂无主图"
                      />
                      <div className="min-w-0 flex-1 text-xs space-y-1.5">
                        <div>
                          <span className="text-slate-400">品牌：</span>
                          <span className="font-medium text-slate-800">
                            {selectedItem.brand || "— 未提供"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">类目：</span>
                          <span className="font-medium text-slate-800">
                            {selectedItem.category || "— 未提供"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">来源渠道：</span>
                          <span className="font-medium text-slate-800">
                            {selectedItem.sources.join("、") || "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">更新时间：</span>
                          <span className="text-slate-600">
                            {selectedItem.updatedAt
                              ? new Date(selectedItem.updatedAt).toLocaleString("zh-CN")
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">当前售价</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.price
                            ? `${selectedItem.price.currency} ${selectedItem.price.amount.toFixed(2)}`
                            : "— 未提供"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">预估月销量</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.estimatedMonthlySales !== null
                            ? `${selectedItem.estimatedMonthlySales.toLocaleString()} 件`
                            : "— 未提供"}
                        </div>
                        <div className="text-[12px] text-slate-400">第三方模型估算</div>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">预估月销售额</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.estimatedMonthlyRevenueUsd !== null
                            ? `$${selectedItem.estimatedMonthlyRevenueUsd.toLocaleString()}`
                            : "— 未提供"}
                        </div>
                        <div className="text-[12px] text-slate-400">第三方模型估算</div>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">评分</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.rating !== null
                            ? `★ ${selectedItem.rating.toFixed(1)}`
                            : "— 未提供"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">评论数</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.reviewCount !== null
                            ? `${selectedItem.reviewCount.toLocaleString()} 条`
                            : "— 未提供"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <div className="text-[13px] font-medium text-slate-400">BSR 排名</div>
                        <div className="mt-1 text-base font-bold text-slate-900">
                          {selectedItem.bsr
                            ? `#${selectedItem.bsr.rank.toLocaleString()}`
                            : "— 未提供"}
                        </div>
                        {selectedItem.bsr?.category ? (
                          <div className="text-[12px] text-slate-400 truncate">
                            {selectedItem.bsr.category}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 p-3 bg-slate-50 text-xs text-slate-600">
                      <p className="font-semibold text-slate-700">采集数据 ≠ 商品事实说明：</p>
                      <p className="mt-1 leading-relaxed text-slate-500">
                        外部抓取与第三方导出的数据在此处作为「来源证明」存档。缺失字段将诚实保持为空，不自动补全；进入商品研究后需人工最终确认。
                      </p>
                    </div>
                  </div>
                )}

                {drawerTab === "validation" && (
                  <div className="space-y-4">
                    <div className="rounded-lg border p-4 bg-slate-50 border-slate-200">
                      <h4 className="text-xs font-semibold text-slate-800">准入状态诊断</h4>
                      <p className="mt-1 text-xs text-slate-600">
                        {selectedItem.latestVerdict === "passed"
                          ? "该商品各项基础信息与可信度校验通过，可用于市场扫描，或送入单品研究池。"
                          : selectedItem.latestVerdict === "blocked"
                          ? "该商品命中阻断级规则，不允许进入商品研究流程。"
                          : "该商品存在字段缺失或可信度偏低，建议人工复核后再做决定。"}
                      </p>
                    </div>

                    {/* source-issue-list */}
                    <div className="source-issue-list space-y-2">
                      <h4 className="text-xs font-semibold text-slate-700">异常与风险标记</h4>
                      {selectedItem.issues.length === 0 && selectedItem.riskFlags.length === 0 ? (
                        <p className="text-xs text-slate-400 py-2">无校验异常或风险标记。</p>
                      ) : (
                        <>
                          {selectedItem.issues.map((issue, idx) => (
                            <div
                              key={idx}
                              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900"
                            >
                              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                              <div>
                                <span className="font-semibold">
                                  {ERROR_LABELS[issue.code] ?? "数据项异常"}：
                                </span>
                                <span>{issue.hint}</span>
                              </div>
                            </div>
                          ))}
                          {selectedItem.riskFlags.map((flag, idx) => (
                            <div
                              key={idx}
                              className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
                            >
                              <AlertTriangle className="h-3.5 w-3.5 text-slate-500 mt-0.5 shrink-0" />
                              <div>
                                <span className="font-semibold text-slate-800">风险：</span>
                                <span>{riskFlagLabel(flag)}</span>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>

                    {selectedItem.fieldCoverage.missingFields.length > 0 && (
                      <div className="rounded-lg border border-slate-200 p-3 bg-white">
                        <h4 className="text-xs font-semibold text-slate-700">
                          缺失字段清单（共 {selectedItem.fieldCoverage.missingFields.length} 项）
                        </h4>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {selectedItem.fieldCoverage.missingFields.map((f) => (
                            <span
                              key={f}
                              className="rounded bg-slate-100 px-2 py-0.5 text-[13px] font-medium text-slate-600"
                            >
                              {f}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {drawerTab === "versions" && (
                  <div className="space-y-4">
                    <h4 className="text-xs font-semibold text-slate-700">版本记录时间线</h4>
                    {detailLoading ? (
                      <div className="text-xs text-slate-400 py-4 text-center">
                        正在加载完整版本档案...
                      </div>
                    ) : itemDetail?.versions && itemDetail.versions.length > 0 ? (
                      <div className="space-y-3">
                        {itemDetail.versions.map((ver) => (
                          <div
                            key={ver.version}
                            className="rounded-lg border border-slate-200 p-3 bg-white space-y-1.5 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-slate-800">版本 v{ver.version}</span>
                              <span className="text-[13px] text-slate-400">
                                {ver.capturedAt
                                  ? new Date(ver.capturedAt).toLocaleString("zh-CN")
                                  : "—"}
                              </span>
                            </div>
                            <div className="text-slate-600">
                              来源类型：
                              <span className="font-medium text-slate-800">{ver.sourceType}</span>
                            </div>
                            {ver.sourceUrl ? (
                              <div className="text-slate-500 truncate">
                                URL：<span className="font-mono text-[13px]">{ver.sourceUrl}</span>
                              </div>
                            ) : null}
                            <div className="text-[13px] font-mono text-slate-400 truncate">
                              指纹：{ver.contentHash}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400">暂无多版本记录。</p>
                    )}
                  </div>
                )}

                {/* Collapsible Technical Details (source-audit-timeline) */}
                <div className="border-t border-slate-200 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowTechDetails(!showTechDetails)}
                    className="flex w-full items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-700"
                  >
                    <span>技术详情</span>
                    {showTechDetails ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  {showTechDetails && (
                    <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="font-medium text-slate-700">主体标识 SubjectKey: </span>
                          <span className="font-mono text-[13px] break-all">
                            {selectedItem.subjectKey}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyDiagnostics}
                          disabled={!itemDetail || itemDetail.audit.length === 0}
                          className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[13px] font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {copiedDiagnostics ? (
                            <Check className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          {copiedDiagnostics ? "已复制" : "复制脱敏诊断包"}
                        </button>
                      </div>
                      <div className="source-audit-timeline space-y-2 pt-2 border-t border-slate-200">
                        <span className="font-semibold text-slate-700 block">审计时间线：</span>
                        {itemDetail?.audit && itemDetail.audit.length > 0 ? (
                          itemDetail.audit.slice(-6).map((entry, idx) => (
                            <div
                              key={idx}
                              className="rounded bg-white p-2 border border-slate-200 font-mono text-[13px] space-y-0.5"
                            >
                              <div className="flex justify-between text-slate-400">
                                <span>
                                  #{entry.sequence} · {entry.eventKind}
                                </span>
                                <span>
                                  {new Date(entry.timestamp).toLocaleTimeString("zh-CN")}
                                </span>
                              </div>
                              <div className="text-slate-800">
                                {entry.module ? `${entry.module} · ` : ""}
                                {entry.eventType ?? entry.reason}
                              </div>
                              {entry.statusBefore || entry.statusAfter ? (
                                <div className="text-slate-500">
                                  状态：{entry.statusBefore ?? entry.previousState ?? "—"} → {entry.statusAfter ?? entry.nextState ?? "—"}
                                </div>
                              ) : null}
                              {entry.traceId ? (
                                <div className="text-slate-400 truncate">trace：{entry.traceId}</div>
                              ) : null}
                              {entry.evidenceRefs && entry.evidenceRefs.length > 0 ? (
                                <div className="text-slate-400 break-all">
                                  evidence：{entry.evidenceRefs.join(", ")}
                                </div>
                              ) : null}
                              {entry.reason && entry.eventType ? (
                                <div className="text-slate-600">{entry.reason}</div>
                              ) : null}
                              {entry.errorCode ? (
                                <div className="text-rose-600">错误：{entry.errorCode}</div>
                              ) : null}
                              {entry.humanRequired ? (
                                <div className="text-amber-700">需要人工接管</div>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <div className="text-slate-400 text-[13px]">暂无更深层审计日志。</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Product Modal (source-layer-bridge) */}
      {addDialogOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity"
            onClick={() => setAddDialogOpen(false)}
          />
          <div className="flex min-h-full items-center justify-center p-4">
            <div
              ref={addDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-product-dialog-title"
              className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/80">
                <div>
                  <h3
                    id="add-product-dialog-title"
                    className="text-base font-semibold text-slate-900"
                  >
                    接入新商品资料
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    选择适合的渠道录入商品来源证明，通过校验后即可用于市场扫描或深入研究。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAddDialogOpen(false)}
                  aria-label="关闭"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Connectors Tabs */}
              <div className="border-b border-slate-200 bg-white px-6 flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setAddTab("batch");
                    setAddError(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                    addTab === "batch"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <FileSpreadsheet className="h-4 w-4" /> 接入卖家精灵批次
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddTab("plugin");
                    setAddError(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                    addTab === "plugin"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <Chrome className="h-4 w-4" /> 插件数据接入
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddTab("amazon");
                    setAddError(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                    addTab === "amazon"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <Search className="h-4 w-4" /> Amazon 采集
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddTab("manual");
                    setAddError(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                    addTab === "manual"
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <PenTool className="h-4 w-4" /> 手工录入单品
                </button>
              </div>

              {/* Tab Body */}
              <div className="p-6">
                {addError && (
                  <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                    <span>{addError}</span>
                  </div>
                )}

                {addTab === "batch" && (
                  <div className="source-layer-bridge space-y-4">
                    <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4 text-xs text-emerald-900 space-y-2">
                      <p className="font-semibold text-emerald-950 flex items-center gap-1.5">
                        <Database className="h-4 w-4 text-emerald-600" /> 从当前商品批次接入来源证据
                      </p>
                      <p className="leading-relaxed text-emerald-800/90">
                        系统将从已有 SellerSprite
                        导入批次中读取原始商品数据，经校验器判定后归档为来源证据。
                        该操作为只读桥接，<strong className="font-semibold">不会修改批次本身</strong>
                        ，也不会产生重复污染。
                      </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setAddDialogOpen(false)}
                        className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={addBusy}
                        onClick={handleBridgeBatch}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {addBusy ? "正在接入批次商品..." : "一键接入批次商品"}
                      </button>
                    </div>
                  </div>
                )}

                {addTab === "plugin" && (
                  <div className="space-y-4 text-xs text-slate-600">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                      <h4 className="font-semibold text-slate-800 flex items-center gap-2">
                        <Chrome className="h-4 w-4 text-slate-500" /> 插件通道当前状态
                      </h4>
                      <ul className="list-disc list-inside space-y-2 text-slate-600 leading-relaxed">
                        <li>
                          本页的插件通道是
                          <strong className="font-semibold text-slate-800">数据接收端</strong>
                          ：工作台已实现卖家精灵插件行数据接入接口，可接收符合既有插件契约的商品行，经服务端校验后归档为来源证据。
                        </li>
                        <li>
                          工作台
                          <strong className="font-semibold text-slate-800">
                            当前不包含、也不提供可安装的 Amazon 采集插件
                          </strong>
                          ；插件采集由浏览器端完成，采集完成后数据需通过既有插件流程接入。
                        </li>
                        <li>
                          当前需通过既有插件流程接入。若暂时没有该外部工具，请改用本弹窗内的「接入卖家精灵批次」或「手工录入单品」。
                        </li>
                      </ul>
                    </div>
                    <p className="text-[13px] text-slate-400">
                      * 网页端不提供跨进程抓取按钮，也不会代为采集；所有来源数据都必须来自可追溯的既有流程。
                    </p>
                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        onClick={() => setAddDialogOpen(false)}
                        className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        我知道了
                      </button>
                    </div>
                  </div>
                )}

                {addTab === "amazon" && (
                  <AmazonCapturePanel
                    onCaptured={(message) => {
                      setNotice(message);
                      setAddDialogOpen(false);
                    }}
                    onRefresh={() => void loadInbox()}
                  />
                )}

                {addTab === "manual" && (
                  <form onSubmit={handleManualSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          ASIN <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="B0XXXXXXXX"
                          value={asin}
                          onChange={(e) => setAsin(e.target.value)}
                          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono uppercase text-slate-900 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          商品页面链接 <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="url"
                          required
                          placeholder="https://www.amazon.com/dp/..."
                          value={productUrl}
                          onChange={(e) => setProductUrl(e.target.value)}
                          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        商品标题（可选）
                      </label>
                      <input
                        type="text"
                        placeholder="输入商品标题或简短描述"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>

                    <div className="border-t border-slate-100 pt-3">
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className="flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700"
                      >
                        {showAdvanced ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        {showAdvanced
                          ? "收起详细市场字段"
                          : "补充详细市场字段（价格、评分、排名等）"}
                      </button>

                      {showAdvanced && (
                        <div className="mt-3 space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-[13px] font-medium text-slate-600">
                                售价 (USD)
                              </label>
                              <input
                                type="number"
                                step="0.01"
                                placeholder="29.99"
                                value={price}
                                onChange={(e) => setPrice(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              />
                            </div>
                            <div>
                              <label className="block text-[13px] font-medium text-slate-600">
                                评分 (1-5)
                              </label>
                              <input
                                type="number"
                                step="0.1"
                                placeholder="4.5"
                                value={rating}
                                onChange={(e) => setRating(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              />
                            </div>
                            <div>
                              <label className="block text-[13px] font-medium text-slate-600">
                                评论数
                              </label>
                              <input
                                type="number"
                                placeholder="120"
                                value={reviewCount}
                                onChange={(e) => setReviewCount(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[13px] font-medium text-slate-600">
                                BSR 排名
                              </label>
                              <input
                                type="number"
                                placeholder="1500"
                                value={bsrRank}
                                onChange={(e) => setBsrRank(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              />
                            </div>
                            <div>
                              <label className="block text-[13px] font-medium text-slate-600">
                                BSR 类目
                              </label>
                              <select
                                value={bsrCategory}
                                onChange={(e) => setBsrCategory(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              >
                                <option value="">选择类目</option>
                                {AMAZON_US_TOP_LEVEL_CATEGORIES.map((cat) => (
                                  <option key={cat.value} value={cat.value}>
                                    {cat.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div>
                            <label className="block text-[13px] font-medium text-slate-600">
                              主图图片链接（每行一个）
                            </label>
                            <textarea
                              rows={2}
                              placeholder="https://images-na.ssl-images-amazon.com/..."
                              value={imagesText}
                              onChange={(e) => setImagesText(e.target.value)}
                              className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs font-mono"
                            />
                          </div>

                          <div>
                            <label className="block text-[13px] font-medium text-slate-600">
                              核心关键词（逗号或换行分隔）
                            </label>
                            <input
                              type="text"
                              placeholder="例：insulated water bottle（英文关键词）"
                              value={keywordsText}
                              onChange={(e) => setKeywordsText(e.target.value)}
                              className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setAddDialogOpen(false)}
                        className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {addBusy ? "正在保存证据..." : "确认录入"}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
