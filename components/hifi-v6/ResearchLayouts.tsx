"use client";
import { useState } from "react";
import Link from "next/link";
import { ProductImage } from "./components";
import { useHifi } from "./HifiProvider";
import { GATE_LABEL, ROLE_LABEL, type GateStatus, type Sample, type Screen } from "./data";
import { comparisonKind, effectiveGate, gateSaveBlocked, latestVoiceReport, linkedThemeReviews, subjectReviews, uniqueReviewProducts } from "./researchPresentation";
import { ResearchCockpit } from "./cockpit/ResearchCockpit";

type Props = { onNav: (screen: Screen) => void; onToast: (message: string) => void; onOpenSample: (sample: Sample) => void };
const tabs: Array<[Screen, string]> = [["overview", "研究总览"], ["competition", "市场竞争"], ["keywords", "关键词与需求"], ["voc", "买家声音"], ["compare", "商品对比"], ["gate", "市场闸门"]];
function Header({ screen, title, sub, onNav }: { screen: Screen; title: string; sub: string; onNav: Props["onNav"] }) {
  return <><nav className="flow" aria-label="主流程"><Link href="/source">01 市场采集</Link><button className="active" onClick={() => onNav("overview")}>02 市场研究</button><Link href="/research">03 商品深研</Link><Link href="/product-brief">04 需求单</Link></nav>
    <nav className="subnav" aria-label="02 市场研究工作区">{tabs.map(([id, label]) => <button type="button" key={id} className={id === screen ? "active" : ""} onClick={() => onNav(id)}>{label}</button>)}</nav>
    <div className="page-head"><div><div className="kicker">02 · {tabs.find(t => t[0] === screen)?.[1]}</div><h1 className="page-title">{title}</h1><p className="page-sub">{sub}</p></div></div></>;
}
function ReadState() {
  const { loading, researchData: d } = useHifi();
  return <div className="notice notice-warn" role="status">{loading ? "正在读取当前研究与已保存证据…" : d.error || "当前研究尚无可展示的样本。请返回市场采集确认研究对象。"}</div>;
}
function ProvenanceNotice() {
  const { researchData: d } = useHifi();
  return <p className="data-boundary">{d.intelligenceError ? `证据暂不可读：${d.intelligenceError}。缺失不表示没有问题。` : "来自已保存样本与证据，只读呈现。来源记录不等于人工确认；历史 AI 建议不替代人工决定。"}</p>;
}

export function ResearchExplorer({ onNav, onToast, onOpenSample }: Props) {
  // 探索台已升级为 Research Cockpit（Bento 网格 + 交互图表 + 可展开洞察 + 证据抽屉）。
  // 数据仍由 HifiProvider 从 /api/home/summary 与 /api/market-analysis/* 只读读取。
  return <ResearchCockpit onNav={onNav} onToast={onToast} onOpenSample={onOpenSample} />;
}

