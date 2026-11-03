"use client";
import Link from "next/link";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Check, Database, ExternalLink, NotebookTabs, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AtelierHeading } from "@/components/ui/Atelier";
import { FeishuConnectionDrawer, type FeishuConnectionStatus } from "@/components/feishu/FeishuConnectionDrawer";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { HomeSummaryPayload } from "@/components/home/WorkbenchOverviewClient";
type HubStatus = FeishuConnectionStatus & { hubStatus?: string; schemaState?: string; tables?: Array<{ key: string; status: string }> };
const VIEWS = [
  { key: "products", name: "商品研究库", subtitle: "研究主体与阶段", table: "T01", href: "/research" },
  { key: "research", name: "研究档案", subtitle: "研究结论与证据", table: "T02", href: "/research" },
  { key: "voice", name: "买家声音", subtitle: "反馈主题与来源", table: "T03", href: "/research" },
  { key: "brief", name: "产品开发方案", subtitle: "需求与待确认项", table: "T05", href: "/product-brief" },
] as const;
export function FeishuWorkspaceClient({ tables }: { tables: Array<{ id: string; name: string }> }) {
  const [tab, setTab] = useState("overview");
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("products");
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([
      fetch("/api/feishu-hub/status", { cache: "no-store", headers: buildAccessHeaders() }).then(async r => { const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error?.message || "连接状态读取失败"); return j.data as HubStatus; }),
      fetch("/api/home/summary", { cache: "no-store", headers: buildAccessHeaders() }).then(async r => { const j = await r.json(); if (!r.ok || !j.ok) throw new Error("研究摘要读取失败"); return j.data as HomeSummaryPayload; }),
    ]);
    if (results[0].status === "fulfilled") setStatus(results[0].value); else { setStatus(null); setError(results[0].reason instanceof Error ? results[0].reason.message : "连接状态读取失败"); }
    if (results[1].status === "fulfilled") setSummary(results[1].value); else { setSummary(null); setError(old => [old, "研究摘要暂不可用"].filter(Boolean).join("；")); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const connectionLabel = loading ? "正在读取" : error && !status ? "状态未确认" : status?.status === "ready" ? "连接就绪" : status?.status === "degraded" ? "连接降级" : status?.status === "down" ? "连接异常" : "尚未配置";
  const current = VIEWS.find(item => item.key === view)!;
  const projection = summary?.feishu;
  const value = (n: number | undefined) => loading || n == null ? "—" : n;
  return <>
    <AtelierHeading eyebrow="飞书 · 我的研究积累" title="让研究，沉淀为自己的积累。" description="工作台里做判断，飞书里管理与复盘。每次同步，都保留来源与版本。"
      actions={<><Button onClick={() => setDrawer(true)}><Settings2 size={15} />连接设置</Button><Button aria-label="刷新飞书状态" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></Button></>} />
    {error && <div className="lc-inline-notice" role="alert">{error}<Button size="xs" onClick={() => void load()}>重新读取</Button></div>}
    <nav className="lc-section-nav" aria-label="飞书工作区视图">{[["overview","个人研究中心"],["views","飞书资料视图"],["sync","同步与连接"],["review","应用建议入口"]].map(([key,label]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div hidden={tab !== "overview"} className="lc-feishu-pane">
      <section className={activeStyles.connectionBanner} data-state={loading || !status ? "unknown" : status.status} aria-label="当前飞书连接">
        <div><p>当前连接</p><h2>{connectionLabel}</h2><p>连接状态与每次同步结果分别记录，商品研究和证据始终保留在轻选。</p></div>
        <div><Button onClick={() => setDrawer(true)}>检查连接设置</Button>{status?.baseOpenUrl && <a href={status.baseOpenUrl} target="_blank" rel="noreferrer">在飞书打开研究库 <ExternalLink size={15} /></a>}</div>
      </section>
      {status?.lastError && !(status.status === "not_configured" && status.lastError.code === "FEISHU_CREDENTIAL_MISSING") && <section className={activeStyles.historyNote} aria-label="最近错误信息"><h3>最近错误信息</h3><p>{status.lastError.message}</p><small>{status.lastError.code} · 与当前连接状态分列；完整记录见连接设置。</small></section>}
      <div className="lc-metrics-strip"><div><strong>{value(projection?.syncedMarketBatches)}</strong><span>已同步市场批次</span></div><div><strong>{value(projection?.syncedResearchRows)}</strong><span>已同步研究条目</span></div><div><strong>{status?.tables ? status.tables.filter(t => t.status === "available").length : "—"}</strong><span>当前可用资料表</span></div><div><strong className="lc-time-value">{projection?.lastSyncAt ? new Date(projection.lastSyncAt).toLocaleString("zh-CN") : "—"}</strong><span>最近同步时间{projection?.lastSyncAt ? "" : " · 未提供"}</span></div></div>
      <div className="lc-section-heading"><div><p className="lc-eyebrow">我的研究资料库</p><h2>研究资料，各有位置。</h2></div><button type="button" onClick={() => setTab("views")}>查看资料视图 →</button></div>
      <div className="lc-feishu-collections">{VIEWS.map((item,i) => <button type="button" key={item.key} onClick={() => { setView(item.key); setTab("views"); }}><span>0{i + 1}</span><NotebookTabs size={23} /><strong>{item.name}</strong><small>{item.subtitle}</small><ArrowUpRight size={16} /></button>)}</div>
      <details className={activeStyles.disclosure}><summary>研究库的同步与判断边界</summary><div>{["本地研究与证据保持权威", "同步结果以真实回执为准", "飞书建议经你确认后应用"].map(text => <p key={text} className="flex items-center gap-2 py-1"><Check size={15} />{text}</p>)}</div></details>
    </div>
    <div hidden={tab !== "views"} className="lc-feishu-pane">
      <div className="lc-view-layout"><aside className="lc-view-sidebar"><p className="lc-eyebrow">资料库</p>{VIEWS.map(item => <button type="button" key={item.key} aria-pressed={view === item.key} onClick={() => setView(item.key)}><NotebookTabs size={16} />{item.name}</button>)}</aside>
        <section className="lc-reading-section"><p className="lc-eyebrow">研究资料库 / {current.table}</p><h2>{current.name}</h2><p>这里说明对应的管理投影与访问入口。实际资料行、筛选和图表在飞书内查看。</p>
          <div className="lc-view-status"><Database size={30} /><h3>{status?.tables?.find(t => t.key === current.table)?.status === "available" ? "对应资料表可用" : "对应资料表尚未确认可用"}</h3><p>{current.subtitle}。工作台保存的事实与研究版本始终保留；外部同步失败不会改变本地记录。</p>
            <div>{status?.baseOpenUrl ? <a className="lc-hero-cta" href={status.baseOpenUrl} target="_blank" rel="noreferrer">打开飞书 Base<ExternalLink size={15} /></a> : <Button onClick={() => setDrawer(true)}>检查飞书连接</Button>}<Link href={current.href}>回到本地工作区 <ArrowUpRight size={14} /></Link></div></div>
          <p className="lc-footnote">当前页面展示连接与投影范围；实际资料内容以飞书 Base 为准。具体视图、筛选与图表可在飞书内配置。</p>
        </section></div>
    </div>
    <div hidden={tab !== "sync"} className="lc-feishu-pane"><section className="lc-reading-section"><div className="lc-section-heading"><div><p className="lc-eyebrow">连接与投影</p><h2>每一次同步，都能确认结果。</h2></div><span className="lc-soft-tag">{connectionLabel}</span></div><p>从市场研究或商品深研详情发起同步；本页只读取连接与资料表状态。</p>
      <details className={activeStyles.disclosure}><summary>逐表连接状态（{tables.length} 张资料表）</summary><div className="lc-hub-tables">{tables.map(table => <div key={table.id}><Database size={18} /><strong>{table.name}</strong><span>{status?.tables?.find(t => t.key === table.id)?.status === "available" ? "可用" : loading ? "读取中" : "待核实"}</span></div>)}</div></details>
      {status?.lastError && <div role="alert" className="lc-inline-notice">{status.lastError.message} · {status.lastError.code}</div>}
      <div className="lc-feishu-sync-actions"><Button onClick={() => setDrawer(true)}>连接检查与安全重试</Button><Link href="/market-analysis">市场同步入口 →</Link><Link href="/research">研究同步入口 →</Link></div>
      <details className="lc-environment-details"><summary>扩展能力与当前边界</summary><div>额外三张扩展表与五类 VOC 完整看板仍属于后续扩展。当前界面不创建表、不自动写入飞书，也不模拟成功回执。</div></details>
    </section></div>
    <div hidden={tab !== "review"} className="lc-feishu-pane"><section className="lc-reading-section lc-review-empty"><span className="lc-empty-glyph"><NotebookTabs size={25} /></span><h2>飞书里的建议，回到这里由你决定。</h2><p>请在商品深研列表点击“检查飞书最新决策”，在具体研究中核对版本并确认。本页尚不提供独立的建议待办列表。</p><Link className="lc-hero-cta" href="/research">进入商品深研 <ArrowUpRight size={15} /></Link><small>飞书备注不会自动覆盖本地人工决定。</small></section></div>
    <FeishuConnectionDrawer open={drawer} onClose={() => setDrawer(false)} />
  </>;
}
