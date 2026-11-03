"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleDot, Hand, Link2, LockKeyhole, Paperclip, RefreshCw } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { GalleryImage } from "./GalleryImage";
import { resolveGalleryTitle } from "./presentation";
import { PROVENANCE_MODULE_LABELS } from "../source-provenance/sourceProvenanceModel";
import { MATRIX_GROUPS, materialCell, matchesMaterialFilter, matrixSubjectScope, sharedMaterialReferences, type MatrixCell, type MatrixFilter, type MatrixIssue, type MatrixItem, type MatrixLocation, type MatrixReading } from "./materialMatrixPresentation";
import styles from "./ProductMaterialMatrix.module.css";

const SHORT_LABELS: Record<string, string> = { amazon_detail: "商品详情", amazon_search_market: "搜索关联", variation: "变体结构", review_voc: "评论资料", sellersprite_product_market: "商品市场", reverse_asin: "反查 ASIN", keyword_mining_trend: "关键词与趋势", historical_trend: "历史趋势" };
export const MATRIX_ISSUES: { value: MatrixIssue; label: string }[] = [{ value: "all", label: "全部" }, { value: "human", label: "需人工" }, { value: "partial", label: "部分完成" }, { value: "blocked", label: "受阻 / 受限" }, { value: "failed", label: "尝试失败" }, { value: "missing", label: "未采集" }, { value: "not_in_scope", label: "本轮未授权" }];
const STATE_ICONS = { complete: CheckCircle2, partial: CircleDot, limited: AlertTriangle, human: Hand, blocked: Ban, failed: AlertTriangle, missing: CircleDashed, not_in_scope: LockKeyhole, unknown: CircleDashed, read_error: AlertTriangle, query: Link2 };

type Props = {
  active: boolean; batchId: string; allItems: MatrixItem[]; baseItems: MatrixItem[]; items: MatrixItem[];
  allowedModules: readonly string[] | null; filter: MatrixFilter; location: MatrixLocation | null;
  loaded: boolean; loading: boolean; loadError: string | null;
  onFilter: (filter: MatrixFilter) => void; onLocate: (item: MatrixItem, module: string) => void;
  onEvidence: (item: MatrixItem, module: string) => void; onSources: () => void; onRun: () => void;
  onReveal: () => void; onReloadItems: () => void;
};

