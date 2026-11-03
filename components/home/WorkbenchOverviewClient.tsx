"use client";

import Link from "next/link";
import Image from "next/image";
import { projectWorkspaceCounts } from "@/lib/client/workflowCounts";
import { useEffect, useState, useCallback } from "react";
import { ArrowUpRight, Compass, ExternalLink, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { AtelierHeading } from "@/components/ui/Atelier";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import { Dialog } from "@/components/ui/Dialog";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { FeishuConnectionDrawer } from "@/components/feishu/FeishuConnectionDrawer";
import { QuickAsinIngress } from "@/components/home/QuickAsinIngress";
import { ProductIdentity } from "@/components/ui/ProductIdentity";

export type HomeSummaryPayload = {
  source?: { batchCount?: number; itemCount?: number };
  market?: { scanCount?: number; sampleCount?: number };
  research?: { taskCount?: number; pendingCandidateCount?: number };
  counts?: {
    sourceBatches?: number;
    sourceItems?: number;
    marketScans?: number;
    marketSamples?: number;
    researchTotal?: number;
    researchNeedsChoice?: number;
    researchInProgress?: number;
    choiceProceed?: number;
    choiceWatch?: number;
    choiceDrop?: number;
    archived?: number;
  };
  /** 决策状态分项只读计数；缺失时前端回退合并的 counts.choiceWatch。 */
  decision?: {
    paused?: number;
    validateMore?: number;
  };
  pipeline?: {
    source?: { totalBatches?: number; totalItems?: number; readyCount?: number; needsReviewCount?: number };
    market?: { totalScans?: number; totalSamples?: number };
    research?: { inProgress?: number; needsChoice?: number };
    choices?: { total?: number; proceed?: number; watch?: number; drop?: number };
  };
  nextAction?:
    | string
    | {
        type?: string;
        title?: string;
        description?: string;
        href?: string;
        ctaLabel?: string;
        /** D0-006：与动作同主体的业务对象；无合格对象时缺省，前端不得拼接任意商品。 */
        subject?: {
          kind?: "research" | "brief" | "market_scan";
          subjectId?: string;
          asin?: string | null;
          title?: string | null;
          image?: string | null;
        } | null;
      };
  decisionQueue?: Array<{
    taskId: string;
    asin: string;
    title: string | null;
    image: string | null;
    deepseekSummary: string | null;
    riskGateStatus: string | null;
    compositeSuggestion: "recommend_proceed" | "watch_carefully" | "recommend_drop" | "no_suggestion";
    updatedAt: string;
  }>;
  recentScans?: Array<{
    scanId: string;
    scanName: string;
    sampleCount: number;
    medianPrice?: { amount: number; currency: string } | null;
    cr5?: number | null;
    createdAt: string;
  }>;
  feishu?: {
    configured?: boolean;
    syncedMarketBatches?: number;
    syncedResearchRows?: number;
    baseOpenUrl?: string | null;
    lastSyncAt?: string | null;
  };
};

/**
 * 首页「暂缓」摘要：服务端给出 decision 分项时显示「暂缓观察 X · 需补充验证 Y」；
 * 旧响应只有合并计数时回退旧文案，保持兼容。
 */
export function formatDecisionWatchSummary(input: {
  readonly watch?: number;
  readonly paused?: number;
  readonly validateMore?: number;
}): string {
  const paused = normalizeCount(input.paused);
  const validateMore = normalizeCount(input.validateMore);
  if (paused === null || validateMore === null) return `${normalizeCount(input.watch) ?? 0} 暂缓`;
  return `暂缓观察 ${paused} · 需补充验证 ${validateMore}`;
}

function normalizeCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

export function WorkbenchOverviewClient() {
  const [quickOpen, setQuickOpen] = useState(false);
  const [data, setData] = useState<HomeSummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feishuDrawerOpen, setFeishuDrawerOpen] = useState(false);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/home/summary", {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message || `数据读取失败 (${res.status})`);
      }
      setData(json.data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "获取工作台总览失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // Derive counts
  const projectedCounts = projectWorkspaceCounts(data);
  const { sourceBatches, sourceItems, marketScans, marketSamples, researchInProgress, researchNeedsDecision: researchNeedsChoice } = projectedCounts;

  const isCompletelyEmpty =
    !loading &&
    !errorMsg &&
    sourceBatches === 0 &&
    sourceItems === 0 &&
    marketScans === 0 &&
    researchInProgress === 0 &&
    (data?.decisionQueue?.length ?? 0) === 0;

  // 下一步动作：完全以服务端 `nextAction` 为权威，前端只做展示标准化。
  // 前端不再根据 counts 自行推导业务下一步；服务端未给出建议时展示中性状态。
  let nextAction: {
    type?: string;
    title: string;
    description: string;
    href: string;
    ctaLabel: string;
    subject?: {
      kind?: string;
      subjectId?: string;
      asin?: string | null;
      title?: string | null;
      image?: string | null;
    } | null;
  } | null = null;
  if (typeof data?.nextAction === "string" && data.nextAction.trim()) {
    const serverAction = data.nextAction.trim();
    if (serverAction.includes("等待商业决断") || serverAction.includes("商业决策")) {
      nextAction = {
        title: serverAction,
        description: "基于真实事实基线与深度研报，请在第一屏做出关键商业决断：继续推进、需补充验证、暂缓或放弃。",
        href: data?.decisionQueue?.[0]?.taskId ? `/research/${data.decisionQueue[0].taskId}` : "/research?view=needs_decision",
        ctaLabel: "去做商业决策 ➔",
      };
    } else if (serverAction === "完成研究交接" || serverAction.includes("交接") || serverAction.includes("发起深度商品研究")) {
      nextAction = {
        title: serverAction,
        description: "已有选出的潜力商品，前往推进深度商品研报与数据提炼。",
        href: "/research",
        ctaLabel: "进入商品研究 ➔",
      };
    } else if (serverAction === "创建市场研究") {
      nextAction = {
        title: "商品资料已导入，创建市场研究",
        description: "已有商品资料，立即发起市场大盘分析与竞品扫描。",
        href: "/market-analysis",
        ctaLabel: "创建市场研究 ➔",
      };
    } else if (serverAction === "导入商品来源") {
      nextAction = {
        title: "录入或导入首批商品",
        description: "使用上方快速输入 ASIN 开始研究，或前往 01 市场采集导入数据。",
        href: "/source",
        ctaLabel: "前往市场采集 ➔",
      };
    } else {
      nextAction = {
        title: serverAction,
        description: "",
        href: "/research",
        ctaLabel: "查看详情 ➔",
      };
    }
  } else if (data?.nextAction && typeof data.nextAction === "object") {
    nextAction = {
      type: data.nextAction.type,
      title: data.nextAction.title || "下一步行动",
      description: data.nextAction.description || "",
      href: data.nextAction.href || "/research",
      ctaLabel: data.nextAction.ctaLabel || "立即执行 ➔",
      subject: data.nextAction.subject ?? null,
    };
  }

  return <>
    <WorkspaceFrame footerNote="研究有据，决定由你。" header={
      <AtelierHeading eyebrow="产品探索工作台" title="把好问题，推进成好产品。"
        description="继续处理眼前最重要的一步，让证据与判断始终相伴。"
        actions={<><Button onClick={() => setQuickOpen(true)}><Plus size={16} />快速补录 ASIN</Button><Button aria-label="刷新总览" onClick={fetchSummary} disabled={loading}><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></Button></>} />
    }>
      {loading ? <div className="lc-home-loading"><Skeleton className="h-72 rounded-3xl" /><Skeleton className="h-72 rounded-3xl" /></div>
      : errorMsg ? <section className="lc-status-panel" role="alert"><ShieldAlert size={24} /><h2>暂时未能读取工作台</h2><p>{errorMsg}</p><Button onClick={fetchSummary}>重新读取</Button><Link href="/source">进入市场采集 →</Link></section>
      : <>
        <div className="lc-home-hero-grid" role="region" aria-label="轻选工作台总览 · 商品研究">
          <section className="lc-home-hero" aria-label="下一步建议">
            <div className="lc-hero-copy"><p className="lc-eyebrow">NEXT ACTION / 继续上次研究</p>
              <span
                className="lc-soft-tag"
                data-testid="next-action-soft-tag"
              >
                {isCompletelyEmpty
                  ? "从第一条线索开始"
                  : nextAction?.type === "PRODUCT_BRIEF" && nextAction?.title?.startsWith("查看")
                    ? "已有判断与需求单"
                    : nextAction?.type === "PRODUCT_DECISION"
                      ? "待人工判断"
                      : data?.decisionQueue?.length
                        ? "待人工判断"
                        : "继续推进工作流"}
              </span>
              <h2>{nextAction?.title || (isCompletelyEmpty ? "让每一个想法，\n都有据可循。" : "留一点时间，\n看清下一个好问题。")}</h2>
              <p>{nextAction?.description || (isCompletelyEmpty ? "先收集市场线索，再慢慢打磨成值得做的产品。" : "当前暂无待处理的建议，可以回看已有研究与来源。")}</p>
              {nextAction?.subject && (nextAction.subject.asin || nextAction.subject.title) && <div className="lc-action-subject" data-testid="next-action-subject">
                {nextAction.subject.asin ? <ProductIdentity image={nextAction.subject.image ?? null} title={nextAction.subject.title ?? null} asin={nextAction.subject.asin} marketplace="US" size="sm" /> : <span>对象：{nextAction.subject.title}</span>}
              </div>}
              {nextAction?.href ? <Link className="lc-hero-cta" href={nextAction.href}>{nextAction.ctaLabel || "继续研究"}<ArrowUpRight size={17} /></Link> :
                <Link className="lc-hero-cta" href={isCompletelyEmpty ? "/source" : "/research"}>{isCompletelyEmpty ? "开启第一次探索" : "进入研究工作区"}<ArrowUpRight size={17} /></Link>}
            </div>
            <div className="lc-compass-art" aria-hidden="true"><div className="lc-orbit lc-orbit-one" /><div className="lc-orbit lc-orbit-two" /><Image src="/project-icon.webp" alt="" width={205} height={205} priority /><span>轻选工作台</span></div>
          </section>
          <aside className={activeStyles.homeShortcuts} aria-label="常用工作入口">
            <h2>常用工作入口</h2><p>主任务在左侧继续，其他工作从这里进入。</p>
            <Link href="/source">来源批次 <ArrowUpRight size={16} /></Link>
            <Link href="/market-analysis">市场研究 <ArrowUpRight size={16} /></Link>
            <Link href="/product-brief">开发需求单 <ArrowUpRight size={16} /></Link>
          </aside>
        </div>
        <WorkflowProgress data={data} />
        <section className="lc-research-queue" aria-label="待我决策队列">
          <div className="lc-section-heading"><div><p className="lc-eyebrow">ON YOUR DESK</p><h2>等待你的判断</h2></div><Link href="/research">全部研究 <ArrowUpRight size={15} /></Link></div>
          {data?.decisionQueue?.length ? <div className="lc-product-grid">{data.decisionQueue.slice(0, 6).map(item =>
            <article className="lc-product-card" key={item.taskId}>
              <div className="lc-product-identity"><ProductIdentity image={item.image} title={item.title} asin={item.asin} marketplace="US" size="md" /></div>
              <details className={activeStyles.queueNote}><summary>已保存的研究摘要</summary><p>{item.deepseekSummary || "打开研究，查看已保存的证据与待核实事项。"}</p></details>
              <div><Badge tone={item.compositeSuggestion === "recommend_proceed" ? "emerald" : item.compositeSuggestion === "recommend_drop" ? "rose" : "amber"}>
                {item.compositeSuggestion === "recommend_proceed" ? "AI 建议推进" : item.compositeSuggestion === "watch_carefully" ? "AI 建议谨慎观察" : item.compositeSuggestion === "recommend_drop" ? "AI 建议放弃" : "暂无建议"}</Badge>
                <Link href={"/research/" + item.taskId}>查看研究 <ArrowUpRight size={14} /></Link></div>
            </article>)}</div> : <div className="lc-quiet-empty"><span className="lc-empty-glyph"><Compass size={24} /></span><div><h3>好研究，从一个好问题开始。</h3><p>目前没有等待决策的商品。收集一批来源，或回到市场挑选代表商品。</p></div><Link href="/source">去发现线索 <ArrowUpRight size={15} /></Link></div>}
        </section>
        <details className={activeStyles.disclosure}><summary>最近探索的市场 · 近期记录</summary><section className="lc-market-recent" aria-label="最近市场洞察"><div className="lc-section-heading"><div><p className="lc-eyebrow">最近研究</p><h2>最近探索的市场</h2></div><Link href="/market-analysis">全部市场 <ArrowUpRight size={15} /></Link></div>
          {data?.recentScans?.length ? <div className="lc-scan-grid">{data.recentScans.slice(0, 4).map(scan => <Link key={scan.scanId} href={"/market-analysis/" + scan.scanId}><Compass size={21} /><h3>{scan.scanName}</h3><p>{scan.sampleCount} 款样本{scan.medianPrice?.amount != null ? " · 中位价 " + scan.medianPrice.currency + " " + scan.medianPrice.amount.toFixed(2) : ""}{scan.cr5 != null ? " · CR5 " + (scan.cr5 * 100).toFixed(1) + "%" : ""}</p><ArrowUpRight size={16} /></Link>)}</div> :
            <p className="lc-empty-copy">{marketScans ? "已有 " + marketScans + " 个市场研究，暂无可展示的近期洞察。" : "还没有市场研究。来源批次准备好后，就可以开始看清一个市场。"}</p>}
        </section></details>
        <div className="lc-feishu-strip"><span className={"lc-status-dot " + (data?.feishu?.configured ? "is-ready" : "")} /><div><strong>飞书个人研究库</strong><span>{data?.feishu?.configured ? "已配置 · 同步结果以各次回执为准" : "尚未配置 · 可以随时继续本地研究"}</span></div>
          {data?.feishu?.baseOpenUrl && <a href={data.feishu.baseOpenUrl} target="_blank" rel="noreferrer">打开 Base <ExternalLink size={14} /></a>}
          <Button size="sm" onClick={() => setFeishuDrawerOpen(true)}>连接设置</Button><Link href="/team">进入飞书工作区 <ArrowUpRight size={15} /></Link></div>
      </>}
    </WorkspaceFrame>
    <Dialog isOpen={quickOpen} onClose={() => setQuickOpen(false)} title="快速补录 ASIN" description="补录单个商品事实，不等同于市场样本。" maxWidth="2xl" scrollable><QuickAsinIngress /></Dialog>
    <FeishuConnectionDrawer open={feishuDrawerOpen} onClose={() => setFeishuDrawerOpen(false)} />
  </>;
}


