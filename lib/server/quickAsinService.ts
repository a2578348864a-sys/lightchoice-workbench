import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { V5CoreError, requireIdempotencyKey, withV5Receipt } from "@/lib/server/v5CoreCommon";
import { createOrGetResearchTask } from "@/lib/server/startResearchTask";
import { createOrReuseEvidencePromotionCandidate } from "@/lib/server/evidencePromotionCandidateService";
import { collectAmazonDetailWithPlaywright } from "@/lib/server/captureRecipeBrowser";
import { listPromotableEvidenceSubjects, promoteEvidence } from "@/lib/sourceLayer/server/promotableEvidenceService";

const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;

function normalizeAsin(value: unknown): string {
  if (typeof value !== "string") throw new V5CoreError("ASIN_INVALID", "ASIN 必须是 10 位字母数字。", 400);
  const asin = value.trim().toUpperCase();
  if (!ASIN_PATTERN.test(asin)) throw new V5CoreError("ASIN_INVALID", "ASIN 必须是 10 位字母数字。", 400);
  return asin;
}

async function findOrCapture(input: { context: AccessContext; asin: string; traceId: string }) {
  let preview = await listPromotableEvidenceSubjects(input.context);
  let subject = preview.subjects.find((entry) => entry.asin === input.asin);
  if (!subject) {
    const capture = await collectAmazonDetailWithPlaywright({ context: input.context, asin: input.asin, traceId: input.traceId });
    if (capture.status !== "captured") {
      const humanRequired = capture.status === "human_required" || capture.status === "blocked"
        || capture.errorCode === "CAPTCHA_DETECTED" || capture.errorCode === "LOGIN_REQUIRED";
      throw new V5CoreError(
        humanRequired ? capture.errorCode ?? "QUICK_ASIN_HUMAN_REQUIRED"
          : capture.errorCode === "LOCAL_ENVIRONMENT_REQUIRED" ? "QUICK_ASIN_LOCAL_CAPTURE_UNAVAILABLE" : "QUICK_ASIN_CAPTURE_FAILED",
        capture.errorMessage ?? (humanRequired ? "Amazon 页面要求人工处理，请先在本地浏览器完成验证或登录。" : "未能从 Amazon 详情页获得可研究的商品证据。"),
        humanRequired || capture.status === "unavailable" ? 409 : 502,
        !humanRequired && capture.status !== "unavailable",
        false,
        { humanRequired, sourceErrorCode: capture.errorCode },
      );
    }
    preview = await listPromotableEvidenceSubjects(input.context);
    subject = preview.subjects.find((entry) => entry.asin === input.asin);
  }
  if (!subject) throw new V5CoreError("QUICK_ASIN_EVIDENCE_NOT_READY", "采集已返回，但商品证据尚未达到可研究状态，请稍后重试。", 409, true, false);
  return subject;
}

export async function startResearchFromQuickAsin(input: {
  context: AccessContext;
  asin: unknown;
  idempotencyKey: string;
}) {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许从 ASIN 启动正式研究。", 403);
  const asin = normalizeAsin(input.asin);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "research:quick-asin:v1",
    resourceKey: asin,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    requestBody: { asin },
    execute: async () => {
      const traceId = `quick-asin-${randomUUID()}`;
      const subject = await findOrCapture({ context: input.context, asin, traceId });
      const promoted = await promoteEvidence({
        context: input.context,
        bindings: [{ subjectKey: subject.subjectKey, evidenceVersion: subject.evidenceVersion, contentHash: subject.contentHash }],
        confirmed: true,
        idempotencyKey: `quick-promotion-${subject.subjectKey}-${subject.evidenceVersion}-${subject.contentHash.slice(0, 16)}`,
      });
      const store = await import("@/lib/server/productBatchStoreResolver").then((module) => module.getProductBatchStore(input.context));
      const item = (await store.getBatchItems(promoted.value.batchId)).find((entry) => entry.asin === asin);
      if (!item) throw new V5CoreError("QUICK_ASIN_PROMOTION_FAILED", "商品证据已存在，但未能建立批次引用。", 500, true, false);
      const candidate = await createOrReuseEvidencePromotionCandidate({ context: input.context, batchId: promoted.value.batchId, itemId: item.id });
      const task = await createOrGetResearchTask(input.context, candidate.candidateId);
      return {
        asin,
        subjectKey: subject.subjectKey,
        candidateId: candidate.candidateId,
        taskId: task.taskId,
        taskMode: task.mode,
        captureStatus: "ready" as const,
        promoted: promoted.value.created.length > 0,
      };
    },
  });
  return receipt;
}
