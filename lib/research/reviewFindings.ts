import type { ResearchNarrative, ResearchReport } from "./researchContracts";
import { buildDecisionSummary } from "./decisionSummary";

/** Trusted review/audit overlay, bound to one immutable report. Never source facts. */
export type ResearchReviewFinding = {
  readonly code: "CONFIRMED_SOURCE_MISATTRIBUTION" | "SELECTIVE_REVIEW_INTERPRETATION" | "NON_DISCRIMINATING_COUNTEREVIDENCE";
  readonly reportHash: string;
  readonly taskId: string;
  readonly subjectKey: string;
  readonly runId: string;
  readonly fieldPath: string;
  readonly originalText: string;
  readonly message: string;
  readonly auditArtifactHash: string;
  readonly evidenceBindings: readonly { readonly refId: string; readonly contentHash: string }[];
};

export function applyResearchReviewFindings(report: ResearchReport, reportHash: string, findings: readonly ResearchReviewFinding[]): ResearchReport {
  const output = structuredClone(report);
  let changed = false;
  for (const finding of findings) {
    if (!["CONFIRMED_SOURCE_MISATTRIBUTION", "SELECTIVE_REVIEW_INTERPRETATION", "NON_DISCRIMINATING_COUNTEREVIDENCE"].includes(finding.code) || finding.reportHash !== reportHash
      || finding.taskId !== report.taskId || finding.subjectKey !== report.subjectKey || finding.runId !== report.runId
      || !/^[a-f0-9]{64}$/u.test(finding.auditArtifactHash)
      || typeof finding.message !== "string" || !finding.message.trim()
      || !Array.isArray(finding.evidenceBindings) || !finding.evidenceBindings.length) continue;
    // Explicit narrative paths only: no prototype traversal, facts or decisions.
    if (!/^(executiveSummary|marketOpportunity|competitionInsight|vocAnalysis|unitEconomics|supplyChain|riskAssessment)\.(analysis|keyPoints\[\d+\]|differentiationSuggestions\[\d+\]|causalInvestigations\[\d+\]\.(hypothesis|rationale|supportingEvidence\[\d+\]|counterevidence\[\d+\])|painPoints\[\d+\]|risks\[\d+\])$/u.test(finding.fieldPath)) continue;
    let node: unknown = output;
    for (const key of finding.fieldPath.replace(/\[(\d+)\]/gu, ".$1").split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
    }
    const narrative = node as ResearchNarrative | undefined;
    if (!narrative || narrative.text !== finding.originalText || !Array.isArray(narrative.evidenceRefs)
      || !finding.evidenceBindings.every((binding) => binding && typeof binding.refId === "string"
        && typeof binding.contentHash === "string" && narrative.evidenceRefs.some((ref) =>
          ref.refId === binding.refId && ref.contentHash === binding.contentHash))) continue;
    const target = narrative as { semanticReview?: ResearchNarrative["semanticReview"] };
    const audits = [...(narrative.semanticReview?.auditFindings ?? []), {
      code: finding.code, auditArtifactHash: finding.auditArtifactHash, reportHash,
    }];
    target.semanticReview = { status: "human_review_required",
      auditFindings: [...new Map(audits.map((a) => [`${a.code}:${a.auditArtifactHash}:${a.reportHash}`, a])).values()],
      reasons: [...new Set([
      ...(narrative.semanticReview?.reasons ?? []),
      `[${finding.code}] ${finding.message}（审计 ${finding.auditArtifactHash.slice(0, 12)}）`,
    ])] };
    const causeIndex = /^competitionInsight\.causalInvestigations\[(\d+)\]/u.exec(finding.fieldPath)?.[1];
    const cause = causeIndex === undefined ? null : output.competitionInsight.causalInvestigations?.[Number(causeIndex)];
    if (cause) {
      const reviewReason = finding.code === "CONFIRMED_SOURCE_MISATTRIBUTION"
        ? "本原因关联观察存在已确认归属错误；引用不确认因果，请结合纠错记录重新验证。"
        : "本原因的证据解释存在定向审查意见；保留观察与假设，需人工复核证据的完整语义和区分力。";
      for (const value of [cause.hypothesis, cause.rationale]) {
        if (!value?.text) continue;
        (value as { semanticReview?: ResearchNarrative["semanticReview"] }).semanticReview = {
          status: value.semanticReview?.status === "human_review_required" ? "human_review_required" : "hypothesis",
          reasons: [...new Set([...(value.semanticReview?.reasons ?? []), reviewReason])],
        };
      }
    }
    changed = true;
  }
  if (!changed) return report;
  try { return { ...output, decisionSummary: buildDecisionSummary(output) }; }
  catch {
    // Historical partial reports remain readable, but their old cached AI
    // recommendation must not silently survive a confirmed correction.
    return { ...output, decisionSummary: { researchPriority: "P3", recommendedNextAction: "补充数据",
      keyReasons: [], blockingRisks: ["报告存在来源解释审查意见，需人工复核。"],
      missingInformation: ["历史报告缺少完整确定性字段，无法重建可靠推荐摘要。"] } };
  }
}
