/**
 * Jev Phase 7B — Shadow Auditor。
 * 只生成旁路审计报告，绝不返回可直接写入 ProductFact 的变更。
 */
export const SHADOW_AUDITOR_SCHEMA = "source-layer-jev-shadow-auditor.v1" as const;

export const SHADOW_AUDIT_STATUSES = [
  "PASS",
  "SUSPECT",
  "MISSING_CANDIDATE",
  "CONFLICT_CANDIDATE",
  "STRUCTURE_DRIFT",
] as const;
export type ShadowAuditStatus = (typeof SHADOW_AUDIT_STATUSES)[number];

export type ShadowAuditFinding = {
  code: string;
  field: string | null;
  reason: string;
};

export type ShadowAuditResult = {
  schemaVersion: typeof SHADOW_AUDITOR_SCHEMA;
  jevRole: "shadow_auditor";
  status: ShadowAuditStatus;
  evidenceRefs: string[];
  pageTemplateHash: string | null;
  findings: ShadowAuditFinding[];
  generatedAt: string;
};

export type ShadowAuditInput = {
  fact: unknown;
  evidenceRefs: readonly string[];
  pageTemplateHash?: string | null;
  previousPageTemplateHash?: string | null;
  now?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function factFieldMissing(fact: Record<string, unknown>, group: string, field: string): boolean {
  const groupValue = fact[group];
  if (!isRecord(groupValue)) return true;
  const fieldValue = groupValue[field];
  if (!isRecord(fieldValue)) return true;
  return fieldValue.status === "missing" || fieldValue.value === null || fieldValue.value === undefined;
}

function containsReviewTitleReuse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const extended = value.extended;
  if (isRecord(extended) && typeof extended.reviewText === "object" && extended.reviewText !== null) {
    const reviewText = extended.reviewText as Record<string, unknown>;
    const title = (value.basic as Record<string, unknown> | undefined)?.title;
    return isRecord(title) && Boolean(title.value) && title.value === reviewText.value;
  }
  return false;
}

export function auditProductFactSnapshot(input: ShadowAuditInput): ShadowAuditResult {
  const refs = [...new Set(input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))].slice(0, 32);
  const findings: ShadowAuditFinding[] = [];
  let status: ShadowAuditStatus = "PASS";
  if (refs.length === 0) {
    status = "MISSING_CANDIDATE";
    findings.push({ code: "NO_EVIDENCE", field: null, reason: "旁路审计没有可追溯证据引用。" });
  } else if (!isRecord(input.fact)) {
    status = "MISSING_CANDIDATE";
    findings.push({ code: "FACT_MISSING", field: null, reason: "ProductFact 不存在。" });
  } else {
    const required = [
      ["basic", "asin"],
      ["basic", "title"],
      ["basic", "price"],
    ] as const;
    for (const [group, field] of required) {
      if (factFieldMissing(input.fact, group, field)) {
        status = "MISSING_CANDIDATE";
        findings.push({ code: "FIELD_MISSING", field: `${group}.${field}`, reason: "事实字段没有可用值。" });
      }
    }
    const groups = ["basic", "market", "profit", "extended"];
    for (const group of groups) {
      const value = input.fact[group];
      if (!isRecord(value)) continue;
      for (const [field, fieldValue] of Object.entries(value)) {
        if (isRecord(fieldValue) && fieldValue.status === "conflict") {
          status = "CONFLICT_CANDIDATE";
          findings.push({ code: "FIELD_CONFLICT", field: `${group}.${field}`, reason: "事实字段标记为冲突。" });
        }
      }
    }
    if (containsReviewTitleReuse(input.fact)) {
      if (status === "PASS") status = "SUSPECT";
      findings.push({ code: "REVIEW_TITLE_REUSED", field: "reviewText", reason: "评论正文疑似错误复用了评论标题。" });
    }
  }
  if (input.previousPageTemplateHash && input.pageTemplateHash
    && input.previousPageTemplateHash !== input.pageTemplateHash) {
    status = "STRUCTURE_DRIFT";
    findings.push({ code: "PAGE_TEMPLATE_CHANGED", field: null, reason: "页面模板指纹发生变化。" });
  }
  return {
    schemaVersion: SHADOW_AUDITOR_SCHEMA,
    jevRole: "shadow_auditor",
    status,
    evidenceRefs: refs,
    pageTemplateHash: input.pageTemplateHash ?? null,
    findings,
    generatedAt: input.now ?? new Date().toISOString(),
  };
}