/** One read-only matrix. Business controls and evidence readers remain in T02/T03/T04. */
export function ProductMaterialMatrix({ active, batchId, allItems, baseItems, items, allowedModules, filter, location, loaded, loading, loadError, onFilter, onLocate, onEvidence, onSources, onRun, onReveal, onReloadItems }: Props) {
  const [reading, setReading] = useState<MatrixReading>({ state: "idle" });
  const [readEpoch, setReadEpoch] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef({ top: 0, left: 0 });
  const lastFocusedToken = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReading({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/source-layer/batch-capture/external-evidence?batchId=${encodeURIComponent(batchId)}`, { headers: buildAccessHeaders(), signal: controller.signal, cache: "no-store" });
        const json = await response.json();
        if (!response.ok || !json?.ok || !Array.isArray(json.data?.subjects) || !Array.isArray(json.data?.totals?.failures)) throw new Error("补充资料读取失败，请重新读取。");
        setReading({ state: "ready", data: json.data });
      } catch {
        if (!controller.signal.aborted) setReading({ state: "error", error: "补充资料读取失败，不代表没有证据。" });
      }
    })();
    return () => controller.abort();
  }, [active, batchId, readEpoch]);

  useEffect(() => {
    if (active && scroller.current) scroller.current.scrollTo(scrollPosition.current.left, scrollPosition.current.top);
  }, [active]);

  useEffect(() => {
    if (!active || !location || !scroller.current || lastFocusedToken.current === location.token) return;
    const container = scroller.current;
    const target = container.querySelector<HTMLButtonElement>(`[data-matrix-item="${CSS.escape(location.itemId)}"] [data-matrix-module="${location.module}"]`);
    if (!target) return;
    lastFocusedToken.current = location.token;
    const box = container.getBoundingClientRect(), rect = target.getBoundingClientRect();
    const header = container.querySelector("thead")?.getBoundingClientRect().height ?? 72;
    const identity = container.querySelector("tbody th")?.getBoundingClientRect().width ?? 240;
    if (rect.top < box.top + header) container.scrollTop -= box.top + header - rect.top + 6;
    else if (rect.bottom > box.bottom) container.scrollTop += rect.bottom - box.bottom + 6;
    if (rect.left < box.left + identity) container.scrollLeft -= box.left + identity - rect.left + 6;
    else if (rect.right > box.right) container.scrollLeft += rect.right - box.right + 6;
    target.focus({ preventScroll: true });
  }, [active, location, items]);

  const modules = MATRIX_GROUPS[filter.group];
  const selectedItem = allItems.find(item => item.id === location?.itemId);
  const selectedCell = selectedItem && location ? materialCell(selectedItem, location.module, allowedModules, reading) : null;
  const hidden = selectedItem && !items.some(item => item.id === selectedItem.id);
  const shared = selectedCell ? sharedMaterialReferences(allItems, selectedCell.evidenceId) : 0;
  const visibleReferences = items.flatMap(item => modules.flatMap(module => {
    const cell = materialCell(item, module, allowedModules);
    return cell.hasEvidence && cell.evidenceId ? [cell.evidenceId] : [];
  }));
  const issues = MATRIX_ISSUES.map(issue => ({ ...issue, count: baseItems.filter(item => matchesMaterialFilter(item, { ...filter, issue: issue.value }, allowedModules)).length }));
  const scopeLabel = (module: string) => ({ product: "商品资料", search_association: "市场查询关联", batch_query: "批次共用查询", file: "导出附件关联" })[matrixSubjectScope(module)];
  const renderState = (cell: MatrixCell) => { const Icon = STATE_ICONS[cell.state]; return <><span className={styles.stateLine}><Icon size={16} aria-hidden="true" />{cell.label}</span>{cell.hasEvidence ? <Paperclip className={styles.attachment} size={13} aria-label="有证据附件" /> : null}</>; };

  return <section className={styles.root} data-testid="product-material-matrix" data-active={active} aria-label="商品资料矩阵">
    <div className={styles.tools}>
      <div className={styles.groups} role="group" aria-label="矩阵资料范围">
        <button type="button" aria-pressed={filter.group === "basic"} onClick={() => onFilter({ group: "basic", module: "all", issue: "all" })}>基础资料 <span>4 类</span></button>
        <button type="button" aria-pressed={filter.group === "supplementary"} onClick={() => onFilter({ group: "supplementary", module: "all", issue: "all" })}>补充资料 <span>4 类</span></button>
      </div>
      <div className={styles.links}>{reading.state === "loading" ? <span className={styles.readStatus} role="status">核对补充来源…</span> : null}<button type="button" onClick={onSources}>资料与来源</button><button type="button" onClick={onRun}>运行详情</button></div>
    </div>
    <div className={styles.filters}>
      <select aria-label="矩阵资料类别" value={filter.module} onChange={event => onFilter({ ...filter, module: event.target.value })}>
        <option value="all">全部{filter.group === "basic" ? "基础" : "补充"}资料</option>{modules.map(module => <option key={module} value={module}>{SHORT_LABELS[module]}</option>)}
      </select>
      <div className={styles.issues} role="group" aria-label="按资料问题筛选">
        {issues.map(issue => <button type="button" key={issue.value} aria-pressed={filter.issue === issue.value} data-testid={`matrix-filter-${issue.value}`} onClick={() => onFilter({ ...filter, issue: issue.value })}>{issue.label}{issue.value !== "all" ? <b>{loaded ? issue.count : "–"}</b> : null}</button>)}
      </div>
    </div>
    {reading.state === "error" || Boolean(reading.data?.totals.failures.length) ? <div className={styles.readError} role="alert" data-testid="matrix-read-error"><AlertTriangle size={16} aria-hidden="true" /><span>{reading.state === "error" ? reading.error : "部分补充来源读取失败，不代表没有证据。"}</span><button type="button" onClick={() => setReadEpoch(epoch => epoch + 1)}>重新读取补充资料</button></div> : null}
    {selectedItem && selectedCell && location ? <div className={styles.location} data-testid="matrix-location" data-tone={selectedCell.state}>
      <div><strong>{selectedItem.asin} · {SHORT_LABELS[location.module]} · {selectedCell.label}</strong><p>{selectedCell.reason}{shared > 1 ? ` 同一附件关联 ${shared} 件商品，不按多个独立来源统计。` : ""}</p></div>
      <div className={styles.locationActions}>{selectedCell.hasEvidence ? <button type="button" onClick={() => onEvidence(selectedItem, location.module)}>查看对应证据</button> : selectedCell.query ? <button type="button" onClick={onRun}>查看批次来源</button> : selectedCell.state === "unknown" ? <button type="button" onClick={onReloadItems}>重新读取商品</button> : <button type="button" onClick={onRun}>查看运行原因</button>}{hidden ? <button type="button" onClick={onReveal}>清除筛选并显示当前商品</button> : <button type="button" onClick={() => onLocate(selectedItem, location.module)}>定位检阅模块</button>}</div>
      {hidden ? <p className={styles.hiddenNotice} role="status">当前定位商品被筛选隐藏，商品与证据身份仍保留。</p> : null}
    </div> : null}
    {loading && !loaded ? <div className={styles.empty} role="status">正在读取商品资料…</div> : loadError ? <div className={styles.empty} role="alert">商品资料读取失败：{loadError}<button type="button" onClick={onReloadItems}>重新读取商品</button></div> : items.length === 0 ? <div className={styles.empty} data-testid="matrix-empty"><strong>{allItems.length ? "当前条件下没有匹配商品" : "本批次暂无商品"}</strong>{allItems.length ? <button type="button" onClick={onReveal}>清除筛选，查看全部商品</button> : <span>取得商品记录后，资料状态才会在这里显示。</span>}</div> : <div className={styles.scroller} ref={scroller} onScroll={event => { if (active) scrollPosition.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }; }} data-testid="matrix-scroll" tabIndex={0} aria-label="商品资料矩阵，可上下左右滚动">
      <table className={styles.table}>
        <thead><tr><th scope="col"><span>商品</span><small>当前显示 {items.length} 件</small></th>{modules.map(module => <th key={module} scope="col"><span>{SHORT_LABELS[module]}</span><small>{scopeLabel(module)}</small></th>)}</tr></thead>
        <tbody>{items.map(item => {
          const title = resolveGalleryTitle(item);
          return <tr key={item.id} data-matrix-item={item.id} data-testid="matrix-product-row"><th scope="row"><div className={styles.identity}><div className={styles.thumbnail}><GalleryImage src={item.image} alt={title.primary} onOpenDetail={() => onLocate(item, filter.module === "all" ? modules[0] : filter.module)} /></div><div className={styles.identityText}><button type="button" className={styles.productName} title={title.primary} onClick={() => onLocate(item, filter.module === "all" ? modules[0] : filter.module)}>{title.primary}</button><span className={styles.asin}>{item.asin}{item.archivedAt ? " · 已归档" : ""}</span></div></div></th>{modules.map(module => {
            const cell = materialCell(item, module, allowedModules, reading);
            const chosen = location?.itemId === item.id && location.module === module;
            return <td key={module}><button type="button" className={styles.cell} data-testid={`matrix-cell-${item.asin}-${module}`} data-matrix-module={module} data-state={cell.state} data-focused={chosen} aria-label={`${item.asin} · ${SHORT_LABELS[module]} · ${cell.label}${cell.hasEvidence ? " · 有证据附件" : ""}`} title={cell.reason} onClick={() => onLocate(item, module)}>{renderState(cell)}</button></td>;
          })}</tr>;
        })}</tbody>
      </table>
    </div>}
    <div className={styles.foot}><span><Paperclip size={13} aria-hidden="true" />已存附件不等于资料完整</span><span className={styles.scrollHint}>可滚动查看，商品列保持可见</span><details><summary>统计与来源说明</summary><p>筛选只影响当前商品视图，不改变研究样本。本轮执行量与批次历史覆盖请分别到运行详情、资料与来源查看。</p><p>当前矩阵 {visibleReferences.length} 个关联单元有附件，引用去重 {new Set(visibleReferences).size} 个附件；不代表同等数量的独立来源。搜索为查询结果的商品关联；补充查询资料不按商品重复计数，历史趋势按文件附件关联。</p><p>{allowedModules ? `本轮运行白名单：${allowedModules.map(module => PROVENANCE_MODULE_LABELS[module] ?? module).join("、")}。搜索阶段资料不由推进白名单重复执行。` : "本轮授权范围尚未确认；不会把未知范围当作已授权或没有任务。"}</p><p>补充来源：{reading.state === "loading" ? "读取中" : reading.state === "ready" ? "已按真实主体读取" : reading.state === "error" ? "读取失败" : "尚未读取"}。矩阵不发起采集、确认或保存。</p></details></div>
  </section>;
}
