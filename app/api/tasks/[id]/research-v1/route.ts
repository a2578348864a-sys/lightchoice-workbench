import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  DEFAULT_RESEARCH_CONFIG,
  buildResearchEngineInput,
  readResearchTaskSnapshot,
  ResearchV1InputError,
} from "@/lib/server/research/researchInput";
import {
  V1_MAX_OUTPUT_TOKENS,
  V1_MAX_TIMEOUT_MS,
  V1_MIN_OUTPUT_TOKENS,
} from "@/lib/server/research/researchOutputLimits";
import { runResearchEngine } from "@/lib/server/research/researchEngine";
import {
  readStoredResearchReport,
  saveResearchReport,
} from "@/lib/server/research/researchReportStore";
import { TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";
import { mapReportToLarkFields } from "@/lib/research/larkMapping";
import type { ResearchConfig } from "@/lib/research/researchContracts";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { stableFactHash } from "@/lib/server/research/stableFactHash";
import { hashJson } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id?: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function configFromBody(value: unknown): ResearchConfig {
  const body = isRecord(value) ? value : {};
  const configValue = isRecord(body.researchConfig) ? body.researchConfig : body;
  return {
    ...DEFAULT_RESEARCH_CONFIG,
    // 上限必须与 DEFAULT_RESEARCH_CONFIG.maxTokens / CHAIN_OUTPUT_CAP_TOKENS.v1 一致；
    // 12,000 由官方 max_output_tokens=393,216 支撑，4000 已被真实调用证明会截断。
    maxTokens: asPositiveInteger(configValue.maxTokens, DEFAULT_RESEARCH_CONFIG.maxTokens, V1_MIN_OUTPUT_TOKENS, V1_MAX_OUTPUT_TOKENS),
    // 90,000 默认值需要落在允许区间内；上限放到 120,000 给长输出留余量，仍是单次请求。
    timeoutMs: asPositiveInteger(configValue.timeoutMs, DEFAULT_RESEARCH_CONFIG.timeoutMs, 10_000, V1_MAX_TIMEOUT_MS),
  };
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
    error: { code: "research_v1_failed", message: "Research 运行失败，请稍后重试。" },
  }, 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  const taskId = await taskIdOf(context);
  if (!taskId) return json({ ok: false, error: { code: "invalid_task_id", message: "缺少有效 task id。" } }, 400);

  try {
    const task = await readResearchTaskSnapshot(auth.context, taskId);
    const stored = readStoredResearchReport(task.result);
    return json({
      ok: true,
      data: {
        taskId: task.id,
        status: stored ? "completed" : "not_started",
        report: stored?.report ?? null,
        reportHash: stored?.reportHash ?? null,
        generatedAt: stored?.generatedAt ?? null,
        larkFields: stored
          ? mapReportToLarkFields(stored.report, {
              decisionStatus: task.decisionStatus,
              researchLink: `/tasks/${encodeURIComponent(task.id)}`,
            })
          : null,
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

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const bodyRecord = isRecord(body) ? body : {};
  const force = bodyRecord.force === true;

  try {
    const current = await readResearchTaskSnapshot(auth.context, taskId);
    const existing = readStoredResearchReport(current.result);
    if (existing && !force) {
      return json({
        ok: true,
        data: {
          taskId: current.id,
          mode: "existing",
          report: existing.report,
          reportHash: existing.reportHash,
          generatedAt: existing.generatedAt,
          larkFields: mapReportToLarkFields(existing.report, {
            decisionStatus: current.decisionStatus,
            researchLink: `/tasks/${encodeURIComponent(current.id)}`,
          }),
        },
      });
    }

    const traceId = newTraceId();
    const input = await buildResearchEngineInput({
      context: auth.context,
      taskId,
      traceId,
      researchConfig: configFromBody(bodyRecord),
      includeBundle: true,
    });
    const generation = await runResearchEngine(input);
    // P2-04：记录本次生成所用的事实/证据绑定，使 v1 研报也能被判定「来源已变化」。
    // 输入不完整时不伪造绑定，读侧会如实标注「时效未知」。
    const bindings = input.productFact && Array.isArray(input.sourceEvidenceRefs)
      ? {
          factHash: stableFactHash(input.productFact),
          evidenceHash: hashJson(input.sourceEvidenceRefs
            .map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
            .sort((a, b) => a.refId.localeCompare(b.refId))),
        }
      : undefined;
    const stored = await saveResearchReport({
      context: auth.context,
      taskId: input.taskId,
      candidateId: input.candidateId,
      report: generation.report,
      reportHash: generation.reportHash,
      generatedAt: generation.generatedAt,
      ...(bindings ? { bindings } : {}),
    });
    return json({
      ok: true,
      data: {
        taskId: input.taskId,
        traceId: input.traceId ?? null,
        mode: "generated",
        report: stored.report,
        reportHash: stored.reportHash,
        generatedAt: stored.generatedAt,
        aiProviderCallStarted: generation.aiProviderCallStarted,
        larkFields: mapReportToLarkFields(stored.report, {
          decisionStatus: current.decisionStatus,
          researchLink: `/tasks/${encodeURIComponent(current.id)}`,
        }),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
