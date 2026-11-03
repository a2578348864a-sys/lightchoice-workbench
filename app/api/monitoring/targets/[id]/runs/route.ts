import { NextRequest, NextResponse } from "next/server";

import { projectCapturesForSubject } from "@/lib/server/continuousMonitoringCaptureProjection";
import { authorizeMonitoringRequest, monitoringError } from "@/lib/server/continuousMonitoringHttp";
import { createMonitoringRepository } from "@/lib/server/continuousMonitoringRepository";
import {
  isContinuousMonitoringRetired,
  MONITORING_RETIRED_CODE,
  MONITORING_RETIRED_MESSAGE,
} from "@/lib/server/continuousMonitoringRetirement";
import { runMonitoringTarget } from "@/lib/server/continuousMonitoringService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const denied = authorizeMonitoringRequest(request, false);
  if (denied) return denied;
  const { id } = await context.params;
  const rawTake = Number(new URL(request.url).searchParams.get("take") ?? "50");
  const take = Number.isFinite(rawTake) ? Math.max(1, Math.min(100, Math.trunc(rawTake))) : 50;
  try {
    const repository = createMonitoringRepository();
    const watch = await repository.getWatch(id);
    if (!watch) return monitoringError(404, "watch_not_found", "监控目标不存在。");
    const runs = await repository.listRuns(id, take);
    // One EvidenceStore read per subject; each run row then shows what it actually captured.
    const references = runs.flatMap((run) => [run.currentEvidenceRef, run.previousEvidenceRef]);
    const projections = await projectCapturesForSubject(watch.subjectKey, references);
    const runsWithCapture = runs.map((run, index) => ({
      ...run,
      capture: projections[index * 2] ?? null,
      previousCapture: projections[index * 2 + 1] ?? null,
    }));
    return NextResponse.json({ ok: true, data: { runs: runsWithCapture } });
  } catch {
    return monitoringError(500, "monitoring_storage_unavailable", "运行历史暂时不可读。");
  }
}
export async function POST(request: NextRequest, context: RouteContext) {
  // V6 退役门禁：手动「立即检查」属于永久停止的执行入口，不得进入采集服务。
  if (isContinuousMonitoringRetired()) {
    return monitoringError(410, MONITORING_RETIRED_CODE, MONITORING_RETIRED_MESSAGE);
  }
  const denied = authorizeMonitoringRequest(request, true);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const repository = createMonitoringRepository();
    const recentRuns = await repository.listRuns(id, 1);
    const lastRun = recentRuns[0];
    if (lastRun?.startedAt) {
      const elapsedMs = Date.now() - Date.parse(lastRun.startedAt);
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 3000) {
        return NextResponse.json({ ok: true, data: { status: "STARTED", run: lastRun } }, { status: 200 });
      }
    }
    const result = await runMonitoringTarget({ watchTargetId: id, triggerType: "MANUAL" });
    if (result.status === "NOT_FOUND") return monitoringError(404, "watch_not_found", "监控目标不存在。");
    if (result.status === "NOT_DUE") return monitoringError(409, "monitoring_run_not_due", "自动检查尚未到计划时间。");
    return NextResponse.json({ ok: true, data: result }, { status: result.status === "STARTED" ? 201 : 200 });
  } catch {
    return monitoringError(500, "monitoring_run_failed", "立即检查未能启动；没有确认任何变化事件。");
  }
}
