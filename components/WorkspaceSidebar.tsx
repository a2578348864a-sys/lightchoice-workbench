"use client";

import Link from "next/link";
import { projectWorkspaceCounts } from "@/lib/client/workflowCounts";
import { usePathname } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { NavigationEffects } from "@/components/ui/NavigationEffects";
import {
  Info,
  Compass,
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useSharedProduct } from "@/hooks/useSharedProduct";
import { buildAccessHeaders, setNoAuthOwnerMode } from "@/lib/client/accessToken";
import { classifyResearchLifecycle } from "@/lib/researchLifecycle";
import type { DecisionStatus } from "@/lib/tasks/decisionStatus";
import type { RuntimeMode } from "@/lib/server/runtimeMode";
import { WORKFLOW_STAGE_META } from "@/lib/workflow/workflowResolver";
import { FeishuConnectionDrawer, type FeishuConnectionStatus } from "@/components/feishu/FeishuConnectionDrawer";

export type SidebarNavItem = {
  label: string;
  /** 英文辅助名：中文优先，英文仅作辅助识别。 */
  labelEn?: string;
  href: string;
  icon: LucideIcon;
  badge?: string | number | null;
  badgeTone?: "neutral" | "amber" | "emerald";
};

export type SidebarRuntime = { mode: RuntimeMode | null; v4Graph: boolean };

/**
 * V5 Product Workflow Recovery 导航：市场采集 → 市场研究 → 商品深研 → 产品开发需求单。
 * Listing / Image Studio 已从正式产品退役，不再占据导航。
 */
export function buildV5NavGroups(
  runtime: SidebarRuntime,
  counts?: {
    sourceBadge?: string | null;
    marketBadge?: string | null;
    researchBadge?: string | null;
    researchBadgeTone?: "neutral" | "amber" | "emerald";
  }
): ReadonlyArray<{
  label: string;
  items: ReadonlyArray<SidebarNavItem>;
}> {
  const developmentItems: SidebarNavItem[] = [
    {
      label: WORKFLOW_STAGE_META.MARKET_CAPTURE.label,
      labelEn: WORKFLOW_STAGE_META.MARKET_CAPTURE.labelEn,
      href: WORKFLOW_STAGE_META.MARKET_CAPTURE.href,
      icon: Inbox,
      badge: counts?.sourceBadge ?? null,
      badgeTone: "neutral",
    },
    {
      label: WORKFLOW_STAGE_META.MARKET_RESEARCH.label,
      labelEn: WORKFLOW_STAGE_META.MARKET_RESEARCH.labelEn,
      href: WORKFLOW_STAGE_META.MARKET_RESEARCH.href,
      icon: Compass,
      badge: counts?.marketBadge ?? null,
      badgeTone: "neutral",
    },
    {
      label: WORKFLOW_STAGE_META.PRODUCT_RESEARCH.label,
      labelEn: WORKFLOW_STAGE_META.PRODUCT_RESEARCH.labelEn,
      href: WORKFLOW_STAGE_META.PRODUCT_RESEARCH.href,
      icon: Sparkles,
      badge: counts?.researchBadge ?? null,
      badgeTone: counts?.researchBadgeTone ?? "neutral",
    },
    {
      label: WORKFLOW_STAGE_META.PRODUCT_BRIEF.label,
      labelEn: WORKFLOW_STAGE_META.PRODUCT_BRIEF.labelEn,
      href: WORKFLOW_STAGE_META.PRODUCT_BRIEF.href,
      icon: FileText,
    },
  ];

  return [
    { label: "工作台", items: [{ label: "工作台", href: "/", icon: LayoutDashboard }] },
    { label: "产品开发流程", items: developmentItems },
    // D1-B：飞书 / 诊断合并进「辅助区」；持续监控与 Listing/生图已退役，不再提供入口。
    {
      label: "辅助区",
      items: [
        { label: "飞书个人看板", href: "/team", icon: History },
        { label: "系统诊断", href: "/diagnostics", icon: Settings },
      ],
    },
  ];
}

