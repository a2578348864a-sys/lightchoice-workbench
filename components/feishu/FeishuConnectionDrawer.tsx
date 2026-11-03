"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Badge } from "@/components/ui/Badge";
import { buildAccessHeaders } from "@/lib/client/accessToken";

export type FeishuConnectionStatus = {
  configured: boolean;
  status: "ready" | "degraded" | "down" | "not_configured";
  preflight: "passed" | "failed" | "unknown";
  marketTableReady: boolean;
  researchTableReady: boolean;
  baseOpenUrl: string | null;
  displayName: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: { code: string; message: string; retryable: boolean } | null;
};

interface FeishuConnectionDrawerProps {
  open: boolean;
  onClose: () => void;
  onStatusChange?: (status: FeishuConnectionStatus | null) => void;
}

export function FeishuConnectionDrawer({
  open,
  onClose,
  onStatusChange,
}: FeishuConnectionDrawerProps) {
  const [data, setData] = useState<FeishuConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchConnection = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/feishu-hub/status", {
        headers: {
          ...buildAccessHeaders(),
        },
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        // Fail-closed / graceful display
        const err = json?.error?.message || `连接信息获取失败 (${res.status})`;
        setErrorMsg(err);
        setData(null);
        onStatusChange?.(null);
        return;
      }
      setData(json.data);
      onStatusChange?.(json.data);
    } catch (e) {
      const err = e instanceof Error ? e.message : "网络异常，无法获取飞书连接状态";
      setErrorMsg(err);
      setData(null);
      onStatusChange?.(null);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    if (open) {
      fetchConnection();
    }
  }, [open, fetchConnection]);

  async function handleRetry() {
    setRetrying(true);
    try {
      await fetchConnection();
    } catch {
      // Refresh state regardless
      await fetchConnection();
    } finally {
      setRetrying(false);
    }
  }

  const statusTone =
    data?.status === "ready"
      ? "emerald"
      : data?.status === "degraded"
      ? "amber"
      : data?.status === "down"
      ? "rose"
      : "slate";

  const statusLabel =
    data?.status === "ready"
      ? "连接正常"
      : data?.status === "degraded"
      ? "连接降级"
      : data?.status === "down"
      ? "服务异常"
      : "未配置";

  return (
    <Drawer isOpen={open} onClose={onClose} title="飞书协同连接设置" width="lg">
      <div className="flex flex-col gap-5 text-sm text-slate-700">
        {/* 说明横幅 */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="size-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-xs leading-relaxed text-slate-600">
              <p className="font-semibold text-slate-800 mb-1">单向旁路协同（Sidecar）</p>
              <p>
                飞书多维表格作为选品主链的旁路协同层，负责承接横向大宽表与长期云端档案。凭证由服务端统一配置管理，前端不持有也不输入任何
                Secret。
              </p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
            <Loader2 className="size-6 animate-spin text-emerald-600" />
            <span className="text-xs">正在检测飞书服务连接...</span>
          </div>
        ) : errorMsg && !data ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldAlert className="size-4 shrink-0 text-rose-600" />
              <span>无法连接飞书协同服务</span>
            </div>
            <p className="mt-1.5 text-rose-700">{errorMsg}</p>
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={fetchConnection}>
                <RefreshCw className="size-3 mr-1.5" />
                重新检测
              </Button>
            </div>
          </div>
        ) : data ? (
          <>
            {/* 总体连接状态卡片 */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">协同 Base 状态</span>
                  <Badge tone={statusTone}>{statusLabel}</Badge>
                </div>
                <Button size="sm" variant="ghost" onClick={fetchConnection} disabled={loading}>
                  <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                </Button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 pt-3 border-t border-slate-100 text-xs">
                <div>
                  <span className="text-slate-400 block mb-0.5">多维表格 Base 名称</span>
                  <span className="font-semibold text-slate-800">
                    {data.displayName || (data.configured ? "已配置（只读）" : "未配置")}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block mb-0.5">契约预检 (Preflight)</span>
                  <span
                    className={`font-semibold ${
                      data.preflight === "passed"
                        ? "text-emerald-700"
                        : data.preflight === "failed"
                        ? "text-rose-700"
                        : "text-slate-500"
                    }`}
                  >
                    {data.preflight === "passed" ? "通过" : data.preflight === "failed" ? "未通过" : "未知"}
                  </span>
                </div>
              </div>

              {data.baseOpenUrl && (
                <div className="mt-4 pt-3 border-t border-slate-100">
                  <a
                    href={data.baseOpenUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline"
                  >
                    <span>在飞书客户端或浏览器打开此 Base</span>
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              )}
            </div>

            {/* 一 Base 两表状态 */}
            <div className="space-y-2.5">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                双表同步契约检测
              </h4>

              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-800">
                    表 1：市场分析样本大表 (Market Samples)
                  </div>
                  <div className="text-[13px] text-slate-500 mt-0.5">
                    承接 40+ 字段大宽表、竞品价格分布与销量估算快照
                  </div>
                </div>
                <Badge tone={data.marketTableReady ? "emerald" : "slate"}>
                  {data.marketTableReady ? "已就绪" : "未就绪"}
                </Badge>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-800">
                    表 2：商品研究结果归档表 (Research Archive)
                  </div>
                  <div className="text-[13px] text-slate-500 mt-0.5">
                    承接用户本人拍板决断、DeepSeek 研报摘要与证据指纹
                  </div>
                </div>
                <Badge tone={data.researchTableReady ? "emerald" : "slate"}>
                  {data.researchTableReady ? "已就绪" : "未就绪"}
                </Badge>
              </div>
            </div>

            {/* 错误或异常信息 */}
            {data.lastError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                  <span>同步异常：{data.lastError.code}</span>
                </div>
                <p className="mt-1 text-amber-800">{data.lastError.message}</p>
                {data.lastError.retryable && (
                  <div className="mt-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRetry}
                      disabled={retrying}
                    >
                      {retrying && <Loader2 className="size-3 animate-spin mr-1.5" />}
                      重试失败同步
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* 检查时间 */}
            {data.lastCheckedAt && (
              <div className="text-[13px] text-slate-400 text-right">
                最近检测时间：{new Date(data.lastCheckedAt).toLocaleString("zh-CN")}
              </div>
            )}
          </>
        ) : null}

        {/* 底部安全提示 */}
        <div className="mt-auto border-t border-slate-100 pt-4 text-[13px] text-slate-400">
          <p>
            注：若需修改飞书 App ID / App Secret，请由运维在服务端环境变量中更新，前端不提供凭据保存入口。
          </p>
        </div>
      </div>
    </Drawer>
  );
}
