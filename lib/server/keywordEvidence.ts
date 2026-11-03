import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  TaskResultJsonMutationError,
  mutateTaskResultJson,
} from "@/lib/server/taskResultJsonMutation";
import { isSandboxTaskId, getSandboxTask } from "@/lib/server/demoSandbox";
import { prisma } from "@/lib/server/db";
import type { KeywordReport, KeywordReportRow, KeywordReportType } from "@/lib/upstream/sellersprite/keywordReports";
import { KEYWORD_REPORT_SCHEMA } from "@/lib/upstream/sellersprite/keywordReports";
import {
  parseSourceEvidenceRefs,
  type SourceEvidenceRef,
} from "@/lib/sourceLayer/evidenceRefs";
import { newSpanId, newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";

/**
 * 关键词 Evidence（seller-sprite-keyword-evidence.v1）——Phase 3/4 Save Evidence 闭环。
 * 存储：taskResultJson.keywordEvidence（writer 所有权契约，乐观并发）。
 * 流程：Preview（解析）→ Human bind（前端确认归属）→ Save（本模块）→ Workbench（读取）。
 */

export const KEYWORD_EVIDENCE_SCHEMA = "seller-sprite-keyword-evidence.v1" as const;
export const KEYWORD_EVIDENCE_NAMESPACE = "keywordEvidence" as const;
/**
 * 分型共存扩展：保留 keywordEvidence 作为旧读者的 latest 视图，
 * 用独立 namespace 保存 reverse_asin 与 keyword_mining 两类报告，避免
 * 后一次保存覆盖前一次报告。
 */
export const KEYWORD_EVIDENCE_BY_TYPE_NAMESPACE = "keywordEvidenceByType" as const;
export const KEYWORD_EVIDENCE_COLLECTION_SCHEMA = "seller-sprite-keyword-evidence-collection.v1" as const;

export type KeywordEvidenceV1 = {
  schema: typeof KEYWORD_EVIDENCE_SCHEMA;
  reportType: KeywordReportType;
  capturedAt: string;
  dataPeriod: null;
  rows: KeywordReportRow[];
  updatedAt: string;
  /** SellerSprite 页面人工 TSV 与官方 XLSX 的来源语义，不改变旧 sourceType。 */
  sourceMethod?: "sellersprite_page_manual_tsv" | "sellersprite_official_xlsx" | string;
  /** 只读引用：原始关键词报表通过 Capture Gateway 进入同一 EvidenceStore。 */
  sourceEvidenceRefs?: SourceEvidenceRef[];
};

export type KeywordEvidenceCollectionV1 = {
  schema: typeof KEYWORD_EVIDENCE_COLLECTION_SCHEMA;
  reports: Partial<Record<KeywordReportType, KeywordEvidenceV1>>;
  updatedAt: string;
};

export class KeywordEvidenceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KeywordEvidenceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function parseRow(value: unknown): KeywordReportRow | null {
  if (!isRecord(value)) return null;
  const rowNumber = typeof value.rowNumber === "number" ? value.rowNumber : null;
  const keyword = asString(value.keyword);
  if (rowNumber === null || !keyword) return null;
  const fields: Record<string, unknown> = {};
  if (isRecord(value.fields)) {
    for (const [field, fieldValue] of Object.entries(value.fields)) {
      if (isRecord(fieldValue)) {
        fields[field] = {
          raw: fieldValue.raw === null || typeof fieldValue.raw === "string" ? fieldValue.raw : null,
          normalized: fieldValue.normalized ?? null,
          metricNature: asString(fieldValue.metricNature, "unknown"),
          applicability: asString(fieldValue.applicability, "missing"),
        };
      }
    }
  }
  return {
    rowNumber,
    keyword,
    keywordTranslation: value.keywordTranslation === null || value.keywordTranslation === undefined
      ? null
      : asString(value.keywordTranslation),
    fields: fields as KeywordReportRow["fields"],
  };
}

export function parseKeywordEvidence(value: unknown): KeywordEvidenceV1 | null {
  if (!isRecord(value)) return null;
  if (value.schema !== KEYWORD_EVIDENCE_SCHEMA) return null;
  const reportType = value.reportType;
  if (reportType !== "reverse_asin" && reportType !== "keyword_mining") return null;
  if (!Array.isArray(value.rows)) return null;
  const rows: KeywordReportRow[] = [];
  for (const item of value.rows) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }
  const capturedAt = asString(value.capturedAt);
  if (!capturedAt) return null;
  const sourceEvidenceRefs = value.sourceEvidenceRefs === undefined
    ? undefined
    : parseSourceEvidenceRefs(value.sourceEvidenceRefs);
  if (value.sourceEvidenceRefs !== undefined && sourceEvidenceRefs === null) return null;
  return {
    schema: KEYWORD_EVIDENCE_SCHEMA,
    reportType,
    capturedAt,
    dataPeriod: null,
    rows,
    updatedAt: asString(value.updatedAt),
    ...(typeof value.sourceMethod === "string" && value.sourceMethod.trim()
      ? { sourceMethod: value.sourceMethod.trim().slice(0, 96) }
      : {}),
    ...(sourceEvidenceRefs ? { sourceEvidenceRefs } : {}),
  };
}

