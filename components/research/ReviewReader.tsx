"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, MessageSquareQuote } from "lucide-react";
import styles from "./ResearchReading.module.css";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { formatBuyerVoiceLoadError } from "@/components/research/BuyerVoicePanel";
import { localizeAccessBasis, localizeIdentityMatch, localizeVoiceContentType, localizeVoiceSource } from "@/lib/client/bilingualDisplay";

type Observation = {
  externalContentId: string;
  source: "amazon_review" | "reddit_post" | "reddit_comment" | "manual_voc";
  contentType: string;
  capturedAt: string;
  publishedAt: string | null;
  title: string | null;
  text: string;
  rating: number | null;
  verifiedPurchase: boolean | null;
  identityMatch: string;
  sourceUrl: string | null;
  evidenceRefs: string[];
  parentContentId: string | null;
  threadId: string | null;
  subreddit: string | null;
  depth: number | null;
  engagement: { score: number | null; commentCount: number | null } | null;
  provenance: { accessBasis: string };
};

function snippet(text: string, max = 56): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 原始评论阅读器（对照 3414 第 16 张）：
 * 左侧片段列表 + 右侧原文与证据详情；只读，不提供任何写入入口。
 */
export function ReviewReader({
  taskId,
  vocThemes = [],
  bilingual = true,
}: {
  taskId: string;
  /** 研究级中文 VOC 主题（只读展示，不是本条评论的译文）。 */
  vocThemes?: readonly { label: string; summary: string; reviewCount: number; strength: string }[];
  /** 中英对照开关：默认开启；关闭后只显示英文原文。 */
  bilingual?: boolean;
}) {
  const [items, setItems] = useState<Observation[]>([]);
  const [evidenceRefs, setEvidenceRefs] = useState<Array<{ refId: string; contentHash: string; capturedAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = typeof json?.error?.code === "string" ? json.error.code : null;
        const message = typeof json?.error?.message === "string" ? json.error.message : null;
        throw new Error(formatBuyerVoiceLoadError(response.status, code, message));
      }
      const data = (json?.data ?? json) as { observations?: Observation[]; evidenceRefs?: Array<{ refId: string; contentHash: string; capturedAt: string }> };
      const list = Array.isArray(data.observations) ? data.observations : [];
      setItems(list);
      setEvidenceRefs(Array.isArray(data.evidenceRefs) ? data.evidenceRefs : []);
      setActiveId((current) => (current && list.some((item) => item.externalContentId === current) ? current : list[0]?.externalContentId ?? null));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取买家声音失败。");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload]);

  const index = items.findIndex((item) => item.externalContentId === activeId);
  const active = index >= 0 ? items[index] : null;
  const refOf = useCallback(
    (refId: string) => evidenceRefs.find((ref) => ref.refId === refId) ?? null,
    [evidenceRefs]
  );
  const emptyHint = useMemo(() => (items.length === 0 ? "尚未导入评论原文。导入后会在这里逐条阅读，并附带证据引用。" : ""), [items.length]);

  return (
    <section className={`lc-reader ${styles.reader}`} aria-label="原始评论阅读器" data-testid="review-reader">
      <aside className="lc-reader-list" aria-label="评论片段列表">
        <div className="lc-reader-list-head">
          <MessageSquareQuote className="size-3.5" />
          <span>评论片段</span>
          <em>{items.length} 条</em>
        </div>
        {loading ? (
          <p className="lc-reader-loading"><Loader2 className="size-3.5 animate-spin" />正在读取评论…</p>
        ) : error ? (
          <p className="lc-reader-error">{error}</p>
        ) : items.length === 0 ? (
          <p className="lc-reader-empty">{emptyHint || "暂无评论片段。"}</p>
        ) : (
          <ul>
            {items.map((item, position) => (
              <li key={item.externalContentId}>
                <button
                  type="button"
                  onClick={() => setActiveId(item.externalContentId)}
                  aria-current={item.externalContentId === activeId ? "true" : undefined}
                  data-testid={`review-item-${item.externalContentId}`}
                >
                  <span className="lc-reader-index">{String(position + 1).padStart(2, "0")}</span>
                  <span className="lc-reader-item-text">
                    <strong>{item.title?.trim() || snippet(item.text, 40)}</strong>
                    {item.title?.trim() ? <small>{snippet(item.text, 40)}</small> : null}
                    {item.rating !== null ? <em>{item.rating.toFixed(1)}</em> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <article className="lc-reader-body" aria-label="评论原文">
        {active ? (
          <>
            <header className="lc-reader-head">
              <h2>{active.title?.trim() || localizeVoiceSource(active.source)}</h2>
              <span className="lc-reader-count">{index + 1} / {items.length}</span>
            </header>

            <p className={styles.reviewContext}>
              {localizeVoiceSource(active.source)} · {active.rating !== null ? `${active.rating.toFixed(1)} 分` : "无评分"}
              {active.verifiedPurchase ? " · 已验证购买" : ""}
              {active.publishedAt ? ` · ${new Date(active.publishedAt).toLocaleDateString("zh-CN")}` : ""}
              {active.sourceUrl ? <> · <a href={active.sourceUrl} target="_blank" rel="noreferrer noopener">原文 ↗</a></> : null}
            </p>
            <blockquote className="lc-reader-quote" data-testid="review-original">
              <span className="lc-reader-quote-tag">买家原文 · 未改写</span>
              {active.text}
            </blockquote>

            {bilingual && (
              <details className={`lc-reader-fold lc-reader-interpretation ${styles.interpretation}`} data-testid="review-interpretation">
                <summary>中文研究解读（研究级 VOC，非本条译文）</summary>
                {vocThemes.length > 0 ? <ul>
                  {vocThemes.slice(0, 3).map((theme) => <li key={theme.label}>
                    <strong>{theme.label}</strong><p>{theme.summary}</p>
                  </li>)}
                </ul> : <p>本研究尚未生成中文 VOC 主题分析。</p>}
              </details>
            )}

            <details className={`lc-reader-fold lc-reader-provenance ${styles.provenance}`} data-testid="review-provenance">
              <summary>来源与证据 · {active.evidenceRefs.length} 条引用</summary>
              <dl className="lc-reader-meta">
                <div><dt>来源</dt><dd>{localizeVoiceSource(active.source)} · {localizeVoiceContentType(active.contentType)}{active.sourceUrl ? <> · <a href={active.sourceUrl} target="_blank" rel="noreferrer noopener">原文链接</a></> : null}</dd></div>
                <div><dt>商品匹配</dt><dd>{localizeIdentityMatch(active.identityMatch).label}</dd></div>
                <div><dt>评分 / 购买</dt><dd>{active.rating !== null ? `${active.rating.toFixed(1)} 分` : "无评分"}{active.verifiedPurchase ? " · 已验证购买" : " · 未标记已验证购买"}</dd></div>
                <div><dt>发布时间</dt><dd>{active.publishedAt ? new Date(active.publishedAt).toLocaleString("zh-CN") : "未提供"}</dd></div>
                <div><dt>抓取时间</dt><dd>{new Date(active.capturedAt).toLocaleString("zh-CN")} · {localizeAccessBasis(active.provenance?.accessBasis)}</dd></div>
                {active.subreddit ? <div><dt>版块</dt><dd>{active.subreddit}{active.engagement?.commentCount !== null && active.engagement?.commentCount !== undefined ? ` · ${active.engagement.commentCount} 条回复` : ""}</dd></div> : null}
              </dl>

              <div className="lc-reader-refs">
                <p className="lc-reader-refs-title">证据引用</p>
                {active.evidenceRefs.length === 0 ? (
                  <p className="lc-reader-empty">该片段没有附证据引用；不能作为事实依据。</p>
                ) : (
                  <ul>
                    {active.evidenceRefs.map((ref) => {
                      const detail = refOf(ref);
                      return (
                        <li key={ref}>
                          <code>{ref}</code>
                          {detail ? <span>内容哈希 {detail.contentHash} · 抓取于 {new Date(detail.capturedAt).toLocaleString("zh-CN")}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </details>

            <footer className="lc-reader-foot">
              <button type="button" disabled={index <= 0} onClick={() => setActiveId(items[index - 1].externalContentId)}>← 上一条</button>
              <button type="button" disabled={index < 0 || index >= items.length - 1} onClick={() => setActiveId(items[index + 1].externalContentId)}>下一条 →</button>
            </footer>
          </>
        ) : (
          <div className="lc-reader-body-empty">
            <FileText className="size-6" />
            <p>{loading ? "正在读取评论…" : error ?? "选择左侧片段后，这里显示评论原文与证据详情。"}</p>
          </div>
        )}
      </article>
    </section>
  );
}
