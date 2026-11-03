"use client";

/**
 * 探索台（Research Cockpit）。
 * 布局：Magic UI Bento Grid 的不对称网格 + 悬停反馈；
 * 图表：shadcn/ui Charts 的容器与提示卡结构（recharts 实现）；
 * 数字：Magic UI Number Ticker 的计数语义。
 * 所有数值来自已保存的 scan / intelligence，只读展示，不写回任何正式数据。
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, Compass, ImageOff, ShieldCheck } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { useHifi } from "../HifiProvider";
import { effectiveGate } from "../researchPresentation";
import { GATE_LABEL, type Sample, type Screen } from "../data";
import {
  buildActions,
  buildEvidenceModel,
  buildInsightModel,
  buildPriceStructure,
  type CockpitAction,
  type InsightItem,
  type PriceBandView,
} from "./cockpitModel";
import { EvidenceCoverageCard, type EvidenceDrawerKind } from "./EvidenceCoverageCard";
import { InsightCard } from "./InsightCard";
import { NextActionsCard } from "./NextActionsCard";
import { PriceStructureCard } from "./PriceStructureCard";
import { RecentResearchCard } from "./RecentResearchCard";
import { setCompetitionBandHandoff } from "./competitionHandoff";
import styles from "./cockpit.module.css";

type CockpitProps = {
  onNav: (screen: Screen) => void;
  onToast: (message: string) => void;
  onOpenSample: (sample: Sample) => void;
};

type DrawerState =
  | { kind: "conflicts" }
  | { kind: "missing" }
  | { kind: "coverage" }
  | { kind: "limits" }
  | { kind: "insight"; item: InsightItem; tab: "opportunity" | "risk" | "action" };

function shortTime(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function money(value: number | null | undefined): string {
  return value == null ? "未知" : `$${value.toFixed(2)}`;
}

export function ResearchCockpit({ onNav, onToast, onOpenSample }: CockpitProps) {
  const live = useHifi();
  const { scan, intelligence: data, recent } = live.researchData;
  const [activeBandId, setActiveBandId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const gate = effectiveGate(scan);
  const gateStale = Boolean(scan?.marketGate?.stale || scan?.marketWorkflow?.stale);
  const structure = useMemo(() => buildPriceStructure(scan), [scan]);
  const evidence = useMemo(() => buildEvidenceModel(scan, data), [scan, data]);
  const insight = useMemo(() => buildInsightModel(data), [data]);
  const actions = useMemo(
    () => buildActions({ scan, evidence, insight, gateStale, gateStatus: gate }),
    [scan, evidence, insight, gateStale, gate],
  );

  const representative = useMemo(() => {
    if (!scan) return null;
    const preferred = scan.representatives?.items?.[0]?.asin;
    return scan.sampleItems.find((item) => item.asin === preferred && item.imageUrl)
      ?? scan.sampleItems.find((item) => item.imageUrl)
      ?? scan.sampleItems[0]
      ?? null;
  }, [scan]);

  const activeBand = structure.bands.find((band) => band.id === activeBandId) ?? null;
  const matched = useMemo(() => {
    if (!scan || !activeBand) return [];
    const byAsin = new Map(scan.sampleItems.map((item) => [item.asin, item]));
    return activeBand.asins
      .slice(0, 6)
      .map((asin) => byAsin.get(asin))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({ asin: item.asin, title: item.title, imageUrl: item.imageUrl, price: item.price }));
  }, [scan, activeBand]);

  const coverageRows = useMemo(() => {
    if (!scan) return [];
    const counts = new Map<string, number>();
    for (const review of data?.reviews ?? []) {
      const keys = review.subjectKeys?.length ? review.subjectKeys : [review.subjectKey];
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return scan.sampleItems.map((item) => ({
      asin: item.asin,
      subjectKey: item.subjectKey,
      title: item.title,
      reviews: counts.get(item.subjectKey) ?? 0,
    }));
  }, [scan, data]);

  const researchQuestion = scan?.marketWorkflow?.metadata?.researchQuestion?.trim() || "";
  const missingLabels = evidence.missing.map((item) => item.label);

  const openSampleByAsin = (asin: string) => {
    const sample = live.samples.find((item) => item.asin === asin);
    if (!sample) {
      onToast(`${asin} 不在当前样本视图中，无法打开来源卡。`);
      return;
    }
    onOpenSample(sample);
  };

  const openSubject = (subjectKey: string) => {
    const asin = subjectKey.split(":").at(-1) ?? "";
    openSampleByAsin(asin);
  };

  const runAction = (action: CockpitAction) => {
    if (action.target.kind === "screen") {
      onNav(action.target.screen);
      return;
    }
    if (action.target.kind === "href") {
      window.location.assign(action.target.href);
      return;
    }
    if (action.target.kind === "drawer") {
      setDrawer({ kind: action.target.drawer });
    }
  };

  const enterCompetition = (band: PriceBandView) => {
    if (!band.filterLabel) {
      onToast("该价格带没有可传递的闭区间，未进入 02。");
      return;
    }
    setCompetitionBandHandoff({
      label: band.filterLabel,
      min: band.min,
      max: band.max ?? (band.observedMax ?? band.min),
      count: band.count,
    });
    onNav("competition");
  };

  if (live.loading && !scan) {
    return (
      <div className={styles.cockpit}>
        <div className={styles.skeletonHead} />
        <div className={styles.skeletonGrid}>
          <div className={styles.skeletonHero} />
          <div className={styles.skeletonSide} />
          <div className={styles.skeletonSide} />
        </div>
        <p className={styles.loadingNote} role="status">正在读取当前研究与已保存证据…</p>
      </div>
    );
  }

  if (!scan) {
    return (
      <div className={styles.cockpit}>
        <div className={styles.emptyBlock} role="status">
          <strong>{live.error ? "研究读取失败" : "当前还没有可展示的研究"}</strong>
          <p>{live.error || "尚未找到可打开的市场研究；请先在 01 市场采集完成一次样本锁定。"}</p>
          <button type="button" className={styles.inlineCta} onClick={() => onNav("overview")}>
            进入 02 市场研究
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cockpit}>
      <header className={styles.cockpitHead}>
        <div>
          <p className={styles.kicker}>研究驾驶舱</p>
          <h1 className={styles.pageTitle}>今天值得推进的研究</h1>
          <p className={styles.pageSub}>先核对研究对象与证据强度，再决定下一步做什么。</p>
        </div>
        <div className={styles.headActions}>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => onNav("overview")}
          >
            <Compass size={14} aria-hidden="true" />
            研究总览
          </button>
          <button type="button" className={styles.primaryButton} onClick={() => onNav("gate")}>
            <ShieldCheck size={14} aria-hidden="true" />
            处理市场闸门
          </button>
        </div>
      </header>

      <div className={styles.bento}>
        <section className={`${styles.card} ${styles.hero}`} aria-labelledby="ck-hero-title">
          <div className={styles.heroTop}>
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>当前研究</p>
              <h2 id="ck-hero-title" className={styles.heroTitle}>{scan.scanName}</h2>
              <div className={styles.heroChips}>
                <span className={styles.pill}>{scan.marketplace} 市场</span>
                <span className={styles.pill}>{scan.sampleCount} 件锁定样本</span>
                <span className={styles.pill} data-tone={gateStale || gate === "PENDING" ? "warn" : "ok"}>
                  {gateStale ? "来源变化 · 判断已失效" : GATE_LABEL[gate]}
                </span>
              </div>
              <div className={styles.heroQuestion} data-empty={researchQuestion ? undefined : "true"}>
                <span>本轮研究问题</span>
                <p>{researchQuestion || "研究问题尚未保存。先核对样本可比性、评论来源与缺失属性，再作人工判断。"}</p>
                <button type="button" className={styles.questionLink} onClick={() => onNav("gate")}>
                  查看研究范围与人工门禁
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              </div>
            </div>

            <figure className={styles.heroMedia}>
              <div className={styles.heroImageFrame}>
                {representative?.imageUrl ? (
                  <img
                    src={representative.imageUrl}
                    alt={`${representative.title ?? representative.asin} 研究样本主图`}
                    loading="eager"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className={styles.heroImageEmpty}><ImageOff size={20} aria-hidden="true" />暂无可信代表图</span>
                )}
              </div>
              <figcaption>
                <strong>研究样本 · 非推荐结论</strong>
                <span>{representative?.asin ?? "样本待补齐"}{representative?.price != null ? ` · ${money(representative.price)}` : ""}</span>
              </figcaption>
            </figure>
          </div>

          <div className={styles.heroFoot}>
            <button
              type="button"
              className={styles.heroNext}
              onClick={() => {
                const primary = actions[0];
                if (primary) runAction(primary);
              }}
              disabled={!actions[0]}
            >
              <span>下一步</span>
              <strong>{actions[0]?.title ?? "核对证据后记录人工判断"}</strong>
              <small>{actions[0]?.detail ?? "当前没有派生出的待办，可按证据自行复核。"}</small>
            </button>
            <div className={styles.heroLimits}>
              <span>当前证据限制</span>
              <div>
                {missingLabels.length
                  ? missingLabels.map((label) => (
                      <button key={label} type="button" className={styles.limitChip} onClick={() => setDrawer({ kind: "missing" })}>
                        <AlertTriangle size={11} aria-hidden="true" />
                        {label}
                      </button>
                    ))
                  : <em>未读取到缺口清单，不能据此认定数据完整。</em>}
              </div>
            </div>
          </div>

          <div className={styles.heroActions}>
            <button type="button" className={styles.primaryButton} onClick={() => onNav("compare")}>核对商品差异</button>
            <button type="button" className={styles.ghostButton} onClick={() => onNav("voc")}>查看评论依据</button>
            <button type="button" className={styles.linkButton} onClick={() => setDrawer({ kind: "limits" })}>
              证据口径与限制
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          </div>
        </section>

        <div className={styles.evidenceSlot}>
          <EvidenceCoverageCard evidence={evidence} onOpen={(kind: EvidenceDrawerKind) => setDrawer({ kind })} />
        </div>

        <div className={styles.priceSlot}>
          <PriceStructureCard
            structure={structure}
            activeBandId={activeBandId}
            matched={matched}
            onSelectBand={(id) => setActiveBandId(id)}
            onClearBand={() => setActiveBandId(null)}
            onOpenSample={openSampleByAsin}
            onEnterCompetition={enterCompetition}
          />
        </div>

        <div className={styles.insightSlot}>
          <InsightCard
            insight={insight}
            onOpenEvidence={(item, tab) => setDrawer({ kind: "insight", item, tab })}
            onOpenSubject={openSubject}
            onNav={(screen) => onNav(screen)}
          />
        </div>

        <div className={styles.recentSlot}>
          <RecentResearchCard recent={recent} currentId={scan.id} />
        </div>

        <div className={styles.actionsSlot}>
          <NextActionsCard actions={actions} onAction={runAction} />
        </div>
      </div>

      <Drawer
        isOpen={drawer != null}
        onClose={() => setDrawer(null)}
        title={
          drawer?.kind === "conflicts" ? "评价数来源冲突"
            : drawer?.kind === "missing" ? "证据缺口与人工确认"
              : drawer?.kind === "coverage" ? "评论证据覆盖明细"
                : drawer?.kind === "limits" ? "证据口径与限制"
                  : drawer?.kind === "insight" ? drawer.item.title
                    : ""
        }
        description={
          drawer?.kind === "conflicts" ? "搜索页与商品页读数并列保留，不择一覆盖。"
            : drawer?.kind === "missing" ? "缺失项需要人工确认，不能由页面自动补齐。"
              : drawer?.kind === "coverage" ? "读取条数不是商品累计评价数。"
                : drawer?.kind === "limits" ? "来自已保存证据与研究限制说明。"
                  : drawer?.kind === "insight" ? "AI 提议与来源引用，需人工复核。" : undefined
        }
        width={drawer?.kind === "conflicts" || drawer?.kind === "coverage" ? "xl" : "lg"}
      >
        {drawer?.kind === "conflicts" ? (
          evidence.conflicts.length ? (
            <div className={styles.drawerBody}>
              <p className={styles.drawerNote}>
                共 {evidence.conflictCount} 件冲突；锁定值来自搜索页，商品页读数另存。冲突值不进入分布统计，也不能据此判断竞争强度或新旧。
              </p>
              <table className={styles.drawerTable}>
                <thead>
                  <tr><th>ASIN</th><th>锁定值</th><th>商品页读数</th><th>抓取时间</th></tr>
                </thead>
                <tbody>
                  {evidence.conflicts.map((conflict) => (
                    <tr key={conflict.asin}>
                      <td>{conflict.asin}</td>
                      <td>{conflict.lockedValue ?? "未知"}{conflict.lockedSurface ? <small>{conflict.lockedSurface}</small> : null}</td>
                      <td>{conflict.productPageValue ?? "未知"}</td>
                      <td><small>{shortTime(conflict.lockedCapturedAt)}<br />{shortTime(conflict.productPageCapturedAt)}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={styles.drawerNote}>解决路径：回到 02 商品对比或来源卡逐件核对；页面不自动消除冲突。</p>
              <button
                type="button"
                className={styles.inlineCta}
                onClick={() => { setDrawer(null); onNav("compare"); }}
              >
                进入 02 商品对比逐件核对
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>
          ) : <p className={styles.drawerNote}>当前统计中没有冲突记录；这不等于所有读数都已复核。</p>
        ) : null}

        {drawer?.kind === "missing" ? (
          <div className={styles.drawerBody}>
            {evidence.blockedReasons.length ? (
              <div className={styles.drawerBlock} data-tone="risk">
                <strong>硬阻塞</strong>
                {evidence.blockedReasons.map((item) => <p key={item.code}>{item.label}：{item.detail}</p>)}
              </div>
            ) : null}
            {evidence.missing.length ? evidence.missing.map((item) => (
              <div key={item.code} className={styles.drawerBlock}>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
            )) : <p className={styles.drawerNote}>未读取到缺口清单，不能据此认定数据完整。</p>}
            <p className={styles.drawerNote}>这些缺口需要在市场闸门中显式确认，页面不会自动勾选。</p>
          </div>
        ) : null}

        {drawer?.kind === "coverage" ? (
          <div className={styles.drawerBody}>
            <p className={styles.drawerNote}>
              已读取 {evidence.reviewsRead ?? "未知"} 条原声，覆盖 {evidence.asinCovered ?? "未知"} / {evidence.sampleCount} 个 ASIN。
              读取数量不是累计评价量；未覆盖样本不能凭星级判断体验。
            </p>
            <table className={styles.drawerTable}>
              <thead><tr><th>ASIN</th><th>已读评论</th><th>样本标题</th></tr></thead>
              <tbody>
                {coverageRows.map((row) => (
                  <tr key={row.asin} data-empty={row.reviews === 0 ? "true" : undefined}>
                    <td>{row.asin}</td>
                    <td>{row.reviews || "0"}</td>
                    <td><small>{row.title ?? "标题缺失"}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.drawerNote}>低星优先、非随机抽样；不能把这里的条数当作全市场抱怨比例。</p>
            <button
              type="button"
              className={styles.inlineCta}
              onClick={() => { setDrawer(null); onNav("voc"); }}
            >
              进入 02 买家声音核对原声
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {drawer?.kind === "limits" ? (
          <div className={styles.drawerBody}>
            <div className={styles.drawerBlock}>
              <strong>证据权威</strong>
              <p>EvidenceStore 为唯一原始证据权威；本页只消费已保存样本与证据，不新建采集通道。</p>
            </div>
            <div className={styles.drawerBlock}>
              <strong>口径边界</strong>
              <p>商品累计评价数 ≠ 本次读取评论条数 ≠ 销量；第三方估算不得冒充 Amazon 确认事实。</p>
            </div>
            {(data?.limitations ?? []).map((item) => (
              <div key={item} className={styles.drawerBlock}><p>{item}</p></div>
            ))}
            <p className={styles.drawerNote}>
              样本哈希 {scan.sampleHash.slice(0, 16)}… · 版本 {scan.resourceVersion}
            </p>
          </div>
        ) : null}

        {drawer?.kind === "insight" ? (
          <div className={styles.drawerBody}>
            <div className={styles.drawerBlock} data-tone={insight.status === "stale" ? "warn" : undefined}>
              <strong>{insight.statusLabel}</strong>
              <p>{insight.statusDetail}</p>
            </div>
            {insight.judgment ? (
              <>
                <div className={styles.drawerBlock}><strong>可判断</strong><p>{insight.judgment.canJudge}</p></div>
                <div className={styles.drawerBlock}><strong>不可判断</strong><p>{insight.judgment.cannotJudge}</p></div>
              </>
            ) : null}
            {drawer.item.fields.map((field) => (
              <div key={field.label} className={styles.drawerBlock}>
                <strong>{field.label}</strong>
                <p>{field.value}</p>
              </div>
            ))}
            {drawer.item.lists.map((list) => (
              <div key={list.label} className={styles.drawerBlock}>
                <strong>{list.label}</strong>
                <ul>{list.items.map((entry) => <li key={entry}>{entry}</li>)}</ul>
              </div>
            ))}
            <div className={styles.drawerBlock}>
              <strong>来源与版本</strong>
              <p>
                {insight.statusLabel} · {insight.model ?? "模型未知"} · 生成于 {shortTime(insight.generatedAt)}
              </p>
              <p className={styles.monoLine}>
                输入哈希 {data?.inputHash ? `${data.inputHash.slice(0, 16)}…` : "未知"}
                <br />
                样本哈希 {scan.sampleHash.slice(0, 16)}… · 版本 {scan.resourceVersion}
              </p>
            </div>
            <div className={styles.drawerBlock}>
              <strong>来源引用（{drawer.item.citations.length}）</strong>
              {drawer.item.citations.length ? (
                <ul className={styles.citationList}>
                  {drawer.item.citations.map((citation) => (
                    <li key={citation}><code title={citation}>{citation.length > 56 ? `${citation.slice(0, 56)}…` : citation}</code></li>
                  ))}
                </ul>
              ) : <p>该条目没有携带引用，不能作为证据使用。</p>}
            </div>
            {drawer.item.relatedSubjects.length ? (
              <div className={styles.drawerBlock}>
                <strong>相关商品</strong>
                <div className={styles.subjectRow}>
                  {drawer.item.relatedSubjects.map((subject) => (
                    <button
                      key={subject.subjectKey}
                      type="button"
                      className={styles.subjectChip}
                      onClick={() => openSubject(subject.subjectKey)}
                    >
                      {subject.subjectKey.split(":").at(-1)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <p className={styles.drawerNote}>AI 提议不是来源事实，也不是人工决定；引用可定位不等于结论已成立。</p>
          </div>
        ) : null}
      </Drawer>

      <p className={styles.footNote}>
        来自已保存样本与证据，只读呈现。来源记录不等于人工确认；历史 AI 建议不替代人工决定。
      </p>
    </div>
  );
}
