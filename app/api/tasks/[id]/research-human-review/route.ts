import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isResearchDecisionNextAction, isResearchDecisionStatus, isResearchReviewStale, type ResearchDecision } from "@/lib/research/researchContracts";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { readResearchTaskSnapshot, ResearchV1InputError } from "@/lib/server/research/researchInput";
import { readStoredResearchReport } from "@/lib/server/research/researchReportStore";
import {
  readStoredResearchDecision,
  RESEARCH_HUMAN_REVIEW_NOTES_MAX_LENGTH,
  saveResearchHumanReview,
  type ResearchHumanReviewStorageVersion,
} from "@/lib/server/research/researchHumanReviewStore";
import {
  TaskResultJsonMutationError,
  type TaskResultJsonStorageVersionHash,
} from "@/lib/server/taskResultJsonMutation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id?: string }> };

type ReviewApiResponse =
  | {
      ok: true;
      data: {
        taskId: string;
        decision: ResearchDecision | null;
        reportHash: string | null;
        /** RESEARCH-001：当前人工复核是否针对旧版报告。 */
        reviewStale: boolean;
        storageVersion: ResearchHumanReviewStorageVersion;
      };
    }
  | { ok: false; error: { code: string; message: string } };

function json(body: ReviewApiResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function toStorageVersion(snapshot: {
  readonly resultJson: string;
  readonly updatedAt: Date | string;
}): ResearchHumanReviewStorageVersion {
  return {
    resultJsonHash: createHash("sha256").update(snapshot.resultJson, "utf8").digest("hex"),
    updatedAt: snapshot.updatedAt instanceof Date
      ? snapshot.updatedAt.toISOString()
      : String(snapshot.updatedAt),
  };
}

function parseStorageVersion(value: unknown): TaskResultJsonStorageVersionHash | null {
  if (!isRecord(value)) return null;
  const resultJsonHash = asTrimmedString(value.resultJsonHash);
  const updatedAt = asTrimmedString(value.updatedAt);
  if (!resultJsonHash || !/^[a-f0-9]{64}$/.test(resultJsonHash) || !updatedAt) return null;
  return { resultJsonHash, updatedAt };
}

function taskIdOf(context: RouteContext): Promise<string> {
  return context.params.then(({ id }) => typeof id === "string" ? id.trim() : "");
}

function errorResponse(error: unknown) {
  if (error instanceof ResearchV1InputError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof TaskResultJsonMutationError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  return json({
    ok: false,
    error: { code: "research_human_review_failed", message: "人工复核意见保存失败，请稍后重试。" },
  }, 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  const taskId = await taskIdOf(context);
  if (!taskId) return json({ ok: false, error: { code: "invalid_task_id", message: "缺少有效 task id。" } }, 400);

  try {
    const task = await readResearchTaskSnapshot(auth.context, taskId);
    const report = readStoredResearchReport(task.result);
    const decision = readStoredResearchDecision(task.result);
    return json({
      ok: true,
      data: {
        taskId: task.id,
        decision,
        reportHash: report?.reportHash ?? null,
        reviewStale: isResearchReviewStale(decision, report?.reportHash ?? null),
        storageVersion: toStorageVersion(task),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  const taskId = await taskIdOf(context);
  if (!taskId) return json({ ok: false, error: { code: "invalid_task_id", message: "缺少有效 task id。" } }, 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: "invalid_json", message: "请求体不是合法 JSON。" } }, 400);
  }
  const bodyRecord = isRecord(body) ? body : null;
  if (!bodyRecord) {
    return json({ ok: false, error: { code: "invalid_body", message: "请求体结构无效。" } }, 400);
  }

  const allowedKeys = new Set(["expectedStorageVersion", "status", "nextAction", "notes", "reviewedReportHash"]);
  if (Object.keys(bodyRecord).some((key) => !allowedKeys.has(key))) {
    return json({ ok: false, error: { code: "invalid_body", message: "请求包含未允许的字段。" } }, 400);
  }

  const status = bodyRecord.status;
  if (!isResearchDecisionStatus(status)) {
    return json({ ok: false, error: { code: "invalid_status", message: "人工复核状态无效。" } }, 400);
  }
  const nextAction = bodyRecord.nextAction;
  if (!isResearchDecisionNextAction(nextAction)) {
    return json({ ok: false, error: { code: "invalid_next_action", message: "下一步动作无效。" } }, 400);
  }
  const notes = asTrimmedString(bodyRecord.notes);
  if (notes === null || notes.length > RESEARCH_HUMAN_REVIEW_NOTES_MAX_LENGTH) {
    return json({ ok: false, error: { code: "invalid_notes", message: "备注必须是有效文本，且不超过 2000 字。" } }, 400);
  }
  // RESEARCH-001：客户端只能声明"我看到的报告指纹"；最终绑定值由服务端从已存报告决定，
  // 声明值不一致会被存储层拒绝（409 research_review_report_stale）。
  const reviewedReportHash = asTrimmedString(bodyRecord.reviewedReportHash);
  const expectedStorageVersion = parseStorageVersion(bodyRecord.expectedStorageVersion);
  if (!expectedStorageVersion) {
    return json({ ok: false, error: { code: "storage_version_required", message: "内容刚在其他位置更新，请刷新后重试。" } }, 400);
  }

  try {
    const current = await readResearchTaskSnapshot(auth.context, taskId);
    const report = readStoredResearchReport(current.result);
    if (!report) {
      return json({ ok: false, error: { code: "research_report_required", message: "请先生成 ResearchReport，再提交人工复核。" } }, 409);
    }

    const decision: ResearchDecision = {
      status,
      nextAction,
      notes,
      updatedAt: new Date().toISOString(),
      // 不接受客户端传入身份；这里只保留认证模式的非敏感标识。
      updatedBy: auth.context.mode === "owner" ? "owner" : "demo",
      reviewedReportHash,
    };
    const saved = await saveResearchHumanReview({
      context: auth.context,
      taskId: current.id,
      decision,
      expectedStorageVersion,
    });
    return json({
      ok: true,
      data: {
        taskId: current.id,
        decision: saved.decision,
        reportHash: report.reportHash,
        reviewStale: isResearchReviewStale(saved.decision, report.reportHash),
        storageVersion: saved.storageVersion,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