export function ResearchCompare({ onNav, onOpenSample, draft, setDraft }: Props & { draft: string[]; setDraft: (value: string[]) => void }) {
  const live = useHifi(), { scan, intelligence: data } = live.researchData;
  const items = scan?.sampleItems ?? [], savedItems = scan?.representatives?.items ?? [];
  const [a, setA] = useState(""), [b, setB] = useState("");
  const sa = items.find(s => s.asin === a) ?? items.find(s => s.asin === savedItems[0]?.asin) ?? items[0];
  const sb = items.find(s => s.asin === b) ?? items.find(s => s.asin === savedItems[1]?.asin) ?? items[1] ?? items[0];
  const open = (asin: string) => { const s = live.samples.find(x => x.asin === asin); if (s) onOpenSample(s); };
  const details = (key: string) => data?.productDetails?.find(d => d.subjectKey === key)?.facts;
  const fa = sa && details(sa.subjectKey), fb = sb && details(sb.subjectKey);
  const ca = data?.samples.find(s => s.subjectKey === sa?.subjectKey)?.reviewCountCaliber;
  const cb = data?.samples.find(s => s.subjectKey === sb?.subjectKey)?.reviewCountCaliber;
  const dimensions = (f: typeof fa) => f?.itemDimensions ? `${f.itemDimensions.length} × ${f.itemDimensions.width}${f.itemDimensions.height != null ? ` × ${f.itemDimensions.height}` : ""} ${f.itemDimensions.unit}` : null;
  const rows = [
    { label: "包价（非单位价）", a: sa?.price, b: sb?.price, note: "包装件数缺失，不能换算或排名单位成本。" },
    { label: "来源记录的品牌", a: fa?.brand, b: fb?.brand, note: "来源属性，未作人工确认。" },
    { label: "商品尺寸", a: dimensions(fa), b: dimensions(fb), note: "按来源结构化字段；不从标题猜规格。" },
    { label: "材质", a: fa?.material, b: fb?.material, note: "来源声明，非检测或合规证明。" },
    { label: "包装件数 / 厚度", a: null, b: null, note: "当前展示合同缺少可靠字段，需核对详情证据。" },
    { label: "累计评价数", a: ca?.state === "verified" ? sa?.reviewCount : null, b: cb?.state === "verified" ? sb?.reviewCount : null, note: "未复核或有来源冲突时不用于成熟度比较。", conflict: ca?.state === "conflict" || cb?.state === "conflict" },
  ];
  return <><Header screen="compare" title="围绕研究问题，看清商品差异" sub="先看来源属性、冲突与缺口，再选择代表商品；包价差异不等于产品优势。" onNav={onNav} />
    {!scan || !sa || !sb ? <ReadState /> : <>
      <div className="research-question-strip"><strong>本轮研究问题</strong><span>{scan.marketWorkflow?.metadata?.researchQuestion || "尚未保存。请先确认用途、规格与对比范围；当前只展示可核对的来源差异。"}</span><button className="btn btn-sm" onClick={() => onNav("gate")}>查看范围与判断</button></div>
      <div className="compare-identities">{[sa, sb].map((s, index) => <article key={index} className="card compare-identity"><div className="compare-product-picture"><ProductImage asin={s.asin} imageUrl={s.imageUrl} name={s.title || s.asin} /></div><div><label>商品 {index ? "B" : "A"}<select aria-label={`商品 ${index ? "B" : "A"}`} value={s.asin} onChange={e => index ? setB(e.target.value) : setA(e.target.value)}>{items.map(i => <option key={i.asin} value={i.asin}>{i.asin}</option>)}</select></label><h3>{s.title || "标题缺失"}</h3><div className="row"><span className="tag">{ROLE_LABEL[savedItems.find(r => r.asin === s.asin)?.role ?? "sample"]}</span><button className="btn btn-sm btn-ghost" onClick={() => open(s.asin)}>来源卡 →</button></div></div></article>)}</div>
      <div className="research-columns compare-evidence"><section className="card"><div className="card-title card-pad"><h3>核心差异与可比较程度</h3><span className="sub">缺失 ≠ 相同</span></div><div className="comparison-flags"><span className="tag tag-amber">包装件数 / 厚度待补</span><span className={`tag ${ca?.state === "conflict" || cb?.state === "conflict" ? "tag-rose" : "tag-blue"}`}>{ca?.state === "conflict" || cb?.state === "conflict" ? "评价数存在来源冲突" : "评价口径需复核"}</span></div><table className="data research-diff-table"><thead><tr><th>维度</th><th>A</th><th>B</th><th>判断与补证</th></tr></thead><tbody>{rows.map(r => { const kind = r.conflict ? "conflict" : comparisonKind(r.a, r.b); return <tr key={r.label}><th>{r.label}</th><td>{r.a == null ? "未知" : r.label.startsWith("包价") ? `${r.a} ${sa.priceCurrency || "币种未知"}` : r.a}</td><td>{r.b == null ? "未知" : r.label.startsWith("包价") ? `${r.b} ${sb.priceCurrency || "币种未知"}` : r.b}</td><td><span className={`diff-badge diff-${kind === "same" ? "close" : kind}`}>{kind === "conflict" ? "来源冲突" : kind === "unknown" ? "不可比较" : kind === "same" ? "记录相同" : "记录不同"}</span><small>{r.note}</small></td></tr>; })}</tbody></table></section>
        <aside className="stack"><section className="card card-pad"><h3>评论依据覆盖到哪里？</h3>{[sa, sb].map((s, i) => <div className="coverage-row" key={i}><strong>{i ? "B" : "A"} · {s.asin}</strong><span>{data ? subjectReviews(data, s.subjectKey).length : "未知"} 条已读取原声</span></div>)}<p className="data-boundary">读取数量不是累计评价量；未读取不等于无负面。不能仅凭星级判断痛点。</p><button className="btn btn-sm" onClick={() => onNav("voc")}>查看原声及正反限制 →</button></section>
        <section className="card card-pad"><h3>下一步验证方向</h3><ol className="validation-list"><li>补齐包装件数，才能公平比较单位价格。</li><li>核对评价数冲突与具体使用场景。</li><li>核实尺寸、材质及测试条件，再作人工选择。</li></ol><span className="tag tag-amber">不生成优势分数或自动推荐</span></section></aside></div>
      <details className="card card-pad source-expand"><summary>展开来源、时间与冲突读数</summary>{[sa, sb].map((s, i) => { const c = i ? cb : ca; const detail = data?.productDetails?.find(d => d.subjectKey === s.subjectKey); return <div className="evidence-gap" key={i}><strong>{s.asin} · {s.scopeReview?.reviewStatus === "IN_SCOPE" && !s.scopeReview.reviewStale ? "已人工确认研究范围" : "人工属性确认未提供"}</strong><span>评价数：锁定 {c?.lockedValue ?? "未知"} / 详情页 {c?.productPageValue ?? "未知"}；{c?.state ?? "尚未复核"}</span><span>属性证据 {detail?.evidence.evidenceId ?? "缺失"} · {detail?.evidence.capturedAt ?? "时间未知"}</span></div>; })}</details>
      <section className="card card-pad selection-review"><div className="card-title"><h3>人工代表商品与选择草稿</h3><span className="tag">有效闸门：{GATE_LABEL[effectiveGate(scan)]}</span></div><p>保留已保存的角色与理由；修改草稿不会替换这些记录，也不会自动进入 03。</p>{savedItems.map(s => <details key={s.asin}><summary>{s.asin} · {ROLE_LABEL[s.role]} · 已保存角色与理由</summary><p>{s.note || "未提供理由"}</p></details>)}
        <details className="source-expand"><summary>展开全部 {items.length} 件样本，调整选择草稿（当前 {draft.length} 件）</summary><div className="selection-list">{items.map(s => <label key={s.asin}><input type="checkbox" checked={draft.includes(s.asin)} onChange={e => setDraft(e.target.checked ? [...new Set([...draft, s.asin])] : draft.filter(id => id !== s.asin))} /><span>{s.asin} · {s.title || "标题缺失"}</span></label>)}</div></details>
        <div className="row mt12"><button className="btn" disabled title="此预览尚未完成代表商品角色与理由保存接线">保存重点对象</button><button className="btn btn-primary" disabled title="需要有效的已保存闸门、代表商品角色和理由，以及正式交接检查">保存并进入 03</button><span className="muted">代表商品保存与交接尚未完成接线，当前保持锁定。</span></div></section><ProvenanceNotice />
    </>}
  </>;
}

