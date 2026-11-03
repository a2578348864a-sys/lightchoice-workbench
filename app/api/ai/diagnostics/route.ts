import { NextRequest, NextResponse } from "next/server";
import {
  checkAiModels,
  getAiDiagnosticsSnapshot,
  isAiDiagnosticsAllowed,
} from "@/lib/server/aiDiagnostics";
import { requireOwnerOnly } from "@/lib/server/demoGuard";

export const runtime = "nodejs";

function disabledResponse() {
  return NextResponse.json(
    { ok: false, error: { code: "not_found", message: "Not found." } },
    { status: 404 },
  );
}

export async function GET(request: NextRequest) {
  if (!isAiDiagnosticsAllowed()) {
    return disabledResponse();
  }

  const auth = requireOwnerOnly(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: { code: auth.code, message: auth.message } },
      { status: auth.status },
    );
  }

  const checkModels = request.nextUrl.searchParams.get("checkModels") === "1";

  if (!checkModels) {
    return NextResponse.json({
      ok: true,
      data: getAiDiagnosticsSnapshot(),
    });
  }

  const result = await checkAiModels();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
