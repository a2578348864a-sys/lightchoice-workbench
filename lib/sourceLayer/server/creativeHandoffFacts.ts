import "server-only";

/**
 * Product Source Layer V1.2 — 来源证据 → 创作交接的窄适配器
 *
 * 职责边界（刻意保持很窄）：
 * - 只做「来源证据字段 → 既有 manual fact 白名单字段」的映射；
 * - 值必须原样取自 Capture Package，**绝不推测、绝不补全**；
 * - 不存在对应字段时返回空数组（缺失保持缺失）；
 * - 不改动 Evidence / 研究 / 创作任何核心逻辑，只组装既有接口的调用参数。
 *
 * 为什么需要它：来源层的 analysis context 是扁平投影（seller_sprite_market_research），
 * 不含 productFacts，因此研究侧确定性事实候选为 0；此时既有链路提供的
 * 「人工补充事实」（human_manual，服务端白名单）是唯一合法的补事实通道。
 */

export type ManualFactInput = {
  field: string;
  value: string;
};

/** 既有 manual fact 白名单里、来源证据可直接映射的字段。 */
const CAPTURE_TO_MANUAL_FIELD = {
  title: "series_or_model",
  bsrCategory: "product_type",
} as const;

/** 与 lib/server/manualFactConfirmation.ts 一致的取值上限。 */
const MAX_VALUE_LENGTH = 200;

export function manualFactsFromCaptureFields(input: {
  title?: string | null;
  bsrCategory?: string | null;
}): ManualFactInput[] {
  const candidates: Array<{ field: string; raw: string | null | undefined }> = [
    { field: CAPTURE_TO_MANUAL_FIELD.bsrCategory, raw: input.bsrCategory },
    { field: CAPTURE_TO_MANUAL_FIELD.title, raw: input.title },
  ];
  const out: ManualFactInput[] = [];
  for (const candidate of candidates) {
    if (typeof candidate.raw !== "string") continue;
    const value = candidate.raw.normalize("NFC").trim().replace(/\s+/g, " ");
    // 空值或超长值一律不产出：宁缺勿错，不做截断（截断会产生错误事实）。
    if (!value || value.length > MAX_VALUE_LENGTH) continue;
    out.push({ field: candidate.field, value });
  }
  return out;
}

export type HandoffInputFromManualFacts = {
  requestId: string;
  expectedResearchRevision: number;
  expectedCurrentHandoffRevision: number;
  expectedStorageVersion: { resultJsonHash: string; updatedAt: string };
  selectedFactCandidateIds: string[];
  manualConfirmedFacts: ManualFactInput[];
};

/**
 * 组装 createOrAppendCreativeHandoff 的输入。
 * selectedFactCandidateIds 固定为空：没有确定性候选时不得伪造候选引用。
 */
export function buildHandoffInputFromManualFacts(input: {
  requestId: string;
  expectedResearchRevision: number;
  expectedCurrentHandoffRevision: number;
  expectedStorageVersion: { resultJsonHash: string; updatedAt: string };
  manualConfirmedFacts: readonly ManualFactInput[];
}): HandoffInputFromManualFacts {
  if (!input.requestId.trim()) throw new Error("handoff_request_id_required");
  if (!Number.isSafeInteger(input.expectedResearchRevision) || input.expectedResearchRevision < 1) {
    throw new Error("handoff_research_revision_invalid");
  }
  if (!Number.isSafeInteger(input.expectedCurrentHandoffRevision) || input.expectedCurrentHandoffRevision < 0) {
    throw new Error("handoff_current_revision_invalid");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedStorageVersion.resultJsonHash)) {
    throw new Error("handoff_storage_version_invalid");
  }
  if (Number.isNaN(Date.parse(input.expectedStorageVersion.updatedAt))) {
    throw new Error("handoff_storage_version_invalid");
  }
  return {
    requestId: input.requestId,
    expectedResearchRevision: input.expectedResearchRevision,
    expectedCurrentHandoffRevision: input.expectedCurrentHandoffRevision,
    expectedStorageVersion: input.expectedStorageVersion,
    selectedFactCandidateIds: [],
    manualConfirmedFacts: [...input.manualConfirmedFacts],
  };
}