export function parseKeywordEvidenceCollection(value: unknown): KeywordEvidenceCollectionV1 | null {
  if (!isRecord(value) || value.schema !== KEYWORD_EVIDENCE_COLLECTION_SCHEMA || !isRecord(value.reports)) {
    return null;
  }
  const reports: Partial<Record<KeywordReportType, KeywordEvidenceV1>> = {};
  for (const reportType of ["reverse_asin", "keyword_mining"] as const) {
    const raw = value.reports[reportType];
    if (raw === undefined) continue;
    const parsed = parseKeywordEvidence(raw);
    if (!parsed || parsed.reportType !== reportType) return null;
    reports[reportType] = parsed;
  }
  const updatedAt = asString(value.updatedAt);
  if (!updatedAt || Object.keys(reports).length === 0) return null;
  return {
    schema: KEYWORD_EVIDENCE_COLLECTION_SCHEMA,
    reports,
    updatedAt,
  };
}

export function keywordReportToEvidence(
  report: KeywordReport,
  updatedAt: string,
  sourceEvidenceRefs?: SourceEvidenceRef[],
  sourceMethod?: KeywordEvidenceV1["sourceMethod"],
): KeywordEvidenceV1 {
  return {
    schema: KEYWORD_EVIDENCE_SCHEMA,
    reportType: report.reportType,
    capturedAt: report.capturedAt,
    dataPeriod: report.dataPeriod,
    rows: report.rows,
    updatedAt,
    ...(sourceMethod ? { sourceMethod } : {}),
    ...(sourceEvidenceRefs ? { sourceEvidenceRefs } : {}),
  };
}

function parseResultJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function readKeywordEvidenceSnapshot(
  context: AccessContext,
  taskId: string,
): Promise<{ updatedAt: Date | string; resultJson: string }> {
  if (context.mode === "demo") {
    if (!isSandboxTaskId(taskId)) {
      throw new KeywordEvidenceError("not_found", 404, "任务不存在。");
    }
    const task = getSandboxTask(context.demoAccessId, taskId);
    if (!task) {
      throw new KeywordEvidenceError("not_found", 404, "任务不存在。");
    }
    return { updatedAt: task.updatedAt, resultJson: task.resultJson };
  }
  if (isSandboxTaskId(taskId)) {
    throw new KeywordEvidenceError("not_found", 404, "任务不存在。");
  }
  const task = await prisma.viralAnalysisRecord.findFirst({
    where: { id: taskId },
    select: { id: true, updatedAt: true, resultJson: true },
  });
  if (!task) {
    throw new KeywordEvidenceError("not_found", 404, "任务不存在。");
  }
  return { updatedAt: task.updatedAt, resultJson: task.resultJson };
}

export async function getKeywordEvidence(
  context: AccessContext,
  taskId: string,
): Promise<KeywordEvidenceV1 | null> {
  const snapshot = await readKeywordEvidenceSnapshot(context, taskId);
  const result = parseResultJson(snapshot.resultJson);
  const raw = result[KEYWORD_EVIDENCE_NAMESPACE];
  if (raw === undefined) return null;
  return parseKeywordEvidence(raw);
}

