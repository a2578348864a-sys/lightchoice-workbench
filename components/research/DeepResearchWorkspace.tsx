"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, BarChart3, ChevronDown, ClipboardList, Loader2, MessageSquareWarning, RefreshCw, Target } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type {
  DeepResearchComparisonProjection,
  DeepResearchOpportunityProjection,
  DeepResearchPayload,
  DeepResearchVocProjection,
  DeepResearchVocTheme,
} from "@/lib/research/deepResearchTypes";

/**
 * 03 商品深研工作区（只读投影）。
 *
 * 数据来自 `GET /api/research/{taskId}/deep-analysis`：VOC 评论证据归属、代表商品可比性、开发机会。
 * 全部为只读展示；人工决策与需求单仍需走既有门禁（本组件不写入任何数据）。
 */

export type DeepResearchWorkspaceProps = {
  taskId: string;
  /** 总览已承担「研究结论」时关闭该段，避免同一结论在两处重复。 */
  showConclusion?: boolean;
  /**
   * 只渲染指定模块（证据区按材料分类打开、比较区只读竞品与机会）。
   * 未传 = 全部渲染；传空数组 = 不渲染任何模块。
   */
  sections?: readonly DeepResearchSection[];
  /**
   * 只渲染单个模块时隐藏「第 N 部分」序号，避免在二级视图里出现无上下文的编号。
   * 默认 false（保持原样）。
   */
  hideStep?: boolean;
  detail: {
    title: string | null;
    asin: string | null;
    stale: boolean;
    hasFormalReport: boolean;
    researchRevision: number | null;
    marketRole: string | null;
  };
};

const ROLE_LABELS: Record<string, string> = {
  benchmark: "基准商品",
  newcomer: "新进入者",
  pain_point: "痛点样本",
};

const STRENGTH_META: Record<string, { label: string; tone: "emerald" | "amber" | "slate" | "rose" }> = {
  recurring: { label: "已复现（≥4 条明确负面）", tone: "rose" },
  weak: { label: "弱信号（2–3 条明确负面，待验证）", tone: "amber" },
  isolated: { label: "孤立负面（仅 1 条明确负面）", tone: "slate" },
  mention_only: { label: "仅为主题提及（无明确负面）", tone: "slate" },
  insufficient: { label: "证据不足（无法判断）", tone: "slate" },
};

const INTENT_LABEL: Record<string, string> = {
  complaint: "明确负面",
  tolerated: "可接受",
  uncertain: "待核对",
  mention: "仅提及",
  positive: "正面",
};

const COMPARABILITY_META: Record<string, { label: string; tone: "emerald" | "amber" | "slate" }> = {
  comparable: { label: "可直接比较", tone: "emerald" },
  spec_differs: { label: "规格不同，暂不可直接比较", tone: "amber" },
  unknown: { label: "缺少关键事实，无法判断", tone: "slate" },
};

function formatMoney(value: { amount: number; currency: string } | null): string {
  if (!value) return "缺失";
  const symbol = value.currency === "USD" ? "$" : `${value.currency} `;
  return `${symbol}${value.amount.toFixed(2)}`;
}

/** 评论日期统一成「2026/1/31」这类可读格式；无法解析时原样返回。 */
function formatReviewDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("zh-CN");
}

