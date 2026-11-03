/**
 * Phase 2：Market Opportunity 运行时契约。
 *
 * 机会池只编组已经存在的 MarketScan；它不复制商品事实，也不把 AI 文本
 * 伪装成新的数值事实。所有从数据库 / API 进入业务层的 JSON 都必须经过这里。
 */

import {
  MARKET_METRICS_VERSION,
  NICHE_DEFINITION_KINDS,
  type MarketMetricsV1,
  type NicheDefinitionV1,
  type SampleDefinitionV1,
} from "@/lib/marketScan/types";
import {
  parseMarketMetricsV1,
  parseSampleDefinitionV1,
} from "@/lib/marketScan/contract";
import { stableStringify } from "@/lib/marketScan/metrics";
import {
  AI_STATUSES,
  ANALYSIS_STATUSES,
  HUMAN_DECISIONS,
  LARK_SYNC_STATUSES,
  MARKET_OPPORTUNITY_AI_SCHEMA,
  MARKET_OPPORTUNITY_ANALYSIS_SCHEMA,
  MARKET_OPPORTUNITY_EXPORT_SCHEMA,
  MARKET_OPPORTUNITY_NICHE_SCHEMA,
  MARKET_OPPORTUNITY_SCHEMA,
  type AnalysisStatus,
  type AiStatus,
  type HumanDecisionStatus,
  type LarkSyncStatus,
  type MarketOpportunityAiInterpretation,
  type MarketOpportunityAnalysisSnapshot,
  type MarketOpportunityComparison,
  type MarketOpportunityFactRef,
  type MarketOpportunityHumanDecision,
  type MarketOpportunityLarkSync,
  type MarketOpportunityNicheDefinition,
  type MarketOpportunityScanRef,
  type OpportunityExportRecord,
} from "@/lib/marketOpportunity/types";

export const MARKET_OPPORTUNITY_MAX_NAME_LENGTH = 200;
export const MARKET_OPPORTUNITY_MAX_SCAN_REFS = 100;
export const MARKET_OPPORTUNITY_MAX_TEXT_LENGTH = 4_000;
export const MARKET_OPPORTUNITY_MAX_LIST_ITEMS = 40;
export const MARKET_OPPORTUNITY_MAX_JSON_BYTES = 4 * 1024 * 1024;

export type MarketOpportunityContractErrorCode =
  | "market_opportunity_invalid"
  | "market_opportunity_json_invalid"
  | "market_opportunity_json_too_large"
  | "market_opportunity_scan_mismatch"
  | "market_opportunity_ai_invalid"
  | "market_opportunity_human_decision_invalid"
  | "market_opportunity_lark_invalid";

export class MarketOpportunityContractError extends Error {
  constructor(
    public readonly code: MarketOpportunityContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketOpportunityContractError";
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const METRICS_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NICHE_KINDS = new Set<string>(NICHE_DEFINITION_KINDS);
const ANALYSIS_STATUS_SET = new Set<string>(ANALYSIS_STATUSES);
const AI_STATUS_SET = new Set<string>(AI_STATUSES);
const HUMAN_DECISION_SET = new Set<string>(HUMAN_DECISIONS);
const LARK_STATUS_SET = new Set<string>(LARK_SYNC_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: MarketOpportunityContractErrorCode, message: string): never {
  throw new MarketOpportunityContractError(code, message);
}

function text(
  value: unknown,
  maxLength: number,
  label: string,
  code: MarketOpportunityContractErrorCode = "market_opportunity_invalid",
): string {
  if (typeof value !== "string") fail(code, `${label} 必须是字符串。`);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maxLength) fail(code, `${label} 长度不合法。`);
  return normalized;
}

function nullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, maxLength, label);
}

function optionalIso(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail("market_opportunity_invalid", `${label} 必须是 UTC ISO 时间。`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("market_opportunity_invalid", `${label} 不合法。`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("market_opportunity_invalid", `${label} 必须是 64 位小写 SHA-256。`);
  }
  return value;
}

function metricsVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !METRICS_VERSION_PATTERN.test(value)) {
    fail("market_opportunity_invalid", `${label} 不合法。`);
  }
  return value;
}

function finiteNumberOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("market_opportunity_json_invalid", `${label} 必须是有限数值或 null。`);
  }
  return value;
}

function boundedStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail("market_opportunity_json_invalid", `${label} 必须是数组。`);
  if (value.length > MARKET_OPPORTUNITY_MAX_LIST_ITEMS) {
    fail("market_opportunity_json_invalid", `${label} 条数超出上限。`);
  }
  return value.map((item, index) => text(
    item,
    MARKET_OPPORTUNITY_MAX_TEXT_LENGTH,
    `${label}[${index}]`,
    "market_opportunity_json_invalid",
  ));
}

function scalarParameters(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) fail("market_opportunity_json_invalid", "nicheDefinition.parameters 必须是对象。");
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/u.test(key)) {
      fail("market_opportunity_json_invalid", "nicheDefinition.parameters 的键不合法。");
    }
    if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
      if (typeof raw === "string" && raw.length > 500) {
        fail("market_opportunity_json_invalid", "nicheDefinition.parameters 文本过长。");
      }
      result[key] = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    } else {
      fail("market_opportunity_json_invalid", "nicheDefinition.parameters 只允许标量。");
    }
  }
  return result;
}

export function parseMarketOpportunityNicheDefinition(
  value: unknown,
): MarketOpportunityNicheDefinition {
  if (!isRecord(value)) fail("market_opportunity_json_invalid", "机会定义必须是对象。");
  if (value.schemaVersion !== MARKET_OPPORTUNITY_NICHE_SCHEMA) {
    fail("market_opportunity_json_invalid", "机会定义 schemaVersion 不受支持。");
  }
  if (typeof value.kind !== "string" || !NICHE_KINDS.has(value.kind)) {
    fail("market_opportunity_json_invalid", "机会定义 kind 不受支持。");
  }
  return {
    schemaVersion: MARKET_OPPORTUNITY_NICHE_SCHEMA,
    kind: value.kind as MarketOpportunityNicheDefinition["kind"],
    label: text(value.label, MARKET_OPPORTUNITY_MAX_NAME_LENGTH, "机会定义.label", "market_opportunity_json_invalid"),
    notes: nullableText(value.notes, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "机会定义.notes"),
    parameters: scalarParameters(value.parameters),
  };
}

export function buildMarketOpportunityNicheDefinition(
  input: NicheDefinitionV1,
): MarketOpportunityNicheDefinition {
  return parseMarketOpportunityNicheDefinition({
    schemaVersion: MARKET_OPPORTUNITY_NICHE_SCHEMA,
    kind: input.kind,
    label: input.label,
    notes: input.notes,
    parameters: input.parameters,
  });
}

export function parseMarketOpportunityScanRef(value: unknown, label = "scanRef"): MarketOpportunityScanRef {
  if (!isRecord(value)) fail("market_opportunity_json_invalid", `${label} 必须是对象。`);
  const sampleCount = value.sampleCount;
  if (!Number.isSafeInteger(sampleCount) || (sampleCount as number) < 1 || (sampleCount as number) > 500) {
    fail("market_opportunity_json_invalid", `${label}.sampleCount 不合法。`);
  }
  const createdAt = optionalIso(value.createdAt, `${label}.createdAt`);
  if (createdAt === null) fail("market_opportunity_json_invalid", `${label}.createdAt 不能为空。`);
  return {
    scanId: id(value.scanId, `${label}.scanId`),
    sampleHash: hash(value.sampleHash, `${label}.sampleHash`),
    metricsVersion: metricsVersion(value.metricsVersion, `${label}.metricsVersion`),
    sampleCount: sampleCount as number,
    createdAt,
  };
}

export function parseMarketOpportunityScanRefs(value: unknown): MarketOpportunityScanRef[] {
  if (!Array.isArray(value)) fail("market_opportunity_json_invalid", "scanRefs 必须是数组。");
  if (value.length < 1 || value.length > MARKET_OPPORTUNITY_MAX_SCAN_REFS) {
    fail("market_opportunity_json_invalid", "scanRefs 条数不合法。");
  }
  const refs = value.map((item, index) => parseMarketOpportunityScanRef(item, `scanRefs[${index}]`));
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.scanId)) fail("market_opportunity_scan_mismatch", "scanRefs 不得包含重复扫描。 ");
    seen.add(ref.scanId);
  }
  return refs;
}

