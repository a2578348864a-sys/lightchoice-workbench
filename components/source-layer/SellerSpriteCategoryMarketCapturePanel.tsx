"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, FolderTree, Globe2, Layers3, Loader2, Search, ShieldCheck } from "lucide-react";

import styles from "./SellerSpriteCategoryMarketCapturePanel.module.css";
import { useSpotlight } from "@/components/source/cockpit/useSpotlight";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { CategoryMarketQualityNotice } from "./CategoryMarketQualityNotice";
import {
  AMAZON_CATEGORY_DICTIONARY,
  AMAZON_CATEGORY_TAXONOMY_META,
  AMAZON_TAXONOMY_IMPORTED,
  findAmazonCategoryByAmazonNodeId,
  findAmazonCategoryPathByAmazonNodeId,
  presentSellerSpriteCategoryLabel,
  type AmazonCategoryNode,
} from "@/components/source-layer/amazonCategoryDictionary";
import {
  isTrustedSellerSpriteMatch,
  buildSellerSpriteCategoryLookupQuery,
  matchSellerSpriteCandidate,
  sellerSpriteMatchBadge,
  type SellerSpriteCandidateMatch,
} from "@/lib/sourceLayer/sellerSpriteCategoryMatch";

type SellerSpriteCategoryNode = {
  id: string;
  label: string;
  products: number | null;
};

type Estimate = { value: number | null; nature: "provider_estimate" };