/** 模式 Badge 文案（unknown 为空，避免 hydration 漂移） */
export function modeBadgeLabel(_runtime: SidebarRuntime): string {
  return "";
}

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/source") {
    return (
      pathname === "/source" ||
      pathname.startsWith("/source/") ||
      pathname === "/sourcing" ||
      pathname === "/materials" ||
      pathname === "/viral"
    );
  }
  if (href === "/market-analysis") {
    return (
      pathname === "/market-analysis" ||
      pathname.startsWith("/market-analysis/") ||
      pathname === "/market-scan" ||
      pathname.startsWith("/market-scan/") ||
      pathname === "/market-opportunities" ||
      pathname.startsWith("/market-opportunities/")
    );
  }
  if (href === "/research") {
    return (
      pathname === "/research" ||
      pathname.startsWith("/research/") ||
      pathname === "/tasks" ||
      pathname.startsWith("/tasks/") ||
      pathname === "/opportunity-candidates" ||
      pathname.startsWith("/opportunity-candidates/")
    );
  }
  if (href === "/product-brief") {
    return pathname.startsWith("/product-brief");
  }
  return pathname === href || pathname.startsWith(href + "/");
}

export function isTaskActiveResearchHighlight(
  pathname: string,
  search: string,
  hasActiveDetail: boolean | null
) {
  if (pathname === "/research" || pathname.startsWith("/research/")) return true;
  if (pathname.startsWith("/tasks/")) {
    if (hasActiveDetail === null) return search.includes("from=research");
    return hasActiveDetail;
  }
  return false;
}

