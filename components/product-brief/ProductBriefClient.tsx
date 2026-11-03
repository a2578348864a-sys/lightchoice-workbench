"use client";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  ExternalLink,
  FileDown,
  FileText,
  Info,
  Loader2,
  LockKeyhole,
  PencilLine,
  Plus,
  Printer,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { calculatePurchaseCostCeiling, type ProductBrief, type ProductBriefComparisonRow, type ProductBriefConfirmationItem, type ProductBriefEvidenceLine, type ProductBriefSpecRow, type ProductBriefStatus, type ProductBriefVerificationItem } from "@/lib/productBrief/contract";
import { briefFileName, buildBriefMarkdown } from "@/lib/productBrief/export";
import { approvalGateFromBrief } from "@/lib/productBrief/approvalGate";
import { ProductBriefIndexClient } from "@/components/product-brief/ProductBriefIndexClient";
import { ImprovementPlanSection } from "@/components/product-brief/ImprovementPlanSection";
import { BriefDecisionSummaryCard } from "@/components/product-brief/BriefDecisionSummary";
import { buildBriefDecisionSummary } from "@/lib/productBrief/briefDecisionSummary";
import { annotateSnapshotItem, snapshotAnnotationNote } from "@/lib/productBrief/briefEconomicsStates";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";
import { BriefConflictPanel } from "@/components/product-brief/BriefConflictPanel";
import { BriefHistoryPanel } from "@/components/product-brief/BriefHistoryPanel";
import {
  dirtySections,
  draftFromBrief,
  draftIsDirty,
  draftIsDirtyAgainst,
  draftToPatch,
  resolveDraft,
  saveLikelyApplied,
  type BriefDraft,
  type ConflictChoices,
} from "@/lib/productBrief/briefEditing";
import { applySpecContentPatch } from "@/lib/productBrief/specEvidence";
import { HUMAN_COMPARISON_NOTE, applyComparisonContentPatch, comparisonOriginLabel, isSourceComparisonNote } from "@/lib/productBrief/comparisonEvidence";
import {
  displayProductTitle,
  evidenceReferenceCount,
  evidenceRefsOf,
  formatDate,
  formatMoney,
  missingCostFields,
  researchSummaryOf,
  shortApprovalReason,
  shortHash,
  sourceStateOf,
  statusLabelOf,
  type BriefDetailResponse,
} from "./briefWorkbenchModel";
import styles from "./ProductBriefWorkbench.module.css";

type BriefResponse = BriefDetailResponse;
/** P3-02 预览：服务端只读计算出的新旧差异，不写库。 */
type BriefPreviewChange = { key: string; label: string; before: string | null; after: string | null; kind: "source" | "manual" | "status" };
type BriefPreview = { current: ProductBrief | null; next: ProductBrief; changes: BriefPreviewChange[]; summary: { total: number; manual: number; source: number }; stale: boolean };
/** 本标签页暂存的草稿：同时保存编辑起点基线，用于刷新后仍能做三方冲突对照。 */
type StoredDraft = { revision?: unknown; base?: unknown; baseBrief?: ProductBrief; draft?: unknown };

type BriefTab = "plan" | "specs" | "cost" | "confirm" | "verify";
const BRIEF_TABS: readonly { id: BriefTab; label: string }[] = [
  { id: "plan", label: "方案" },
  { id: "specs", label: "规格" },
  { id: "cost", label: "成本" },
  { id: "confirm", label: "待确认" },
  { id: "verify", label: "验证" },
] as const;

const COST_FIELDS = [
  ["目标售价", "targetPrice", "USD / 件", "拟开发目标，不是竞品事实价格"],
  ["目标毛利率", "targetMarginPct", "%", "0% 至 100% 之间"],
  ["平台佣金", "referralFee", "USD / 件", "人工输入；来源与假设需核实"],
  ["物流费用", "logistics", "USD / 件", "人工输入；来源与假设需核实"],
  ["估算税费", "estimatedTax", "USD / 件", "人工输入；来源与假设需核实"],
  ["其他已知费用", "otherKnownCosts", "USD / 件", "可选；没有就留空"],
] as const;

const statusLabel: Record<ProductBriefStatus, string> = { DRAFT: "草稿", READY: "待评审", APPROVED: "已批准" };
const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);

function natureLabel(nature: ProductBriefEvidenceLine["nature"]): string {
  if (nature === "FACT") return "来源事实";
  if (nature === "ASSUMPTION") return "待确认假设";
  return "证据推导";
}

function specNatureLabel(nature: ProductBriefSpecRow["nature"]): string {
  if (nature === "FACT") return "参考记录";
  if (nature === "ASSUMPTION") return "待确认假设";
  return "证据推导";
}

function evidenceHref(taskId: string, ref: string): string {
  const base = `/research/${encodeURIComponent(taskId)}`;
  if (ref.startsWith("attachment:")) return `${base}#research-voc-section`;
  if (ref.startsWith("evidence:")) return `${base}#research-facts-section`;
  return base;
}

function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "edit" | "read" | "assumption" | "warn" | "ok" }) {
  return <span className={styles.chip} data-tone={tone}>{children}</span>;
}

function EmptyInline({ children }: { children: ReactNode }) {
  return <p className={styles.emptyInline}>{children}</p>;
}

