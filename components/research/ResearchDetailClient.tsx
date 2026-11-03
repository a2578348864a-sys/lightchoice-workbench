"use client";

import Link from "next/link";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import readingStyles from "./ResearchReading.module.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Gavel,
  HelpCircle,
  Info,
  LayoutDashboard,
  Loader2,
  MessageSquareQuote,
  Quote,
  RefreshCw,
  ScanSearch,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  UserCheck,
} from "lucide-react";

import { formatTeamRecommendationPullFeedback, teamRecommendationLabel, type TeamRecommendationView } from "@/lib/client/feishuTeamRecommendation";
import { JudgmentCard } from "@/components/research/DecisionCard";
import { DecisionChecklist } from "@/components/research/DecisionChecklist";
import { ReviewReader } from "@/components/research/ReviewReader";
import type { EvidencePane } from "@/components/research/ResearchWorkspacePanels";
import { ResearchOverviewFocus } from "@/components/research/ResearchOverviewFocus";
import { EvidenceOpportunityWorkspace } from "@/components/research/EvidenceOpportunityWorkspace";
import { ResearchCompetitorSnapshot } from "@/components/research/ResearchCompetitorSnapshot";
import { ResearchVoiceReport, ResearchImprovementSection, ResearchCostSection, ResearchRiskSection, ResearchConclusionEvidence } from "@/components/research/ResearchReportSections";
import { ResearchV1ReportCard } from "@/components/research/ResearchV1ReportCard";
import { ResearchMaterialDrawer } from "@/components/research/ResearchMaterialDrawer";
import { ResearchClaimAuditCard } from "@/components/research/ResearchClaimAuditCard";
import { ImprovementPlanCard } from "@/components/research/ImprovementPlanCard";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";
import { describeDecisionBasis } from "@/lib/research/decisionBasis";
import { RiskUnknowns } from "@/components/research/RiskUnknowns";
import { ResearchDecisionWorkspace } from "@/components/research/ResearchDecisionWorkspace";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { WORKFLOW_STAGE_META } from "@/lib/workflow/workflowResolver";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getLegacyV5GenerationState, shouldShowProductFactRecovery } from "@/components/research/legacyV5Generation";
import { BuyerVoicePanel } from "@/components/research/BuyerVoicePanel";
import { CommercialInputsCard } from "@/components/product-research/CommercialInputsCard";
import { UnitEconomicsResultCard } from "@/components/research/UnitEconomicsResultCard";
import type { UnitEconomicsView } from "@/lib/research/researchContracts";
import { TechnicalProvenanceDrawer } from "@/components/research/TechnicalProvenanceDrawer";
import { ProductConceptV5Panel } from "@/components/research/ProductConceptV5Panel";
import { CommercialFeasibilityPanel } from "@/components/research/CommercialFeasibilityPanel";
import { ResearchProductFactsCard, type ResearchProductFactCardData } from "@/components/research/ResearchProductFactsCard";
import { MarketResearchContextCard } from "@/components/research/MarketResearchContextCard";
import { DeepResearchWorkspace } from "@/components/research/DeepResearchWorkspace";
import { JevReadinessReviewCard, type JevReadinessView } from "@/components/research/JevReadinessReviewCard";
import {
  type CanonicalDecisionStatus,
  CANONICAL_DECISION_ACTIONS,
  canonicalToLegacyChoice,
  toCanonicalDecisionStatus,
  getDecisionStatusDisplay,
} from "@/lib/types/v5DecisionStatus";

type ResearchDetailData = {
  claimAudit?: import("@/lib/research/evidenceAudit").ResearchClaimAudit | null;
  taskId: string;
  candidateId?: string | null;
  asin: string;
  title: string | null;
  imageUrl: string | null;
  marketplace: string;
  marketProvenance?: {
    marketScanId?: string;
    marketSampleKey?: string;
    sampleHash?: string;
    metricsVersion?: string;
    marketDecisionStatus?: string;
    role?: "benchmark" | "newcomer" | "pain_point" | string;
    representativeNote?: string | null;
    opportunityResearch?: import("@/lib/marketScan/opportunityResearch").OpportunityResearchSnapshot;
  } | null;
  fastTrack?: boolean;
  researchRevision: number | null;
  reportHash: string | null;
  factHash: string | null;
  evidenceHash: string | null;
  decisionBindingHash: string | null;
  resourceVersion?: string;
  teamRecommendation?: TeamRecommendationView | null;
  conceptTeamRecommendation?: TeamRecommendationView | null;
  stale: boolean;
  reportStale?: boolean;
  /** 服务端 stale 判定原因：RESEARCH_EVIDENCE_CHANGED | DECISION_BINDING_CHANGED */
  staleReason?: string | null;
  /**
   * A2 读侧：历史 AI 研报的 VOC 规则时效（current / outdated / unknown）。
   * 纯展示标注，不参与 stale 门禁、不改任何状态。
   */
  vocRuleCurrency?: {
    status: "current" | "outdated" | "unknown";
    hint: string | null;
  };
  lastAdvisoryAttempt?: { status?: string; errorCode?: string };
  archivedAt: string | null;
  isLegacy?: boolean;
  hasLegacyReport?: boolean;
  /** P2-04：v1 正式研报的只读展示投影（v5 是权威时服务端返回 null）。 */
  reportViewV1?: import("@/lib/research/v1ReportView").V1ReportView | null;
  /** P5-v3：v5 综合研报的只读展示投影（仅 v5 为权威时返回；没有原因假设层）。 */
  reportViewV5?: import("@/lib/research/v5ReportView").V5ReportView | null;
  /** 当前权威报告判定（唯一解释路径，含歧义原因）。 */
  reportResolution?: {
    status: "current" | "ambiguous" | "missing";
    source: "v1" | "v5" | null;
    reportHash: string | null;
    generatedAt: string | null;
    researchRevision: number | null;
    otherPresent: boolean;
    reason: string;
    candidates: { source: string; reportHash: string; generatedAt: string | null }[];
  } | null;
  hasHumanDecision?: boolean;
  legacyV5GenerationAvailable?: boolean;
  legacyV5GenerationBlockReason?: string | null;
  missingCapabilities?: string[];
  displayOnlyIdentity?: import("@/lib/product/researchDisplayIdentity").ResearchDisplayIdentity;
  facts?: ResearchProductFactCardData & {
    dimensions?: string | null;
    weight?: string | null;
    features?: string[];
  };
  deepseek?: {
    status: "available" | "unavailable" | "failed" | "stale";
    summary?: string | null;
    opportunities?: string[];
    risks?: string[];
    citations?: Array<{ quote: string; source: string; sentiment?: string }>;
    reportRefs?: string[];
    /**
     * P0 证据可信度：仅有引用白名单外来源、支撑范围不可知的**已持久化**陈述被暂停展示时出现。
     * 原始研报与 reportHash 不变，研究版本不变。
     */
    evidenceIntegrity?: {
      schemaVersion?: string;
      suppressed: boolean;
      suppressedSummary?: boolean;
      notices?: string[];
      auditSummary?: string | null;
      rejectedClaims?: Array<{ field: string; disposition: string; illegalRefs?: string[]; textPreview?: string }>;
      rawReportUnchanged?: boolean;
    } | null;
  };
  evidenceRiskGate?: {
    status: "available" | "unavailable" | "failed" | "stale";
    evidenceSufficiency: "adequate" | "insufficient" | "conflicting" | "stale";
    blockingRisk: "none" | "present" | "insufficient_evidence" | "unavailable";
    gateVersion?: string;
  };
  compositeSuggestion?: {
    status: "available" | "unavailable" | "failed" | "stale";
    composite: "recommend_proceed" | "watch_carefully" | "recommend_drop" | "no_suggestion";
    inputs?: string[];
    gateVersion?: string;
  };
  decisionDelivery?: {
    status: "available" | "unavailable";
    assembleVersion?: string;
    aiInvoked?: boolean;
    reason?: string;
    decisionSummary?: {
      researchPriority?: "P1" | "P2" | "P3";
      recommendedNextAction?: "继续研究" | "补充数据" | "暂停";
      keyReasons?: readonly string[];
      blockingRisks?: readonly string[];
      missingInformation?: readonly string[];
      actionReasons?: readonly string[];
      checklist?: readonly {
        key: string;
        label: string;
        status: "passed" | "blocked" | "warning" | "missing";
        detail: string;
      }[];
    };
    riskGate?: {
      status: "passed" | "blocked" | "warning";
      hasBlockingRisk: boolean;
      rules: readonly {
        ruleId: string;
        severity: "BLOCK" | "WARNING" | "INFO";
        status: "triggered" | "passed" | "not_computable";
        reason: string | null;
      }[];
      blockingReasons: readonly string[];
      warningReasons: readonly string[];
    };
    riskCounts?: {
      blocking: number;
      warning: number;
      notComputable: number;
      passed: number;
    };
  } | null;
  /** V6：单位经济性只读展示契约（确定性计算，零 AI；无输入时为不可计算）。 */
  unitEconomics?: UnitEconomicsView | null;
  vocImprovementInsights?: {
    available: boolean;
    requirements: readonly {
      id: string;
      requirement: string;
      sourceThemeLabel: string;
      reviewCount: number;
      severityHint: string | null;
      evidenceRefs: readonly string[];
    }[];
    checkpoints: readonly {
      id: string;
      checkpoint: string;
      sourceThemeLabel: string;
      reviewCount: number;
      evidenceRefs: readonly string[];
    }[];
    /** 真实评论分析出的痛点/请求主题（样本不足派生不出改进需求时也能看到）。 */
    themes?: readonly {
      label: string;
      summary: string;
      reviewCount: number;
      strength: string;
      kind?: "pain" | "request" | "positive";
    }[];
    /** 正式 VOC 分析快照的独立评论计数（与主题提及次数分开） */
    reviewSnapshot?: { totalReviews?: number; reviewsUsed?: number } | null;
    /** 正式 VOC 分析快照：本样本无法证明什么（商品级） */
    unknowns?: readonly string[];
    /** 正式 VOC 分析快照：下一步研究建议（商品级） */
    nextResearchSteps?: readonly string[];
  };
  myChoice?: {
    choice: "PROCEED" | "WATCH" | "DROP" | null;
    canonicalStatus?: CanonicalDecisionStatus | null;
    hubStatus?: CanonicalDecisionStatus | null;
    scope: "FINAL" | "TEMPORARY" | null;
    chosenAt: string | null;
    chosenBy?: string | null;
    reason?: string | null;
    source?: {
      kind?: string | null;
      recordId?: string | null;
      reviewedAt?: string | null;
      packetHash?: string | null;
    } | null;
  } | null;
  feishuSync?: {
    baseOpenUrl?: string | null;
    lastSyncedAt?: string | null;
    status?: string;
  };
  /** 服务端只读配置状态：false = 飞书凭据缺失，同步按钮应提前禁用并显示原因。 */
  feishuConfigured?: boolean;
  feishuHub?: {
    table: "T02";
    recordId: string;
    baseOpenUrl?: string | null;
  } | null;
  /** Jev「AI 二次复核」读侧投影（默认关闭时为最小投影；不触发任何 Provider 调用）。 */
  jevReadiness?: JevReadinessView | null;
};

