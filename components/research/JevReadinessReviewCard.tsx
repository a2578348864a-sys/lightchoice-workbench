"use client";

/**
 * AI 二次复核（Jev Research Readiness）— 第 4 步·系统建议内的最小接线卡片。
 *
 * 纪律：
 * - 只读展示 + 显式触发：打开详情 / 切 Tab / 刷新 / 展开折叠块都不会发起任何请求；
 *   只有点击「运行 AI 二次复核」并经过后端门禁后才进入 Provider 执行路径；
 * - 离线桩结果显式标注「离线测试结果，并非真实 Jev 模型判断」；
 * - 不提供任何自动 PROCEED / VALIDATE_MORE / PAUSE / DROP / 需求单 / 人工决断能力；
 * - 结果绑定（四元组）与当前研究不一致时，不把旧内容作为当前建议呈现。
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Info, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { buildAccessHeaders } from "@/lib/client/accessToken";

/* ── 视图类型（与服务端 JevReadinessViewState / 运行回执对齐，仅形状镜像） ── */

export type JevReadinessBindingView = {
  reportHash: string | null;
  factHash: string | null;
  evidenceHash: string | null;
  researchRevision: number | null;
};

export type JevAdviceItemView = { text: string; evidenceRefs: string[] };

export type JevRunView = {
  status: "available" | "unavailable" | "failed";
  advice: {
    status: string;
    readiness: "READY_FOR_HUMAN_REVIEW" | "NEED_MORE_EVIDENCE" | "HIGH_RISK" | null;
    reviewQuestions: JevAdviceItemView[];
    contradictions: JevAdviceItemView[];
    missingEvidence: string[];
    limitations: string[];
    inputBinding: JevReadinessBindingView;
  } | null;
  provider: string;
  model: string | null;
  generatedAt: string;
  sideEffects: {
    deepseekInvoked: boolean;
    externalRequestAttempted: number | null;
    stateWritten: boolean;
    reportRegenerated: boolean;
  };
  sideEffectsVerification: "runtime_measured" | "unverified";
  requestTrackerKind: "scoped" | "cumulative" | "none";
  rejected: {
    reason: string | null;
    droppedQuestions: number;
    droppedContradictions: number;
    forbiddenFields: string[];
    bindingMismatch: boolean;
  };
  notes: string[];
};

export type JevReadinessView = {
  enabled: boolean;
  providerKind: "typesafe" | "offline" | "unavailable";
  providerReason: string | null;
  providerReady: boolean;
  inputAvailable: boolean;
  inputReason: string | null;
  binding: JevReadinessBindingView;
  lastResult: JevRunView | null;
  staleResult: { generatedAt: string; binding: JevReadinessBindingView | null } | null;
  rerunCooldownMs: number;
};

