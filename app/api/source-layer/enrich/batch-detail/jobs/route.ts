import { NextRequest, NextResponse } from "next/server";

import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { authResponse, jsonBody, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import {
  controlBatchDetailEnrichmentJob,
  ensureBatchDetailEnrichmentJob,
  getBatchDetailEnrichmentJob,
  runBatchDetailEnrichmentJobOnce,
} from "@/lib/server/batchDetailEnrichmentScheduler";
import { V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validBatchId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,64}$/u.test(value.trim());
}

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  const batchId = new URL(request.url).searchParams.get("batchId");
  if (!validBatchId(batchId)) {
    return NextResponse.json({ ok: false, error: { code: "BATCH_ID_INVALID", message: "batchId 无效。" } }, { status: 400 });
  }
  try {
    const result = await getBatchDetailEnrichmentJob({ context: auth.context, batchId });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!sameOrigin(request)) {
    return NextResponse.json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, { status: 403 });
  }
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new V5CoreError("INVALID_INPUT", "请求体必须是 JSON object。", 400);
    const record = body as Record<string, unknown>;
    if (!validBatchId(record.batchId)) throw new V5CoreError("BATCH_ID_INVALID", "batchId 无效。", 400);
    if (record.action === "run-one") {
      if (Object.keys(record).length !== 2) throw new V5CoreError("INVALID_INPUT", "手动执行仅接受 batchId 与 action。", 400);
      const job = await runBatchDetailEnrichmentJobOnce({ context: auth.context, batchId: record.batchId });
      return NextResponse.json({ ok: true, data: { job, attemptedLimit: 1 } });
    }
    if (record.action === "ensure") {
      const result = await ensureBatchDetailEnrichmentJob({ context: auth.context, batchId: record.batchId });
      return NextResponse.json({ ok: true, data: result }, { status: result.created ? 201 : 200 });
    }
    if (record.action === "pause" || record.action === "resume" || record.action === "cancel") {
      if (Object.keys(record).length !== 2) throw new V5CoreError("INVALID_INPUT", "任务操作参数无效。", 400);
      if (record.action === "resume") {
        const existing = await getBatchDetailEnrichmentJob({ context: auth.context, batchId: record.batchId });
        const result = existing.job
          ? await controlBatchDetailEnrichmentJob({ context: auth.context, batchId: record.batchId, action: "resume" })
          : (await ensureBatchDetailEnrichmentJob({ context: auth.context, batchId: record.batchId })).job;
        if (!result) throw new V5CoreError("DETAIL_JOB_NOT_FOUND", "详情补齐任务不存在。", 404);
        return NextResponse.json({ ok: true, data: { job: result } });
      }
      const result = await controlBatchDetailEnrichmentJob({ context: auth.context, batchId: record.batchId, action: record.action });
      if (!result) throw new V5CoreError("DETAIL_JOB_NOT_FOUND", "详情补齐任务不存在。", 404);
      return NextResponse.json({ ok: true, data: { job: result } });
    }
    throw new V5CoreError("INVALID_ACTION", "任务操作无效。", 400);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
