import type { ResearchClaimAudit } from "./evidenceAudit";

/** Shared consumption policy. Saving an original/draft is separate from adopting it. */
export function claimConsumptionBlockReason(audit: ResearchClaimAudit | null | undefined): string | null {
  if (!audit || audit.verdict === "UNAVAILABLE") return "RESEARCH_CLAIM_AUDIT_UNAVAILABLE";
  return audit.verdict === "BLOCKED" ? "RESEARCH_CLAIMS_BLOCKED" : null;
}

export function claimConsumptionNotice(audit: ResearchClaimAudit | null | undefined): string {
  const reason = claimConsumptionBlockReason(audit);
  if (reason === "RESEARCH_CLAIM_AUDIT_UNAVAILABLE") return "证据强度审查尚不可用。原文和草稿保留，可继续编辑或补证；暂不能采信、批准或向下游发布为有效结论。";
  if (reason) return "研报存在超过证据强度的结论。原文和人工草稿保留；请补充证据或更新研报后重新审查，人工知悉不能把估算或缺失变成事实。";
  return audit?.verdict === "NEEDS_DOWNGRADE" ? "部分表述需降级阅读；属性观察和小样本反馈均为待复核线索，不是已确认缺陷或总体结论。" : "审查未发现规则覆盖内的越级表述；这不等于事实或商业可行性已经验证。";
}
