"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, FileText, LockKeyhole, RefreshCw, Search, Sparkles } from "lucide-react";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import {
  displayProductTitle,
  formatDate,
  listNextStep,
  listSourceState,
  statusLabelOf,
  statusTone,
  type BriefListItem,
} from "./briefWorkbenchModel";
import styles from "./ProductBriefWorkbench.module.css";

type FilterKey = "all" | "ready" | "draft" | "approved" | "locked";

const FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "ready", label: "待评审" },
  { key: "draft", label: "草稿" },
  { key: "approved", label: "已批准" },
  { key: "locked", label: "只读" },
] as const;

function matchesFilter(item: BriefListItem, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "locked") return item.stale === true;
  if (item.stale) return false;
  if (filter === "ready") return item.status === "READY";
  if (filter === "approved") return item.status === "APPROVED";
  return item.status === "DRAFT";
}

export function BriefWorkbenchList() {
  const [items, setItems] = useState<BriefListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/product-brief", { headers: buildAccessHeaders(), cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) throw new Error(json?.error?.message ?? "需求单列表暂时无法读取，请刷新后重试。");
      setItems(Array.isArray(json.data?.items) ? json.data.items : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "需求单列表暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ordered = useMemo(
    () => [...items].sort((a, b) => Number(Boolean(a.stale)) - Number(Boolean(b.stale)) || new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()),
    [items],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return ordered.filter((item) => {
      if (!matchesFilter(item, filter)) return false;
      if (!keyword) return true;
      return [item.title, item.asin, item.taskId, item.positioningText].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [filter, ordered, query]);

  const counts = useMemo(() => {
    const result: Record<FilterKey, number> = { all: items.length, ready: 0, draft: 0, approved: 0, locked: 0 };
    for (const item of items) {
      if (item.stale) result.locked += 1;
      else if (item.status === "READY") result.ready += 1;
      else if (item.status === "APPROVED") result.approved += 1;
      else result.draft += 1;
    }
    return result;
  }, [items]);

  const activeCount = counts.all - counts.locked;
  const countLabel = loading ? "—" : String(counts.all);

  return (
    <WorkspaceFrame
      modeLabel="正式需求单列表 · 服务端读取"
      footerNote="04 产品开发需求单 · 来源事实只读 · 人工方案可编辑 · 版本与门禁保留"
      header={
        <header className={styles.hero}>
          <div className={styles.heroMain}>
            <p className={styles.kicker}><span className={styles.kickerDot} />04 · 产品开发</p>
            <h1 className={styles.heroTitle}>产品开发需求单</h1>
            <p className={styles.heroLead}>
              把研究结论变成能讨论、能核实的产品方案。共 <b>{countLabel}</b> 份需求单
              {loading ? "。" : <>，<b>{activeCount}</b> 份可继续完善{counts.locked ? <>，<b>{counts.locked}</b> 份因来源锁定只能查看</> : null}。</>}
            </p>
          </div>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/research?view=proceed">
              <Sparkles size={16} aria-hidden="true" />
              从已推进研究开始
            </Link>
            <button type="button" className={styles.secondaryAction} onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
              刷新
            </button>
          </div>
        </header>
      }
    >
      <div className={styles.page}>
        <div className={styles.toolbar}>
          <div className={styles.segmented} role="group" aria-label="需求单状态筛选">
            {FILTERS.map((entry) => (
              <button key={entry.key} type="button" aria-pressed={filter === entry.key} onClick={() => setFilter(entry.key)}>
                <span>{entry.label}</span>
                <em>{loading ? "—" : counts[entry.key]}</em>
              </button>
            ))}
          </div>
          <label className={styles.search}>
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索需求单"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索商品名、定位、ASIN 或任务 ID"
            />
          </label>
        </div>

        {loading ? (
          <div className={styles.cardGrid} aria-label="正在读取需求单">
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.skeletonCard}>
                <span className={styles.skeletonCover} />
                <span className={styles.skeletonLine} />
                <span className={styles.skeletonLineShort} />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className={styles.stateCard} role="alert">
            <FileText size={30} aria-hidden="true" />
            <h2>需求单暂时无法读取</h2>
            <p>{error}</p>
            <button type="button" className={styles.secondaryAction} onClick={() => void load()}>
              <RefreshCw size={15} aria-hidden="true" />重新读取
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.stateCard}>
            <FileText size={30} aria-hidden="true" />
            <h2>{items.length === 0 ? "还没有产品开发需求单" : "没有匹配的需求单"}</h2>
            <p>
              {items.length === 0
                ? "先在 03 商品深研完成门禁并选择「继续推进」，系统才会生成第一版需求单。"
                : "尝试换一个关键词，或把筛选切回「全部」。"}
            </p>
            {items.length === 0 ? (
              <Link className={styles.primaryAction} href="/research?view=proceed">前往已推进的商品深研</Link>
            ) : (
              <button type="button" className={styles.secondaryAction} onClick={() => { setFilter("all"); setQuery(""); }}>重置筛选</button>
            )}
          </div>
        ) : (
          <div className={styles.cardGrid}>
            {filtered.map((item) => {
              const locked = item.stale === true;
              const tone = statusTone(item.status);
              const source = listSourceState(item);
              const statusText = locked ? `历史${statusLabelOf(item.status)} · 只读` : statusLabelOf(item.status);
              const nextStep = listNextStep(item);
              const href = `/product-brief?taskId=${encodeURIComponent(item.taskId)}`;
              return (
                <article key={item.taskId} className={styles.briefCard} data-locked={locked ? "true" : undefined}>
                  <div className={styles.cardTop}>
                    <div className={styles.cover}>
                      <ProductImage
                        src={item.imageUrl}
                        alt={item.title ?? item.asin}
                        className={styles.coverImage}
                        iconClassName={styles.coverIcon}
                        placeholderLabel="暂无图片"
                        testId={`brief-image-${item.asin}`}
                      />
                    </div>
                    <div className={styles.cardIdentity}>
                      <div className={styles.cardBadges}>
                        <span className={styles.statusChip} data-tone={locked ? "locked" : tone}>
                          {locked ? <LockKeyhole size={12} aria-hidden="true" /> : null}
                          {statusText}
                        </span>
                        <span className={styles.sourceChip} data-tone={source.tone}>{source.label}</span>
                        {item.syntheticSample ? <span className={styles.chip} data-tone="warn">隔离联调样本</span> : null}
                      </div>
                      <p className={styles.cardBrand}>研究参考商品 · {item.brand ?? "Amazon 商品"} · {item.asin}</p>
                      <h2 className={styles.cardTitle} title={item.title ?? undefined}>
                        <Link href={href}>{displayProductTitle(item.title, item.asin)}</Link>
                      </h2>
                    </div>
                  </div>

                  <p className={styles.cardScheme}>
                    <strong>拟开发方案</strong>
                    <span>{item.positioningText?.trim() || "尚未填写拟开发定位；打开需求单补充。"}</span>
                  </p>

                  <p className={styles.cardNext} data-tone={locked || (item.status === "READY" && item.approvalBlocked) ? "warn" : "ok"}>
                    <strong>下一步</strong>
                    <span>{nextStep}</span>
                  </p>

                  <div className={styles.cardMeta}>
                    <span>需求单 rev.{item.revision}</span>
                    {item.researchRevision !== undefined ? <span>研究 rev.{item.researchRevision}</span> : null}
                    <span>更新 {formatDate(item.generatedAt)}</span>
                    {!locked && item.missingCostCount ? <span className={styles.metaWarn}>成本缺口 {item.missingCostCount} 项</span> : null}
                  </div>
                  <div className={styles.cardFoot}>
                    <Link className={styles.cardPrimary} href={href}>
                      {locked ? "查看历史内容" : "打开需求单"}
                      <ArrowRight size={14} aria-hidden="true" />
                    </Link>
                    <Link className={styles.cardSecondary} href={`/research/${encodeURIComponent(item.taskId)}`}>商品深研</Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <p className={styles.listNote}>
          研究参考商品只提供研究依据；拟开发方案、成本目标与待验证条件由人工编辑并单独保存。来源锁定后只读。
        </p>
      </div>
    </WorkspaceFrame>
  );
}
