"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowRight, FileText, Loader2, RefreshCw, ShieldAlert, Lock } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ValidationBriefPanel } from "@/components/research/ValidationBriefPanel";
import type {
  BuildCommercialFeasibilityInput,
  CommercialFeasibilityView,
  HumanDecisionGate,
} from "@/lib/research/commercialFeasibility";

type TraceableItem = {
  id: string;
  kind: string;
  text: string;
  nature: "confirmed_fact" | "derived" | "recommendation" | "assumption";
  evidenceRefs: string[];
  validationRequired: boolean;
};

type ProductConcept = {
  conceptId: string;
  revision: number;
  generatedAt: string;
  aiSummary: string | null;
  model: string | null;
  missingValidation: string[];
  traceableItems?: TraceableItem[];
  sourceBinding?: {
    researchRevision: number;
    reportHash: string;
    factHash: string;
    evidenceHash: string;
  };
};

type ConceptData = {
  concept: ProductConcept | null;
  stale: boolean;
  staleReason: string | null;
};

const natureLabels: Record<TraceableItem["nature"], string> = {
  confirmed_fact: "确认事实",
  derived: "证据推导",
  recommendation: "建议",
  assumption: "假设",
};

const itemKindLabels: Record<string, string> = {
  confirmed_fact: "确认事实",
  research_summary: "研究摘要",
  research_opportunity: "市场机会",
  research_risk: "研究风险",
  research_voc_pain: "买家痛点",
  research_voc_positive: "正向信号",
  research_voc_failure: "失败模式",
  research_voc_use_case: "使用场景",
  research_voc_replacement: "替代信号",
  research_voc_switch: "切换原因",
  research_voc_ownership: "所有权自述",
  assumption: "假设",
};

/** 把服务端字段路径（basic.brand 等）映射为用户语言；未知路径原样展示，不猜测。 */
const FIELD_PATH_LABELS: Record<string, string> = {
  "basic.brand": "品牌",
  "basic.bulletPoints": "五点描述",
  "basic.category": "类目",
  "basic.price": "价格",
  "basic.rating": "评分",
  "basic.reviews": "评论数",
  "extended.amazonDetail": "Amazon 详情数据",
  "extended.bsrRanks": "BSR 排名",
  isMinorVariation: "变体销售拆解",
};

function humanizeValidationItem(item: string): string {
  return FIELD_PATH_LABELS[item] ?? item;
}

/**
 * 03 商品深研的收尾区块：产品方向摘要 + 进入 04 产品开发需求单的唯一入口。
 * 只读展示（不提供重新生成按钮）；摘要优先取已存档的产品概念快照（可追溯哈希），
 * 概念缺失时回退展示研报执行摘要；两者都没有时诚实显示暂无数据。
 */
export interface ProductConceptV5PanelProps {
  taskId: string;
  disabled?: boolean;
  /** 研报执行摘要：概念快照缺失时的回退摘要（同为真实研究产出，非臆造）。 */
  fallbackSummary?: string | null;
  researchBindingKey?: string;
  /** 人工决策状态（严格来自 Human Decision） */
  humanDecisionGate?: HumanDecisionGate | string | null;
  /**
   * 人工决策是否已与当前研究版本脱钩（服务端 stale 判定投影）。
   * 为 true 时：保留历史决策，但不得解锁「验证需求单」——必须先由人工重新确认。
   */
  humanDecisionStale?: boolean;
  humanDecisionStaleReason?: string | null;
  /** Validation Brief Panel（第一版）上下文数据 */
  briefContext?: {
    asin: string;
    title?: string | null;
    role?: string | null;
    facts?: Record<string, unknown> | null;
    feasibilityView?: CommercialFeasibilityView;
    input?: BuildCommercialFeasibilityInput;
  };
}