/* ── 形状归一化（unknown → 显示模型；不做任何兜底夸大） ─────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asBinding(value: unknown): JevReadinessBindingView {
  const record = asRecord(value);
  return {
    reportHash: asString(record?.["reportHash"]),
    factHash: asString(record?.["factHash"]),
    evidenceHash: asString(record?.["evidenceHash"]),
    researchRevision: typeof record?.["researchRevision"] === "number" ? (record["researchRevision"] as number) : null,
  };
}

function asAdviceItems(value: unknown): JevAdviceItemView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const text = asString(record?.["text"]);
    if (!record || !text) return [];
    return [{ text, evidenceRefs: asStringArray(record["evidenceRefs"]) }];
  });
}

/** 归一化运行回执（同时兼容 POST 直返形状 jevStatus 与视图内 lastResult 形状 status）。 */
export function normalizeRunView(value: unknown): JevRunView | null {
  const record = asRecord(value);
  if (!record) return null;
  const statusRaw = asString(record["jevStatus"]) ?? asString(record["status"]);
  const status = statusRaw === "available" || statusRaw === "unavailable" || statusRaw === "failed" ? statusRaw : "failed";
  const adviceRecord = asRecord(record["advice"]);
  const sideEffects = asRecord(record["sideEffects"]) ?? {};
  const rejected = asRecord(record["rejected"]) ?? {};
  const readinessRaw = asString(adviceRecord?.["readiness"]);
  const readiness = readinessRaw === "READY_FOR_HUMAN_REVIEW" || readinessRaw === "NEED_MORE_EVIDENCE" || readinessRaw === "HIGH_RISK"
    ? readinessRaw
    : null;
  return {
    status,
    advice: adviceRecord ? {
      status: asString(adviceRecord["status"]) ?? "unavailable",
      readiness,
      reviewQuestions: asAdviceItems(adviceRecord["reviewQuestions"]),
      contradictions: asAdviceItems(adviceRecord["contradictions"]),
      missingEvidence: asStringArray(adviceRecord["missingEvidence"]),
      limitations: asStringArray(adviceRecord["limitations"]),
      inputBinding: asBinding(adviceRecord["inputBinding"]),
    } : null,
    provider: asString(record["provider"]) ?? "unknown",
    model: asString(record["model"]),
    generatedAt: asString(record["generatedAt"]) ?? "",
    sideEffects: {
      deepseekInvoked: sideEffects["deepseekInvoked"] === true,
      externalRequestAttempted: typeof sideEffects["externalRequestAttempted"] === "number" ? (sideEffects["externalRequestAttempted"] as number) : null,
      stateWritten: sideEffects["stateWritten"] === true,
      reportRegenerated: sideEffects["reportRegenerated"] === true,
    },
    sideEffectsVerification: record["sideEffectsVerification"] === "runtime_measured" ? "runtime_measured" : "unverified",
    requestTrackerKind: record["requestTrackerKind"] === "scoped" || record["requestTrackerKind"] === "cumulative"
      ? (record["requestTrackerKind"] as "scoped" | "cumulative")
      : "none",
    rejected: {
      reason: asString(rejected["reason"]),
      droppedQuestions: typeof rejected["droppedQuestions"] === "number" ? (rejected["droppedQuestions"] as number) : 0,
      droppedContradictions: typeof rejected["droppedContradictions"] === "number" ? (rejected["droppedContradictions"] as number) : 0,
      forbiddenFields: asStringArray(rejected["forbiddenFields"]),
      bindingMismatch: rejected["bindingMismatch"] === true,
    },
    notes: asStringArray(record["notes"]),
  };
}

function sameBinding(a: JevReadinessBindingView, b: JevReadinessBindingView): boolean {
  return a.reportHash === b.reportHash && a.factHash === b.factHash && a.evidenceHash === b.evidenceHash
    && a.researchRevision === b.researchRevision;
}

const READINESS_LABEL: Record<string, { label: string; tone: "emerald" | "amber" | "rose" | "slate" }> = {
  READY_FOR_HUMAN_REVIEW: { label: "准备度：可供人工复核", tone: "emerald" },
  NEED_MORE_EVIDENCE: { label: "准备度：证据仍不足", tone: "amber" },
  HIGH_RISK: { label: "准备度：存在高阻断风险", tone: "rose" },
};

/* ── 组件 ───────────────────────────────────────────────────────── */

