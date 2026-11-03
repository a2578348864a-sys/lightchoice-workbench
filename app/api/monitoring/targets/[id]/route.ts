import { NextRequest, NextResponse } from "next/server";

import { isMonitoringSchedule, isValidTimeZone, parseMonitoringPolicy } from "@/lib/server/continuousMonitoringContract";
import {
  authorizeMonitoringRequest,
  monitoringError,
  onlyAllowedKeys,
  readMonitoringJsonBody,
} from "@/lib/server/continuousMonitoringHttp";
import { createMonitoringRepository } from "@/lib/server/continuousMonitoringRepository";
import {
  isContinuousMonitoringRetired,
  MONITORING_RETIRED_CODE,
  MONITORING_RETIRED_MESSAGE,
} from "@/lib/server/continuousMonitoringRetirement";
import { nextMonitoringRunAt } from "@/lib/server/continuousMonitoringContract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const denied = authorizeMonitoringRequest(request, false);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const watch = await createMonitoringRepository().getWatch(id);
    return watch
      ? NextResponse.json({ ok: true, data: { watch } })
      : monitoringError(404, "watch_not_found", "监控目标不存在。");
  } catch {
    return monitoringError(500, "monitoring_storage_unavailable", "监控数据暂时不可读。");
  }
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  // V6 退役门禁：编辑、启用、停用与恢复都属于永久停止的写入入口，统一返回 410。
  if (isContinuousMonitoringRetired()) {
    return monitoringError(410, MONITORING_RETIRED_CODE, MONITORING_RETIRED_MESSAGE);
  }
  const denied = authorizeMonitoringRequest(request, true);
  if (denied) return denied;
  const body = await readMonitoringJsonBody(request);
  if (!body) return monitoringError(400, "invalid_request_body", "请求体不是合法 JSON 或超过大小限制。");
  if (!onlyAllowedKeys(body, ["enabled", "schedule", "timezone", "policy"]) || Object.keys(body).length === 0) {
    return monitoringError(422, "monitoring_fields_unsupported", "请求字段为空或包含 V1 不支持的字段。");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return monitoringError(422, "enabled_invalid", "enabled 必须为布尔值。");
  }
  if (body.schedule !== undefined && !isMonitoringSchedule(body.schedule)) {
    return monitoringError(422, "schedule_invalid", "V1 计划仅支持每天本地时间 09:00 或 21:00。");
  }
  if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
    return monitoringError(422, "timezone_invalid", "请提供有效的 IANA 时区。");
  }
  const policy = body.policy === undefined ? undefined : parseMonitoringPolicy(body.policy);
  if (body.policy !== undefined && !policy) return monitoringError(422, "policy_invalid", "变化规则超出 V1 允许字段或阈值范围。");

  const { id } = await context.params;
  const repository = createMonitoringRepository();
  try {
    const existing = await repository.getWatch(id);
    if (!existing) return monitoringError(404, "watch_not_found", "监控目标不存在。");
    const patch = {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(policy ? { policy } : {}),
    };
    const schedule = patch.schedule ?? existing.schedule;
    const timezone = patch.timezone ?? existing.timezone;
    const nextRunAt = nextMonitoringRunAt(schedule, timezone, new Date()).toISOString();
    const watch = await repository.updateWatch(id, patch, nextRunAt);
    return watch
      ? NextResponse.json({ ok: true, data: { watch } })
      : monitoringError(404, "watch_not_found", "监控目标不存在。");
  } catch {
    return monitoringError(500, "monitoring_storage_unavailable", "监控配置未能更新。");
  }
}