export function ProductConceptV5Panel({
  taskId,
  disabled = false,
  fallbackSummary = null,
  researchBindingKey = "",
  humanDecisionGate = null,
  humanDecisionStale = false,
  humanDecisionStaleReason = null,
  briefContext,
}: ProductConceptV5PanelProps) {
  const [data, setData] = useState<ConceptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showValidationBrief, setShowValidationBrief] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/product-concept`, { headers: buildAccessHeaders(), cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error(json?.error?.message ?? `读取产品方向摘要失败 (${response.status})`);
      const next = json?.data ?? json;
      setData({ concept: next?.concept ?? null, stale: next?.stale === true, staleReason: next?.staleReason ?? null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取产品方向摘要失败。");
    } finally { setLoading(false); }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload, researchBindingKey]);

  const concept = data?.concept ?? null;
  const stale = data?.stale === true;
  const summary = concept?.aiSummary ?? fallbackSummary ?? null;
  const summarySource = concept?.aiSummary
    ? `产品概念快照 rev.${concept.revision}`
    : fallbackSummary
      ? "研报执行摘要"
      : null;

  return (
    <section aria-labelledby="product-concept-v5-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-[13px] font-semibold text-emerald-700">03 商品深研 · 收尾</span>
            {stale && <Badge tone="rose">研究已更新 · 摘要待刷新</Badge>}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <FileText className="size-4 text-emerald-700" />
            <h2 id="product-concept-v5-heading" className="text-sm font-bold text-slate-900">产品方向摘要</h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            汇总当前研究的商品事实、证据与结论，给出该商品的产品方向。确认方向成立后，进入 04 生成完整的产品开发需求单。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> 刷新
        </Button>
      </div>

      {stale && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />研究版本 / 报告 / 事实或证据已更新。下方摘要基于旧版本生成，请先回到上方完成研报更新与重新确认。</p>}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-400"><Loader2 className="size-4 animate-spin" />正在检查研究状态…</div>
      ) : summary ? (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/50 p-3.5 text-xs leading-relaxed text-slate-700">
          <p className="whitespace-pre-line">{summary}</p>
          {summarySource && <p className="mt-2 text-[12px] text-slate-400">摘要来源：{summarySource}{concept?.model ? ` · ${concept.model}` : ""}</p>}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
          <p className="font-medium text-slate-700">暂无数据：该研究还没有可提炼的方向摘要</p>
          <p className="mt-1 text-[13px] text-slate-400">完成第 2 步深度研报后，这里会自动呈现研究结论与产品方向。</p>
        </div>
      )}

      {concept?.traceableItems?.length ? (
        <ul className="mt-3 space-y-2">
          {concept.traceableItems.slice(0, 6).map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={item.nature === "confirmed_fact" ? "emerald" : item.nature === "assumption" ? "amber" : item.nature === "recommendation" ? "purple" : "blue"}>{natureLabels[item.nature]}</Badge>
                <Badge tone="slate">{itemKindLabels[item.kind] ?? item.kind}</Badge>
                {item.validationRequired && <span className="text-[12px] text-amber-700">需验证</span>}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-800">{item.text}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {concept && concept.missingValidation.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <h3 className="text-xs font-semibold text-amber-900">假设与待验证项</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-amber-800">
            {concept.missingValidation.slice(0, 8).map((item, index) => <li key={`${index}:${item}`}>{humanizeValidationItem(item)}</li>)}
          </ul>
        </div>
      )}

      {/* 出口分流：根据人工决策状态与决策有效性严密分流 */}
      {humanDecisionGate === "VALIDATE_MORE" && humanDecisionStale ? (
        <div
          data-testid="concept-exit-decision-stale"
          className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4"
        >
          <div>
            <div className="flex items-center gap-1.5">
              <Lock className="size-3.5 text-rose-600" />
              <span className="text-[13px] font-bold text-rose-900">原人工决策已失效，需重新确认</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-rose-800">
              研究版本 / 报告 / 事实或证据已更新，原「需补充验证」决策不再对应当前研究版本。
              <strong>历史决策记录已保留，未被改写</strong>；请先在上方重新完成人工决断，验证需求单才会按最新证据重新解锁。
            </p>
            {humanDecisionStaleReason && (
              <p className="mt-1 text-[12px] font-mono text-rose-700">staleReason: {humanDecisionStaleReason}</p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled
            className="shrink-0 text-rose-400 cursor-not-allowed"
            title="原人工决策已失效，需重新确认后才能生成验证需求单"
          >
            生成验证需求单 (需重新确认)
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
        </div>
      ) : humanDecisionGate === "VALIDATE_MORE" ? (
        <div
          data-testid="concept-exit-validate-more"
          className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-blue-300 bg-blue-50/80 p-4"
        >
          <div>
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-blue-100 text-blue-800 px-1.5 py-0.5 text-[12px] font-bold">
                人工决断：需补充验证 (VALIDATE_MORE)
              </span>
              <span className="text-[12px] text-blue-700 bg-white border border-blue-200 px-1.5 py-0.2 rounded font-medium">
                第一版 · 验证链路闭环
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-blue-950">
              当前处于补充验证阶段。可生成前置验证需求单，用于向工厂/供应商核对底价、起订量与包装缺口（非正式立项）。
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setShowValidationBrief(true)}
            className="shrink-0 bg-blue-700 hover:bg-blue-800 text-white"
          >
            生成验证需求单
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
        </div>
      ) : humanDecisionGate === "PROCEED" ? (
        <div
          data-testid="concept-exit-proceed"
          className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50/80 p-4"
        >
          <div>
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-emerald-100 text-emerald-800 px-1.5 py-0.5 text-[12px] font-bold">
                人工决断：已继续推进 (PROCEED)
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-emerald-900">
              方向确认后，基于商品事实、买家声音与研究结论生成产品开发需求单（进入 04 正式立项与投产准备度文档）。
            </p>
          </div>
          {disabled ? (
            <Button size="sm" variant="primary" disabled title="完成深度研报后可进入产品开发需求单" className="shrink-0">
              生成产品开发需求单
              <ArrowRight className="ml-1 size-3.5" />
            </Button>
          ) : (
            <Link
              href={`/product-brief?taskId=${encodeURIComponent(taskId)}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-800 transition"
            >
              生成产品开发需求单
              <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      ) : (
        <div
          data-testid="concept-exit-gate-locked"
          className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <div>
            <div className="flex items-center gap-1.5 text-slate-600">
              <Lock className="size-3.5 text-slate-500" />
              <span className="text-[13px] font-bold text-slate-700">
                前置决断门禁未解锁
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              需先在上方第 5 步完成人工商业决断：选择「继续推进」可生成正式需求单；选择「需补充验证」可生成验证需求单。
            </p>
          </div>
          <Button size="sm" variant="outline" disabled className="shrink-0 text-slate-400 cursor-not-allowed">
            生成需求单 (需先决断)
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
        </div>
      )}

      {briefContext && (
        <ValidationBriefPanel
          isOpen={showValidationBrief}
          onClose={() => setShowValidationBrief(false)}
          asin={briefContext.asin}
          title={briefContext.title}
          role={briefContext.role}
          feasibilityView={briefContext.feasibilityView}
          input={briefContext.input}
          summary={summary}
        />
      )}

      {concept?.sourceBinding && (
        <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700 hover:text-slate-900">
            技术详情与版本追溯（哈希与引用依据）
          </summary>
          <div className="mt-2 grid gap-1 border-t border-slate-200 pt-2 font-mono text-[12px] text-slate-500 sm:grid-cols-2">
            <span>研究版本: rev.{concept.sourceBinding.researchRevision}</span>
            <span>报告哈希: {concept.sourceBinding.reportHash.slice(0, 16)}…</span>
            <span>事实哈希: {concept.sourceBinding.factHash.slice(0, 16)}…</span>
            <span>证据哈希: {concept.sourceBinding.evidenceHash.slice(0, 16)}…</span>
          </div>
        </details>
      )}

      {error && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"><AlertCircle className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
    </section>
  );
}
