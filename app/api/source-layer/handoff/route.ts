import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  SourceLayerServiceError,
  handoffCapturesToResearch,
} from "@/lib/sourceLayer/server/sourceLayerService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBJECTS_PER_HANDOFF = 20;
const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  let expected = url.origin;
  if (host !== null) {
    try {
      expected = new URL(`${url.protocol}//${host}`).origin;
    } catch {
      return false;
    }
  }
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && new URL(referer).origin === expected
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");
  }
  const rawSubjects = (body as { subjectKeys?: unknown }).subjectKeys;
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) {
    return errorResponse(400, "candidate_selection_empty", "请先选择要进入研究池的商品。");
  }
  if (rawSubjects.length > MAX_SUBJECTS_PER_HANDOFF) {
    return errorResponse(400, "candidate_selection_too_large", "一次最多交接 20 个商品。");
  }
  const subjectKeys: string[] = [];
  for (const item of rawSubjects) {
    if (typeof item !== "string" || !SUBJECT_KEY_PATTERN.test(item.trim())) {
      return errorResponse(400, "candidate_selection_invalid", "商品标识不合法。");
    }
    subjectKeys.push(item.trim());
  }

  try {
    const result = await handoffCapturesToResearch({
      context: auth.context,
      subjectKeys,
    });
    const destination = "/opportunity-candidates?view=startable";
    return NextResponse.json({
      ok: true,
      data: {
        created: result.summary.created,
        skipped: result.summary.skipped,
        conflicts: result.summary.conflicts,
        evidenceOnlyNote: result.evidenceOnlyNote,
        destinationUrl: destination,
      },
    });
  } catch (error) {
    if (error instanceof SourceLayerServiceError) {
      const status = error.code === "candidate_not_ready" ? 422
        : error.code === "candidate_selection_empty" ? 400
          : 500;
      return errorResponse(status, error.code, error.message);
    }
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_handoff_failed";
    return errorResponse(500, code, "交接研究池失败，请稍后重试。");
  }
}
