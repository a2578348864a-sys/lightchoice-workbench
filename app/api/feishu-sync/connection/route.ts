import { NextRequest, NextResponse } from "next/server";
import { getFeishuConnectionStatus } from "@/lib/server/v5FeishuService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try { return NextResponse.json(okResponse(getFeishuConnectionStatus()).body); } catch (error) { return v5ErrorResponse(error); }
}
