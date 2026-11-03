"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, FolderOpen, Loader2, Play, RefreshCw, Wifi, WifiOff } from "lucide-react";

import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { SellerSpriteCdpReadiness } from "@/lib/server/captureEnvironmentReadiness";

type BrowserIdentity = "managed" | "foreign" | "unknown";

/** 环境数据 = 只读 CDP 探测 + 实例身份（D2-1F：CDP 可达 ≠ 本工作台专用实例）。 */
export type EnvironmentData = SellerSpriteCdpReadiness & { browserIdentity?: BrowserIdentity | null };

type CardState =
  | { kind: "loading" }
  | { kind: "result"; readiness: EnvironmentData }
  | { kind: "error"; message: string };

function checkedAtLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

/**
 * D2-1：采集环境状态改为「一行摘要 + 按需展开诊断」。
 * 环境异常时自动展开详细诊断；正常时默认收起，不再占用首屏大量空间。
 */
export function CaptureEnvironmentStatusCard({ compact = false, onReadinessChange }: { compact?: boolean; onReadinessChange?: (value: EnvironmentData | null) => void } = {}) {
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [openProfileBusy, setOpenProfileBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(null);

  const checkReadiness = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/source-layer/capture-environment", {
        method: "GET",
        cache: "no-store",
        headers: buildAccessHeaders(),
      });
      const payload = await response.json() as {
        ok?: boolean;
        data?: SellerSpriteCdpReadiness;
      };

      if (!response.ok || payload.ok !== true || !payload.data) {
        setState({ kind: "error", message: "暂时无法读取采集环境状态，请稍后重试。" });
        onReadinessChange?.(null);
        return;
      }
      setState({ kind: "result", readiness: payload.data });
      onReadinessChange?.(payload.data);
    } catch {
      setState({ kind: "error", message: "采集环境状态读取失败，请检查工作台连接后重试。" });
      onReadinessChange?.(null);
    } finally {
      setRefreshing(false);
    }
  }, [onReadinessChange]);

  useEffect(() => {
    void checkReadiness();
  }, [checkReadiness]);

  /**
   * 受控启动 SellerSprite 专用可见浏览器（POST，无参数）。
   * 已运行/已复用时服务端直接返回，不会重复启动；完成后回读权威 CDP 状态。
   * 该操作绝不控制用户日常 Chrome（固定专用 Profile 启动）。
   */
  const launchSellerspriteBrowser = useCallback(async () => {
    setLaunchBusy(true);
    setActionNotice(null);
    try {
      const response = await fetch("/api/source-layer/capture-environment/launch-sellersprite-browser", {
        method: "POST",
        cache: "no-store",
        headers: buildAccessHeaders(),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { status?: string };
        error?: { code?: string; message?: string };
      } | null;
      if (!response.ok || payload?.ok !== true) {
        setActionNotice({ tone: "error", message: payload?.error?.message ?? `启动请求失败（${response.status}）。` });
      } else {
        setActionNotice({
          tone: "success",
          message: payload.data?.status === "already_running"
            ? "已校验为专用实例，复用现有连接（未重复启动）。"
            : "专用浏览器已启动，调试端口已连接；请在该浏览器窗口中登录/使用 SellerSprite。",
        });
      }
    } catch {
      setActionNotice({ tone: "error", message: "启动请求未完成（网络中断）；请稍后重试。" });
    } finally {
      setLaunchBusy(false);
      void checkReadiness();
    }
  }, [checkReadiness]);

  /** 打开专用 Profile 目录（辅助入口；目录由服务端解析，不接受前端路径）。 */
  const openSellerspriteProfile = useCallback(async () => {
    setOpenProfileBusy(true);
    setActionNotice(null);
    try {
      const response = await fetch("/api/source-layer/capture-environment/open-sellersprite-profile", {
        method: "POST",
        cache: "no-store",
        headers: buildAccessHeaders(),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { profileDir?: string };
        error?: { message?: string };
      } | null;
      if (!response.ok || payload?.ok !== true) {
        setActionNotice({ tone: "error", message: payload?.error?.message ?? `打开目录失败（${response.status}）。` });
      } else {
        setActionNotice({ tone: "info", message: `已在本机文件管理器中打开专用 Profile 目录${payload.data?.profileDir ? `：${payload.data.profileDir}` : "。"}` });
      }
    } catch {
      setActionNotice({ tone: "error", message: "打开目录请求未完成（网络中断）。" });
    } finally {
      setOpenProfileBusy(false);
    }
  }, []);

  const ready = state.kind === "result" && state.readiness.cdpReachable;
  const badgeClass = ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-amber-200 bg-amber-50 text-amber-800";

  // D2-1B：详细诊断默认折叠，摘要行常驻；用户手动开合优先。
  const showDetails = detailsOpen;

  const summaryLabel = state.kind === "loading"
    ? "正在检查…"
    : state.kind === "error"
      ? "读取失败"
      : ready
        ? "CDP 可达"
        : state.readiness.status === "misconfigured"
          ? "配置异常"
          : "CDP 不可达";

  return (
    <section
      aria-labelledby="capture-environment-title"
      data-testid="capture-environment-card"
      data-cdp-status={state.kind === "result" ? state.readiness.status : state.kind}
      className="surface-card rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-xs"
    >
      {/* 一行摘要：图标 + 状态 + 关键提示 + 展开/收起 + 重新检测 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}
          aria-hidden="true"
        >
          {ready ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
        </span>
        <h2 id="capture-environment-title" className="text-[13px] font-semibold text-slate-700">
          采集环境
        </h2>
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeClass}`} data-testid="capture-environment-status">
          {summaryLabel}
        </span>
        {!compact && state.kind === "result" && (
          <span className="text-[13px] text-slate-500 truncate max-w-[420px]" data-testid="capture-environment-result">
            {state.readiness.message}
          </span>
        )}
        {/* D2-1F：CDP 可达 ≠ 本工作台专用实例——身份独立展示（managed / foreign / unknown） */}
        {state.kind === "result" && state.readiness.cdpReachable && state.readiness.browserIdentity ? (
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${state.readiness.browserIdentity === "managed"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : state.readiness.browserIdentity === "foreign"
                ? "border-rose-200 bg-rose-50 text-rose-800"
                : "border-amber-200 bg-amber-50 text-amber-800"}`}
            data-testid="capture-environment-browser-identity"
          >
            {state.readiness.browserIdentity === "managed"
              ? "专用实例"
              : state.readiness.browserIdentity === "foreign"
                ? "非专用实例"
                : "身份未验证"}
          </span>
        ) : null}
        {/* Amazon 采集是独立通道：CDP 可达不代表 Amazon 就绪，摘要行单独展示真实开关状态 */}
        {!compact && state.kind === "result" && state.readiness.amazon ? (
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${state.readiness.amazon.enabled
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"}`}
            data-testid="capture-environment-amazon-badge"
          >
            {state.readiness.amazon.enabled ? "Amazon 采集：已开启" : "Amazon 采集：未开启"}
          </span>
        ) : null}
        {state.kind === "error" && (
          <span className="text-[13px] text-rose-600 truncate max-w-[420px]" data-testid="capture-environment-error">
            {state.message}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {state.kind === "result" ? (
            <button
              type="button"
              onClick={() => void launchSellerspriteBrowser()}
              disabled={launchBusy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60"
              data-testid="capture-environment-launch-sellersprite"
            >
              {launchBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {ready ? "复用专用浏览器" : "启动专用浏览器"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={showDetails}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            data-testid="capture-environment-details-toggle"
          >
            {showDetails ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            诊断详情
          </button>
          <button
            type="button"
            onClick={() => void checkReadiness()}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
            data-testid="capture-environment-refresh"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            重新检测
          </button>
        </span>
      </div>

      {actionNotice ? (
        <p
          role={actionNotice.tone === "error" ? "alert" : "status"}
          data-testid="capture-environment-launch-notice"
          className={`mt-2 rounded-lg border px-2.5 py-2 text-xs ${actionNotice.tone === "error"
            ? "border-rose-200 bg-rose-50 text-rose-900"
            : actionNotice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-sky-200 bg-sky-50 text-sky-900"}`}
        >
          {actionNotice.message}
        </p>
      ) : null}

      {/* 详细诊断：按需展开 */}
      {showDetails && (
        <div className="mt-3 space-y-3" aria-live="polite">
          <div className="rounded-xl bg-slate-50 p-3.5">
            {state.kind === "loading" ? (
              <p className="text-sm text-slate-600" data-testid="capture-environment-loading">正在检查 CDP 连接…</p>
            ) : state.kind === "error" ? (
              <div>
                <p className="text-sm font-semibold text-rose-700">检查失败</p>
                <p className="mt-1 text-xs leading-5 text-slate-600">{state.message}</p>
              </div>
            ) : (
              <div className="min-w-0">
                <p className="mt-1 text-sm font-medium text-slate-900" data-testid="capture-environment-next-action">
                  {state.readiness.nextAction}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openSellerspriteProfile()}
                    disabled={openProfileBusy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                    data-testid="capture-environment-open-profile"
                  >
                    {openProfileBusy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
                    打开 Profile 目录
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-slate-500">
                  专用浏览器使用本机已安装的 Google Chrome 与固定专用 Profile（默认
                  .playwright-profile/sellersprite-v3），仅监听本机调试端口；
                  不会控制或影响你日常使用的 Chrome 窗口。
                  {ready
                    ? " 检测到本机调试端口已有 Chrome 在运行：点击「复用专用浏览器」会先校验它是否为本工作台专用实例；校验不通过时不会连接该浏览器。"
                    : " 点击「启动专用浏览器」即可拉起，无需手动寻找目录或记住启动命令。"}
                </p>
                {/* D2-1F：身份结果明示——「CDP 可达」绝不能被读成「采集环境已就绪」 */}
                {ready && state.readiness.browserIdentity ? (
                  <p
                    className={`mt-1.5 rounded-lg border px-2.5 py-2 text-xs leading-5 ${state.readiness.browserIdentity === "managed"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : state.readiness.browserIdentity === "foreign"
                        ? "border-rose-200 bg-rose-50 text-rose-900"
                        : "border-amber-200 bg-amber-50 text-amber-900"}`}
                    data-testid="capture-environment-identity-note"
                  >
                    {state.readiness.browserIdentity === "managed"
                      ? "实例身份：已确认是本工作台专用浏览器（Profile 匹配）；采集会使用这一实例。"
                      : state.readiness.browserIdentity === "foreign"
                        ? "实例身份：非本工作台专用实例（Profile 不匹配）。该浏览器不会被采集使用；请关闭它后由工作台启动专用浏览器。"
                        : "实例身份：无法验证（该实例可能未由工作台启动，或缺少自动化标记）。正式采集会拒绝连接它；请通过工作台「启动专用浏览器」启动后重试。"}
                  </p>
                ) : null}
                <p className="mt-1.5 text-xs leading-5 text-slate-500" data-testid="capture-environment-login-status">
                  SellerSprite 登录状态：尚未验证（登录状态只在真实采集时校验；系统不会自动登录，也不会绕过验证码或平台权限）。
                </p>
                <p className="mt-2 text-[13px] text-slate-400" data-testid="capture-environment-checked-at">
                  检测时间：{checkedAtLabel(state.readiness.checkedAt)}
                  {state.readiness.latencyMs === null ? "" : ` · ${state.readiness.latencyMs} ms`}
                </p>
              </div>
            )}
          </div>
          {state.kind === "result" && state.readiness.amazon ? (
            <div className="rounded-xl bg-slate-50 p-3.5" data-testid="amazon-runtime-status">
              <p className="text-sm font-semibold text-slate-900">
                Amazon 主动采集：{state.readiness.amazon.enabled ? "已开启" : "未开启"}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">{state.readiness.amazon.message}</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                关键词与 ASIN 使用同一专用 Amazon 浏览器会话（独立于 SellerSprite CDP 通道：
                CDP 可达不等于 Amazon 采集已就绪）。当前会话尚未检测；请在采集入口检查环境。
                {state.readiness.amazon.detailExecution === "manual_only" ? "详情补齐按次手动执行，后台自动采集未开启。" : "详情补齐后台调度已开启。"}
              </p>
              {state.readiness.amazon.enabled ? null : (
                <p
                  className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900"
                  data-testid="capture-environment-amazon-recovery"
                >
                  恢复操作：Amazon 采集需要以启用「本地采集」的启动配置重新运行本工作台
                  （LOCAL_ACQUISITION_ENABLED=true 与专用 Amazon Profile 目录），并保持现有数据库 /
                  EvidenceStore / AI 与飞书 Provider 配置不变；重启后回到本卡片重新检测即可。
                  该操作涉及重启工作台，需由管理员执行。
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
