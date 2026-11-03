"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, FileUp, Globe, Loader2, MessageSquareQuote, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { amazonCaptureFailureGuidance, classifyAmazonCaptureFailure } from "@/components/source-layer/amazonCaptureOutcome";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

type VoiceObservation = {
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

type VoiceData = {
  observations: VoiceObservation[];
  count: number;
  evidenceRefs: Array<{ refId: string; contentHash: string; capturedAt: string }>;
};

export function formatBuyerVoiceLoadError(status: number, code: string | null, message: string | null): string {
  if (status >= 500 || code === "INTERNAL_ERROR") {
    const safeCode = code && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : `HTTP_${status}`;
    return `买家评论暂时无法读取（${safeCode}）。请点击“刷新”重试；若问题持续，请把错误码提供给维护者。`;
  }
  return message || `读取买家声音失败 (${status})`;
}

const sourceLabels: Record<VoiceObservation["source"], string> = {
  amazon_review: "Amazon 真实评论",
  reddit_post: "Reddit 帖子",
  reddit_comment: "Reddit 评论",
  manual_voc: "人工录入 / 导入",
};

const matchLabels: Record<string, { label: string; tone: "emerald" | "amber" | "blue" | "slate" }> = {
  EXACT: { label: "精确匹配商品", tone: "emerald" },
  UNRESOLVED: { label: "人工录入 / 未验证", tone: "slate" },
  VARIANT: { label: "变体关联", tone: "blue" },
  FAMILY: { label: "同族关联", tone: "blue" },
  PROBABLE: { label: "疑似匹配", tone: "amber" },
};

export function BuyerVoicePanel({
  taskId,
  disabled = false,
  onEvidenceChanged,
}: {
  taskId: string;
  disabled?: boolean;
  onEvidenceChanged?: () => Promise<void> | void;
}) {
  const [data, setData] = useState<VoiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"amazon-collect" | "amazon-norm" | "voc-analyze" | "file" | "manual" | "reddit" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 读取失败的错误码（如 PRODUCT_FACT_INVALID）：用于给出可执行的出路，而不是只报错。 */
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [redditQuery, setRedditQuery] = useState("");

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
        setErrorCode(code);
        throw new Error(formatBuyerVoiceLoadError(response.status, code, message));
      }
      setErrorCode(null);
      setData(json?.data ?? json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取买家声音失败。");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload]);

  const finishWrite = async (message: string) => {
    setNotice(message);
    await reload();
    await onEvidenceChanged?.();
  };

  const collectAmazon = async () => {
    setBusy("amazon-collect"); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice/amazon`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "collect" }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = typeof json?.error?.code === "string" ? json.error.code : null;
        const guidance = amazonCaptureFailureGuidance(classifyAmazonCaptureFailure(code));
        throw new Error(`浏览器评论采集未完成——${guidance.title}。${guidance.hint}${json?.error?.message ? `（服务端原因：${json.error.message}）` : ""}`);
      }
      const result = json.data ?? json;
      await finishWrite(result.collectedCount
        ? `已通过浏览器采集 ${result.collectedCount} 条当前商品真实评论；入库归一化 ${result.added ?? 0} 条买家声音。`
        : (result.warning ?? "浏览器采集已执行，未解析到新增公开评论。"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Amazon 评论浏览器采集失败。");
    } finally { setBusy(null); }
  };

  const normalizeAmazon = async () => {
    setBusy("amazon-norm"); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice/amazon`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "normalize" }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `归一化 Amazon Review 失败 (${response.status})`);
      const result = json.data ?? json;
      await finishWrite(`已读取 ${result.sourceCount ?? 0} 条既有 Amazon Review；新增 ${result.added ?? 0} 条买家声音。未重新采集商品数据。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Amazon Review 归一化失败。");
    } finally { setBusy(null); }
  };

  const analyzeVoc = async () => {
    setBusy("voc-analyze"); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice/amazon`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `VOC 分析生成失败 (${response.status})`);
      await finishWrite("买家声音（VOC）主题聚类与痛点分析已完成，已落库并同步更新研报。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "VOC 主题分析失败。");
    } finally { setBusy(null); }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("文件不得超过 5 MiB。"); return; }
    setBusy("file"); setError(null); setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice`, {
        method: "POST",
        headers: buildAccessHeaders(),
        body: form,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `导入买家声音失败 (${response.status})`);
      const result = json.data ?? json;
      await finishWrite(`文件已作为原始凭证（RawArtifact）保存；解析 ${result.parsedRows ?? 0} 行，接受 ${result.acceptedRows ?? 0} 条，新增 ${result.added ?? 0} 条。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件导入失败。");
    } finally { setBusy(null); }
  };

  const addManual = async () => {
    const text = manualText.trim();
    if (!text) return;
    setBusy("manual"); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice/manual`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ observations: [{ contentType: "review", text }] }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `保存人工 VOC 失败 (${response.status})`);
      const result = json.data ?? json;
      setManualText("");
      await finishWrite(`人工买家原声已保留原始输入证据；新增 ${result.added ?? 0} 条。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存人工 VOC 失败。");
    } finally { setBusy(null); }
  };

  const collectReddit = async () => {
    if (redditQuery.trim().length < 2) { setError("请输入至少 2 个字符的 Reddit 搜索词。"); return; }
    setBusy("reddit"); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice/reddit`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ query: redditQuery.trim() }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = typeof json?.error?.code === "string" ? json.error.code : null;
        const guidance = amazonCaptureFailureGuidance(classifyAmazonCaptureFailure(code));
        throw new Error(`公开讨论采集未完成——${guidance.title}。${guidance.hint}`);
      }
      const result = json.data ?? json;
      await finishWrite(result.status === "external_blocked" || result.status === "partial_external_block"
        ? `Reddit 采集遇到外部阻断；已严格停止并保留原始凭据，未伪造数据。`
        : `Reddit 公开讨论采集完成：帖子 ${result.postCount ?? 0} 篇，评论 ${result.commentCount ?? 0} 条，新增 ${result.added ?? 0} 条。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reddit 公开页面采集失败。");
    } finally { setBusy(null); }
  };

  return (
    <section id="buyer-voice-panel" aria-labelledby="buyer-voice-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareQuote className="size-4 text-violet-700" />
            <h2 id="buyer-voice-heading" className="text-sm font-bold text-slate-900">买家声音</h2>
            <Badge tone="purple">事实依据引用</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            收集并归一化真实买家评论、用户导入反馈及公开社区讨论；作为研报痛点与产品开发需求单改动的直接证据。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.observations.length ? (
            <Button size="sm" variant="secondary" onClick={() => void analyzeVoc()} disabled={disabled || busy !== null} isLoading={busy === "voc-analyze"}>
              <Sparkles className="size-3.5" /> 生成 VOC 主题分析
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading || busy !== null}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-3 pt-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">Amazon 真实评论采集与归一化</h3>
            <span className="text-[12px] text-slate-500">主证据渠道</span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
            通过本地浏览器实时抓取当前商品详情页真实公开评论，或归一化已有评论凭证。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void collectAmazon()} disabled={disabled || busy !== null} isLoading={busy === "amazon-collect"}>
              <Globe className="size-3.5" /> 浏览器实时采集评论
            </Button>
            <Button size="sm" variant="outline" onClick={() => void normalizeAmazon()} disabled={disabled || busy !== null} isLoading={busy === "amazon-norm"}>
              <RefreshCw className="size-3.5" /> 归一化既有评论
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <h3 className="text-xs font-semibold text-slate-800">导入离线评论（CSV / XLSX / JSON）</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
            支持卖家精灵、ERP 导出的评论表格；原文件作为不可变凭证（RawArtifact）保存。
          </p>
          <label className={`mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 ${disabled || busy !== null ? "pointer-events-none opacity-50" : ""}`}>
            {busy === "file" ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
            选择文件上传
            <input aria-label="导入买家声音文件" className="sr-only" type="file" accept=".csv,.xlsx,.json" disabled={disabled || busy !== null} onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </label>
        </div>

        <div className="rounded-xl border border-slate-200 p-3">
          <h3 className="text-xs font-semibold text-slate-800">手动记录买家原话（VOC）</h3>
          <textarea aria-label="人工 VOC 内容" rows={3} maxLength={2_000} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="记录买家真实反馈、客诉邮件或调研原话；请勿输入手机号、姓名等隐私信息。" disabled={disabled || busy !== null} className="mt-2 w-full rounded-lg border border-slate-200 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/20" />
          <Button className="mt-2" size="sm" onClick={() => void addManual()} disabled={disabled || busy !== null || !manualText.trim()} isLoading={busy === "manual"}>保存人工原声</Button>
        </div>

        <div className="rounded-xl border border-slate-200 p-3">
          <h3 className="text-xs font-semibold text-slate-800">Reddit 公开讨论采集</h3>
          <p className="mt-1 text-[13px] text-slate-500">通过浏览器抓取公开社区真实讨论；遇到验证码或登录限制时自动安全停止。</p>
          <div className="mt-2 flex gap-2">
            <input aria-label="Reddit 搜索词" value={redditQuery} onChange={(event) => setRedditQuery(event.target.value)} maxLength={120} placeholder="英文产品词或核心使用痛点" disabled={disabled || busy !== null} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500/20" />
            <Button size="sm" onClick={() => void collectReddit()} disabled={disabled || busy !== null || redditQuery.trim().length < 2} isLoading={busy === "reddit"}>采集公开讨论</Button>
          </div>
        </div>
      </div>

      {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"><AlertCircle className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
      {(() => {
        // 状态条：让用户一眼区分「已有证据 / 暂无数据 / 采集中 / 读取失败（原因）」。
        const busyLabel = busy === "amazon-collect" ? "采集中：正在通过专用浏览器抓取 Amazon 评论…"
          : busy === "reddit" ? "采集中：正在抓取公开讨论…"
          : busy === "amazon-norm" ? "处理中：正在归一化既有 Amazon 评论…"
          : busy === "voc-analyze" ? "处理中：正在生成 VOC 主题分析…"
          : busy === "file" ? "处理中：正在解析导入文件…"
          : busy === "manual" ? "处理中：正在保存人工原声…"
          : null;
        return (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <div className={`flex items-center gap-1.5 font-medium ${error ? "text-rose-700" : busyLabel ? "text-sky-700" : data?.count ? "text-emerald-700" : "text-slate-500"}`} data-testid="buyer-voice-status">
              {error ? <AlertCircle className="size-3.5 shrink-0" /> : <ShieldCheck className="size-3.5 shrink-0" />}
              {loading
                ? "正在读取买家声音…"
                : busyLabel
                  ? busyLabel
                  : error
                    ? "读取失败（原因见下方提示）"
                    : data?.count
                      ? `已有证据：${data.count} 条买家观察记录 · ${data.evidenceRefs.length} 个正式凭据引用`
                      : "暂无数据：该商品还没有任何买家声音证据"}
            </div>
            <span data-testid="buyer-voice-count" className="sr-only">{data?.count ?? 0}</span>
          </div>
        );
      })()}

      {/* 读取被事实门禁拦截时，给出可执行的出路（不依赖商品事实绑定的人工通道仍然可用）。 */}
      {!loading && errorCode && (errorCode === "PRODUCT_FACT_INVALID" || errorCode === "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING" || errorCode === "EVIDENCE_BINDING_MISSING") && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-900">
          当前研究的商品事实或来源绑定不可验证，已按 fail-closed 停止读取已采集评论。两条出路：①在页面顶部「立即补齐商品数据」补齐来源后重试；②直接使用下方「手动记录买家原话」或「导入离线评论」——人工导入内容不依赖商品事实绑定，可正常进入买家声音。
        </p>
      )}

      {data?.observations.length ? (
        <ul className="mt-3 max-h-[28rem] space-y-2 overflow-auto">
          {data.observations.map((item, index) => {
            const match = matchLabels[item.identityMatch] ?? { label: item.identityMatch, tone: "slate" as const };
            return (
              <li key={`${item.source}:${item.externalContentId}:${index}`} data-testid="buyer-voice-observation" className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.source === "amazon_review" ? "amber" : item.source === "reddit_post" || item.source === "reddit_comment" ? "indigo" : "slate"} data-testid="buyer-voice-source">
                    {sourceLabels[item.source]}
                  </Badge>
                  <Badge tone={match.tone} data-testid="buyer-voice-identity-match">{match.label}</Badge>
                  {/* 是否可引用：有正式凭证引用的内容才能被研报与需求单引用 */}
                  {item.evidenceRefs.length > 0
                    ? <Badge tone="emerald">可引用 · 有凭证</Badge>
                    : <Badge tone="slate">暂无引用凭证</Badge>}
                  {item.rating !== null && <span className="text-[13px] font-medium text-amber-700">★ {item.rating} 颗星</span>}
                  {item.verifiedPurchase === true && <span className="text-[12px] text-emerald-600 font-medium">✓ 平台验证购买</span>}
                  {item.subreddit && <span className="text-[12px] text-slate-500">r/{item.subreddit}</span>}
                  {item.engagement?.score !== null && item.engagement?.score !== undefined && <span className="text-[12px] text-slate-500">互动分 {item.engagement.score}</span>}
                  {item.engagement?.commentCount !== null && item.engagement?.commentCount !== undefined && <span className="text-[12px] text-slate-500">讨论数 {item.engagement.commentCount}</span>}
                  <time className="ml-auto text-[12px] text-slate-400">{new Date(item.capturedAt).toLocaleString("zh-CN")}</time>
                </div>
                {item.title && <h4 className="mt-2 text-xs font-semibold text-slate-800">{item.title}</h4>}
                <p data-testid="buyer-voice-text" className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">{item.text}</p>
                <details className="mt-2 text-[12px] text-slate-400">
                  <summary className="cursor-pointer select-none text-[12px] text-slate-400 hover:text-slate-600">
                    技术详情与追溯依据
                  </summary>
                  <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-slate-500">
                    {item.parentContentId && <span>上级编号: {item.parentContentId}</span>}
                    {item.threadId && <span>讨论串编号: {item.threadId}</span>}
                    {item.depth !== null && <span>评论层级: {item.depth}</span>}
                    {item.publishedAt && <time>发布时间: {new Date(item.publishedAt).toLocaleString("zh-CN")}</time>}
                    <span>获取通道: {item.provenance.accessBasis}</span>
                    {item.evidenceRefs.map((ref) => <code key={ref} className="rounded bg-slate-100 px-1 py-0.5">{ref}</code>)}
                    {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-violet-700 hover:underline">查看公开来源</a>}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : !loading ? (
        <div className="mt-3 rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-500">
          <p className="font-medium text-slate-700">本模块暂无已归一的买家声音观察</p>
          <p className="mt-1 text-[13px] text-slate-400">
            这不等于商品没有评论证据：已合法采集的评论附件由「VOC 痛点」层读取。此处可点击上方“浏览器实时采集评论”从 Amazon 详情页抓取，或上传离线评论表格。
          </p>
        </div>
      ) : null}
      <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
        买家主观陈述不等同于 Amazon 平台事实；研报与产品开发需求单需引用对应证据附件。
      </p>
    </section>
  );
}