const COMPARISON_REASONS = new Set([
  "marketplace_mismatch",
  "niche_definition_mismatch",
  "sample_definition_mismatch",
  "metrics_version_mismatch",
  "metric_missing",
]);

export function parseMarketOpportunityComparison(
  value: unknown,
): MarketOpportunityComparison | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) fail("market_opportunity_json_invalid", "comparison 必须是对象或 null。");
  if (value.status !== "COMPARABLE" && value.status !== "INSUFFICIENT_DATA") {
    fail("market_opportunity_json_invalid", "comparison.status 不受支持。");
  }
  if (!Array.isArray(value.reasons)) fail("market_opportunity_json_invalid", "comparison.reasons 必须是数组。");
  const reasons: MarketOpportunityComparison["reasons"][number][] = [];
  for (const reason of value.reasons) {
    if (typeof reason !== "string" || !COMPARISON_REASONS.has(reason)) {
      fail("market_opportunity_json_invalid", "comparison.reasons 含不支持的原因。");
    }
    if (!reasons.includes(reason as typeof reasons[number])) reasons.push(reason as typeof reasons[number]);
  }
  return {
    status: value.status,
    fromScanId: id(value.fromScanId, "comparison.fromScanId"),
    toScanId: id(value.toScanId, "comparison.toScanId"),
    reasons,
    priceMedianDelta: finiteNumberOrNull(value.priceMedianDelta, "comparison.priceMedianDelta"),
    knownSalesDelta: finiteNumberOrNull(value.knownSalesDelta, "comparison.knownSalesDelta"),
    knownRevenueDelta: finiteNumberOrNull(value.knownRevenueDelta, "comparison.knownRevenueDelta"),
    cr5Delta: finiteNumberOrNull(value.cr5Delta, "comparison.cr5Delta"),
    brandCountDelta: finiteNumberOrNull(value.brandCountDelta, "comparison.brandCountDelta"),
    ratingDelta: finiteNumberOrNull(value.ratingDelta, "comparison.ratingDelta"),
    reviewBarrierDelta: finiteNumberOrNull(value.reviewBarrierDelta, "comparison.reviewBarrierDelta"),
  };
}

export function parseMarketOpportunityAnalysisSnapshot(
  value: unknown,
): MarketOpportunityAnalysisSnapshot {
  if (!isRecord(value)) fail("market_opportunity_json_invalid", "analysisSnapshot 必须是对象。");
  if (value.schemaVersion !== MARKET_OPPORTUNITY_ANALYSIS_SCHEMA) {
    fail("market_opportunity_json_invalid", "analysisSnapshot.schemaVersion 不受支持。");
  }
  if (typeof value.status !== "string" || !ANALYSIS_STATUS_SET.has(value.status)) {
    fail("market_opportunity_json_invalid", "analysisSnapshot.status 不受支持。");
  }
  const scanRef = parseMarketOpportunityScanRef(value.scanRef, "analysisSnapshot.scanRef");
  const latestScanId = id(value.latestScanId, "analysisSnapshot.latestScanId");
  if (latestScanId !== scanRef.scanId) {
    fail("market_opportunity_scan_mismatch", "analysisSnapshot.latestScanId 与 scanRef 不一致。");
  }
  const sampleDefinition = parseSampleDefinitionV1(value.sampleDefinition);
  const metrics = parseMarketMetricsV1(value.metrics);
  if (metrics.sampleHash !== scanRef.sampleHash || metrics.metricsVersion !== scanRef.metricsVersion
    || metrics.sampleCount !== scanRef.sampleCount) {
    fail("market_opportunity_scan_mismatch", "analysisSnapshot 的指标与 scanRef 不一致。");
  }
  const generatedAt = optionalIso(value.generatedAt, "analysisSnapshot.generatedAt");
  if (generatedAt === null) fail("market_opportunity_json_invalid", "analysisSnapshot.generatedAt 不能为空。");
  return {
    schemaVersion: MARKET_OPPORTUNITY_ANALYSIS_SCHEMA,
    status: value.status as AnalysisStatus,
    latestScanId,
    scanRef,
    sampleDefinition,
    metrics,
    comparison: parseMarketOpportunityComparison(value.comparison),
    missingEvidence: boundedStringList(value.missingEvidence, "analysisSnapshot.missingEvidence"),
    generatedAt,
  };
}