async function recordKeywordDiagnostic(input: {
  context: AccessContext;
  traceId: string;
  taskId: string;
  evidence: KeywordEvidenceV1;
  status: "succeeded" | "failed";
  reason: string;
  errorCode?: string | null;
}): Promise<void> {
  const ref = input.evidence.sourceEvidenceRefs?.[0];
  if (!ref) return;
  await recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId: input.traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: input.taskId,
      captureId: ref.captureId,
      subjectKey: ref.subjectKey,
      module: "KEYWORD_EVIDENCE",
      phase: "persist",
      eventType: input.status === "succeeded" ? "keyword_evidence_saved" : "keyword_evidence_save_failed",
      severity: input.status === "failed" ? "error" : "info",
      statusBefore: null,
      statusAfter: input.status,
      status: input.status,
      errorCode: input.errorCode ?? null,
      reason: input.reason,
      retryable: input.status === "failed",
      humanRequired: input.status === "failed",
      sourceType: input.evidence.sourceMethod ?? "sellersprite_xlsx",
      recipeVersion: "seller-sprite-keyword-evidence.v1",
      pageTemplateHash: null,
      evidenceRefs: [ref.attachmentId, `evidence:${ref.evidenceId}`],
      contentHash: ref.attachmentHash,
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: null,
      attempt: 1,
    },
  }).catch(() => undefined);
}

/**
 * 返回按报表类型分组的正式关键词证据。
 * 旧任务只有 keywordEvidence 时，按其 reportType 兼容投影到分型结果。
 */
export async function getKeywordEvidenceReports(
  context: AccessContext,
  taskId: string,
): Promise<Partial<Record<KeywordReportType, KeywordEvidenceV1>>> {
  const snapshot = await readKeywordEvidenceSnapshot(context, taskId);
  const result = parseResultJson(snapshot.resultJson);
  const collection = parseKeywordEvidenceCollection(result[KEYWORD_EVIDENCE_BY_TYPE_NAMESPACE]);
  const reports: Partial<Record<KeywordReportType, KeywordEvidenceV1>> = collection
    ? { ...collection.reports }
    : {};
  const latest = parseKeywordEvidence(result[KEYWORD_EVIDENCE_NAMESPACE]);
  if (latest) reports[latest.reportType] = latest;
  return reports;
}

export async function saveKeywordEvidence(input: {
  context: AccessContext;
  taskId: string;
  evidence: KeywordEvidenceV1;
  expectedStorageVersion: { resultJsonHash: string; updatedAt: string };
  traceId?: string;
}): Promise<KeywordEvidenceV1> {
  if (input.evidence.rows.length === 0) {
    throw new KeywordEvidenceError("no_valid_rows", 400, "没有可保存的关键词证据行。");
  }
  const traceId = input.traceId ?? newTraceId();
  try {
    const mutation = await mutateTaskResultJson({
      context: input.context,
      taskId: input.taskId,
      writer: "keyword-evidence",
      expectedStorageVersion: input.expectedStorageVersion,
      mutate: (current) => {
        const next: KeywordEvidenceV1 = {
          ...input.evidence,
          updatedAt: new Date().toISOString(),
        };
        const existingCollection = parseKeywordEvidenceCollection(current[KEYWORD_EVIDENCE_BY_TYPE_NAMESPACE]);
        const legacyLatest = parseKeywordEvidence(current[KEYWORD_EVIDENCE_NAMESPACE]);
        const reports: Partial<Record<KeywordReportType, KeywordEvidenceV1>> = {
          ...(existingCollection?.reports ?? {}),
          ...(legacyLatest ? { [legacyLatest.reportType]: legacyLatest } : {}),
          [next.reportType]: next,
        };
        const collection: KeywordEvidenceCollectionV1 = {
          schema: KEYWORD_EVIDENCE_COLLECTION_SCHEMA,
          reports,
          updatedAt: next.updatedAt,
        };
        return {
          result: {
            ...current,
            [KEYWORD_EVIDENCE_NAMESPACE]: next,
            [KEYWORD_EVIDENCE_BY_TYPE_NAMESPACE]: collection,
          },
          value: next,
        };
      },
    });
    await recordKeywordDiagnostic({
      context: input.context,
      traceId,
      taskId: input.taskId,
      evidence: mutation.value,
      status: "succeeded",
      reason: "KeywordEvidence namespace saved after Source Layer evidence binding.",
    });
    return mutation.value;
  } catch (error) {
    await recordKeywordDiagnostic({
      context: input.context,
      traceId,
      taskId: input.taskId,
      evidence: input.evidence,
      status: "failed",
      reason: "KeywordEvidence namespace mutation failed; no unverified result was returned.",
      errorCode: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "PERSISTENCE_FAILED",
    });
    if (error instanceof KeywordEvidenceError) throw error;
    if (error instanceof TaskResultJsonMutationError) {
      throw new KeywordEvidenceError(error.code, error.status, error.message);
    }
    throw error;
  }
}