export function ResearchGate({ onNav, gate, setGate, reason, setReason, ack, setAck }: Omit<Props, "onOpenSample"> & { gate: GateStatus | null; setGate: (s: GateStatus | null) => void; reason: string; setReason: (s: string) => void; ack: boolean; setAck: (v: boolean) => void }) {
  const live = useHifi(), { scan } = live.researchData;
  const [saving, setSaving] = useState(false), [feedback, setFeedback] = useState<string | null>(null);
  const saved = effectiveGate(scan), blocked = gateSaveBlocked(scan, gate, reason, ack) || (!live.onSavedGate ? "保存接口尚未接线，当前仅可调整草稿。" : null);
  const choices: Array<[GateStatus, string, string]> = [["PROCEED", "继续深入研究", "仅确认继续研究；仍需保存代表商品并通过交接检查。"], ["VALIDATE_MORE", "需要补充证据", "先补属性、来源冲突或评论覆盖，再重新判断。"], ["PAUSE", "暂缓，继续观察", "保留已有证据与判断，等待条件或信息变化。"], ["DROP", "停止本次研究", "记录停止理由；不继续下游开发。"]];
  return <><Header screen="gate" title="证据看过了，下一步由你决定" sub="先选决定，再记录理由和风险确认；草稿与已保存状态分开。" onNav={onNav} />{!scan ? <ReadState /> : <>
    <div className="gate-scope-strip card"><div><span className="kicker">当前研究</span><strong>{scan.scanName}</strong><span>{scan.marketplace} · {scan.sampleCount} 件样本</span></div><div><span className="tag tag-amber">当前有效状态：{GATE_LABEL[saved]}（{saved}）</span>{scan.marketGate?.stale && <small>历史{GATE_LABEL[scan.marketGate.status]}已因来源变化失效，需重新确认。</small>}</div></div>
    <div className="gate-workspace"><section className="card card-pad-lg decision-primary"><div className="card-title"><h3>你的决定</h3><span className="sub">{gate && gate !== "PENDING" ? `当前草稿：${GATE_LABEL[gate]} · 尚未保存` : "请选择，当前没有新决定"}</span></div><div className="gate-decide">{choices.map(([id, title, text], i) => <button type="button" key={id} aria-pressed={gate === id} className={`decide-card ${gate === id ? "selected" : ""} ${id === "DROP" ? "danger" : ""}`} onClick={() => { setGate(id); setFeedback(null); }}><span className="decision-number">0{i + 1}</span><strong>{title}</strong><span>{text}</span><em>{gate === id ? "已选 · 待保存" : "选择此决定"}</em></button>)}</div>
      <div className="field mt12"><label htmlFor="gate-reason">判断理由（必填）</label><textarea id="gate-reason" rows={3} value={reason} onChange={e => { setReason(e.target.value); setFeedback(null); }} placeholder="说明依据、仍存缺口，以及为什么选择这个决定。" /></div><label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>我已阅读风险与缺失项，确认由我作出本次判断。</span></label>
      <div className="decision-actions"><button className="btn btn-primary" disabled={Boolean(blocked) || saving || live.loading} title={blocked || "使用当前样本与版本信息保存，服务端会再次验证"} onClick={async () => { if (!gate || blocked) return; setSaving(true); setFeedback(null); try { await live.onSavedGate?.(gate, reason); setFeedback("保存请求已成功，正在重新读取服务端有效状态；只有回读结果决定是否可继续。"); } catch (e) { setFeedback(e instanceof Error ? e.message : "保存失败，草稿已保留，请刷新核对当前版本。"); } finally { setSaving(false); } }}>{saving ? "正在保存…" : "保存我的决定"}</button><button className="btn" onClick={() => onNav("compare")}>回商品对比核对</button></div><p className="disabled-reason" role="status">{feedback || blocked || "可提交人工判断；最终结果受服务端版本、证据与权限门禁约束。"}</p>
    </section><aside className="stack"><section className="card card-pad"><h3>保存前需要知道</h3>{(scan.decisionReadiness?.blockers ?? []).map(m => <div className="notice notice-risk" key={m.code}>{m.label}：{m.detail}</div>)}<div className="stack-sm mt12">{(scan.decisionReadiness?.acknowledgeableMissing ?? []).map(m => <details className="evidence-gap" key={m.code}><summary>{m.label}</summary><p>{m.detail}</p></details>)}</div>{!scan.decisionReadiness && <p>就绪条件未读取，继续决定保持禁用。</p>}</section>
      <section className="card card-pad"><h3>进入 03 的真实限制</h3><ol className="validation-list"><li>有效的已保存闸门为「通过」。</li><li>代表商品须保存角色、理由与版本。</li><li>交接接口仍需验证范围、版本和权限。</li></ol><button className="btn" disabled title="此预览尚未完成代表商品保存与正式交接接线">继续进入 03</button><p className="disabled-reason">选择“继续”不会自动放行；当前交接接线未完成。</p></section>
      <details className="card card-pad"><summary>研究范围、历史理由与版本</summary><p>{scan.marketWorkflow?.metadata?.researchQuestion || "研究问题尚未保存。"}</p><p>历史理由：{scan.marketGate?.reason || "无"}</p><p className="mono wrap-anywhere">版本 {scan.resourceVersion}<br />样本 {scan.sampleHash}</p></details></aside></div><ProvenanceNotice />
  </>}</>;
}

