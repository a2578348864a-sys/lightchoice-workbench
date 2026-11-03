"use client";

import React, { useMemo } from "react";
import {
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  ShieldAlert,
  ArrowRight,
  Info,
  Lock,
} from "lucide-react";
import {
  buildCommercialFeasibility,
  type BuildCommercialFeasibilityInput,
  type CommercialFeasibilityView,
  type HumanDecisionGate,
} from "@/lib/research/commercialFeasibility";
import { describeVocThemeStrength } from "@/lib/research/vocThresholds";

export interface OpportunityValidationCardProps {
  readonly title?: string | null;
  readonly asin: string;
  readonly role?: "benchmark" | "newcomer" | "pain_point" | string | null;
  /** 可直接传入已构建好的 feasibilityView */
  readonly feasibilityView?: CommercialFeasibilityView;
  /** 或传入原始构建参数，由组件内部纯函数构建 */
  readonly input?: BuildCommercialFeasibilityInput;
  /** 外部传入的建议下一步（如来自 decisionDelivery），只允许三态 */
  readonly nextAction?: "继续研究" | "补充数据" | "暂停" | null;
}

const ROLE_DISPLAY_MAP: Record<string, { label: string; tagClass: string }> = {
  benchmark: {
    label: "基准品 (Benchmark)",
    tagClass: "bg-blue-50 text-blue-800 border-blue-200",
  },
  newcomer: {
    label: "新晋品 (Newcomer)",
    tagClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
  pain_point: {
    label: "痛点品 (Pain Point)",
    tagClass: "bg-rose-50 text-rose-800 border-rose-200",
  },
};

const HUMAN_DECISION_META: Record<
  HumanDecisionGate,
  { label: string; badgeClass: string }
> = {
  PENDING: {
    label: "未决断 (PENDING)",
    badgeClass: "bg-slate-100 text-slate-700 border-slate-300",
  },
  VALIDATE_MORE: {
    label: "需补充验证 (VALIDATE_MORE)",
    badgeClass: "bg-blue-100 text-blue-800 border-blue-300",
  },
  PROCEED: {
    label: "继续推进 (PROCEED)",
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300",
  },
  PAUSE: {
    label: "加入观察 (PAUSE)",
    badgeClass: "bg-amber-100 text-amber-800 border-amber-300",
  },
  DROP: {
    label: "放弃 (DROP)",
    badgeClass: "bg-rose-100 text-rose-800 border-rose-300",
  },
  WATCH: {
    label: "加入观察 (WATCH)",
    badgeClass: "bg-amber-100 text-amber-800 border-amber-300",
  },
};

/**
 * V6 Opportunity Validation Card（产品机会验证摘要）
 * 
 * 定位：ResearchDetail 页面上的轻量决策辅助摘要层。
 * 核心目标：让用户在 10 秒内理解：
 * 1. 当前商品是什么角色
 * 2. 有没有值得继续验证的机会信号
 * 3. 信号依据是什么
 * 4. 为什么现在不能直接进入产品开发
 * 5. 下一步应该验证什么
 * 
 * 架构红线：
 * - 纯展示组件，Props 仅消费已有 ResearchDetail 数据
 * - 零 API 请求、零 DB 读写、零新 Schema、零第二事实源
 * - 独立评论数 ≠ 主题提及数，无正式 VOC 绝不编造
 * - 禁止生成具体产品方案（禁止“开发0.7mm加厚款”等臆测）
 * - 所有 AI 推断必标：“AI 推断，非事实证据，需要人工验证”
 * - 下一步仅限三态：继续研究 / 补充数据 / 暂停
 * - 严禁自动推荐开发、立即立项、自动 PROCEED
 */
export function OpportunityValidationCard({
  title,
  asin,
  role,
  feasibilityView,
  input,
  nextAction,
}: OpportunityValidationCardProps) {
  // 1. 获取四层商业可行性视图片元
  const view = useMemo(() => {
    if (feasibilityView) return feasibilityView;
    if (input) return buildCommercialFeasibility(input);
    // 兜底最小构建
    return buildCommercialFeasibility({
      asin,
      title,
      marketProvenance: role ? { role } : undefined,
    });
  }, [feasibilityView, input, asin, title, role]);

  // 2. 解析角色与人工决策状态
  const effectiveRole = role || view.role || "未指定角色";
  const roleMeta =
    ROLE_DISPLAY_MAP[effectiveRole.toLowerCase()] ?? {
      label: effectiveRole,
      tagClass: "bg-slate-100 text-slate-800 border-slate-200",
    };

  const humanGate = view.commercialAssessment.decisionSupport.currentGate;
  const humanDecisionMeta =
    HUMAN_DECISION_META[humanGate] ?? HUMAN_DECISION_META.PENDING;
  const decisionStale = view.commercialAssessment.decisionSupport.humanDecided
    && view.commercialAssessment.decisionSupport.decisionStale;

  // 3. 解析正式 VOC 信号（严格区分独立评论与主题提及）
  const buyerVoc = view.buyerVoc;
  const hasFormalVoc = buyerVoc.state === "AVAILABLE";
  const independentCount = buyerVoc.independentReviewCount;
  const mentionCount = buyerVoc.themeMentionCount;

  // 最多各取 2 个主题
  const topPositives = buyerVoc.positiveSignals.slice(0, 2);
  const topNegatives = buyerVoc.negativeSignals.slice(0, 2);

  // 4. 解析验证方向（禁止生成具体产品方案，仅泛化方向与依据）
  const verificationDirection = useMemo(() => {
    if (!hasFormalVoc && view.aiInferences.length === 0) {
      return {
        direction: "暂无明确产品机会验证方向（等待正式买家反馈或研报数据补齐）",
        premise: "尚无充分的正式 VOC 分析或研报机会点支持",
        state: "待验证",
      };
    }

    if (topNegatives.length > 0) {
      const mainPain = topNegatives[0].text.split("：")[0] || "买家体验痛点";
      const strength = describeVocThemeStrength(topNegatives[0].reviewCount ?? 0);
      return {
        direction: `针对「${mainPain}」——${strength.evidencePhrase}；存在体验与稳定性优化验证方向`,
        premise: `正式 VOC 分析：独立评论 ${independentCount ?? "未记录"} 条、主题提及 ${mentionCount} 次；该主题提及 ${topNegatives[0].reviewCount ?? 0} 次（strength=${strength.strength}）。`,
        state: "待验证",
      };
    }

    if (topPositives.length > 0) {
      const mainAdv = topPositives[0].text.split("：")[0] || "核心优势";
      const strength = describeVocThemeStrength(topPositives[0].reviewCount ?? 0);
      return {
        direction: `在保持「${mainAdv}」正向认可的前提下，探索成本与包装效率优化方向`,
        premise: `正式 VOC 分析：独立评论 ${independentCount ?? "未记录"} 条、主题提及 ${mentionCount} 次；正向主题提及 ${topPositives[0].reviewCount ?? 0} 次（strength=${strength.strength}）。`,
        state: "待验证",
      };
    }

    return {
      direction: "存在基础品类体验优化与性能对标验证方向",
      premise: "来自市场基础属性与定位推断，缺乏深度原声验证",
      state: "待验证",
    };
  }, [hasFormalVoc, topNegatives, topPositives, view.aiInferences, independentCount, mentionCount]);

  // 5. 解析验证缺口（为什么不能直接进入产品开发）
  const criticalGaps = useMemo(() => {
    return view.commercialAssessment.dataGaps.slice(0, 3);
  }, [view.commercialAssessment.dataGaps]);

  // 6. 解析下一步动作（严格三态：继续研究 / 补充数据 / 暂停）
  const effectiveNextAction = useMemo<"继续研究" | "补充数据" | "暂停" | null>(() => {
    if (nextAction === "继续研究" || nextAction === "补充数据" || nextAction === "暂停") {
      return nextAction;
    }
    return null;
  }, [nextAction]);

  return (
    <section
      data-testid="opportunity-validation-card"
      aria-labelledby="opportunity-validation-heading"
      className="rounded-2xl border-2 border-indigo-200/90 bg-linear-to-b from-indigo-50/40 via-white to-slate-50/30 p-5 shadow-xs space-y-4"
    >
      {/* 顶部标题与双状态指示 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100/80 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-xs">
            <Lightbulb className="size-4" />
          </span>
          <div>
            <h2
              id="opportunity-validation-heading"
              className="text-sm font-bold text-slate-900 tracking-tight flex items-center gap-2"
            >
              产品机会验证摘要
              <span className="text-[12px] font-normal text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">
                10 秒速览 · 决策辅助层
              </span>
            </h2>
          </div>
        </div>

        {/* 人工决策与系统建议严格分离 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div
            data-testid="opportunity-human-decision"
            className="flex items-center gap-1.5 bg-white border border-slate-200 px-2.5 py-1 rounded-lg"
          >
            <Lock className="size-3 text-slate-500" />
            <span className="text-[13px] text-slate-500">{decisionStale ? "历史决定 · 需重新确认" : "人工决策:"}</span>
            <span
              className={`rounded px-1.5 py-0.2 font-mono text-[12px] font-bold border ${decisionStale ? "bg-amber-100 text-amber-800 border-amber-300" : humanDecisionMeta.badgeClass}`}
            >
              {humanDecisionMeta.label}
            </span>
          </div>

          <div
            data-testid="opportunity-system-suggestion"
            className="flex items-center gap-1.5 bg-white border border-violet-200 px-2.5 py-1 rounded-lg"
          >
            <Info className="size-3 text-violet-600" />
            <span className="text-[13px] text-violet-700 font-medium">
              系统建议（非人工决策）:
            </span>
            <span className="rounded bg-violet-50 text-violet-800 border border-violet-200 px-1.5 py-0.2 font-mono text-[12px] font-bold">
              {effectiveNextAction ?? "暂不可用"}
            </span>
          </div>
        </div>
      </div>

      {/* 模块 1：商品身份与代表样本角色 */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-white p-3.5 rounded-xl border border-slate-200/80 items-center">
        <div className="sm:col-span-8 min-w-0">
          <span className="text-[12px] font-medium text-slate-400 block mb-0.5">
            当前评估商品 (ASIN: {asin})
          </span>
          <p className="text-xs font-semibold text-slate-900 truncate" title={title || asin}>
            {title || "无标题商品"}
          </p>
        </div>

        <div className="sm:col-span-4 flex items-center sm:justify-end gap-2">
          <span className="text-[13px] text-slate-500">样本角色:</span>
          <span
            data-testid="opportunity-role-badge"
            className={`rounded-md px-2 py-0.5 text-xs font-bold border ${roleMeta.tagClass}`}
          >
            {roleMeta.label}
          </span>
        </div>
      </div>

      {/* 模块 2 & 3：当前信号 (正式 VOC) 与 验证方向 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 模块 2：当前信号 (Signals) */}
        <div
          data-testid="opportunity-signals"
          className="rounded-xl border border-slate-200/90 bg-white p-3.5 space-y-2.5 flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 mb-2">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-indigo-600" />
                当前机会信号 (真实买家原声)
              </span>
              <span
                data-testid="opportunity-voc-state"
                className={`font-mono text-[12px] font-semibold px-1.5 py-0.2 rounded border ${
                  hasFormalVoc
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-100 text-slate-500 border-slate-200"
                }`}
              >
                {buyerVoc.state}
              </span>
            </div>

            {hasFormalVoc ? (
              <div className="space-y-2 text-xs">
                {/* 独立评论数严格区分主题提及次数 */}
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-100 text-[13px] text-slate-600">
                  <span className="font-semibold text-slate-700">样本基础：</span>
                  {independentCount !== null ? (
                    <span>
                      独立评论 <b>{independentCount}</b> 条，累计主题提及 <b>{mentionCount}</b> 次
                    </span>
                  ) : (
                    <span>
                      累计主题提及 <b>{mentionCount}</b> 次（独立评论数未随快照记录）
                    </span>
                  )}
                  <span className="block text-[12px] text-slate-400 mt-0.5">
                    * 独立评论数 ≠ 主题提及次数（同一评论可涉及多个主题，不混充独立样本）
                  </span>
                </div>

                {/* 正向主题 */}
                {topPositives.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[12px] font-bold text-emerald-800 uppercase tracking-wider block">
                      主要正向信号（最多 2 个）：
                    </span>
                    <ul className="space-y-1 text-[13px] text-slate-700">
                      {topPositives.map((sig, idx) => (
                        <li key={idx} className="flex items-start gap-1">
                          <span className="text-emerald-600 font-bold shrink-0">✓</span>
                          <span className="line-clamp-1">{sig.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 负向痛点 */}
                {topNegatives.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[12px] font-bold text-rose-800 uppercase tracking-wider block">
                      主要痛点信号（最多 2 个）：
                    </span>
                    <ul className="space-y-1 text-[13px] text-slate-700">
                      {topNegatives.map((sig, idx) => (
                        <li key={idx} className="flex items-start gap-1">
                          <span className="text-rose-600 font-bold shrink-0">!</span>
                          <span className="line-clamp-1">{sig.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div
                data-testid="opportunity-no-voc"
                className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-3 text-center text-xs text-slate-500 space-y-1"
              >
                <p className="font-semibold text-slate-700">暂无正式 VOC 数据</p>
                <p className="text-[13px] text-slate-400">
                  当前商品未完成正式 VOC 分析；这不等于没有评论证据（已合法采集的评论见「VOC 痛点」层）。系统拒绝以 AI 脑补或默认话术填充虚假痛点。
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 模块 3：验证方向 (Direction) */}
        <div
          data-testid="opportunity-direction"
          className="rounded-xl border border-purple-200/80 bg-purple-50/20 p-3.5 space-y-2.5 flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between border-b border-purple-100 pb-1.5 mb-2">
              <span className="text-xs font-bold text-purple-950 flex items-center gap-1.5">
                <Lightbulb className="size-3.5 text-purple-600" />
                验证方向 (Direction)
              </span>
              <span className="text-[12px] font-semibold text-purple-700 bg-purple-50 px-1.5 py-0.2 rounded border border-purple-200">
                状态: {verificationDirection.state}
              </span>
            </div>

            <div className="space-y-2 text-xs">
              <div>
                <span className="text-[12px] font-bold text-purple-800 uppercase tracking-wider block mb-0.5">
                  验证方向：
                </span>
                <p className="text-slate-800 text-[13px] leading-relaxed font-medium">
                  {verificationDirection.direction}
                </p>
              </div>

              <div>
                <span className="text-[12px] font-bold text-purple-800 uppercase tracking-wider block mb-0.5">
                  依据：
                </span>
                <p className="text-slate-600 text-[13px] leading-relaxed">
                  {verificationDirection.premise}
                </p>
              </div>
            </div>
          </div>

          {/* AI 警示门禁 */}
          <div className="rounded-lg border border-purple-200 bg-purple-50/70 p-2 text-[12px] text-purple-800 flex items-start gap-1.5">
            <Info className="size-3 text-purple-600 shrink-0 mt-0.5" />
            <span>AI 推断，非事实证据，需要人工验证；严禁直接转为开模或设计方案。</span>
          </div>
        </div>
      </div>

      {/* 模块 4 & 5：验证缺口 (Data Gaps) 与 下一步动作 (Next Step) */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
        {/* 模块 4：验证缺口 (Data Gaps) */}
        <div
          data-testid="opportunity-gaps"
          className="md:col-span-8 rounded-xl border border-amber-200/80 bg-amber-50/20 p-3.5 space-y-2"
        >
          <div className="flex items-center justify-between border-b border-amber-100 pb-1.5">
            <span className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 text-amber-600" />
              进入下一步前需要核实什么？（关键验证缺口）
            </span>
            <span className="text-[12px] text-amber-700 font-semibold bg-amber-50 px-1.5 py-0.2 rounded border border-amber-200">
              待核实: {criticalGaps.length} 项
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {criticalGaps.map((gap, idx) => (
              <div
                key={idx}
                className="bg-white/90 p-2 rounded-lg border border-amber-200/60 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <span className="text-xs font-bold text-slate-800 truncate">
                      {gap.field}
                    </span>
                    <span className="text-[9px] font-mono text-slate-500 bg-slate-100 px-1 rounded">
                      {gap.state}
                    </span>
                  </div>
                  <p className="text-[12px] text-amber-900/80 leading-snug">
                    {gap.impact}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 模块 5：下一步动作 (Next Step) */}
        <div
          data-testid="opportunity-next-action"
          className="md:col-span-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 flex flex-col justify-between space-y-2"
        >
          <div>
            <span className="text-[12px] font-bold text-indigo-900 uppercase tracking-wider block mb-1">
              建议下一步动作 (Next Action)
            </span>
            <div className="flex items-center gap-2">
              <span
                data-testid="opportunity-action-badge"
                className={`text-sm font-bold px-2 py-0.5 rounded-md border ${
                  effectiveNextAction === "继续研究"
                    ? "bg-emerald-600 text-white border-emerald-700"
                    : effectiveNextAction === "补充数据"
                    ? "bg-amber-600 text-white border-amber-700"
                    : effectiveNextAction === "暂停"
                    ? "bg-rose-600 text-white border-rose-700"
                    : "bg-slate-100 text-slate-700 border-slate-300"
                }`}
              >
                {effectiveNextAction ?? "暂不可用"}
              </span>
              <span className="text-[13px] text-slate-600">
                {effectiveNextAction === "补充数据"
                  ? "优先核实供应链与成本缺口"
                  : effectiveNextAction === "暂停"
                  ? "存在重大风险，暂缓投入"
                  : effectiveNextAction === "继续研究"
                  ? "继续查看证据与研究结果"
                  : "尚未生成可用的系统建议"}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-indigo-200/60 text-[12px] text-slate-500 space-y-0.5">
            <p className="font-semibold text-rose-600">
              禁止自动推进 PROCEED · 最终决策由人工在页面右侧完成
            </p>
            <p className="text-slate-400">
              缺少报价本身不妨碍继续研究；需求单仍遵循现有人工决定与版本门禁。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
