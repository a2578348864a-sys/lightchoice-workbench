export type DecisionBasisSource = {
  readonly kind?: string | null;
  readonly recordId?: string | null;
  readonly reviewedAt?: string | null;
  readonly packetHash?: string | null;
} | null;

export type DecisionBasisNotice = {
  readonly kind: "linked" | "unlinked" | "local_only";
  readonly text: string;
};

/**
 * 人工决定的外部依据只读说明。
 * 只描述依据来源与绑定状态；不把本地字段缺失解释为决定无效，也不改变决定。
 */
export function describeDecisionBasis(input: {
  readonly hasDecision: boolean;
  readonly source: DecisionBasisSource;
  readonly linkedRecordId?: string | null;
  readonly localEconomicsIncomplete: boolean;
}): DecisionBasisNotice | null {
  if (!input.hasDecision) return null;
  const economics = input.localEconomicsIncomplete
    ? " 本地经济性字段不完整，不能复核外部毛利模型；该缺口不否定历史决定。"
    : "";
  const recordId = input.source?.recordId?.trim() ?? "";
  if (!recordId) {
    return {
      kind: "local_only",
      text: `该人工决定未记录外部依据来源；当前仅展示本地保存的理由，不改变历史决定状态。${economics}`,
    };
  }
  const reviewedAt = input.source?.reviewedAt?.trim() ?? "";
  const date = /^\d{4}-\d{2}-\d{2}/u.test(reviewedAt) ? ` · ${reviewedAt.slice(0, 10)}` : "";
  const packetHash = input.source?.packetHash?.trim() ?? "";
  const packet = packetHash ? ` · 证据包 ${packetHash.slice(0, 10)}…` : "";
  const linked = input.source?.kind === "feishu_hub" && input.linkedRecordId === recordId;
  return {
    kind: linked ? "linked" : "unlinked",
    text: `外部依据：飞书 T02 记录 ${recordId}${date}${packet}。${linked ? "已与本地研究包绑定。" : "尚未与本地研究包建立有效绑定，需人工核对。"}${economics}`,
  };
}
