/**
 * Research 侧 KeywordEvidence / ReviewEvidence 对 Source Layer 的只读引用。
 * 引用的是同一主体下的商品 Evidence 版本与附属 Evidence，不复制 ProductFact。
 */
export type SourceEvidenceRef = {
  readonly subjectKey: string;
  readonly captureId: string;
  readonly evidenceId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly attachmentId: string;
  readonly attachmentHash: string;
};

export function parseSourceEvidenceRefs(value: unknown): SourceEvidenceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SourceEvidenceRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.subjectKey !== "string" || !record.subjectKey.trim()) return null;
    if (typeof record.captureId !== "string" || !record.captureId.trim()) return null;
    if (typeof record.evidenceId !== "string" || !record.evidenceId.trim()) return null;
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) return null;
    if (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)) return null;
    if (typeof record.attachmentId !== "string" || !record.attachmentId.trim()) return null;
    if (typeof record.attachmentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.attachmentHash)) return null;
    refs.push(record as unknown as SourceEvidenceRef);
  }
  return refs;
}

