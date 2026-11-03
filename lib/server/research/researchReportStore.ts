import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  mutateTaskResultJson,
  TaskResultJsonMutationError,
} from "@/lib/server/taskResultJsonMutation";
import type { ResearchReport } from "@/lib/research/researchContracts";
import { applyResearchReviewFindings, type ResearchReviewFinding } from "@/lib/research/reviewFindings";
import { researchCandidateIdFromResult } from "./researchInput";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type StoredResearchReport = {
  readonly report: ResearchReport;
  readonly reportHash: string;
  readonly generatedAt: string;
};

export function readStoredResearchReport(result: unknown): StoredResearchReport | null {
  if (!isRecord(result) || !isRecord(result.researchReport)) return null;
  const stored = result.researchReport;
  // V1 正式形状：researchReport.reportJson + reportHash + generatedAt。
  // 兼容首轮实现曾写入的 researchReport 直接报告对象，避免历史结果不可读。
  const report = isRecord(stored.reportJson) ? stored.reportJson : stored;
  const hasReportJson = isRecord(stored.reportJson);
  const reportHash = hasReportJson
    ? (typeof stored.reportHash === "string" ? stored.reportHash : null)
    : (typeof result.researchReportHash === "string" ? result.researchReportHash : null);
  const generatedAt = hasReportJson
    ? (typeof stored.generatedAt === "string" ? stored.generatedAt : null)
    : (typeof result.researchReportGeneratedAt === "string"
      ? result.researchReportGeneratedAt
      : (typeof report.generatedAt === "string" ? report.generatedAt : null));
  if (!reportHash || !generatedAt || report.schema !== "research-report.v1") return null;
  return {
    report: applyResearchReviewFindings(report as unknown as ResearchReport, reportHash,
      Array.isArray(stored.reviewFindings) ? stored.reviewFindings.filter(isRecord) as unknown as ResearchReviewFinding[] : []),
    reportHash,
    generatedAt,
  };
}

export async function saveResearchReport(input: {
  readonly context: AccessContext;
  readonly taskId: string;
  readonly candidateId: string;
  readonly report: ResearchReport;
  readonly reportHash: string;
  readonly generatedAt: string;
  /**
   * P2-04：该报告生成时的事实/证据绑定，用于后续判断「来源是否已变化」。
   * 历史 v1 报告没有这两个哈希，读侧会如实标注「时效未知」，不假装有效。
   */
  readonly bindings?: { readonly factHash: string | null; readonly evidenceHash: string | null };
}): Promise<StoredResearchReport> {
  const mutation = await mutateTaskResultJson({
    context: input.context,
    taskId: input.taskId,
    writer: "research-report",
    mutate: (current) => {
      const currentCandidateId = researchCandidateIdFromResult(current);
      if (currentCandidateId !== input.candidateId) {
        throw new TaskResultJsonMutationError(
          "candidate_binding_invalid",
          409,
          "研究任务与 Candidate 绑定不一致，已阻止保存报告。",
        );
      }
      return {
        result: {
          ...current,
          // Active Research Task 当前只有 resultJson 可复用；在独立 namespace
          // 内保留 reportJson/reportHash/generatedAt，不新增 Prisma 列。
          researchReport: {
            reportJson: input.report,
            reportHash: input.reportHash,
            generatedAt: input.generatedAt,
          },
          researchReportHash: input.reportHash,
          researchReportGeneratedAt: input.generatedAt,
          ...(input.bindings ? { researchReportBindingHashes: { factHash: input.bindings.factHash, evidenceHash: input.bindings.evidenceHash } } : {}),
          // 当前正式研报指针：本次生成即声明「v1 是最近一次产出的正式报告」。
          // 读侧只在指针命中时采用，不按格式或版本号猜测权威。
          researchCurrentReport: { source: "v1", reportHash: input.reportHash, generatedAt: input.generatedAt, researchRevision: null },
        },
        value: {
          report: input.report,
          reportHash: input.reportHash,
          generatedAt: input.generatedAt,
        },
      };
    },
  });
  return mutation.value;
}