export function assertOpportunityJsonWithinLimit(label: string, json: string): string {
  if (Buffer.byteLength(json, "utf8") > MARKET_OPPORTUNITY_MAX_JSON_BYTES) {
    fail("market_opportunity_json_too_large", `${label} 超出大小上限。`);
  }
  return json;
}

export function serializeOpportunityJson(value: unknown, label: string): string {
  return assertOpportunityJsonWithinLimit(label, stableStringify(value));
}

function parseFactRef(value: unknown, index: number): MarketOpportunityFactRef {
  if (!isRecord(value)) fail("market_opportunity_ai_invalid", `factRefs[${index}] 必须是对象。`);
  const source = value.source;
  if (source !== "market_scan_metrics" && source !== "market_scan_sample"
    && source !== "scan_comparison" && source !== "coverage") {
    fail("market_opportunity_ai_invalid", `factRefs[${index}].source 不受支持。`);
  }
  return {
    path: text(value.path, 200, `factRefs[${index}].path`, "market_opportunity_ai_invalid"),
    source,
    scanId: id(value.scanId, `factRefs[${index}].scanId`),
  };
}

export function parseMarketOpportunityAiInterpretation(
  value: unknown,
): MarketOpportunityAiInterpretation {
  if (!isRecord(value)) fail("market_opportunity_ai_invalid", "AI 解释必须是对象。");
  if (value.schemaVersion !== MARKET_OPPORTUNITY_AI_SCHEMA) {
    fail("market_opportunity_ai_invalid", "AI 解释 schemaVersion 不受支持。");
  }
  if (typeof value.status !== "string" || !AI_STATUS_SET.has(value.status)) {
    fail("market_opportunity_ai_invalid", "AI 解释 status 不受支持。");
  }
  const factRefsRaw = value.factRefs;
  if (!Array.isArray(factRefsRaw) || factRefsRaw.length > MARKET_OPPORTUNITY_MAX_LIST_ITEMS) {
    fail("market_opportunity_ai_invalid", "AI 解释 factRefs 不合法。");
  }
  const factRefs = factRefsRaw.map((item, index) => parseFactRef(item, index));
  const generatedAt = optionalIso(value.generatedAt, "AI 解释.generatedAt");
  return {
    schemaVersion: MARKET_OPPORTUNITY_AI_SCHEMA,
    status: value.status as AiStatus,
    summary: nullableText(value.summary, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "AI 解释.summary"),
    observations: boundedStringList(value.observations, "AI 解释.observations"),
    risks: boundedStringList(value.risks, "AI 解释.risks"),
    missingEvidence: boundedStringList(value.missingEvidence, "AI 解释.missingEvidence"),
    questionsToValidate: boundedStringList(value.questionsToValidate, "AI 解释.questionsToValidate"),
    suggestedNextStep: nullableText(value.suggestedNextStep, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "AI 解释.suggestedNextStep"),
    factRefs,
    generatedAt,
    model: nullableText(value.model, 200, "AI 解释.model"),
    ...(value.errorCode === undefined ? {} : {
      errorCode: text(value.errorCode, 100, "AI 解释.errorCode", "market_opportunity_ai_invalid"),
    }),
  };
}

export function buildNotRequestedAiInterpretation(): MarketOpportunityAiInterpretation {
  return {
    schemaVersion: MARKET_OPPORTUNITY_AI_SCHEMA,
    status: "NOT_REQUESTED",
    summary: null,
    observations: [],
    risks: [],
    missingEvidence: [],
    questionsToValidate: [],
    suggestedNextStep: null,
    factRefs: [],
    generatedAt: null,
    model: null,
  };
}

