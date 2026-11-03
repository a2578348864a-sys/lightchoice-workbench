import type { Metadata } from "next";
import Link from "next/link";
import activeStyles from "@/components/ui/ActiveWorkspace.module.css";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Layers,
  Lock,
  RefreshCw,
  Server,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { DiagnosticsRecheck } from "@/components/diagnostics/DiagnosticsRecheck";
import { getRedactedLarkConfig } from "@/lib/integrations/lark/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "系统诊断与协同设置 - 轻选工作台",
  description: "查看工作台组件清单、配置检查结果与飞书多维表格 Sidecar 适配器状态。",
};

function maskSecret(val: string | undefined): string {
  if (!val) return "未配置";
  if (val.length <= 8) return "••••••••";
  return `${val.slice(0, 4)}••••${val.slice(-4)}`;
}

export default function DiagnosticsPage() {
  const config = getRedactedLarkConfig();

  return (
    <WorkspaceFrame>
        <div className={`min-w-0 flex-1 ${activeStyles.diagnostics}`}>
          <header className="workspace-header page-header mb-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">系统基础设施</p>
                <h1 className="section-title mt-1 text-2xl sm:text-3xl font-bold text-slate-950">系统诊断与协同设置</h1>
                <p className="mt-1.5 max-w-3xl text-xs sm:text-sm leading-relaxed text-slate-500">
                  先确认本地服务和数据能否读取，再查看连接配置。凭证只在服务端保存，页面展示脱敏信息。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                    config.configured
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                  }`}
                >
                  {config.configured ? (
                    <>
                      <CheckCircle2 className="size-3.5 text-emerald-600" />
                      飞书配置已提供
                    </>
                  ) : (
                    <>
                      <Lock className="size-3.5 text-amber-600" />
                      飞书环境变量待配置
                    </>
                  )}
                </span>
              </div>
            </div>
          </header>

          <DiagnosticsRecheck />

          {/* 页面入口是目录，不冒充服务健康 */}
          <details className="mb-6 border-b border-slate-200 pb-5">
            <summary className="text-base font-semibold">
              <Layers className="size-4 text-emerald-600" />
              <span>工作台入口</span>
            </summary>
            <p className="mb-3 text-xs text-slate-500">以下为页面入口清单，尚无组件健康数据源，不表示服务可用或流程已通过验收。</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <Link
                href="/"
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 hover:border-emerald-400 hover:bg-white transition"
              >
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="font-mono text-[13px]">00 /</span>
                  <ArrowRight className="size-3.5 text-slate-400" />
                </div>
                <span className="font-bold text-slate-900 block text-sm">工作台总览</span>
                <span className="text-[13px] text-slate-500 mt-1 block">5秒回答3个问题，推进看板</span>
              </Link>

              <Link
                href="/source"
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 hover:border-emerald-400 hover:bg-white transition"
              >
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="font-mono text-[13px]">01 /source</span>
                  <ArrowRight className="size-3.5 text-slate-400" />
                </div>
                <span className="font-bold text-slate-900 block text-sm">商品来源</span>
                <span className="text-[13px] text-slate-500 mt-1 block">Amazon/卖家精灵清洗入库</span>
              </Link>

              <Link
                href="/market-analysis"
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 hover:border-emerald-400 hover:bg-white transition"
              >
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="font-mono text-[13px]">02 /market-analysis</span>
                  <ArrowRight className="size-3.5 text-slate-400" />
                </div>
                <span className="font-bold text-slate-900 block text-sm">市场分析</span>
                <span className="text-[13px] text-slate-500 mt-1 block">确定性大盘指标与代表品初筛</span>
              </Link>

              <Link
                href="/research"
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 hover:border-emerald-400 hover:bg-white transition"
              >
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="font-mono text-[13px]">03 /research</span>
                  <ArrowRight className="size-3.5 text-slate-400" />
                </div>
                <span className="font-bold text-slate-900 block text-sm">商品深度研究</span>
                <span className="text-[13px] text-slate-500 mt-1 block">第一屏单面研报与用户最终拍板</span>
              </Link>
            </div>
          </details>

          {/* 飞书 Sidecar 协同连接状态 */}
          <section className="mb-6 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-4">
              <div className="flex items-center gap-2.5">
                <div
                  className={`flex size-9 items-center justify-center rounded-xl ${
                    config.configured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {config.configured ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-950">飞书连接配置（兼容入口）</h2>
                  <p className="text-xs text-slate-500">
                    {config.configured
                      ? "已检测到服务端配置；连接结果尚未验证。LightChoice 为唯一权威事实源，单向投影到飞书。"
                      : "缺少必要服务端环境变量。外部写入保持安全拦截（失败即阻断）。"}
                  </p>
                </div>
              </div>
              <a
                href="https://open.feishu.cn"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <span>飞书开放平台</span>
                <ExternalLink className="size-3" />
              </a>
            </div>

            <details className={activeStyles.disclosure}><summary>脱敏配置与兼容投影说明</summary>
            <p className="text-sm text-slate-600">以下为既有 Sidecar 1 Base / 2 Tables 兼容配置；当前个人研究库的连接与逐表状态可在飞书工作区核对。</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
                <span className="text-slate-400 block mb-1">开放平台网关</span>
                <span className="font-semibold text-slate-800 font-mono">
                  {config.openApiDomain || "https://open.feishu.cn"}
                </span>
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
                <span className="text-slate-400 block mb-1">应用凭据 (App ID)</span>
                <span className="font-semibold text-slate-800 font-mono">
                  {maskSecret(config.appId)}
                </span>
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
                <span className="text-slate-400 block mb-1">多维表格 Token</span>
                <span className="font-semibold text-slate-800 font-mono">
                  {maskSecret(config.appToken)}
                </span>
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
                <span className="text-slate-400 block mb-1">目标数据表 (Table ID)</span>
                <span className="font-semibold text-slate-800 font-mono">
                  {maskSecret(config.tableId)}
                </span>
              </div>
            </div>

            {/* 表 1 与 表 2 架构说明 */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-slate-100 text-xs">
              <div className="rounded-xl border border-slate-200 p-3.5 bg-slate-50/50">
                <span className="font-bold text-slate-800 block text-xs mb-1">
                  Table 1: 市场分析样本大表 (Market Samples)
                </span>
                <p className="text-[13px] text-slate-500 leading-relaxed">
                  主键为 <code>scanId:ASIN</code>。承接市场扫描 40+ 字段大宽表、价格分布与销量估算，按扫描快照单向写入。
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 p-3.5 bg-slate-50/50">
                <span className="font-bold text-slate-800 block text-xs mb-1">
                  Table 2: 商品研究结果归档表 (Research Archive)
                </span>
                <p className="text-[13px] text-slate-500 leading-relaxed">
                  主键为 <code>taskId:researchRevision</code>。承接用户本人拍板决策、DeepSeek 研报摘要与不可变证据哈希。
                </p>
              </div>
            </div>
            </details>
          </section>

          {/* 安全与边界红线 */}
          <details className="border-b border-slate-200 pb-5">
            <summary>数据安全与人工判断边界</summary>
            <div className="grid gap-3 text-xs text-slate-600 sm:grid-cols-2 mt-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <span className="font-semibold text-slate-800 block mb-1">1. 单向受控投影</span>
                <p className="text-[13px] leading-relaxed text-slate-500">
                  LightChoice 是唯一业务事实源；飞书多维表格只作单向协同镜像，绝不允许飞书反向修改本地决策。
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <span className="font-semibold text-slate-800 block mb-1">2. 零 AI 自动拍板</span>
                <p className="text-[13px] leading-relaxed text-slate-500">
                  AI 只生成辅助研报与机会/风险提炼，禁止大模型或后台服务自动做出最终商业选择或立项。
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <span className="font-semibold text-slate-800 block mb-1">3. 凭据永不入前端</span>
                <p className="text-[13px] leading-relaxed text-slate-500">
                  App Secret、API Key 等绝密凭据始终在服务端持有，前端接口与表单严禁输入或展示明文。
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <span className="font-semibold text-slate-800 block mb-1">4. 失败即阻断</span>
                <p className="text-[13px] leading-relaxed text-slate-500">
                  外部调用异常或凭据缺失时严格 fail-closed，禁止使用 Mock 或本地虚拟数据伪造同步成功。
                </p>
              </div>
            </div>
          </details>
        </div>
    </WorkspaceFrame>
  );
}
