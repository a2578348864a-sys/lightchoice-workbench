"use client";
import { Fragment, useEffect, useState, useRef } from "react";
import { NavigationEffects } from "@/components/ui/NavigationEffects";
import Link from "next/link";
import { ResearchExplorer as ExplorerPage, ResearchCompare as ComparePage, ResearchGate as GatePage, ResearchVoice as VocPage } from "./ResearchLayouts";
import {
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Compass,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Drawer, ProductImage } from "./components";
import { useHifi } from "./HifiProvider";
import { clearCompetitionBandHandoff, peekCompetitionBandHandoff } from "./cockpit/competitionHandoff";
import {
  ROLE_LABEL,
  asinFlow,
  asinTrends,
  keywordEvidence,
  keywords,
  moreEntries,
  opportunityDetail,
  priceBands as demoPriceBands,
  samples as demoSamples,
  scan as demoScan,
  voc,
  type Sample,
  type Screen,
} from "./data";
import "./hifi-v6.css";

/* ───────── Chart helpers ───────── */
function ChartTip(props: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown>; value?: number | string }>;
  label?: string;
  unit?: string;
}) {
  const { active, payload, label, unit } = props;
  if (!active || !payload?.length) return null;
  const p = (payload[0].payload ?? {}) as Record<string, unknown>;
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: "10px 12px",
        boxShadow: "0 8px 20px var(--shadow)",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{String(p.date ?? p.name ?? label ?? "")}</div>
      {p.price != null && (
        <div>
          价格：<strong>${Number(p.price).toFixed(2)}</strong>
          {unit || " USD / 包"}
        </div>
      )}
      {p.rating != null && (
        <div>
          评分：<strong>{Number(p.rating).toFixed(2)}</strong> ★
        </div>
      )}
      {p.count != null && <div>数量：{String(p.count)}</div>}
      {Boolean(p.asin) && (
        <div className="faint" style={{ marginTop: 4 }}>
          ASIN {String(p.asin)}
        </div>
      )}
      <div className="faint" style={{ marginTop: 4 }}>
        来源：演示序列（非全市场）
      </div>
    </div>
  );
}

