import type { Metadata } from "next";
import Link from "next/link";
import { Archive, ShieldCheck } from "lucide-react";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "持续监控已停止提供 - 轻选工作台",
  description: "持续监控已从正式产品范围退役；原有历史记录及采集证据仍予保留，不再执行新的监控任务。",
};

export default function MonitoringRetiredPage() {
  return (
    <WorkspaceFrame>
      <div className="min-w-0 flex-1">
        <section className="workspace-header page-header" aria-labelledby="monitoring-retired-title">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">功能已退役 · RETIRED FEATURE</p>
          <h1
            id="monitoring-retired-title"
            className="section-title mt-1 text-2xl font-bold text-slate-950 sm:text-3xl"
          >
            持续监控已停止提供
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">
            持续监控已停止提供。原有历史记录及采集证据仍予保留，但不再执行新的监控任务。
          </p>
        </section>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Archive className="size-4 text-emerald-600" aria-hidden="true" />
              历史数据仍然保留
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              原有监控目标、检查记录、采集运行记录与 EvidenceStore 原始证据均保留在本地，不删除、不迁移，仅供历史核对。
            </p>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <ShieldCheck className="size-4 text-emerald-600" aria-hidden="true" />
              不再执行新的监控任务
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              自动检查已关闭；创建、编辑、启用、停用与手动检查均已停止，不会发起新的商品采集。
            </p>
          </article>
        </div>

        <p className="mt-5 text-xs leading-relaxed text-slate-500">
          本变更不影响 01 市场采集、02 市场研究、03 商品深研与 04 产品开发需求单。
        </p>

        <div className="mt-6">
          <Link href="/" className="lc-hifi-btn primary">
            返回探索台
          </Link>
        </div>
      </div>
    </WorkspaceFrame>
  );
}