export function JevReadinessReviewCard(props: {
  taskId: string;
  researchRevision: number | null;
  reportHash: string | null;
  factHash: string | null;
  evidenceHash: string | null;
  view: JevReadinessView | null | undefined;
}) {
  const { taskId, view } = props;
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [runResult, setRunResult] = useState<JevRunView | null>(() => normalizeRunView(view?.lastResult ?? null));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setRunResult(normalizeRunView(view?.lastResult ?? null));
  }, [view?.lastResult]);

  const enabled = Boolean(view?.enabled);
  const providerReady = Boolean(view?.providerReady);
  const inputAvailable = Boolean(view?.inputAvailable);
  const canRun = enabled && providerReady && inputAvailable;

  const currentBinding: JevReadinessBindingView = {
    reportHash: props.reportHash,
    factHash: props.factHash,
    evidenceHash: props.evidenceHash,
    researchRevision: props.researchRevision,
  };
  const resultStale = Boolean(view?.staleResult || (runResult?.advice && !sameBinding(runResult.advice.inputBinding, currentBinding)));
  const effectiveResult = runResult && !resultStale ? runResult : null;
  const offlineHint = Boolean(effectiveResult?.provider.startsWith("offline"));

  const run = useCallback(async (confirmRerun: boolean) => {
    setRunning(true);
    setErrorMsg(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/research/${encodeURIComponent(taskId)}/jev-readiness-advisory`, {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          expectedRevision: props.researchRevision ?? 0,
          expectedFactHash: props.factHash ?? undefined,
          expectedEvidenceHash: props.evidenceHash ?? undefined,
          confirmRerun,
          idempotencyKey,
        }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const errorRecord = asRecord(asRecord(json)?.["error"]);
        const code = asString(errorRecord?.["code"]) ?? "";
        const message = asString(errorRecord?.["message"]) ?? "AI 二次复核未完成。";
        setErrorMsg(code ? `[${code}] ${message}` : message);
        return;
      }
      const normalized = normalizeRunView(asRecord(json)?.["data"] ?? null);
      if (normalized) {
        setRunResult(normalized);
      } else {
        setErrorMsg("AI 二次复核返回了无法识别的响应。");
      }
    } catch {
      setErrorMsg("AI 二次复核请求失败（网络或服务异常）。");
    } finally {
      setRunning(false);
    }
  }, [taskId, props.researchRevision, props.factHash, props.evidenceHash]);

  const handlePrimary = () => {
    if (!canRun || running) return;
    if (effectiveResult) {
      setPendingConfirm(true);
      return;
    }
    void run(false);
  };

  let statusBadge: { text: string; tone: "emerald" | "amber" | "rose" | "slate" } = { text: "状态未知", tone: "slate" };
  if (view == null) statusBadge = { text: "状态未知", tone: "slate" };
  else if (!enabled) statusBadge = { text: "未启用", tone: "slate" };
  else if (!providerReady) statusBadge = { text: "Provider 不可用", tone: "slate" };
  else if (!inputAvailable) statusBadge = { text: "暂不可复核", tone: "amber" };
  else if (running) statusBadge = { text: "运行中…", tone: "amber" };
  else if (effectiveResult?.status === "available") statusBadge = { text: "已完成", tone: "emerald" };
  else if (effectiveResult) statusBadge = { text: "执行失败", tone: "rose" };
  else if (resultStale) statusBadge = { text: "结果已失效", tone: "amber" };
  else if (canRun) statusBadge = { text: "可运行", tone: "slate" };

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60" data-testid="jev-readiness-review-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        aria-expanded={open}
        data-testid="jev-readiness-toggle"
      >
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-slate-700">
          <Sparkles className="size-3.5 text-indigo-500" />
          AI 二次复核（Jev Readiness）
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone={statusBadge.tone}>{statusBadge.text}</Badge>
          {open ? <ChevronUp className="size-3.5 text-slate-400" /> : <ChevronDown className="size-3.5 text-slate-400" />}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2" data-testid="jev-readiness-review-body">
          {view == null && (
            <div className="text-[13px] text-slate-500" data-testid="jev-readiness-unknown">
              未能获取复核状态（服务端未返回投影）；不在此处发起任何请求。
            </div>
          )}
          {view != null && !enabled && (
            <div className="text-[13px] text-slate-500 flex items-start gap-1.5" data-testid="jev-readiness-disabled">
              <Info className="size-3.5 text-slate-400 shrink-0 mt-0.5" />
              <span>AI 二次复核当前未启用（默认关闭；不产生任何外部调用）。未接入真实模型时绝不展示虚假 AI 评分。</span>
            </div>
          )}
          {view != null && enabled && !providerReady && (
            <div className="text-[13px] text-slate-500" data-testid="jev-readiness-provider-unavailable">
              Provider 当前不可用{view.providerReason ? `（${view.providerReason}）` : ""}；未发起任何请求。
            </div>
          )}
          {view != null && enabled && providerReady && !inputAvailable && (
            <div className="text-[13px] text-amber-700" data-testid="jev-readiness-input-unavailable">
              缺少有效研报或证据，暂不可复核{view.inputReason ? `（${view.inputReason}）` : ""}。
            </div>
          )}

          {view != null && resultStale && (
            <div className="text-[13px] text-amber-700 flex items-start gap-1.5" data-testid="jev-readiness-stale">
              <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span>既有复核结果基于旧版研究（绑定已变化）；已隐藏旧内容，不作为当前建议呈现。请重新运行。</span>
            </div>
          )}

          {view != null && canRun && (
            <>
              {offlineHint && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-800" data-testid="jev-readiness-offline-banner">
                  离线测试结果，并非真实 Jev 模型判断（Provider：{effectiveResult?.provider ?? "offline-stub:ok"}）。
                </div>
              )}

              {!effectiveResult && !running && !pendingConfirm && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handlePrimary} data-testid="jev-readiness-run-button" className="text-xs h-7 px-2">
                    <Sparkles className="size-3 mr-1 text-indigo-500" />
                    运行 AI 二次复核
                  </Button>
                  <span className="text-[12px] text-slate-400">仅在你点击后执行一次，受费用与版本门禁保护。</span>
                </div>
              )}

              {pendingConfirm && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 space-y-1.5" data-testid="jev-readiness-rerun-confirm">
                  <div className="text-[13px] text-amber-800">重新运行会发起一次新的外部调用（受单次上限与冷却保护）。确认继续？</div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setPendingConfirm(false); void run(true); }} className="text-xs h-7 px-2" data-testid="jev-readiness-rerun-confirm-button">
                      确认重新运行
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingConfirm(false)} className="text-xs h-7 px-2">
                      取消
                    </Button>
                  </div>
                </div>
              )}

              {running && (
                <div className="flex items-center gap-2 text-[13px] text-slate-500" data-testid="jev-readiness-running">
                  <Loader2 className="size-3.5 animate-spin" />
                  正在执行复核（单次外部调用，无重试）…
                </div>
              )}

              {errorMsg && (
                <div className="text-[13px] text-rose-600" data-testid="jev-readiness-error">{errorMsg}</div>
              )}

              {effectiveResult && (
                <JevResultBlock result={effectiveResult} onRerunRequest={() => setPendingConfirm(true)} />
              )}
            </>
          )}

          <p className="text-[12px] text-slate-400 leading-tight" data-testid="jev-readiness-disclaimer">
            AI 二次复核只提供参考，不等于人工商业决断。
          </p>
        </div>
      )}
    </div>
  );
}

function JevResultBlock({ result, onRerunRequest }: { result: JevRunView; onRerunRequest: () => void }) {
  const advice = result.advice;
  const readiness = advice?.readiness ? READINESS_LABEL[advice.readiness] : null;
  const requestsText = result.sideEffects.externalRequestAttempted === null
    ? "外部请求：未测量（不得据此声称零请求）"
    : `外部请求观测：${result.sideEffects.externalRequestAttempted} 次`;
  const dropped = result.rejected.droppedQuestions + result.rejected.droppedContradictions;

  return (
    <div className="space-y-2" data-testid="jev-readiness-result">
      {result.status === "available" && advice ? (
        <>
          <div className="flex items-center justify-between">
            <Badge tone={readiness?.tone ?? "slate"}>{readiness?.label ?? "复核完成"}</Badge>
            <span className="text-[12px] text-slate-400">研究版本 rev.{advice.inputBinding.researchRevision ?? "—"}</span>
          </div>
          <JevList title="需人工复核的问题" items={advice.reviewQuestions} testid="jev-readiness-questions" />
          <JevList title="潜在研究矛盾" items={advice.contradictions} testid="jev-readiness-contradictions" />
          {advice.missingEvidence.length > 0 && (
            <div data-testid="jev-readiness-missing">
              <div className="text-[13px] font-semibold text-slate-700 mb-0.5">缺失证据</div>
              <ul className="list-disc pl-4 text-[13px] text-slate-600 space-y-0.5">
                {advice.missingEvidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {advice.limitations.length > 0 && (
            <div data-testid="jev-readiness-limitations">
              <div className="text-[13px] font-semibold text-slate-700 mb-0.5">局限性说明</div>
              <ul className="list-disc pl-4 text-[13px] text-slate-500 space-y-0.5">
                {advice.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="text-[13px] text-rose-600" data-testid="jev-readiness-provider-failed">
          Provider {result.status === "unavailable" ? "不可用" : "执行失败"}
          {result.rejected.reason ? `（${result.rejected.reason}）` : ""}
          {result.rejected.bindingMismatch ? "；输出绑定与研究不一致，已整份拒收。" : "。"}
        </div>
      )}

      <div className="rounded-lg bg-white/70 border border-slate-200 px-2 py-1.5 text-[12px] text-slate-500 space-y-0.5" data-testid="jev-readiness-meta">
        <div>来源：{result.provider} · 模型：{result.model ?? "未提供"} · 生成时间：{result.generatedAt ? new Date(result.generatedAt).toLocaleString("zh-CN") : "—"}</div>
        {advice && (
          <div
            className="break-all"
            data-testid="jev-readiness-binding"
            title={`reportHash=${advice.inputBinding.reportHash ?? "—"}; factHash=${advice.inputBinding.factHash ?? "—"}; evidenceHash=${advice.inputBinding.evidenceHash ?? "—"}; researchRevision=${advice.inputBinding.researchRevision ?? "—"}`}
          >
            版本绑定：报告 {shortHash(advice.inputBinding.reportHash)} · 事实 {shortHash(advice.inputBinding.factHash)} · 证据 {shortHash(advice.inputBinding.evidenceHash)} · rev.{advice.inputBinding.researchRevision ?? "—"}
          </div>
        )}
        <div>{requestsText}（{result.sideEffectsVerification === "runtime_measured" ? "运行时实测" : "未验证"}；单次上限 1 次，无重试）</div>
        <div>
          副作用：写状态 {result.sideEffects.stateWritten ? "有" : "无"} · 研报重生成 {result.sideEffects.reportRegenerated ? "有" : "无"} · DeepSeek 调用{" "}
          {result.sideEffects.deepseekInvoked ? "有" : "无"}
        </div>
      </div>

      {dropped > 0 && (
        <div className="text-[12px] text-amber-700">契约守卫：拒收条目 问题 {result.rejected.droppedQuestions} / 矛盾 {result.rejected.droppedContradictions}。</div>
      )}

      {result.notes.length > 0 && (
        <details className="text-[12px] text-slate-400">
          <summary className="cursor-pointer select-none">查看运行说明（{result.notes.length}）</summary>
          <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
            {result.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}

      <Button size="sm" variant="ghost" onClick={onRerunRequest} className="text-xs h-6 px-2 text-slate-500" data-testid="jev-readiness-rerun-button">
        <RefreshCw className="size-3 mr-1" />
        重新运行复核
      </Button>
    </div>
  );
}

function shortHash(value: string | null): string {
  if (!value) return "—";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function JevList({ title, items, testid }: { title: string; items: JevAdviceItemView[]; testid: string }) {
  if (items.length === 0) return null;
  return (
    <div data-testid={testid}>
      <div className="text-[13px] font-semibold text-slate-700 mb-0.5">{title}</div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={index} className="rounded-lg bg-white/70 border border-slate-200 px-2 py-1 text-[13px] text-slate-600">
            <div>{item.text}</div>
            <div className="text-[12px] text-slate-400 mt-0.5">引用：{item.evidenceRefs.join(", ") || "（无）"}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
