"use client";

import React, { useMemo, useState } from "react";
import {
  FileText,
  Copy,
  Check,
  ShieldAlert,
  AlertTriangle,
  Info,
  Lock,
  Layers,
  HelpCircle,
  Database,
  ClipboardList,
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  buildValidationBriefView,
  roleLabelOf,
  type ValidationBriefViewModel,
} from "@/lib/research/validationBriefView";
import type {
  BuildCommercialFeasibilityInput,
  CommercialFeasibilityView,
} from "@/lib/research/commercialFeasibility";
import { describeVocThemeStrength } from "@/lib/research/vocThresholds";

export interface ValidationBriefPanelProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly asin: string;
  readonly title?: string | null;
  readonly role?: string | null;
  readonly feasibilityView?: CommercialFeasibilityView;
  readonly input?: BuildCommercialFeasibilityInput;
  readonly summary?: string | null;
}

const FACT_STATE_META = {
  available: { label: "已确认事实 (AVAILABLE)", tone: "emerald" as const, hint: "存在符合事实契约的有效证据" },
  estimated: { label: "来源明确的估算 (ESTIMATED)", tone: "amber" as const, hint: "估算，不计入已确认事实" },
  missing: { label: "缺失 / 无法验证 (DATA_MISSING)", tone: "slate" as const, hint: "缺失或无法验证" },
};

/**
 * Validation Brief Panel（第一版 · 验证链路闭环）
 *
 * 定位：当深研人工决策处于 VALIDATE_MORE 时，提供一个面向供应链/工厂核实的工作底稿。
 *
 * 架构红线：
 * - 纯展示/只读投影组件：数据 100% 消费自深研已有事实、正式 VOC 快照与商业评估
 * - 零 API 写操作、零 DB 变更、零新建事实层
 * - 保持正式 Product Brief 门禁严格不变（不放宽 PROCEED 门禁）
 * - 严禁出现「自动推荐开发」「立即立项」「确定机会」
 * - 严禁无据强度词（「高频痛点」「普遍差评」「多数用户不满」）
 * - 严格区分：独立评论数 ≠ 主题提及数；AVAILABLE ≠ ESTIMATED ≠ DATA_MISSING
 * - 页面渲染与 Markdown 导出消费同一份 ViewModel（buildValidationBriefView）
 */
