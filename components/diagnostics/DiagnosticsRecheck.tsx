"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";

type CheckStatus = "pass" | "fail";

type CheckResult = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  checkedAt: string;
};

type CheckDefinition = {
  id: string;
  label: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
};

async function fetchJsonOk(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { headers: buildAccessHeaders(), cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.error?.message || body?.error?.code || `HTTP ${res.status}`;
      return { ok: false, detail: `${message}（下一步：查看服务端日志或稍后重试）` };
    }
    return { ok: true, detail: `HTTP ${res.status}，响应正常` };
  } catch (error) {
    return { ok: false, detail: `${error instanceof Error ? error.message : String(error)}（下一步：确认本地服务进程是否存活）` };
  }
}

const CHECKS: CheckDefinition[] = [
  {
    id: "health",
    label: "本地服务健康（/api/health）",
    run: async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) return { ok: false, detail: `HTTP ${res.status}（下一步：重启本地服务）` };
        return { ok: true, detail: "服务存活，健康探针返回 ok" };
      } catch (error) {
        return { ok: false, detail: `${error instanceof Error ? error.message : String(error)}（下一步：确认 127.0.0.1 服务已启动）` };
      }
    },
  },
  {
    id: "source-data",
    label: "事实数据可读（/api/source/batches）",
    run: async () => {
      try {
        const res = await fetch("/api/source/batches?include=active&limit=1", { headers: buildAccessHeaders(), cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message = body?.error?.message || `HTTP ${res.status}`;
          return { ok: false, detail: `${message}（下一步：检查数据库连接与访问模式）` };
        }
        const count = Array.isArray(body?.data?.items) ? body.data.items.length : -1;
        if (count < 0) return { ok: false, detail: "响应结构不符合 V5 契约（下一步：核对接口版本）" };
        return { ok: true, detail: `数据库读取成功（返回 ${count} 条批次样本）` };
      } catch (error) {
        return { ok: false, detail: `${error instanceof Error ? error.message : String(error)}（下一步：检查网络与鉴权）` };
      }
    },
  },
  {
    id: "feishu-status",
    label: "飞书状态接口可读（/api/feishu-hub/status）",
    run: () => fetchJsonOk("/api/feishu-hub/status"),
  },
];

/**
 * Diagnostics「重新检查」：真实调用既有只读接口并把结果落到页面。
 * 不做任何写入；失败时展示真实原因与下一步动作，不做永久 loading。
 */
export function DiagnosticsRecheck() {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const runChecks = async () => {
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toLocaleTimeString("zh-CN");
      const settled: CheckResult[] = [];
      for (const check of CHECKS) {
        const outcome = await check.run();
        settled.push({ id: check.id, label: check.label, status: outcome.ok ? "pass" : "fail", detail: outcome.detail, checkedAt: now });
      }
      setResults(settled);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="diagnostics-recheck" className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-slate-800">运行时健康检查</p>
          <p className="mt-0.5 text-[13px] text-slate-500">检查本地接口可读性；外部连接就绪与同步结果请在飞书工作区核对。</p>
        </div>
        <button
          type="button"
          data-testid="diagnostics-recheck-button"
          onClick={() => void runChecks()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {busy ? "检查中…" : "重新检查"}
        </button>
      </div>

      {error && (
        <p role="alert" data-testid="diagnostics-recheck-error" className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {results.map((result) => (
            <li key={result.id} data-testid="diagnostics-check-result" data-check-id={result.id} data-status={result.status} className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                  {result.status === "pass" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-rose-600" />}
                  {result.label}
                </span>
                <span className="text-[12px] text-slate-400">{result.checkedAt}</span>
              </div>
              <p className={`mt-1 leading-relaxed ${result.status === "pass" ? "text-slate-600" : "text-rose-700"}`} data-testid="diagnostics-check-detail">
                {result.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
