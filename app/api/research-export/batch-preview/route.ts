import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  buildResearchExportBatchPreview,
  normalizeResearchExportTaskIds,
} from "@/lib/server/research/researchExportBatch";
import { ResearchV1InputError } from "@/lib/server/research/researchInput";

export const runtime = "nodejs";

type BatchPreviewResponse =
  | {
      ok: true;
      data: {
        count: number;
        items: Awaited<ReturnType<typeof buildResearchExportBatchPreview>>["items"];
        larkRecords: Awaited<ReturnType<typeof buildResearchExportBatchPreview>>["larkRecords"];
      };
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

function json(body: BatchPreviewResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function parseTaskIds(request: NextRequest): string[] {
  const repeated = request.nextUrl.searchParams.getAll("taskId");
  const commaSeparated = request.nextUrl.searchParams.getAll("taskIds");
  return normalizeResearchExportTaskIds([
    ...repeated,
    ...commaSeparated.flatMap((value) => value.split(",")),
  ]);
}

function errorResponse(error: unknown) {
  if (error instanceof ResearchV1InputError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  return json({
    ok: false,
    error: { code: "research_export_batch_preview_failed", message: "批量研究导出预览读取失败，请稍后重试。" },
  }, 500);
}

/**
 * GET /api/research-export/batch-preview?taskId=...&taskId=...
 *
 * 只读 Research Export Layer 入口。输入可以是重复 taskId，也兼容
 * taskIds=task-a,task-b；返回的 items 一律来自已保存的 ResearchExportRecord。
 */
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);

  const taskIds = parseTaskIds(request);
  if (taskIds.length === 0) {
    return json({
      ok: false,
      error: { code: "task_ids_required", message: "请至少选择一个已完成 Research 的 task id。" },
    }, 400);
  }

  try {
    const data = await buildResearchExportBatchPreview({
      context: auth.context,
      taskIds,
    });
    return json({ ok: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}
