import "server-only";

import { LOCAL_OWNER_PRINCIPAL } from "@/lib/server/accessPassword";
import {
  extractMonitoringField,
  type MonitoringEvidenceReference,
} from "@/lib/server/continuousMonitoringDiff";
import { parseV3ModuleEvidence, readV3ModuleEvidence, type V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { projectMonitoringProductIdentity, type MonitoringProductIdentity } from "@/lib/server/monitoringProductIdentity";

/**
 * Read-only projection of the values a monitoring run actually captured.
 *
 * It never invents a value: every field is either the exact `registeredFields` observation
 * from the referenced EvidenceStore attachment, or an explicit "unavailable" with the
 * provider-side reason. The attachment is re-validated against the run's evidence reference
 * before any value is projected, so a stale or mismatched file cannot be shown as current.
 */

export type MonitoringCaptureFieldId = "price" | "rating" | "reviewCount";

export type MonitoringCaptureField = {
  field: MonitoringCaptureFieldId;
  label: string;
  status: "observed" | "unavailable";
  value: number | null;
  currency: string | null;
  unit: "currency" | "stars" | "reviews";
  /** Machine reason for an unavailable field, e.g. `field_status_ambiguous`. */
  reason: string | null;
  /** Provider-side detail, e.g. `conflicting_candidates`. */
  detail: string | null;
  /** Plain-language explanation for end users; null when the field is observed. */
  message: string | null;
};

export type MonitoringLatestCapture = {
  capturedAt: string;
  sourceType: string;
  provider: string;
  metricNature: string;
  moduleStatus: string;
  fields: MonitoringCaptureField[];
  /**
   * 商品身份（英文原标题 / 可信主图 / 中文展示名），与本次指标来自同一份已校验附件，
   * 因此标题、图片与 ASIN 一定指向同一个商品。
   */
  product: MonitoringProductIdentity;
};

const FIELD_ORDER: readonly MonitoringCaptureFieldId[] = ["price", "rating", "reviewCount"];
const FIELD_LABELS: Readonly<Record<MonitoringCaptureFieldId, string>> = Object.freeze({
  price: "价格",
  rating: "星级",
  reviewCount: "评论数",
});
const FIELD_UNITS: Readonly<Record<MonitoringCaptureFieldId, MonitoringCaptureField["unit"]>> = Object.freeze({
  price: "currency",
  rating: "stars",
  reviewCount: "reviews",
});

function unavailableMessage(field: MonitoringCaptureFieldId, detail: string | null): string {
  if (field === "price") {
    if (detail === "conflicting_candidates") return "价格无法确认：本次页面存在多个价格候选。";
    return "价格无法确认：本次没有读到唯一可信的价格。";
  }
  if (field === "rating") return "星级无法确认：本次没有读到可信的星级。";
  return "评论数无法确认：本次没有读到可信的评论数。";
}

function projectField(
  evidence: V3ModuleEvidence,
  field: MonitoringCaptureFieldId,
): MonitoringCaptureField {
  const extraction = extractMonitoringField(evidence, field);
  const base = {
    field,
    label: FIELD_LABELS[field],
    unit: FIELD_UNITS[field],
  } as const;

  if (!extraction.ok) {
    return {
      ...base,
      status: "unavailable",
      value: null,
      currency: null,
      reason: extraction.reason,
      detail: extraction.detail,
      message: unavailableMessage(field, extraction.detail),
    };
  }

  return {
    ...base,
    status: "observed",
    value: extraction.metric.value,
    currency: field === "price" ? extraction.metric.unit : null,
    reason: null,
    detail: null,
    message: null,
  };
}

export async function projectLatestCapture(
  reference: MonitoringEvidenceReference | null,
): Promise<MonitoringLatestCapture | null> {
  if (!reference) return null;
  try {
    const readback = await readV3ModuleEvidence({
      context: LOCAL_OWNER_PRINCIPAL,
      subjectKey: reference.subjectKey,
      module: reference.module,
    });
    return projectFromAttachments(readback.evidenceStore?.attachments ?? [], reference);
  } catch {
    // A read failure must degrade to "no projected values", never to fabricated ones.
    return null;
  }
}

type AttachmentLike = { attachmentId: string; contentHash: string; capturedAt: string; sourceType: string; payload: unknown };

function projectFromAttachments(
  attachments: readonly AttachmentLike[],
  reference: MonitoringEvidenceReference,
): MonitoringLatestCapture | null {
  const attachment = attachments.find((item) => item.attachmentId === reference.attachmentId);
  if (!attachment
    || attachment.contentHash !== reference.contentHash
    || attachment.capturedAt !== reference.capturedAt
    || attachment.sourceType !== reference.sourceType) return null;

  const evidence = parseV3ModuleEvidence(attachment.payload);
  if (!evidence
    || evidence.subjectKey !== reference.subjectKey
    || evidence.module !== reference.module
    || evidence.capturedAt !== reference.capturedAt
    || evidence.provider !== reference.provider
    || evidence.acquisitionMode !== reference.acquisitionMode
    || evidence.metricNature !== reference.metricNature) return null;

  return {
    capturedAt: evidence.capturedAt,
    sourceType: attachment.sourceType,
    provider: evidence.provider,
    metricNature: evidence.metricNature,
    moduleStatus: evidence.status,
    fields: FIELD_ORDER.map((field) => projectField(evidence, field)),
    product: projectMonitoringProductIdentity(evidence),
  };
}

/**
 * Projects many runs of one subject with a single EvidenceStore directory read.
 * Used by the run-history endpoint so "what was actually captured" is visible per run
 * without re-reading the subject for every row.
 */
export async function projectCapturesForSubject(
  subjectKey: string,
  references: ReadonlyArray<MonitoringEvidenceReference | null>,
): Promise<Array<MonitoringLatestCapture | null>> {
  const present = references.filter((reference): reference is MonitoringEvidenceReference => reference !== null);
  if (present.length === 0) return references.map(() => null);
  try {
    const readback = await readV3ModuleEvidence({
      context: LOCAL_OWNER_PRINCIPAL,
      subjectKey,
      module: present[0].module,
    });
    const attachments = readback.evidenceStore?.attachments ?? [];
    return references.map((reference) => (reference ? projectFromAttachments(attachments, reference) : null));
  } catch {
    return references.map(() => null);
  }
}
