import { NextRequest, NextResponse } from "next/server";
import { generateProductBrief, previewProductBrief, ProductBriefError, readProductBrief, saveProductBrief } from "@/lib/server/productBriefService";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, readAuth, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";
import { TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") {
    return NextResponse.json({ ok: false, error: { code: "PRODUCT_BRIEF_REVISION_STALE", message: "产品企划已被更新，请刷新后重试。" } }, { status: 409 });
  }
  if (error instanceof ProductBriefError) {
    return NextResponse.json({ ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: { code: "PRODUCT_BRIEF_INTERNAL_ERROR", message: "Product Brief 服务暂时不可用。" } }, { status: 500 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await readProductBrief({ context: auth.context, taskId })).body);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { taskId } = await context.params;
    const body = await boundedJsonBody(request, 32 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "请求体必须是 JSON 对象。" } }, { status: 400 });
    const raw = body as Record<string, unknown>;
    if (raw.action === "save") {
      const targetUser = raw.targetUser && typeof raw.targetUser === "object" && !Array.isArray(raw.targetUser) ? raw.targetUser as { text?: unknown; nature?: unknown; evidenceRefs?: unknown } : raw.targetUser === null ? null : undefined;
      const patch: Record<string, unknown> = {};
      for (const key of ["targetPrice", "targetMarginPct", "referralFee", "logistics", "estimatedTax", "otherKnownCosts", "status", "specifications", "confirmationItems", "benchmarkComparison", "verificationPlan", "positioning"]) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) patch[key] = raw[key];
      }
      if (targetUser !== undefined) patch.targetUser = targetUser;
      if (typeof raw.expectedRevision !== "number") return NextResponse.json({ ok: false, error: { code: "EXPECTED_REVISION_REQUIRED", message: "保存 Product Brief 必须携带 expectedRevision。" } }, { status: 400 });
      // P3-02（3.3）：保存也支持幂等键，超时重试不会产生第二个版本。
      const saveKey = request.headers.get("Idempotency-Key");
      return NextResponse.json(okResponse(await saveProductBrief({
        context: auth.context,
        taskId,
        expectedRevision: raw.expectedRevision,
        patch: patch as never,
        ...(saveKey !== null ? { idempotencyKey: saveKey } : {}),
      })).body);
    }
    if (raw.action === "preview") {
      // P3-02：只读预览，不写库；用于来源更新后让用户先看差异再决定。
      return NextResponse.json(okResponse(await previewProductBrief({
        context: auth.context,
        taskId,
        resetDerivedFields: raw.resetDerivedFields === true,
      })).body);
    }
    if (raw.action === "generate") {
      if (Object.keys(raw).some((key) => !["action", "resetDerivedFields", "previewRevision", "previewSourceBinding"].includes(key)) || (raw.resetDerivedFields !== undefined && typeof raw.resetDerivedFields !== "boolean") || (raw.previewSourceBinding !== undefined && raw.previewRevision === undefined)) {
        return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "生成参数无效，请重新预览。" } }, { status: 400 });
      }
      if (raw.previewRevision !== undefined && (!Number.isInteger(raw.previewRevision) || !raw.previewSourceBinding || typeof raw.previewSourceBinding !== "object" || Array.isArray(raw.previewSourceBinding))) {
        return NextResponse.json({ ok: false, error: { code: "INVALID_PREVIEW_BINDING", message: "预览版本无效，请重新预览。" } }, { status: 400 });
      }
      return NextResponse.json(okResponse(await generateProductBrief({
        context: auth.context,
        taskId,
        resetDerivedFields: raw.resetDerivedFields === true,
        ...(request.headers.has("Idempotency-Key") ? { idempotencyKey: request.headers.get("Idempotency-Key") ?? "" } : {}),
        ...(typeof raw.previewRevision === "number" ? { previewRevision: raw.previewRevision, previewSourceBinding: raw.previewSourceBinding as never } : {}),
      })).body, { status: 201 });
    }
    if (Object.keys(raw).length > 0) return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "生成 Product Brief 不接受未知字段。" } }, { status: 400 });
    return NextResponse.json(okResponse(await generateProductBrief({ context: auth.context, taskId, ...(request.headers.has("Idempotency-Key") ? { idempotencyKey: request.headers.get("Idempotency-Key") ?? "" } : {}) })).body, { status: 201 });
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    return errorResponse(error);
  }
}
