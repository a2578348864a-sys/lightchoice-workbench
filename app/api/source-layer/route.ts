import { NextRequest, NextResponse } from "next/server";

import "@/lib/sourceLayer/adapters";
import { SOURCE_LAYER_SCHEMA_VERSION } from "@/lib/sourceLayer/capturePackage";
import { listSourceAdapters } from "@/lib/sourceLayer/sourceAdapter";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  listSourceEvidence,
  sourceLayerOperator,
} from "@/lib/sourceLayer/server/sourceLayerService";
import { getSourceAssetInbox } from "@/lib/sourceLayer/server/sourceAssetInbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  try {
    const view = request.nextUrl.searchParams.get("view");
    if (view === "assets") {
      const inbox = await getSourceAssetInbox(auth.context);
      return NextResponse.json({ ok: true, data: inbox });
    }

    const { operator, subjects } = await listSourceEvidence(auth.context);
    return NextResponse.json({
      ok: true,
      data: {
        schemaVersion: SOURCE_LAYER_SCHEMA_VERSION,
        accessMode: auth.context.mode === "owner" ? "owner" : "visitor",
        operator: sourceLayerOperator(auth.context),
        storageOperator: operator,
        adapters: listSourceAdapters().map((adapter) => ({
          sourceType: adapter.sourceType,
          label: adapter.label,
          adapterVersion: adapter.adapterVersion,
        })),
        subjects,
      },
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_read_failed";
    return errorResponse(500, code, "来源证据读取失败，请稍后重试。");
  }
}
