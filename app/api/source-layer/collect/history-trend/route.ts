import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { decideHistoryTrendSource, type HistoryTrendSourceCandidate } from "@/tools/collectors/recipes/historyTrend";
import { recordHistoryTrendDecision } from "@/lib/sourceLayer/server/trendObservationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  try {
    return referer !== null && isSameOriginRequest(new URL(referer).origin, request);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCandidates(value: unknown): HistoryTrendSourceCandidate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const candidates: HistoryTrendSourceCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.sourceId !== "string"
      || !["official_api", "official_export", "manual"].includes(String(item.sourceType))
      || typeof item.reliable !== "boolean"
      || typeof item.hasStructuredTimeSeries !== "boolean") {
      return undefined;
    }
    candidates.push({
      sourceId: item.sourceId.trim().slice(0, 160),
      sourceType: item.sourceType as HistoryTrendSourceCandidate["sourceType"],
      reliable: item.reliable,
      hasStructuredTimeSeries: item.hasStructuredTimeSeries,
    });
  }
  return candidates;
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (!isRecord(body) || typeof body.subjectKey !== "string" || !SUBJECT_KEY_PATTERN.test(body.subjectKey.trim())) {
    return errorResponse(400, "subject_key_invalid", "趋势决定必须绑定到合法的 Source Layer 商品主体。");
  }
  const candidates = parseCandidates(body.candidates);
  if (body.candidates !== undefined && candidates === undefined) {
    return errorResponse(400, "candidates_invalid", "趋势来源候选格式无效，系统不会猜测来源能力。");
  }
  const decision = decideHistoryTrendSource({ candidates });
  try {
    const audit = await recordHistoryTrendDecision({
      context: auth.context,
      subjectKey: body.subjectKey.trim(),
      decision,
    });
    return NextResponse.json({ ok: true, data: { decision, audit } }, { status: 201 });
  } catch (error) {
    console.error("[source-layer/history-trend]", { code: "trend_decision_persist_failed" });
    return errorResponse(409, "trend_decision_persist_failed", error instanceof Error ? error.message : "历史趋势决定未能保存。");
  }
}
