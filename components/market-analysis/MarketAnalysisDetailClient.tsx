"use client";

import Link from "next/link";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import comparisonStyles from "./MarketComparison.module.css";
import gateStyles from "./MarketDecisionGate.module.css";
import { GATE_STATUS_LABELS, gateSemanticsFor } from "./gateStatusLabels";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Compass,
  DollarSign,
  ExternalLink,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  Tag,
  Trash2,
  TrendingUp,
  Users,
} from "lucide-react";

import type { MarketDecisionReadiness } from "@/lib/marketScan/marketDecisionReadiness";
import type { MarketScopeAnalysisV1, MarketScopeItemAnalysis, SourceBatchCoverageV1 } from "@/lib/marketScan/marketScopeAnalysis";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { WORKFLOW_STAGE_META } from "@/lib/workflow/workflowResolver";
import { MarketSampleIdentity, MarketSamplePrice } from "@/components/market-analysis/MarketSampleFacts";
import { localizeSampleSourceType, localizeScopeReviewStatus } from "@/lib/client/bilingualDisplay";
import { CategoryMarketEvidencePanel } from "@/components/market-analysis/CategoryMarketEvidencePanel";
import { MarketIntelligencePanel, type MarketResearchTab } from "@/components/market-analysis/MarketIntelligencePanel";
import type { MarketIntelligence, MarketIntelligenceReport, MarketResearchRecommendation } from "@/lib/marketScan/intelligence";
import { recommendationDraftNote, type OpportunityResearchSelection, type OpportunityResearchSnapshot } from "@/lib/marketScan/opportunityResearch";
import { MarketSampleScopePanel } from "@/components/market-analysis/MarketSampleScopePanel";
import {
  analyzeSampleHomogeneity,
  filterSamplesBySubtype,
  type SampleSubtypeId,
} from "@/lib/marketScan/sampleHomogeneity";
import type { MarketSampleScopeProjection } from "@/lib/marketScan/marketSampleScope";
import type { ScopeConfirmationRow, ScopeConfirmationSummary } from "@/lib/marketScan/scopeConfirmation";
import { ScopeConfirmationPanel } from "@/components/market-analysis/ScopeConfirmationPanel";
import { MarketHandoffPanel } from "@/components/market-analysis/MarketHandoffPanel";
import { MarketDecisionWorkspace } from "@/components/market-analysis/MarketDecisionWorkspace";
import decisionStyles from "@/components/market-analysis/MarketDecisionWorkspace.module.css";
import { trustedSampleImageUrl } from "@/components/market-analysis/MarketResearchReport";
import { ProductIdentity } from "@/components/ui/ProductIdentity";
import { DataTable } from "@/components/ui/DataTable";
import { BulkActionBar } from "@/components/ui/BulkActionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { marketSampleKeyFor, representativeDraftMatches, resolveResearchHandoffSamples, resolveSelectedMarketSamples, restoreRepresentativeSelection } from "@/components/market-analysis/marketSampleSelection";

type MarketSampleItem = {
  marketSampleKey?: string;
  asin: string;
  subjectKey: string;
  title: string | null;
  imageUrl: string | null;
  brand?: string | null;
  price?: number | null;
  priceCurrency?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  monthlySalesEstimate?: number | null;
  sourceType: string;
  evidenceVersion: number;
  capturedAt: string;
  candidateId?: string | null;
  taskId?: string | null;
  archivedAt?: string | null;
  /** 服务端 sample resourceVersion 是 hash 字符串；旧字段 version 与其同值。 */
  version?: string;
  resourceVersion?: string;
  marketScope?: MarketScopeItemAnalysis;
  /** P3 人工范围确认（与系统子类型、门禁无关） */
  scopeReview?: ScopeConfirmationRow | null;
};

type MarketGateStatus = "PENDING" | "PROCEED" | "VALIDATE_MORE" | "PAUSE" | "DROP";
type RepresentativeRole = "benchmark" | "newcomer" | "pain_point";

type MetricDistribution = {
  min: number;
  max: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  sampleSize: number;
  missingCount: number;
};

type Concentration = {
  ratio: number | null;
  usedSampleCount: number;
  missingCount: number;
  topN: Array<{ rank: number; key: string; value: number; share: number }>;
};

type MarketScanDetail = {
  id: string;
  scanName: string;
  marketplace: string;
  sampleCount: number;
  metricsVersion: string | number;
  sampleHash: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  resourceVersion?: string;
  scopeNotice?: string;
  marketScopeAnalysis?: MarketScopeAnalysisV1;
  /** 服务端样本范围投影：区分「技术有效」与「符合研究范围」，只读，不参与门禁 */
  sampleScope?: MarketSampleScopeProjection;
  /** P3 人工范围确认统计（有效/未确认/过期） */
  scopeReviewSummary?: ScopeConfirmationSummary;
  sourceBatchCoverage?: SourceBatchCoverageV1 | null;
  feishuSync?: {
    baseOpenUrl?: string;
    lastSyncedAt?: string;
  };
  sampleItems: MarketSampleItem[];
  decisionReadiness?: MarketDecisionReadiness;
  marketGate?: {
    status: MarketGateStatus;
    effectiveStatus: MarketGateStatus;
    reason: string | null;
    chosenAt: string | null;
    stale: boolean;
    staleReason: string | null;
    missingDataAcknowledged?: boolean;
  };
  representatives?: {
    items: Array<{ marketSampleKey: string; asin: string; subjectKey: string; role: RepresentativeRole; note: string | null; researchContext?: OpportunityResearchSnapshot }>;
  };
  parentVariationDedup?: {
    status: "APPLIED" | "NOT_AVAILABLE";
    basis: string;
    groupsCollapsed: number;
    sourceItemCount: number;
    retainedItemCount: number;
    notice: string;
  };
  metrics?: {
    price?: {
      status: string;
      value?: MetricDistribution | null;
    };
    sales?: {
      status: string;
      value?: {
        total: number;
        median: number;
        distribution?: MetricDistribution;
      } | null;
      sampleSize?: number;
      missingCount?: number;
    };
    brandConcentration?: {
      brandCr5?: {
        status: string;
        value?: Concentration | null;
      };
      brandCr3?: {
        status: string;
        value?: Concentration | null;
      };
      uniqueBrandCount?: {
        status: string;
        value?: number | null;
      };
    };
    salesConcentration?: {
      cr5?: {
        status: string;
        value?: Concentration | null;
      };
    };
    rating?: {
      averageRating?: {
        status: string;
        value?: number | null;
      };
      medianRating?: {
        status: string;
        value?: number | null;
      };
    };
    reviews?: {
      medianReviewCount?: {
        status: string;
        value?: number | null;
      };
      topReviewThreshold?: {
        status: string;
        value?: {
          thresholdReviewCount: number;
        } | null;
      };
    };
    newEntrants?: {
      newProductShare90d?: {
        status: string;
        value?: number | null;
      };
      newProductCount90d?: {
        status: string;
        value?: number | null;
      };
    };
  };
};

function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "— 未提供";
  return `$${amount.toFixed(2)}`;
}

function formatScopeMoney(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return "— 未提供";
  return currency === "USD" ? `$${amount.toFixed(2)}` : `${currency ?? "未知币种"} ${amount.toFixed(2)}`;
}

function evidenceStatusLabel(status: string): string {
  if (status === "limited_evidence") return "证据有限";
  if (status === "ready") return "证据可用";
  return "证据状态待确认";
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined || !Number.isFinite(num)) return "— 未提供";
  return num.toLocaleString();
}

function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "— 未提供";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 样本来源的用户可读标签（技术枚举不直接暴露给用户）。 */
const SAMPLE_SOURCE_LABELS: Record<string, string> = {
  amazon_dom: "Amazon 页面采集",
  amazon_search_capture: "Amazon 搜索采集",
  sellersprite: "卖家精灵",
  sellersprite_xlsx: "卖家精灵导入",
  keepa: "Keepa 数据",
  manual_import: "人工导入",
};

function sampleSourceLabel(sourceType: string): string {
  return localizeSampleSourceType(sourceType);
}

