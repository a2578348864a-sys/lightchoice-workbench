import { NextRequest, NextResponse } from "next/server";
import {
  CustomerVoiceServiceError,
  normalizeAmazonReviewsForResearchTask,
  collectAmazonReviewsForResearchTask,
  analyzeVocForResearchTask,
} from "@/lib/server/customerVoiceService";
import { authResponse, originError, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { taskId } = await context.params;
    let action = "normalize";
    try {
      const body = await request.json();
      if (body && typeof body.action === "string") action = body.action;
    } catch {
      // Body may be empty in simple normalize calls
    }
    if (action === "collect") {
      const result = await collectAmazonReviewsForResearchTask({ context: auth.context, taskId });
      return NextResponse.json(okResponse(result).body);
    }
    if (action === "analyze") {
      const result = await analyzeVocForResearchTask({ context: auth.context, taskId });
      return NextResponse.json(okResponse(result).body);
    }
    return NextResponse.json(okResponse(await normalizeAmazonReviewsForResearchTask({ context: auth.context, taskId })).body);
  } catch (error) {
    if (error instanceof CustomerVoiceServiceError) {
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message, retryable: false, conflict: error.status === 409 } }, { status: error.status });
    }
    return v5ErrorResponse(error);
  }
}
