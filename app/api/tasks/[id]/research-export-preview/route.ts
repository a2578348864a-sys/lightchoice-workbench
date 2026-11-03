import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { readResearchTaskSnapshot, ResearchV1InputError } from "@/lib/server/research/researchInput";
import { readStoredResearchReport } from "@/lib/server/research/researchReportStore";
import { readStoredResearchDecision } from "@/lib/server/research/researchHumanReviewStore";
import { buildResearchExportRecord } from "@/lib/research/exportRecord";
import { mapResearchExportToLarkRecord, type LarkBaseRecord } from "@/lib/research/larkMapping";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id?: string }> };

type ExportPreviewApiResponse =
  | {
      ok: true;
      data: {
        exportRecord: ResearchExportRecord;
        larkFields: LarkBaseRecord;
      };
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

function json(body: ExportPreviewApiResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function taskIdOf(context: RouteContext): Promise<string> {
  return context.params.then(({ id }) => typeof id === "string" ? id.trim() : "");
}

function errorResponse(error: unknown) {
  if (error instanceof ResearchV1InputError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  return json(
    {
      ok: false,
      error: { code: "research_export_preview_failed", message: "导出预览读取失败，请稍后重试。" },
    },
    500,
  );
}

/**
 * GET /api/tasks/[id]/research-export-preview
 *
 * 纯只读端点：合成 ResearchReport + ResearchDecision + ProductFact 为标准导出快照。
 * 严禁调用飞书 API，严禁写入外部系统，严禁由 AI 重新生成。
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);

  const taskId = await taskIdOf(context);
  if (!taskId) return json({ ok: false, error: { code: "invalid_task_id", message: "缺少有效 task id。" } }, 400);

  try {
    const task = await readResearchTaskSnapshot(auth.context, taskId);
    const storedReport = readStoredResearchReport(task.result);
    if (!storedReport) {
      return json(
        {
          ok: false,
          error: {
            code: "research_report_not_found",
            message: "尚未生成 ResearchReport，无法预览导出记录。",
          },
        },
        404,
      );
    }

    const storedDecision = readStoredResearchDecision(task.result);

    const exportRecord = buildResearchExportRecord({
      taskId: task.id,
      candidateId: storedReport.report.candidateId,
      report: storedReport.report,
      reportHash: storedReport.reportHash,
      decision: storedDecision,
    });

    const larkFields = mapResearchExportToLarkRecord(exportRecord);

    return json({
      ok: true,
      data: {
        exportRecord,
        larkFields,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