/** 样本行的中文辅助说明：系统子类型 + 人工范围确认状态（展示层派生，不写回数据）。 */
function sampleChineseHint(item: MarketSampleItem, assignments: ReadonlyArray<{ asin: string; subtypeLabel: string }>): string {
  const subtype = assignments.find((entry) => entry.asin === String(item.asin).toUpperCase())?.subtypeLabel;
  const review = item.scopeReview;
  const status = review?.reviewStale ? "STALE" : (review?.reviewStatus ?? "UNREVIEWED");
  const parts = [subtype, localizeScopeReviewStatus(status)].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

/** 兼容迁移：旧快照里持久化的工程词 notice 在展示层转成用户语言（不回写数据）。 */
function humanizeParentVariationNotice(notice: string): string {
  return notice
    .replace(/^PARENT_VARIATION_DEDUP=NOT_AVAILABLE[：:]/, "父子变体合并未执行：")
    .replace(/family identity/g, "同族标识")
    .trim();
}



export function MarketAnalysisDetailClient({ scanId }: { scanId: string }) {
  const router = useRouter();
  const [researchTab, setResearchTab] = useState<MarketResearchTab>("研究总览");
  /** P1-HANDOFF-UX：研究区与「决策与交接」工作区是两个视图；URL 用 ?view=decision 表达，刷新/前进后退都不丢。 */
  const [decisionView, setDecisionView] = useState(false);
  /** 已通过且未失效时默认折叠人工判断；待判断/失效/被拦截时展开。 */
  const [gateOpen, setGateOpen] = useState(false);
  const [researchData, setResearchData] = useState<MarketIntelligence | null>(null);
  const [intelligenceRefresh, setIntelligenceRefresh] = useState(0);
  const receiveIntelligence = useCallback((data: MarketIntelligence) => setResearchData(data), []);
  const [marketView, setMarketView] = useState("market-gate-section");
  /** 三个工作区：判断 / 样本与代表商品 / 依据与记录；工作区只决定默认可见分节，不隐藏任何业务数据。 */
  const [marketWorkspace, setMarketWorkspace] = useState<"judgment" | "samples" | "records">("judgment");
  // Explorer links target the existing formal tab; saving and handoff stay unchanged.
  useEffect(() => {
    const views: Record<string, MarketResearchTab> = { overview: "研究总览", competition: "市场竞争", keywords: "关键词与需求", voc: "买家声音", compare: "商品对比", gate: "研究总览" };
    const tab = views[new URLSearchParams(window.location.search).get("view") ?? ""];
    if (tab) {
      setResearchTab(tab);
      setMarketWorkspace(tab === "商品对比" ? "samples" : "judgment");
    }
  }, [scanId]);
  const [scan, setScan] = useState<MarketScanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [marketGateReason, setMarketGateReason] = useState("");
  const [missingDataAcknowledged, setMissingDataAcknowledged] = useState(false);
  const [noteBySampleKey, setNoteBySampleKey] = useState<Record<string, string>>({});
  const [roleBySampleKey, setRoleBySampleKey] = useState<Record<string, RepresentativeRole>>({});
  const [recommendationBySampleKey, setRecommendationBySampleKey] = useState<Record<string, OpportunityResearchSelection>>({});
  const [benchmarkNotice, setBenchmarkNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [invalidRepresentativeKeys, setInvalidRepresentativeKeys] = useState<Set<string>>(new Set());

  // Search filter
  const [sampleSearch, setSampleSearch] = useState("");
  /** 样本子类型筛选：仅视图过滤，不改变统计口径。 */
  const [activeSubtype, setActiveSubtype] = useState<SampleSubtypeId | "all">("all");
  const [showTechDetails, setShowTechDetails] = useState(false);
  /** 样本列表：按人工范围确认状态筛选 + 表格/分组两种读法。 */
  const [scopeReviewFilter, setScopeReviewFilter] = useState<"all" | "todo" | "in" | "out" | "stale">("all");
  const [samplesView, setSamplesView] = useState<"table" | "grouped">("table");

  // TanStack table selection
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // Single / Bulk confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    action: () => Promise<void>;
  }>({
    open: false,
    title: "",
    message: "",
    action: async () => {},
  });

  const hasLoadedRef = useRef(false);

  const loadScan = useCallback(async () => {
    // 首次加载显示整页 loading；之后刷新不再卸载页面，避免丢失面板内的筛选/选择/提示状态。
    if (!hasLoadedRef.current) setLoading(true);
    setErrorMsg(null);
    try {
      // 1. Try canonical /api/market-analysis/{scanId}
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scanId)}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });

      if (res.ok) {
        const json = await res.json();
        const data = json.data || json;
        setScan(data);
        setMarketGateReason(data.marketGate?.reason ?? "");
        setMissingDataAcknowledged(data.marketGate?.missingDataAcknowledged === true);
        setNoteBySampleKey(Object.fromEntries((data.representatives?.items ?? []).map((item: { marketSampleKey: string; note: string | null }) => [item.marketSampleKey, item.note ?? ""])));
        setRoleBySampleKey(Object.fromEntries((data.representatives?.items ?? []).map((item: { marketSampleKey: string; role: RepresentativeRole }) => [item.marketSampleKey, item.role])));
        setRowSelection(restoreRepresentativeSelection(
          data.id,
          data.sampleItems ?? [],
          data.representatives?.items ?? [],
        ));
        return;
      }

      // 正式 V5 契约：canonical market-analysis 详情失败时如实报错，
      // 不再回退旧的 market-scan 兼容接口。
      const errJson = await res.json().catch(() => null);
      throw new Error(errJson?.error?.message || `读取市场研究详情失败 (${res.status})`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "读取市场研究详情失败");
    } finally {
      setLoading(false);
      hasLoadedRef.current = true;
    }
  }, [scanId]);

  useEffect(() => {
    loadScan();
  }, [loadScan]);

  // 样本同质性：只做确定性标题分类，不参与任何统计计算。
  const homogeneity = useMemo(
    () => analyzeSampleHomogeneity((scan?.sampleItems ?? []).map((item) => ({ asin: item.asin, title: item.title ?? null }))),
    [scan],
  );

  // Filtered samples：搜索 + 子类型筛选，二者都只影响列表显示，不改变统计口径。
  const scopeStatusOf = useCallback((item: MarketSampleItem): string => {
    return item.scopeReview?.reviewStale ? "STALE" : (item.scopeReview?.reviewStatus ?? "UNREVIEWED");
  }, []);

  const filteredSamples = useMemo(() => {
    if (!scan?.sampleItems) return [];
    const bySubtype = filterSamplesBySubtype(scan.sampleItems, homogeneity.assignments, activeSubtype);
    const byScope = scopeReviewFilter === "all" ? bySubtype : bySubtype.filter((item) => scopeStatusOf(item) === (scopeReviewFilter === "todo" ? "UNREVIEWED" : scopeReviewFilter === "in" ? "IN_SCOPE" : scopeReviewFilter === "out" ? "OUT_OF_SCOPE" : "STALE"));
    if (!sampleSearch.trim()) return byScope;
    const q = sampleSearch.trim().toLowerCase();
    return byScope.filter(
      (item) =>
        item.asin.toLowerCase().includes(q) ||
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.brand && item.brand.toLowerCase().includes(q)) ||
        item.sourceType.toLowerCase().includes(q)
    );
  }, [scan, sampleSearch, homogeneity, activeSubtype, scopeReviewFilter, scopeStatusOf]);

  /** 分组读法：按人工范围确认状态把样本分三组，避免 34 条平铺。 */
  const sampleGroups = useMemo(() => {
    const groups = { in: [] as MarketSampleItem[], out: [] as MarketSampleItem[], todo: [] as MarketSampleItem[] };
    for (const item of filteredSamples) {
      const status = scopeStatusOf(item);
      if (status === "IN_SCOPE") groups.in.push(item);
      else if (status === "OUT_OF_SCOPE") groups.out.push(item);
      else groups.todo.push(item);
    }
    return groups;
  }, [filteredSamples, scopeStatusOf]);

  const scopeReviewCounts = useMemo(() => {
    const all = scan?.sampleItems ?? [];
    return {
      all: all.length,
      todo: all.filter((item) => scopeStatusOf(item) === "UNREVIEWED").length,
      in: all.filter((item) => scopeStatusOf(item) === "IN_SCOPE").length,
      out: all.filter((item) => scopeStatusOf(item) === "OUT_OF_SCOPE").length,
      stale: all.filter((item) => scopeStatusOf(item) === "STALE").length,
    };
  }, [scan, scopeStatusOf]);

  // Selected items list
  const selectedItems = useMemo(() => {
    if (!scan) return [];
    return resolveSelectedMarketSamples(scan.id, scan.sampleItems, rowSelection);
  }, [rowSelection, scan]);

  const savedRepresentativeItems = useMemo(() => {
    if (!scan?.representatives?.items?.length) return [];
    return resolveResearchHandoffSamples(scan.id, scan.sampleItems, scan.representatives.items);
  }, [scan]);

  const representativeDraftSaved = useMemo(() => !scan || (!selectedItems.some((item) => recommendationBySampleKey[marketSampleKeyFor(scan.id,item)]) && representativeDraftMatches(
    selectedItems.map((item,index) => { const key=marketSampleKeyFor(scan.id,item); return {marketSampleKey:key,role:roleBySampleKey[key]??(["benchmark","newcomer","pain_point"] as const)[index%3],note:noteBySampleKey[key]??""}; }),
    scan.representatives?.items ?? [],
  )), [scan,selectedItems,roleBySampleKey,noteBySampleKey,recommendationBySampleKey]);

  const adoptRecommendation = (report: MarketIntelligenceReport, recommendation: MarketResearchRecommendation) => {
    if (!scan) return;
    const sample = scan.sampleItems.find((item) => item.subjectKey === recommendation.subjectKey);
    if (!sample) return;
    const key = marketSampleKeyFor(scan.id, sample);
    setRowSelection((current) => ({ ...current, [key]: true }));
    setNoteBySampleKey((current) => ({ ...current, [key]: current[key]?.trim() ? current[key] : recommendationDraftNote(report, recommendation) }));
    setRoleBySampleKey((current) => ({ ...current, [key]: current[key] ?? recommendation.role }));
    setRecommendationBySampleKey((current) => ({ ...current, [key]: { reportId: report.id, inputHash: report.inputHash, opportunityIds: recommendation.opportunityIds } }));
    setActionNotice({ type: "success", message: "已加入选择草稿，已有手填理由保留。请核对角色与理由，再保存代表商品；尚未创建商品研究任务。" });
    document.getElementById("benchmark-selection-section")?.setAttribute("open", "");
  };

  const roleLabel = (role: RepresentativeRole) => role === "benchmark" ? "基准商品" : role === "newcomer" ? "新进入者" : "痛点样本";

  /** 市场闸门状态的中文标签（枚举只作技术辅助，不直接暴露）。 */
  const gateStatusLabel = (status: MarketGateStatus) => GATE_STATUS_LABELS[status];

  /** 业务跳转：先切到目标所在工作区，再显示对应分节，最后回到工作区导航。 */
  const scrollToSection = useCallback((id: string) => {
    const workspace: "judgment" | "samples" | "records" =
      id === "category-market-evidence-section" ? "records" : id === "market-gate-section" ? "judgment" : "samples";
    setMarketWorkspace(workspace);
    setResearchTab(workspace === "judgment" ? "研究总览" : "商品对比");
    setMarketView(id);
    requestAnimationFrame(() => { const target = document.querySelector(`#${id}`); if (target instanceof HTMLDetailsElement) target.open = true; target?.scrollIntoView({ behavior: document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth", block: "start" }); });
  }, []);

  /** 工作区内定位：不切换研究 Tab，只把目标分节滚到视野内。 */
  const scrollWithinDecision = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const target = document.querySelector(`#${id}`);
      if (target instanceof HTMLDetailsElement) target.open = true;
      target?.scrollIntoView({ behavior: document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth", block: "start" });
    });
  }, []);

  /** 打开/关闭「决策与交接」工作区：URL 用 ?view=decision，刷新与前进后退都保持一致。 */
  const openDecision = useCallback(() => {
    setDecisionView(true);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "decision");
    window.history.pushState({ view: "decision" }, "", url);
    window.scrollTo({ top: 0, behavior: document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth" });
  }, []);

  const closeDecision = useCallback(() => {
    setDecisionView(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.pushState({ view: "research" }, "", url);
    window.scrollTo({ top: 0, behavior: document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    const read = () => setDecisionView(new URLSearchParams(window.location.search).get("view") === "decision");
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  // 判断状态变化时同步折叠态：通过→折叠，失效/未通过→展开；理由输入存在父级 state，折叠不会清空。
  useEffect(() => {
    const ready = scan?.marketGate?.effectiveStatus === "PROCEED" && !scan?.marketGate?.stale;
    setGateOpen(!ready);
  }, [scan?.marketGate?.effectiveStatus, scan?.marketGate?.stale]);

  // 决策工作区不渲染五区面板，需要自己取一次只读研究投影（商品图/译文/统计都在里面）。
  useEffect(() => {
    if (!decisionView || researchData || !scan) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/intelligence`, { headers: buildAccessHeaders(), cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && body?.ok && body.data) setResearchData(body.data as MarketIntelligence);
      } catch { /* 只读投影失败时保留未知，不伪造商品图或统计 */ }
    })();
    return () => { cancelled = true; };
  }, [decisionView, researchData, scan]);

  // Handlers
  const handleMarketGate = useCallback(async (status: MarketGateStatus) => {    if (!scan) return;
    setBusy(true);
    setActionNotice(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/market-gate`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ status, missingDataAcknowledged, reason: marketGateReason.trim() || null, expectedScanHash: scan.sampleHash, expectedVersion: scan.resourceVersion ?? scan.updatedAt, idempotencyKey }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? `保存市场闸门（Market Gate）失败 (${res.status})`);
      setActionNotice({ type: "success", message: `市场闸门（Market Gate）已保存：${status === "PROCEED" ? "进入代表商品选择" : status === "VALIDATE_MORE" ? "需补充验证" : status === "PAUSE" ? "暂缓" : status === "DROP" ? "放弃" : "待处理"}。` });
      await loadScan();
      if (status === "PROCEED") {
        setTimeout(() => scrollWithinDecision("benchmark-selection-section"), 150);
      }
    } catch (error) {
      setActionNotice({ type: "error", message: error instanceof Error ? error.message : "保存市场闸门（Market Gate）失败" });
    } finally {
      setBusy(false);
    }
  }, [loadScan, marketGateReason, missingDataAcknowledged, scan, scrollWithinDecision]);

  const handleProceedClick = useCallback(() => {
    if (scan?.marketGate?.effectiveStatus === "PROCEED" && marketGateReason.trim() === (scan.marketGate?.reason ?? "").trim()) {
      setActionNotice({ type: "success", message: "已允许继续研究，正在引导至代表商品选择区域。" });
      scrollWithinDecision("benchmark-selection-section");
      return;
    }
    void handleMarketGate("PROCEED");
  }, [handleMarketGate, marketGateReason, scan, scrollWithinDecision]);

  const handleSaveRepresentatives = useCallback(async () => {
    setBenchmarkNotice(null);
    if (!scan || selectedItems.length < 1) {
      const msg = "请至少勾选 1 款代表商品。";
      setActionNotice({ type: "error", message: msg });
      setBenchmarkNotice({ type: "error", message: msg });
      return;
    }
    if (scan.marketGate?.effectiveStatus !== "PROCEED") {
      const msg = "请先通过上方市场闸门（Market Gate），再保存代表商品。";
      setActionNotice({ type: "error", message: msg });
      setBenchmarkNotice({ type: "error", message: msg });
      return;
    }

    // Client-side pre-validation: all selected items must have a non-empty note (1-1000 chars)
    const invalidKeys = new Set<string>();
    const itemsToSave = selectedItems.map((item, index) => {
      const key = marketSampleKeyFor(scan.id, item);
      const note = (noteBySampleKey[key] ?? "").trim();
      const role = roleBySampleKey[key] ?? (["benchmark", "newcomer", "pain_point"] as const)[index % 3];
      if (!note || note.length > 1000) {
        invalidKeys.add(key);
      }
      return {
        marketSampleKey: key,
        asin: item.asin,
        subjectKey: item.subjectKey,
        note,
        role,
        ...(recommendationBySampleKey[key] ? { researchRecommendation: recommendationBySampleKey[key] } : {}),
      };
    });

    if (invalidKeys.size > 0) {
      setInvalidRepresentativeKeys(invalidKeys);
      const errorMsg = `还有 ${invalidKeys.size} 款代表商品未填写选择理由（必填，1～1000 字符），请补充后再保存。`;
      setActionNotice({ type: "error", message: errorMsg });
      setBenchmarkNotice({ type: "error", message: errorMsg });
      const firstInvalidItem = itemsToSave.find((item) => invalidKeys.has(item.marketSampleKey));
      if (firstInvalidItem) {
        const targetId = `rep-card-${firstInvalidItem.marketSampleKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const textarea = el.querySelector("textarea");
          textarea?.focus();
        }
      }
      return;
    }

    setInvalidRepresentativeKeys(new Set());

    // Check already saved unchanged state (non-silent no-op prevention)
    const savedItems = scan.representatives?.items ?? [];
    if (savedItems.length === itemsToSave.length) {
      const allMatch = itemsToSave.every((item) => {
        const match = savedItems.find((s) => s.marketSampleKey === item.marketSampleKey);
        return !item.researchRecommendation && match && match.role === item.role && (match.note ?? "").trim() === item.note;
      });
      if (allMatch) {
        const msg = `当前 ${itemsToSave.length} 款代表商品已保存，无需重复保存。`;
        setActionNotice({ type: "success", message: msg });
        setBenchmarkNotice({ type: "info", message: msg });
        return;
      }
    }

    setBusy(true);
    setActionNotice(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/representatives`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          expectedScanHash: scan.sampleHash,
          expectedVersion: scan.resourceVersion ?? scan.updatedAt,
          idempotencyKey,
          items: itemsToSave,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? `保存代表商品失败 (${res.status})`);
      
      await loadScan();
      setRecommendationBySampleKey({});
      const successMsg = `已保存 ${itemsToSave.length} 款代表商品及其角色，可继续发起商品研究。`;
      setActionNotice({ type: "success", message: successMsg });
      setBenchmarkNotice({ type: "success", message: successMsg });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "保存代表商品失败";
      setActionNotice({ type: "error", message: errMsg });
      setBenchmarkNotice({ type: "error", message: errMsg });
    } finally {
      setBusy(false);
    }
  }, [loadScan, noteBySampleKey, roleBySampleKey, scan, selectedItems, recommendationBySampleKey]);

  // 1. Research handoff: only persisted representatives may enter the research chain.
  const handleResearchHandoff = useCallback(async (requestedMarketSampleKey?: string) => {
    if (!scan || scan.marketGate?.effectiveStatus !== "PROCEED") {
      setActionNotice({ type: "error", message: "请先通过市场闸门（Market Gate）。" });
      return;
    }
    const handoffItems = requestedMarketSampleKey === undefined
      ? savedRepresentativeItems
      : resolveResearchHandoffSamples(scan.id, scan.sampleItems, scan.representatives?.items ?? [], requestedMarketSampleKey);
    if (requestedMarketSampleKey !== undefined && handoffItems.length !== 1) {
      setActionNotice({ type: "error", message: "该商品尚未保存为代表商品，请先保存该商品的代表角色，再发起商品研究。" });
      return;
    }
    if (handoffItems.length < 1 || handoffItems.length > 50) {
      setActionNotice({
        type: "error",
        message: "请先保存 1～50 款代表商品；界面推荐先选择 1–50 款。",
      });
      return;
    }

    setBusy(true);
    setActionNotice(null);

    try {
      const payload = {
        selections: handoffItems.map((item) => ({
          marketSampleKey: marketSampleKeyFor(scan.id, item),
          asin: item.asin,
          subjectKey: item.subjectKey || `asin:${item.asin}`,
          role: scan.representatives?.items.find((rep) => rep.marketSampleKey === marketSampleKeyFor(scan.id, item))?.role ?? "benchmark",
        })),
        expectedScanHash: scan.sampleHash,
        idempotencyKey: crypto.randomUUID(),
      };

      // Try canonical /api/market-analysis/{scanId}/research-handoff
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/research-handoff`, {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // 正式 V5 契约：canonical research-handoff 失败时如实报错，
        // 不再回退旧 /api/opportunity-candidates/from-market-screening。
        const json = await res.json().catch(() => null);
        const code = json?.error?.code || json?.code;
        if (code === "MARKET_SNAPSHOT_STALE") {
          throw new Error("市场扫描快照版本已过期，请刷新页面重新确认后送出。");
        } else if (code === "SELECTION_LIMIT_INVALID") {
          throw new Error("送去研究的样本数必须在 1–50 款之间。");
        }
        throw new Error(json?.error?.message || `发起研究失败 (${res.status})`);
      }

      const result = await res.json();
      const firstTask = result.items?.[0]?.taskId || result.data?.items?.[0]?.taskId;

      setActionNotice({
        type: "success",
        message: `已成功发起 ${handoffItems.length} 款代表商品的深度研究！正在跳转...`,
      });

      if (requestedMarketSampleKey === undefined) setRowSelection({});
      setTimeout(() => {
        if (firstTask) {
          router.push(`/research/${encodeURIComponent(firstTask)}`);
        } else {
          router.push(WORKFLOW_STAGE_META.PRODUCT_RESEARCH.href);
        }
      }, 1000);
    } catch (err) {
      setActionNotice({
        type: "error",
        message: err instanceof Error ? err.message : "送去研究失败",
      });
    } finally {
      setBusy(false);
    }
  }, [savedRepresentativeItems, scan, router]);

  // 3. Scan Archive / Restore / Safe Delete
  const handleScanAction = useCallback(
    (action: "archive" | "restore" | "delete") => {
      if (!scan) return;
      const actionName = action === "archive" ? "归档" : action === "restore" ? "恢复" : "删除";

      setConfirmDialog({
        open: true,
        title: `确认${actionName}该市场研究？`,
        message:
          action === "delete"
            ? "注意：物理删除仅在无下游研究任务引用的草稿状态下允许。若已被商品研究或候选引用，系统将阻止删除并建议归档。"
            : `归档后此市场研究将从日常可见列表中隐藏，历史样本快照与指标保持不变。`,
        action: async () => {
          setBusy(true);
          try {
            const res = await fetch(
              `/api/market-analysis/${encodeURIComponent(scan.id)}/${action}`,
              {
                method: "POST",
                headers: {
                  ...buildAccessHeaders(),
                  "Content-Type": "application/json",
                  "Idempotency-Key": crypto.randomUUID(),
                },
                body: JSON.stringify({
                  expectedVersion: scan.resourceVersion || scan.updatedAt || scan.metricsVersion || 1,
                  idempotencyKey: crypto.randomUUID(),
                }),
              }
            );

            if (!res.ok) {
              const json = await res.json().catch(() => null);
              const code = json?.error?.code || json?.code;
              if (code === "DELETE_DEPENDENCY_BLOCKED" || code === "MARKET_SCAN_DELETE_FORBIDDEN") {
                throw new Error("该市场研究已被下游商品研究或候选引用，受引用保护禁止物理删除。请使用【归档】。");
              }
              throw new Error(json?.error?.message || `${actionName}失败 (${res.status})`);
            }

            if (action === "delete") {
              router.push("/market-analysis");
            } else {
              loadScan();
            }
          } catch (err) {
            setActionNotice({
              type: "error",
              message: err instanceof Error ? err.message : `${actionName}失败`,
            });
          } finally {
            setBusy(false);
            setConfirmDialog((prev) => ({ ...prev, open: false }));
          }
        },
      });
    },
    [scan, router, loadScan]
  );

  // 4. Sample bulk action (Archive / Restore / Delete)
  const handleSampleBulkAction = useCallback(
    (action: "archive" | "restore" | "delete") => {
      if (selectedItems.length === 0 || !scan) return;
      const actionName = action === "archive" ? "归档" : action === "restore" ? "恢复" : "删除";

      setConfirmDialog({
        open: true,
        title: `确认批量${actionName}选中的 ${selectedItems.length} 个样本？`,
        message:
          action === "delete"
            ? "物理删除仅对无下游引用的样本有效。已送去深度研究的样本将被系统拒绝物理删除，建议改用归档。"
            : `选中的 ${selectedItems.length} 个样本将执行${actionName}操作。`,
        action: async () => {
          setBusy(true);
          try {
            const payload = {
              resource: "market_sample" as const,
              action,
              items: selectedItems.map((s) => ({
                id: marketSampleKeyFor(scan.id, s),
                expectedVersion: s.version || s.resourceVersion || "",
              })),
              idempotencyKey: crypto.randomUUID(),
            };

            const res = await fetch("/api/market-analysis/bulk-actions", {
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
              throw new Error(json?.error?.message || `批量${actionName}失败`);
            }

            const succeeded = json?.data?.succeeded ?? 0;
            const failed = json?.data?.failed ?? 0;

            if (failed > 0) {
              setActionNotice({
                type: "error",
                message: `批量${actionName}部分完成：成功 ${succeeded} 项，失败 ${failed} 项（若被研究任务引用则受保护无法删除）。`,
              });
            } else {
              setActionNotice({
                type: "success",
                message: `成功${actionName} ${succeeded} 个样本。`,
              });
            }

            setRowSelection({});
            loadScan();
          } catch (err) {
            setActionNotice({
              type: "error",
              message: err instanceof Error ? err.message : `批量${actionName}失败`,
            });
          } finally {
            setBusy(false);
            setConfirmDialog((prev) => ({ ...prev, open: false }));
          }
        },
      });
    },
    [selectedItems, scan, loadScan]
  );

  // TanStack columns
  const sampleColumns = useMemo<ColumnDef<MarketSampleItem>[]>(
    () => {
      const columns: ColumnDef<MarketSampleItem>[] = [
      {
        id: "product",
        header: "商品身份",
        accessorFn: (item) => item.title ?? item.asin,
        cell: ({ row }) => (
          <MarketSampleIdentity
            item={row.original}
            translatedTitle={researchData?.translations?.[`title:${row.original.subjectKey}`]?.text}
            translationPending
            marketplace={scan?.marketplace ?? "US"}
            chineseHint={sampleChineseHint(row.original, homogeneity.assignments)}
          />
        ),
      },
      {
        id: "scope",
        header: "烘焙垫范围初筛",
        accessorFn: (item) => item.marketScope?.status ?? "UNCERTAIN",
        cell: ({ row }) => {
          const scope = row.original.marketScope;
          if (!scope) return <span className="text-[13px] text-slate-400">待生成</span>;
          const label = scope.status === "IN_SCOPE" ? "标题疑似相关" : scope.status === "OUT_OF_SCOPE" ? "标题疑似不相关" : "待核实";
          const tone = scope.status === "IN_SCOPE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : scope.status === "OUT_OF_SCOPE" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800";
          return <div className="max-w-64"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[12px] font-semibold ${tone}`}>{label}</span><p className="mt-1 text-[12px] leading-4 text-slate-500 line-clamp-2" title={scope.reason}>{scope.reason}</p>{scope.comparabilityFlags.length > 0 && <p className="mt-1 text-[12px] text-amber-700 line-clamp-2">{scope.comparabilityFlags.join(" · ")}</p>}<details className="mt-1 text-[12px] text-slate-400"><summary className="cursor-pointer">查看完整理由与来源</summary><p>{scope.reason}</p><p className="mt-1 break-all">{scope.evidence.evidenceId} · v{scope.evidence.evidenceVersion} · {scope.evidence.capturedAt} · {scope.evidence.sourceProofHash}</p></details></div>;
        },
      },
      {
        id: "scope-review",
        header: "人工范围确认（P3）",
        accessorFn: (item) => item.scopeReview?.reviewStale ? "STALE" : (item.scopeReview?.reviewStatus ?? "UNREVIEWED"),
        cell: ({ row }) => {
          const review = row.original.scopeReview;
          const status = review?.reviewStale ? "STALE" : (review?.reviewStatus ?? "UNREVIEWED");
          const tone = status === "IN_SCOPE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : status === "OUT_OF_SCOPE" ? "border-rose-200 bg-rose-50 text-rose-800" : status === "STALE" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600";
          return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[12px] font-semibold ${tone}`}>{localizeScopeReviewStatus(status)}</span>;
        },
      },
      {
        id: "price",
        header: "价格",
        accessorFn: (item) => item.price ?? -1,
        cell: ({ row }) => <MarketSamplePrice item={row.original} />,
      },
      {
        id: "rating",
        header: "评分与评论",
        accessorFn: (item) => item.rating ?? -1,
        cell: ({ row }) => {
          const sample = researchData?.samples.find((sample) => sample.subjectKey === row.original.subjectKey);
          const caliber = sample?.reviewCountCaliber;
          return <div className="flex flex-col text-sm"><span>评分 {row.original.rating ?? "未知"}</span><span className="text-slate-500">{caliber?.state === "conflict" ? "累计评价冲突，未采用" : caliber?.state === "verified" ? `${formatNumber(sample?.reviewCount)} 条（可复核）` : caliber?.state === "unverified" ? "累计评价未复核" : "累计评价未知 / 待复核"}</span></div>;
        },
      },
      {
        id: "sales",
        header: "月销估算",
        accessorFn: (item) => item.monthlySalesEstimate ?? -1,
        cell: ({ row }) => (
          <div className="text-xs">
            {row.original.monthlySalesEstimate !== null && row.original.monthlySalesEstimate !== undefined ? (
              <span className="font-semibold text-emerald-700 font-mono">
                {formatNumber(row.original.monthlySalesEstimate)} 件/月
              </span>
            ) : (
              <span className="text-[13px] text-slate-400">暂无数据</span>
            )}
          </div>
        ),
      },
      {
        id: "provenance",
        header: "来源与版本",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-col text-[13px] text-slate-500">
            <span>{sampleSourceLabel(row.original.sourceType)}</span>
            <span className="font-mono text-[12px] text-slate-400">
              v{row.original.evidenceVersion} · {row.original.capturedAt ? new Date(row.original.capturedAt).toLocaleDateString("zh-CN") : "—"}
            </span>
          </div>
        ),
      },
      {
        id: "actions",
        header: "操作",
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original;
          if (item.taskId) {
            return (
              <Link
                href={`${WORKFLOW_STAGE_META.PRODUCT_RESEARCH.href}/${encodeURIComponent(item.taskId)}`}
                className="inline-flex items-center text-xs font-semibold text-emerald-600 hover:text-emerald-700"
              >
                查看商品研究 <ArrowRight className="size-3 ml-0.5" />
              </Link>
            );
          }
          const sampleKey = scan ? marketSampleKeyFor(scan.id, item) : (item.marketSampleKey ?? String(item.asin));
          const isSaved = Boolean(scan?.representatives?.items.some((saved) => saved.marketSampleKey === sampleKey));
          const inDraft = Boolean(rowSelection[sampleKey]);
          if (isSaved) {
            return (
              <button
                type="button"
                onClick={() => void handleResearchHandoff(row.id)}
                disabled={busy || Boolean(scan?.archivedAt) || scan?.marketGate?.effectiveStatus !== "PROCEED"}
                title={busy ? "正在处理，请稍后。" : scan?.archivedAt ? "研究已归档，不能交接。" : scan?.marketGate?.effectiveStatus !== "PROCEED" ? "请先通过市场判断。" : "使用该商品已保存的代表角色与理由发起商品研究。"}
                className="inline-flex items-center text-xs text-slate-600 hover:text-emerald-600 font-medium cursor-pointer"
              >
                <Send className="size-3 mr-1" />
                发起商品研究
              </button>
            );
          }
          return (
            <button
              type="button"
              onClick={() => {
                if (!inDraft) setRowSelection((prev) => ({ ...prev, [sampleKey]: true }));
                scrollWithinDecision("benchmark-selection-section");
              }}
              disabled={busy || Boolean(scan?.archivedAt)}
              title={inDraft ? "已加入选择草稿，去填写角色与研究理由。" : "加入选择草稿；随后填写角色与研究理由并保存。"}
              className="inline-flex items-center text-xs text-slate-600 hover:text-emerald-600 font-medium cursor-pointer"
            >
              <Send className="size-3 mr-1" />
              {inDraft ? "已加入草稿 · 去填写" : "加入代表"}
            </button>
          );
        },
      },
      ];
      return scan?.marketScopeAnalysis ? columns : columns.filter((column) => column.id !== "scope");
    },
    [busy, handleResearchHandoff, homogeneity.assignments, scan, researchData, rowSelection, scrollWithinDecision]
  );

  // Derived metrics values (safe access)
  if (loading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
        <Loader2 className="size-6 animate-spin text-emerald-600" />
        <p className="text-xs">正在加载市场研究详情与锁定快照...</p>
      </div>
    );
  }

  if (errorMsg || !scan) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center max-w-lg mx-auto mt-6">
        <AlertCircle className="size-8 text-rose-600 mx-auto mb-2" />
        <h3 className="text-sm font-semibold text-rose-900">未找到该市场研究快照</h3>
        <p className="mt-1 text-xs text-rose-700">{errorMsg || "记录不存在或已被移除。"}</p>
        <div className="mt-4">
          <Link href={WORKFLOW_STAGE_META.MARKET_RESEARCH.href}>
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-3.5 mr-1.5" />
              返回市场研究列表
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const isArchived = Boolean(scan.archivedAt);
  const sourceBatchCoverage = scan.sourceBatchCoverage;
  const formalSampleCount = researchData?.statistics?.sampleCount ?? scan.decisionReadiness?.validSampleCount ?? scan.sampleCount;
  const observedTimeText = researchData?.statistics?.timeRange.from
    ? `${researchData.statistics.timeRange.from.slice(0, 10)} ${researchData.statistics.timeRange.from.slice(11, 16)} UTC`
    : new Date(scan.createdAt).toLocaleString("zh-CN");
  const gateQuickText = scan.marketGate?.stale
    ? "需重新确认"
    : scan.marketGate?.effectiveStatus
      ? gateStatusLabel(scan.marketGate.effectiveStatus)
      : "待处理";

  // 决策工作区入口状态：全部由已保存事实推导，不用草稿或 AI 建议冒充完成。
  const gateReady = scan.marketGate?.effectiveStatus === "PROCEED" && !scan.marketGate?.stale;
  const savedRepresentativeCount = scan.representatives?.items.length ?? 0;
  const decisionState: { label: string; tone: "ok" | "warn" | "neutral" } = !gateReady
    ? { label: scan.marketGate?.stale ? "判断已失效" : "待人工判断", tone: "warn" }
    : savedRepresentativeCount < 1
      ? { label: "待保存代表", tone: "neutral" }
      : { label: "可以交接", tone: "ok" };
  const decisionStage: "gate" | "representatives" | "handoff" = !gateReady
    ? "gate"
    : savedRepresentativeCount > 0 ? "handoff" : "representatives";


  return (
    <div className={`lc-market-detail space-y-3 pb-28 ${activeStyles.market}`} data-market-view={marketView} data-market-workspace={marketWorkspace}>
      {/* 顶部紧凑研究简报头 */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 pb-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
            <Link
              href={WORKFLOW_STAGE_META.MARKET_RESEARCH.href}
              className="inline-flex items-center text-slate-600 hover:text-blue-800 font-medium"
            >
              <ArrowLeft className="size-3.5 mr-1" />
              返回市场研究列表
            </Link>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-700">{scan.marketplace || "US"} 站点</span>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-slate-700" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formalSampleCount} 款正式商品（源候选 {scan.sampleCount}）
            </span>
            <span aria-hidden="true">·</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>观察于 {observedTimeText}</span>
            {isArchived && (
              <span className="rounded bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                已归档
              </span>
            )}
          </div>
          <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.015em] text-slate-900 leading-tight">
            {scan.scanName || `市场研究-${scan.id.slice(0, 8)}`}
          </h1>
        </div>

        {/* 右侧：市场判断快速定位 + 次要管理操作 */}
        <div className="flex flex-wrap items-center gap-2 self-center">
          <button
            type="button"
            onClick={openDecision}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold cursor-pointer transition-colors ${
              scan.marketGate?.stale
                ? "border-amber-300 bg-amber-50/70 text-amber-900 hover:bg-amber-100/80"
                : scan.marketGate?.effectiveStatus === "PROCEED"
                  ? "border-emerald-300 bg-emerald-50/70 text-emerald-800 hover:bg-emerald-100/80"
                  : "border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100"
            }`}
            title="定位到下方人工市场闸门（Market Gate）"
          >
            <span>人工市场判断：{gateQuickText}</span>
            <span aria-hidden="true">↓</span>
          </button>

          {scan.feishuSync?.baseOpenUrl && (
            <a
              href={scan.feishuSync.baseOpenUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              在飞书查看大盘 <ExternalLink className="size-3 ml-1" />
            </a>
          )}

          <Button
            variant="outline"
            size="xs"
            onClick={() => handleScanAction(isArchived ? "restore" : "archive")}
            disabled={busy}
            className="text-slate-600"
          >
            <Archive className="size-3 mr-1 text-slate-400" />
            {isArchived ? "恢复扫描" : "归档扫描"}
          </Button>

          <Button
            variant="outline"
            size="xs"
            onClick={() => handleScanAction("delete")}
            disabled={busy}
            className="text-rose-700 hover:text-rose-800 hover:bg-rose-50 border-rose-200/80"
          >
            <Trash2 className="size-3 mr-1" />
            删除
          </Button>
        </div>
      </div>

      {/* 提示通知 */}
      {actionNotice && (
        <div
          className={`flex items-start gap-2.5 rounded-xl p-3 text-xs ${
            actionNotice.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-rose-50 text-rose-800 border border-rose-200"
          }`}
        >
          {actionNotice.type === "success" ? (
            <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="size-4 text-rose-600 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 leading-relaxed">{actionNotice.message}</span>
        </div>
      )}

      {decisionView ? (
        <MarketDecisionWorkspace
          scanName={scan.scanName}
          marketplace={scan.marketplace ?? "US"}
          scanId={scan.id}
          gateStatus={scan.marketGate?.effectiveStatus ?? null}
          gateStale={Boolean(scan.marketGate?.stale)}
          savedCount={scan.representatives?.items.length ?? 0}
          draftCount={selectedItems.length}
          draftSaved={representativeDraftSaved}
          stage={decisionStage}
          busy={busy}
          onBack={() => closeDecision()}
          onRefresh={() => { void loadScan(); setIntelligenceRefresh((n) => n + 1); }}
        >

        <div className={decisionStyles.gateShell} data-open={gateOpen || undefined}>
          <button type="button" className={decisionStyles.gateSummary} aria-expanded={gateOpen} onClick={() => setGateOpen((open) => !open)}>
            <span className={decisionStyles.gateSummaryMain}>
              <b>人工市场判断</b>
              <em data-tone={gateReady ? "ok" : "warn"}>{gateQuickText}</em>
            </span>
            <span className={decisionStyles.gateSummaryMeta}>
              {scan.marketGate?.chosenAt ? `最近确认 ${new Date(scan.marketGate.chosenAt).toLocaleString("zh-CN")}` : "尚未保存判断"}
              {scan.marketGate?.reason ? ` · ${scan.marketGate.reason.slice(0, 40)}${scan.marketGate.reason.length > 40 ? "…" : ""}` : ""}
            </span>
            <span className={decisionStyles.gateToggle}>{gateOpen ? "收起" : gateReady ? "查看判断依据 / 修改判断" : "展开填写判断"}</span>
          </button>
          {gateOpen ? <div className={gateStyles.pane}>
      {/* Market Gate：市场研究完成后必须由人决定是否进入代表商品选择 */}
      <section id="market-gate-section" className={gateStyles.gate}>
        <header className={gateStyles.head}>
          <div className={gateStyles.headMain}>
            <span className={gateStyles.kicker}>人工市场判断</span>
            <h2>这个市场是否值得继续找代表商品？</h2>
            <p>决定由你做出，AI 只提供研究材料；样本、统计口径或来源更新后需要重新确认。每次判断都会记录理由并保留历史。</p>
          </div>
          <span
            className={gateStyles.status}
            data-tone={scan.marketGate?.stale ? "warn" : scan.marketGate?.effectiveStatus === "PROCEED" ? "ok" : "neutral"}
          >
            {scan.marketGate?.stale ? "需重新确认" : scan.marketGate?.effectiveStatus ? gateStatusLabel(scan.marketGate.effectiveStatus) : "待处理"}
          </span>
        </header>
        {!scan.marketGate?.stale && gateSemanticsFor(scan.marketGate?.effectiveStatus) ? (
          <p className="mt-1 text-[11px] leading-relaxed text-slate-600" data-testid="market-gate-proceed-semantics">
            {gateSemanticsFor(scan.marketGate?.effectiveStatus)}
          </p>
        ) : null}

        <div className={gateStyles.body} data-has-prereq={scan.decisionReadiness ? "true" : "false"}>
          <div className={gateStyles.decision}>
            <label className={gateStyles.reasonLabel} htmlFor="market-gate-reason">
              判断理由 <em>必填</em>
            </label>
            <textarea
              id="market-gate-reason"
              value={marketGateReason}
              onChange={(event) => setMarketGateReason(event.target.value)}
              maxLength={2_000}
              rows={4}
              placeholder="写清楚你为什么这样判断：证据支持什么、还缺什么、下一步要验证什么。"
              className={gateStyles.textarea}
              disabled={busy || isArchived}
            />
            <p className={gateStyles.reasonHint}>
              {scan.marketGate?.chosenAt ? `最近确认：${new Date(scan.marketGate.chosenAt).toLocaleString("zh-CN")} · ` : "还没有保存过判断 · "}
              理由会随决定一起保存并在历史中保留，不会由 AI 代填。
            </p>

            <div className={gateStyles.options} role="group" aria-label="选择市场判断">
              {([
                { status: "PROCEED" as const, title: "允许继续研究", desc: "仅允许进入代表商品选择与商品研究，不代表机会或商业可行性已确认", tone: "proceed" },
                { status: "VALIDATE_MORE" as const, title: "补充验证", desc: "方向可能成立，但关键证据还不够", tone: "validate" },
                { status: "PAUSE" as const, title: "暂缓", desc: "暂不投入，保留材料等待条件变化", tone: "pause" },
                { status: "DROP" as const, title: "放弃", desc: "不继续这个市场，保留记录", tone: "drop" },
              ]).map((option) => {
                const isCurrentProceed = option.status === "PROCEED" && scan.marketGate?.effectiveStatus === "PROCEED";
                const disabled = busy || isArchived || (option.status === "PROCEED" && (!scan.decisionReadiness || scan.decisionReadiness.status === "NOT_READY" || (scan.decisionReadiness.status === "READY_WITH_MISSING_DATA_CONFIRMATION" && !missingDataAcknowledged)));
                return (
                  <button
                    key={option.status}
                    type="button"
                    className={gateStyles.option}
                    data-tone={option.tone}
                    aria-pressed={isCurrentProceed}
                    disabled={disabled}
                    onClick={() => {
                      if (option.status === "PROCEED") {
                        handleProceedClick();
                      } else {
                        void handleMarketGate(option.status);
                      }
                    }}
                  >
                    <span className={gateStyles.optionHead}>
                      <span className={gateStyles.optionTitle}>
                        {option.status === "PROCEED" ? (
                          isCurrentProceed ? (
                            <span className={gateStyles.optionCurrent}>
                              <Check className="size-3.5" aria-hidden="true" />
                              已通过 · 选择代表商品
                            </span>
                          ) : (
                            "通过，选择代表商品"
                          )
                        ) : (
                          option.title
                        )}
                      </span>
                      {isCurrentProceed && <span className={gateStyles.currentChip}>当前</span>}
                    </span>
                    <span className={gateStyles.optionDesc}>{option.desc}</span>
                  </button>
                );
              })}
            </div>

            {scan.decisionReadiness?.status === "READY_WITH_MISSING_DATA_CONFIRMATION" && !missingDataAcknowledged && (
              <p className={gateStyles.disabledHint}>
                「通过」需要先在右侧勾选「我已知晓当前关键数据缺失，仍决定继续」；补充验证、暂缓、放弃可直接保存。
              </p>
            )}
            {(!scan.decisionReadiness || scan.decisionReadiness.status === "NOT_READY") && (
              <p className={gateStyles.disabledHint}>当前判断前提未就绪，暂时不能选择「通过」；可以先保存补充验证、暂缓或放弃。</p>
            )}

            {scan.marketGate?.effectiveStatus === "PROCEED" && (
              <div data-testid="market-gate-proceed-feedback" className={gateStyles.feedback}>
                <div className={gateStyles.feedbackMain}>
                  <CheckCircle2 className={gateStyles.feedbackIcon} aria-hidden="true" />
                  <div>
                    <p className={gateStyles.feedbackTitle}>市场判断已通过</p>
                    <p className={gateStyles.feedbackText}>
                      在下方正式样本列表选择代表商品，填写角色与研究理由后保存，再发起商品研究。
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="bg-white text-emerald-800 border-emerald-300 hover:bg-emerald-50 shrink-0 font-medium"
                  onClick={() => scrollWithinDecision("sample-list-section")}
                >
                  前往样本列表勾选 ↓
                </Button>
              </div>
            )}
          </div>

          {scan.decisionReadiness && (
            <aside className={gateStyles.prereq} aria-label="市场判断前提">
              <header className={gateStyles.prereqHead}>
                <h3>判断前提</h3>
                <span className={gateStyles.prereqBadge}>
                  有效商品 {scan.decisionReadiness.validSampleCount} / 门槛 ≥ {scan.decisionReadiness.requiredValidSampleCount}
                </span>
              </header>

              {scan.sampleScope?.manualReviewRequired && (
                <p className={gateStyles.prereqNote} data-testid="sample-scope-gate-caveat">
                  技术有效数量只代表样本按采集合同可用，<strong>不代表同质直接竞品数量</strong>；研究范围归属仍需人工确认。本提示不改变 Market Gate 判定。
                </p>
              )}

              {scan.decisionReadiness.blockers.map((item) => (
                <p key={item.code} className={gateStyles.blocker}>
                  <AlertCircle className={gateStyles.blockerIcon} aria-hidden="true" />
                  <span>
                    <b>{item.label}</b>
                    {item.detail}
                  </span>
                </p>
              ))}

              {scan.decisionReadiness.acknowledgeableMissing.length > 0 && (
                <div className={gateStyles.missing}>
                  <p className={gateStyles.missingTitle}>待知悉的数据缺口</p>
                  <p className={gateStyles.missingList}>{scan.decisionReadiness.acknowledgeableMissing.map((item) => item.label).join("、")}</p>
                  <details className={gateStyles.missingDetails}>
                    <summary>查看缺口说明与判断影响</summary>
                    {scan.decisionReadiness.acknowledgeableMissing.map((item) => (
                      <p key={item.code}>
                        <b>{item.label}</b>
                        {item.detail}
                      </p>
                    ))}
                  </details>
                </div>
              )}

              {scan.decisionReadiness.status === "READY_WITH_MISSING_DATA_CONFIRMATION" && (
                <label className={gateStyles.ack}>
                  <input type="checkbox" checked={missingDataAcknowledged} onChange={(e) => setMissingDataAcknowledged(e.target.checked)} />
                  <span>我已知晓当前关键数据缺失，仍决定继续</span>
                </label>
              )}

              {scan.decisionReadiness.sampleSufficiency === "INSUFFICIENT_SAMPLE" && (
                <Link className={gateStyles.prereqLink} href="/source">
                  返回 01 市场采集补充有效商品，再建立市场研究
                </Link>
              )}

              <div className={gateStyles.steps}>
                <h4>接下来的步骤</h4>
                <ol>
                  <li data-state={scan.marketGate?.effectiveStatus === "PROCEED" && !scan.marketGate?.stale ? "done" : "current"}>
                    通过市场判断
                  </li>
                  <li data-state={(scan.representatives?.items.length ?? 0) > 0 ? "done" : scan.marketGate?.effectiveStatus === "PROCEED" ? "current" : "todo"}>
                    保存代表商品（已保存 {scan.representatives?.items.length ?? 0} 款）
                  </li>
                  <li data-state={scan.marketGate?.effectiveStatus === "PROCEED" && (scan.representatives?.items.length ?? 0) > 0 ? "ready" : "todo"}>
                    交接商品研究
                  </li>
                </ol>
              </div>

              {scan.parentVariationDedup && (
                <p className={gateStyles.variationNote}>
                  父子变体处理：{humanizeParentVariationNotice(scan.parentVariationDedup.notice)}{" "}
                  {scan.parentVariationDedup.status === "APPLIED" ? `（${scan.parentVariationDedup.sourceItemCount} → ${scan.parentVariationDedup.retainedItemCount}）` : ""}
                </p>
              )}
            </aside>
          )}
        </div>
      </section>
          </div> : null}
        </div>

        <details id="sample-list-section" data-has-scope={Boolean(scan.marketScopeAnalysis)} className={`${comparisonStyles.sampleManagement} space-y-3 rounded-xl border border-slate-200 bg-white p-5 ${selectedItems.length > 0 ? "open:pb-28" : ""}`}>
        <summary className="cursor-pointer text-base font-semibold text-slate-800">选择正式样本（{scan.sampleItems?.length ?? 0} 款）· 展开勾选，勾选后到下方填写角色与理由</summary>
        <div className="lc-sample-toolbar">
          <div className="lc-sample-toolbar-title">
            <h2>样本与代表商品（{filteredSamples.length}/{scan.sampleItems?.length ?? 0}）</h2>
            <p>搜索、筛选和分页只改变列表；勾选进入选择草稿。核对角色与理由，通过市场判断后保存，才可交接商品研究。</p>
          </div>
          <div className="lc-sample-toolbar-controls">
            <div className="lc-sample-search">
              <Search className="size-3.5" />
              <input
                type="text"
                placeholder="搜索 ASIN、标题或品牌…"
                value={sampleSearch}
                onChange={(e) => setSampleSearch(e.target.value)}
                aria-label="搜索样本"
              />
            </div>
            <div className="lc-sample-filters" role="group" aria-label="按人工范围确认筛选">
              {([
                { id: "all", label: "全部" },
                { id: "todo", label: "待确认" },
                { id: "in", label: "已确认符合" },
                { id: "out", label: "已确认不符合" },
                { id: "stale", label: "已过期" },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setScopeReviewFilter(item.id)}
                  aria-pressed={scopeReviewFilter === item.id}
                  data-testid={`sample-filter-${item.id}`}
                >
                  {item.label}<em>{scopeReviewCounts[item.id]}</em>
                </button>
              ))}
            </div>
            <div className="lc-sample-views" role="group" aria-label="展示方式">
              <button type="button" onClick={() => setSamplesView("table")} aria-pressed={samplesView === "table"} data-testid="sample-view-table">表格</button>
              <button type="button" onClick={() => setSamplesView("grouped")} aria-pressed={samplesView === "grouped"} data-testid="sample-view-grouped">分组</button>
            </div>
          </div>
        </div>

        {samplesView === "table" ? (
          <DataTable
            columns={sampleColumns}
            data={filteredSamples}
            enableRowSelection={true}
            rowSelection={rowSelection}
            setRowSelection={setRowSelection}
            getRowId={(row) => marketSampleKeyFor(scan.id, row)}
            pageSize={10}
          />
        ) : (
          <div className="lc-sample-groups" data-testid="sample-groups">
            {([
              { key: "in", title: "已确认符合范围", items: sampleGroups.in },
              { key: "out", title: "已确认不符合范围", items: sampleGroups.out },
              { key: "todo", title: "待确认 / 已过期", items: sampleGroups.todo },
            ] as const).map((group) => (
              group.items.length > 0 && (
                <section key={group.key} className={`lc-sample-group is-${group.key}`}>
                  <h3>{group.title}<em>{group.items.length} 款</em></h3>
                  <ul>
                    {group.items.slice(0, 12).map((item) => (
                      <li key={marketSampleKeyFor(scan.id, item)}>
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(rowSelection[marketSampleKeyFor(scan.id, item)])}
                            onChange={(event) => setRowSelection((previous) => ({ ...previous, [marketSampleKeyFor(scan.id, item)]: event.target.checked }))}
                            aria-label={`选择 ${item.asin}`}
                          />
                          <MarketSampleIdentity item={item} marketplace={scan.marketplace ?? "US"} translatedTitle={researchData?.translations?.[`title:${item.subjectKey}`]?.text} translationPending chineseHint={sampleChineseHint(item, homogeneity.assignments)} />
                        </label>
                      </li>
                    ))}
                  </ul>
                  {group.items.length > 12 && <p className="lc-sample-group-more">另有 {group.items.length - 12} 款，请用搜索或筛选缩小范围。</p>}
                </section>
              )
            ))}
            {filteredSamples.length === 0 && <p className="lc-sample-empty">当前筛选没有样本。换个筛选条件或清除搜索试试。</p>}
          </div>
        )}
      </details>

        <MarketHandoffPanel
          gateStatus={scan.marketGate?.effectiveStatus ?? null}
          gateStale={Boolean(scan.marketGate?.stale)}
          archived={isArchived}
          busy={busy}
          formalSampleCount={formalSampleCount}
          draftCount={selectedItems.length}
          draftSaved={representativeDraftSaved}
          draft={selectedItems.slice(0, 50).map((item, index) => {
            const key = marketSampleKeyFor(scan.id, item);
            return {
              marketSampleKey: key,
              asin: String(item.asin).toUpperCase(),
              subjectKey: item.subjectKey,
              title: researchData?.translations?.[`title:${item.subjectKey}`]?.text ?? item.title ?? String(item.asin),
              brand: item.brand ?? null,
              imageSrc: researchData ? trustedSampleImageUrl(researchData, item.subjectKey) : null,
              role: roleBySampleKey[key] ?? (["benchmark", "newcomer", "pain_point"] as const)[index % 3],
              note: noteBySampleKey[key] ?? "",
              invalid: invalidRepresentativeKeys.has(key),
            };
          })}
          saved={(scan.representatives?.items ?? []).map((item) => ({
            marketSampleKey: item.marketSampleKey,
            asin: item.asin,
            subjectKey: item.subjectKey,
            role: item.role,
            note: item.note,
          }))}
          notice={benchmarkNotice}
          onRoleChange={(key, role) => {
            setRoleBySampleKey((current) => ({ ...current, [key]: role }));
            setInvalidRepresentativeKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }}
          onNoteChange={(key, value) => {
            setNoteBySampleKey((current) => ({ ...current, [key]: value }));
            if (value.trim()) {
              setInvalidRepresentativeKeys((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
              });
              setBenchmarkNotice((current) => (current?.type === "error" ? null : current));
            }
          }}
          onSave={() => void handleSaveRepresentatives()}
          onHandoff={() => void handleResearchHandoff()}
          onGoToGate={() => scrollWithinDecision("market-gate-section")}
          onGoToSamples={() => scrollWithinDecision("sample-list-section")}
          onReload={() => { setBenchmarkNotice(null); setActionNotice(null); void loadScan(); }}
          onRestoreDraft={(items) => {
            setRoleBySampleKey((current) => {
              const next = { ...current };
              for (const item of items) next[item.marketSampleKey] = item.role;
              return next;
            });
            setNoteBySampleKey((current) => {
              const next = { ...current };
              for (const item of items) next[item.marketSampleKey] = item.note;
              return next;
            });
            setBenchmarkNotice({ type: "info", message: `已恢复重新读取前的草稿（${items.length} 款），保存后才会写入服务端。` });
          }}
        />

        <details id="market-scope-confirmation" className="rounded-xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer font-semibold text-sm text-slate-800">核对这些商品是否属于当前关键词市场</summary>
        <p className="my-2.5 text-xs text-slate-500">这里只保存归属确认。核实后点击上方“正式应用已确认排除项”，图表和AI才切换到新范围。原始观察及历史判断保留。</p>
      <ScopeConfirmationPanel
        scanId={scan.id}
        expectedScanHash={scan.sampleHash}
        items={scan.sampleItems.map((item) => ({
          marketSampleKey: item.marketSampleKey ?? `${scan.id}:${String(item.asin).toUpperCase()}`,
          asin: String(item.asin).toUpperCase(),
          subjectKey: item.subjectKey,
          resourceVersion: item.resourceVersion ?? item.version ?? "",
          scopeReview: item.scopeReview ?? null,
        }))}
        summary={scan.scopeReviewSummary}
        onSaved={() => { void loadScan(); setIntelligenceRefresh((n) => n + 1); }}
      />
      </details>
        </MarketDecisionWorkspace>
      ) : (
      <MarketIntelligencePanel
        scanId={scan.id}
        revision={`${scan.resourceVersion}:${intelligenceRefresh}`}
        active={researchTab}
        onTabChange={(tab) => { setResearchTab(tab); setMarketWorkspace(tab === "商品对比" ? "samples" : "judgment"); }}
        selectedSubjects={selectedItems.map((item) => item.subjectKey)}
        onData={receiveIntelligence}
        onChanged={() => { void loadScan(); }}
        savedRepresentatives={scan.representatives?.items ?? []}
        onAdoptRecommendation={adoptRecommendation}
        marketGate={{
          label: gateQuickText,
          tone: scan.marketGate?.stale ? "warn" : scan.marketGate?.effectiveStatus === "PROCEED" ? "ok" : "neutral",
        }}
        onGoToGate={openDecision}
        onOpenDecision={openDecision}
        decisionState={decisionState}
      />
      )}

      {/* 底部浮动批量操作条 (BulkActionBar) */}
      <BulkActionBar
        selectedCount={marketWorkspace === "samples" && !representativeDraftSaved ? selectedItems.length : 0}
        onClearSelection={() => setRowSelection({})}
        actions={
          <div className="flex items-center gap-2">
            {/* 核心动作：保存后的代表商品进入深度研究 */}
            <Button
              variant="primary"
              size="sm"
              onClick={() => { openDecision(); scrollWithinDecision("benchmark-selection-section"); }}
              disabled={busy || isArchived || scan.marketGate?.effectiveStatus !== "PROCEED" || selectedItems.length > 50}
              className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs font-semibold"
              title={
                "当前勾选或角色理由尚未保存；请先核实并保存代表商品"
              }
            >
              <Sparkles className="size-3.5 mr-1.5" />
              标注角色并保存代表 ({selectedItems.length}款) ➔
            </Button>

            {/* 样本归档 */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSampleBulkAction("archive")}
              disabled={busy}
            >
              <Archive className="size-3 mr-1" />
              归档样本
            </Button>

            {/* 样本删除 */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSampleBulkAction("delete")}
              disabled={busy}
              className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
            >
              <Trash2 className="size-3 mr-1" />
              删除样本
            </Button>
          </div>
        }
      />

      {/* 统一操作确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.message}
        onConfirm={confirmDialog.action}
        onClose={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