export function WorkflowProgress({ data }: { data: HomeSummaryPayload | null }) {
  const counts = projectWorkspaceCounts(data);
  const watch = formatDecisionWatchSummary({ watch: counts.choiceWatch, paused: data?.decision?.paused, validateMore: data?.decision?.validateMore });
  const metrics = [
    { label: "采集批次", value: counts.sourceBatches, detail: counts.sourceItems + " 款来源商品", href: "/source" },
    { label: "市场研究", value: counts.marketScans, detail: counts.marketSamples + " 款研究样本", href: "/market-analysis" },
    { label: "待我判断", value: counts.researchNeedsDecision, detail: counts.researchInProgress + " 项研究进行中", href: "/research?view=needs_decision" },
    { label: "已存判断", value: counts.choiceProceed + counts.choiceWatch + counts.choiceDrop, detail: counts.choiceProceed + " 推进 · " + watch + " · " + counts.choiceDrop + " 放弃", href: "/research" },
  ];
  return <section className="lc-metrics-strip" aria-label="核心业务推进管道">
    {metrics.map(item => <Link href={item.href} key={item.label} data-attention={item.label === "待我判断" && item.value > 0 ? "true" : undefined}><strong>{item.value}</strong><span>{item.label}</span><small>{item.detail}</small><ArrowUpRight size={16} /></Link>)}
  </section>;
}