export function ResearchVoice({ onNav, onOpenSample }: Props) {
  const live = useHifi(), { scan, intelligence: data } = live.researchData;
  const report = latestVoiceReport(data), themes = report?.voiceThemes ?? [];
  const [theme, setTheme] = useState(0), [expanded, setExpanded] = useState(false), [otherVoice, setOtherVoice] = useState(false);
  const selected = themes[theme] ?? themes[0], linked = data && selected ? linkedThemeReviews(data, selected.reviewIds) : [];
  const subjects = new Set(linked.flatMap(r => r.subjectKeys?.length ? r.subjectKeys : [r.subjectKey]));
  const other = data?.reviews.filter(r => !linked.some(x => x.id === r.id) && (subjects.has(r.subjectKey) || r.subjectKeys?.some(s => subjects.has(s)))) ?? [];
  const reviews = otherVoice ? other : selected ? linked : data?.reviews ?? [];
  return <><Header screen="voc" title="把改进假设放回评论原声中核对" sub="先看引用与覆盖，再看支持和相反反馈；没有明确关联的反馈不作自动归类。" onNav={onNav} />{!scan ? <ReadState /> : <>
    <div className="voice-summary card"><div><strong>{data?.reviews.length ?? "未知"}</strong><span>条已保存原声</span></div><div><strong>{data ? `${uniqueReviewProducts(data)} / ${scan.sampleCount}` : "未知"}</strong><span>ASIN 覆盖</span></div><div><strong>{data ? themes.length : "未知"}</strong><span>历史 AI 主题 · 待复核</span></div><p>非随机公开评论样本；不能用高星代替正面判断，也不能据此估算全市场负面比例。</p></div>
    {report && <div className="notice notice-warn mb12">{report.inputHash === data?.inputHash ? "AI 主题仍需人工复核" : "历史 AI 主题的输入已变化，当前仅用于追溯和待验证假设"} · 生成于 {report.generatedAt.slice(0, 10)}</div>}
    <div className="voice-research-grid"><section className="card card-pad voice-evidence"><div className="card-title"><h3>{otherVoice ? "同主体其他反馈（尚未判定是否相反）" : selected ? `${selected.label} · 引用原声` : "已保存评论原声"}</h3><span className="sub">{reviews.length} 条</span></div><div className="row mb12"><button className="btn btn-sm" aria-pressed={!otherVoice} onClick={() => { setOtherVoice(false); setExpanded(false); }}>查看引用依据</button><button className="btn btn-sm" aria-pressed={otherVoice} disabled={!subjects.size || !other.length} onClick={() => { setOtherVoice(true); setExpanded(false); }}>核对同主体其他反馈（{other.length}）</button></div>
      {reviews.length === 0 && <div className="notice notice-warn">没有可定位的原声证据，不能支持这项假设。请补齐引用与来源。</div>}
      {reviews.slice(0, expanded ? reviews.length : 4).map((r, i) => { const asin = r.subjectKey.split(":").at(-1) || "未知", s = live.samples.find(s => s.asin === asin); return <article className="quote" key={r.id ?? `${r.evidence.id}-${i}`}><div className="meta"><span className="stars">{r.rating == null ? "评分未知" : `${r.rating} ★`}</span>{s ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenSample(s)}><ProductImage asin={s.asin} imageUrl={s.imageUrl} name={s.name} size="sm" />{s.asin}</button> : <span>{asin}</span>}<span className="tag">{otherVoice ? "同主体原声 · 尚未归类" : selected ? "AI 引用关联 · 待核对" : "来源原声 · 非人工确认"}</span></div><p className="text">“{r.text}”</p><details><summary>证据、时间与引用</summary><p className="wrap-anywhere">{r.id || "无评论 ID"}<br />{r.evidence.evidenceId} · {r.evidence.capturedAt}</p>{r.evidence.sourceUrl && <a href={r.evidence.sourceUrl} target="_blank" rel="noreferrer">查看该评论的来源商品页面 ↗</a>}<p>来源页面是商品入口，未承诺直达评论。保存正文可能为公开摘录。</p></details></article>; })}
      {reviews.length > 4 && <button className="btn mt12" onClick={() => setExpanded(!expanded)}>{expanded ? "收起原声" : `展开其余 ${reviews.length - 4} 条`}</button>}
    </section><aside className="stack"><section className="card card-pad"><div className="card-title"><h3>假设 → 证据</h3><span className="tag tag-ai">历史 AI 提议</span></div><label className="voice-theme-picker">选择要复核的历史主题<select aria-label="选择评论主题" value={theme} disabled={!themes.length} onChange={e => { setTheme(Number(e.target.value)); setExpanded(false); setOtherVoice(false); }}>{themes.map((t, i) => <option key={t.id || t.label} value={i}>{t.label} · {t.reviewIds.length} 条引用</option>)}</select></label>{!themes.length && <p>没有可追溯的 AI 主题。保留原声，不自动生成改进机会。</p>}</section>
      {selected && <section className="card card-pad hypothesis-link"><h3>{selected.hypothesis || "假设尚未明确"}</h3><div className="evidence-gap"><strong>支持依据（待逐条核对）</strong><span>{linked.length} / {selected.reviewIds.length} 条引用在当前证据中可定位，涉及 {subjects.size} 个 ASIN。可定位不等于支持已成立。历史报告写道：{selected.statement.text}</span></div><div className="evidence-gap"><strong>相反反馈与限制</strong><span>{selected.sentiment === "mixed" ? "报告已标为混合反馈，引用中可能同时有支持与反例，需逐条复核。" : "当前报告没有逐条标记相反反馈。请核对同主体其他原声，不能将未标注当作不存在。"}</span></div><div className="evidence-gap"><strong>覆盖不足</strong><span>{subjects.size} / {scan.sampleCount} 个样本有该主题引用；{selected.reviewIds.length - linked.length} 条历史引用未在当前结果定位。不能外推为普遍需求。</span></div><details><summary>改进方向与验证建议（AI 提议）</summary><p>{selected.improvement}</p><ul>{selected.verification.map(v => <li key={v}>{v}</li>)}</ul></details></section>}
    </aside></div><ProvenanceNotice />
  </>}</>;
}