export function buildFailedAiInterpretation(errorCode: string, generatedAt = new Date().toISOString()): MarketOpportunityAiInterpretation {
  return parseMarketOpportunityAiInterpretation({
    schemaVersion: MARKET_OPPORTUNITY_AI_SCHEMA,
    status: "FAILED",
    summary: null,
    observations: [],
    risks: [],
    missingEvidence: [],
    questionsToValidate: [],
    suggestedNextStep: null,
    factRefs: [],
    generatedAt,
    model: null,
    errorCode,
  });
}

export function parseMarketOpportunityHumanDecision(
  value: unknown,
): MarketOpportunityHumanDecision {
  if (!isRecord(value)) fail("market_opportunity_human_decision_invalid", "人工决策必须是对象。");
  if (typeof value.status !== "string" || !HUMAN_DECISION_SET.has(value.status)) {
    fail("market_opportunity_human_decision_invalid", "人工决策 status 不受支持。");
  }
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    fail("market_opportunity_human_decision_invalid", "人工决策 revision 不合法。");
  }
  return {
    status: value.status as HumanDecisionStatus,
    reason: nullableText(value.reason, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "人工决策.reason"),
    nextAction: nullableText(value.nextAction, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "人工决策.nextAction"),
    decidedAt: optionalIso(value.decidedAt, "人工决策.decidedAt"),
    revision: revision as number,
  };
}

export function buildInitialHumanDecision(): MarketOpportunityHumanDecision {
  return {
    status: "UNREVIEWED",
    reason: null,
    nextAction: null,
    decidedAt: null,
    revision: 0,
  };
}

export function parseMarketOpportunityLarkSync(value: unknown): MarketOpportunityLarkSync {
  if (!isRecord(value)) fail("market_opportunity_lark_invalid", "飞书同步状态必须是对象。");
  if (typeof value.status !== "string" || !LARK_STATUS_SET.has(value.status)) {
    fail("market_opportunity_lark_invalid", "飞书同步 status 不受支持。");
  }
  if (value.exportContractVersion !== MARKET_OPPORTUNITY_EXPORT_SCHEMA) {
    fail("market_opportunity_lark_invalid", "飞书同步契约版本不受支持。");
  }
  return {
    status: value.status as LarkSyncStatus,
    exportContractVersion: MARKET_OPPORTUNITY_EXPORT_SCHEMA,
    opportunityId: value.opportunityId === null || value.opportunityId === undefined
      ? null : id(value.opportunityId, "飞书同步.opportunityId"),
    tableId: nullableText(value.tableId, 200, "飞书同步.tableId"),
    recordId: nullableText(value.recordId, 200, "飞书同步.recordId"),
    viewUrl: nullableText(value.viewUrl, 2_048, "飞书同步.viewUrl"),
    syncedAt: optionalIso(value.syncedAt, "飞书同步.syncedAt"),
    idempotencyKey: nullableText(value.idempotencyKey, 200, "飞书同步.idempotencyKey"),
    ...(value.errorCode === undefined ? {} : {
      errorCode: text(value.errorCode, 100, "飞书同步.errorCode", "market_opportunity_lark_invalid"),
    }),
  };
}

export function buildInitialLarkSync(): MarketOpportunityLarkSync {
  return {
    status: "NOT_SYNCED",
    exportContractVersion: MARKET_OPPORTUNITY_EXPORT_SCHEMA,
    opportunityId: null,
    tableId: null,
    recordId: null,
    viewUrl: null,
    syncedAt: null,
    idempotencyKey: null,
  };
}

