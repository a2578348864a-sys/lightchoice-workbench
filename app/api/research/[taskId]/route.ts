import { NextRequest, NextResponse } from "next/server";
import { getResearchDetail } from "@/lib/server/v5ResearchService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await getResearchDetail({ context: auth.context, taskId })).body);
  } catch (error) { return v5ErrorResponse(error); }
}
