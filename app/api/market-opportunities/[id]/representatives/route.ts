import { NextRequest, NextResponse } from "next/server";

import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { apiErrorOf, sameOrigin } from "@/lib/server/marketOpportunityService";
import {
  MarketOpportunityRepresentativeError,
  readRepresentativeView,
  saveRepresentativeSelections,
} from "@/lib/server/marketOpportunityRepresentativeService";
import { logAgentEvent } from "@/lib/server/agentEventLogger";
import { REPRESENTATIVE_ROLE_TAGS, type RepresentativeRoleTag } from "@/lib/marketOpportunity/representatives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorBody(error: unknown) {
  if (error instanceof MarketOpportunityRepresentativeError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  const mapped = apiErrorOf(error, "代表商品操作失败，请刷新后重试。");
  if (mapped.httpStatus >= 500) console.error("[market-opportunity representatives] unexpected error", error);
  return { status: mapped.httpStatus, body: { ok: false, error: { code: mapped.code, message: mapped.message } } };
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  const { id } = await context.params;
  try {
    return json({ ok: true, data: await readRepresentativeView(id) });
  } catch (error) {
    const mapped = errorBody(error);
    return json(mapped.body, mapped.status);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (!sameOrigin(request)) return json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, 403);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: { code: "body_too_large", message: "请求体过大。" } }, 413);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: "invalid_json", message: "请求体必须是 JSON。" } }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ ok: false, error: { code: "invalid_body", message: "请求体必须是 JSON 对象。" } }, 400);
  }
  const payload = body as Record<string, unknown>;
  const allowed = new Set(["expectedRevision", "selections"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    return json({ ok: false, error: { code: "invalid_body", message: "请求包含未允许的字段。" } }, 400);
  }
  if (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0 || !Array.isArray(payload.selections)) {
    return json({ ok: false, error: { code: "invalid_body", message: "缺少有效的 revision 或 selections。" } }, 422);
  }
  const selections = payload.selections.map((raw) => {
    const value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const roleTags = Array.isArray(value.roleTags)
      ? value.roleTags.filter((tag): tag is RepresentativeRoleTag => typeof tag === "string" && (REPRESENTATIVE_ROLE_TAGS as readonly string[]).includes(tag))
      : [];
    return {
      productFactSubjectKey: typeof value.productFactSubjectKey === "string" ? value.productFactSubjectKey : "",
      asin: typeof value.asin === "string" ? value.asin : "",
      roleTags,
      candidateId: null,
      selectedBy: "owner:v1",
      selectedAt: new Date().toISOString(),
      note: value.note === null || typeof value.note === "string" ? value.note : null,
    };
  });
  const { id } = await context.params;
  try {
    const data = await saveRepresentativeSelections({
      context: auth.context,
      opportunityId: id,
      expectedRevision: payload.expectedRevision as number,
      selections,
    });
    await logAgentEvent({
      module: "market-opportunity",
      event: "representatives_saved",
      level: "info",
      message: "代表商品选择已保存。",
      metadata: { opportunityId: id, selectedCount: data.selectedCount, revision: data.revision },
    });
    return json({ ok: true, data });
  } catch (error) {
    const mapped = errorBody(error);
    return json(mapped.body, mapped.status);
  }
}