export function parseOpportunityExportRecord(value: unknown): OpportunityExportRecord {
  if (!isRecord(value)) fail("market_opportunity_json_invalid", "OpportunityExportRecord 必须是对象。");
  if (value.schemaVersion !== MARKET_OPPORTUNITY_EXPORT_SCHEMA) {
    fail("market_opportunity_json_invalid", "OpportunityExportRecord 版本不受支持。");
  }
  if (typeof value.metricsSummary !== "object" || value.metricsSummary === null || Array.isArray(value.metricsSummary)) {
    fail("market_opportunity_json_invalid", "OpportunityExportRecord.metricsSummary 必须是对象。");
  }
  if (typeof value.humanDecision !== "string" || !HUMAN_DECISION_SET.has(value.humanDecision)) {
    fail("market_opportunity_json_invalid", "OpportunityExportRecord.humanDecision 不受支持。");
  }
  const exportedAt = optionalIso(value.exportedAt, "OpportunityExportRecord.exportedAt");
  if (!exportedAt) fail("market_opportunity_json_invalid", "OpportunityExportRecord.exportedAt 不能为空。");
  const sampleCount = value.sampleCount;
  if (!Number.isSafeInteger(sampleCount) || (sampleCount as number) < 1 || (sampleCount as number) > 500) {
    fail("market_opportunity_json_invalid", "OpportunityExportRecord.sampleCount 不合法。");
  }
  return {
    schemaVersion: MARKET_OPPORTUNITY_EXPORT_SCHEMA,
    opportunityId: id(value.opportunityId, "OpportunityExportRecord.opportunityId"),
    name: text(value.name, MARKET_OPPORTUNITY_MAX_NAME_LENGTH, "OpportunityExportRecord.name"),
    marketplace: text(value.marketplace, 16, "OpportunityExportRecord.marketplace").toUpperCase(),
    nicheKind: text(value.nicheKind, 80, "OpportunityExportRecord.nicheKind"),
    latestScanId: id(value.latestScanId, "OpportunityExportRecord.latestScanId"),
    sampleCount: sampleCount as number,
    metricsSummary: value.metricsSummary as Readonly<Record<string, unknown>>,
    humanDecision: value.humanDecision as HumanDecisionStatus,
    decisionReason: nullableText(value.decisionReason, MARKET_OPPORTUNITY_MAX_TEXT_LENGTH, "OpportunityExportRecord.decisionReason"),
    opportunityUrl: text(value.opportunityUrl, 2_048, "OpportunityExportRecord.opportunityUrl"),
    exportedAt,
  };
}

export function assertOpportunityIdentity(input: {
  readonly latestScanId: string;
  readonly scanRefs: readonly MarketOpportunityScanRef[];
  readonly analysisSnapshot: MarketOpportunityAnalysisSnapshot;
}): void {
  if (input.analysisSnapshot.latestScanId !== input.latestScanId
    || !input.scanRefs.some((ref) => ref.scanId === input.latestScanId)) {
    fail("market_opportunity_scan_mismatch", "机会的 latestMarketScanId 必须存在于 scanRefs 且与分析快照一致。");
  }
}

export function parseMarketOpportunitySchemaVersion(value: unknown): typeof MARKET_OPPORTUNITY_SCHEMA {
  if (value !== MARKET_OPPORTUNITY_SCHEMA) fail("market_opportunity_invalid", "机会 schemaVersion 不受支持。");
  return MARKET_OPPORTUNITY_SCHEMA;
}

export function parseMarketOpportunityAnalysisStatus(value: unknown): AnalysisStatus {
  if (typeof value !== "string" || !ANALYSIS_STATUS_SET.has(value)) {
    fail("market_opportunity_invalid", "分析状态不受支持。");
  }
  return value as AnalysisStatus;
}

export function parseMarketOpportunityAiStatus(value: unknown): AiStatus {
  if (typeof value !== "string" || !AI_STATUS_SET.has(value)) {
    fail("market_opportunity_ai_invalid", "AI 状态不受支持。");
  }
  return value as AiStatus;
}

export function parseMarketOpportunityHumanDecisionStatus(value: unknown): HumanDecisionStatus {
  if (typeof value !== "string" || !HUMAN_DECISION_SET.has(value)) {
    fail("market_opportunity_human_decision_invalid", "人工决策状态不受支持。");
  }
  return value as HumanDecisionStatus;
}

export function expectedMetricsVersion(): string {
  return MARKET_METRICS_VERSION;
}

export function canonicalOpportunityIdentity(value: {
  readonly marketplace: string;
  readonly nicheDefinition: MarketOpportunityNicheDefinition;
  readonly sampleDefinition: SampleDefinitionV1;
}): string {
  return stableStringify({
    marketplace: value.marketplace,
    nicheDefinition: value.nicheDefinition,
    sampleDefinition: value.sampleDefinition,
  });
}

export type { MarketMetricsV1 };
