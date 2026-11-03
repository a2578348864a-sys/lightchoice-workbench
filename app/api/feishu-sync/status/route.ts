import { NextRequest, NextResponse } from "next/server";
import { getFeishuSyncStatus } from "@/lib/server/v5FeishuService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const query = new URL(request.url).searchParams;
    const data = await getFeishuSyncStatus({ context: auth.context, resourceType: query.get("resourceType") ?? "", resourceId: query.get("resourceId") ?? "", table: query.get("table") ?? undefined });
    return NextResponse.json(okResponse(data).body);
  } catch (error) { return v5ErrorResponse(error); }
}
