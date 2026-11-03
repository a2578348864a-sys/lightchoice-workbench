import "server-only";

import { readBitableTextValue, type LarkBitableRecord } from "./baseClient";

const SHA256 = /^[a-f0-9]{64}$/iu;
const LOCALIZED_DECISIONS = new Map<string, V5HubHumanDecision["status"]>([
  ["通过", "APPROVE"],
  ["需补充验证", "VALIDATE_MORE"],
  ["暂缓", "PAUSE"],
  ["放弃", "DROP"],
]);
const REVIEW_TIME_TOLERANCE_MS = 5 * 60 * 1000;

export type V5HubHumanDecision = {
  readonly recordId: string;
  readonly conceptId: string;
  readonly subjectKey: string;
  readonly taskId: string;
  readonly conceptRevision: number;
  readonly reportHash: string;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly packetHash: string;
  readonly status: "APPROVE" | "VALIDATE_MORE" | "PAUSE" | "DROP";
  readonly reason: string;
  /** P1-HUB-03：个人复盘备注（飞书端可写；回读仅作 advisory 文本，不进事实链、不改决策） */
  readonly personalReview: string | null;
  readonly reviewerIdentity: string;
  readonly reviewedAt: string;
  readonly lastModifiedTime: number;
};

export class V5HubDecisionRecordError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "V5HubDecisionRecordError";
  }
}

function text(fields: Readonly<Record<string, unknown>>, name: string): string {
  return readBitableTextValue(fields[name]);
}

function requiredText(fields: Readonly<Record<string, unknown>>, name: string): string {
  const value = text(fields, name);
  if (!value) throw new V5HubDecisionRecordError(`DECISION_FIELD_REQUIRED:${name}`);
  return value;
}

function requiredHash(fields: Readonly<Record<string, unknown>>, name: string): string {
  const value = requiredText(fields, name);
  if (!SHA256.test(value)) throw new V5HubDecisionRecordError(`DECISION_HASH_INVALID:${name}`);
  return value.toLowerCase();
}

function dateValue(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  const parsed = Date.parse(readBitableTextValue(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Parse only an explicitly submitted T05 human decision. The reviewer identity
 * and timestamp cells are display-only user input. The effective reviewer and
 * review time come exclusively from platform-generated modification metadata.
 */
export function parseV5HubDecisionRecord(record: LarkBitableRecord): V5HubHumanDecision | null {
  const rawStatus = text(record.fields, "人工决策");
  if (!rawStatus || rawStatus === "未审核") return null;
  const status = LOCALIZED_DECISIONS.get(rawStatus);
  if (!status) throw new V5HubDecisionRecordError("DECISION_STATUS_INVALID");

  const platformReviewer = record.last_modified_by?.id?.trim() ?? "";
  if (!platformReviewer) throw new V5HubDecisionRecordError("DECISION_REVIEWER_UNVERIFIED");

  const lastModifiedTime = record.last_modified_time;
  const declaredReviewTime = dateValue(record.fields["审核时间"]);
  if (typeof lastModifiedTime !== "number" || !Number.isSafeInteger(lastModifiedTime) || lastModifiedTime <= 0
    || !Number.isFinite(new Date(lastModifiedTime).getTime())
    || !Number.isSafeInteger(declaredReviewTime)
    || Math.abs(declaredReviewTime - lastModifiedTime) > REVIEW_TIME_TOLERANCE_MS) {
    throw new V5HubDecisionRecordError("DECISION_REVIEW_TIME_UNVERIFIED");
  }

  const conceptRevisionRaw = record.fields["修订版本"];
  const conceptRevision = typeof conceptRevisionRaw === "number"
    ? conceptRevisionRaw
    : Number(readBitableTextValue(conceptRevisionRaw));
  if (!Number.isSafeInteger(conceptRevision) || conceptRevision < 1) {
    throw new V5HubDecisionRecordError("DECISION_CONCEPT_REVISION_INVALID");
  }

  const reason = requiredText(record.fields, "决策备注");
  if (reason.length > 4_000) throw new V5HubDecisionRecordError("DECISION_REASON_TOO_LONG");
  const personalReview = text(record.fields, "个人复盘") || null;
  if (personalReview && personalReview.length > 2_000) throw new V5HubDecisionRecordError("DECISION_PERSONAL_REVIEW_TOO_LONG");

  return {
    recordId: record.record_id,
    conceptId: requiredText(record.fields, "概念 ID"),
    subjectKey: requiredText(record.fields, "主体键"),
    taskId: requiredText(record.fields, "任务 ID"),
    conceptRevision,
    reportHash: requiredHash(record.fields, "报告哈希"),
    factHash: requiredHash(record.fields, "事实哈希"),
    evidenceHash: requiredHash(record.fields, "证据哈希"),
    packetHash: requiredHash(record.fields, "预期研究包哈希"),
    status,
    reason,
    personalReview,
    reviewerIdentity: platformReviewer,
    reviewedAt: new Date(lastModifiedTime).toISOString(),
    lastModifiedTime,
  };
}