/**
 * 飞书同步按钮禁用判定（纯函数）：忙、无正式报告、服务端明确未配置时禁用。
 * feishuConfigured 缺省（旧响应/读取失败）不禁用，保持既有行为；服务端门禁不变。
 */
export function shouldDisableFeishuSync(input: {
  busy: boolean;
  hasFormalReport: boolean;
  feishuConfigured?: boolean;
}): boolean {
  return input.busy || !input.hasFormalReport || input.feishuConfigured === false;
}

function formatMoney(amount: number | null | undefined, currency = "$"): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "— 未提供";
  return `${currency}${amount.toFixed(2)}`;
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined || !Number.isFinite(num)) return "— 未提供";
  return num.toLocaleString();
}

type ResearchWorkspace = "overview" | "evidence" | "comparison" | "decision";

/**
 * 九个研究细分模块 → 四个工作区。
 * 工作区只决定「哪些模块一起展示」，每个模块仍然完整渲染，不删除、不改数据。
 */
const RESEARCH_MODULES = [
  { id: "deep-research-conclusion", label: "研究结论", workspace: "overview" },
  { id: "research-facts-section", label: "商品事实", workspace: "evidence" },
  { id: "research-voc-section", label: "买家声音", workspace: "evidence" },
  { id: "deep-research-voc", label: "VOC 痛点", workspace: "evidence" },
  { id: "research-report-section", label: "AI 研报", workspace: "evidence" },
  { id: "deep-research-competitors", label: "竞品对比", workspace: "comparison" },
  { id: "deep-research-opportunities", label: "开发机会", workspace: "comparison" },
  { id: "research-cost-section", label: "成本测算", workspace: "comparison" },
  { id: "research-decision-section", label: "人工决策", workspace: "decision" },
] as const satisfies readonly { id: string; label: string; workspace: ResearchWorkspace }[];

function workspaceOfSection(id: string): ResearchWorkspace {
  return RESEARCH_MODULES.find((module) => module.id === id)?.workspace ?? "overview";
}

/** 统一资料阅读器可承载的资料：一个入口、一份内容，不再并行多套页面。 */
type MaterialTarget = "archive" | "facts" | "report" | "reviews" | "voc" | "audit" | "plan" | "competitors";

const MATERIAL_TITLE: Record<MaterialTarget, string> = {
  archive: "研究档案",
  facts: "商品事实",
  report: "AI 研报与引用",
  reviews: "原始买家评论",
  voc: "VOC 规则结果",
  audit: "证据强度审查",
  plan: "改良假设与来源依据",
  competitors: "竞品详细事实",
};

/** 旧深链 / 分节 id → 统一资料阅读器目标；成本与竞品走页面内定位。 */
function materialOfSection(id: string): MaterialTarget | null {
  if (id === "research-facts-section") return "facts";
  if (id === "research-report-section") return "report";
  if (id === "deep-research-voc") return "voc";
  if (id === "research-voc-section") return "reviews";
  return null;
}

