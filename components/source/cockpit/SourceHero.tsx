"use client";

import type { ReactNode } from "react";
import { ArrowRight, FolderArchive, Layers, RefreshCw, Search, ShieldCheck, Plus } from "lucide-react";
import { useSpotlight } from "./useSpotlight";
import styles from "./SourceCockpit.module.css";

/**
 * 01 市场采集 · 主视觉与入口 Bento。
 * 业务行为完全沿用 SourceManagementClient 传入的回调（打开既有采集弹窗/抽屉）。
 */
export function SourceHero({
  onKeyword,
  onCategory,
  onSingleAsin,
  toolsMenu,
  onOpenRecords,
  onRefresh,
  loading,
  minimumRequired,
  lastBatchLabel,
}: {
  onKeyword: () => void;
  onCategory: () => void;
  onSingleAsin: () => void;
  toolsMenu: ReactNode;
  onOpenRecords: () => void;
  onRefresh: () => void;
  loading: boolean;
  minimumRequired: number;
  lastBatchLabel: string | null;
}) {
  return (
    <section className={styles.hero} aria-labelledby="sc-hero-title" data-testid="capture-overview-zone">
      <span className={styles.aurora} aria-hidden="true" />
      <div className={styles.heroCopy}>
        <p className={styles.eyebrow}>01 · 市场采集</p>
        <h1 id="sc-hero-title" className={styles.heroTitle}>
          市场采集中心<em>，从可信线索开始</em>
        </h1>
        <p className={styles.heroLead}>
          选择一个入口，把市场线索整理成有来源、能回看的研究材料。采集结果会整理为批次，
          有效样本达到门槛后即可建立市场研究；证据统一写入证据库。
        </p>
        <div className={styles.heroChips}>
          <span className={styles.chip}><ShieldCheck size={13} aria-hidden="true" />证据写入证据库</span>
          <span className={styles.chip}>有效样本门槛 ≥ {minimumRequired} 款</span>
          <span className={styles.chip}>美国站（Amazon US）· 采集网关</span>
          {lastBatchLabel ? <span className={styles.chip}>最近批次 · {lastBatchLabel}</span> : null}
        </div>
        <div className={styles.heroActions}>
          <button type="button" className={styles.primaryCta} onClick={onKeyword} data-testid="entry-keyword-market">
            <Search size={17} aria-hidden="true" />
            关键词市场采集
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className={styles.secondaryCta} onClick={onCategory} data-testid="entry-category-market">
            <Layers size={16} aria-hidden="true" />
            类目市场
          </button>
          <button type="button" className={styles.secondaryCta} onClick={onSingleAsin} data-testid="start-product-capture-button">
            <Plus size={16} aria-hidden="true" />
            补录 ASIN
          </button>
        </div>
        <div className={`${styles.heroActions} ${styles.heroUtilities}`}>
          <button type="button" className={styles.secondaryCta} onClick={onOpenRecords} data-testid="batch-records-drawer-button">
            <FolderArchive size={15} aria-hidden="true" />
            采集记录
          </button>
          <button type="button" className={styles.secondaryCta} onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            {loading ? "刷新中" : "刷新"}
          </button>
          {toolsMenu}
        </div>
      </div>

      <div className={styles.heroVisual} aria-hidden="true">
        <div className={styles.radar}>
          <span className={styles.radarRing} />
          <span className={styles.radarRing} />
          <span className={styles.radarRing} />
          <span className={styles.radarSweep} />
          <span className={styles.radarDot} />
          <span className={styles.radarDot} />
          <span className={styles.radarDot} />
          <span className={styles.radarCore}>采集</span>
        </div>
        <p className={styles.radarCaption}>装饰图形 · 不代表采集进度或实时扫描</p>
      </div>
    </section>
  );
}

export function SourceEntryBento({
  onKeyword,
  onCategory,
  onSingleAsin,
}: {
  onKeyword: () => void;
  onCategory: () => void;
  onSingleAsin: () => void;
}) {
  const keyword = useSpotlight<HTMLButtonElement>();
  const category = useSpotlight<HTMLButtonElement>();

  return (
    <section className={styles.bento} aria-label="采集入口" data-testid="capture-entry-cards">
      <button
        type="button"
        ref={keyword.ref}
        onPointerMove={keyword.onPointerMove}
        onClick={onKeyword}
        className={`${styles.entry} ${styles.entryKeyword}`}
        data-testid="entry-keyword-market-card"
      >
        <span className={styles.entryTag}><Search size={15} aria-hidden="true" />主入口 · 关键词市场</span>
        <h2 className={styles.entryTitle}>关键词市场<small>输入关键词与站点，采集一批可追溯的商品样本</small></h2>
        <p className={styles.entryDesc}>
          以关键词为线索拉取搜索结果，形成采集批次；样本可用于市场竞争、价格结构与买家声音研究。
        </p>
        <div className={styles.flowSteps}>
          <span>输入关键词</span><i aria-hidden="true">→</i><span>拉取搜索结果</span><i aria-hidden="true">→</i><span>形成采集批次</span>
        </div>
        <span className={styles.entryCta}>开始关键词采集 <ArrowRight size={15} aria-hidden="true" /></span>
      </button>

      <button
        type="button"
        ref={category.ref}
        onPointerMove={category.onPointerMove}
        onClick={onCategory}
        className={`${styles.entry} ${styles.entryCategory}`}
        data-testid="entry-category-market-card"
      >
        <span className={styles.entryTag}><Layers size={15} aria-hidden="true" />主入口 · 类目市场</span>
        <h2 className={styles.entryTitle}>类目市场<small>卖家精灵（SellerSprite）类目指标与市场估算</small></h2>
        <p className={styles.entryDesc}>
          采集 Amazon 类目的市场指标（第三方估算），可在 02 市场研究绑定查看。
        </p>
        <span className={styles.entryNote}>指标观察 · 不含类目商品样本</span>
        <span className={styles.entryCta}>查看类目指标 <ArrowRight size={15} aria-hidden="true" /></span>
      </button>

      <div className={`${styles.entry} ${styles.entrySingle}`} data-testid="entry-single-asin">
        <span className={styles.entryIcon} aria-hidden="true"><Plus size={20} /></span>
        <div className={styles.entryBody}>
          <span className={styles.entryTag} style={{ color: "#6b8177" }}>辅助入口</span>
          <h2 className={styles.entryTitle}>补录单个商品</h2>
          <p className={styles.entryDesc}>已知 ASIN 时补录单个商品事实，用于商品深研快速通道，不构成市场样本。</p>
        </div>
        <button type="button" className={styles.singleAction} onClick={onSingleAsin} data-testid="start-product-capture-inline">
          补录商品 <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