/** 任务详情研究高亮（数据驱动，侧栏与移动导航共用；读取中返回 null 不抢高亮） */
function useTaskDetailResearchHighlight(pathname: string): boolean | null {
  const taskId = pathname.match(/^\/(?:tasks|research)\/([^/?#]+)/)?.[1] ?? null;
  const [state, setState] = useState<boolean | null>(null);
  useEffect(() => {
    if (!taskId) {
      setState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
          cache: "no-store",
          headers: { ...buildAccessHeaders() },
        });
        const json = (await response.json().catch(() => null)) as {
          ok?: boolean;
          data?: { decisionStatus?: string; type?: string; result?: unknown };
        } | null;
        if (cancelled) return;
        if (!response.ok || !json?.ok || !json.data) {
          setState(false);
          return;
        }
        const lifecycle = classifyResearchLifecycle({
          decisionStatus: (json.data.decisionStatus ?? "pending") as DecisionStatus,
          result: (json.data.result ?? null) as Record<string, unknown> | null,
          type: json.data.type ?? "workflow",
        });
        setState(lifecycle.lifecycle === "active");
      } catch {
        if (!cancelled) setState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  return state;
}

function currentProductLabel(productName: string) {
  try {
    const url = new URL(productName);
    if (url.protocol === "http:" || url.protocol === "https:") return "已选择商品链接";
  } catch {
    // Ordinary product titles are not URLs
  }
  return productName;
}

export function withTaskContext(href: string, taskId: string | null): string {
  if (!taskId || !["/product-brief"].includes(href)) return href;
  return `${href}?taskId=${encodeURIComponent(taskId)}`;
}

export function useCurrentTaskId(pathname: string): string | null {
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => {
    const fromPath = pathname.match(/^\/(?:tasks|research)\/([^/?#]+)/)?.[1] ?? null;
    const fromQuery =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("taskId")
        : null;
    setTaskId(fromPath ?? fromQuery);
  }, [pathname]);
  return taskId;
}

function NavLink({
  item,
  pathname,
  isAuxiliary = false,
  taskId = null,
}: {
  item: SidebarNavItem;
  pathname: string;
  isAuxiliary?: boolean;
  taskId?: string | null;
}) {
  const Icon = item.icon;
  const active = isActivePath(pathname, item.href);

  const displayLabel = item.href === "/"
    ? "探索台"
    : item.href === "/product-brief"
      ? "需求单"
      : item.label.replace(/^\s*\d{2}\s*/u, "");
  return (
    <Link
      href={withTaskContext(item.href, taskId)}
      aria-current={active ? "page" : undefined}
      aria-label={displayLabel}
      data-tip={displayLabel}
      className={`lc-site-nav-link${isAuxiliary ? " is-auxiliary" : ""}`}
    >
      <span className="lc-nav-chip" aria-hidden="true"><Icon size={19} /></span>
      <span className="lc-nav-copy">{displayLabel}</span>

      {item.badge !== undefined && item.badge !== null ? (
        <span
          className={`lc-site-nav-count${item.badgeTone === "amber" ? " is-amber" : ""}`}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

export function WorkspaceSidebar() {
  const railRef = useRef<HTMLElement>(null);
  const pathname = usePathname() || "/";
  const currentTaskId = useCurrentTaskId(pathname);
  const [sharedProduct] = useSharedProduct();
  const [runtime, setRuntime] = useState<SidebarRuntime>({ mode: null, v4Graph: false });

  // Feishu Drawer & connection status
  const [feishuDrawerOpen, setFeishuDrawerOpen] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<FeishuConnectionStatus | null>(null);
  // 与探索台共用同一个折叠记忆键，保证跨页面切换后侧栏状态一致。
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("lc-rail-collapsed") === "1") setCollapsed(true);
    } catch {
      /* localStorage 不可用时保持展开 */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem("lc-rail-collapsed", next ? "1" : "0");
      } catch {
        /* 忽略持久化失败 */
      }
      return next;
    });
  };

  // Summary counts for badges
  const [counts, setCounts] = useState<{
    sourceBadge?: string | null;
    marketBadge?: string | null;
    researchBadge?: string | null;
    researchBadgeTone?: "neutral" | "amber" | "emerald";
  }>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runtime-mode", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok) return;
        const mode = json.mode === "local_owner" ? "local_owner" as const : null;
        setRuntime({ mode, v4Graph: json.v4GraphEnabled === true });
        if (mode === "local_owner" && json.noAuthOwner === true) {
          setNoAuthOwnerMode();
        }
      })
      .catch(() => undefined);

    // Initial Feishu status fetch
    fetch("/api/feishu-hub/status", {
      cache: "no-store",
      headers: buildAccessHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok || !json.data) return;
        setFeishuStatus(json.data);
      })
      .catch(() => undefined);

    // Fetch summary counts for badges
    fetch("/api/home/summary", {
      cache: "no-store",
      headers: buildAccessHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok || !json.data) return;
        const data = json.data;
        const projected = projectWorkspaceCounts(data);
        const sourceNeedsClean = 0;
        const sourceValid = projected.sourceItems;
        const marketScans = projected.marketScans;
        const researchNeedsChoice = projected.researchNeedsDecision;
        setCounts({
          sourceBadge:
            sourceNeedsClean > 0
              ? `${sourceNeedsClean}待洗/${sourceValid}`
              : sourceValid > 0
              ? `${sourceValid}`
              : null,
          marketBadge: marketScans > 0 ? `${marketScans}` : null,
          researchBadge: researchNeedsChoice > 0 ? `${researchNeedsChoice}` : null,
          researchBadgeTone: researchNeedsChoice > 0 ? "amber" : "neutral",
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const productLabel = currentProductLabel(sharedProduct.productName);
  const productMeta = sharedProduct.category ? "品类：" + sharedProduct.category : "商品资料已载入";
  const badge = modeBadgeLabel(runtime);
  const groups = buildV5NavGroups(runtime, counts);
  const primaryItems = groups[0]?.items ?? [];
  const pipelineItems = groups[1]?.items ?? [];
  const auxiliaryItems = groups[2]?.items ?? [];

  const feishuConnected = feishuStatus?.status === "ready";
  const feishuDegraded = feishuStatus?.status === "degraded";
  const feishuDown = feishuStatus?.status === "down";

  return <>
    <aside ref={railRef} className="lc-rail lc-site-sidebar lc-modern-navigation" id="lc-site-rail" data-collapsed={collapsed ? "true" : "false"} aria-label="应用导航">
      <Link className="lc-site-logo" href="/" aria-label="轻选工作台，返回探索台">
        <span className="lc-site-mark" aria-hidden="true">
          <img src="/brand/mint-compass.jpg" alt="" width={104} height={104} />
        </span>
        <span className="lc-site-logo-text"><strong>轻选工作台</strong><span>跨境商品研策台</span></span>
      </Link>
      <nav className="lc-site-navigation" aria-label="工作台导航">
        <section className="lc-site-nav-group">
          <p className="lc-nav-label"><span>主流程</span></p>
          {[...primaryItems, ...pipelineItems].map(item => <NavLink key={item.href} item={item} pathname={pathname} taskId={currentTaskId} />)}
        </section>
        {auxiliaryItems.length ? <section className="lc-site-nav-group">
          <p className="lc-nav-label"><span>辅助</span></p>
          {auxiliaryItems.map(item => <NavLink key={item.href} item={item} pathname={pathname} taskId={currentTaskId} />)}
        </section> : null}
      </nav>
      <div className="lc-site-sidebar-footer">
        {process.env.NEXT_PUBLIC_LC_UI_PREVIEW === "true" && <>
          <span className="lc-preview-label" data-tip="3450 · 隔离预览：不连接 3010 正式写入，不调用付费 AI / 真实采集">
            <span className="lc-preview-full">3450 · 隔离预览</span>
            <span className="lc-preview-mini"><b>3450</b><i>隔离</i></span>
          </span>
          <p>不连接 3010 正式写入<br/>不调用付费 AI / 真实采集</p>
        </>}
        {sharedProduct.productName && <div className="lc-site-context" title={"当前评估商品：" + productLabel + " · " + productMeta}><Package size={17} /><span><small>创作工具当前商品</small><b>{productLabel}</b></span></div>}
        <button className="lc-site-connection" type="button" onClick={() => setFeishuDrawerOpen(true)}
          aria-label="飞书连接设置" data-tip="飞书连接设置" title={"飞书：" + (feishuConnected ? "已连接" : feishuDegraded ? "连接降级" : feishuDown ? "异常" : "未配置") + (badge ? " · " + badge : "")}>
          <Info size={18} /><span>飞书连接</span><small>{feishuConnected ? "已连接" : feishuDegraded ? "降级" : feishuDown ? "异常" : "未配置"}</small>
        </button>
        <button type="button" className="lc-site-rail-toggle" onClick={toggleCollapsed}
          aria-label={collapsed ? "展开导航栏" : "收起导航栏"} aria-expanded={!collapsed} aria-controls="lc-site-rail"
          data-tip={collapsed ? "展开导航栏" : "收起导航栏"}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          <span className="lc-site-rail-toggle-label">收起导航</span>
        </button>
      </div>
      <NavigationEffects railRef={railRef} collapsed={collapsed} activeKey={pathname} />
    </aside>
    <FeishuConnectionDrawer open={feishuDrawerOpen} onClose={() => setFeishuDrawerOpen(false)} onStatusChange={setFeishuStatus} />
  </>;

}

export function WorkspaceMobileNav() {
  const pathname = usePathname() || "/";
  const [runtime, setRuntime] = useState<SidebarRuntime>({ mode: null, v4Graph: false });
  const [feishuDrawerOpen, setFeishuDrawerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runtime-mode", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok) return;
        const mode = json.mode === "local_owner" ? "local_owner" as const : null;
        setRuntime({ mode, v4Graph: json.v4GraphEnabled === true });
        if (mode === "local_owner" && json.noAuthOwner === true) {
          setNoAuthOwnerMode();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const items = buildV5NavGroups(runtime).flatMap((group) => group.items);
  const currentTaskId = useCurrentTaskId(pathname);

  return (
    <>
      <nav
        className="no-scrollbar mt-4 flex items-center gap-2 overflow-x-auto pb-1 lg:hidden"
        aria-label="工作台移动导航"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={withTaskContext(item.href, currentTaskId)}
              aria-current={active ? "page" : undefined}
              className={
                "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition " +
                (active
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 shadow-xs"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
              }
            >
              <Icon className="size-3.5" />
              <span>{item.label}</span>
            </Link>
          );
        })}

        <button
          type="button"
          onClick={() => setFeishuDrawerOpen(true)}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
        >
          <Settings className="size-3.5" />
          <span>飞书设置</span>
        </button>
      </nav>

      <FeishuConnectionDrawer
        open={feishuDrawerOpen}
        onClose={() => setFeishuDrawerOpen(false)}
      />
    </>
  );
}