export function ValidationBriefPanel({
  isOpen,
  onClose,
  asin,
  title,
  role,
  feasibilityView,
  input,
  summary,
}: ValidationBriefPanelProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const view: ValidationBriefViewModel = useMemo(
    () => buildValidationBriefView({ asin, title, role, feasibilityView, input, summary }),
    [asin, title, role, feasibilityView, input, summary],
  );

  const handleCopy = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyState("failed");
        return;
      }
      await navigator.clipboard.writeText(view.markdown);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("failed");
    }
  };

  const roleLabel = roleLabelOf(role || view.roleLabel);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="2xl"
      scrollable
      title={
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-blue-600 text-white shadow-xs">
            <FileText className="size-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-slate-900">产品验证需求单</span>
              <span className="rounded bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                第一版 · 验证链路闭环
              </span>
            </div>
            <p className="text-xs font-normal text-slate-500 mt-0.5">
              供与工厂/供应商核查商务条款与包装尺寸 · 非正式立项通知
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <span className="text-[13px] text-slate-400">
            {view.decision.staleBlocked ? "人工决策已失效 · 不可复制为已批准需求单" : "非正式立项 · 仅用于前置验证链路闭环"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              disabled={view.decision.staleBlocked}
              className="gap-1.5 text-xs text-slate-700 hover:text-slate-900"
            >
              {copyState === "copied" ? (
                <>
                  <Check className="size-3.5 text-emerald-600" />
                  <span className="text-emerald-700 font-medium">已复制 Markdown</span>
                </>
              ) : copyState === "failed" ? (
                <>
                  <AlertTriangle className="size-3.5 text-rose-600" />
                  <span className="text-rose-700 font-medium">复制失败，请手动选择</span>
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  <span>复制需求单 (Markdown)</span>
                </>
              )}
            </Button>
            <Button variant="primary" size="sm" onClick={onClose}>
              完成查看
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 py-1 text-slate-800" data-testid="validation-brief-panel">
        {view.decision.staleBlocked ? (
          <div
            data-testid="validation-brief-stale-blocked"
            className="rounded-xl border border-rose-300 bg-rose-50 p-4 flex items-start gap-2.5 text-xs text-rose-900"
          >
            <Lock className="size-4 text-rose-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-rose-950">原人工决策已失效，需重新确认后才能使用本需求单</p>
              <p className="mt-1 text-[13px] leading-relaxed text-rose-800">
                研究版本 / 报告 / 事实或证据已更新，原「需补充验证」决策不再对应当前研究版本。
                <strong>历史决策记录已保留，未被改写</strong>；请先回到页面重新完成人工决断，届时本需求单会按最新证据重新生成。
              </p>
              <p className="mt-1 text-[12px] font-mono text-rose-700">staleReason: {view.decision.staleReason ?? "unknown"}</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 flex items-start gap-2.5 text-xs text-amber-900">
            <ShieldAlert className="size-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-amber-950">前置验证工单（Validation Brief）性质声明</p>
              <p className="mt-0.5 text-[13px] text-amber-800 leading-relaxed">
                当前商品处于「需补充验证 (VALIDATE_MORE)」状态。本需求单用于拿着已知缺口向供应链核实成本与参数，
                <strong>不代表正式产品开发立项</strong>。正式立项须在核实完毕并由人工决断为「继续推进 (PROCEED)」后生成。
              </p>
            </div>
          </div>
        )}

        {/* 1. 商品信息 */}
        <section className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <Layers className="size-3.5 text-slate-500" /> 1. 商品基础档案
            </span>
            <div className="flex items-center gap-1.5">
              <Badge tone="slate">{roleLabel}</Badge>
              <Badge tone={view.decision.staleBlocked ? "rose" : "blue"}>{view.decision.gateLabel}</Badge>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between text-slate-500">
              <span>ASIN: <span className="font-mono text-slate-800 font-semibold">{view.asin}</span></span>
            </div>
            <p className="font-medium text-slate-900 truncate" title={view.title || view.asin}>
              {view.title || "无标题商品"}
            </p>
          </div>
        </section>

        {/* 2. 当前机会验证方向 */}
        <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-indigo-950 flex items-center gap-1.5">
              <Info className="size-3.5 text-indigo-600" /> 2. 当前机会验证方向
            </span>
            <span className="rounded bg-indigo-100 text-indigo-800 border border-indigo-200 px-1.5 py-0.2 text-[12px] font-semibold">
              {view.direction.state}
            </span>
          </div>
          <div className="bg-white rounded-lg border border-indigo-100 p-3 text-xs space-y-1.5">
            <p className="font-semibold text-slate-900 leading-snug">{view.direction.direction}</p>
            <p className="text-[13px] text-slate-500">
              <span className="font-medium text-slate-600">推导依据：</span>
              {view.direction.premise}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Badge tone={view.direction.basisStrength === "recurring" ? "emerald" : view.direction.basisStrength === "weak" ? "amber" : "slate"}>
                证据强度：{view.direction.basisStrength ?? "无正式 VOC 主题"}
              </Badge>
              {view.direction.basisMentionCount !== null && (
                <span className="text-[12px] text-slate-500">该主题提及 {view.direction.basisMentionCount} 次</span>
              )}
            </div>
            {view.direction.caveat && (
              <p className="text-[12px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                强度限定：{view.direction.caveat}
              </p>
            )}
            <div className="pt-1.5 border-t border-slate-100 flex items-center gap-1.5 text-[12px] text-amber-700 font-medium">
              <AlertTriangle className="size-3 shrink-0" />
              <span>AI 推断，非事实证据，需要人工验证</span>
            </div>
          </div>
        </section>

        {/* 3. 已确认事实（三态分层） */}
        <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <Database className="size-3.5 text-emerald-600" /> 3. 已确认事实证据（按来源状态分层）
            </span>
            <span className="text-[12px] text-slate-400">只展示真实存在、来源可确认的字段</span>
          </div>
          <div className="space-y-2">
            {(["available", "estimated", "missing"] as const).map((stateKey) => {
              const meta = FACT_STATE_META[stateKey];
              const items = view.facts[stateKey];
              return (
                <div key={stateKey} className="rounded-lg border border-slate-200 p-2.5">
                  <div className="flex items-center justify-between">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="text-[12px] text-slate-400">{meta.hint}</span>
                  </div>
                  {items.length === 0 ? (
                    <p className="mt-1.5 text-[13px] text-slate-400">无</p>
                  ) : (
                    <ul className="mt-1.5 grid gap-1 text-[13px] sm:grid-cols-2">
                      {items.map((fact) => (
                        <li key={fact.key} className="leading-relaxed text-slate-700">
                          <span className="text-slate-500">{fact.label}：</span>
                          <span className={stateKey === "missing" ? "text-slate-400" : "font-medium text-slate-800"}>{fact.displayValue}</span>
                          {fact.note && <span className="block text-[12px] text-slate-400">{fact.note}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 3·附 研究解释（AI 摘要，非事实证据） */}
        {view.researchInterpretation && (
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Info className="size-3.5 text-slate-500" /> 附. 研究解释（AI 研报摘要）
              </span>
              <Badge tone="amber">非事实证据</Badge>
            </div>
            <p className="line-clamp-4 text-[13px] leading-relaxed text-slate-600">{view.researchInterpretation}</p>
          </section>
        )}

        {/* 4. VOC 信号 */}
        <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <FileText className="size-3.5 text-blue-600" /> 4. 买家声音 (VOC) 信号
            </span>
            {view.voc.state === "AVAILABLE" && (
              <span className="text-[12px] text-slate-500">
                独立评论数 {view.voc.independentReviewCount ?? "未记录"} 条 · 主题提及 {view.voc.themeMentionCount} 次
              </span>
            )}
          </div>

          {view.voc.state === "AVAILABLE" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
                <span className="text-[13px] font-bold text-emerald-900 block mb-1">
                  正向认可信号（不可改丢的优势）：
                </span>
                {view.voc.positive.length > 0 ? (
                  <ul className="space-y-1 text-[13px] text-emerald-800">
                    {view.voc.positive.map((signal) => (
                      <li key={signal.text} className="line-clamp-3">
                        ✓ {signal.text}
                        <span className="ml-1 text-[12px] text-emerald-700">
                          （{describeVocThemeStrength(signal.reviewCount ?? 0).evidencePhrase}）
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-slate-400">暂无正向主题记录</p>
                )}
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-2.5">
                <span className="text-[13px] font-bold text-rose-900 block mb-1">
                  买家痛点与负向信号（重点优化验证）：
                </span>
                {view.voc.negative.length > 0 ? (
                  <ul className="space-y-1 text-[13px] text-rose-800">
                    {view.voc.negative.map((signal) => (
                      <li key={signal.text} className="line-clamp-3">
                        ✗ {signal.text}
                        <span className="ml-1 text-[12px] text-rose-700">
                          （{describeVocThemeStrength(signal.reviewCount ?? 0).evidencePhrase}）
                        </span>
                        {signal.strengthConflict && (
                          <span className="ml-1 text-[12px] font-semibold text-amber-700">[强度记录与计数不一致，待核实]</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-slate-400">暂无负向主题记录</p>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-center text-xs text-slate-500">
              <p className="font-medium text-slate-700">暂无正式 VOC 数据</p>
              <p className="text-[12px] text-slate-400 mt-0.5">
                未导入或未生成正式 VOC 主题分析；这不等于商品没有评论证据（已合法采集的评论见「VOC 痛点」层），也禁止 AI 补充臆测痛点。
              </p>
            </div>
          )}
        </section>

        {/* 5. 验证缺口 */}
        <section className="rounded-xl border border-rose-200 bg-rose-50/30 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-rose-950 flex items-center gap-1.5">
              <HelpCircle className="size-3.5 text-rose-600" /> 5. 商业数据缺口（为什么当前不能直接进入开发）
            </span>
            <span className="rounded bg-rose-100 text-rose-800 text-[12px] font-bold px-1.5 py-0.2">
              阻断立项
            </span>
          </div>
          <ul className="space-y-1.5 bg-white rounded-lg border border-rose-100 p-2.5 text-xs">
            {view.dataGaps.map((gap) => (
              <li key={gap.field} className="flex items-start gap-1.5 text-slate-700">
                <span className="text-rose-500 font-bold shrink-0">•</span>
                <span className="leading-relaxed">
                  <span className="font-medium text-slate-800">{gap.field}</span>
                  <span className="text-slate-400">（{gap.category}）</span> — {gap.impact}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* 6. 下一步验证任务 */}
        <section className="rounded-xl border border-blue-200 bg-blue-50/30 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-blue-950 flex items-center gap-1.5">
              <ClipboardList className="size-3.5 text-blue-600" /> 6. 下一步供应商与商务验证任务
            </span>
            <span className="text-[12px] text-blue-700 font-medium">核实后可转 PROCEED</span>
          </div>
          {view.taskFallbackUsed && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[13px] text-amber-900">
              <p className="font-semibold">本商品暂无专项验证任务</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-amber-800">
                该商品尚无正式 VOC 分析数据，无法派生商品专项核实事项。以下为最小通用核实建议（模板参考，不代表本商品专项任务）。
              </p>
            </div>
          )}
          <div className="space-y-2">
            {view.tasks.map((task, idx) => (
              <div key={task.id} className="rounded-lg border border-blue-100 bg-white p-2.5 text-xs space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5 font-semibold text-slate-900">
                  <span className="flex size-4 items-center justify-center rounded-full bg-blue-100 text-blue-800 text-[12px]">
                    {idx + 1}
                  </span>
                  <span>{task.title}</span>
                  <Badge tone="slate">{task.sourceLabel}</Badge>
                  {task.mentionCount !== null && (
                    <span className="text-[12px] font-normal text-slate-500">提及 {task.mentionCount} 次</span>
                  )}
                </div>
                <p className="text-[13px] text-slate-600 pl-5.5 leading-relaxed">{task.detail}</p>
                {task.evidenceRefs.length > 0 && (
                  <p className="pl-5.5 text-[12px] font-mono text-slate-400">证据引用 {task.evidenceRefs.length} 条</p>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
