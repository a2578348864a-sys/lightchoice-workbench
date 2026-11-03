"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Search, Sparkles } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { buildV5NavGroups, useCurrentTaskId, withTaskContext } from "@/components/WorkspaceSidebar";
/**
 * 快速跳转的数据源。
 * label 与左侧主导航保持同一名称（04 在侧栏叫「需求单」），
 * keywords 只用于搜索别名：用户会按「产品开发需求单 / 开发需求」去找同一个页面。
 */
const FLOW_STEPS = [
  { href: "/source", label: "市场采集", en: "Market Capture", match: ["/source", "/sourcing", "/materials", "/viral"], keywords: ["采集", "商品采集", "批量采集"] },
  { href: "/market-analysis", label: "市场研究", en: "Market Research", match: ["/market-analysis", "/market-scan", "/market-opportunities"], keywords: ["市场", "市场分析", "大盘", "赛道"] },
  { href: "/research", label: "商品深研", en: "Product Deep Research", match: ["/research", "/tasks", "/opportunity-candidates"], keywords: ["深研", "商品研究", "研究详情", "决策"] },
  {
    href: "/product-brief",
    label: "产品开发需求单",
    en: "Product Brief",
    match: ["/product-brief"],
    keywords: ["需求单", "开发需求单", "开发需求", "需求", "开发需求书", "product brief"],
  },
] as const;
const DESTINATIONS = [
  { href: "/", label: "探索台", en: "Home", detail: "继续研究与待办", keywords: [] as readonly string[] },
  ...FLOW_STEPS.map(s => ({ ...s, detail: "产品开发主线" })),
  { href: "/team", label: "飞书个人看板", en: "Feishu Board", detail: "管理投影与连接状态", keywords: ["飞书"] as readonly string[] },
  { href: "/diagnostics", label: "系统诊断", en: "Diagnostics", detail: "检查运行环境", keywords: ["诊断"] as readonly string[] },
];
/**
 * V6：全站移除顶部 01→04 流程步骤条（由左侧主导航承担流程入口）。
 * 保留导出与签名以兼容既有引用，渲染为空。
 */
export function WorkspaceFlow() {
  return null;
}
export function WorkspaceChrome({ modeLabel, actions }: { modeLabel?: string; actions?: ReactNode }) {
  const pathname = usePathname() || "/";
  const current = DESTINATIONS.find(s => s.href !== "/" && (pathname === s.href || pathname.startsWith(s.href + "/")))
    ?? (pathname === "/" || pathname === "/home" ? DESTINATIONS.find(s => s.href === "/") : undefined);
  const taskId = useCurrentTaskId(pathname);
  // 辅助区已进入侧栏，更多菜单只保留创作工具，避免同一入口重复出现。
  const moreGroups = buildV5NavGroups({mode:"local_owner",v4Graph:false}).slice(3);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [calm, setCalm] = useState(false);
  useEffect(() => { try { setCalm(localStorage.getItem("lightchoice-calm-motion") === "true"); } catch { /* optional preference */ } }, []);
  useEffect(() => { document.documentElement.dataset.lcCalm = String(calm); }, [calm]);
  const normalizedQuery = query.trim().toLowerCase();
  const results = DESTINATIONS.filter(s => `${s.label} ${s.detail} ${s.keywords.join(" ")}`.toLowerCase().includes(normalizedQuery));
  return <>
    <header className="lc-topbar">
      <div className="lc-site-breadcrumb"><Link href="/">轻选工作台</Link><span className="lc-sep">/</span><strong>{current?.label ?? "探索台"}</strong>{current?.en ? <em className="lc-breadcrumb-en">{current.en}</em> : null}</div>
      <div className="lc-top-actions">{actions}
        {process.env.NEXT_PUBLIC_LC_UI_PREVIEW === "true" ? <span className="lc-preview-label" title="真实保存数据的隔离副本；本次修改不影响3010">隔离预览</span> : <span className="lc-mode-label" title={modeLabel}>本地工作台</span>}
        <div className="lc-more-menu" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setMoreOpen(false);}} onKeyDown={event=>{if(event.key==="Escape")setMoreOpen(false);}}>
          <button type="button" aria-expanded={moreOpen} aria-controls="workspace-more-links" onClick={()=>setMoreOpen(!moreOpen)}>更多 ▾</button>
          {moreOpen&&<nav id="workspace-more-links" className="lc-more-pop" aria-label="辅助与保留功能">{moreGroups.map((group,index)=><div key={group.label}>{index>0&&<div className="lc-sep"/>}{group.items.map(item=><Link key={item.href} href={withTaskContext(item.href,taskId)} onClick={()=>setMoreOpen(false)}>{item.label}</Link>)}</div>)}</nav>}
        </div>
        <Button className="lc-site-search" aria-label="搜索与快速跳转" title="搜索与快速跳转" onClick={() => { setQuery(""); setSearchOpen(true); }}><Search size={16} /></Button>
        <Button className="lc-motion-toggle" aria-label={calm ? "开启动效" : "减少动效"} aria-pressed={!calm} onClick={() => {
          setCalm(!calm); try { localStorage.setItem("lightchoice-calm-motion", String(!calm)); } catch { /* optional preference */ }
        }}><Sparkles size={17} /></Button>
      </div>
    </header>
    <Dialog isOpen={searchOpen} onClose={() => setSearchOpen(false)} title="快速到达" description="搜索页面名称，前往你的工作区。" maxWidth="lg" scrollable>
      <label className="lc-command-search"><Search size={17} /><input aria-label="搜索工作区" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索采集、研究、飞书…" /></label>
      <div className="lc-command-list">{results.map(s => <Link key={s.href} href={s.href} onClick={() => setSearchOpen(false)}><span><strong>{s.label}</strong><small>{s.detail}</small></span><ArrowUpRight size={16} /></Link>)}
        {!results.length && <p className="lc-empty-copy">没有匹配的页面，请换一个关键词。</p>}
      </div>
    </Dialog>
  </>;
}
export function WorkspacePageShell({ children, sidebar, modeLabel, actions, showFlow = true, footerNote }: {
  children: ReactNode; sidebar?: ReactNode; modeLabel?: string; actions?: ReactNode; showFlow?: boolean; footerNote?: string;
}) {
  const pathname = usePathname() || "/";
  const scoped = pathname === "/" || pathname === "/home" || pathname.startsWith("/market-analysis");
  return <div className={`lc-workspace${scoped ? " lc-site-v6" : ""}`}>{sidebar}<div className="lc-workspace-body"><WorkspaceChrome modeLabel={modeLabel} actions={actions} /><main className="lc-workspace-main">{children}</main>{footerNote && <footer className="lc-workspace-footer">{footerNote}</footer>}</div></div>;
}