function Section({ kicker, title, aside, children, className = "" }: { kicker?: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${styles.card} ${className}`.trim()}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionHeadText}>
          {kicker ? <p className={styles.cardKicker}>{kicker}</p> : null}
          <h2 className={styles.sectionTitle}>{title}</h2>
        </div>
        {aside ? <div className={styles.sectionAside}>{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

function EvidenceRow({ line, taskId }: { line: ProductBriefEvidenceLine; taskId: string }) {
  return (
    <li className={styles.evidenceRow}>
      <div className={styles.evidenceMeta}>
        <Chip tone={line.nature === "FACT" ? "ok" : line.nature === "ASSUMPTION" ? "assumption" : "read"}>{natureLabel(line.nature)}</Chip>
        <span>{line.evidenceRefs.length} 条引用</span>
        {line.evidenceRefs.length ? (
          <a className={styles.evidenceLink} href={evidenceHref(taskId, line.evidenceRefs[0])} target="_blank" rel="noreferrer">
            在 03 核查依据<ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : (
          <span className={styles.evidenceNoRef}>无来源引用 · 仅作假设</span>
        )}
      </div>
      <p>{line.text}</p>
      {line.evidenceRefs.length ? (
        <details className={styles.evidenceRefDetails}>
          <summary>引用 ID（{line.evidenceRefs.length}）</summary>
          <div>{line.evidenceRefs.map((ref) => <a key={ref} href={evidenceHref(taskId, ref)} target="_blank" rel="noreferrer"><code>{ref}</code></a>)}</div>
          <p>按引用类型打开 03 对应材料区；不按文字相似度猜测关联。</p>
        </details>
      ) : null}
    </li>
  );
}

/** 兼容迁移：旧需求单持久化数据里的工程词文案在展示层转成用户语言（不回写数据）。 */
function humanizeLegacyBriefItem(item: string): string {
  if (item.includes("该任务是 FAST_TRACK，未绑定市场扫描")) {
    return "该任务走快速通道，未绑定市场扫描；市场规模与代表商品需另行补证。";
  }
  return item;
}

/** 无既有需求单时，把服务端口径的门禁阻塞码转成用户语言（与 readProductBrief 的 staleReason 对齐）。 */
function gateBlockMessage(reason: string | null): string {
  switch (reason) {
    case "PRODUCT_GATE_PROCEED_REQUIRED":
      return "必须先在商品闸门（Product Gate）选择“继续推进”，服务端才会接受需求单生成。";
    case "RESEARCH_EVIDENCE_STALE":
      return "研究证据或决策绑定已变化，请先重新确认研究。";
    case "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS":
      return "报告权威未定（V1 与 V5 并存）：暂不可生成需求单。请先在商品研究页重新生成研报，确认以哪份为准。";
    case "RESEARCH_OR_MARKET_BINDING_CHANGED":
      return "需求单引用的研究或市场版本已更新；可先用「预览差异并重新生成」查看变化，再决定是否重新生成。";
    case "RESEARCH_REPORT_REQUIRED":
      return "请先完成正式商品深研报告，再生成产品开发需求单。";
    default:
      return "当前研究状态暂不满足生成条件，请先前往研究页检查。";
  }
}

export function ProductBriefClient({ taskId }: { taskId: string }) {
  const [data, setData] = useState<BriefResponse | null>(null);
  const [briefView, setBriefView] = useState<BriefTab>("plan");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 单份草稿承载全部人工可编辑章节：章节间共享同一份输入，
   * 保存时一次提交全量快照，避免「只保存当前章节」造成跨章丢失。
   */
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  /** 草稿所依据的服务端版本；CAS 冲突时用它做三方对照。 */
  const [baseline, setBaseline] = useState<ProductBrief | null>(null);
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "error" | "unconfirmed">("idle");
  const [conflict, setConflict] = useState<{ latest: ProductBrief } | null>(null);
  const [legacyDraftWithoutBase, setLegacyDraftWithoutBase] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  /** P3-02：来源更新后的重新生成预览（只读，不写库）。 */
  const [preview, setPreview] = useState<BriefPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [resetDerived, setResetDerived] = useState(false);
  /** 已提交但未确认的请求快照；用于回读判断到底成没成功。 */
  const pendingSaveRef = useRef<{ draft: BriefDraft; status: ProductBriefStatus; expectedRevision: number } | null>(null);
  const draftStorageKey = `lightchoice:brief-draft:v1:${taskId}`;
  const generationKey = `lightchoice:brief-generation:v1:${taskId}`;
  const pendingGeneration = useRef<{ body: string; key: string } | null>(null);
  const generationId = (body: string) => {
    let pending = pendingGeneration.current;
    try { pending ??= JSON.parse(window.sessionStorage.getItem(generationKey) ?? "null"); } catch { /* storage unavailable */ }
    if (!pending || pending.body !== body) pending = { body, key: crypto.randomUUID() };
    pendingGeneration.current = pending;
    try { window.sessionStorage.setItem(generationKey, JSON.stringify(pending)); } catch { /* in-memory retry */ }
    return pending.key;
  };
  const clearGeneration = () => {
    pendingGeneration.current = null;
    try { window.sessionStorage.removeItem(generationKey); } catch { /* storage unavailable */ }
  };
  /**
   * P3-02（3.3）：保存的幂等键。同一份内容（含 expectedRevision）重复提交时复用同一标识，
   * 服务端据此返回已保存版本而不是再抬一个 revision；内容变化则换新标识。
   */
  const saveKeyStorage = `lightchoice:brief-save:v1:${taskId}`;
  const pendingSaveId = useRef<{ body: string; key: string } | null>(null);
  const saveRequestId = (body: string) => {
    let pending = pendingSaveId.current;
    try { pending ??= JSON.parse(window.sessionStorage.getItem(saveKeyStorage) ?? "null"); } catch { /* storage unavailable */ }
    if (!pending || pending.body !== body) pending = { body, key: crypto.randomUUID() };
    pendingSaveId.current = pending;
    try { window.sessionStorage.setItem(saveKeyStorage, JSON.stringify(pending)); } catch { /* in-memory retry */ }
    return pending.key;
  };
  const clearSaveRequestId = () => {
    pendingSaveId.current = null;
    try { window.sessionStorage.removeItem(saveKeyStorage); } catch { /* storage unavailable */ }
  };
  const busy = phase === "saving";

  /**
   * 把服务端读取结果落到界面：
   * - 载入时优先恢复本标签页暂存的草稿（本地暂存不等于已保存，需显式提示）；
   * - 保存/回读后不恢复旧暂存，避免用过期输入覆盖刚保存的内容。
   */
  const hydrate = useCallback((next: BriefResponse, options?: { restore?: boolean }) => {
    setData(next);
    const nextBrief = next.brief;
    if (!nextBrief) {
      setBaseline(null);
      setDraft(null);
      return;
    }
    const serverDraft = draftFromBrief(nextBrief);
    setBaseline(nextBrief);
    if (options?.restore === false) {
      setDraft(serverDraft);
      return;
    }
    let restored: StoredDraft | null = null;
    try {
      const raw = window.sessionStorage.getItem(draftStorageKey);
      restored = raw ? (JSON.parse(raw) as StoredDraft) : null;
    } catch {
      restored = null;
    }
    const restoredBase = restored?.base && typeof restored.base === "object" ? (restored.base as BriefDraft) : null;
    const restoredDraft = restored?.draft && typeof restored.draft === "object" ? (restored.draft as BriefDraft) : null;
    if (restoredDraft && restoredBase) {
      setDraft(restoredDraft);
      if (draftIsDirtyAgainst(restoredDraft, restoredBase)) {
        setDraftNotice("已恢复本标签页上次未保存的输入；本地暂存不等于已保存，请核对后保存。");
      }
      if (typeof restored?.revision === "number" && restored.revision !== nextBrief.revision) {
        if (restored.baseBrief?.revision === restored.revision) setBaseline(restored.baseBrief);
        else setLegacyDraftWithoutBase(true);
        setConflict({ latest: nextBrief });
      }
      return;
    }
    setDraft(serverDraft);
  }, [draftStorageKey]);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, { headers: buildAccessHeaders(), cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `读取产品开发需求单失败 (${response.status})`);
      hydrate((json?.data ?? json) as BriefResponse, { restore: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取产品开发需求单失败");
    } finally { setLoading(false); }
  }, [hydrate, taskId]);

  useEffect(() => { void load(); }, [load]);

  /** 其他标签页保存后，本页只提示版本已变，不静默覆盖正在编辑的内容。 */
  useEffect(() => {
    const onFocus = () => {
      if (!data?.brief || busy) return;
      void fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, { headers: buildAccessHeaders(), cache: "no-store" })
        .then(async (response) => (response.ok ? ((await response.json())?.data as BriefResponse | undefined) : undefined))
        .then((latest) => {
          if (latest?.brief && data.brief && latest.brief.revision > data.brief.revision && draft && baseline && draftIsDirty(draft, baseline)) {
            setConflict({ latest: latest.brief });
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [baseline, busy, data?.brief, draft, taskId]);

  /**
   * 跨章节草稿只在本标签页暂存：刷新、误关标签页可恢复，但绝不写正式数据。
   * 仅当确有未保存输入时保留；干净草稿立即清除，避免下次打开误报「有未保存输入」。
   */
  useEffect(() => {
    if (!draft || !baseline || legacyDraftWithoutBase) return;
    try {
      if (!draftIsDirty(draft, baseline)) {
        window.sessionStorage.removeItem(draftStorageKey);
        return;
      }
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify({ revision: baseline.revision, base: draftFromBrief(baseline), baseBrief: baseline, draft, savedAt: new Date().toISOString() }));
    } catch {
      // 浏览器禁用存储时退化为纯内存编辑，功能不受影响。
    }
  }, [baseline, draft, draftStorageKey, legacyDraftWithoutBase]);

  const generate = async () => {
    setPhase("saving"); setError(null); setNotice(null);
    try {
      const body = JSON.stringify({ action: "generate" });
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, { method: "POST", headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": generationId(body) }, body });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        if (json?.error?.code === "RESEARCH_EVIDENCE_STALE") throw new Error("请先在研究页更新研报后，再重新生成企划。");
        throw new Error(json?.error?.message ?? `生成产品开发需求单失败 (${response.status})`);
      }
      setNotice("已从当前研究、商品事实、买家声音和市场来源生成产品开发需求单。");
      await load();
      clearGeneration();
      setPhase("saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成产品开发需求单失败");
      setPhase("error");
    }
  };

  /**
   * P3-02：来源更新后的恢复入口。
   * 旧行为是在 stale 时完全隐藏重新生成，导致“研究已更新但需求单永远锁死”。
   * 现在改为：先只读预览差异（不写库），用户确认后再原子生成新 revision；
   * 服务端仍用 briefContext 校验研究证据与商品闸门，不满足就返回精确原因。
   */
  const openPreview = async (reset = false) => {
    setPreviewBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", resetDerivedFields: reset }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = json?.error?.code as string | undefined;
        if (code === "RESEARCH_EVIDENCE_STALE") throw new Error("研究证据仍是旧版本：请先回研究页重跑研报并重新确认人工决定。");
        if (code === "PRODUCT_GATE_PROCEED_REQUIRED") throw new Error("商品闸门尚未选择“继续推进”，当前不能重新生成需求单。");
        throw new Error(json?.error?.message ?? `读取差异失败 (${response.status})`);
      }
      setPreview((json?.data ?? null) as BriefPreview | null);
      setResetDerived(reset);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取差异失败");
    } finally {
      setPreviewBusy(false);
    }
  };

  const confirmRegenerate = async () => {
    if (!preview?.current) return;
    const hasDraft = Boolean(draft && baseline && draftIsDirty(draft, baseline));
    if (hasDraft && draft && baseline) {
      try { window.sessionStorage.setItem(draftStorageKey, JSON.stringify({ revision: baseline.revision, base: draftFromBrief(baseline), baseBrief: baseline, draft })); } catch { setError("浏览器无法暂存未保存输入，请先下载草稿再继续；刷新可能丢失输入。"); return; }
    }
    setPhase("saving"); setError(null); setNotice(null);
    try {
      const body = JSON.stringify({ action: "generate", resetDerivedFields: resetDerived, previewRevision: preview.current.revision, previewSourceBinding: preview.next.sourceBinding });
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": generationId(body) },
        body,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = json?.error?.code as string | undefined;
        if (code === "RESEARCH_EVIDENCE_STALE") throw new Error("研究证据仍是旧版本，请先回研究页更新研报后再试。");
        throw new Error(json?.error?.message ?? `重新生成失败 (${response.status})`);
      }
      const saved = (json?.data?.brief ?? json?.brief) as ProductBrief | undefined;
      setPreview(null);
      setNotice(`已按当前来源重新生成需求单：rev.${saved?.revision ?? "?"}（${saved ? statusLabel[saved.status] : "草稿"}）。旧版本已进入历史，仍可查看。`);
      if (hasDraft) {
        const latest = await readLatest();
        if (latest?.brief) { setData(latest); setConflict({ latest: latest.brief }); setDraftNotice("未保存输入已保留，请对照新版本选择内容后保存。"); }
        else { setPhase("error"); setError("生成已返回，但最新版本未能读取；草稿仍保留，请刷新后核对。"); return; }
      } else await load();
      clearGeneration();
      setPhase("saved");
    } catch (caught) {
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "重新生成失败");
    }
  };

  // P0-BR-A6：结构化 Markdown 导出（前端生成，不经服务端）。
  const exportMarkdown = () => {
    if (!brief) return;
    const markdown = buildBriefMarkdown(brief, { stale: Boolean(data?.stale), staleReason: data?.staleReason ?? null });
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = briefFileName(brief);
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const copyMarkdown = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(buildBriefMarkdown(brief, { stale: Boolean(data?.stale), staleReason: data?.staleReason ?? null }));
      setNotice("Markdown 已复制到剪贴板。");
    } catch {
      setError("复制失败：浏览器未授权剪贴板访问，可改用下载导出。");
    }
  };

  /**
   * 保存：提交整份草稿快照（全部章节），携带 expectedRevision 做 CAS。
   * 失败分三类，处理方式不同：
   * - 409 REVISION_STALE：服务器已有新版本 → 对照冲突，人工逐项选择后再保存；
   * - 409 STALE / RESEARCH_EVIDENCE_STALE：来源绑定变化 → 锁保存，保留本地输入，只允许下载或回研究页；
   * - 超时/网络中断：结果未知 → 不重复写，先回读确认，再决定「已保存」或「允许重试」。
   */
  const submitSave = async (status: ProductBriefStatus) => {
    if (!brief || !draft || busy || phase === "unconfirmed" || conflict || data?.stale) return;
    const submitted = { ...draft };
    const baseRevision = brief.revision;
    setPhase("saving"); setError(null); setNotice(null); setDraftNotice(null);
    pendingSaveRef.current = { draft: submitted, status, expectedRevision: baseRevision };
    const requestBody = JSON.stringify({ action: "save", expectedRevision: baseRevision, status, ...draftToPatch(submitted, baseline ?? brief) });
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": saveRequestId(requestBody) },
        body: requestBody,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = json?.error?.code as string | undefined;
        if (code === "PRODUCT_BRIEF_REVISION_STALE") {
          const latest = await readLatest();
          if (latest?.brief) {
            setConflict({ latest: latest.brief });
            setPhase("error");
            setError(`服务器已有更新版本（v${latest.brief.revision}），请对照变动内容后再保存。`);
            return;
          }
        }
        if (code === "PRODUCT_BRIEF_STALE" || code === "RESEARCH_EVIDENCE_STALE") {
          setPhase("error");
          setError("研究或市场来源已变化，当前需求单只能查看。你的输入仍保留在本页，可下载草稿后回研究页更新。");
          await load();
          return;
        }
        if (code === "PRODUCT_GATE_PROCEED_REQUIRED") {
          setPhase("error");
          setError("当前商品闸门不是「继续推进」（例如仍为需补充验证），不能保存需求单。请先回 03 完成门禁，再回来编辑。本地输入仍保留。");
          await load();
          return;
        }
        throw new Error(json?.error?.message ?? `保存产品开发需求单失败 (${response.status})`);
      }
      const savedBrief = (json?.data?.brief ?? json?.brief) as ProductBrief | undefined;
      if (!savedBrief || !Number.isInteger(savedBrief.revision) || savedBrief.revision <= baseRevision) {
        throw new Error("没有收到有效保存回执，请回读确认结果。");
      }
      pendingSaveRef.current = null;
      clearStoredDraft();
      clearSaveRequestId();
      setConflict(null);
      setNotice(`产品开发需求单已保存：${statusLabel[status]} · rev.${savedBrief?.revision ?? baseRevision + 1}。${savedBrief.economics.provenance?.referralFee?.source === "product-brief-derived-price-changed" ? "目标售价变化，原按费率推导的佣金已清空，请重新确认。" : ""}`);
      await load();
      setPhase("saved");
    } catch (caught) {
      // 网络层失败没有可信的业务结论，按“结果未确认”处理，禁止盲目重试造成重复写入。
      setPhase("unconfirmed");
      setError(caught instanceof Error ? `提交结果未确认：${caught.message}` : "提交结果未确认，请先回读核对。");
    }
  };

  const readLatest = async (): Promise<BriefResponse | null> => {
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-brief`, { headers: buildAccessHeaders(), cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) return null;
      return (json?.data ?? json) as BriefResponse;
    } catch {
      return null;
    }
  };

  /** 超时/断网后回读：只有内容和状态都能对上，才认定上一次提交已生效。 */
  const reconcilePendingSave = async () => {
    const pending = pendingSaveRef.current;
    if (!pending || !baseline) return;
    setPhase("saving"); setError(null);
    const latest = await readLatest();
    if (!latest?.brief) {
      setPhase("unconfirmed");
      setError("仍无法读取服务器版本，暂不能判断是否保存成功；输入仍在，请稍后重试。");
      return;
    }
    if (saveLikelyApplied(baseline, pending.draft, pending.status, latest.brief)) {
      pendingSaveRef.current = null;
      clearStoredDraft();
      clearSaveRequestId();
      hydrate(latest, { restore: false });
      setNotice(`已回读确认上次提交成功：${statusLabel[pending.status]} · rev.${latest.brief.revision}。`);
      setPhase("saved");
      return;
    }
    if (latest.brief.revision > pending.expectedRevision) {
      setPhase("error");
      setConflict({ latest: latest.brief });
      setError("已读取新版本：你的提交没有完整生效，请对照变动内容后决定保留哪一份。");
      return;
    }
    pendingSaveRef.current = null;
    setPhase("error");
    setError("已回读确认上次未保存，全部输入仍在。现在可以重新保存。");
  };

  /** CAS 冲突解决：按人工选择合成新草稿；不自动保存，仍需用户确认。 */
  const applyConflictChoices = (choices: ConflictChoices) => {
    if (!conflict || !draft || !baseline) return;
    const latestDraft = draftFromBrief(conflict.latest);
    const baseDraft = draftFromBrief(baseline);
    const resolved = resolveDraft(baseDraft, draft, latestDraft, choices);
    if (!resolved) return;
    setDraft(resolved);
    setBaseline(conflict.latest);
    setData((previous) => (previous ? { ...previous, brief: conflict.latest } : previous));
    setConflict(null);
    setDraftNotice(`已按你的选择合并到第 ${conflict.latest.revision} 版；这是本地草稿，尚未保存。`);
    setPhase("idle");
    setError(null);
  };

  const clearStoredDraft = () => {
    try {
      window.sessionStorage.removeItem(draftStorageKey);
    } catch {
      // 暂存不可用不影响正式保存结果。
    }
  };

  /** 本地草稿下载：来源过期或冲突时，至少不让用户白写。 */
  const downloadLocalDraft = () => {
    if (!draft) return;
    const payload = {
      taskId,
      baseRevision: brief?.revision ?? null,
      savedAt: new Date().toISOString(),
      note: "本地未保存草稿，仅供人工留档；不是正式需求单。",
      draft,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `product-brief-draft-${taskId}-rev${brief?.revision ?? 0}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const save = (status: ProductBriefStatus) => void submitSave(status);
  const saveSections = () => void submitSave(brief?.status ?? "DRAFT");

  const updateField = <K extends keyof BriefDraft>(key: K, value: BriefDraft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  // 列表章节按整组编辑：任一行变更都进入同一份草稿，保存时整组提交。
  const updateSpec = (index: number, patch: Partial<ProductBriefSpecRow>) => {
    if (!draft) return;
    const row = draft.specifications[index];
    if (!row) return;
    const next = applySpecContentPatch(row, patch);
    if (row.evidenceRefs.length > 0 && next.evidenceRefs.length === 0) {
      setDraftNotice("修改规格内容后，原证据引用已从该行移除，并按待确认假设保存；原始研究证据仍在 03 商品深研与历史版本中。");
    }
    setDraft((current) => (current ? { ...current, specifications: current.specifications.map((item, i) => (i === index ? next : item)) } : current));
  };
  const addSpec = () => setDraft((current) => (current ? { ...current, specifications: [...current.specifications, { id: `spec_${crypto.randomUUID().slice(0, 8)}`, label: "", value: "", unit: null, nature: "ASSUMPTION" as const, verification: "unverified" as const, evidenceRefs: [] }] } : current));
  const removeSpec = (index: number) => setDraft((current) => (current ? { ...current, specifications: current.specifications.filter((_, i) => i !== index) } : current));
  const updateConfirm = (index: number, patch: Partial<ProductBriefConfirmationItem>) => setDraft((current) => (current ? { ...current, confirmationItems: current.confirmationItems.map((row, i) => (i === index ? { ...row, ...patch } : row)) } : current));
  const addConfirm = () => setDraft((current) => (current ? { ...current, confirmationItems: [...current.confirmationItems, { id: `cfq_${crypto.randomUUID().slice(0, 8)}`, item: "", status: "待确认" as const, reason: null }] } : current));
  const removeConfirm = (index: number) => setDraft((current) => (current ? { ...current, confirmationItems: current.confirmationItems.filter((_, i) => i !== index) } : current));
  const updateComparison = (index: number, patch: Partial<ProductBriefComparisonRow>) => {
    if (!draft) return;
    const row = draft.benchmarkComparison[index];
    if (!row) return;
    const next = applyComparisonContentPatch(row, patch);
    if (isSourceComparisonNote(row.note) && next.note === HUMAN_COMPARISON_NOTE) {
      setDraftNotice("竞品对照没有逐字段来源绑定；修改后按人工假设保存，不再视为来源记录。原始研究材料仍在 03 与历史版本中。");
    }
    setDraft((current) => (current ? { ...current, benchmarkComparison: current.benchmarkComparison.map((item, i) => (i === index ? next : item)) } : current));
  };
  const addComparison = () => setDraft((current) => (current ? { ...current, benchmarkComparison: [...current.benchmarkComparison, { id: `cmp_${crypto.randomUUID().slice(0, 8)}`, label: "", ours: null, theirs: null, nature: "ASSUMPTION" as const, note: null }] } : current));
  const removeComparison = (index: number) => setDraft((current) => (current ? { ...current, benchmarkComparison: current.benchmarkComparison.filter((_, i) => i !== index) } : current));
  const updateVerification = (index: number, patch: Partial<ProductBriefVerificationItem>) => setDraft((current) => (current ? { ...current, verificationPlan: current.verificationPlan.map((row, i) => (i === index ? { ...row, ...patch } : row)) } : current));
  const addVerification = () => setDraft((current) => (current ? { ...current, verificationPlan: [...current.verificationPlan, { id: `v_${crypto.randomUUID().slice(0, 8)}`, item: "", method: "", timing: "", status: "pending" as const }] } : current));
  const removeVerification = (index: number) => setDraft((current) => (current ? { ...current, verificationPlan: current.verificationPlan.filter((_, i) => i !== index) } : current));

  // JSX 兼容别名：读草稿，写回草稿；草稿未就绪时保持只读空值。
  const targetPrice = draft?.targetPrice ?? "";
  const targetMarginPct = draft?.targetMarginPct ?? "";
  const referralFee = draft?.referralFee ?? "";
  const logistics = draft?.logistics ?? "";
  const estimatedTax = draft?.estimatedTax ?? "";
  const otherKnownCosts = draft?.otherKnownCosts ?? "";
  const targetUser = draft?.targetUser ?? "";
  const positioning = draft?.positioning ?? "";
  const specRows = draft?.specifications ?? [];

  const confirmRows = draft?.confirmationItems ?? [];
  const comparisonRows = draft?.benchmarkComparison ?? [];
  const verificationRows = draft?.verificationPlan ?? [];
  const setTargetPrice = (value: string) => updateField("targetPrice", value);
  const setTargetMarginPct = (value: string) => updateField("targetMarginPct", value);
  const setReferralFee = (value: string) => updateField("referralFee", value);
  const setLogistics = (value: string) => updateField("logistics", value);
  const setEstimatedTax = (value: string) => updateField("estimatedTax", value);
  const setOtherKnownCosts = (value: string) => updateField("otherKnownCosts", value);
  const setTargetUser = (value: string) => updateField("targetUser", value);
  const setPositioning = (value: string) => updateField("positioning", value);
  /** 仍以服务端最新版本为脏检查基线；冲突合并后基线会同步前进。 */
  const dirty = draft && baseline ? draftIsDirty(draft, baseline) : false;
  const pendingSections = draft && baseline ? dirtySections(draft, baseline) : new Set<string>();

  const brief = data?.brief ?? null;
  // 改良假设：由 Brief 已存的逐项原因调查 + 差异化方向确定性派生（不调模型、不写库）。
  const improvementPlan = useMemo(() => {
    if (!brief) return null;
    const causes = brief.causalInvestigations;
    if (causes?.length) {
      return buildImprovementPlan({
        causes: causes.map((item) => ({
          hypothesis: item.hypothesis.text,
          rationale: item.rationale?.text ?? null,
          supportingEvidence: item.supportingEvidence.map((line) => line.text),
          counterevidence: item.counterevidence.map((line) => line.text),
          unknowns: item.unknowns,
          confidence: item.confidence,
          verification: item.verification,
        })),
        differentiationDirections: (brief.differentiation ?? []).map((line) => line.text),
      });
    }
    /**
     * v5 综合研报 / 旧需求单没有「逐项原因假设」层：不能伪造原因，也不能什么都不显示。
     * 用已持久化的 VOC 问题陈述（corePainPoints，带引用）作为输入，并把缺失字段写清楚，
     * 让用户看到「这是问题陈述，不是原因结论」。
     */
    const observations = brief.corePainPoints.map((line) => ({ statement: line.text, evidenceRefs: line.evidenceRefs }));
    if (!observations.length) return null;
    return buildImprovementPlan({
      observations,
      differentiationDirections: (brief.differentiation ?? []).map((line) => line.text),
      sourceDisclosure: {
        sourceKind: "unknown",
        missingFacts: [
          "原因假设（competitionInsight.causalInvestigations）",
          "假设提出理由（rationale）",
          "逐条支持线索",
          "逐条反证线索",
          "逐条未知事项",
          "验证动作（verification）",
        ],
      },
    });
  }, [brief]);
  const ceiling = brief?.economics.purchaseCostCeiling;
  /**
   * E-1E：按**当前表单值**预判「批准」是否可执行（服务端 422 仍是权威）。
   * 不能用 GET 里的 purchaseCostCeiling —— 那是上次保存的结果，可能是旧值。
   */
  const approvalBlockedReason = brief
    ? approvalGateFromBrief(brief, { targetPrice, targetMarginPct, referralFee, logistics, estimatedTax, otherKnownCosts })
    : null;
  // 决策摘要：页面与 Markdown 导出共用同一计算来源（lib/productBrief/briefDecisionSummary）
  const decisionSummary = useMemo(() => buildBriefDecisionSummary({
    brief,
    plan: improvementPlan,
    stale: Boolean(data?.stale),
    staleReason: data?.staleReason ?? null,
    approvalBlockedReason,
  }), [brief, improvementPlan, data?.stale, data?.staleReason, approvalBlockedReason]);
  const showMissing = useMemo(
    () => (brief?.missingValidation ?? []).map(humanizeLegacyBriefItem),
    [brief]
  );
  const locked = Boolean(data?.stale);
  const sourceState = sourceStateOf(data);
  const summary = useMemo(() => (brief ? researchSummaryOf(brief) : null), [brief]);
  const evidenceCount = useMemo(() => (brief ? evidenceReferenceCount(brief) : 0), [brief]);
  const briefEvidenceRefs = useMemo(() => (brief ? evidenceRefsOf(brief) : []), [brief]);
  const claimBlocked = useMemo(() => (brief ? claimConsumptionBlockReason(brief.claimAudit) : null), [brief]);
  const canApprove = Boolean(brief && !locked && !approvalBlockedReason && !claimBlocked && !busy && phase !== "unconfirmed" && !conflict);
  const liveCeiling = useMemo(() => {
    if (!brief) return null;
    return calculatePurchaseCostCeiling({
      targetPrice: numberOrNull(targetPrice),
      targetMarginPct: numberOrNull(targetMarginPct),
      referralFee: numberOrNull(referralFee),
      fbaFee: brief.economics.fbaFee,
      logistics: numberOrNull(logistics),
      estimatedTax: numberOrNull(estimatedTax),
      otherKnownCosts: numberOrNull(otherKnownCosts),
      currency: brief.economics.currency,
    });
  }, [brief, targetPrice, targetMarginPct, referralFee, logistics, estimatedTax, otherKnownCosts]);
  const missingCosts = useMemo(() => (brief ? missingCostFields(brief, draft) : []), [brief, draft]);
  const history = useMemo(() => [...(data?.history ?? [])].sort((a, b) => b.revision - a.revision), [data?.history]);
  const pendingConfirm = draft?.confirmationItems.filter((item) => item.status === "待确认").length ?? 0;
  const pendingVerify = draft?.verificationPlan.filter((item) => item.status === "pending").length ?? 0;
  const referenceTitle = brief ? displayProductTitle(brief.identity.title, brief.identity.asin) : "";
  const schemePositioning = (draft?.positioning ?? brief?.positioning?.text ?? "").trim();
  const syntheticSample = /隔离|联调/.test([brief?.projectOverview?.text, targetUser, positioning].filter(Boolean).join(" "));
  const isAuthorityLock = data?.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS";
  const isGateLock = data?.staleReason === "PRODUCT_GATE_PROCEED_REQUIRED";
  const isHistoricalLock = locked && !isAuthorityLock && !isGateLock;
  const sourceLockText = isAuthorityLock
    ? "报告权威未定，暂不展示研究结论。"
    : isGateLock
      ? "商品闸门尚未继续推进；研究内容仍可查看。"
      : null;
  const lockedArchiveText = isAuthorityLock
    ? "V1 与 V5 报告并存，无法确认以哪份为准；历史需求单只读。请先回 03 重新生成研报并确认权威。"
    : isGateLock
      ? "商品闸门尚未继续推进；历史需求单只读。请先在 03 完成门禁，再回来继续编辑。"
      : "研究证据或市场绑定已变化；历史需求单只读，需重新确认研究后才能继续。";
  const shortGate = shortApprovalReason(approvalBlockedReason) ?? (claimBlocked ? "研报表述审查未通过" : null);
  const statusChipTone = locked ? "locked" : brief?.status === "APPROVED" ? "approved" : brief?.status === "READY" ? "ready" : "draft";
  const next: { text: string; action: string; tone: "ok" | "warn"; tab?: BriefTab; href?: string } | null = useMemo(() => {
    if (!brief) return null;
    if (locked) {
      const text = data?.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS"
        ? "先回商品研究确认以哪份研报为准；确认前历史内容只读，保存、评审与批准不可用。"
        : data?.staleReason === "PRODUCT_GATE_PROCEED_REQUIRED"
          ? "商品闸门尚未继续推进；当前内容只读，回 03 完成门禁后可继续。"
          : "研究证据或市场绑定已变化；先回商品研究重新确认，确认前历史内容只读。";
      return { text, action: "回商品研究", href: `/research/${encodeURIComponent(taskId)}`, tone: "warn" };
    }
    if (claimBlocked) return { text: "研报存在超过证据强度的表述：先补证或更新研报，再批准；方案仍可继续完善。", action: "查看批准条件", tab: "cost", tone: "warn" };
    if (approvalBlockedReason) return { text: `批准条件未满足：${shortApprovalReason(approvalBlockedReason)}。其余章节仍可继续完善。`, action: "查看批准条件", tab: "cost", tone: "warn" };
    if (brief.status === "APPROVED") return { text: "已批准：可导出用于开发评估；继续修订会生成新版本。", action: "查看方案", tab: "plan", tone: "ok" };
    if (brief.status === "READY") return { text: "内容可进入人工评审。批准只表示可进入开发评估，不代表供应链已就绪。", action: "查看方案", tab: "plan", tone: "ok" };
    return { text: "补充定位、规格与成本后，标记待评审。", action: "继续完善", tab: "plan", tone: "ok" };
  }, [approvalBlockedReason, brief, claimBlocked, data?.staleReason, locked, taskId]);
  const tabDirty = (id: BriefTab) => {
    if (id === "plan") return pendingSections.has("definition");
    if (id === "specs") return pendingSections.has("product");
    if (id === "cost") return pendingSections.has("economics");
    if (id === "confirm") return pendingSections.has("confirmation");
    return pendingSections.has("validation");
  };

  if (!taskId) return <ProductBriefIndexClient />;
  if (loading) {
    return (
      <WorkspaceFrame modeLabel="正式产品开发需求单 · 服务端保存" footerNote="04 产品开发需求单 · 正在读取服务端版本" header={<BriefHeader taskId={taskId} loading onRefresh={() => void load()} />}>
        <div className={styles.detailPage}><div className={styles.loadingCard}><Loader2 className={styles.spin} size={22} aria-hidden="true" />正在读取产品开发需求单…</div></div>
      </WorkspaceFrame>
    );
  }

  if (!brief || !draft) {
    return (
      <WorkspaceFrame modeLabel="正式产品开发需求单 · 服务端保存" footerNote="04 产品开发需求单 · 来源事实只读 · 人工方案可编辑" header={<BriefHeader taskId={taskId} onRefresh={() => void load()} />}>
        <div className={styles.detailPage}>
          <div className={styles.stateCard}>
            <FileText size={30} aria-hidden="true" />
            <h2>尚未形成产品开发需求单</h2>
            <p>{data?.stale ? gateBlockMessage(data.staleReason) : "必须先在 03 商品闸门选择「继续推进」。生成过程只读取当前研究、商品事实、买家声音和市场来源依据，不调用外部 AI。"}</p>
            <div className={styles.heroActions}>
              <Link className={styles.secondaryAction} href={`/research/${encodeURIComponent(taskId)}`}>前往商品研究页</Link>
              <button type="button" className={styles.primaryAction} onClick={() => void generate()} disabled={busy || Boolean(data?.stale)} title={data?.stale ? gateBlockMessage(data.staleReason) : undefined}>
                从当前研究生成需求单
              </button>
            </div>
            {data?.stale ? <p className={styles.fieldHint}>当前门禁不满足，生成按钮不可用；请先回研究页处理，服务端不会接受绕过门禁的生成请求。</p> : null}
          </div>
        </div>
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame
      modeLabel="正式产品开发需求单 · 服务端保存"
      footerNote="04 产品开发需求单 · 来源事实只读 · 人工方案可编辑 · 版本/历史/门禁保留"
      header={<BriefHeader taskId={taskId} onRefresh={() => void load()} loading={busy} />}
    >
      <div className={styles.detailPage}>
        {error && !conflict ? <Notice tone="error" role="alert"><ShieldAlert size={16} aria-hidden="true" /><span>{error}</span></Notice> : null}
        {draftNotice ? <Notice tone="info"><ClipboardCopy size={15} aria-hidden="true" /><span>{draftNotice}</span></Notice> : null}
        {phase === "unconfirmed" ? (
          <div className={styles.notice} data-tone="warn" role="alert">
            <ShieldAlert size={16} aria-hidden="true" />
            <div>
              <strong>上次提交的结果还未确认，暂不重复写入。</strong>
              <p>网络中断或响应超时，服务器可能已经保存。请先回读核对；确认未保存后再重试，避免同一份修改写入两次。</p>
              <div className={styles.noticeActions}>
                <button type="button" className={styles.secondaryAction} onClick={() => void reconcilePendingSave()} disabled={busy}>回读确认结果</button>
                <button type="button" className={styles.ghostAction} onClick={downloadLocalDraft}>下载本地草稿</button>
              </div>
            </div>
          </div>
        ) : null}
        {conflict && draft && baseline ? (
          <div className={styles.card}>
            {legacyDraftWithoutBase
              ? <div role="alert">旧草稿缺少原版本，无法安全自动合并。请先下载本地草稿，再对照最新版本手动填写。</div>
              : <BriefConflictPanel base={draftFromBrief(baseline)} latest={draftFromBrief(conflict.latest)} draft={draft} baseRevision={baseline.revision} latestRevision={conflict.latest.revision} busy={busy} onResolve={applyConflictChoices} />}
            {legacyDraftWithoutBase ? <button type="button" className={styles.secondaryAction} onClick={downloadLocalDraft}>下载本地草稿</button> : null}
            <button type="button" className={styles.ghostAction} disabled={busy} onClick={() => {
              if (!window.confirm("确定放弃本标签页尚未保存的输入，使用服务器最新版本？")) return;
              clearStoredDraft();
              setDraft(draftFromBrief(conflict.latest));
              setBaseline(conflict.latest);
              setData((previous) => previous ? { ...previous, brief: conflict.latest } : previous);
              setConflict(null); setLegacyDraftWithoutBase(false); setDraftNotice(null); setPhase("idle");
            }}>放弃未保存输入，使用最新版本</button>
          </div>
        ) : null}
        {notice ? <Notice tone="ok" onClose={() => setNotice(null)}><CheckCircle2 size={16} aria-hidden="true" /><span>{notice}</span></Notice> : null}
        {data?.historyIntegrity === "INVALID" ? <Notice tone="error" role="alert"><ShieldAlert size={16} aria-hidden="true" /><span>历史版本无法读取，已有原始记录已保留，请先检查数据。</span></Notice> : null}

        <section className={styles.identity} data-locked={locked ? "true" : undefined} aria-label="需求单身份">
          <div className={styles.identityCover}>
            <ProductImage
              src={brief.identity.imageUrl}
              alt={`研究参考商品：${brief.identity.title ?? brief.identity.asin}`}
              className={styles.identityImage}
              iconClassName={styles.identityIcon}
              placeholderLabel="暂无商品图"
              testId="brief-detail-reference-image"
            />
          </div>
          <div className={styles.identityMain}>
            <div className={styles.identityChips}>
              <span className={styles.statusChip} data-tone={statusChipTone}>
                {locked ? <LockKeyhole size={12} aria-hidden="true" /> : null}
                {locked ? `历史${statusLabelOf(brief.status)} · 只读` : statusLabelOf(brief.status)}
              </span>
              <span className={styles.sourceChip} data-tone={sourceState.tone === "ok" ? "ok" : "warn"}>{sourceState.label}</span>
              <Chip tone="read">研究参考商品</Chip>
              {syntheticSample ? <Chip tone="warn">隔离联调样本</Chip> : null}
            </div>
            <p className={styles.identityKicker}>04 · 产品开发需求单<em>Product Brief</em></p>
            <h1 className={styles.identityTitle}>拟开发方案</h1>
            <p className={styles.identityPositioning}>{schemePositioning || "尚未填写拟开发定位；可在方案页补充。"}</p>
            <div className={styles.identityMeta}>
              <span>参考商品：{referenceTitle}</span>
              <span>ASIN {brief.identity.asin}</span>
              <span>{brief.identity.marketplace === "US" ? "美国站" : `${brief.identity.marketplace} 站`}</span>
              <span>来源研究 rev.{brief.sourceBinding.researchRevision}</span>
            </div>
          </div>
          <div className={styles.identityAside}>
            <p className={styles.identityAsideKicker}>当前状态</p>
            <strong>{locked ? "历史内容" : statusLabelOf(brief.status)}</strong>
            <span>{locked ? "历史内容只读 · 来源确认后继续" : brief.status === "READY" ? "等待人工评审与批准条件" : brief.status === "APPROVED" ? "可导出用于开发评估" : "仍在整理开发方案"}</span>
            <span className={styles.identityDate}>更新 {formatDate(brief.generatedAt)}</span>
          </div>
        </section>

        <section className={styles.nextStep} data-tone={next?.tone ?? "ok"} aria-label="下一步">
          <div>
            <p className={styles.nextKicker}>下一步</p>
            <p className={styles.nextText}>{next?.text}</p>
          </div>
          {next?.href ? (
            <Link className={styles.primaryAction} href={next.href}>{next.action}<ArrowRight size={14} aria-hidden="true" /></Link>
          ) : (
            <button type="button" className={styles.primaryAction} onClick={() => next?.tab && setBriefView(next.tab)}>{next?.action}<ArrowRight size={14} aria-hidden="true" /></button>
          )}
        </section>

        <section className={styles.researchStrip} data-locked={locked ? "true" : undefined} data-tone={isAuthorityLock ? "warn" : summary?.tone ?? "empty"} aria-label="研究依据">
          <div className={styles.researchMain}>
            <p className={styles.researchKicker}>{locked ? "研究来源 · 历史内容" : "研究依据"}</p>
            {isAuthorityLock ? (
              <p className={styles.researchHeadline}>{sourceLockText}</p>
            ) : summary?.text ? (
              <p className={styles.researchHeadline}>{isHistoricalLock ? <span className={styles.historicalLabel}>历史记录 · 需重新确认</span> : null}{summary.text}</p>
            ) : (
              <p className={styles.researchHeadline}>当前研究没有可展示的买家问题或研究摘要；这里不补写结论。</p>
            )}
            <div className={styles.researchMeta}>
              {isAuthorityLock ? (
                <>
                  <span>V1 与 V5 报告并存</span>
                  <span>需先确认以哪份为准</span>
                  <span>历史需求单 rev.{brief.revision}</span>
                </>
              ) : isGateLock ? (
                <>
                  <span>商品闸门未通过</span>
                  <span>研究结果仍可查看</span>
                  <span>当前内容只读</span>
                </>
              ) : isHistoricalLock ? (
                <>
                  <span>研究证据或市场绑定已更新</span>
                  <span>历史判断不能当作当前结论</span>
                  <span>历史需求单 rev.{brief.revision}</span>
                </>
              ) : (
                <>
                  <span>{summary?.label ?? "研究依据"}</span>
                  <span>研究 rev.{brief.sourceBinding.researchRevision}</span>
                  <span>报告当前有效</span>
                  <span>{evidenceCount} 条证据引用</span>
                  {summary?.isolated ? <span className={styles.researchWarn}>隔离联调样本 · 非市场结论</span> : null}
                </>
              )}
            </div>
            {!locked && briefEvidenceRefs.length ? (
              <details className={styles.researchRefs}>
                <summary>查看引用依据（{briefEvidenceRefs.length}）</summary>
                <p>需求单保存引用 ID，不复制、不改写原文；按引用类型打开 03 对应材料区，不按文字相似度猜测关联。</p>
                <div className={styles.refList}>
                  {briefEvidenceRefs.map((ref) => <a key={ref} href={evidenceHref(taskId, ref)} target="_blank" rel="noreferrer"><code>{ref}</code><ExternalLink size={11} aria-hidden="true" /></a>)}
                </div>
              </details>
            ) : null}
          </div>
          {!locked ? (
            <Link className={styles.researchLink} href={`/research/${encodeURIComponent(taskId)}`}>
              回看商品深研<ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
        </section>

        {preview ? (
          <section className={styles.card} data-testid="brief-preview-panel" aria-label="来源更新后的重新生成预览">
            <div className={styles.sectionHead}>
              <div className={styles.sectionHeadText}>
                <p className={styles.cardKicker}>来源更新</p>
                <h2 className={styles.sectionTitle}>重新生成预览（只读）</h2>
              </div>
              <div className={styles.sectionAside}><button type="button" className={styles.secondaryAction} onClick={() => setPreview(null)} disabled={busy}>取消</button></div>
            </div>
            <p className={styles.sectionLead}>
              当前 rev.{preview.current?.revision ?? "—"} → 新版本 rev.{preview.next.revision}；共 {preview.summary.total} 项变化，其中人工字段 {preview.summary.manual} 项。新版本固定从「{statusLabel[preview.next.status]}」开始，不继承旧批准。
            </p>
            {preview.changes.length === 0 ? (
              <p className={styles.sectionLead}>来源版本已更新，但可见字段没有变化；仍可重新生成以获得新的来源绑定。</p>
            ) : (
              <ul className={styles.previewChanges}>
                {preview.changes.map((row) => (
                  <li key={row.key}>
                    <strong>{row.label}{row.kind === "manual" ? "（人工）" : ""}</strong>
                    <span><s>{row.before ?? "（无）"}</s> → <b>{row.after ?? "（无）"}</b></span>
                  </li>
                ))}
              </ul>
            )}
            <label className={styles.checkboxLine}>
              <input type="checkbox" checked={resetDerived} disabled={previewBusy || busy} onChange={(event) => void openPreview(event.target.checked)} />
              <span>重置研究派生内容（规格方向 / 待确认事项 / 竞品对照 / 验证计划 / 定位）。目标价、目标毛利率等人工输入始终保留。</span>
            </label>
            <div className={styles.previewActions}>
              <button type="button" className={styles.primaryAction} onClick={() => void confirmRegenerate()} disabled={busy || previewBusy}>确认重新生成 rev.{preview.next.revision}</button>
              <span className={styles.fieldHint}>旧版本写入历史；失败不会改动当前需求单与草稿。</span>
            </div>
          </section>
        ) : null}

        <section className={styles.reviewBar} data-locked={locked ? "true" : undefined} aria-label="审阅操作">
          <div className={styles.reviewState}>
            <span className={styles.statusChip} data-tone={statusChipTone}>{locked ? `历史${statusLabelOf(brief.status)} · 只读` : statusLabelOf(brief.status)}</span>
            <span className={styles.reviewRev}>rev.{brief.revision}</span>
            <span className={styles.reviewSync} data-dirty={dirty ? "true" : undefined}>
              {busy ? "保存中…" : phase === "unconfirmed" ? "提交结果待回读确认" : conflict ? "等待版本对照" : phase === "error" ? "保存未完成，输入已保留" : dirty ? `未保存 · ${pendingSections.size} 章有改动` : "全部章节已同步"}
            </span>
            <span className={styles.reviewPreview}>{locked ? "历史内容只读 · 保存与评审不可用" : "跨章节一次保存 · 来源事实只读"}</span>
          </div>
          <div className={styles.reviewActions}>
            {locked ? (
              !isAuthorityLock ? <button type="button" className={styles.secondaryAction} onClick={() => void openPreview()} disabled={previewBusy}>{previewBusy ? "正在读取差异…" : "预览差异并重新生成"}</button> : null
            ) : (
              <>
                <button type="button" className={dirty ? styles.primaryAction : styles.secondaryAction} onClick={saveSections} disabled={busy || phase === "unconfirmed" || Boolean(conflict)} data-testid="brief-save-sections" title={dirty ? "保存全部章节" : "当前没有未保存修改"}>保存修改</button>
                {brief.status === "DRAFT" ? <button type="button" className={styles.secondaryAction} onClick={() => void save("READY")} disabled={busy || phase === "unconfirmed" || Boolean(conflict)} data-testid="brief-mark-ready">标记待评审</button> : null}
                {brief.status !== "DRAFT" ? <button type="button" className={styles.ghostAction} onClick={() => void save("DRAFT")} disabled={busy || phase === "unconfirmed" || Boolean(conflict)}>退回草稿</button> : null}
                <button type="button" className={styles.secondaryAction} onClick={() => void save("APPROVED")} disabled={!canApprove || brief.status === "APPROVED"} title={approvalBlockedReason ?? claimBlocked ?? undefined} data-testid="brief-approve">{brief.status === "APPROVED" ? "已批准" : "批准需求单"}</button>
                {shortGate ? <button type="button" className={styles.gateLink} onClick={() => setBriefView("cost")}>{shortGate}<ArrowRight size={13} aria-hidden="true" /></button> : null}
              </>
            )}
          </div>
        </section>

        <nav className={styles.tabs} role="tablist" aria-label="需求单视图">
          {BRIEF_TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={briefView === entry.id} className={styles.tab} onClick={() => setBriefView(entry.id)}>
              <span>{entry.label}</span>
              {tabDirty(entry.id) ? <i className={styles.tabDirty} aria-label="有未保存修改" /> : null}
            </button>
          ))}
        </nav>

        <div className={styles.detailGrid}>
          <div className={styles.editor} role="tabpanel">
            {briefView === "plan" ? (
              <>
                <Section kicker="产品方案" title="准备开发什么" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工可编辑</Chip>}>
                  <div className={styles.fieldStack}>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>产品定位 {locked ? <Chip tone="warn">历史记录</Chip> : <Chip tone="assumption">开发假设</Chip>}</span>
                      {locked ? (
                        positioning.trim() ? <div className={styles.readOnlyBlock}>{positioning}</div> : <p className={styles.lockedEmpty}>历史需求单没有记录产品定位。</p>
                      ) : (
                        <textarea className={styles.textarea} rows={4} value={positioning} onChange={(event) => setPositioning(event.target.value)} placeholder="描述拟开发产品要解决的问题和定位；保存后仍按待确认假设处理。" />
                      )}
                      <span className={styles.fieldHint}>这是拟开发方案，不改写研究参考商品的品牌、名称、尺寸或材质。</span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>目标用户与使用场景 {locked ? <Chip tone="warn">历史记录</Chip> : <Chip tone="assumption">开发假设</Chip>}{/联调|测试|test/i.test(targetUser) ? <Chip tone="warn">联调样本输入</Chip> : null}</span>
                      {locked ? (
                        targetUser.trim() ? <div className={styles.readOnlyBlock}>{targetUser}</div> : <p className={styles.lockedEmpty}>历史需求单没有记录目标用户与使用场景。</p>
                      ) : (
                        <textarea className={styles.textarea} rows={3} value={targetUser} onChange={(event) => setTargetUser(event.target.value)} placeholder="描述拟服务的用户和场景；没有访谈或证据时请明确写成待验证假设。" />
                      )}
                      <span className={styles.fieldHint}>目标用户需要后续访谈或验证；不把研究参考商品的买家直接当成拟开发产品的用户。</span>
                    </div>
                  </div>
                  <div className={styles.divider} />
                  <div className={styles.readBlock}>
                    <div className={styles.blockTitleRow}><h3>研究给出的差异化方向</h3><Chip tone="read">来源只读</Chip></div>
                    {brief.differentiation.length ? (
                      <ul className={styles.evidenceList}>{brief.differentiation.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul>
                    ) : (
                      <EmptyInline>研究尚未给出带证据的差异化方向；可以在定位中提出假设，待验证后再写入规格。</EmptyInline>
                    )}
                  </div>
                  <p className={styles.sourceNote}><Info size={14} aria-hidden="true" />研究参考商品只提供依据；拟开发定位、目标用户和规格是可编辑假设，不自动继承来源事实。</p>
                </Section>

                {improvementPlan ? (
                  <details className={styles.sourceDetailsBlock}>
                    <summary>研究提出的改良方向（可开发化假设 · 只读）</summary>
                    <div className={styles.detailsBody}><ImprovementPlanSection plan={improvementPlan} /></div>
                  </details>
                ) : null}

                <Section kicker="研究依据" title="研究记录中的买家问题" aside={<Link className={styles.inlineLink} href={`/research/${encodeURIComponent(taskId)}`}>完整研究 →</Link>}>
                  {brief.corePainPoints.length ? (
                    <ul className={styles.evidenceList}>{brief.corePainPoints.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul>
                  ) : (
                    <EmptyInline>当前研究没有带合法引用的买家问题。缺口不是结论，也不能用历史假设补成正式方案。</EmptyInline>
                  )}
                  {brief.userScenarios?.length ? (
                    <div className={styles.scenarioBlock}>
                      <h3>使用场景</h3>
                      <div className={styles.scenarioChips}>{brief.userScenarios.map((line, index) => <span key={`${line.text}:${index}`}>{line.text}</span>)}</div>
                    </div>
                  ) : null}
                </Section>

                <details className={styles.sourceDetailsBlock}>
                  <summary>完整研究依据与假设（只读）</summary>
                  <div className={styles.detailsBody}>
                    {brief.projectOverview ? <div className={styles.readBlock}><h3>研究摘要</h3><ul className={styles.evidenceList}><EvidenceRow line={brief.projectOverview} taskId={taskId} /></ul></div> : null}
                    {brief.causalInvestigations?.length ? (
                      <div className={styles.readBlock}>
                        <h3>逐项原因调查（AI 假设 · 待验证）</h3>
                        {brief.causalInvestigations.map((item, index) => (
                          <div key={`${item.hypothesis.text}:${index}`} className={styles.evidenceRow}>
                            <div className={styles.blockTitleRow}><strong>原因 {index + 1}：{item.hypothesis.text}</strong><Chip tone="assumption">待验证</Chip></div>
                            {item.rationale ? <p className={styles.evidenceMeta}>为什么提出：{item.rationale.text}{item.rationale.evidenceRefs.length ? <a className={styles.evidenceLink} href={evidenceHref(taskId, item.rationale.evidenceRefs[0])} target="_blank" rel="noreferrer">核查依据<ExternalLink size={12} /></a> : null}</p> : null}
                            <p>支持线索：{item.supportingEvidence.length ? item.supportingEvidence.map((line) => line.text).join("；") : "未知"}</p>
                            <p>反证线索：{item.counterevidence.length ? item.counterevidence.map((line) => line.text).join("；") : "未知"}</p>
                            <p>未知：{item.unknowns.length ? item.unknowns.join("；") : "未提供"}</p>
                            <p>验证：{item.verification.length ? item.verification.join("；") : "未提供"}</p>
                            <p className={styles.fieldHint}>AI 可信度 {item.confidence}（非事实确认）</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyInline>当前研报没有逐原因调查；这不等于原因已被确认。</EmptyInline>}
                    {brief.competitiveHypotheses?.length ? <div className={styles.readBlock}><h3>竞争性因果假设（研究来源）</h3><ul className={styles.evidenceList}>{brief.competitiveHypotheses.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                    {brief.supportingEvidence?.length ? <div className={styles.readBlock}><h3>支持当前解释的证据</h3><ul className={styles.evidenceList}>{brief.supportingEvidence.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                    {brief.counterevidence?.length ? <div className={styles.readBlock}><h3>反证 / 可能推翻点</h3><ul className={styles.evidenceList}>{brief.counterevidence.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                    {brief.researchAlternatives?.length ? <div className={styles.readBlock}><h3>备选方案（含保留现状 / 缩小场景 / 停止）</h3><ul className={styles.evidenceList}>{brief.researchAlternatives.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                    {brief.researchAssumptions?.length ? <div className={styles.readBlock}><h3>研究未验证假设（不得当作事实）</h3><ul className={styles.evidenceList}>{brief.researchAssumptions.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                  </div>
                </details>
              </>
            ) : null}

            {briefView === "specs" ? (
              <>
                <Section kicker="规格方向" title="拟开发规格" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工补充</Chip>}>
                  <p className={styles.sectionLead}>从研究参考商品预填的尺寸 / 材质只是参考记录，不是拟开发商品的已确认规格；请人工确认或修改。性质与验证状态由服务端保存记录决定，客户端不能提升事实等级，人工也不能自行标记已验证；修改名称 / 数值 / 单位会移除旧引用并降级为待确认假设、未验证。</p>
                  {locked ? (
                    specRows.length ? (
                      <div className={styles.readOnlyTable}>
                        {specRows.map((row) => (
                          <div key={row.id} className={styles.readOnlySpecRow}>
                            <strong>{row.label}</strong>
                            <span>{row.value}{row.unit ? ` ${row.unit}` : ""}</span>
                            <span>{specNatureLabel(row.nature)}</span>
                            <span>{row.verification === "not_applicable" ? "不适用" : "未验证"}</span>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyInline>历史需求单没有保存规格行。研究提供的规格线索在下方只读区。</EmptyInline>
                  ) : (
                    <>
                      {specRows.length ? (
                        <div className={styles.editRows}>
                          {specRows.map((row, index) => (
                            <div key={row.id} className={styles.specEditBlock}>
                              <div className={styles.specEditRow}>
                                <label className={styles.miniField}><span>名称</span><input className={styles.input} value={row.label} onChange={(event) => updateSpec(index, { label: event.target.value })} /></label>
                                <label className={styles.miniField}><span>数值</span><input className={styles.input} value={row.value} onChange={(event) => updateSpec(index, { value: event.target.value })} /></label>
                                <label className={styles.miniField}><span>单位</span><input className={styles.input} value={row.unit ?? ""} onChange={(event) => updateSpec(index, { unit: event.target.value || null })} /></label>
                                <label className={styles.miniField}><span>性质</span><select className={styles.select} value={row.nature} disabled title="由服务端保存记录决定；修改内容会自动降级"><option value="ASSUMPTION">待确认假设</option><option value="EVIDENCE_DERIVED" disabled={!row.evidenceRefs.length}>证据推导（需引用）</option><option value="FACT" disabled={!row.evidenceRefs.length}>参考记录（需引用）</option></select></label>
                                <label className={styles.miniField}><span>验证</span><select className={styles.select} value={row.verification} disabled title="由服务端保存记录决定；人工不能自行标记已验证"><option value="unverified">未验证</option><option value="not_applicable">不适用</option></select></label>
                                <button type="button" className={styles.removeButton} onClick={() => removeSpec(index)} aria-label="删除规格行"><Trash2 size={14} aria-hidden="true" /></button>
                              </div>
                              <div className={styles.specEvidence}>
                                {row.evidenceRefs.length ? (
                                  <>
                                    <span>来源引用：</span>
                                    {row.evidenceRefs.map((ref) => <a key={ref} href={evidenceHref(taskId, ref)} target="_blank" rel="noreferrer"><code>{ref}</code></a>)}
                                    <span className={styles.specEvidenceHint}>修改名称 / 数值 / 单位会移除旧引用并降级为待确认假设；原始证据仍可在 03 与历史版本查看。</span>
                                  </>
                                ) : <span className={styles.evidenceNoRef}>无来源引用 · 仅可标为待确认假设</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : <EmptyInline>尚未添加规格行。研究提供的规格线索在下方只读区。</EmptyInline>}
                      <div className={styles.addRow}><button type="button" className={styles.addButton} onClick={addSpec}><Plus size={14} aria-hidden="true" />添加规格行</button></div>
                    </>
                  )}
                  <details className={styles.sourceDetails}>
                    <summary>研究提供的规格线索（{brief.specsDirection.length}）</summary>
                    {brief.specsDirection.length ? <ul className={styles.evidenceList}>{brief.specsDirection.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul> : <EmptyInline>研究未提供规格线索。</EmptyInline>}
                  </details>
                </Section>

                <Section kicker="竞品对照" title="本品与基准差在哪" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工补充</Chip>}>
                  <p className={styles.sectionLead}>对照表没有逐字段来源绑定；本品 / 对照基准均为人工整理或研究参考记录，所有行只能作为待确认假设，不能标为确认事实。修改后按人工假设保存，原始内容与历史版本保留。</p>
                  {locked ? (
                    comparisonRows.length ? (
                      <div className={styles.readOnlyTable}>
                        {comparisonRows.map((row) => (
                          <div key={row.id} className={styles.readOnlyCompareRow}>
                            <strong>{row.label}</strong>
                            <span>{row.ours ?? "未采集"}</span>
                            <span>{row.theirs ?? "未采集"}</span>
                            <span>{comparisonOriginLabel(row)}</span>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyInline>历史需求单没有保存竞品对照。</EmptyInline>
                  ) : (
                    <>
                      {comparisonRows.length ? (
                        <div className={styles.editRows}>
                          {comparisonRows.map((row, index) => (
                            <div key={row.id} className={styles.compareEditRow}>
                              <label className={styles.miniField}><span>维度</span><input className={styles.input} value={row.label} onChange={(event) => updateComparison(index, { label: event.target.value })} /></label>
                              <label className={styles.miniField}><span>本品</span><input className={styles.input} value={row.ours ?? ""} placeholder="未采集" onChange={(event) => updateComparison(index, { ours: event.target.value || null })} /></label>
                              <label className={styles.miniField}><span>对照基准</span><input className={styles.input} value={row.theirs ?? ""} placeholder="未采集" onChange={(event) => updateComparison(index, { theirs: event.target.value || null })} /></label>
                              <div className={styles.miniField}><span>来源性质</span><span className={styles.specMetaValue}>{comparisonOriginLabel(row)}</span></div>
                              <button type="button" className={styles.removeButton} onClick={() => removeComparison(index)} aria-label="删除对照行"><Trash2 size={14} aria-hidden="true" /></button>
                            </div>
                          ))}
                        </div>
                      ) : <EmptyInline>暂无对照行。</EmptyInline>}
                      <div className={styles.addRow}><button type="button" className={styles.addButton} onClick={addComparison}><Plus size={14} aria-hidden="true" />添加对照行</button></div>
                    </>
                  )}
                  <p className={styles.sourceNote}><Info size={14} aria-hidden="true" />「来源对照记录（待确认）」只表示该行来自研究参考记录，不等于拟开发商品或人工填写值的确认事实；导出保持同一口径。</p>
                </Section>

                <Section kicker="基准商品" title="研究使用的对照样本" aside={<Chip tone="read">来源只读</Chip>}>
                  {brief.benchmarks.length ? (
                    <div className={styles.benchmarkList}>
                      {brief.benchmarks.map((benchmark) => (
                        <article key={`${benchmark.asin}:${benchmark.role}`} className={styles.benchmarkCard}>
                          <ProductImage src={benchmark.imageUrl} alt={benchmark.title ?? benchmark.asin} className={styles.benchmarkImage} iconClassName={styles.benchmarkIcon} placeholderLabel="暂无图片" />
                          <div>
                            <p className={styles.benchmarkRole}>{benchmark.role === "pain_point" ? "痛点样本" : benchmark.role === "newcomer" ? "新进入者" : benchmark.role === "benchmark" ? "基准" : "快速通道"}</p>
                            <h3>{benchmark.title ?? benchmark.asin}</h3>
                            <p className={styles.benchmarkMeta}>{benchmark.asin} · {benchmark.marketplace} · {benchmark.evidenceRefs.length} 条证据引用</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : <EmptyInline>研究未绑定基准商品。</EmptyInline>}
                </Section>
              </>
            ) : null}

            {briefView === "cost" ? (
              <>
                <Section kicker="目标与费用" title="成本条件" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工输入</Chip>}>
                  <p className={styles.sectionLead}>{locked ? "历史需求单保存的成本条件；来源确认后可继续修改。" : "费用按件填写；未知留空。人工费用需核实来源，FBA 保持只读。"}</p>
                  {locked ? (
                    <div className={styles.readOnlyCostGrid}>
                      {COST_FIELDS.map(([label, key, unit]) => (
                        <div key={key} className={styles.readOnlyCostRow}><span>{label}</span><strong>{draft[key].trim() || "未提供"}</strong><em>{unit}</em></div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.costGrid}>
                      {COST_FIELDS.map(([label, key, unit, hint]) => (
                        <label key={key} className={styles.costField}>
                          <span className={styles.fieldLabel}>{label}</span>
                          <span className={styles.inputUnit}><input className={styles.input} inputMode="decimal" value={draft[key]} onChange={(event) => updateField(key, event.target.value)} /><i>{unit}</i></span>
                          <span className={styles.fieldHint}>{hint}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className={styles.fbaRow}>
                    <div>
                      <p className={styles.fbaLabel}>FBA 费用</p>
                      <strong>{brief.economics.fbaFee === null ? "未提供" : formatMoney(brief.economics.fbaFee, brief.economics.currency)}</strong>
                      <p className={styles.fieldHint}>只读来源：Amazon 商品页不提供该字段；系统不把第三方浮层数值当作商品事实，04 页面不提供手工补填。</p>
                    </div>
                    <Link className={styles.inlineLink} href={`/research/${encodeURIComponent(taskId)}`}>查看来源 →</Link>
                  </div>
                </Section>

                <Section kicker="采购上限" title="按当前输入能承受多少采购成本" aside={<Chip tone="read">确定性计算</Chip>}>
                  <div className={styles.ceilingRow}>
                    <div>
                      <p className={styles.ceilingValue} data-status={liveCeiling?.status}>{liveCeiling?.status === "COMPUTED" ? formatMoney(liveCeiling.value, liveCeiling.currency ?? brief.economics.currency) : "暂不可计算"}</p>
                      <p className={styles.ceilingHint}>{liveCeiling?.status === "COMPUTED" ? "按当前输入计算；保存后服务端会按同一口径重新计算。" : liveCeiling?.reason ?? "成本项不完整。"}</p>
                    </div>
                    {missingCosts.length ? <div className={styles.missingChips}>{missingCosts.map((item) => <span key={item}>{item}</span>)}</div> : null}
                  </div>
                  <details className={styles.sourceDetails}><summary>查看计算公式</summary><p>{liveCeiling?.formula}</p></details>
                </Section>

                <Section kicker="批准条件" title="为什么现在不能批准" aside={canApprove ? <Chip tone="ok">条件已满足</Chip> : <Chip tone="warn">未满足</Chip>}>
                  <p className={styles.gateLead}>{approvalBlockedReason ? shortApprovalReason(approvalBlockedReason) : claimBlocked ? "研报表述审查未通过" : "目标价格、毛利率与采购上限均可计算，可以进入批准。"}</p>
                  {approvalBlockedReason ? <details className={styles.sourceDetails}><summary>查看完整门禁说明</summary><p>{approvalBlockedReason}</p></details> : null}
                  {claimBlocked ? <p className={styles.gateNote}>研究表述审查：{claimConsumptionNotice(brief.claimAudit)}</p> : null}
                  <p className={styles.gateNote}>批准只代表可进入开发评估，不代表供应商、成本或量产已就绪。</p>
                </Section>
              </>
            ) : null}

            {briefView === "confirm" ? (
              <>
                <Section kicker="待确认事项" title="需要人工或供应商回答什么" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工核实</Chip>}>
                  <p className={styles.sectionLead}>这里只列出“需要确认什么”；系统不填写 MOQ、打样周期、报价或生产能力，答案由人工或供应商给出。</p>
                  {locked ? (
                    confirmRows.length ? (
                      <div className={styles.readOnlyTable}>
                        {confirmRows.map((row) => (
                          <div key={row.id} className={styles.readOnlyConfirmRow}><strong>{row.item}</strong><span>{row.status}</span><span>{row.reason ?? "—"}</span></div>
                        ))}
                      </div>
                    ) : <EmptyInline>历史需求单没有保存待确认事项。</EmptyInline>
                  ) : (
                    <>
                      {confirmRows.length ? (
                        <div className={styles.editRows}>
                          {confirmRows.map((row, index) => (
                            <div key={row.id} className={styles.confirmEditRow}>
                              <label className={styles.miniField}><span>待确认事项</span><input className={styles.input} value={row.item} onChange={(event) => updateConfirm(index, { item: event.target.value })} /></label>
                              <label className={styles.miniField}><span>状态</span><select className={styles.select} value={row.status} onChange={(event) => updateConfirm(index, { status: event.target.value as ProductBriefConfirmationItem["status"] })}><option value="待确认">待确认</option><option value="已确认">已确认</option><option value="不适用">不适用</option></select></label>
                              <label className={styles.miniField}><span>原因 / 说明</span><input className={styles.input} value={row.reason ?? ""} onChange={(event) => updateConfirm(index, { reason: event.target.value || null })} placeholder="例：需要供应商确认" /></label>
                              <button type="button" className={styles.removeButton} onClick={() => removeConfirm(index)} aria-label="删除确认事项"><Trash2 size={14} aria-hidden="true" /></button>
                            </div>
                          ))}
                        </div>
                      ) : <EmptyInline>暂无待确认事项。</EmptyInline>}
                      <div className={styles.addRow}><button type="button" className={styles.addButton} onClick={addConfirm}><Plus size={14} aria-hidden="true" />添加确认事项</button></div>
                    </>
                  )}
                </Section>
                <Section kicker="VOC 转需求" title="研究提出的需求线索" aside={<Chip tone="read">来源只读</Chip>}>
                  <p className={styles.sectionLead}>仅当同一类买家痛点反复出现（recurring）时才派生改进方向，每条都带证据引用。它们是待验证的开发假设，不是已确认的产品要求；少量反馈不会自动成为产品要求。</p>
                  {brief.vocRequirements === undefined ? (
                    <EmptyInline>旧版需求单尚无改进方向段：重新生成后将自动从 recurring VOC 痛点派生。</EmptyInline>
                  ) : brief.vocRequirements.length ? (
                    <ul className={styles.evidenceList}>{brief.vocRequirements.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul>
                  ) : (
                    <EmptyInline>当前 VOC 证据中没有「反复出现」级别的痛点，因此没有可派生的改进方向。</EmptyInline>
                  )}
                </Section>
              </>
            ) : null}

            {briefView === "verify" ? (
              <>
                <Section kicker="验证计划" title="下一步验证什么" aside={locked ? <Chip tone="warn">历史只读</Chip> : <Chip tone="edit">人工补充</Chip>}>
                  <p className={styles.sectionLead}>由研究缺口生成；人工补充验证方法与时点，并更新状态。状态变更需人工保存。</p>
                  {locked ? (
                    (brief.verificationPlan?.length ?? 0) ? (
                      <div className={styles.readOnlyTable}>
                        {brief.verificationPlan?.map((row) => (
                          <div key={row.id} className={styles.readOnlyVerifyRow}><strong>{row.item}</strong><span>{row.method || "—"}</span><span>{row.timing || "—"}</span><span>{row.status === "done" ? "已完成" : row.status === "dropped" ? "已放弃" : "待验证"}</span></div>
                        ))}
                      </div>
                    ) : <EmptyInline>历史需求单没有保存验证计划。</EmptyInline>
                  ) : (
                    <>
                      {verificationRows.length ? (
                        <div className={styles.editRows}>
                          {verificationRows.map((row, index) => {
                            const note = snapshotAnnotationNote(annotateSnapshotItem(row.item, decisionSummary.economics));
                            return (
                              <div key={row.id} className={styles.verifyEditBlock}>
                                <div className={styles.verifyEditRow}>
                                  <label className={styles.miniField}><span>验证项</span><input className={styles.input} value={row.item} onChange={(event) => updateVerification(index, { item: event.target.value })} /></label>
                                  <label className={styles.miniField}><span>方法</span><input className={styles.input} value={row.method} onChange={(event) => updateVerification(index, { method: event.target.value })} placeholder="例：竞品价格带复核" /></label>
                                  <label className={styles.miniField}><span>时点</span><input className={styles.input} value={row.timing} onChange={(event) => updateVerification(index, { timing: event.target.value })} placeholder="例：本周" /></label>
                                  <label className={styles.miniField}><span>状态</span><select className={styles.select} value={row.status} onChange={(event) => updateVerification(index, { status: event.target.value as ProductBriefVerificationItem["status"] })}><option value="pending">待验证</option><option value="done">已完成</option><option value="dropped">已放弃</option></select></label>
                                  <button type="button" className={styles.removeButton} onClick={() => removeVerification(index)} aria-label="删除验证项"><Trash2 size={14} aria-hidden="true" /></button>
                                </div>
                                {note ? <p className={styles.snapshotNote}>{note}</p> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : <EmptyInline>暂无验证项。</EmptyInline>}
                      <div className={styles.addRow}><button type="button" className={styles.addButton} onClick={addVerification}><Plus size={14} aria-hidden="true" />添加验证项</button></div>
                    </>
                  )}
                </Section>
                <Section kicker="研究缺口" title="还没有被验证的事情" aside={<Chip tone="read">来源只读</Chip>}>
                  {showMissing.length ? <ul className={styles.plainList}>{showMissing.map((item) => <li key={item}><span>{item}</span></li>)}</ul> : <EmptyInline>当前没有登记的来源缺口。</EmptyInline>}
                  <p className={styles.sourceNote}><Info size={14} aria-hidden="true" />这些是研究尚未验证的事项，不是已确认的缺陷或结论；不补 0、不猜测。</p>
                </Section>
                <details className={styles.sourceDetailsBlock}>
                  <summary>来源风险与 QA 红线（只读）</summary>
                  <div className={styles.detailsBody}>
                    {brief.vocQaRedlines.length ? <div className={styles.readBlock}><h3>VOC 质量红线</h3><ul className={styles.evidenceList}>{brief.vocQaRedlines.map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : <EmptyInline>当前没有带合法引用的失败模式。</EmptyInline>}
                    {brief.risks.length || brief.rationale.length ? <div className={styles.readBlock}><h3>研究风险与形成理由</h3><ul className={styles.evidenceList}>{[...brief.risks, ...brief.rationale].map((line, index) => <EvidenceRow key={`${line.text}:${index}`} line={line} taskId={taskId} />)}</ul></div> : null}
                  </div>
                </details>
              </>
            ) : null}
          </div>

          <aside className={styles.side}>
            <section className={styles.sideCard}>
              <p className={styles.sideKicker}>开发条件</p>
              <div className={styles.metricList}>
                <div><span>目标售价</span><strong>{formatMoney(numberOrNull(targetPrice), brief.economics.currency)}</strong></div>
                <div><span>目标毛利率</span><strong>{targetMarginPct.trim() ? `${targetMarginPct}%` : "未提供"}</strong></div>
                <div><span>FBA</span><strong className={brief.economics.fbaFee === null ? styles.metricWarn : undefined}>{brief.economics.fbaFee === null ? "未提供" : formatMoney(brief.economics.fbaFee, brief.economics.currency)}</strong></div>
                <div><span>采购上限</span><strong>{liveCeiling?.status === "COMPUTED" ? formatMoney(liveCeiling.value, liveCeiling.currency ?? brief.economics.currency) : "暂不可计算"}</strong></div>
              </div>
              <button type="button" className={styles.sideLink} onClick={() => setBriefView("cost")}>{locked ? "查看成本" : "去补成本"}<ArrowRight size={14} aria-hidden="true" /></button>
            </section>

            <section className={styles.sideCard}>
              <p className={styles.sideKicker}>待确认与验证</p>
              <div className={styles.countGrid}>
                <div><strong>{pendingConfirm}</strong><span>待确认</span></div>
                <div><strong>{pendingVerify}</strong><span>待验证</span></div>
                <div><strong>{brief.missingValidation.length}</strong><span>研究缺口</span></div>
              </div>
              <button type="button" className={styles.sideLink} onClick={() => setBriefView("confirm")}>{locked ? "查看待确认" : "处理待确认"}<ArrowRight size={14} aria-hidden="true" /></button>
            </section>

            <section className={styles.sideCard}>
              <details className={styles.archive}>
                <summary><span>限制与档案</span><em>{brief.missingValidation.length + (claimBlocked ? 1 : 0) + (locked ? 1 : 0)} 项</em><ChevronDown size={15} aria-hidden="true" /></summary>
                <div className={styles.archiveBody}>
                  <p className={styles.archiveLead}>来源限制、技术标识和历史版本集中在这里，不占据首屏。</p>
                  {locked ? <div className={styles.archiveItem}><strong>来源锁定 · {sourceState.label}</strong><p>{lockedArchiveText}</p></div> : null}
                  {brief.claimAudit && brief.claimAudit.verdict !== "CONSISTENT" ? <div className={styles.archiveItem}><strong>研报表述审查 · {brief.claimAudit.verdict}</strong><p>{claimConsumptionNotice(brief.claimAudit)}</p></div> : null}
                  {approvalBlockedReason ? <div className={styles.archiveItem}><strong>批准条件未满足</strong><p>{approvalBlockedReason}</p></div> : null}
                  <dl className={styles.archiveDl}>
                    <div><dt>研究参考商品</dt><dd>{brief.identity.title ?? "—"}</dd></div>
                    <div><dt>商品 ASIN</dt><dd>{brief.identity.asin}</dd></div>
                    <div><dt>任务 ID</dt><dd><code>{brief.sourceBinding.taskId}</code></dd></div>
                    <div><dt>报告 Hash</dt><dd><code title={brief.sourceBinding.reportHash}>{shortHash(brief.sourceBinding.reportHash)}</code></dd></div>
                    <div><dt>事实 Hash</dt><dd><code title={brief.sourceBinding.factHash}>{shortHash(brief.sourceBinding.factHash)}</code></dd></div>
                    <div><dt>证据 Hash</dt><dd><code title={brief.sourceBinding.evidenceHash}>{shortHash(brief.sourceBinding.evidenceHash)}</code></dd></div>
                    {brief.sourceBinding.marketScanId ? <div><dt>市场扫描</dt><dd><code>{brief.sourceBinding.marketScanId}</code></dd></div> : null}
                  </dl>
                  <div className={styles.archiveActions}>
                    <button type="button" className={styles.secondaryAction} onClick={exportMarkdown}><FileDown size={14} aria-hidden="true" />导出 Markdown</button>
                    <button type="button" className={styles.secondaryAction} onClick={() => void copyMarkdown()}><ClipboardCopy size={14} aria-hidden="true" />复制</button>
                    <button type="button" className={styles.ghostAction} onClick={() => window.print()}><Printer size={14} aria-hidden="true" />打印</button>
                    <button type="button" className={styles.ghostAction} onClick={downloadLocalDraft}><FileText size={14} aria-hidden="true" />下载本地草稿</button>
                  </div>
                  <p className={styles.fieldHint}>导出 / 复制使用已保存版本，不含本标签页未保存输入；下载草稿仅供人工留档，不是正式需求单。</p>
                  {history.length ? <BriefHistoryPanel history={history} current={brief} /> : <p className={styles.fieldHint}>暂无更早的历史版本。</p>}
                </div>
              </details>
            </section>
          </aside>
        </div>

        <details className={styles.summaryBlock}>
          <summary>评审摘要（决策、关键未知、停止条件）</summary>
          <div className={styles.summaryBody}><BriefDecisionSummaryCard summary={decisionSummary} /></div>
        </details>

        <p className={styles.detailNote}><PencilLine size={14} aria-hidden="true" />人工编辑保存在同一份需求单草稿中；来源事实、FBA 与证据引用保持只读。所有状态变更都由人工保存，AI 与页面不会自动批准。</p>
      </div>
    </WorkspaceFrame>
  );
}

function BriefHeader({ taskId, onRefresh, loading = false }: { taskId: string; onRefresh: () => void; loading?: boolean }) {
  return (
    <header className={styles.detailHeader}>
      <div className={styles.detailBreadcrumb}>
        <Link href="/product-brief"><ArrowLeft size={15} aria-hidden="true" />需求单列表</Link>
        <span>/</span>
        <Link href={`/research/${encodeURIComponent(taskId)}`}>商品深研</Link>
        <span>/</span>
        <strong>04 产品开发需求单</strong>
      </div>
      <div className={styles.detailHeaderActions}>
        <button type="button" className={styles.secondaryAction} onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
          刷新读取
        </button>
      </div>
    </header>
  );
}

function Notice({ tone, role = "status", onClose, children }: { tone: "ok" | "info" | "warn" | "error"; role?: "status" | "alert"; onClose?: () => void; children: ReactNode }) {
  return (
    <div className={styles.notice} data-tone={tone} role={role}>
      {children}
      {onClose ? <button type="button" aria-label="关闭提示" onClick={onClose}><X size={14} aria-hidden="true" /></button> : null}
    </div>
  );
}