export function ResearchDetailClient({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [researchView, setResearchView] = useState("deep-research-conclusion");
  const [researchWorkspace, setResearchWorkspace] = useState<ResearchWorkspace>("overview");
  /** 证据阅读器当前选中的材料；null = 未选择，原始材料保持收起。只影响阅读面板，不改变数据。 */
  /** 统一资料阅读器当前打开的资料；null = 关闭。只影响阅读层，不改变数据。 */
  const [material, setMaterial] = useState<MaterialTarget | null>(null);
  /** 成本测算的专注操作区：全宽独立视图，不塞进右侧阅读器。 */
  const [costFocus, setCostFocus] = useState(false);
  const [detail, setDetail] = useState<ResearchDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: "success" | "warning" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pullingFeishu, setPullingFeishu] = useState(false);
  const [generationBlockedMessage, setGenerationBlockedMessage] = useState<string | null>(null);
  const [factRecoveryRequired, setFactRecoveryRequired] = useState(false);
  const [factRecoveryBusy, setFactRecoveryBusy] = useState(false);

  // My Choice state (preserves user reason during STALE errors!)
  const [typedReason, setTypedReason] = useState("");
  const [temporaryNote, setTemporaryNote] = useState("");
  // P0-DC-04：阻断/不可评估数据缺失时的决策就绪知悉标记
  const [readinessAcked, setReadinessAcked] = useState(false);
  /** 决策页当前选择（仅本地状态；真正写入仍走 handleMakeChoice 的既有门禁）。 */
  const [pendingDecision, setPendingDecision] = useState<CanonicalDecisionStatus | null>(null);

  const decisionDelivery = detail?.decisionDelivery;
  const deliveryCounts = decisionDelivery?.status === "available" ? decisionDelivery.riskCounts : undefined;
  const needsReadinessAck = Boolean(deliveryCounts && (deliveryCounts.blocking > 0 || deliveryCounts.notComputable > 0));
  const readinessBlocked = needsReadinessAck && !readinessAcked;

  // Collapsible section toggles
  const [showCitations, setShowCitations] = useState(false);

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    isDestructive: boolean;
    confirmText?: string;
    action: () => Promise<void>;
  }>({
    open: false,
    title: "",
    description: "",
    isDestructive: false,
    confirmText: "确认执行",
    action: async () => {},
  });

  const loadDetail = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setLoading(true);
    setErrorMsg(null);
    try {
      // 1. Try canonical /api/research/{taskId}
      const res = await fetch(`/api/research/${encodeURIComponent(taskId)}`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });

      if (res.ok) {
        const json = await res.json();
        const data: ResearchDetailData = json.data || json;
        const missingCapabilities: string[] = [];
        if (!data.reportHash) missingCapabilities.push("正式研报内容");
        if (!data.factHash) missingCapabilities.push("商品事实基线尚未完成");
        if (!data.evidenceHash) missingCapabilities.push("证据来源尚未完成");
        if (!data.evidenceRiskGate || data.evidenceRiskGate.status === "unavailable") {
          missingCapabilities.push("确定性证据与风险门禁");
        }
        if (!data.deepseek || data.deepseek.status === "unavailable") {
          missingCapabilities.push("DeepSeek 深度研报分析");
        }

        const isLegacy = Boolean(data.isLegacy || (!data.reportHash && !data.factHash));
        setDetail({
          ...data,
          isLegacy,
          missingCapabilities: isLegacy ? (data.missingCapabilities?.length ? data.missingCapabilities : missingCapabilities) : [],
        });
        setFactRecoveryRequired(shouldShowProductFactRecovery({
          isLegacy,
          hasProductFact: Boolean(data.factHash),
          asin: data.asin,
          hasHumanDecision: Boolean(data.hasHumanDecision || data.myChoice),
        }));
        // 服务端理由只在用户尚未输入时种入本地；用户已输入的内容永不被刷新覆盖。
        // 不把 typedReason 放进 loadDetail 依赖：否则每个字符都会触发整页重新 GET（D0-002）。
        setTypedReason((prev) => (prev ? prev : data.myChoice?.reason || ""));
        return;
      }

      // 正式 V5 契约：canonical 研究详情失败时如实报错；404 即如实告知不存在，
      // 不再回退旧的 tasks 兼容接口拼装视图。
      if (res.status === 404) {
        setDetail(null);
        setErrorMsg("未找到该商品研究任务，或该任务已被删除。");
        return;
      }

      const errJson = await res.json().catch(() => null);
      throw new Error(errJson?.error?.message || `读取商品研究详情失败 (${res.status})`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "获取商品研究详情失败");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // 切换研究任务时清空上一个任务的本地未保存输入（仅在 taskId 变化时执行）。
  useEffect(() => {
    setTypedReason("");
    setTemporaryNote("");
  }, [taskId]);

  // 研报内容变化（新 reportHash）时重置知悉标记；同一研报的刷新保留勾选状态
  useEffect(() => {
    setReadinessAcked(false);
  }, [detail?.reportHash]);

  useEffect(() => {
    const revealHash = () => {
      const id = window.location.hash.slice(1);
      const known = RESEARCH_MODULES.map((module) => module.id) as readonly string[];
      if (known.includes(id)) {
        setResearchWorkspace(workspaceOfSection(id));
        setResearchView(id);
        if (id === "research-cost-section") { setResearchWorkspace("evidence"); setCostFocus(true); return; }
        if (id === "deep-research-competitors") {
          setResearchWorkspace("evidence");
          requestAnimationFrame(() => document.getElementById("research-competitors-inline")?.scrollIntoView({ block: "start" }));
          return;
        }
        const target = materialOfSection(id);
        if (target) setMaterial(target);
      }
    };
    revealHash();
    window.addEventListener("hashchange", revealHash);
    return () => window.removeEventListener("hashchange", revealHash);
  }, [taskId]);

  // D3：分节导航跳转 —— 先切到该模块所属工作区（证据类同时切换材料面板），再高亮并滚动到目标分节
  const scrollToSection = useCallback((id: string) => {
    setResearchWorkspace(workspaceOfSection(id));
    setResearchView(id);
    const target = materialOfSection(id);
    if (target) { setMaterial(target); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const behavior = document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth";
      const target = document.getElementById(id);
      // 该分节被当前视图隐藏时（CSS 分页），退回滚动导航条，避免点了没有反应。
      if (target && target.getBoundingClientRect().height > 0) {
        target.scrollIntoView({ behavior, block: "start" });
        return;
      }
      document.querySelector('[data-testid="research-workspace-nav"]')?.scrollIntoView({ behavior, block: "start" });
    }));
  }, []);

  // 持续监控已于 V6 退役：深研页不再提供「加入持续监控」入口，也不再请求监控列表。

  // Handler: Global Pull Feishu decisions
  const handlePullFeishuDecisions = useCallback(async () => {
    setPullingFeishu(true);
    setActionNotice(null);
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
      setActionNotice(formatTeamRecommendationPullFeedback(data));
      await loadDetail();
    } catch (err) {
      setActionNotice({
        type: "error",
        message: err instanceof Error ? err.message : "检查飞书端建议失败",
      });
    } finally {
      setPullingFeishu(false);
    }
  }, [loadDetail]);

  const handleApplyTeamRecommendation = useCallback(() => {
    const recommendation = detail?.teamRecommendation;
    if (!detail || !recommendation || recommendation.status !== "VERIFIED_TEAM_RECOMMENDATION" || recommendation.stale) return;
    setConfirmDialog({ open: true, title: "确认飞书端建议", isDestructive: recommendation.recommendationStatus === "RECOMMEND_DROP",
      description: `将当前研究最终决策设为「${teamRecommendationLabel(recommendation.recommendationStatus)}」。只有本次确认会使建议生效。`,
      confirmText: "确认采纳并保存", action: async () => {
        setBusy(true); setActionNotice(null);
        try {
          const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/apply-team-recommendation`, {
            method: "POST", headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ recommendationId: recommendation.id, confirmed: true, readinessAcknowledged: readinessAcked === true, expectedVersion: detail.resourceVersion,
              expectedRevision: detail.researchRevision, expectedReportHash: detail.reportHash, expectedFactHash: detail.factHash, expectedEvidenceHash: detail.evidenceHash }) });
          const json = await res.json().catch(() => null);
          if (!res.ok) throw new Error(json?.error?.message ?? "飞书端建议确认失败。");
          setActionNotice({ type: "success", message: "已由 Workbench 用户确认，飞书端建议已成为最终决策。" });
        } catch (error) { setActionNotice({ type: "error", message: error instanceof Error ? error.message : "飞书端建议确认失败。" }); }
        finally { setConfirmDialog(prev => ({ ...prev, open: false })); await loadDetail(); setBusy(false); }
      } });
  }, [detail, loadDetail, readinessAcked]);

  // Handler: Formal My Choice with Canonical 5-State & 4-hash binding
  const handleMakeChoice = useCallback(
    async (status: CanonicalDecisionStatus) => {
      if (!detail || detail.isLegacy) return;
      setBusy(true);
      setActionNotice(null);

      try {
        const legacyChoice = canonicalToLegacyChoice(status);
        const payload = {
          choice: legacyChoice,
          canonicalStatus: status,
          reason: typedReason.trim() || undefined,
          readinessAcknowledged: readinessAcked === true,
          expectedVersion: detail.resourceVersion,
          ...(detail.teamRecommendation?.status === "VERIFIED_TEAM_RECOMMENDATION" ? { expectedTeamRecommendationId: detail.teamRecommendation.id } : {}),
          expectedRevision: detail.researchRevision ?? 1,
          expectedReportHash: detail.reportHash || "",
          expectedFactHash: detail.factHash || "",
          expectedEvidenceHash: detail.evidenceHash || "",
          idempotencyKey: crypto.randomUUID(),
        };

        const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/choice`, {
          method: "POST",
          headers: {
            ...buildAccessHeaders(),
            "Content-Type": "application/json",
            "Idempotency-Key": payload.idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const json = await res.json().catch(() => null);
          const code = json?.error?.code || json?.code;

          if ((res.status === 409 && code !== "READINESS_ACK_REQUIRED") || code === "REPORT_STALE" || code === "FACT_STALE" || code === "EVIDENCE_STALE" || code === "RESEARCH_REVISION_STALE") {
            // STALE CONTRACT: Preserve user's typed reason, re-fetch detail, and alert!
            setActionNotice({
              type: "error",
              message: "研究内容或底层事实已被更新（STALE），请重新确认当前最新版本后再做选择。您的决策备注已保留。",
            });
            await loadDetail();
            return;
          }

          throw new Error(json?.error?.message || `保存决断失败 (${res.status})`);
        }

        const display = getDecisionStatusDisplay(status);
        setActionNotice({
          type: "success",
          message: `已成功保存决断：【${display.label}】！决策结果已锁定归档。`,
        });

        loadDetail();
      } catch (err) {
        setActionNotice({
          type: "error",
          message: err instanceof Error ? err.message : "保存决断失败",
        });
      } finally {
        setBusy(false);
      }
    },
    [detail, typedReason, loadDetail, readinessAcked]
  );

  // Handler: Generate formal DeepSeek advisory report via official ResearchInputBundle boundary
  const handleGenerateAdvisory = useCallback(async () => {
    const legacyGeneration = detail && getLegacyV5GenerationState({
      isLegacy: Boolean(detail.isLegacy),
      hasLegacyReport: Boolean(detail.hasLegacyReport),
      reportHash: detail.reportHash,
      hasHumanDecision: Boolean(detail.hasHumanDecision || detail.myChoice),
      boundaryAvailable: detail.legacyV5GenerationAvailable === true,
      boundaryBlockReason: detail.legacyV5GenerationBlockReason,
      busy,
      boundaryBlockedMessage: generationBlockedMessage,
    });
    if (!detail || (!legacyGeneration?.enabled && detail.isLegacy) || busy) return;
    const confirmFinalAdvisoryRegeneration = detail.myChoice?.scope === "FINAL"
      ? window.confirm("已有最终决策。重生成研报会保留旧决策，并要求你再次确认新的报告与证据绑定。是否继续？") : false;
    if (detail.myChoice?.scope === "FINAL" && !confirmFinalAdvisoryRegeneration) return;
    setBusy(true);
    setActionNotice(null);
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/advisory`, {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          expectedRevision: detail.researchRevision ?? 0,
          requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"],
          confirmFinalAdvisoryRegeneration,
          expectedFactHash: detail.factHash,
          expectedEvidenceHash: detail.evidenceHash,
          idempotencyKey,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const code = json?.error?.code || json?.code;
        if (res.status === 409 || ["REPORT_STALE", "FACT_STALE", "EVIDENCE_STALE", "RESEARCH_REVISION_STALE"].includes(code)) {
          setActionNotice({ type: "error", message: "研究版本或绑定已变化，请确认最新状态后重试。" });
          await loadDetail();
          return;
        }
        if (["PRODUCT_FACT_MISSING", "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING", "EVIDENCE_BINDING_MISSING"].includes(json?.data?.deepseek?.errorCode || code)) {
          const missingFact = (json?.data?.deepseek?.errorCode || code) === "PRODUCT_FACT_MISSING";
          const message = json?.data?.deepseek?.message || json?.error?.message || "正式研究输入边界 / 事实依据库边界不可用，已阻止生成。";
          setGenerationBlockedMessage(message);
          setFactRecoveryRequired(missingFact);
          setActionNotice({ type: "error", message });
          return;
        }
        throw new Error(json?.error?.message || `生成研报失败 (${res.status})`);
      }
      const deepseek = json?.data?.deepseek;
      if (deepseek?.status !== "available") {
        const boundaryCodes = ["PRODUCT_FACT_MISSING", "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING", "EVIDENCE_BINDING_MISSING"];
        if (boundaryCodes.includes(deepseek?.errorCode)) {
          const message = deepseek?.message || "正式研究输入边界 / 事实依据库边界不可用，已阻止生成。";
          setGenerationBlockedMessage(message);
          setFactRecoveryRequired(deepseek?.errorCode === "PRODUCT_FACT_MISSING");
          setActionNotice({ type: "error", message });
          return;
        }
        await loadDetail();
        throw new Error(deepseek?.message || deepseek?.errorCode || "研报生成未就绪，请稍后重试。");
      }
      setActionNotice({
        type: "success",
        message: "已基于正式研究输入包生成深度研报（含原文引用绑定）。",
      });
      setFactRecoveryRequired(false);
      await loadDetail();
    } catch (err) {
      setActionNotice({
        type: "error",
        message: err instanceof Error ? err.message : "生成研报失败",
      });
    } finally {
      setBusy(false);
    }
  }, [detail, loadDetail, busy, generationBlockedMessage]);

  const handleRecoverProductFact = useCallback(async () => {
    if (!detail?.asin) return;
    setFactRecoveryBusy(true);
    setActionNotice(null);
    try {
      const res = await fetch("/api/quick-asin", {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ asin: detail.asin }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || "商品事实补齐未完成，请稍后重试。");
      setFactRecoveryRequired(false);
      setGenerationBlockedMessage(null);
      setActionNotice({ type: "success", message: "商品事实已重新绑定到最新事实依据库（EvidenceStore）版本，正在刷新研究状态。" });
      await loadDetail();
    } catch (error) {
      setActionNotice({ type: "error", message: error instanceof Error ? error.message : "商品事实补齐未完成。" });
    } finally {
      setFactRecoveryBusy(false);
    }
  }, [detail, loadDetail]);

  // Handler: Temporary Watch (Task exists, NO formal report yet)
  const handleTemporaryWatch = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setActionNotice(null);

    try {
      // STRICT CONTRACT: Note only, NO candidateId!
      const payload = {
        note: temporaryNote.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      };

      const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/temporary-watch`, {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `保存临时观察失败 (${res.status})`);
      }

      setActionNotice({
        type: "success",
        message: "已加入临时观察并保存人工备注。",
      });

      loadDetail();
    } catch (err) {
      setActionNotice({
        type: "error",
        message: err instanceof Error ? err.message : "保存临时观察失败",
      });
    } finally {
      setBusy(false);
    }
  }, [detail, temporaryNote, loadDetail]);

  // Handler: Feishu Sync
  const handleHubSync = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setActionNotice(null);
    try {
      const payload = {
        expectedRevision: detail.researchRevision ?? 0,
        expectedReportHash: detail.reportHash || "",
        expectedFactHash: detail.factHash || "",
        expectedEvidenceHash: detail.evidenceHash || "",
        idempotencyKey: crypto.randomUUID(),
      };
      const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/feishu-hub-sync`, {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message || `同步到研究情报中心失败 (${res.status})`);
      setActionNotice({ type: "success", message: "研究数据包与商品事实已同步并校验，可在飞书研究情报中心查看。" });
      loadDetail();
    } catch (err) {
      setActionNotice({ type: "error", message: err instanceof Error ? err.message : "同步研究情报中心失败。" });
    } finally {
      setBusy(false);
    }
  }, [detail, loadDetail]);

  // P1-HUB-04：批量同步个人看板（T01/T02 研究投影 + T05 概念投影；复用既有逐表 guard 与回执，手动触发）
  const handleHubSyncAll = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setActionNotice(null);
    const payload = {
      expectedRevision: detail.researchRevision ?? 0,
      expectedReportHash: detail.reportHash || "",
      expectedFactHash: detail.factHash || "",
      expectedEvidenceHash: detail.evidenceHash || "",
      idempotencyKey: crypto.randomUUID(),
    };
    const callSync = async (action: string) => {
      const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/${action}`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error(json?.error?.message || `同步失败 (${res.status})`), { code: json?.error?.code });
      return true;
    };
    try {
      await callSync("feishu-hub-sync");
      try {
        await callSync("feishu-hub-concept-sync");
        setActionNotice({ type: "success", message: "个人看板全部同步完成：商品主表、研究数据包、产品概念均已投影并校验。" });
      } catch (conceptErr) {
        const code = (conceptErr as { code?: string }).code;
        if (code === "PRODUCT_CONCEPT_REQUIRED") {
          setActionNotice({ type: "success", message: "商品主表与研究数据包已同步；当前研究尚无产品概念快照，概念表未投影。" });
        } else {
          throw conceptErr;
        }
      }
      loadDetail();
    } catch (err) {
      setActionNotice({ type: "error", message: err instanceof Error ? err.message : "同步个人看板失败。" });
    } finally {
      setBusy(false);
    }
  }, [detail, loadDetail]);

  // Handler: Archive / Restore / Safe Delete
  const handleTaskAction = useCallback(
    (action: "archive" | "restore" | "delete") => {
      if (!detail) return;
      const actionName = action === "archive" ? "归档" : action === "restore" ? "恢复" : "删除";
      const isBlockedAhead = action === "delete" && (Boolean(detail.reportHash) || Boolean(detail.myChoice?.choice));

      setConfirmDialog({
        open: true,
        title: isBlockedAhead ? "无法彻底删除（依赖保护）" : `确认${actionName}该商品研究？`,
        description: isBlockedAhead
          ? "该任务已存在正式研究报告或决断结论。为了保证已有分析与研报记录完整，系统不允许物理删除。可以改为归档，归档后不会继续出现在日常列表中。"
          : action === "delete"
          ? "注意：物理删除仅在无正式研报且无决断结论的草稿状态下允许。已产出研报或已拍板的任务受系统保护禁止删除，请改走【归档】。"
          : `归档后条目将从日常可见列表中隐藏，历史版本与研报保持完整。`,
        isDestructive: action === "delete" && !isBlockedAhead,
        confirmText: isBlockedAhead ? "改为移入归档" : action === "delete" ? "确认彻底删除" : "确认执行",
        action: async () => {
          const effectiveAction = isBlockedAhead ? "archive" : action;
          setBusy(true);
          try {
            const res = await fetch(`/api/research/${encodeURIComponent(detail.taskId)}/${effectiveAction}`, {
              method: "POST",
              headers: {
                ...buildAccessHeaders(),
                "Content-Type": "application/json",
                "Idempotency-Key": crypto.randomUUID(),
              },
              body: JSON.stringify({
                expectedVersion: detail.resourceVersion || detail.researchRevision || 1,
                idempotencyKey: crypto.randomUUID(),
              }),
            });

            if (!res.ok) {
              const json = await res.json().catch(() => null);
              const code = json?.error?.code || json?.code;
              if (code === "REPORT_OR_CHOICE_EXISTS" || code === "DELETE_DEPENDENCY_BLOCKED" || code === "CANDIDATE_LINK_PROTECTED") {
                throw new Error("该任务已存在正式研究报告或决断结论，受引用保护禁止彻底删除。请使用【归档】。");
              }
              throw new Error(json?.error?.message || `${actionName}失败 (${res.status})`);
            }

            if (effectiveAction === "delete") {
              router.push("/research");
            } else {
              loadDetail();
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
    [detail, router, loadDetail]
  );

  if (loading) {
    return (
      <div className="lc-research-detail-state flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
        <Loader2 className="size-6 animate-spin text-emerald-600" />
        <p className="text-xs">正在加载商品研究深度研报与事实基线...</p>
      </div>
    );
  }

  if (errorMsg || !detail) {
    return (
      <div className="lc-research-detail-error-shell">
        <div className="lc-research-detail-state lc-research-detail-state-error rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center max-w-lg mx-auto">
          <AlertCircle className="size-8 text-rose-600 mx-auto mb-2" />
          <h3 className="text-sm font-semibold text-rose-900">未找到该商品研究任务</h3>
          <p className="mt-1 text-xs text-rose-700">{errorMsg || "研究记录不存在或已被移除。"}</p>
          <div className="mt-4">
            <Link href="/research">
              <Button variant="outline" size="sm">
                <ArrowLeft className="size-3.5 mr-1.5" />
                返回商品研究列表
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 权威由服务端判定：v5 为权威时 reportViewV1=null；v1 为权威或权威未定时才返回 v1 视图。
  const reportAuthority = detail.reportResolution?.status ?? null;
  const reportAuthorityAmbiguous = reportAuthority === "ambiguous";
  // 改良假设由研报确定性派生（不调模型、不写库）。纯函数且条目很少，
  // 直接计算而不上 useMemo：此位置在 early return 之后，用 Hook 会违反调用顺序。
  // v1 深度研报有原因假设层，直接派生；v5 综合研报没有该层，只能从 VOC 问题陈述派生，
  // 并把缺失字段如实披露（不补造原因、不调用模型）。
  const improvementPlan = detail.reportViewV1
    ? buildImprovementPlan({
        causes: detail.reportViewV1.causalInvestigations.map((item) => ({
          hypothesis: item.hypothesis,
          rationale: item.rationale,
          supportingEvidence: item.supportingEvidence,
          counterevidence: item.counterevidence,
          unknowns: item.unknowns,
          confidence: item.confidence,
          verification: item.verification,
        })),
        differentiationDirections: detail.reportViewV1.differentiationSuggestions,
      })
    : detail.reportViewV5
      ? buildImprovementPlan({
          observations: detail.reportViewV5.painPoints.map((pain) => ({ statement: pain.text, evidenceRefs: pain.evidenceRefs })),
          sourceDisclosure: { sourceKind: "v5", missingFacts: detail.reportViewV5.missingFacts },
        })
      : null;
  const hasV1Report = Boolean(detail.reportViewV1?.authoritative);
  const hasFormalReport = Boolean(!detail.isLegacy && !reportAuthorityAmbiguous
    && ((detail.reportHash && detail.deepseek?.status === "available" && !hasV1Report) || hasV1Report));
  const feishuNotConfigured = detail.feishuConfigured === false;
  const feishuSyncDisabled = shouldDisableFeishuSync({
    busy,
    hasFormalReport,
    feishuConfigured: detail.feishuConfigured,
  });
  const myChoice = detail.myChoice;
  const decisionBasis = describeDecisionBasis({
    hasDecision: Boolean(detail.hasHumanDecision || myChoice?.choice),
    source: myChoice?.source ?? null,
    linkedRecordId: detail.feishuHub?.recordId ?? null,
    localEconomicsIncomplete: detail.unitEconomics?.status !== "available",
  });
  const legacyGeneration = getLegacyV5GenerationState({
    isLegacy: Boolean(detail.isLegacy),
    hasLegacyReport: Boolean(detail.hasLegacyReport),
    reportHash: detail.reportHash,
    hasHumanDecision: Boolean(detail.hasHumanDecision || myChoice),
    boundaryAvailable: detail.legacyV5GenerationAvailable === true,
    boundaryBlockReason: detail.legacyV5GenerationBlockReason,
    busy,
    boundaryBlockedMessage: generationBlockedMessage,
  });
  const isArchived = Boolean(detail.archivedAt);

  const decisionSummary = decisionDelivery?.status === "available" ? decisionDelivery.decisionSummary : undefined;
  const canonicalChoice = toCanonicalDecisionStatus({ myChoice });
  /**
   * 「能不能提交」只把既有门禁翻译成一句人话，不新增判定：
   * 历史任务 → 报告权威未定 → 来源过期 → 无正式研报，顺序与后端门禁一致。
   */
  const decisionGateView = (() => {
    if (detail.isLegacy) {
      return { canSubmit: false, reason: "历史任务缺少完整的事实与来源核验，不能做正式决断；可先重新生成 V5 研报。", nextLabel: "生成 V5 研报", nextAction: () => void handleGenerateAdvisory() };
    }
    if (reportAuthorityAmbiguous) {
      return { canSubmit: false, reason: "报告权威未定（V1 与 V5 并存），需先确认以哪份为准，才能提交人工决定。", nextLabel: "查看研报与版本", nextAction: () => setMaterial("report") };
    }
    if (detail.reportStale === true) {
      return { canSubmit: false, reason: "研报来源已变化，旧结论不能直接采信；更新研报后即可重新确认。", nextLabel: "更新研报", nextAction: () => setMaterial("report") };
    }
    if (!hasFormalReport) {
      return { canSubmit: false, reason: "尚无正式研报，暂不能提交人工决定。", nextLabel: "查看研报与生成入口", nextAction: () => setMaterial("report") };
    }
    return { canSubmit: true, reason: null, nextLabel: null, nextAction: null };
  })();
  const overviewSuggestion = {
    status: (decisionDelivery?.status === "available" ? "available" : "unavailable") as "available" | "unavailable",
    priority: decisionSummary?.researchPriority,
    nextAction: decisionSummary?.recommendedNextAction,
    keyReason: decisionSummary?.keyReasons?.[0] ?? decisionDelivery?.reason,
    blocking: deliveryCounts?.blocking ?? 0,
    warning: deliveryCounts?.warning ?? 0,
    notComputable: deliveryCounts?.notComputable ?? 0,
  };
  const missingLimits = [
    ...(decisionSummary?.missingInformation ?? []),
    ...(decisionSummary?.blockingRisks ?? []),
  ];
  const briefHref = `/product-brief?taskId=${encodeURIComponent(detail.taskId)}`;

  const openWorkspace = (workspace: ResearchWorkspace, view: string) => {
    setResearchWorkspace(workspace);
    setResearchView(view);
    if (workspace === "comparison") {

    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // P2-UI-01：总览的商品聚焦头只消费已存投影，不新增取数、计算或状态。
  const overviewDecisionLabel = canonicalChoice === "PENDING" ? null : getDecisionStatusDisplay(canonicalChoice).label;
  // 权威未定单独成态：不宣称「有效」也不并入「来源变化」，状态标签直接说明 V1 与 V5 并存。
  const overviewReportState: "valid" | "stale" | "missing" | "ambiguous" = reportAuthorityAmbiguous
    ? "ambiguous"
    : detail.stale
      ? "stale"
      : hasFormalReport
        ? "valid"
        : "missing";
  const overviewQuestion = detail.stale && overviewDecisionLabel
    ? `历史判断「${overviewDecisionLabel}」需要重新确认：来源变化后，这个结论是否仍然成立？`
    : overviewDecisionLabel
      ? `你已记录「${overviewDecisionLabel}」；本页核对支撑这项判断的证据是否仍然成立。`
      : "这款商品是否存在值得继续验证的改良方向？";
  const overviewSummary = detail.deepseek?.summary?.trim() || detail.reportViewV1?.summary?.trim() || null;
  /**
   * 总览只放「一条主发现」：优先用当前研报里带评论基数的买家问题（可追溯、普通读者能懂），
   * 没有痛点主题时才回退到研报摘要；整段摘要不在这里铺开（完整研报在证据区）。
   */
  /** 与证据页口径一致：取提及数最高的痛点主题，两页不出现「主要问题」不一致。 */
  const overviewPainTheme = (detail.vocImprovementInsights?.themes ?? [])
    .filter((theme) => theme.kind === "pain" && theme.label.trim().length > 0)
    .slice()
    .sort((a, b) => b.reviewCount - a.reviewCount)[0] ?? null;
  /**
   * 只有复现主题（strength=recurring）才配叫「主要问题」；弱信号 / 孤立提及一律说「初步线索」，
   * 避免用确定性措辞把少量反馈说成已证实结论。判定只复用上游 strength，不新增门槛。
   */
  const overviewFindingConfirmed = overviewPainTheme?.strength === "recurring";
  const overviewFinding = reportAuthorityAmbiguous
    ? "暂不展示研究结论。"
    : overviewPainTheme
      ? overviewFindingConfirmed
        ? `买家主要问题：${overviewPainTheme.label}${overviewPainTheme.reviewCount > 0 ? `（${overviewPainTheme.reviewCount} 条评论提及）` : ""}。`
        : `${overviewPainTheme.label}${overviewPainTheme.reviewCount > 0 ? `（${overviewPainTheme.reviewCount} 条评论提及）` : ""}，尚待验证。`
      : overviewSummary ?? detail.deepseek?.opportunities?.[0]?.trim() ?? detail.reportViewV1?.differentiationSuggestions?.[0]?.trim() ?? null;
  const overviewFindingSource = reportAuthorityAmbiguous
    ? null
    : overviewPainTheme
      ? "当前研报 · 评论证据"
      : overviewSummary
        ? "来自当前已保存研报"
        : overviewFinding ? "来自研报机会项" : null;
  const currentClaimAudit = detail.claimAudit ?? detail.reportViewV5?.claimAudit;
  const overviewConsumptionNotice = currentClaimAudit && claimConsumptionBlockReason(currentClaimAudit)
    ? claimConsumptionNotice(currentClaimAudit) : null;
  /**
   * 结论关联证据：主发现来自哪个痛点主题，就取该主题在 VOC 规则里显式登记的证据引用
   * （checkpoints.evidenceRefs，按 externalContentId 与已采集观察精确对应）。
   * 不用研报全文引用冒充结论依据；主题没有登记引用时由组件如实显示空态。
   */
  const overviewEvidenceRefs = overviewPainTheme
    ? (detail.vocImprovementInsights?.checkpoints ?? []).find(
        (checkpoint) => checkpoint.sourceThemeLabel === overviewPainTheme.label,
      )?.evidenceRefs ?? []
    : [];
  const overviewUnknown = detail.vocImprovementInsights?.unknowns?.[0]?.trim()
    ?? decisionSummary?.missingInformation?.[0]?.trim()
    ?? null;
  const overviewUnknownSource = detail.vocImprovementInsights?.unknowns?.[0] ? "来自 VOC 快照" : overviewUnknown ? "来自决策摘要" : null;
  const overviewFactCount = [
    detail.facts?.brand,
    detail.facts?.price,
    detail.facts?.rating,
    detail.facts?.reviewCount,
    detail.facts?.mainCategory,
    detail.facts?.itemDimensions,
    detail.facts?.itemWeight,
    detail.facts?.material,
    detail.facts?.features?.length ? detail.facts.features : null,
  ].filter((value) => value !== null && value !== undefined).length;
  const overviewCoverage = {
    facts: overviewFactCount,
    reviews: detail.vocImprovementInsights?.reviewSnapshot?.reviewsUsed
      ?? detail.vocImprovementInsights?.reviewSnapshot?.totalReviews
      ?? null,
    themes: detail.vocImprovementInsights?.themes?.length ?? 0,
    risk: decisionDelivery?.status === "available"
      ? overviewSuggestion.blocking > 0
        ? `${overviewSuggestion.blocking} 项阻断`
        : overviewSuggestion.warning > 0
          ? `${overviewSuggestion.warning} 项提醒`
          : missingLimits.length > 0
            ? `0 阻断 · ${missingLimits.length} 项待补`
            : "未发现阻断"
      : null,
  };
  const overviewPrimary = overviewReportState === "stale"
    ? { label: "更新研报后重新确认", onClick: () => openWorkspace("evidence", "research-report-section") }
    : overviewReportState === "ambiguous"
      ? { label: "查看研报与版本", onClick: () => setMaterial("report") }
      : overviewReportState === "missing"
        ? { label: "查看研报与生成入口", onClick: () => openWorkspace("evidence", "research-report-section") }
        : canonicalChoice === "PROCEED"
        ? { label: "查看需求单", href: briefHref }
        : overviewDecisionLabel
          ? { label: "查看人工决定", onClick: () => openWorkspace("decision", "research-decision-section") }
          : { label: "去做人工决定", onClick: () => openWorkspace("decision", "research-decision-section") };
  const overviewClaimAudit = detail.claimAudit ?? detail.reportViewV5?.claimAudit;
  /**
   * 总览与人工决策页共用的风险三态（V12）：权威未定 / 审查不可用 / 风险规则不可用时 = unverifiable，
   * 两页统一显示「风险尚无法完整判断」，不得展示「无阻断风险」；越级结论与阻断计数优先。
   * 只改展示语义：不改变 canSubmit、READINESS_ACK、保存与 04 交接门禁。
   */
  const overviewRiskState: "blocking" | "unverifiable" | "clear" =
    overviewClaimAudit?.verdict === "BLOCKED" || (deliveryCounts?.blocking ?? 0) > 0
      ? "blocking"
      : reportAuthorityAmbiguous || !overviewClaimAudit || decisionDelivery?.status !== "available"
        ? "unverifiable"
        : "clear";
  const overviewRiskGateLabel = overviewRiskState === "blocking"
    ? overviewClaimAudit?.verdict === "BLOCKED"
      ? "存在越级结论"
      : `${deliveryCounts?.blocking ?? 0} 项阻断风险`
    : overviewRiskState === "unverifiable"
      ? "风险尚无法完整判断"
      : "无阻断风险";
  /** 改良区历史态：研报暂停采信 / 来源失效 / 权威未定时，全部建议标注为历史线索。 */
  const overviewImprovementHistorical = detail.stale === true || reportAuthorityAmbiguous || Boolean(overviewConsumptionNotice);
  /** 决策页的一条审查提示：只把既有 claimAudit 结论翻成人话。 */
  const decisionAuditNotice = (() => {
    if (!overviewClaimAudit) return null;
    const blocking = overviewClaimAudit.flags.filter((flag) => flag.severity === "BLOCKING").length;
    const warning = overviewClaimAudit.flags.filter((flag) => flag.severity === "WARNING").length;
    if (overviewClaimAudit.verdict === "BLOCKED" && blocking > 0) return `研报有 ${blocking} 处越级结论，采信前需先处理。`;
    if (overviewClaimAudit.verdict === "NEEDS_DOWNGRADE" && warning > 0) return `研报有 ${warning} 处表述强于证据，采信时需降级。`;
    return null;
  })();
  const evidenceAuditLabel = !overviewClaimAudit
    ? "审查不可用"
    : overviewClaimAudit.verdict === "BLOCKED"
      ? "存在越级结论"
      : overviewClaimAudit.verdict === "UNAVAILABLE"
        ? "审查不可用"
        : overviewClaimAudit.verdict === "NEEDS_DOWNGRADE" ? "表述需降级" : "未发现越级";
  const evidenceAuditTone = !overviewClaimAudit
    ? "muted"
    : overviewClaimAudit.verdict === "CONSISTENT"
      ? "ok"
      : overviewClaimAudit.verdict === "NEEDS_DOWNGRADE" ? "warn" : "blocked";
  const evidencePainThemes = (detail.vocImprovementInsights?.themes ?? [])
    .filter((theme) => theme.kind === "pain");
  /**
   * 同一条主题只在页面出现一次：证据与机会页的问题区已经完整列出全部痛点主题
   * （现象 + 改良方向 + 待验证），VOC 规则结果里不再重复列一遍；
   * 正向主题与请求主题仍完整列出。
   */
  const problemCardLabels = new Set(evidencePainThemes.map((theme) => theme.label));
  const otherVocThemes = (detail.vocImprovementInsights?.themes ?? [])
    .filter((theme) => !problemCardLabels.has(theme.label));
  const otherVocCheckpoints = (detail.vocImprovementInsights?.checkpoints ?? [])
    .filter((item) => !problemCardLabels.has(item.sourceThemeLabel));
  const evidenceUnknowns = [...new Set([
    ...(detail.vocImprovementInsights?.unknowns ?? []),
    ...missingLimits,
  ])].slice(0, 6);
  /**
   * 研报阅读器默认只回答三件事：是否有效、结论是什么、最需要注意什么。
   * 完整研报、引用与技术审查一律折叠，历史机会点不冒充当前结论。
   */
  const reportStatus = reportAuthorityAmbiguous
    ? { tone: "blocked" as const, label: "报告权威未定", note: "V1 与 V5 并存，系统不会自动选择。" }
    : overviewConsumptionNotice
      ? { tone: "blocked" as const, label: "已暂停采信", note: "报告表述超出证据强度，需先按审查建议降级。" }
      : detail.stale
        ? { tone: "warn" as const, label: "需重新确认", note: "报告生成后来源或事实已更新，旧结论不能直接沿用。" }
        : hasFormalReport
          ? { tone: "ok" as const, label: "当前有效", note: `来自当前已保存研报 · rev.${detail.researchRevision ?? "—"}` }
          : { tone: "muted" as const, label: "尚无正式研报", note: "完成研究后这里才会出现结论。" };
  const reportHeadline = reportAuthorityAmbiguous ? null : overviewSummary;
  const reportWatchItems = [
    ...(reportAuthorityAmbiguous ? [] : (detail.deepseek?.risks ?? []).slice(0, 2)),
    ...(overviewUnknown ? [overviewUnknown] : []),
  ].slice(0, 3);
  /** 成本摘要（只读投影，不改变计算规则）：本页只给状态与缺口，完整表单进专注操作区。 */
  const costView = {
    status: (detail.unitEconomics?.status ?? null) as "available" | "not_computable" | null,
    totalCost: detail.unitEconomics?.totalUnitCostUsd ?? null,
    currency: detail.unitEconomics?.currency ?? null,
    reason: detail.unitEconomics?.reasons?.[0] ?? null,
    gaps: [
      ...(detail.unitEconomics?.status === "not_computable" ? detail.unitEconomics.reasons : []),
      ...(detail.unitEconomics?.excludedCosts ?? []),
    ],
  };
  /** 统一资料阅读器的标题、来源与状态标识。 */
  /** 研究档案：按用途分组，只给名称 + 必要状态；完整资料各自打开，不再一卡一说明。 */
  const archiveGroups: { title: string; items: { key: MaterialTarget; label: string; status?: string | null; tone?: "ok" | "warn" | "blocked" | "muted" }[] }[] = [
    {
      title: "买家证据",
      items: [
        {
          key: "reviews",
          label: "原始买家评论",
          status: overviewCoverage.reviews === null ? "未记录" : `${overviewCoverage.reviews} 条`,
          tone: overviewCoverage.reviews === null ? "muted" : "ok",
        },
        {
          key: "voc",
          label: "VOC 规则结果",
          status: overviewCoverage.themes > 0 ? `${overviewCoverage.themes} 个主题` : "未生成",
          tone: overviewCoverage.themes > 0 ? "ok" : "muted",
        },
      ],
    },
    {
      title: "研究结论",
      items: [
        { key: "report", label: "AI 研报与引用", status: reportStatus.label, tone: reportStatus.tone },
        {
          key: "plan",
          label: "改良假设与验证",
          status: (improvementPlan?.items.length ?? 0) > 0 ? `${improvementPlan?.items.length} 条` : "未形成",
          tone: (improvementPlan?.items.length ?? 0) > 0 ? "ok" : "muted",
        },
      ],
    },
    {
      title: "事实与审查",
      items: [
        { key: "facts", label: "商品事实", status: `${overviewCoverage.facts} 项`, tone: overviewCoverage.facts > 0 ? "ok" : "muted" },
        { key: "audit", label: "证据强度审查", status: evidenceAuditLabel, tone: evidenceAuditTone as "ok" | "warn" | "blocked" | "muted" },
        { key: "competitors", label: "竞品详细事实" },
      ],
    },
  ];
  const materialMeta = material ? {
    title: MATERIAL_TITLE[material],
    subtitle: material === "competitors"
      ? "代表商品对比 · 包装数量仅标题推断"
      : material === "archive"
        ? null
        : `rev.${detail.researchRevision ?? "—"} · 当前已保存的研究与证据`,
    badges: [
      // 研报的有效性由正文顶部状态条统一说明，头部不再重复同一句话
      ...(material === "report" ? [] : detail.stale ? [{ label: "来源已变化，需重新确认", tone: "warn" as const }] : []),
      ...(material === "report" ? [] : reportAuthorityAmbiguous ? [{ label: "报告权威未定", tone: "blocked" as const }] : []),
      ...(material === "report" && detail.reportViewV1 && detail.reportViewV1.authoritative === false ? [{ label: "非当前权威报告", tone: "muted" as const }] : []),
    ],
    onBack: material === "archive" ? null : () => setMaterial("archive"),
  } : null;
  const overviewAudit = overviewClaimAudit ? {
    label: evidenceAuditLabel,
    headline: overviewConsumptionNotice ? null : overviewClaimAudit.headline,
    tone: evidenceAuditTone as "ok" | "warn" | "blocked" | "muted",
    blocking: overviewClaimAudit.flags.filter((flag) => flag.severity === "BLOCKING").length,
    warning: overviewClaimAudit.flags.filter((flag) => flag.severity === "WARNING").length,
    // 审查入口唯一放在「关键风险」区；侧卡只给结论文字，不重复挂同一个阅读器入口。
  } : reportAuthorityAmbiguous ? {
    label: "证据审查",
    headline: "报告权威未定：V1 与 V5 并存，系统不会自动选择；请先重新生成研报，再做人工决策。",
    tone: "blocked" as const,
  } : null;

  const auxiliaryActions = (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleHubSync}
        disabled={feishuSyncDisabled}
        title="同步当前研究包到飞书研究情报中心"
        className="justify-start"
      >
        <Share2 className="size-3.5 mr-1.5 text-emerald-600" />
        同步研究包到情报中心
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={handleHubSyncAll}
        disabled={feishuSyncDisabled}
        title="批量同步商品主表、研究数据包与产品概念到飞书个人看板"
        data-testid="hub-sync-all"
        className="justify-start"
      >
        <Share2 className="size-3.5 mr-1.5 text-indigo-600" />
        同步全部个人看板
      </Button>

      {feishuNotConfigured && (
        <p role="status" className="text-[11px] leading-relaxed text-amber-700" data-testid="feishu-sync-not-configured">
          飞书未配置（FEISHU_CREDENTIAL_MISSING）：本地选品与需求单不受影响
        </p>
      )}

      {detail.feishuSync?.baseOpenUrl && (
        <a
          href={detail.feishuSync.baseOpenUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 shadow-xs"
        >
          在飞书查看存档 <ExternalLink className="size-3 ml-1" />
        </a>
      )}

      {detail.feishuHub?.baseOpenUrl && (
        <a
          href={detail.feishuHub.baseOpenUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 hover:bg-indigo-100 shadow-xs"
        >
          飞书 T02 <ExternalLink className="size-3 ml-1" />
        </a>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => handleTaskAction(isArchived ? "restore" : "archive")}
        disabled={busy}
        className="justify-start"
      >
        <Archive className="size-3.5 mr-1.5 text-slate-500" />
        {isArchived ? "恢复" : "归档"}
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => handleTaskAction("delete")}
        disabled={busy}
        className="justify-start text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
      >
        <Trash2 className="size-3.5 mr-1.5" />
        删除
      </Button>
    </>
  );

  return (
    <div className={`lc-research-detail space-y-6 ${readingStyles.workspace} ${activeStyles.research}`} data-cost-focus={costFocus ? "true" : "false"} data-research-view={researchView} data-research-workspace={researchWorkspace}>
      {/* 所有工作区共用一条精简商品栏；完整商品事实在证据区按需查看。 */}
      <div className="lc-research-topbar">
        <div className="lc-research-topbar-main">
          <Link href="/research" className="lc-research-topbar-back" title="返回商品研究列表">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="lc-research-topbar-id">
            <span className="lc-research-topbar-eyebrow">商品研究</span>
            <h1 className="lc-research-topbar-title" title={detail.title ?? detail.asin}>{detail.title ?? detail.asin}</h1>
            <p className="lc-research-topbar-meta">
              {detail.asin} · {detail.marketplace || "US"} · rev.{detail.researchRevision ?? "—"}
            </p>
          </div>
        </div>
        <div className="lc-research-topbar-side">
          <div className="lc-research-topbar-badges">
            {detail.stale && <Badge tone="amber" dot>需重新确认</Badge>}
            {isArchived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">已归档</span>}
            {detail.myChoice && (() => {
              const canonical = toCanonicalDecisionStatus({ myChoice: detail.myChoice });
              const display = getDecisionStatusDisplay(canonical);
              const tone = canonical === "PROCEED" ? "emerald" : canonical === "VALIDATE_MORE" ? "blue" : canonical === "PAUSE" ? "amber" : canonical === "DROP" ? "rose" : "slate";
              return <Badge tone={detail.stale ? "amber" : tone} dot>{detail.stale ? "旧决断" : "决断"}: {display.label}</Badge>;
            })()}
            {detail.marketProvenance ? (
              <Badge tone="purple">市场代表：{detail.marketProvenance.role === "newcomer" ? "新进入者" : detail.marketProvenance.role === "pain_point" ? "痛点样本" : "基准商品"}</Badge>
            ) : (
              <Badge tone="slate">快速通道</Badge>
            )}
          </div>
          <details className="lc-research-topbar-more">
            <summary>更多操作</summary>
            <div>{auxiliaryActions}</div>
          </details>
        </div>
      </div>

      {/* 提示通知 */}
      {actionNotice && (
        <div
          className={`flex items-start gap-2.5 rounded-xl p-3.5 text-xs ${
            actionNotice.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : actionNotice.type === "warning"
              ? "bg-amber-50 text-amber-800 border border-amber-200"
              : "bg-rose-50 text-rose-800 border border-rose-200"
          }`}
        >
          {actionNotice.type === "success" ? (
            <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : actionNotice.type === "warning" ? (
            <AlertCircle className="size-4 text-amber-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="size-4 text-rose-600 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 leading-relaxed">{actionNotice.message}</span>
        </div>
      )}

      {factRecoveryRequired && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-bold">尚未获取到该商品完整的商品事实，先补齐商品数据后即可继续研究。</p>
            <p className="mt-1 text-[13px] leading-relaxed text-amber-800">请先通过正式采集入口补齐商品数据；系统会重新校验事实依据库（EvidenceStore）版本绑定，成功后再回到当前研究。</p>
          </div>
          <Button size="sm" variant="primary" onClick={handleRecoverProductFact} disabled={factRecoveryBusy} className="shrink-0">
            {factRecoveryBusy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            立即补齐商品数据
          </Button>
        </div>
      )}

      {/* 三个核心工作区；竞品与成本作为「证据与机会」下的二级入口。 */}
      <nav aria-label="研究工作区" className="lc-research-tabs" data-testid="research-workspace-nav">
        {([
          { id: "overview", label: "研究总览", view: "deep-research-conclusion", Icon: LayoutDashboard },
          { id: "evidence", label: "证据与机会", view: "research-facts-section", Icon: ScanSearch },
          { id: "decision", label: "人工决策", view: "research-decision-section", Icon: Gavel },
        ] as const).map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => {
              openWorkspace(workspace.id, workspace.view);
              setMaterial(null); setCostFocus(false);
            }}
            aria-pressed={researchWorkspace === workspace.id || (workspace.id === "evidence" && researchWorkspace === "comparison")}
            data-testid={`research-workspace-${workspace.id}`}
          >
            <workspace.Icon className="lc-research-tab-icon" aria-hidden="true" />
            <span className="lc-research-tab-label">{workspace.label}</span>
          </button>
        ))}
      </nav>


      {/* V6 03 纵深：首屏研究结论 + VOC 证据归属 + 竞品可比性 + 开发机会（只读投影） */}
      {material && (
        <ResearchMaterialDrawer meta={materialMeta ?? { title: MATERIAL_TITLE[material] }} onClose={() => setMaterial(null)}>
          {material === "archive" && (
            <div className="lc-archive" data-testid="material-archive">
              {archiveGroups.map((group) => (
                <section key={group.title} className="lc-archive-group">
                  <h3>{group.title}</h3>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.key}>
                        <button type="button" onClick={() => setMaterial(item.key)} data-testid={`archive-${item.key}`}>
                          <span className="lc-archive-name">{item.label}</span>
                          {item.status ? <span className="lc-archive-status" data-tone={item.tone ?? "muted"}>{item.status}</span> : null}
                          <ArrowRight className="size-4" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {material === "facts" && (
            <div className="space-y-4" data-testid="material-facts" id="research-facts-section">
              <div className="flex flex-col sm:flex-row gap-5">
                <ProductImage
                  src={detail.imageUrl}
                  alt={`${detail.asin} 主图`}
                  className="size-28 sm:size-32 rounded-xl border border-slate-200 object-cover shrink-0"
                  iconClassName="size-8"
                />
                <div className="flex-1 min-w-0 space-y-2.5">
                  <h3 className="text-[16px] font-bold text-slate-900 leading-snug">{detail.title || "— 标题未提供"}</h3>
                  {detail.marketProvenance?.marketScanId ? (
                    <MarketResearchContextCard
                      scanId={detail.marketProvenance.marketScanId}
                      opportunityResearch={detail.marketProvenance.opportunityResearch}
                      representativeNote={detail.marketProvenance.representativeNote}
                    />
                  ) : null}
                  <ResearchProductFactsCard facts={detail.facts} />
                </div>
              </div>
            </div>
          )}

          {material === "reviews" && (
            <div className="space-y-3" data-testid="material-reviews" id="research-voc-section">
              <p className="lc-material-note">
                相关原始评论材料，按附件归档，不逐条对应某个 VOC 主题；单条评论只代表该用户。
              </p>
              <ReviewReader
                taskId={detail.taskId}
                vocThemes={(detail.vocImprovementInsights?.themes ?? []).map((theme) => ({
                  label: theme.label,
                  summary: theme.summary,
                  reviewCount: theme.reviewCount,
                  strength: theme.strength,
                }))}
              />
              <details className="lc-voc-tools">
                <summary>导入与采集（评论写入入口）</summary>
                <div className="lc-voc-tools-body">
                  <BuyerVoicePanel taskId={detail.taskId} onEvidenceChanged={loadDetail} />
                </div>
              </details>
            </div>
          )}

          {material === "voc" && (
            <div className="space-y-4" data-testid="material-voc" id="deep-research-voc">
              <DeepResearchWorkspace
                taskId={detail.taskId}
                showConclusion={false}
                hideStep
                sections={["voc", "raw"]}
                detail={{
                  title: detail.title ?? null,
                  asin: detail.asin ?? null,
                  stale: Boolean(detail.stale),
                  hasFormalReport,
                  researchRevision: detail.researchRevision ?? null,
                  marketRole: detail.marketProvenance?.role ?? null,
                }}
              />
              {detail.vocImprovementInsights ? (
                <section data-testid="voc-improvement-insights" className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5">
                  <h2 className="text-[16px] font-bold text-slate-900">改进需求与供应商确认问题</h2>
                  <p className="mt-1 text-[14px] text-slate-500">由已读评论的确定性规则派生；弱信号不会被升级为需求。</p>
                  <div className="mt-3 space-y-3">
                    {otherVocThemes.length > 0 ? (
                      <div>
                        <p className="text-[14px] font-semibold text-slate-700">其他评论主题</p>
                        <ul className="mt-2 space-y-1.5">
                          {otherVocThemes.map((theme, index) => (
                            <li key={`${theme.label}-${index}`} className="rounded-xl border border-slate-200 bg-white p-2.5">
                              <p className="text-[14px] font-semibold text-slate-800">
                                {theme.label}
                                <span className="ml-2 font-normal text-[13px] text-slate-500">{theme.reviewCount} 条评论 · {theme.strength === "recurring" ? "复现主题" : theme.strength === "weak" ? "弱信号" : "孤立提及"}</span>
                              </p>
                              <p className="mt-1 text-[14px] leading-relaxed text-slate-600">{theme.summary}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {detail.vocImprovementInsights.requirements.length === 0 ? (
                      <p className="text-[14px] text-slate-500">当前样本没有复现级（≥4 条评论）痛点主题，派生不出改进需求（避免过度解读弱样本）。</p>
                    ) : (
                      <ul className="space-y-2">
                        {detail.vocImprovementInsights.requirements.map((requirement) => (
                          <li key={requirement.id} className="rounded-xl border border-slate-200 bg-white p-3">
                            <p className="text-[14px] leading-relaxed text-slate-800">{requirement.requirement}</p>
                            <p className="mt-1 text-[13px] text-slate-500">来源痛点：「{requirement.sourceThemeLabel}」 · {requirement.reviewCount} 条评论</p>
                          </li>
                        ))}
                      </ul>
                    )}
                    {otherVocCheckpoints.length > 0 ? (
                      <div>
                        <p className="text-[14px] font-semibold text-slate-700">待供应商确认问题（验货/询价时逐条核实）</p>
                        <ol className="mt-1 list-decimal space-y-1 pl-5">
                          {otherVocCheckpoints.map((checkpoint) => (
                            <li key={checkpoint.id} className="text-[14px] leading-relaxed text-slate-700">{checkpoint.checkpoint}</li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
          )}

          {material === "audit" && (
            <div className="space-y-4" data-testid="material-audit">
              {overviewClaimAudit ? (
                <ResearchClaimAuditCard audit={overviewClaimAudit} />
              ) : (
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[14px] text-amber-900">
                  尚无当前权威报告，暂不能审查。报告生成或重新确认后，这里会显示越级结论与降级建议。
                </p>
              )}
              {evidenceUnknowns.length > 0 ? (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="text-[15px] font-bold text-slate-900">仍无法证明</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-slate-700">
                    {evidenceUnknowns.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[13px] text-slate-500">评论频次是提及计数，不是买家问题发生率；AI 推断不等于已确认根因。</p>
                </section>
              ) : null}
            </div>
          )}

          {material === "plan" && (
            <div data-testid="material-plan">
              {improvementPlan ? (
                <ImprovementPlanCard plan={improvementPlan} stale={detail.stale === true} />
              ) : (
                <p className="rounded-xl border border-slate-200 bg-white p-4 text-[14px] text-slate-600">
                  当前没有已保存的研报原因假设，因此派生不出改良假设。这不代表产品没有改良空间，只代表证据还不够。
                </p>
              )}
            </div>
          )}

          {material === "competitors" && (
            <div data-testid="material-competitors" id="deep-research-competitors">
              <DeepResearchWorkspace
                taskId={detail.taskId}
                showConclusion={false}
                hideStep
                sections={["competitors"]}
                detail={{
                  title: detail.title ?? null,
                  asin: detail.asin ?? null,
                  stale: Boolean(detail.stale),
                  hasFormalReport,
                  researchRevision: detail.researchRevision ?? null,
                  marketRole: detail.marketProvenance?.role ?? null,
                }}
              />
            </div>
          )}

          {material === "report" && (
            <div className="lc-report" data-testid="material-report" id="research-report-section">
              <div className="lc-report-status" data-tone={reportStatus.tone}>
                <span className="lc-report-status-label">{reportStatus.label}</span>
                <p className="lc-report-status-note">{reportStatus.note}</p>
              </div>

              <section className="lc-report-block">
                <h3>核心结论</h3>
                {reportHeadline ? (
                  <p className="lc-report-lead">{reportHeadline}</p>
                ) : (
                  <p className="lc-report-muted">当前没有可采信的结论摘要；历史研报摘要见下方「历史 AI 分析与机会点」。</p>
                )}
              </section>

              {reportWatchItems.length > 0 ? (
                <section className="lc-report-block" data-tone="warn">
                  <h3>最需要注意</h3>
                  <ul className="lc-report-list">
                    {reportWatchItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <div className="lc-report-details">
                {detail.reportViewV1 ? (
                  <details className="lc-report-fold" data-testid="research-v1-report-disclosure">
                    <summary>完整研报全文 · v1 引擎</summary>
                    <p className="lc-report-fold-meta">
                      rev.{detail.researchRevision ?? "—"} · {detail.reportViewV1.authoritative === false ? "非当前权威" : detail.stale ? "来源已变化" : "只读报告"}
                    </p>
                    <ResearchV1ReportCard view={detail.reportViewV1} stale={detail.stale === true} />
                  </details>
                ) : null}

                {(detail.deepseek?.citations?.length ?? 0) > 0 ? (
                  <details className="lc-report-fold" data-testid="report-citations">
                    <summary>引用原文 · {detail.deepseek?.citations?.length ?? 0} 条</summary>
                    <ul className="lc-report-quotes">
                      {detail.deepseek?.citations?.map((citation, index) => (
                        <li key={index}>
                          <span>{citation.source}</span>
                          <p>“{citation.quote}”</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <details className="lc-report-fold" data-testid="report-history">
                  <summary>历史 AI 分析与机会点</summary>
                  <p className="lc-report-fold-note">
                    {detail.stale ? "历史资料，需重新确认：" : "历史资料："}
                    过去某次研究生成的 AI 分析，不保证采用最新 VOC 规则，不作为当前有效结论。
                  </p>
                  {detail.deepseek?.summary ? (
                    <div className="lc-report-history-block">
                      <h4>执行摘要</h4>
                      <p>{detail.deepseek.summary}</p>
                    </div>
                  ) : null}
                  {(detail.deepseek?.opportunities?.length ?? 0) > 0 ? (
                    <div className="lc-report-history-block">
                      <h4>核心机会点（历史）</h4>
                      <ul className="lc-report-list">
                        {detail.deepseek?.opportunities?.map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  {(detail.deepseek?.risks?.length ?? 0) > 0 ? (
                    <div className="lc-report-history-block">
                      <h4>风险与限制</h4>
                      <ul className="lc-report-list">
                        {detail.deepseek?.risks?.map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </details>
              </div>

              {detail.reportHash ? (
                <div className="lc-report-actions">
                  <Button variant="secondary" size="sm" onClick={handleGenerateAdvisory} disabled={busy}>重新生成深度研报</Button>
                  {detail.stale ? <span>先重新生成研报，再重新确认人工决策。</span> : null}
                </div>
              ) : null}
            </div>
          )}
        </ResearchMaterialDrawer>
      )}
      {costFocus && (
        <section className="lc-cost-focus" data-testid="cost-focus-area">
          <header className="lc-cost-focus-head">
            <div>
              <p className="lc-cost-focus-kicker">成本测算 · 专注操作区</p>
              <h2>填写与核对成本</h2>
              <p className="lc-cost-focus-sub">{detail.title ?? detail.asin} · {detail.asin} · 人工输入 → 确定性计算 → 可复核结果</p>
            </div>
            <button type="button" className="lc-cost-focus-back" onClick={() => setCostFocus(false)} data-testid="cost-focus-back">← 返回研究</button>
          </header>
          <section
            id="research-cost-section"
            data-testid="unit-economics-section"
            className="rounded-2xl border border-emerald-200 bg-linear-to-b from-emerald-50/30 to-white p-5 shadow-xs space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-xs">
                  <Calculator className="size-4" />
                </span>
                <h2 className="text-base font-bold text-slate-900 tracking-tight">商业成本与利润测算</h2>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[13px] font-medium text-emerald-800">
                  人工输入 · 确定性计算
                </span>
              </div>
              <span className="text-[13px] text-slate-500">
                缺失费用一律不计算，不用 0 或估算值补足；用户输入不等于供应商确认事实
              </span>
            </div>

            <UnitEconomicsResultCard view={detail.unitEconomics ?? null} compactProvenance />

            <CommercialInputsCard taskId={detail.taskId} onChanged={() => void loadDetail({ quiet: true })} />
            <details className={readingStyles.feasibilityHistory} data-testid="comparison-context-details">
              <summary>完整可行性依据 · 事实、反馈、AI 假设与风险</summary>
              <CommercialFeasibilityPanel
                input={{
                  asin: detail.asin,
                  title: detail.title,
                  facts: detail.facts,
                  marketProvenance: detail.marketProvenance,
                  unitEconomics: detail.unitEconomics,
                  recommendedNextAction: detail.decisionDelivery?.decisionSummary?.recommendedNextAction,
                  deepseek: detail.deepseek,
                  vocImprovementInsights: detail.vocImprovementInsights,
                  humanDecision: detail.myChoice
                    ? {
                        choice: detail.myChoice.choice,
                        canonicalStatus: detail.myChoice.canonicalStatus,
                        scope: detail.myChoice.scope,
                        chosenAt: detail.myChoice.chosenAt,
                        decisionStale: detail.stale === true,
                        decisionStaleReason: detail.staleReason ?? null,
                      }
                    : null,
                }}
              />
            </details>
          </section>
        </section>
      )}

      <div className="lc-research-stage" data-mode={researchWorkspace} data-evidence-pane={material ?? "none"} data-deep="false">
        {researchWorkspace === "evidence" && (
          <EvidenceOpportunityWorkspace
            taskId={detail.taskId}
            asin={detail.asin ?? null}
            marketplace={detail.marketplace ?? null}
            stale={detail.stale === true}
            reportAuthorityAmbiguous={reportAuthorityAmbiguous}
            themes={detail.vocImprovementInsights?.themes ?? []}
            requirements={detail.vocImprovementInsights?.requirements ?? []}
            checkpoints={detail.vocImprovementInsights?.checkpoints ?? []}
            reviewSnapshot={
              detail.vocImprovementInsights?.reviewSnapshot
                ? {
                    totalReviews: detail.vocImprovementInsights.reviewSnapshot.totalReviews ?? null,
                    reviewsUsed: detail.vocImprovementInsights.reviewSnapshot.reviewsUsed ?? null,
                  }
                : null
            }
            unknowns={evidenceUnknowns}
            plan={improvementPlan}
            audit={overviewClaimAudit ?? null}
            missingLimits={missingLimits}
            onOpenMaterial={(target) => setMaterial(target)}
            onOpenCompetitorDetail={() => setMaterial("competitors")}
            onOpenCost={() => setCostFocus(true)}
            cost={{
              status: costView.status,
              totalCost: costView.totalCost,
              currency: costView.currency,
              reason: costView.reason,
              gaps: costView.gaps,
            }}
          />
        )}
        <div className="lc-research-stage-main" id={researchWorkspace === "evidence" ? "research-evidence-material" : undefined}>
          {researchWorkspace === "overview" && (
            <>
              <ResearchOverviewFocus
                title={detail.title}
                asin={detail.asin}
                marketplace={detail.marketplace || "US"}
                imageUrl={detail.imageUrl ?? detail.displayOnlyIdentity?.imageUrl ?? null}
                brand={detail.facts?.brand ?? detail.displayOnlyIdentity?.brand ?? null}
                category={detail.facts?.mainCategory ?? detail.displayOnlyIdentity?.category ?? null}
                price={detail.facts?.price ?? null}
                currency={detail.facts?.currency ?? null}
                rating={detail.facts?.rating ?? null}
                reviewCount={detail.facts?.reviewCount ?? null}
                marketSource={detail.marketProvenance ? {
                  scanId: detail.marketProvenance.marketScanId ?? null,
                  sampleKey: detail.marketProvenance.marketSampleKey ?? null,
                  role: detail.marketProvenance.role ?? null,
                  note: detail.marketProvenance.representativeNote ?? null,
                  sampleHash: detail.marketProvenance.sampleHash ?? null,
                } : null}
                researchRevision={detail.researchRevision}
                reportState={overviewReportState}
                decision={overviewDecisionLabel ? { label: overviewDecisionLabel, reason: myChoice?.reason ?? null, stale: detail.stale === true } : null}
                question={overviewQuestion}
                finding={overviewFinding}
                findingSource={overviewFindingSource}
                findingLabel={overviewPainTheme && !overviewFindingConfirmed ? "初步线索" : undefined}
                consumptionNotice={overviewConsumptionNotice}
                unknown={overviewUnknown}
                unknownSource={overviewUnknownSource}
                audit={overviewAudit}
                missing={missingLimits}
                coverage={overviewCoverage}
                primary={overviewPrimary}
                conclusionEvidence={overviewConsumptionNotice || reportAuthorityAmbiguous ? null : (
                  <ResearchConclusionEvidence taskId={detail.taskId} refs={overviewEvidenceRefs} />
                )}
                onOpenMaterial={(target) => setMaterial(target)}
                onOpenDecision={() => openWorkspace("decision", "research-decision-section")}
              >
                {/* ③ 买家反馈：主题归纳 + 原始评论摘录 */}
                <ResearchVoiceReport
                  taskId={detail.taskId}
                  themes={detail.vocImprovementInsights?.themes ?? []}
                  reviewSnapshot={
                    detail.vocImprovementInsights?.reviewSnapshot
                      ? {
                          totalReviews: detail.vocImprovementInsights.reviewSnapshot.totalReviews ?? null,
                          reviewsUsed: detail.vocImprovementInsights.reviewSnapshot.reviewsUsed ?? null,
                        }
                      : null
                  }
                  onOpenReviews={() => setMaterial("reviews")}
                  onOpenVoc={() => setMaterial("voc")}
                />

                {/* ④ 竞品情况：代表商品对照（完整事实走统一阅读器） */}
                <ResearchCompetitorSnapshot
                  taskId={detail.taskId}
                  onOpenDetail={() => setMaterial("competitors")}
                />

                {/* ⑤ 产品改良与待验证项（研报失效时统一标注历史线索） */}
                <ResearchImprovementSection
                  plan={improvementPlan}
                  requirements={detail.vocImprovementInsights?.requirements ?? []}
                  checkpoints={detail.vocImprovementInsights?.checkpoints ?? []}
                  unknowns={evidenceUnknowns}
                  historical={overviewImprovementHistorical}
                  onOpenPlan={() => setMaterial("plan")}
                />

                {/* ⑥ 成本可行性 + ⑦ 关键风险：1440 部分双栏，窄屏自然单栏 */}
                <div className="lc-report-duo">
                  <ResearchCostSection cost={costView} onOpenCost={() => setCostFocus(true)} />
                  <ResearchRiskSection
                    claimAudit={overviewClaimAudit ?? null}
                    stale={detail.stale === true}
                    reportAuthorityAmbiguous={reportAuthorityAmbiguous}
                    riskState={overviewRiskState}
                    gateLabel={overviewRiskGateLabel}
                    blockingRisks={decisionSummary?.blockingRisks ?? []}
                    onOpenAudit={() => setMaterial("audit")}
                  />
                </div>
              </ResearchOverviewFocus>
            </>
          )}




      {researchWorkspace === "decision" && (
        <div className="space-y-4">
          <ResearchDecisionWorkspace
            title={detail.title}
            asin={detail.asin}
            researchRevision={detail.researchRevision ?? null}
            canSubmit={decisionGateView.canSubmit}
            blockReason={decisionGateView.reason}
            nextStep={decisionGateView.nextAction ? { label: decisionGateView.nextLabel ?? "继续", onClick: decisionGateView.nextAction } : null}
            current={
              canonicalChoice && canonicalChoice !== "PENDING"
                ? {
                    label: getDecisionStatusDisplay(canonicalChoice).label,
                    chosenAt: myChoice?.chosenAt ?? null,
                    reason: myChoice?.reason ?? null,
                    stale: detail.stale === true || reportAuthorityAmbiguous,
                  }
                : null
            }
            gateLabel={overviewRiskGateLabel}
            gate={{
              blocking: deliveryCounts?.blocking ?? 0,
              warning: deliveryCounts?.warning ?? 0,
              notComputable: deliveryCounts?.notComputable ?? 0,
            }}
            risks={decisionSummary?.blockingRisks ?? []}
            missing={decisionSummary?.missingInformation ?? []}
            notice={decisionAuditNotice}
            suggestion={{ available: overviewSuggestion.status === "available", nextAction: overviewSuggestion.nextAction ?? null, reason: overviewSuggestion.keyReason ?? null }}
            basisText={decisionBasis?.text ?? null}
            note={typedReason}
            onNoteChange={setTypedReason}
            ack={readinessAcked}
            onAckChange={setReadinessAcked}
            needsAck={needsReadinessAck}
            pending={pendingDecision}
            onPendingChange={setPendingDecision}
            onSubmit={() => { if (pendingDecision) void handleMakeChoice(pendingDecision); }}
            busy={busy}
            onOpenEvidence={() => setMaterial("audit")}
            onOpenReport={() => setMaterial("report")}
            onOpenBrief={() => {
              const entry = document.querySelector<HTMLDetailsElement>("[data-testid='research-brief-entry']");
              if (entry) { entry.open = true; entry.scrollIntoView({ behavior: "smooth", block: "center" }); }
            }}
            briefReady={canonicalChoice === "PROCEED"}
            briefLabel={
              canonicalChoice === "PROCEED"
                ? decisionGateView.canSubmit
                  ? "可进入"
                  : "可查看 · 决定需重新确认"
                : "需先记录「继续推进」"
            }
            supportDetail={
              <>
                {decisionDelivery?.riskGate ? (
                  <RiskUnknowns
                    rules={decisionDelivery.riskGate.rules}
                    missingInformation={decisionDelivery.decisionSummary?.missingInformation}
                  />
                ) : null}
                {decisionDelivery ? <JudgmentCard delivery={decisionDelivery} /> : null}
                {decisionDelivery?.decisionSummary ? <DecisionChecklist summary={decisionDelivery.decisionSummary} /> : null}
                <JevReadinessReviewCard
                  taskId={detail.taskId}
                  researchRevision={detail.researchRevision}
                  reportHash={detail.reportHash}
                  factHash={detail.factHash}
                  evidenceHash={detail.evidenceHash}
                  view={detail.jevReadiness ?? null}
                />
              </>
            }
            extraActions={
              <>
                {canonicalChoice === "VALIDATE_MORE" ? (
                  <button
                    type="button"
                    className="lc-decision-secondary"
                    onClick={() => void handleRecoverProductFact()}
                    disabled={factRecoveryBusy}
                    data-testid="decision-recover-facts"
                  >
                    补齐商品数据
                  </button>
                ) : null}
                <button
                  type="button"
                  className="lc-decision-secondary"
                  onClick={() => void handlePullFeishuDecisions()}
                  disabled={pullingFeishu || busy}
                  data-testid="decision-pull-feishu"
                >
                  检查飞书端建议
                </button>
                {detail.teamRecommendation?.status === "VERIFIED_TEAM_RECOMMENDATION" ? (
                  <button
                    type="button"
                    className="lc-decision-secondary"
                    onClick={() => void handleApplyTeamRecommendation()}
                    disabled={busy || detail.reportStale === true || readinessBlocked || detail.teamRecommendation.stale}
                    data-testid="decision-apply-team"
                  >
                    采纳飞书端建议：{teamRecommendationLabel(detail.teamRecommendation.recommendationStatus)}
                  </button>
                ) : null}
              </>
            }
          />

          {/* 04 入口：只在人工决策区出现一次 */}
        <details className={readingStyles.researchContext} data-testid="research-brief-entry">
          <summary>
            04 产品开发需求单 · {canonicalChoice === "PROCEED" ? "可查看与继续" : "需先记录「继续推进」才能形成需求单"}
          </summary>
        <ProductConceptV5Panel
          taskId={detail.taskId}
          disabled={!detail.reportHash}
          fallbackSummary={detail.deepseek?.summary ?? null}
          researchBindingKey={[detail.resourceVersion ?? "", detail.researchRevision ?? "", detail.reportHash ?? "", detail.factHash ?? "", detail.evidenceHash ?? ""].join(":")}
          humanDecisionGate={
            detail.myChoice?.canonicalStatus
              ? detail.myChoice.canonicalStatus
              : detail.myChoice?.choice === "PROCEED"
                ? "PROCEED"
                : detail.myChoice?.choice === "DROP"
                  ? "DROP"
                  : detail.myChoice?.choice === "WATCH"
                    ? "PAUSE"
                    : "PENDING"
          }
          humanDecisionStale={detail.stale === true}
          humanDecisionStaleReason={detail.staleReason ?? null}
          briefContext={{
            asin: detail.asin,
            title: detail.title,
            role: detail.marketProvenance?.role,
            facts: detail.facts,
            input: {
              asin: detail.asin,
              title: detail.title,
              facts: detail.facts,
              marketProvenance: detail.marketProvenance,
              deepseek: detail.deepseek,
              vocImprovementInsights: detail.vocImprovementInsights,
              humanDecision: detail.myChoice
                ? {
                    choice: detail.myChoice.choice,
                    canonicalStatus: detail.myChoice.canonicalStatus,
                    scope: detail.myChoice.scope,
                    chosenAt: detail.myChoice.chosenAt,
                    decisionStale: detail.stale === true,
                    decisionStaleReason: detail.staleReason ?? null,
                  }
                : null,
            },
          }}
        />
        </details>
        </div>
      )}

        </div>
      </div>

      {/* 统一操作确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmDialog.open}
        onClose={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
        onConfirm={confirmDialog.action}
        title={confirmDialog.title}
        description={confirmDialog.description}
        isDestructive={confirmDialog.isDestructive}
        confirmText={confirmDialog.confirmText || (confirmDialog.isDestructive ? "确认彻底删除" : "确认执行")}
        isLoading={busy}
      />
    </div>
  );
}
