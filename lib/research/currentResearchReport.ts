/**
 * 当前正式研报的权威判定（V1 / V5 并存时的唯一解释路径）。
 *
 * 背景：同一 Research Task 上存在两条写链——
 *  - v5：`/api/research/[taskId]/advisory` 写 `v5Research.{report,reportHash,researchRevision}`
 *  - v1：`/api/tasks/[id]/research-v1` 写根节点 `researchReport.{reportJson,reportHash,generatedAt}`
 * 两份报告格式不同，字段名不同，**版本号大小或字段是否存在都不能证明谁是当前权威**。
 *
 * 因此引入一个最小的持久化指针 `researchCurrentReport`，由两条写链在各自的 CAS 写入时
 * 同时写下「我刚生成了哪一份」。读侧只用本函数解释：
 *  - 只有一份报告 → 就是它；
 *  - 两份都有 + 指针命中其中一份 → 指针指定的那份；
 *  - 两份都有但指针缺失/对不上 → **歧义**，必须如实暴露，写操作 fail-closed；
 *  - 都没有 → 缺失。
 *
 * 本函数是纯函数：不读库、不改 Hash、不参与展示拼装。
 */

export type ResearchReportSource = "v1" | "v5";

export type ResearchReportCandidate = {
  readonly source: ResearchReportSource;
  readonly reportHash: string;
  readonly generatedAt: string | null;
  readonly researchRevision: number | null;
};

export type ResearchCurrentReportPointer = {
  readonly source: ResearchReportSource;
  readonly reportHash: string;
  readonly generatedAt?: string | null;
  readonly researchRevision?: number | null;
};

export type ResearchReportResolution =
  | {
      readonly status: "current";
      readonly source: ResearchReportSource;
      readonly reportHash: string;
      readonly generatedAt: string | null;
      readonly researchRevision: number | null;
      /** 另一份格式的报告是否也存在（只作展示/审计提示，不代表它当前有效）。 */
      readonly otherPresent: boolean;
      readonly reason: "only_candidate" | "pointer_match";
    }
  | {
      readonly status: "ambiguous";
      readonly reason: "both_present_without_pointer" | "pointer_mismatch";
      readonly candidates: readonly ResearchReportCandidate[];
    }
  | { readonly status: "missing"; readonly reason: "no_report" };

export function resolveCurrentResearchReport(input: {
  readonly candidates: readonly ResearchReportCandidate[];
  readonly pointer: ResearchCurrentReportPointer | null;
}): ResearchReportResolution {
  const candidates = input.candidates.filter((item) => typeof item.reportHash === "string" && item.reportHash.trim().length > 0);
  if (candidates.length === 0) return { status: "missing", reason: "no_report" };

  const asCurrent = (candidate: ResearchReportCandidate, reason: "only_candidate" | "pointer_match"): ResearchReportResolution => ({
    status: "current",
    source: candidate.source,
    reportHash: candidate.reportHash,
    generatedAt: candidate.generatedAt,
    researchRevision: candidate.researchRevision,
    otherPresent: candidates.length > 1,
    reason,
  });

  if (candidates.length === 1) return asCurrent(candidates[0], "only_candidate");

  const pointer = input.pointer;
  if (pointer && typeof pointer.reportHash === "string" && pointer.reportHash.trim().length > 0) {
    const matched = candidates.filter((item) => item.reportHash === pointer.reportHash);
    // 指针必须唯一命中，且格式一致；否则视为不可信指针。
    if (matched.length === 1 && matched[0].source === pointer.source) return asCurrent(matched[0], "pointer_match");
    return { status: "ambiguous", reason: "pointer_mismatch", candidates };
  }
  return { status: "ambiguous", reason: "both_present_without_pointer", candidates };
}