type CategoryMarketBatch = {
  batchId: string;
  sourceType: "category";
  provider: "SellerSprite";
  marketplace: "US";
  query: string;
  category: {
    nodeId: string; // Existing batch contract: this is the confirmed SellerSprite node ID.
    label: string;
    productCount: Estimate;
  };
  capturedAt: string;
  rowCount: number;
  amazonConfirmed: false;
  rows: Array<{
    segment: { value: string; authority: "provider_derived" };
    monthlyTotalSales: Estimate;
    averagePriceUsd: Estimate;
    returnRatePercent: Estimate;
    warnings: string[];
  }>;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

/**
 * CDP 前置禁用判定（纯函数）：服务端只读预检明确不可达时才提前禁用；
 * 预检失败/未返回（null/undefined）保持 fail-open，不改变既有按钮条件。
 */
export function shouldDisableSellerSpriteCapture(input: {
  canCapture: boolean;
  cdpReachable?: boolean | null;
}): boolean {
  return !input.canCapture || input.cdpReachable === false;
}

export function SellerSpriteCategoryMarketCapturePanel() {
  const [localQuery, setLocalQuery] = useState("");
  const [showAllRows, setShowAllRows] = useState(false);
  const browseRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const spotlight = useSpotlight<HTMLDivElement>();
  const searchResults = useMemo(() => searchLocalCategories(localQuery), [localQuery]);
  const [selectedCategoryPath, setSelectedCategoryPath] = useState<string[]>([]);
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [nodes, setNodes] = useState<SellerSpriteCategoryNode[]>([]);
  const [selectedSellerSpriteNodeId, setSelectedSellerSpriteNodeId] = useState("");
  const [searching, setSearching] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [batch, setBatch] = useState<CategoryMarketBatch | null>(null);
  const [batchRestored, setBatchRestored] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [cdpReachable, setCdpReachable] = useState<boolean | null>(null);
  const [cdpNextAction, setCdpNextAction] = useState("");

  const selectedCategories = selectedCategoryPath
    .map((amazonNodeId) => findAmazonCategoryByAmazonNodeId(amazonNodeId))
    .filter((category): category is AmazonCategoryNode => category !== null);
  const selectedCategory = selectedCategories.at(-1) ?? null;
  const selectedSellerSpriteNode = nodes.find((node) => node.id === selectedSellerSpriteNodeId) ?? null;

  const amazonPathEn = selectedCategories.map((category) => category.en);
  function evaluateMatch(node: SellerSpriteCategoryNode): SellerSpriteCandidateMatch | null {
    if (!selectedCategory || selectedCategories.length === 0) return null;
    return matchSellerSpriteCandidate({
      amazon: { amazonNodeId: selectedCategory.amazonNodeId, amazonPathEn },
      candidate: { id: node.id, label: node.label },
    });
  }

  const selectedMatch = selectedSellerSpriteNode ? evaluateMatch(selectedSellerSpriteNode) : null;
  const matchBlocked = Boolean(selectedMatch && (!isTrustedSellerSpriteMatch(selectedMatch) || selectedMatch.conflicting));
  const canCapture = Boolean(
    selectedSellerSpriteNode
    && activeSearchQuery
    && selectedMatch
    && isTrustedSellerSpriteMatch(selectedMatch)
    && !matchBlocked
    && !searching
    && !capturing
    && !restoring,
  );
  const cdpBlocked = canCapture && cdpReachable === false;
  const captureDisabled = shouldDisableSellerSpriteCapture({ canCapture, cdpReachable });

  // 挂载时只读预检一次 CDP 可达性：不可达则提前禁用采集；超时/失败静默 fail-open。
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1500);
    void (async () => {
      try {
        const response = await fetch("/api/source-layer/capture-environment", {
          headers: buildAccessHeaders(),
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as ApiEnvelope<{ cdpReachable?: boolean; nextAction?: string }>;
        if (!active || !response.ok || !payload.ok || typeof payload.data?.cdpReachable !== "boolean") return;
        setCdpReachable(payload.data.cdpReachable);
        if (typeof payload.data.nextAction === "string") setCdpNextAction(payload.data.nextAction);
      } catch {
        // 预检失败不禁用按钮（fail-open），既有错误展示保持不变。
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function restoreLatestBatch() {
      try {
        const response = await fetch("/api/source-layer/category-market/latest", {
          headers: buildAccessHeaders(),
          cache: "no-store",
        });
        const payload = await response.json() as ApiEnvelope<{ subjectKey: string; batch: CategoryMarketBatch } | null>;
        if (!active) return;
        if (!response.ok || !payload.ok) {
          setError({
            code: payload.error?.code || "CATEGORY_CAPTURE_RESTORE_FAILED",
            message: payload.error?.message || "无法读取上次类目市场结果；现有来源证据未被修改。",
          });
          return;
        }
        const restoredBatch = payload.data?.batch;
        if (!restoredBatch) return;

        setBatch(restoredBatch);
        setBatchRestored(true);
        setActiveSearchQuery(restoredBatch.query);
        setNodes([{
          id: restoredBatch.category.nodeId,
          label: restoredBatch.category.label,
          products: restoredBatch.category.productCount.value,
        }]);
        setSelectedSellerSpriteNodeId(restoredBatch.category.nodeId);
      } catch {
        if (active) {
          setError({
            code: "CATEGORY_CAPTURE_RESTORE_NETWORK_ERROR",
            message: "连接工作台失败，无法恢复上次类目市场结果；可以稍后刷新重试。",
          });
        }
      } finally {
        if (active) setRestoring(false);
      }
    }

    void restoreLatestBatch();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (batch && !batchRestored) resultRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [batch, batchRestored]);

  function resetSelectionState() {
    setShowAllRows(false);
    setActiveSearchQuery("");
    setNodes([]);
    setSelectedSellerSpriteNodeId("");
    setError(null);
    setBatch(null);
    setBatchRestored(false);
  }

  function selectCategoryAtLevel(level: number, amazonNodeId: string) {
    const nextPath = selectedCategoryPath.slice(0, level);
    if (amazonNodeId) nextPath.push(amazonNodeId);
    setSelectedCategoryPath(nextPath);
    resetSelectionState();
    requestAnimationFrame(() => browseRef.current?.focus());
  }

  async function findCategories() {
    if (!selectedCategory || inFlight.current) return;
    inFlight.current = true;
    const query = buildSellerSpriteCategoryLookupQuery(amazonPathEn);
    setSearching(true);
    setError(null);
    setNodes([]);
    setSelectedSellerSpriteNodeId("");
    setActiveSearchQuery(query);
    setBatch(null);
    setBatchRestored(false);
    try {
      const response = await fetch("/api/source-layer/collect/sellersprite-category-nodes", {
        method: "POST",
        headers: { ...buildAccessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const payload = await response.json() as ApiEnvelope<{ nodes: SellerSpriteCategoryNode[] }>;
      if (!response.ok || !payload.ok || !payload.data) {
        setError({
          code: payload.error?.code || "CATEGORY_SUGGESTIONS_FAILED",
          message: payload.error?.message || "SellerSprite 没有返回类目建议，请确认登录状态后重试。",
        });
        return;
      }
      setNodes(payload.data.nodes);
      if (payload.data.nodes.length === 0) {
        setError({ code: "CATEGORY_NOT_FOUND", message: "没有找到匹配类目，请更换所选类目后重试。" });
      }
    } catch {
      setError({ code: "CATEGORY_SUGGESTIONS_NETWORK_ERROR", message: "工作台连接失败，类目建议尚未加载。请检查本机服务后重试。" });
    } finally {
      inFlight.current = false;
      setSearching(false);
    }
  }

  async function captureCategory() {
    if (!selectedSellerSpriteNodeId || !activeSearchQuery || !selectedCategory || captureDisabled || inFlight.current) return;
    inFlight.current = true;
    setCapturing(true);
    setError(null);
    setBatch(null);
    setBatchRestored(false);
    try {
      const response = await fetch("/api/source-layer/collect/sellersprite-category-market", {
        method: "POST",
        headers: { ...buildAccessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          query: activeSearchQuery,
          categoryId: selectedSellerSpriteNodeId,
          amazonNodeId: selectedCategory.amazonNodeId,
          amazonPathEn,
        }),
      });
      const payload = await response.json() as ApiEnvelope<{ batch: CategoryMarketBatch }>;
      if (!response.ok || !payload.ok || !payload.data?.batch) {
        setError({
          code: payload.error?.code || "CATEGORY_CAPTURE_FAILED",
          message: payload.error?.message || "类目市场采集未完成，请检查 SellerSprite 页面状态后重试。",
        });
        return;
      }
      setShowAllRows(false);
      setBatch(payload.data.batch);
    } catch {
      setError({ code: "CATEGORY_CAPTURE_NETWORK_ERROR", message: "工作台连接失败，采集结果尚未确认。请检查本机服务后重试。" });
    } finally {
      inFlight.current = false;
      setCapturing(false);
    }
  }

  function selectSellerSpriteNode(node: SellerSpriteCategoryNode) {
    setSelectedSellerSpriteNodeId(node.id);
    setError(null);
    setBatch(null);
    setBatchRestored(false);
  }

  // 任意深度级联：每一级来自当前 category.children，不限制字典已有深度。
  const confirmed = Boolean(selectedCategory && selectedMatch && isTrustedSellerSpriteMatch(selectedMatch) && !matchBlocked);
  const browseOptions = selectedCategory ? selectedCategory.children : AMAZON_CATEGORY_DICTIONARY;
  const busy = searching || capturing || restoring;
  const quality = batch ? summarizeCategoryMarketRows(batch.rows) : null;
  const resultTone = quality?.empty ? "empty" : quality?.partial ? "partial" : "success";
  const humanRequired = Boolean(error && /LOGIN|CAPTCHA|HUMAN|SESSION|AUTH|VERIFICATION/i.test(error.code));
  const nextMessage = capturing ? "正在等待 SellerSprite 返回市场指标"
    : searching ? "正在查找对应类目，尚未开始采集指标"
    : cdpReachable === false ? "专用浏览器尚不可连接，暂时不能采集"
    : matchBlocked ? "请重新选择可信的对应类目"
    : canCapture ? "已确认对应类目，采集时仍会检查登录与来源权限"
    : selectedCategory ? "查找并点击确认一个 SellerSprite 对应类目" : "先选择你想了解的 Amazon 市场类目";

  // 公开仓库不带任何第三方类目数据：未导入时给明确空状态与导入指引，不渲染会崩溃的树。
  if (!AMAZON_TAXONOMY_IMPORTED) {
    return (
      <section className={styles.workspace} data-category-workspace="true" data-testid="category-market-workspace" aria-labelledby="category-market-capture-title">
        <header className={styles.hero}>
          <div className={styles.eyebrow}><span><FolderTree size={16} />类目市场采集</span><span><Globe2 size={14} />美国站</span></div>
          <h2 id="category-market-capture-title">先导入类目字典，再开始类目市场采集。</h2>
          <p>公开版本不附带任何 Amazon / SellerSprite 类目数据。</p>
        </header>
        <div className={styles.main}>
          <div className={styles.browser} data-testid="category-taxonomy-empty">
            <div className={styles.sectionTitle}><span className={styles.sourceMark}>!</span><div><h3>尚未导入类目字典</h3><p>TAXONOMY_STATUS = {AMAZON_CATEGORY_TAXONOMY_META.taxonomyStatus}</p></div></div>
            <p>请使用你自己合法取得的 Amazon 类目树运行生成脚本；生成结果只保存在本地，请勿把第三方数据提交到公开仓库。</p>
            <ol>
              <li><code>node scripts/taxonomy/generate-amazon-us-category-tree.mjs</code>：把本地采集/导出的原始类目树生成 <code>data/amazon-taxonomy/amazon-us-taxonomy.v1.json</code> 与 <code>zh-presentation.v1.json</code>。</li>
              <li>重新启动开发服务或重新构建，让页面读到新数据。</li>
              <li>没有类目数据时，02 市场研究仍可查看已有样本与证据，只是无法新选类目。</li>
            </ol>
            <p>如果你只需要按商品 ASIN 研究，可不导入类目数据，直接使用采集与商品研究入口。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.workspace} data-category-workspace="true" data-testid="category-market-workspace" aria-labelledby="category-market-capture-title">
      <header className={styles.hero}>
        <div className={styles.eyebrow}><span><FolderTree size={16} />类目市场采集</span><span><Globe2 size={14} />美国站</span></div>
        <h2 id="category-market-capture-title">选对类目，看清市场。</h2>
        <p>选择 Amazon 类目，确认对应来源，再取得 SellerSprite 市场指标。</p>
        <div className={styles.flow} aria-label="当前采集上下文">
          <span data-done={Boolean(selectedCategory)}><i>{selectedCategory ? <Check size={12} /> : "1"}</i>选择类目</span>
          <span className={styles.flowLine} aria-hidden="true" />
          <span data-done={confirmed}><i>{confirmed ? <Check size={12} /> : "2"}</i>确认对应</span>
          <span className={styles.flowLine} aria-hidden="true" />
          <span data-done={Boolean(batch && quality && !quality.empty)}><i>{batch && quality && !quality.empty ? <Check size={12} /> : "3"}</i>查看指标</span>
        </div>
      </header>

      <div className={styles.main}>
        <div className={styles.browser}>
          <div className={styles.sectionTitle}><span className={styles.sourceMark}>a</span><div><h3>Amazon 类目选择</h3><p>逐级浏览，或搜索本地类目</p></div></div>
          <div className={styles.searchBox}><Search size={18} /><input type="search" value={localQuery} disabled={busy} onChange={e => setLocalQuery(e.target.value)} placeholder="搜索中文、英文或节点 ID" aria-label="搜索本地 Amazon 类目" data-testid="category-local-search" /><kbd>本地</kbd></div>
          <nav className={styles.breadcrumb} aria-label="已选择的类目路径" data-testid="selected-amazon-category-path">
            <button type="button" disabled={busy} onClick={() => {setSelectedCategoryPath([]);resetSelectionState();setLocalQuery("");}}>全部类目</button>
            {selectedCategories.map((category, index) => <span key={category.amazonNodeId}><ChevronRight size={12} /><button type="button" aria-current={index === selectedCategories.length - 1 ? "location" : undefined} disabled={busy} onClick={() => selectCategoryAtLevel(index, category.amazonNodeId)}>{category.zh}</button></span>)}
          </nav>
          <div className={styles.listHeading}><span>{localQuery.trim() ? `找到 ${searchResults.length}${searchResults.length === 60 ? "+" : ""} 个类目` : selectedCategory ? `${selectedCategory.zh} · 下级类目` : `${AMAZON_CATEGORY_DICTIONARY.length} 个一级类目`}</span>{selectedCategory && !localQuery.trim() && <button type="button" disabled={busy} onClick={() => selectCategoryAtLevel(selectedCategoryPath.length - 1, "")}><ArrowLeft size={13} />上一级</button>}</div>
          <div ref={browseRef} tabIndex={-1} onKeyDown={event => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? Math.min(current + 1, buttons.length - 1) : Math.max(current - 1, 0);
            buttons[next]?.focus();
          }} className={styles.categoryList} aria-label="可选择的 Amazon 类目" data-testid="category-browser-list" key={localQuery.trim() ? "search" : selectedCategory?.amazonNodeId ?? "root"}>
            {localQuery.trim() ? searchResults.map(({node, path}) => <button className={styles.categoryRow} type="button" key={node.amazonNodeId} disabled={busy} onClick={() => {setSelectedCategoryPath(path);resetSelectionState();setLocalQuery("");}} data-testid={`category-search-node-${node.amazonNodeId}`}><span><b>{node.zh}</b><small>{findAmazonCategoryPathByAmazonNodeId(node.amazonNodeId).map(item => item.en).join(" › ")}</small></span><ChevronRight size={16} /></button>)
              : browseOptions.map(category => <button className={styles.categoryRow} type="button" key={category.amazonNodeId} disabled={busy} onClick={() => selectCategoryAtLevel(selectedCategoryPath.length, category.amazonNodeId)} data-testid={`category-browse-node-${category.amazonNodeId}`}><span><b>{category.zh}</b><small>{category.en}</small></span>{category.children.length > 0 ? <ChevronRight size={16} /> : <span className={styles.leaf}>选择</span>}</button>)}
            {localQuery.trim() && searchResults.length === 0 && <div className={styles.listEmpty}><Search size={25} /><b>没有找到本地类目</b><p>试试英文名称、较短的关键词或节点 ID。</p></div>}
            {!localQuery.trim() && browseOptions.length === 0 && <div className={styles.listEmpty}><CheckCircle2 size={27} /><b>已选择 {selectedCategory?.zh}</b><p>当前快照未提供更深子类目，可继续查找对应来源。</p></div>}
          </div>
          <p className={styles.snapshotNote}>本地多来源快照，尚未核实为 Amazon 官方完整类目树。</p>
        </div>

        <div className={styles.matchArea}>
          <div className={styles.sectionTitle}><span className={styles.sourceMark}><Layers3 size={18} /></span><div><h3>确认 SellerSprite 类目节点</h3><p>两个来源独立编号，请核对是否对应</p></div></div>
          <div className={styles.mapping} ref={spotlight.ref} onPointerMove={spotlight.onPointerMove} data-confirmed={confirmed}>
            <div className={styles.mappingSource}><small>你选择的 Amazon 类目</small><strong>{selectedCategories.length ? selectedCategories.map(category => category.zh).join(" › ") : "尚未选择类目"}</strong><span>{amazonPathEn.length ? amazonPathEn.join(" › ") : "从左侧开始，找到你想了解的市场"}</span></div>
            <div className={styles.connector} data-active={searching || capturing} aria-hidden="true"><span /><ArrowRight size={18} /><span /></div>
            <div className={styles.mappingSource}><small>对应 SellerSprite 类目</small><strong>{selectedSellerSpriteNode && selectedCategory ? presentSellerSpriteCategoryLabel(selectedSellerSpriteNode.label).zhPath : "等待你确认"}</strong><span>{selectedSellerSpriteNode && selectedCategory ? presentSellerSpriteCategoryLabel(selectedSellerSpriteNode.label).enPath : "不会自动选择第一条候选"}</span></div>
          </div>
          <button type="button" onClick={() => void findCategories()} disabled={!selectedCategory || busy} className={styles.findButton} data-testid="category-market-find-button">{searching ? <Loader2 size={16} className={styles.spin} /> : <Search size={16} />}{searching ? "正在查找 SellerSprite 类目…" : "查找对应的 SellerSprite 类目"}{!searching && <ArrowRight size={16} />}</button>
          {nodes.length > 0 && selectedCategory ? <div className={styles.candidates}>
            <p className={styles.candidateHint} data-testid="category-market-bilingual-format">{nodes.length} 个候选 · 点击卡片，确认中文路径与英文原路径</p>
            <div className={styles.candidateList}>
              {nodes.map((node, index) => {const presentation = presentSellerSpriteCategoryLabel(node.label);const match = evaluateMatch(node);const badge = match ? sellerSpriteMatchBadge(match) : null;return <button key={node.id} type="button" onClick={() => selectSellerSpriteNode(node)} disabled={busy} aria-pressed={selectedSellerSpriteNodeId === node.id} title={node.label} data-testid={`category-market-node-${node.id}`} data-match-type={match?.matchType ?? "UNCONFIRMED"} data-candidate-index={index} className={styles.candidate}>
                <span className={styles.radio}>{selectedSellerSpriteNodeId === node.id && <Check size={12} />}</span><span className={styles.candidateBody}><span className={styles.candidateTop}><b data-testid={`category-market-node-zh-${node.id}`}>{presentation.zhPath}</b>{badge && <em data-testid={`category-market-node-badge-${node.id}`}>{badge}</em>}{match?.conflicting && <em data-conflict="true" data-testid={`category-market-node-conflict-${node.id}`}>不匹配</em>}</span><span data-testid={`category-market-node-en-${node.id}`}>{presentation.enPath}</span><small>{node.products === null ? "商品数未提供" : `${formatCount(node.products)} 件商品（来源提供）`}</small>{presentation.untranslatedSegments.length > 0 && <small className={styles.warningText} data-testid={`category-market-node-untranslated-${node.id}`}>部分名称暂无中文译名：{presentation.untranslatedSegments.join(" / ")}</small>}</span>
              </button>})}
            </div>
          </div> : <div className={styles.matchEmpty}><FolderTree size={25} /><b>{searching ? "正在向来源查找候选" : selectedCategory ? "准备好了，查找对应类目" : "让两个来源准确对应"}</b><p>{searching ? "候选返回后仍需你明确确认。" : "选择 Amazon 类目后，在这里比较并确认来源节点。"}</p></div>}
        </div>
      </div>

      <div className={styles.actionArea}>
        {error && <div role="alert" className={styles.error} data-tone={humanRequired ? "human" : "error"} data-testid="category-market-error"><AlertCircle size={19} /><div><b>{humanRequired ? "需要人工处理" : "本次操作未完成"}</b><p>{error.message}</p><details><summary>错误详情</summary><code>{error.code}</code></details></div></div>}
        <div className={styles.actionRow}>
          <div className={styles.availability} role="status" data-testid="category-market-availability"><span className={styles.statusDot} data-ready={canCapture && cdpReachable !== false} /><div><b>{nextMessage}</b><p>{restoring ? "正在从来源证据恢复最近一次类目市场批次…" : capturing ? "返回后展示实际取得的结果，不估计进度。" : cdpReachable === true ? "浏览器可连接 · 登录、账号权限与来源可用性由服务端复核" : cdpReachable === false ? "请打开专用浏览器并登录 SellerSprite 后重新打开此面板" : "浏览器连接尚未核实 · 提交时由服务端检查"}</p></div></div>
          <button type="button" onClick={() => void captureCategory()} disabled={captureDisabled} className={styles.captureButton} data-testid="category-market-capture-button" data-match-blocked={matchBlocked ? "true" : "false"} data-cdp-blocked={cdpBlocked ? "true" : "false"}>{capturing ? <Loader2 size={17} className={styles.spin} /> : <ArrowRight size={17} />}{capturing ? "正在采集类目市场…" : "采集类目市场"}</button>
        </div>
        {cdpReachable === false && <p className={styles.warningText} data-testid="category-market-cdp-blocked">SellerSprite CDP 不可达：先启动专用浏览器并登录{cdpNextAction ? ` · ${cdpNextAction}` : ""}</p>}
        {matchBlocked && selectedMatch && <p role="alert" className={styles.warningText} data-testid="category-market-match-blocked">{selectedMatch.conflicting ? "该 SellerSprite 节点与当前 Amazon 类目不匹配，已禁止采集。请重新选择。" : "没有可信的对应关系，已禁止采集。请检查路径并选择可信节点。"}</p>}
        <p className={styles.estimateNote}><ShieldCheck size={14} />SellerSprite 第三方估算 · 取得类目市场指标，不代表取得完整商品样本</p>
      </div>

      {batch && quality && <div ref={resultRef} role="status" className={styles.result} data-tone={resultTone} data-testid="category-market-result">
        <div className={styles.resultHeader}><div><span className={styles.resultLabel}>{batchRestored ? "最近一次结果 · 已从来源证据恢复上次类目市场批次" : quality.empty ? "本次返回" : "类目市场批次已保存到来源证据"}</span><h3>{quality.empty ? "尚未取得可用市场指标" : quality.partial ? "已取得部分市场指标" : "市场指标已取得"}</h3><p>{presentSellerSpriteCategoryLabel(batch.category.label || batch.query).zhPath}</p></div><span className={styles.resultCount}><b>{formatCount(batch.rows.length)}</b>条市场细分</span></div>
        <div className={styles.coverage}><span>已提供 {quality.available} / {quality.total} 项数值指标</span><span>缺失保持「未提供」</span><div><i style={{width: `${quality.total ? quality.available / quality.total * 100 : 0}%`}} /></div></div>
        <CategoryMarketQualityNotice rows={batch.rows} />
        <div className={styles.resultTable}><table><thead><tr><th>市场细分</th><th>月总销量<small>估算</small></th><th>平均价格<small>估算 · USD</small></th><th>退货率<small>估算</small></th></tr></thead><tbody>{batch.rows.slice(0, showAllRows ? undefined : 5).map((row, index) => <tr key={`${row.segment.value}-${index}`}><td>{row.segment.value || "未命名细分"}</td><td>{formatEstimate(row.monthlyTotalSales)}</td><td>{formatCurrencyEstimate(row.averagePriceUsd)}</td><td>{formatPercentEstimate(row.returnRatePercent)}</td></tr>)}</tbody></table></div>
        {batch.rows.length > 5 && <button className={styles.textButton} type="button" onClick={() => setShowAllRows(!showAllRows)}>{showAllRows ? "收起更多细分" : `查看全部 ${batch.rows.length} 条细分`}</button>}
        <p className={styles.resultMeta}>{new Date(batch.capturedAt).toLocaleString("zh-CN")} · SellerSprite 第三方估算，未标记为 Amazon 确认。{batchRestored ? "刷新后已恢复，无需重新搜索或采集。" : ""}</p>
        {quality.empty && <p className={styles.warningText}>请检查来源状态与字段覆盖；请求返回不等于已取得可用数据。</p>}
        <details className={styles.advanced}><summary>查看完整指标与来源记录</summary><p>含各行原始指标、来源警告及节点身份。市场细分不是商品样本。</p><pre>{JSON.stringify(batch, null, 2)}</pre></details>
      </div>}

      <details className={styles.sourceDetails} data-testid="category-source-details"><summary>类目来源与匹配详情<span>快照、节点身份及技术信息</span></summary><div data-testid="amazon-taxonomy-source"><p>本地多来源快照；未核实为 Amazon 官方完整类目树。TAXONOMY_STATUS = {AMAZON_CATEGORY_TAXONOMY_META.taxonomyStatus}</p><p>{AMAZON_CATEGORY_TAXONOMY_META.stats.rootCount} 个一级类目 · {AMAZON_CATEGORY_TAXONOMY_META.stats.totalNodeCount} 个节点 · 最大深度 {AMAZON_CATEGORY_TAXONOMY_META.stats.maxDepth} · 中文覆盖 {AMAZON_CATEGORY_TAXONOMY_META.stats.zhCoverageRate}%（已翻译 {AMAZON_CATEGORY_TAXONOMY_META.stats.translatedZhCount} / 待确认 {AMAZON_CATEGORY_TAXONOMY_META.stats.pendingZhCount}）</p><p>来源：{AMAZON_CATEGORY_TAXONOMY_META.source.kind} · 快照 {AMAZON_CATEGORY_TAXONOMY_META.source.harvestedAt}</p><p data-testid="amazon-taxonomy-official-diff">官方完整性核验：{AMAZON_CATEGORY_TAXONOMY_META.officialDiff?.status ?? "UNKNOWN"}</p><p>Amazon 类目节点 ID：{selectedCategory?.amazonNodeId}</p><p>Amazon 原始路径：{amazonPathEn.join(" > ") || "尚未选择"}</p><p>SellerSprite 查询词：{activeSearchQuery || "尚未查询"}</p>{selectedSellerSpriteNode && <p>SellerSprite ID：{selectedSellerSpriteNode.id} · 原始 label：{selectedSellerSpriteNode.label}</p>}{selectedMatch && <p data-testid="category-market-match-summary">{selectedMatch.matchType} · {selectedMatch.reason}</p>}<p data-testid="category-market-bilingual-format-detail">中文路径为本地辅助展示；English original path 和来源节点 ID 保留。无法翻译的片段保留原文。</p></div></details>
    </section>
  );
}

// Local-only search index; IDs and full paths always come from the existing dictionary.
const CATEGORY_INDEX: Array<{node: AmazonCategoryNode; path: string[]; text: string}> = [];
function indexCategories(nodes: AmazonCategoryNode[], path: string[] = [], labels: string[] = []) {
  for (const node of nodes) {
    const nextPath = [...path, node.amazonNodeId];
    const nextLabels = [...labels, node.zh, node.en];
    CATEGORY_INDEX.push({ node, path: nextPath, text: `${nextLabels.join(" ")} ${node.amazonNodeId}`.toLowerCase() });
    indexCategories(node.children, nextPath, nextLabels);
  }
}
indexCategories(AMAZON_CATEGORY_DICTIONARY);
export function searchLocalCategories(query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? CATEGORY_INDEX.filter(item => terms.every(term => item.text.includes(term))).slice(0, 60) : [];
}
export function summarizeCategoryMarketRows(rows: CategoryMarketBatch["rows"]) {
  let available = 0, total = 0;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value && typeof value === "object" && "nature" in value && value.nature === "provider_estimate" && "value" in value) {
        total += 1;
        if (typeof value.value === "number" && Number.isFinite(value.value)) available += 1;
      }
    }
  }
  return {available, total, empty: available === 0, partial: available > 0 && available < total};
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatEstimate(value: Estimate): string {
  return value.value === null ? "未提供" : formatCount(value.value);
}

function formatCurrencyEstimate(value: Estimate): string {
  return value.value === null ? "未提供" : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value.value);
}

function formatPercentEstimate(value: Estimate): string {
  return value.value === null ? "未提供" : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value.value)}%`;
}
