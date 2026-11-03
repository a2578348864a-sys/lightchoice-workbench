import "server-only";

import { createHash } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import {
  isResearchDecisionNextAction,
  isResearchDecisionStatus,
  type ResearchDecision,
} from "@/lib/research/researchContracts";
import {
  mutateTaskResultJson,
  TaskResultJsonMutationError,
  type TaskResultJsonStorageVersionInput,
} from "@/lib/server/taskResultJsonMutation";
import { readStoredResearchReport } from "./researchReportStore";

export const RESEARCH_HUMAN_REVIEW_NOTES_MAX_LENGTH = 2_000;

export type ResearchHumanReviewStorageVersion = {
  readonly resultJsonHash: string;
  readonly updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStoredResearchDecision(value: unknown): value is ResearchDecision {
  if (!isRecord(value)) return false;
  return isResearchDecisionStatus(value.status)
    && isResearchDecisionNextAction(value.nextAction)
    && typeof value.notes === "string"
    && value.notes.length <= RESEARCH_HUMAN_REVIEW_NOTES_MAX_LENGTH
    && typeof value.updatedAt === "string"
    && value.updatedAt.trim().length > 0
    && typeof value.updatedBy === "string"
    && value.updatedBy.trim().length > 0
    // RESEARCH-001：reviewedReportHash 允许历史记录缺失/为 null（读取时归一为 null），
    // 但一旦存在就必须是有效字符串。
    && (value.reviewedReportHash === undefined
      || value.reviewedReportHash === null
      || (typeof value.reviewedReportHash === "string" && value.reviewedReportHash.trim().length > 0));
}

export function readStoredResearchDecision(result: unknown): ResearchDecision | null {
  if (!isRecord(result)) return null;
  if (!isStoredResearchDecision(result.researchDecision)) return null;
  // 归一化：历史复核没有 reviewedReportHash，读出来显式置 null（由 isResearchReviewStale 判为过期）。
  return {
    ...result.researchDecision,
    reviewedReportHash: typeof result.researchDecision.reviewedReportHash === "string"
      ? result.researchDecision.reviewedReportHash
      : null,
  };
}

function storageVersionOf(snapshot: {
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

export async function saveResearchHumanReview(input: {
  readonly context: AccessContext;
  readonly taskId: string;
  readonly decision: ResearchDecision;
  readonly expectedStorageVersion: TaskResultJsonStorageVersionInput;
}): Promise<{
  readonly decision: ResearchDecision;
  readonly storageVersion: ResearchHumanReviewStorageVersion;
}> {
  if (!isStoredResearchDecision(input.decision)) {
    throw new TaskResultJsonMutationError(
      "invalid_research_human_review",
      400,
      "人工复核意见结构无效。",
    );
  }

  const mutation = await mutateTaskResultJson({
    context: input.context,
    taskId: input.taskId,
    writer: "research-human-review",
    expectedStorageVersion: input.expectedStorageVersion,
    mutate: (current) => {
      const report = readStoredResearchReport(current);
      if (!report) {
        throw new TaskResultJsonMutationError(
          "research_report_required",
          409,
          "请先生成 ResearchReport，再提交人工复核。",
        );
      }
      // RESEARCH-001：复核指纹由服务端从已存报告写入，不接受客户端指定。
      // 若客户端声明了另一个 hash，说明它看到的是旧报告 → 拒绝，避免把旧意见盖到新报告上。
      const requestedHash = input.decision.reviewedReportHash;
      if (typeof requestedHash === "string" && requestedHash !== report.reportHash) {
        throw new TaskResultJsonMutationError(
          "research_review_report_stale",
          409,
          "报告已在复核期间更新，请刷新后重新复核。",
        );
      }
      const decision: ResearchDecision = {
        ...input.decision,
        reviewedReportHash: report.reportHash,
      };
      return {
        result: {
          ...current,
          researchDecision: decision,
        },
        value: decision,
      };
    },
  });

  return {
    decision: mutation.value,
    storageVersion: storageVersionOf({
      resultJson: mutation.resultJson,
      updatedAt: mutation.updatedAt,
    }),
  };
}