function TrendChart({ asin, metric }: { asin: string; metric: "price" | "rating" }) {
  const series = asinTrends[asin] ?? [];
  if (!series.length) {
    return (
      <div
        style={{
          height: 180,
          display: "grid",
          placeItems: "center",
          border: "1px dashed var(--line)",
          borderRadius: 14,
          color: "var(--muted)",
          fontSize: 13,
        }}
      >
        暂无该商品的历史记录 · 不伪造趋势
      </div>
    );
  }
  const data = series.map((s) => ({ ...s, name: s.date }));
  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#087f68" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#087f68" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e8f0eb" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#8a9e94" }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: "#8a9e94" }}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={metric === "rating" ? [4.4, 5] : ["auto", "auto"]}
            tickFormatter={(v: number) => (metric === "rating" ? v.toFixed(1) : `$${v}`)}
          />
          <Tooltip content={<ChartTip unit={metric === "price" ? " USD / 包" : undefined} />} />
          <Area
            type="monotone"
            dataKey={metric}
            stroke="#087f68"
            strokeWidth={2.4}
            fill="url(#tg)"
            dot={{ r: 4, fill: "#fff", stroke: "#087f68", strokeWidth: 2 }}
            activeDot={{ r: 5, stroke: "#087f68", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="legend">
        <span>
          <i style={{ background: "#087f68" }} />
          {metric === "price" ? "包价（USD）" : "评分（★）"}
        </span>
        <span>ASIN {asin} · 演示序列 · 非全市场</span>
      </div>
    </div>
  );
}

function PriceBandChart({
  activeBand,
  onBand,
}: {
  activeBand: string | null;
  onBand: (b: string | null) => void;
}) {
  const live = useHifi();
  const data = live.priceBands.map((b) => ({ name: b.label, count: b.count, label: b.label }));
  const colors = ["#087f68", "#0e7490", "#6d5bd0", "#c27803"];
  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 8 }} onClick={(e) => {
          const label = (e as { activePayload?: { payload?: { label?: string } }[] })?.activePayload?.[0]?.payload?.label;
          if (label) onBand(activeBand === label ? null : label);
        }}>
          <CartesianGrid stroke="#e4ebe7" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 14, fill: "#61736d" }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 14, fill: "#61736d" }} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "rgba(8,127,104,0.06)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              return (
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid #dde8e2",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 14,
                    boxShadow: "0 8px 20px rgba(23,69,47,0.08)",
                  }}
                >
                  <strong>{String(payload[0].payload.label)}</strong>
                  <div>{payload[0].value} 件样本</div>
                  <div style={{ color: "#61736d", fontSize: 12 }}>点击可筛选对应商品</div>
                </div>
              );
            }}
          />
          <Bar dataKey="count" radius={[8, 8, 0, 0]} maxBarSize={56}>
            {data.map((entry, index) => (
              <Cell key={entry.label} fill={colors[index % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────── Product helpers ───────── */
function roleTag(s: Sample) {
  return (
    <span
      className={`role tag ${s.role === "benchmark" ? "tag-green" : s.role === "pain_point" ? "tag-amber" : "tag-blue"}`}
    >
      {ROLE_LABEL[s.role]}
    </span>
  );
}

function inBand(s: Sample, band: string | null) {
  if (!band) return true;
  const [a, b] = band.replace("$", "").split("–").map((x) => parseFloat(x));
  return s.price >= a && s.price <= b + 0.01;
}

/* ───────── AI Insight ───────── */
function AiInsight({
  headline,
  evidence,
  next,
  version,
  stale,
  onRegen,
  expanded,
  onToggle,
}: {
  headline: string;
  evidence?: string[];
  next?: string;
  version: string;
  stale: boolean;
  onRegen: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="notice notice-ai mb12">
      <div className="ico">✦</div>
      <div style={{ flex: 1 }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="tag tag-ai tag-dot">AI 洞察</span>
              <span className="tag">{version}</span>
              {stale && <span className="tag tag-amber tag-dot">可能过期</span>}
            </div>
            <strong style={{ fontSize: 14, display: "block", marginBottom: 4 }}>{headline}</strong>
            {!expanded && evidence?.[0] && <p style={{ fontSize: 12.5, opacity: 0.9 }}>{evidence[0]}</p>}
          </div>
          <div className="row">
            <button className="btn btn-sm btn-ghost" onClick={onRegen} type="button">
              重新生成
            </button>
            <button className="btn btn-sm" onClick={onToggle} type="button">
              {expanded ? "收起" : "展开完整"}
            </button>
          </div>
        </div>
        {expanded && (
          <div className="mt12">
            {evidence?.map((e) => (
              <p key={e} style={{ fontSize: 12.5, marginBottom: 6 }}>
                · {e}
              </p>
            ))}
            {next && (
              <p style={{ fontSize: 12.5, fontWeight: 650, marginTop: 8 }}>下一步：{next}</p>
            )}
            <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>
              演示状态 · 不调用付费 AI · 引用对应 Evidence（正式环境）
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({
  s,
  checked,
  onCheck,
  onOpen,
  compact,
}: {
  s: Sample;
  checked?: boolean;
  onCheck?: (asin: string, v: boolean) => void;
  onOpen?: (s: Sample) => void;
  compact?: boolean;
}) {
  return (
    <article className="p-card">
      <button
        type="button"
        className="visual"
        style={{ border: "none", cursor: onOpen ? "pointer" : "default" }}
        onClick={() => onOpen?.(s)}
        aria-label={`打开 ${s.name} 研究卡`}
      >
        <ProductImage asin={s.asin} imageUrl={s.imageUrl} name={s.name} size={compact ? "md" : "lg"} />
        {roleTag(s)}
      </button>
      <div className="body">
        {onCheck && (
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={checked} onChange={(e) => onCheck(s.asin, e.target.checked)} />
            <span style={{ fontSize: 12 }}>纳入人工选择</span>
          </label>
        )}
        <h4>{s.name}</h4>
        <div className="asin">
          {s.asin}
          {s.brand ? ` · ${s.brand}` : ""}
        </div>
        <div className="metrics">
          <div>
            <strong>{s.price != null ? `$${s.price != null ? s.price.toFixed(2) : "未知"}` : "—"}</strong>
            <span>包价</span>
          </div>
          <div>
            <strong>{s.rating ?? "—"}</strong>
            <span>评分</span>
          </div>
          <div>
            <strong>{s.thickness ? s.thickness.split(" ")[0] : "未知"}</strong>
            <span>厚度</span>
          </div>
          <div>
            <strong>{s.pack || "—"}</strong>
            <span>包装件数</span>
          </div>
        </div>
        {s.unitPriceNote && <p className="note">{s.unitPriceNote}</p>}
        <p className="note">
          {s.pos} · {s.neg}
        </p>
      </div>
    </article>
  );
}

/* ───────── Modal ───────── */
function Modal({
  open,
  title,
  desc,
  children,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  desc?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h3>{title}</h3>
        {desc && <p className="desc">{desc}</p>}
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

function FlowStrip({ screen, onNav }: { screen: Screen; onNav: (s: Screen) => void }) {
  const active = screen === "explorer" ? "source" : "market";
  const steps = [
    { id: "source", n: "01", t: "市场采集", s: "explorer" as Screen },
    { id: "market", n: "02", t: "市场研究", s: "overview" as Screen },
    { id: "deep", n: "03", t: "商品深研", s: null },
    { id: "brief", n: "04", t: "需求单", s: null },
  ];
  return (
    <nav className="flow" aria-label="主流程">
      {steps.map((s) => (
        <button key={s.id} type="button" className={active === s.id ? "active" : ""} onClick={() => s.s && onNav(s.s)}>
          <span className="n">{s.n}</span>
          {s.t}
        </button>
      ))}
    </nav>
  );
}

function MarketSubnav({ screen, onNav }: { screen: Screen; onNav: (s: Screen) => void }) {
  const items: { id: Screen; label: string }[] = [
    { id: "overview", label: "研究总览" },
    { id: "competition", label: "市场竞争" },
    { id: "keywords", label: "关键词与需求" },
    { id: "voc", label: "买家声音" },
    { id: "compare", label: "商品对比" },
    { id: "gate", label: "市场闸门" },
  ];
  return (
    <nav className="subnav" aria-label="02 市场研究工作区">
      {items.map((it) => (
        <button key={it.id} type="button" className={screen === it.id ? "active" : ""} onClick={() => onNav(it.id)}>
          {it.label}
        </button>
      ))}
    </nav>
  );
}

function PageHead({
  kicker,
  title,
  sub,
  actions,
}: {
  kicker: string;
  title: string;
  sub: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="kicker">{kicker}</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

/* ═══════════ Overview ═══════════ */
function OverviewPage({
  onNav,
  onToast,
  onOpenSample,
}: {
  onNav: (s: Screen) => void;
  onToast: (m: string) => void;
  onOpenSample: (s: Sample) => void;
}) {
  const live = useHifi();
  const scan = live.scan;
  const samples = live.samples;
  const [aiOpen, setAiOpen] = useState(false);
  return (
    <>
      <MarketSubnav screen="overview" onNav={onNav} />
      <PageHead
        kicker="02 · 研究总览"
        title={scan.category.replace("厨房 · ", "")}
        sub={`${scan.site} · ${scan.sampleCount} 件锁定样本 · 先看结论与机会。`}
        actions={
          <>
            <button className="btn" type="button" onClick={() => onToast("演示：报告 v0.3 已排队")}>
              重新生成报告
            </button>
            <button className="btn btn-primary" type="button" onClick={() => onNav("gate")}>
              打开市场闸门
            </button>
          </>
        }
      />
      {scan.reportStale && (
        <div className="notice notice-warn mb12">
          <div className="ico">⚠</div>
          <div>
            <strong>AI 报告 {scan.reportVersion} 可能过期</strong> · {scan.reportStaleReason}。重新生成不会改写人工判断。
          </div>
        </div>
      )}
      <div className="stat-grid">
        <article className="stat-card accent-brand">
          <div className="label">结论状态</div>
          <div className="value text">值得有界深研</div>
          <div className="hint">不直接进入开发</div>
          <div className="foot">
            <span>AI 建议 + 事实</span>
            <span className="tag tag-ai">AI</span>
          </div>
        </article>
        <article className="stat-card accent-info">
          <div className="label">价格带</div>
          <div className="value">$4.99–15</div>
          <div className="hint">包价 · 非单张价</div>
          <div className="foot">
            <span>{scan.sampleCount} 件</span>
            <span>→</span>
          </div>
        </article>
        <article className="stat-card accent-warn">
          <div className="label">明确负面</div>
          <div className="value">1</div>
          <div className="hint">提及 3 · 未达门槛</div>
          <div className="foot">
            <button className="btn btn-sm" type="button" onClick={() => onNav("voc")}>
              看 VOC
            </button>
          </div>
        </article>
        <article className="stat-card accent-risk clickable" style={{ cursor: "pointer" }} onClick={() => onNav("competition")}>
          <div className="label">证据冲突</div>
          <div className="value text">评论数冲突</div>
          <div className="hint">快照 3 / 详情 3354</div>
          <div className="foot">
            <span>点击查看</span>
            <span>→</span>
          </div>
        </article>
      </div>
      <div className="g-main mb16">
        <section className="card card-pad-lg">
          <div className="card-title">
            <h3>研究简报</h3>
            <span className="sub">
              {scan.reportVersion} · {scan.reportAt}
            </span>
          </div>
          <AiInsight
            headline={scan.conclusions[2].text}
            evidence={scan.conclusions.filter((c) => c.tone === "fact").map((c) => c.text)}
            next="确认研究范围 → 市场闸门 → 选择代表商品"
            version={scan.reportVersion}
            stale={scan.reportStale}
            onRegen={() => onToast("演示：不调用付费 AI")}
            expanded={aiOpen}
            onToggle={() => setAiOpen(!aiOpen)}
          />
          <div className="card-title">
            <h3 style={{ fontSize: 13 }}>已验证事实</h3>
          </div>
          <div className="stack-sm mb12">
            {scan.conclusions
              .filter((c) => c.tone === "fact")
              .map((c) => (
                <div key={c.text} className="notice">
                  <div className="ico">§</div>
                  <div>{c.text}</div>
                </div>
              ))}
          </div>
          <div className="card-title">
            <h3 style={{ fontSize: 13 }}>待验证机会</h3>
          </div>
          <div className="opp-grid">
            {scan.opportunities.map((o) => (
              <article key={o.title} className="opp-card" style={{ cursor: "default" }}>
                <div className="band" />
                <div className="body">
                  <span className="tag tag-amber">{o.score}</span>
                  <h3>{o.title}</h3>
                  <p>{o.desc}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <aside className="stack">
          <section className="card card-pad">
            <div className="card-title">
              <h3>风险与覆盖不足</h3>
            </div>
            <div className="readiness">
              {scan.risks.map((r) => (
                <div key={r.text} className={`ready-item ${r.level === "高" ? "bad" : ""}`}>
                  <span className="ready-icon">{r.level === "高" ? "!" : "·"}</span>
                  <div>
                    <strong>{r.level}风险</strong>
                    <div className="sub">{r.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="card card-pad">
            <div className="card-title">
              <h3>下一步</h3>
            </div>
            <ol style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 0, listStyle: "none" }}>
              {scan.nextSteps.map((n, i) => (
                <li key={n} style={{ display: "flex", gap: 10, fontSize: 13, alignItems: "flex-start" }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 8,
                      background: "var(--panel)",
                      color: "var(--action-ink)",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </span>
                  {n}
                </li>
              ))}
            </ol>
            <button className="btn btn-primary mt12" style={{ width: "100%" }} type="button" onClick={() => onNav("gate")}>
              去市场闸门
            </button>
          </section>
        </aside>
      </div>
      <section className="card card-pad">
        <div className="card-title">
          <h3>推荐商品</h3>
          <span className="sub">AI 提议 · 非最终选择 · 点击打开研究卡</span>
        </div>
        <div className="opp-grid">
          {samples.slice(0, 3).map((s) => (
            <ProductCard key={s.asin} s={s} onOpen={onOpenSample} />
          ))}
        </div>
      </section>
    </>
  );
}

/* ═══════════ Competition ═══════════ */
function CompetitionPage({
  onNav,
  onToast,
  onOpenSample,
}: {
  onNav: (s: Screen) => void;
  onToast: (m: string) => void;
  onOpenSample: (s: Sample) => void;
}) {
  const live = useHifi();
  const samples = live.samples;
  const [metric, setMetric] = useState<"price" | "rating">("price");
  const [trendAsin, setTrendAsin] = useState("B0CWPNBC4Z");
  // 探索台价格带交接：只在挂载时读取一次，进入 02 后作为初始筛选；离开本页即清空。
  const [handoff] = useState(() => peekCompetitionBandHandoff());
  const [band, setBand] = useState<string | null>(handoff?.label ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 5;
  const filtered = samples.filter((s) => inBand(s, band));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => () => clearCompetitionBandHandoff(), []);

  return (
    <>
      <MarketSubnav screen="competition" onNav={onNav} />
      <PageHead
        kicker="02 · 市场竞争"
        title="正式样本与价格结构"
        sub="商品主图 + 包价分布 + 单品趋势（按 ASIN，非全市场）。"
        actions={
          <>
            <button className="btn" type="button" onClick={() => onToast("演示：SellerSprite 补证")}>
              补证
            </button>
            <button className="btn btn-primary" type="button" onClick={() => onNav("compare")}>
              商品对比
            </button>
          </>
        }
      />
      {handoff ? (
        <div className="notice notice-info mb12" role="status">
          <span>已从探索台带入价格带筛选：{handoff.label}（{handoff.count} 件样本）。筛选只作用于本页展示，不写回样本或人工决定。</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBand(null)}>清除筛选</button>
        </div>
      ) : null}
      <div className="g2 mb16">
        <section className="card card-pad-lg">
          <div className="card-title">
            <h3>价格分布 · 包价</h3>
            <span className="sub">点击柱状图筛选商品 · 含 pack 差异</span>
          </div>
          <PriceBandChart activeBand={band} onBand={(b) => { setBand(b); setPage(1); }} />
          <div className="mt12">
            {live.priceBands.map((b) => (
              <button
                key={b.label}
                type="button"
                className={`price-chip ${band === b.label ? "active" : ""}`}
                onClick={() => setBand(band === b.label ? null : b.label)}
              >
                {b.label} · {b.count}
              </button>
            ))}
            {band && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBand(null)}>
                清除筛选
              </button>
            )}
          </div>
          <p className="muted mt12" style={{ fontSize: 12 }}>
            包价 ≠ 单张价；Snap Lock 不进本统计。单位价仅作粗算备注。
          </p>
        </section>
        <section className="card card-pad-lg">
          <div className="card-title">
            <h3>单品历史趋势</h3>
            <span className="sub">按 ASIN 隔离 · 演示序列</span>
          </div>
          <div className="row mb12">
            <select
              className="btn btn-sm"
              style={{ paddingRight: 8 }}
              value={trendAsin}
              onChange={(e) => setTrendAsin(e.target.value)}
              aria-label="选择趋势 ASIN"
            >
              {samples.map((s) => (
                <option key={s.asin} value={s.asin}>
                  {s.asin} · {s.name.split(" ")[0]}
                </option>
              ))}
            </select>
            <div className="segmented">
              <button type="button" className={metric === "price" ? "active" : ""} onClick={() => setMetric("price")}>
                价格
              </button>
              <button type="button" className={metric === "rating" ? "active" : ""} onClick={() => setMetric("rating")}>
                评分
              </button>
            </div>
          </div>
          <TrendChart asin={trendAsin} metric={metric} />
        </section>
      </div>
      <section className="mb16">
        <div className="card-title">
          <h3>商品实物卡</h3>
          <span className="sub">
            {filtered.length} 件{band ? ` · 已筛选 ${band}` : ""} · 点击打开研究卡
          </span>
        </div>
        <div className="opp-grid mb16">
          {filtered.slice(0, 3).map((s) => (
            <ProductCard key={s.asin} s={s} onOpen={onOpenSample} />
          ))}
        </div>
        <div className="table-wrap">
          <div className="table-toolbar">
            <div className="row">
              <span className="tag" style={{ background: "var(--panel)", color: "var(--action-ink)" }}>
                {filtered.length} 件
              </span>
              <span className="tag">可比 {filtered.filter((s) => s.comparable).length}</span>
              <span className="tag tag-rose">冲突 {filtered.filter((s) => s.conflict).length}</span>
            </div>
            <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                第 {page} / {pages} 页
              </span>
              <button className="btn btn-sm" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <button className="btn btn-sm" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </div>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>商品</th>
                <th>角色</th>
                <th>价格</th>
                <th>评分/评论</th>
                <th>包装件数</th>
                <th>买家声音</th>
                <th>可比</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((s) => {
                const isOpen = open === s.asin;
                return (
                  <Fragment key={s.asin}>
                    <tr className={isOpen ? "is-open" : ""} onClick={() => setOpen(isOpen ? null : s.asin)}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div className="p-img thumb" style={{ flexShrink: 0 }}>
                            <ProductImage asin={s.asin} imageUrl={s.imageUrl} name={s.name} size="sm" />
                          </div>
                          <div>
                            <strong>{s.name}</strong>
                            <div className="faint" style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                              {s.asin}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            s.role === "benchmark" ? "tag-green" : s.role === "pain_point" ? "tag-amber" : "tag-blue"
                          }`}
                        >
                          {ROLE_LABEL[s.role]}
                        </span>
                      </td>
                      <td>
                        <strong className="num">${s.price != null ? s.price.toFixed(2) : "未知"}</strong>
                      </td>
                      <td className="num">
                        {s.rating} <span className="faint">/ {s.reviews}</span>
                        {s.conflict && <span className="conflict">评价数冲突</span>}
                      </td>
                      <td className="num">{s.pack}</td>
                      <td className="num">{s.voc || <span className="faint">0</span>}</td>
                      <td>
                        {s.comparable ? <span className="tag tag-green">可比</span> : <span className="tag tag-rose">不进统计</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, background: "#f7faf8" }}>
                          <div className="detail-panel">
                            <div className="row between mb12">
                              <strong style={{ fontSize: 13 }}>{s.name}</strong>
                              <div className="row">
                                <button className="btn btn-sm" type="button" onClick={() => onOpenSample(s)}>
                                  打开完整研究卡
                                </button>
                                <button className="btn btn-sm" type="button" onClick={() => setOpen(null)}>
                                  收起
                                </button>
                              </div>
                            </div>
                            <dl className="detail-grid">
                              <dt>尺寸</dt>
                              <dd>{s.size}</dd>
                              <dt>厚度</dt>
                              <dd>{s.thickness}</dd>
                              <dt>单位价备注</dt>
                              <dd>{s.unitPriceNote ?? "—"}</dd>
                              <dt>评论</dt>
                              <dd className="num">
                                {s.reviews}
                                {s.reviewsAlt ? `（详情 ${s.reviewsAlt}）` : ""}
                              </dd>
                            </dl>
                            <p className="muted mt12" style={{ fontSize: 12 }}>
                              {s.note}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ═══════════ Keywords ═══════════ */
function KeywordsPage({
  onNav,
  onToast,
}: {
  onNav: (s: Screen) => void;
  onToast: (m: string) => void;
}) {
  const live = useHifi();
  const keywords = live.keywords;
  const keywordEvidence = live.keywordEvidence;
  const asinFlow = live.asinFlow;
  const [filter, setFilter] = useState<"all" | "ok" | "gap">("all");
  const [sort, setSort] = useState<"kw" | "vol">("kw");
  const [detail, setDetail] = useState<(typeof keywords)[number] | null>(null);
  const rows = keywords
    .filter((k) => (filter === "gap" ? k.limit : filter === "ok" ? !k.limit : true))
    .slice()
    .sort((a, b) => {
      if (sort === "vol") return (b.vol ?? -1) - (a.vol ?? -1);
      return a.kw.localeCompare(b.kw);
    });

  return (
    <>
      <MarketSubnav screen="keywords" onNav={onNav} />
      <PageHead
        kicker="02 · 关键词与需求"
        title="需求信号探索"
        sub="种子词与 ASIN 流量词分口径；估算与缺失清楚区分。"
        actions={
          <button className="btn btn-primary" type="button" onClick={() => onToast("演示：SellerSprite 定向补证")}>
            SellerSprite 补证
          </button>
        }
      />
      <div className="stat-grid">
        {[
          { label: "种子关键词", value: String(keywords.length), hint: "含缺口", accent: "accent-info", f: "all" as const },
          { label: "待补证", value: String(keywords.filter((k) => k.limit).length), hint: "保持 null", accent: "accent-warn", f: "gap" as const },
          { label: "有估算", value: String(keywords.filter((k) => !k.limit).length), hint: "provider-derived", accent: "accent-brand", f: "ok" as const },
          { label: "流量词 ASIN", value: String(asinFlow.length), hint: "反查口径", accent: "accent-info", f: null },
        ].map((s) => (
          <button
            key={s.label}
            type="button"
            className={`stat-card clickable ${s.accent}`}
            style={{ textAlign: "left" }}
            onClick={() => s.f && setFilter(s.f)}
          >
            <div className="label">{s.label}</div>
            <div className="value num">{s.value}</div>
            <div className="hint">{s.hint}</div>
            <div className="foot">
              <span>{s.f && filter === s.f ? "已筛选" : "点击筛选"}</span>
              <span>{s.f ? "→" : ""}</span>
            </div>
          </button>
        ))}
      </div>
      <section className="card mb16" style={{ overflow: "hidden" }}>
        <div className="table-toolbar">
          <div className="card-title" style={{ margin: 0 }}>
            <h3>种子关键词</h3>
            <span className="sub">{rows.length} 条</span>
          </div>
          <div className="row">
            <div className="segmented">
              <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
                全部
              </button>
              <button type="button" className={filter === "ok" ? "active" : ""} onClick={() => setFilter("ok")}>
                有估算
              </button>
              <button type="button" className={filter === "gap" ? "active" : ""} onClick={() => setFilter("gap")}>
                待补证
              </button>
            </div>
            <div className="segmented">
              <button type="button" className={sort === "kw" ? "active" : ""} onClick={() => setSort("kw")}>
                按词
              </button>
              <button type="button" className={sort === "vol" ? "active" : ""} onClick={() => setSort("vol")}>
                按搜索量
              </button>
            </div>
          </div>
        </div>
        <div style={{ overflow: "auto" }}>
          <table className="data" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>关键词</th>
                <th>月搜索量</th>
                <th>购买次数</th>
                <th>购买率</th>
                <th>来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.kw} onClick={() => setDetail(k)}>
                  <td>
                    <strong>{k.kw}</strong>
                  </td>
                  <td className="num">{k.vol == null ? <span className="faint">null</span> : k.vol.toLocaleString()}</td>
                  <td className="num">{k.buy == null ? <span className="faint">null</span> : k.buy}</td>
                  <td className="num">{k.rate == null ? <span className="faint">null</span> : `${k.rate}%`}</td>
                  <td>
                    <span className={`tag ${k.limit ? "tag-amber" : "tag-blue"} tag-dot`}>{k.source}</span>
                  </td>
                  <td>
                    <button className="btn btn-sm" type="button" onClick={(e) => { e.stopPropagation(); setDetail(k); }}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="g2">
        <section className="card card-pad">
          <div className="card-title">
            <h3>ASIN 流量词</h3>
            <span className="sub">与种子词独立口径</span>
          </div>
          <div className="stack-sm">
            {asinFlow.map((f) => (
              <div key={f.asin} className="card card-pad" style={{ padding: 14, boxShadow: "none", background: "var(--bg)" }}>
                <div className="row between mb12">
                  <strong style={{ fontSize: 13, fontFamily: "ui-monospace, monospace" }}>{f.asin}</strong>
                  <span className="tag tag-blue">{f.evidence}</span>
                </div>
                <div className="row">
                  {f.words.map((w) => (
                    <span key={w} className="tag">
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="card card-pad">
          <div className="card-title">
            <h3>来源边界</h3>
          </div>
          <div className="notice notice-info mb12">
            <div className="ico">i</div>
            <div>月搜索量 / 购买次数 / 购买率为第三方估算，不是 Amazon 确认事实；缺失保持 null。</div>
          </div>
          <div className="stack-sm">
            {keywordEvidence.map((e) => (
              <div key={e.id} className="ready-item">
                <span className="ready-icon">{e.nature === "unknown" ? "?" : "E"}</span>
                <div>
                  <strong style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>{e.id}</strong>
                  <div style={{ fontSize: 12.5, marginTop: 2 }}>{e.text}</div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {e.nature}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <Drawer open={!!detail} title={detail?.kw || ""} onClose={() => setDetail(null)}>
        {detail && (
          <div className="stack">
            <p className="muted" style={{ fontSize: 13 }}>
              完整指标 · 来源口径
            </p>
            <div className="kw-detail-grid">
              <div>
                <strong className="num">{detail.vol == null ? "—" : detail.vol.toLocaleString()}</strong>
                <span>月搜索量 {detail.vol == null ? "· 缺失" : "· 估算"}</span>
              </div>
              <div>
                <strong className="num">{detail.buy ?? "—"}</strong>
                <span>购买次数</span>
              </div>
              <div>
                <strong className="num">{detail.rate != null ? `${detail.rate}%` : "—"}</strong>
                <span>购买率</span>
              </div>
              <div>
                <strong>—</strong>
                <span>增长率 · 本轮无数据</span>
              </div>
            </div>
            <div className={`notice ${detail.limit ? "notice-warn" : "notice-info"}`}>
              <div className="ico">{detail.limit ? "⚠" : "i"}</div>
              <div>
                来源：{detail.source}
                {detail.limit ? " · 建议定向补证（演示）" : " · provider-derived，非 Amazon 确认"}
              </div>
            </div>
            <button className="btn btn-primary" type="button" onClick={() => onToast("演示：补证任务已保存（待处理）")}>
              创建补证任务（演示）
            </button>
          </div>
        )}
      </Drawer>
    </>
  );
}

/* ═══════════ App ═══════════ */
export default function App({ initialScreen }: { initialScreen?: Screen } = {}) {
  const railRef = useRef<HTMLElement>(null);
  const live = useHifi();
  const [screen, setScreenState] = useState<Screen>(() => initialScreen ?? live.screen);
  const setScreen = (s: Screen) => { setScreenState(s); live.setScreen(s); };
  const [toast, setToast] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [modal, setModal] = useState<"tips" | null>(null);
  const [drawerSample, setDrawerSample] = useState<Sample | null>(null);
  // 侧栏折叠态：默认展开；仅在客户端读取上次选择，避免服务端/客户端首屏不一致。
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("lc-rail-collapsed") === "1") setRailCollapsed(true);
    } catch {
      /* localStorage 不可用时保持展开 */
    }
  }, []);
  const toggleRail = () => {
    setRailCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem("lc-rail-collapsed", next ? "1" : "0");
      } catch {
        /* 忽略持久化失败，仅影响下次默认值 */
      }
      return next;
    });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const onNav = (s: Screen) => {
    // Only the accepted explorer is live here. Keep research on the formal route.
    if (screen === "explorer" && s !== "explorer") {
      const studyId = live.researchData.scan?.id;
      window.location.assign(studyId ? `/market-analysis/${encodeURIComponent(studyId)}?view=${s}` : "/market-analysis");
      return;
    }
    setScreen(s);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const onToast = (m: string) => setToast(m);
  const onOpenSample = (s: Sample) => setDrawerSample(s);

  const isMarket = screen !== "explorer";
  const labels: Record<string, string> = {
    explorer: "探索台",
    overview: "研究总览",
    competition: "市场竞争",
    keywords: "关键词与需求",
    voc: "买家声音",
    compare: "商品对比",
    gate: "市场闸门",
  };

  return (
    <div className={`shell hifi-refined lc-modern-shell${isMarket ? " market-research" : ""}${railCollapsed ? " rail-collapsed" : ""}`}>
      <aside ref={railRef} className="rail lc-modern-navigation" id="lc-rail" data-collapsed={railCollapsed ? "true" : "false"} aria-label="应用导航">
        <div className="brand">
          <Link href="/" className="brand-logo" aria-label="轻选工作台，返回探索台">
            <img src="/brand/mint-compass.jpg" alt="" width={64} height={64} />
          </Link>
          <div className="brand-text">
            <strong>轻选工作台</strong>
            <span>跨境商品研策台</span>
          </div>
        </div>

        <nav className="rail-nav" aria-label="主流程">
          <div className="nav-label"><span>主流程</span></div>
          <button
            type="button"
            className={`nav-item ${screen === "explorer" ? "active" : ""}`}
            data-tip="探索台"
            aria-current={screen === "explorer" ? "page" : undefined}
            onClick={() => onNav("explorer")}
          >
            <span className="nav-icon"><LayoutDashboard size={18} /></span>
            <span className="label">探索台</span>
          </button>
          <Link href="/source" className="nav-item" data-tip="市场采集">
            <span className="nav-icon"><Inbox size={18} /></span>
            <span className="label">市场采集</span>
          </Link>
          <button
            type="button"
            className={`nav-item ${isMarket ? "active" : ""}`}
            data-tip="市场研究"
            aria-current={isMarket ? "page" : undefined}
            onClick={() => onNav("overview")}
          >
            <span className="nav-icon"><Compass size={18} /></span>
            <span className="label">市场研究</span>
          </button>
          <Link href="/research" className="nav-item" data-tip="商品深研">
            <span className="nav-icon"><Sparkles size={18} /></span>
            <span className="label">商品深研</span>
          </Link>
          <Link href="/product-brief" className="nav-item" data-tip="需求单">
            <span className="nav-icon"><FileText size={18} /></span>
            <span className="label">需求单</span>
          </Link>
        </nav>

        <nav className="rail-nav" aria-label="辅助">
          <div className="nav-label"><span>辅助</span></div>
          <Link href="/team" className="nav-item" data-tip="飞书研究中心">
            <span className="nav-icon"><History size={18} /></span>
            <span className="label">飞书研究中心</span>
          </Link>
          <Link href="/diagnostics" className="nav-item" data-tip="系统诊断">
            <span className="nav-icon"><Settings size={18} /></span>
            <span className="label">系统诊断</span>
          </Link>
        </nav>

        <div className="rail-foot">
          {process.env.NEXT_PUBLIC_LC_UI_PREVIEW === "true" && <>
          <div className="demo-pill" data-tip="3450 · 隔离预览：不连接 3010 正式写入，不调用付费 AI / 真实采集">
            <span className="demo-pill-full">3450 · 隔离预览</span>
            <span className="demo-pill-mini"><b>3450</b><i>隔离</i></span>
          </div>
          <p>
            不连接 3010 正式写入
            <br />
            不调用付费 AI / 真实采集
          </p>
          </>}
          <button
            type="button"
            className="rail-toggle"
            onClick={toggleRail}
            aria-label={railCollapsed ? "展开导航栏" : "收起导航栏"}
            aria-expanded={!railCollapsed}
            aria-controls="lc-rail"
            data-tip={railCollapsed ? "展开导航栏" : "收起导航栏"}
          >
            {railCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            <span className="rail-toggle-label">收起导航</span>
          </button>
        </div>
        <NavigationEffects railRef={railRef} collapsed={railCollapsed} activeKey={screen} />
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span>轻选工作台</span>
            <span className="sep">/</span>
            {screen !== "explorer" && (
              <>
                <span>02 市场研究</span>
                <span className="sep">/</span>
              </>
            )}
            <strong>{labels[screen]}</strong>
          </div>
          <div className="top-actions">
            <span className="tag tag-amber tag-dot">{process.env.NEXT_PUBLIC_LC_UI_PREVIEW === "true" ? "隔离预览" : "本地工作台"}</span>
            <div className="more-menu">
              <button className="btn btn-sm" type="button" onClick={() => setMoreOpen(!moreOpen)}>
                更多 ▾
              </button>
              {moreOpen && (
                <div className="more-pop">
                  {moreEntries.map((e) =>
                    "label" in e ? (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          setMoreOpen(false);
                          onToast(`入口保留：${e.label}（本轮不重设计）`);
                        }}
                      >
                        {e.label}
                      </button>
                    ) : (
                      <div key={e.id} className="sep" />
                    )
                  )}
                </div>
              )}
            </div>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setModal("tips")}>
              ?
            </button>
          </div>
        </header>
        <main className="content">
          {(screen === "overview" || screen === "keywords") && <div className="notice notice-warn mb12">此页部分分析卡片仍保留原型内容，尚未全部接入当前证据；请以商品对比、买家声音和闸门中的来源记录为准。</div>}
          {screen === "explorer" && <ExplorerPage onNav={onNav} onToast={onToast} onOpenSample={onOpenSample} />}
          {screen === "overview" && <OverviewPage onNav={onNav} onToast={onToast} onOpenSample={onOpenSample} />}
          {screen === "competition" && <CompetitionPage onNav={onNav} onToast={onToast} onOpenSample={onOpenSample} />}
          {screen === "keywords" && <KeywordsPage onNav={onNav} onToast={onToast} />}
          {screen === "voc" && <VocPage onNav={onNav} onToast={onToast} onOpenSample={onOpenSample} />}
          {screen === "compare" && (
            <ComparePage onNav={onNav} onToast={onToast} draft={live.draft} setDraft={live.setDraft} onOpenSample={onOpenSample} />
          )}
          {screen === "gate" && (
            <GatePage
              onNav={onNav}
              onToast={onToast}
              gate={live.gate}
              setGate={live.setGate}
              reason={live.gateReason}
              setReason={live.setGateReason}
              ack={live.gateAck}
              setAck={live.setGateAck}
            />
          )}
        </main>
      </div>

      <Drawer
        open={!!drawerSample}
        title={drawerSample ? `${drawerSample.name}` : ""}
        onClose={() => setDrawerSample(null)}
      >
        {drawerSample && (
          <div className="stack">
            <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
              <ProductImage asin={drawerSample.asin} imageUrl={drawerSample.imageUrl} name={drawerSample.name} size="lg" />
              <div>
                {roleTag(drawerSample)}
                <div className="faint mono" style={{ fontSize: 12, marginTop: 6 }}>
                  {drawerSample.asin}
                </div>
                <div className="row mt12">
                  <span className="tag">${drawerSample.price != null ? drawerSample.price.toFixed(2) : "未知"}</span>
                  <span className="tag">{drawerSample.rating} ★</span>
                  <span className="tag">{drawerSample.voc} 条买家声音</span>
                </div>
              </div>
            </div>
            {drawerSample.conflict && (
              <div className="notice notice-risk">
                <div className="ico">!</div>
                <div>评论数冲突：快照 {drawerSample.reviews} / 详情 {drawerSample.reviewsAlt}</div>
              </div>
            )}
            <dl className="detail-grid">
              <dt>尺寸</dt>
              <dd>{drawerSample.size}</dd>
              <dt>厚度</dt>
              <dd>{drawerSample.thickness}</dd>
              <dt>包装件数</dt>
              <dd>{drawerSample.pack}</dd>
              <dt>单位价</dt>
              <dd>{drawerSample.unitPriceNote ?? "—"}</dd>
              <dt>正面</dt>
              <dd>{drawerSample.pos}</dd>
              <dt>负面</dt>
              <dd>{drawerSample.neg}</dd>
              <dt>可比较程度</dt>
              <dd>需结合研究范围、结构化属性和包装件数核对；此来源卡不单独判定可比。</dd>
            </dl>
            <p className="muted" style={{ fontSize: 12 }}>
              {drawerSample.note}
            </p>
            <p className="faint" style={{ fontSize: 11 }}>
              图片仅用于辨认该 ASIN 研究样本；图片不证明规格、合规或产品优势。
            </p>
            <div className="row">
              <button className="btn" type="button" onClick={() => { setDrawerSample(null); onNav("voc"); }}>
                查看 VOC
              </button>
              <button className="btn" type="button" onClick={() => { setDrawerSample(null); onNav("compare"); }}>
                加入对比
              </button>
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        open={modal === "tips"}
        title="本轮优化说明"
        desc="交互式研究仪表盘 · Recharts Tooltip · 商品抽屉 · 简化闸门决策。"
        onClose={() => setModal(null)}
        actions={
          <button className="btn btn-primary" type="button" onClick={() => setModal(null)}>
            开始浏览
          </button>
        }
      >
        <div className="stack-sm">
          <div className="notice">
            <div className="ico">1</div>
            <div>统计卡 / 机会 / 主题 / 价格区间均可点击联动</div>
          </div>
          <div className="notice">
            <div className="ico">2</div>
            <div>商品图为 ASIN 示意（CDN 不可达）；正式接 imageUrl</div>
          </div>
          <div className="notice">
            <div className="ico">3</div>
            <div>趋势按 ASIN 隔离，标注演示序列，无数据显缺失</div>
          </div>
        </div>
      </Modal>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
