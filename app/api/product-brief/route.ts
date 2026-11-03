import { NextRequest, NextResponse } from "next/server";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";
import { listProductBriefs } from "@/lib/server/productBriefService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try { return NextResponse.json(okResponse(await listProductBriefs(auth.context)).body); }
  catch (error) { return v5ErrorResponse(error); }
}
