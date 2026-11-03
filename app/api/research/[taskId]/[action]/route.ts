import { NextRequest, NextResponse } from "next/server";
import { applyResearchTeamRecommendation, runJevReadinessAdvisory, runResearchAdvisory, researchTaskAction, saveResearchChoice, saveTemporaryWatch } from "@/lib/server/v5ResearchService";
import { syncResearchTask } from "@/lib/server/v5FeishuService";
import { projectProductConceptToV5Hub, projectResearchTaskToV5Hub } from "@/lib/server/v5HubResearchProjectionService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody, V5CoreError } from "@/lib/server/v5CoreCommon";
import type { CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string; action: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { taskId, action } = await context.params;
    const body = safeParseBody(await jsonBody(request));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const idempotencyKey = requireIdempotencyKey(key);
    if (action === "advisory") {
      const requested = Array.isArray(body.requested) ? body.requested.filter((item): item is string => typeof item === "string") : ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"];
      const data = await runResearchAdvisory({ context: auth.context, taskId, expectedRevision: Number(body.expectedRevision), requested, confirmFinalAdvisoryRegeneration: body.confirmFinalAdvisoryRegeneration === true, expectedFactHash: typeof body.expectedFactHash === "string" ? body.expectedFactHash : body.expectedFactHash === null ? null : undefined, expectedEvidenceHash: typeof body.expectedEvidenceHash === "string" ? body.expectedEvidenceHash : body.expectedEvidenceHash === null ? null : undefined, idempotencyKey });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list"]).body);
    }
    if (action === "jev-readiness-advisory") {
      const expectedRevision = body.expectedRevision;
      const expectedFactHash = body.expectedFactHash;
      const expectedEvidenceHash = body.expectedEvidenceHash;
      if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0
        || typeof expectedFactHash !== "string" || !expectedFactHash.trim()
        || typeof expectedEvidenceHash !== "string" || !expectedEvidenceHash.trim()) {
        throw new V5CoreError("INVALID_INPUT", "必须提供有效的 expectedRevision、expectedFactHash 和 expectedEvidenceHash。", 400);
      }
      const data = await runJevReadinessAdvisory({
        context: auth.context,
        taskId,
        expectedRevision,
        expectedFactHash,
        expectedEvidenceHash,
        confirmRerun: body.confirmRerun === true,
        idempotencyKey,
      });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list"]).body);
    }
    if (action === "apply-team-recommendation") {
      const data = await applyResearchTeamRecommendation({ context: auth.context, taskId, idempotencyKey,
        recommendationId: typeof body.recommendationId === "string" ? body.recommendationId : "", confirmed: body.confirmed === true,
        readinessAcknowledged: body.readinessAcknowledged === true,
        expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : "", expectedRevision: Number(body.expectedRevision),
        expectedReportHash: String(body.expectedReportHash ?? ""), expectedFactHash: String(body.expectedFactHash ?? ""), expectedEvidenceHash: String(body.expectedEvidenceHash ?? "") });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list", "home-summary"]).body);
    }
    if (action === "choice") {
      const canonicalStatus = typeof body.canonicalStatus === "string" ? body.canonicalStatus.trim().toUpperCase() : undefined;
      const choice = typeof body.choice === "string" ? body.choice.trim().toUpperCase() : undefined;
      if (!canonicalStatus && !choice) {
        throw new V5CoreError("INVALID_CHOICE", "最终选择必须提供 choice 或 canonicalStatus。", 400);
      }
      if (canonicalStatus && !["PROCEED", "VALIDATE_MORE", "PAUSE", "DROP"].includes(canonicalStatus)) {
        throw new V5CoreError("INVALID_CHOICE", `未知 Canonical 状态: ${canonicalStatus}`, 400);
      }
      if (choice && !["PROCEED", "WATCH", "DROP"].includes(choice)) {
        throw new V5CoreError("INVALID_CHOICE", `未知传统选项: ${choice}`, 400);
      }
      const data = await saveResearchChoice({
        context: auth.context,
        taskId,
        expectedTeamRecommendationId: typeof body.expectedTeamRecommendationId === "string" ? body.expectedTeamRecommendationId : undefined,
        expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
        choice: choice as "PROCEED" | "WATCH" | "DROP" | undefined,
        canonicalStatus: canonicalStatus as CanonicalDecisionStatus | undefined,
        reason: typeof body.reason === "string" ? body.reason : "",
        readinessAcknowledged: body.readinessAcknowledged === true,
        expectedRevision: Number(body.expectedRevision),
        expectedReportHash: typeof body.expectedReportHash === "string" ? body.expectedReportHash : "",
        expectedFactHash: typeof body.expectedFactHash === "string" ? body.expectedFactHash : "",
        expectedEvidenceHash: typeof body.expectedEvidenceHash === "string" ? body.expectedEvidenceHash : "",
        idempotencyKey,
      });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list", "home-summary"]).body);
    }
    if (action === "temporary-watch") {
      const data = await saveTemporaryWatch({ context: auth.context, taskId, note: typeof body.note === "string" ? body.note : undefined, hasCandidateIdField: Object.prototype.hasOwnProperty.call(body, "candidateId"), idempotencyKey });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list"]).body);
    }
    if (action === "feishu-sync") {
      const data = await syncResearchTask({ context: auth.context, taskId, expectedReportHash: typeof body.expectedReportHash === "string" ? body.expectedReportHash : "", expectedFactHash: typeof body.expectedFactHash === "string" ? body.expectedFactHash : "", expectedEvidenceHash: typeof body.expectedEvidenceHash === "string" ? body.expectedEvidenceHash : "", idempotencyKey });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, `feishu-sync:research_archive:${taskId}`]).body);
    }
    if (action === "feishu-hub-sync") {
      const data = await projectResearchTaskToV5Hub({
        context: auth.context,
        taskId,
        expectedRevision: Number(body.expectedRevision),
        expectedReportHash: typeof body.expectedReportHash === "string" ? body.expectedReportHash : "",
        expectedFactHash: typeof body.expectedFactHash === "string" ? body.expectedFactHash : "",
        expectedEvidenceHash: typeof body.expectedEvidenceHash === "string" ? body.expectedEvidenceHash : "",
        idempotencyKey,
      });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, `feishu-hub:${taskId}`]).body);
    }
    if (action === "feishu-hub-concept-sync") {
      const data = await projectProductConceptToV5Hub({
        context: auth.context,
        taskId,
        expectedRevision: Number(body.expectedRevision),
        expectedReportHash: typeof body.expectedReportHash === "string" ? body.expectedReportHash : "",
        expectedFactHash: typeof body.expectedFactHash === "string" ? body.expectedFactHash : "",
        expectedEvidenceHash: typeof body.expectedEvidenceHash === "string" ? body.expectedEvidenceHash : "",
        idempotencyKey,
      });
      return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, `feishu-hub:${taskId}`]).body);
    }
    if (action !== "archive" && action !== "restore" && action !== "delete") throw new V5CoreError("INVALID_INPUT", "研究任务动作无效。", 400);
    const data = await researchTaskAction({ context: auth.context, taskId, action, expectedVersion: body.expectedVersion, idempotencyKey });
    return NextResponse.json(okResponse(data, 200, [`research:${taskId}`, "research-list", "home-summary"]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
