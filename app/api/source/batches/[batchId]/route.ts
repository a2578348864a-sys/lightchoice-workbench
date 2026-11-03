import { NextRequest, NextResponse } from "next/server";
import { getSourceBatch } from "@/lib/server/v5SourceLifecycleService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ batchId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { batchId } = await context.params;
    const data = await getSourceBatch({ context: auth.context, batchId, include: new URL(request.url).searchParams.get("include") ?? undefined });
    return NextResponse.json(okResponse(data).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
