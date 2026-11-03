import { NextRequest, NextResponse } from "next/server";

import { authorizeMonitoringRequest, monitoringError } from "@/lib/server/continuousMonitoringHttp";
import { createMonitoringRepository } from "@/lib/server/continuousMonitoringRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const denied = authorizeMonitoringRequest(request, false);
  if (denied) return denied;
  const { runId } = await context.params;
  try {
    const run = await createMonitoringRepository().getRun(runId);
    return run
      ? NextResponse.json({ ok: true, data: { run } })
      : monitoringError(404, "monitoring_run_not_found", "检查记录不存在。");
  } catch {
    return monitoringError(500, "monitoring_storage_unavailable", "检查记录暂时不可读。");
  }
}
