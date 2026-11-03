export type LegacyV5GenerationInput = {
  isLegacy: boolean;
  hasLegacyReport: boolean;
  reportHash: string | null;
  hasHumanDecision: boolean;
  boundaryAvailable: boolean;
  boundaryBlockReason?: string | null;
  busy: boolean;
  boundaryBlockedMessage?: string | null;
};

export function getLegacyV5GenerationState(input: LegacyV5GenerationInput) {
  const eligible = input.isLegacy && input.hasLegacyReport && !input.reportHash;
  const blockReason = input.hasHumanDecision
    ? "已有正式人工决断，不能直接生成 V5 研报。"
    : !input.boundaryAvailable
    ? input.boundaryBlockReason || "正式 ResearchInputBundle / EvidenceStore 边界不可用或无法确认，已阻止生成。"
    : input.boundaryBlockedMessage ?? null;

  return {
    visible: eligible,
    enabled: eligible && !input.busy && !blockReason,
    blockReason,
  };
}

export function shouldShowProductFactRecovery(input: {
  isLegacy: boolean;
  hasProductFact: boolean;
  asin?: string | null;
  hasHumanDecision: boolean;
}): boolean {
  return input.isLegacy
    && !input.hasProductFact
    && Boolean(input.asin?.trim())
    && !input.hasHumanDecision;
}
