import "server-only";

import { readBitableTextValue, type LarkBitableRecord } from "./baseClient";

const SHA256 = /^[a-f0-9]{64}$/iu;
const LOCALIZED_DECISIONS = new Map<string, V5HubPacketHumanDecision["status"]>([
  ["通过", "APPROVE"],
  ["需补充验证", "VALIDATE_MORE"],
  ["暂缓", "PAUSE"],
  ["放弃", "DROP"],
]);

export type V5HubPacketHumanDecision = {
  readonly recordId: string;
  readonly subjectKey: string;
  readonly taskId: string;
  readonly asin: string;
  readonly marketplace: string;
  readonly revision: number;
  readonly packetHash: string;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly status: "APPROVE" | "VALIDATE_MORE" | "PAUSE" | "DROP";
  readonly reason: string;
  readonly reviewerIdentity: string;
  readonly reviewedAt: string;
  readonly lastModifiedTime: number;
};

export class V5HubPacketDecisionRecordError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "V5HubPacketDecisionRecordError";
  }
}

function text(fields: Readonly<Record<string, unknown>>, name: string): string {
  return readBitableTextValue(fields[name]);
}

function requiredText(fields: Readonly<Record<string, unknown>>, name: string): string {
  const value = text(fields, name);
  if (!value) throw new V5HubPacketDecisionRecordError(`DECISION_FIELD_REQUIRED:${name}`);
  return value;
}

function requiredHash(fields: Readonly<Record<string, unknown>>, name: string): string {
  const value = requiredText(fields, name);
  if (!SHA256.test(value)) throw new V5HubPacketDecisionRecordError(`DECISION_HASH_INVALID:${name}`);
  return value.toLowerCase();
}

/**
 * Parse only an explicitly submitted T02 research packet human decision.
 * The effective reviewer and review time come exclusively from platform-generated
 * modification metadata (last_modified_by.id and last_modified_time), not user-typed text.
 * The CAS token is the immutable 研究包哈希 (packetHash) of the row.
 */
export function parseV5HubPacketDecisionRecord(record: LarkBitableRecord): V5HubPacketHumanDecision | null {
  const rawStatus = text(record.fields, "人工决策");
  if (!rawStatus || rawStatus === "未审核") return null;
  const status = LOCALIZED_DECISIONS.get(rawStatus);
  if (!status) throw new V5HubPacketDecisionRecordError("DECISION_STATUS_INVALID");

  const platformReviewer = record.last_modified_by?.id?.trim() ?? "";
  if (!platformReviewer) throw new V5HubPacketDecisionRecordError("DECISION_REVIEWER_UNVERIFIED");

  const lastModifiedTime = record.last_modified_time;
  if (typeof lastModifiedTime !== "number" || !Number.isSafeInteger(lastModifiedTime) || lastModifiedTime <= 0
    || !Number.isFinite(new Date(lastModifiedTime).getTime())) {
    throw new V5HubPacketDecisionRecordError("DECISION_REVIEW_TIME_UNVERIFIED");
  }

  const reason = requiredText(record.fields, "决策备注");
  if (reason.length > 4_000) throw new V5HubPacketDecisionRecordError("DECISION_REASON_TOO_LONG");

  const revisionRaw = record.fields["修订版本"];
  const revision = typeof revisionRaw === "number"
    ? revisionRaw
    : Number(readBitableTextValue(revisionRaw));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new V5HubPacketDecisionRecordError("DECISION_REVISION_INVALID");
  }

  return {
    recordId: record.record_id,
    subjectKey: requiredText(record.fields, "主体键"),
    taskId: requiredText(record.fields, "任务 ID"),
    asin: requiredText(record.fields, "ASIN"),
    marketplace: requiredText(record.fields, "销售站点"),
    revision,
    packetHash: requiredHash(record.fields, "研究包哈希"),
    factHash: requiredHash(record.fields, "事实哈希"),
    evidenceHash: requiredHash(record.fields, "证据哈希"),
    status,
    reason,
    reviewerIdentity: platformReviewer,
    reviewedAt: new Date(lastModifiedTime).toISOString(),
    lastModifiedTime,
  };
}