function SectionShell(props: {
  id: string;
  step: string;
  title: string;
  description: React.ReactNode;
  icon: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section id={props.id} data-testid={props.testId} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">{props.icon}</div>
        <div className="min-w-0">
          {props.step ? <p className="text-[12px] font-semibold tracking-wide text-emerald-700">{props.step}</p> : null}
          <h2 className="section-title text-base font-bold text-slate-950">{props.title}</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-slate-600">{props.description}</p>
        </div>
      </div>
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

export type DeepResearchSection = "voc" | "competitors" | "opportunities" | "raw";

export function DeepResearchWorkspace({ taskId, detail, showConclusion = true, sections, hideStep = false }: DeepResearchWorkspaceProps) {
  const [data, setData] = useState<DeepResearchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/deep-analysis`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
        signal,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `读取深度分析失败 (${response.status})`);
      const payload = (json?.data ?? json) as DeepResearchPayload;
      setData(payload);
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "读取深度分析失败");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // 切换研究对象时避免旧数据残留
  useEffect(() => {
    setData(null);
    setError(null);
  }, [taskId]);

  if (loading && !data) {
    return (
      <section data-testid="deep-research-loading" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <div className="flex items-center gap-2 text-[15px] text-slate-500">
          <Loader2 className="size-4 animate-spin" />
          正在读取评论证据、代表商品与开发机会…
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section data-testid="deep-research-error" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-xs">
        <p className="text-[15px] font-semibold text-rose-900">深度分析读取失败</p>
        <p className="mt-1 text-[15px] text-rose-800">{error}</p>
        <button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-rose-700">
          <RefreshCw className="size-3.5" /> 重试
        </button>
      </section>
    );
  }

  const voc = data?.voc;
  const comparison = data?.comparison;
  const opportunities = data?.opportunities;

  const topNegative = voc?.themes.find((theme) => theme.polarity === "negative" && theme.complaintCount > 0) ?? null;
  /** 没有任何明确负面时，仍展示「被提到但没有明确负面」的主题，避免把提及说成痛点，也不隐藏观察。 */
  const topMention = topNegative
    ? null
    : voc?.themes.find((theme) => theme.polarity === "negative" && theme.mentionCount > 0) ?? null;
  const topDifference = comparison?.differences[0] ?? null;
  const recommendation = buildRecommendation({ voc, comparison, opportunities });
  const reviewSample = voc ? { reviews: voc.reviewsRead, attachments: voc.attachmentsRead, asins: voc.asins.length } : null;
  const showSection = (section: DeepResearchSection) => !sections || sections.includes(section);

  return (
    <div className="space-y-5" data-testid="deep-research-workspace">
      {/* ① 首屏：研究结论概览（一个屏幕只承担一个判断任务；总览已承担时可关闭） */}
      {showConclusion && <section id="deep-research-conclusion" data-testid="deep-research-conclusion" className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold tracking-wide text-emerald-700">研究结论概览</p>
            <h2 className="mt-0.5 text-lg font-bold text-slate-950">{detail.title ?? "未命名研究对象"}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-slate-600">
              {detail.asin ? <span className="font-mono">{detail.asin}</span> : null}
              {detail.marketRole ? <Badge tone="blue">{ROLE_LABELS[detail.marketRole] ?? detail.marketRole}</Badge> : <Badge tone="slate">未绑定代表商品角色</Badge>}
              <span>研究版本 rev.{detail.researchRevision ?? "—"}</span>
              <span>研报：{detail.hasFormalReport ? "已有正式报告" : "尚无正式报告"}</span>
              <span data-testid="deep-research-conclusion-rule-version">VOC 规则版本 {voc?.ruleVersion ?? "—"}（实时计算）</span>
              {detail.stale ? <Badge tone="amber">研究已过期，需重新确认</Badge> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-[13px] font-semibold text-emerald-800"
            data-testid="deep-research-refresh"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> 刷新结论
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid="deep-research-conclusion-voc">
            <p className="text-[12px] font-semibold text-slate-500">最重要的 VOC 观察</p>
            {topNegative ? (
              <>
                <p className="mt-1 text-[15px] font-bold text-slate-900">{topNegative.label}</p>
                <p className="mt-1 text-[13px] text-slate-600" data-testid="deep-research-conclusion-voc-counts">
                  明确负面 {topNegative.complaintCount} 条 · 提及 {topNegative.mentionCount} 条 · 可接受 {topNegative.toleratedCount} 条 · 待核对 {topNegative.uncertainCount} 条（样本 {topNegative.sampleDenominator} 条）
                </p>
                <p className="mt-1 text-[13px] text-slate-500">{(STRENGTH_META[topNegative.strength] ?? STRENGTH_META.insufficient).label}</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-[15px] font-bold text-slate-700">{topMention ? `${topMention.label}（仅提及）` : "暂无已复现的负面主题"}</p>
                <p className="mt-1 text-[13px] text-slate-500">
                  {topMention
                    ? `${topMention.mentionCount} 条评论提到该属性，其中明确负面 ${topMention.complaintCount} 条、可接受 ${topMention.toleratedCount} 条、待核对 ${topMention.uncertainCount} 条。`
                    : reviewSample && reviewSample.reviews > 0 ? `已读 ${reviewSample.reviews} 条评论，未达到复现门槛；不代表产品没有痛点。` : "当前没有可用评论证据，不能得出「没有痛点」的结论。"}
                </p>
              </>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid="deep-research-conclusion-comparison">
            <p className="text-[12px] font-semibold text-slate-500">主要竞品差异</p>
            {topDifference ? (
              <>
                <p className="mt-1 text-[15px] font-bold text-slate-900">{topDifference.dimension}</p>
                <p className="mt-1 text-[13px] text-slate-600">{topDifference.summary}</p>
                <p className="mt-1 text-[13px] text-slate-500">{topDifference.asins.length} 件代表商品参与</p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-slate-500">
                {comparison?.representativesSelected ? "代表商品事实不足，尚不能形成差异结论。" : "尚未选择代表商品，无法比较竞品。"}
              </p>
            )}
          </div>
          <div className="rounded-xl border border-emerald-200 bg-white p-3" data-testid="deep-research-conclusion-next">
            <p className="text-[12px] font-semibold text-slate-500">当前建议</p>
            <p className="mt-1 text-[15px] font-bold text-emerald-900">{recommendation.headline}</p>
            <p className="mt-1 text-[13px] text-slate-600">{recommendation.detail}</p>
            <Link href="#research-decision-section" className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-emerald-700 hover:underline">
              进入人工决策 <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>

        <p className="mt-3 text-[13px] text-slate-500">
          样本口径：评论 {reviewSample?.reviews ?? 0} 条（来自 {reviewSample?.attachments ?? 0} 个证据附件，覆盖 {reviewSample?.asins ?? 0} 个 ASIN）；代表商品 {comparison?.rows.length ?? 0} 件；有证据支持的开发方向 {opportunities?.opportunities.length ?? 0} 条。
          {" "}这些数字只说明「当前已读到的证据」，不等于市场规模或真实买家比例。
        </p>
      </section>}

      {/* ② VOC 痛点 */}
      {showSection("voc") && <SectionShell
        id="deep-research-voc"
        testId="deep-research-voc"
        step="第二部分 · 评论证据"
        title="VOC 痛点：哪些抱怨重复出现、来自哪件商品"
        description={
          <>
            每条主题都可追溯到具体 ASIN、证据附件和原文；样本不足时如实标注为弱信号，不升级为确定需求。
            <span className="mt-1 block text-[13px] text-slate-500" data-testid="deep-research-voc-source">
              当前 VOC 规则分析（规则版本 {voc?.ruleVersion ?? "—"}）：基于已读评论证据由确定性规则实时计算，与下方「历史 AI 研报」是两套独立分析；当前规则词典未覆盖的主题不会出现在本投影中。
            </span>
          </>
        }
        icon={<MessageSquareWarning className="size-4" />}
      >
        <VocSection voc={voc} />
      </SectionShell>}

      {/* ③ 竞品对比 */}
      {showSection("competitors") && <SectionShell
        id="deep-research-competitors"
        testId="deep-research-competitors"
        step={hideStep ? "" : "第三部分 · 代表商品"}
        title="竞品对比：哪些能直接比价、哪些规格不同"
        description="价格与规格只展示已有事实；包装数量仅从标题解析（没有已核实字段），缺失时不给每件单价，也不假设为单件。"
        icon={<BarChart3 className="size-4" />}
      >
        <ComparisonSection comparison={comparison} taskId={taskId} />
      </SectionShell>}

      {/* ④ 开发机会 */}
      {showSection("opportunities") && <SectionShell
        id="deep-research-opportunities"
        testId="deep-research-opportunities"
        step={hideStep ? "" : "第四部分 · 开发方向"}
        title="开发机会：用户问题 → 改进假设 → 待验证事项"
        description="改进假设只是待验证方向，不代表已有工程方案、成本或供应能力；人工决策与需求单仍走既有门禁。"
        icon={<Target className="size-4" />}
      >
        <OpportunitySection opportunities={opportunities} />
      </SectionShell>}

      {/* ⑤ 详细证据（折叠，不占首屏） */}
      {showSection("raw") && <details id="deep-research-raw" data-testid="deep-research-raw" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <summary className="flex cursor-pointer items-center gap-2 text-[15px] font-bold text-slate-800">
          <ChevronDown className="size-4" /> 详细证据与数据来源（展开查看）
        </summary>
        <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-slate-600">
          <p>生成时间：{data?.generatedAt ? new Date(data.generatedAt).toLocaleString("zh-CN") : "—"}；任务：<code>{taskId}</code></p>
          <p>读取评论附件：{voc?.attachmentsRead ?? 0} 个；去重后评论：{voc?.reviewsRead ?? 0} 条；因重复抑制：{voc?.duplicateReviewsSuppressed ?? 0} 条。</p>
          <p>涉及 ASIN：{(voc?.asins ?? []).join("、") || "无"}</p>
          {voc?.rejectedAttachments.length ? (
            <div>
              <p className="font-semibold text-slate-700">未采用的评论附件（状态不允许或无法解析）</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {voc.rejectedAttachments.map((item) => (
                  <li key={item.attachmentId}><code>{item.attachmentId}</code> · {item.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {comparison?.scanName ? <p>市场来源：{comparison.scanName}（{comparison.scanId}）</p> : null}
          <p className="text-slate-500">说明：本区块只读投影已存证据，不重新采集、不调用 AI、不写入研究结果。</p>
        </div>
      </details>}
    </div>
  );
}

function buildRecommendation(input: {
  voc: DeepResearchVocProjection | undefined;
  comparison: DeepResearchComparisonProjection | undefined;
  opportunities: DeepResearchOpportunityProjection | undefined;
}): { headline: string; detail: string } {
  const opportunities = input.opportunities?.opportunities ?? [];
  const recurring = opportunities.filter((item) => item.strength === "recurring").length;
  const weak = opportunities.filter((item) => item.strength === "weak").length;
  const reviews = input.voc?.reviewsRead ?? 0;
  if (recurring > 0) {
    return {
      headline: `有 ${recurring} 条已复现的开发方向，可进入人工判断`,
      detail: "这些方向有重复评论支持；仍需人工确认后再生成产品开发需求单，改进假设不等于可行方案。",
    };
  }
  if (weak > 0) {
    return {
      headline: `有 ${weak} 条弱信号（明确负面已达 2–3 条），建议继续验证`,
      detail: "明确负面反馈未达到复现门槛；可先补证据或做小范围验证，再决定是否立项。主题提及本身不算痛点。",
    };
  }
  if (reviews > 0) {
    return {
      headline: "当前证据不足以形成开发方向",
      detail: "已读评论中没有达到门槛的明确负面反馈（提及、可接受或语境不足的表述不计入投诉）；不代表产品无问题，需要更多独立评论或竞品对比。",
    };
  }
  return {
    headline: "尚无评论证据，不能判断痛点",
    detail: "需要先取得评论证据（来源采集），再判断是否存在可改进的痛点。",
  };
}

function VocSection({ voc }: { voc: DeepResearchVocProjection | undefined }) {
  if (!voc) return <p className="text-[15px] text-slate-500">暂无 VOC 投影。</p>;
  const negative = voc.themes.filter((theme) => theme.polarity === "negative");
  const positive = voc.themes.filter((theme) => theme.polarity !== "negative");
  if (!voc.reviewsRead) {
    return (
      <div data-testid="deep-research-voc-empty" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[15px] text-amber-900">
        当前没有可用的评论证据（读取 {voc.attachmentsRead} 个附件，0 条评论）。不能据此判断产品没有痛点；
        需要先在采集任务中取得评论，或由用户提供合法评论数据。
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-[15px] text-slate-600">
        已读 <strong>{voc.reviewsRead}</strong> 条去重评论（{voc.attachmentsRead} 个附件、{voc.asins.length} 个 ASIN）。
        主题计数以「独立评论」为单位，不是买家比例。
      </p>
      {negative.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[15px] text-slate-600" data-testid="deep-research-voc-no-negative">
          这批评论里没有可归因的负面主题。可能是样本偏正面，也可能是评论未覆盖问题；不能据此断定产品没有缺陷。
        </p>
      ) : (
        <ul className="space-y-3" data-testid="deep-research-voc-themes">
          {negative.map((theme) => (
            <VocThemeCard key={theme.id} theme={theme} />
          ))}
        </ul>
      )}
      {positive.length ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50/60 p-3" data-testid="deep-research-voc-positive">
          <summary className="cursor-pointer text-[14px] font-semibold text-slate-700">正面/中性主题（{positive.length} 个，仅供参考）</summary>
          <ul className="mt-2 space-y-1 text-[14px] text-slate-600">
            {positive.map((theme) => (
              <li key={theme.id}>
                {theme.label} · 正面 {theme.positiveCount} 条 / {theme.sampleDenominator} 条样本 · {(STRENGTH_META[theme.strength] ?? STRENGTH_META.insufficient).label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {voc.limitations.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="deep-research-voc-limitations">
          <p className="text-[14px] font-semibold text-amber-900">样本限制</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[14px] text-amber-900">
            {voc.limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function VocThemeCard({ theme }: { theme: DeepResearchVocTheme }) {
  const strength = STRENGTH_META[theme.strength] ?? STRENGTH_META.insufficient;
  return (
    <li className="rounded-xl border border-slate-200 p-3" data-testid={`deep-research-voc-theme-${theme.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-bold text-slate-900">{theme.label}</span>
        <Badge tone={strength.tone}>{strength.label}</Badge>
        <span className="text-[13px] text-slate-500">{theme.asins.join("、")}</span>
      </div>
      <p className="mt-1 text-[14px] text-slate-600" data-testid={`deep-research-voc-counts-${theme.id}`}>
        明确负面 <strong>{theme.complaintCount}</strong> 条 · 提及 <strong>{theme.mentionCount}</strong> 条 · 可接受 {theme.toleratedCount} 条 · 待核对 {theme.uncertainCount} 条 · 正面 {theme.positiveCount} 条 / 样本 {theme.sampleDenominator} 条
        {theme.perAsin.length > 1 ? ` · 分商品：${theme.perAsin.map((item) => `${item.asin} ${item.count}/${item.denominator}`).join("；")}` : ""}
      </p>
      {theme.quotes.length ? (
        <ul className="mt-2 space-y-1.5">
          {theme.quotes.map((quote, index) => (
            <li key={`${quote.attachmentId}-${index}`} className="rounded-lg bg-slate-50 p-2 text-[14px] leading-relaxed text-slate-700">
              <Badge tone={quote.intent === "complaint" ? "rose" : quote.intent === "tolerated" ? "amber" : quote.intent === "uncertain" ? "slate" : "blue"}>
                {INTENT_LABEL[quote.intent] ?? quote.intent}
              </Badge>
              <span className="mx-1 font-mono text-[12px] text-slate-500">{quote.asin}</span>
              {quote.rating !== null ? <span className="mr-1 text-[12px] text-slate-500">{quote.rating}★</span> : null}
              {quote.reviewDate ? <span className="mr-1 text-[12px] text-slate-400">{formatReviewDate(quote.reviewDate)}</span> : null}
              「{quote.excerpt}」
            </li>
          ))}
        </ul>
      ) : null}
      {theme.limitations.length ? (
        <p className="mt-1 text-[13px] text-amber-800">{theme.limitations.join("；")}</p>
      ) : null}
    </li>
  );
}

function ComparisonSection({ comparison, taskId }: { comparison: DeepResearchComparisonProjection | undefined; taskId: string }) {
  if (!comparison) return <p className="text-[15px] text-slate-500">暂无竞品投影。</p>;
  if (!comparison.representativesSelected || comparison.rows.length === 0) {
    return (
      <div data-testid="deep-research-comparison-empty" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[15px] text-amber-900">
        还没有选定代表商品（基准商品 / 痛点样本 / 新进入者）。请先在 02 市场研究中选定代表商品并保存，再回到本页查看可比性分析。
        <Link href="/market-analysis" className="ml-2 inline-flex items-center gap-1 font-semibold text-amber-900 underline">
          去市场研究 <ArrowRight className="size-3" />
        </Link>
        <p className="mt-1 text-[13px]">任务：<code>{taskId}</code></p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {comparison.differences.length ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3" data-testid="deep-research-comparison-differences">
          <p className="text-[14px] font-semibold text-slate-800">有事实支持的差异</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[14px] text-slate-700">
            {comparison.differences.map((item) => <li key={item.dimension}><strong>{item.dimension}</strong>：{item.summary}</li>)}
          </ul>
        </div>
      ) : null}
      <p className="text-[13px] text-slate-500" data-testid="deep-research-comparison-unitprice-note">
        每件单价与可比性按<strong className="font-semibold text-slate-700">整组</strong>判定：组内任一商品缺包装数量或价格时，全组都不计算每件单价（所以本行有包装数量也可能显示「不计算」）。
      </p>
      <div className="overflow-x-auto lc-comparison-table-wrap">
        <table className="w-full min-w-[720px] border-collapse text-left text-[14px]" data-testid="deep-research-comparison-table">
          <thead>
            <tr className="text-[12px] uppercase tracking-wide text-slate-500">
              <th className="border-b border-slate-200 py-2 pr-3">代表商品</th>
              <th className="border-b border-slate-200 py-2 pr-3">价格</th>
              <th className="border-b border-slate-200 py-2 pr-3">包装数量</th>
              <th className="border-b border-slate-200 py-2 pr-3">每件单价</th>
              <th className="border-b border-slate-200 py-2 pr-3">评分 / 评论</th>
              <th className="border-b border-slate-200 py-2 pr-3">可比性</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => {
              const meta = COMPARABILITY_META[row.comparability.level] ?? COMPARABILITY_META.unknown;
              return (
                <tr key={row.asin} data-testid={`deep-research-comparison-row-${row.asin}`}>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">
                    <div className="font-semibold text-slate-900">{row.roleLabel}</div>
                    <div className="font-mono text-[12px] text-slate-500">{row.asin}</div>
                    <div className="mt-0.5 line-clamp-2 max-w-[320px] text-[13px] text-slate-600">{row.title ?? "标题缺失"}</div>
                    {row.specs.length ? <div className="mt-1 text-[12px] text-slate-500">{row.specs.map((spec) => `${spec.label} ${spec.value}`).join(" · ")}</div> : null}
                  </td>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">{formatMoney(row.price)}</td>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">
                    {row.packCount ? (
                      <span className="inline-flex flex-col">
                        <span className="font-semibold text-slate-900">{row.packCount.value} 件</span>
                        <span className="text-[12px] text-slate-500">标题推断</span>
                      </span>
                    ) : (
                      <span className="inline-flex flex-col">
                        <span className="text-slate-400">缺失</span>
                        <span className="text-[12px] text-slate-400">不计每件单价</span>
                      </span>
                    )}
                  </td>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">
                    {row.unitPrice ? formatMoney(row.unitPrice) : <span className="text-slate-400">不计算</span>}
                  </td>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">
                    {row.rating ?? "—"} / {row.reviewCount ?? "—"}
                  </td>
                  <td className="border-b border-slate-100 py-2 pr-3 align-top">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <div className="mt-1 max-w-[200px] text-[12px] text-slate-500">{row.comparability.reason}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 窄屏：同一份数据改用卡片呈现，避免表格被横向裁切 */}
      <ul className="lc-comparison-cards" data-testid="deep-research-comparison-cards">
        {comparison.rows.map((row) => {
          const meta = COMPARABILITY_META[row.comparability.level] ?? COMPARABILITY_META.unknown;
          return (
            <li key={`card-${row.asin}`}>
              <div className="lc-comparison-card-head">
                <strong>{row.roleLabel}</strong>
                <span>{row.asin}</span>
              </div>
              <p className="lc-comparison-card-title">{row.title ?? "标题缺失"}</p>
              <dl className="lc-comparison-card-grid">
                <div><dt>价格</dt><dd>{formatMoney(row.price)}</dd></div>
                <div>
                  <dt>包装数量</dt>
                  <dd>
                    {row.packCount ? <>{row.packCount.value} 件<em>标题推断</em></> : <>缺失<em>不计每件单价</em></>}
                  </dd>
                </div>
                <div><dt>每件单价</dt><dd>{row.unitPrice ? formatMoney(row.unitPrice) : "不计算"}</dd></div>
                <div><dt>评分 / 评论</dt><dd>{row.rating ?? "—"} / {row.reviewCount ?? "—"}</dd></div>
              </dl>
              <div className="lc-comparison-card-compare">
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span>{row.comparability.reason}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {comparison.limitations.length ? (
        <details className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[14px] text-amber-900" data-testid="deep-research-comparison-limitations">
          <summary className="cursor-pointer font-semibold">比较限制与缺失依据（{comparison.limitations.length} 项）</summary>
          <div className="mt-3">{comparison.limitations.map((item) => <p key={item}>· {item}</p>)}</div>
        </details>
      ) : null}
    </div>
  );
}

function OpportunitySection({ opportunities }: { opportunities: DeepResearchOpportunityProjection | undefined }) {
  if (!opportunities) return <p className="text-[15px] text-slate-500">暂无开发机会投影。</p>;
  if (opportunities.opportunities.length === 0) {
    return (
      <div className="space-y-2">
        <div data-testid="deep-research-opportunities-empty" className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[15px] text-slate-700">
          当前证据不足以形成「可开发机会」。这通常意味着：评论样本太少、负面主题未达复现门槛，或缺少可比代表商品。
          系统不会用一条抱怨拼出产品需求。
        </div>
        {opportunities.excluded.length ? (
          <details open className="rounded-xl border border-slate-200 p-3">
            <summary className="cursor-pointer text-[14px] font-semibold text-slate-700">未构成机会的观察（{opportunities.excluded.length} 条）</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-slate-600" data-testid="deep-research-opportunities-excluded">
            {opportunities.excluded.map((item) => <li key={item.theme}>{item.theme}：{item.reason}</li>)}
          </ul>
          </details>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-3" data-testid="deep-research-opportunity-list">
        {opportunities.opportunities.map((item) => {
          const strength = STRENGTH_META[item.strength] ?? STRENGTH_META.insufficient;
          return (
            <li key={item.id} className="rounded-xl border border-emerald-200 bg-white p-4" data-testid={`deep-research-opportunity-${item.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={strength.tone}>{strength.label}</Badge>
                <span className="text-[15px] font-bold text-slate-900">{item.problem}</span>
              </div>
              {item.evidence.length ? (
                <details className="mt-3 border-t border-slate-100 pt-3">
                  <summary className="cursor-pointer text-[14px] text-slate-600">原文依据（{item.evidence.length} 条）</summary>
                <ul className="mt-2 space-y-1">
                  {item.evidence.map((evidence, index) => (
                    <li key={`${evidence.attachmentId}-${index}`} className="rounded-lg bg-slate-50 p-2 text-[14px] leading-relaxed text-slate-700">
                      <span className="mr-1 font-mono text-[12px] text-slate-500">{evidence.asin}</span>
                      {evidence.rating !== null ? <span className="mr-1 text-[12px] text-slate-500">{evidence.rating}★</span> : null}
                      「{evidence.excerpt}」
                    </li>
                  ))}
                </ul>
                </details>
              ) : null}
              <p className="mt-2 text-[14px] text-slate-700"><strong>竞品现状：</strong>{item.competitorStatus}</p>
              <p className="mt-1 text-[14px] text-emerald-900"><strong>改进假设（待验证）：</strong>{item.hypothesis}</p>
              <div className="mt-1 text-[14px] text-slate-700">
                <strong>待验证事项：</strong>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {item.validations.map((validation) => <li key={validation}>{validation}</li>)}
                </ul>
              </div>
              <p className="mt-2 text-[13px] text-slate-500">人工处理状态：待人工确认（系统不自动采纳为开发要求）</p>
            </li>
          );
        })}
      </ul>
      {opportunities.excluded.length ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50/60 p-3" data-testid="deep-research-opportunities-excluded">
          <summary className="cursor-pointer text-[14px] font-semibold text-slate-700">未构成机会的观察（{opportunities.excluded.length} 条）</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[14px] text-slate-600">
            {opportunities.excluded.map((item) => <li key={item.theme}>{item.theme}：{item.reason}</li>)}
          </ul>
        </details>
      ) : null}
      {opportunities.limitations.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[14px] text-amber-900">
          {opportunities.limitations.map((item) => <p key={item}>· {item}</p>)}
        </div>
      ) : null}
      <p className="flex items-center gap-1.5 text-[13px] text-slate-500">
        <AlertTriangle className="size-3.5" />
        这些只是研究建议：需要人工确认后，才会进入产品开发需求单；系统不会自动采纳或自动批准。
      </p>
      <Link href="#research-decision-section" className="inline-flex items-center gap-1 text-[14px] font-semibold text-emerald-700 hover:underline">
        <ClipboardList className="size-3.5" /> 去人工决策区确认方向
      </Link>
    </div>
  );
}
