import "server-only";
import { buildOpportunityResearchSnapshot, type OpportunityResearchSelection } from "@/lib/marketScan/opportunityResearch";
import { evaluateMarketDecisionReadiness, marketProceedBlockReason } from "@/lib/marketScan/marketDecisionReadiness";
import { projectFrozenMarketValidity } from "@/lib/marketScan/frozenMarketValidity";
import { resolveValidMarketProductSet, MARKET_SAMPLE_POLICY_VERSION, MARKET_PRODUCT_EXCLUSION_LABELS } from "@/lib/marketScan/marketSamplePolicy";
import { evaluateMarketSampleValidity } from "@/lib/marketScan/marketSampleValidity";
import { factValuesFingerprintOf } from "@/lib/marketScan/metrics";
import { projectMarketSampleDisplayFacts, projectMarketMetricDisplaySummary } from "@/lib/marketScan/marketDisplayProjection";
import { analyzeMarketScopeForConfirmedTopic, summarizeSourceCandidatesOutsideMarketScan } from "@/lib/marketScan/marketScopeAnalysis";
import { buildMarketSampleScope } from "@/lib/marketScan/marketSampleScope";
import { buildScopeConfirmationRows, summarizeScopeConfirmations, type ScopeConfirmationRecord } from "@/lib/marketScan/scopeConfirmation";
import { listSampleScopeRows } from "@/lib/server/marketSampleScopeRepository";
import { approvedResearchSubjects } from "@/lib/marketScan/researchStatistics";
import { resolveMarketScanImageRef } from "@/lib/server/marketScanImage";
import {
  assessCategoryScope,
  buildCategoryEvidenceView,
  readCategoryEvidenceDetail,
  CATEGORY_EVIDENCE_BINDING_PARAM,
} from "@/lib/server/marketCategoryEvidence";
import { isCategoryMarketSubjectKey } from "@/lib/sourceLayer/categoryMarketCapture";
import type { MarketScanImageRefV1, MarketScanSampleItemV1 } from "@/lib/marketScan/types";

import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { createTaskResultJsonMutator } from "@/lib/server/taskResultJsonMutation";
import {
  assertExpectedVersion,
  assertExpectedVersionMatches,
  hashJson,
  parseJsonRecord,
  requireOwnerContext,
  V5CoreError,
  withV5Receipt,
  resourceVersion,
} from "@/lib/server/v5CoreCommon";
import {
  createMarketScan,
  prepareMarketScanSample,
  MarketScanServiceError,
  type CreateMarketScanInput,
} from "@/lib/server/marketScanService";
import type { NicheDefinitionKind } from "@/lib/marketScan/types";
import {
  buildInitialMarketWorkflowMetadata,
  readMarketWorkflowMetadata,
  writeMarketWorkflowMetadata,
  type MarketGateStatus,
  type MarketRepresentative,
  MARKET_GATE_STATUSES,
  REPRESENTATIVE_ROLES,
} from "@/lib/marketWorkflow/metadata";
import { dedupeParentVariations } from "@/lib/marketWorkflow/parentVariation";
import {
  buildV5MarketCandidateEvidenceBinding,
  buildV5MarketCandidateV3Meta,
} from "@/lib/marketScan/candidateContract";

const OWNER = "owner:v1";
const MAX_BULK = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MarketSampleLifecycleAction = "archive" | "restore" | "delete";

function parseSnapshot(value: string) {
  const parsed = parseJsonRecord(value);
  const items = Array.isArray(parsed.items) ? parsed.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  return { ...parsed, items };
}

function parseMarketSampleKey(value: string) {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const scanId = value.slice(0, separator);
  const asin = value.slice(separator + 1).trim().toUpperCase();
  return asin ? { scanId, asin, marketSampleKey: `${scanId}:${asin}` } : null;
}

function sampleResourceVersion(sampleHash: string, marketSampleKey: string, archivedAt: Date | null) {
  return hashJson({ sampleHash, marketSampleKey, archivedAt: archivedAt?.toISOString() ?? null });
}

async function findMarketSample(scanId: string, marketSampleKey: string) {
  const scan = await findScan(scanId);
  const parsed = parseMarketSampleKey(marketSampleKey);
  if (!parsed || parsed.scanId !== scan.id) throw new V5CoreError("SAMPLE_NOT_IN_SCAN", "市场样本不属于指定扫描。", 404);
  const snapshot = parseSnapshot(scan.sampleSnapshotJson);
  const sample = snapshot.items.find((item) => String(item.asin ?? "").toUpperCase() === parsed.asin);
  if (!sample) throw new V5CoreError("SAMPLE_NOT_IN_SCAN", "市场样本不在当前扫描快照中。", 404);
  const lifecycle = await prisma.v5MarketSampleLifecycle.findUnique({
    where: { ownerScope_marketSampleKey: { ownerScope: OWNER, marketSampleKey: parsed.marketSampleKey } },
  });
  return { scan, sample, marketSampleKey: parsed.marketSampleKey, lifecycle };
}

async function sampleDependencySummary(scanId: string, marketSampleKey: string) {
  const candidates = await prisma.opportunityCandidate.findMany({ select: { id: true, sourceMetaJson: true, convertedTaskId: true } });
  const matching = candidates.filter((candidate) => {
    const sourceMeta = parseJsonRecord(candidate.sourceMetaJson);
    const provenance = Array.isArray(sourceMeta.provenance) ? sourceMeta.provenance : [];
    return provenance.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).scanId === scanId
      && (entry as Record<string, unknown>).marketSampleKey === marketSampleKey);
  });
  const candidateIds = matching.map((candidate) => candidate.id);
  const taskIds = matching.map((candidate) => candidate.convertedTaskId).filter((id): id is string => Boolean(id));
  return {
    referenced: candidateIds.length > 0 || taskIds.length > 0,
    candidateIds,
    marketScanIds: [scanId],
    taskIds,
    evidenceRefCount: 0,
    deleteBlockedBy: [
      ...(candidateIds.length ? ["candidate_origin"] : []),
      ...(taskIds.length ? ["task_reference"] : []),
    ],
  };
}

function dependencySummary(scanId: string, snapshot: Record<string, unknown>) {
  const keys = new Set((Array.isArray(snapshot.items) ? snapshot.items : []).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const raw = item as Record<string, unknown>;
    return typeof raw.asin === "string" ? raw.asin : "";
  }).filter(Boolean));
  return {
    referenced: false,
    candidateIds: [],
    marketScanIds: [scanId],
    taskIds: [],
    evidenceRefCount: keys.size,
    deleteBlockedBy: ["market_sample"],
  };
}

function decisionReadinessOf(scan: { sampleSnapshotJson: string; metricsJson: string; marketplace: string; sampleDefinitionJson?: string }) {
  const snapshot = parseSnapshot(scan.sampleSnapshotJson);
  const approved = approvedResearchSubjects(parseJsonRecord(scan.sampleDefinitionJson ?? "{}"));
  if (approved) snapshot.items = snapshot.items.filter((item) => approved.has(String(item.subjectKey)));
  const validSet = projectFrozenMarketValidity(snapshot.items, scan.marketplace);
  return evaluateMarketDecisionReadiness({ ...parseJsonRecord(scan.metricsJson), sampleCount: snapshot.items.length, validSampleCount: validSet.validCount, limitedEvidenceSampleCount: validSet.validItemIds.filter((id) => snapshot.items[Number(id)]?.evidenceStatus === "limited_evidence").length });
}

function assertProceedReadiness(scan: Parameters<typeof decisionReadinessOf>[0], acknowledged: boolean) {
  const readiness = decisionReadinessOf(scan);
  const block = marketProceedBlockReason(readiness, { missingDataAcknowledged: acknowledged });
  if (block) throw new V5CoreError(block === "INSUFFICIENT_SAMPLE" ? "MARKET_SAMPLE_INSUFFICIENT" : block === "MISSING_ACK_REQUIRED" ? "MARKET_MISSING_DATA_ACK_REQUIRED" : "MARKET_DECISION_NOT_READY",
    block === "INSUFFICIENT_SAMPLE" ? `当前只有 ${readiness.validSampleCount} 个有效商品，至少需要 ${readiness.requiredValidSampleCount} 个；请补充 ${readiness.requiredValidSampleCount - readiness.validSampleCount} 个有效商品。`
      : block === "MISSING_ACK_REQUIRED" ? "请确认销量或品牌集中度缺失，并填写人工判断理由后继续。" : "价格数据或证据时间窗口尚未就绪，请先补充来源证据。", 409, false, true, { decisionReadiness: readiness });
  return readiness;
}

function scanView(scan: {
  id: string; scanName: string; marketplace: string; nicheKind: string; nicheDefinitionJson: string;
  sampleDefinitionJson: string; sampleSnapshotJson: string; metricsJson: string; sampleCount: number;
  metricsVersion: string; sampleHash: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
}) {
  const snapshot = parseSnapshot(scan.sampleSnapshotJson);
  const nicheDefinition = parseJsonRecord(scan.nicheDefinitionJson);
  const marketScopeAnalysis = analyzeMarketScopeForConfirmedTopic(nicheDefinition, snapshot.items as unknown as MarketScanSampleItemV1[], scan.sampleHash);
  const sampleDefinition = parseJsonRecord(scan.sampleDefinitionJson);
  const workflow = readMarketWorkflowMetadata(sampleDefinition, {
    scanId: scan.id,
    sampleHash: scan.sampleHash,
    metricsHash: hashJson(parseJsonRecord(scan.metricsJson)),
    metricsVersion: scan.metricsVersion,
  });
  const decisionReadiness = decisionReadinessOf(scan);
  const proceedBlock = marketProceedBlockReason(decisionReadiness, { missingDataAcknowledged: workflow.metadata.marketGate.missingDataAcknowledged });
  const safeWorkflow = workflow.effectiveGateStatus === "PROCEED" && proceedBlock
    ? { ...workflow, effectiveGateStatus: "PENDING" as const, stale: true, staleReason: proceedBlock }
    : workflow;
  const projectedSampleItems = snapshot.items.map((item, index) => ({
    ...item,
    asin: String(item.asin ?? ""),
    ...projectMarketSampleDisplayFacts(item.factValues),
    marketScope: marketScopeAnalysis?.items[index],
  }));
  // 样本范围投影：区分「技术有效」与「符合研究范围」，只读，不参与任何门禁判定。
  const sampleScope = buildMarketSampleScope({
    nicheDefinition,
    items: projectedSampleItems.map((item) => ({ asin: item.asin, title: item.title ?? null })),
    technicallyValidCount: decisionReadiness.validSampleCount,
    marketScopeAnalysis,
  });
  return {
    id: scan.id,
    scanName: scan.scanName,
    marketplace: scan.marketplace,
    nicheKind: scan.nicheKind,
    nicheDefinition,
    sampleDefinition,
    sampleSnapshot: snapshot,
    sampleItems: projectedSampleItems,
    ...(marketScopeAnalysis ? { marketScopeAnalysis } : {}),
    sampleScope,
    metrics: parseJsonRecord(scan.metricsJson),
    ...projectMarketMetricDisplaySummary(parseJsonRecord(scan.metricsJson)),
    sampleCount: scan.sampleCount,
    metricsVersion: scan.metricsVersion,
    sampleHash: scan.sampleHash,
    archivedAt: scan.archivedAt?.toISOString() ?? null,
    resourceVersion: resourceVersion(scan.updatedAt),
    createdAt: scan.createdAt.toISOString(),
    updatedAt: scan.updatedAt.toISOString(),
    decisionReadiness,
    sampleSufficiency: { status: decisionReadiness.sampleSufficiency, rawSampleCount: decisionReadiness.rawSampleCount, validSampleCount: decisionReadiness.validSampleCount, minimumValidSampleCount: decisionReadiness.requiredValidSampleCount },
    sampleValidityPolicyVersion: MARKET_SAMPLE_POLICY_VERSION,
    marketWorkflow: safeWorkflow,
    marketGate: {
      ...safeWorkflow.metadata.marketGate,
      effectiveStatus: safeWorkflow.effectiveGateStatus,
      stale: safeWorkflow.stale,
      staleReason: safeWorkflow.staleReason,
    },
    representatives: workflow.metadata.representatives,
    parentVariationDedup: workflow.metadata.parentVariationDedup,
    scopeNotice: "统计结果基于当前 MarketScan 锁定的商品样本，不代表 Amazon 整体市场。",
  };
}

async function scanViewWithLifecycle(scan: Parameters<typeof scanView>[0]) {
  const view = scanView(scan);
  const states = await prisma.v5MarketSampleLifecycle.findMany({ where: { ownerScope: OWNER, scanId: scan.id } });
  const stateByKey = new Map(states.map((state) => [state.marketSampleKey, state]));
  const sampleItems = await Promise.all(view.sampleItems.map(async (item, index) => {
    const marketSampleKey = `${scan.id}:${String(item.asin).toUpperCase()}`;
    const lifecycle = stateByKey.get(marketSampleKey);
    const resourceVersion = sampleResourceVersion(scan.sampleHash, marketSampleKey, lifecycle?.archivedAt ?? null);
    return {
      ...item,
      imageUrl: await resolveMarketScanImageRef(view.sampleSnapshot.items[index].imageRef as MarketScanImageRefV1 | undefined),
      marketSampleKey,
      archivedAt: lifecycle?.archivedAt?.toISOString() ?? null,
      visible: !lifecycle?.archivedAt,
      resourceVersion,
      version: resourceVersion,
    };
  }));
  // P3 人工范围确认（只读投影）：与 archivedAt 分离，不参与门禁判定
  const nicheHash = hashJson({ nicheDefinition: scan.nicheDefinitionJson });
  const scopePersisted = await listSampleScopeRows(scan.id);
  const confirmations: ScopeConfirmationRecord[] = scopePersisted.flatMap((row) => {
    const status = row.scopeStatus;
    if (status !== "IN_SCOPE" && status !== "OUT_OF_SCOPE" && status !== "REVOKED") return [];
    return [{
      marketSampleKey: row.marketSampleKey,
      status,
      reason: row.scopeReason,
      sampleHash: row.scopeSampleHash,
      nicheHash: row.scopeNicheHash,
      confirmedAt: row.scopeConfirmedAtMs === null ? null : new Date(row.scopeConfirmedAtMs).toISOString(),
      confirmedBy: row.scopeConfirmedBy,
      scopeRevision: row.scopeRevision,
    }];
  });
  const scopeRows = buildScopeConfirmationRows({
    scanId: scan.id,
    sampleHash: scan.sampleHash,
    nicheHash,
    samples: sampleItems.map((item) => ({
      asin: item.asin,
      subjectKey: String((item as { subjectKey?: unknown }).subjectKey ?? `amazon:${scan.marketplace}:${String(item.asin).toUpperCase()}`),
      title: item.title ?? null,
      currentVersion: item.resourceVersion,
    })),
    confirmations,
  });
  const scopeByKey = new Map(scopeRows.map((row) => [row.marketSampleKey, row]));
  const sampleItemsWithScope = sampleItems.map((item) => ({
    ...item,
    scopeReview: scopeByKey.get(item.marketSampleKey) ?? null,
  }));
  const sourceBatchCoverage = await sourceBatchCoverageForScan(view);
  return {
    ...view,
    sampleItems: sampleItemsWithScope,
    scopeReviewSummary: summarizeScopeConfirmations(scopeRows),
    sourceBatchCoverage,
  };
}

async function sourceBatchCoverageForScan(view: ReturnType<typeof scanView>) {
  const sourceBatchId = view.sampleDefinition.productBatchId;
  if (typeof sourceBatchId !== "string" || sourceBatchId.trim() === "") return null;
  const batch = await prisma.productBatch.findFirst({
    where: { id: sourceBatchId, ownerSubject: OWNER },
    select: { id: true },
  });
  if (!batch) return null;
  const candidates = await prisma.productBatchItem.findMany({
    where: { batchId: batch.id },
    select: { asin: true, promotionEligible: true, evidenceStatus: true, normalizedProductJson: true },
  });
  return summarizeSourceCandidatesOutsideMarketScan({
    sourceBatchId: batch.id,
    sampleHash: view.sampleHash,
    lockedSampleAsins: view.sampleItems.map((item) => item.asin),
    candidates: candidates.map((candidate) => {
      const normalized = parseJsonRecord(candidate.normalizedProductJson);
      const comparisonFacts = isRecord(normalized.comparisonFacts) ? normalized.comparisonFacts : {};
      const rating = isRecord(comparisonFacts.rating) ? comparisonFacts.rating : {};
      const reviewCount = isRecord(comparisonFacts.reviewCount) ? comparisonFacts.reviewCount : {};
      return {
        asin: candidate.asin ?? "",
        title: typeof normalized.title === "string" ? normalized.title : null,
        promotionEligible: candidate.promotionEligible,
        evidenceStatus: candidate.evidenceStatus,
        ratingStatus: typeof rating.status === "string" ? rating.status : null,
        reviewCountStatus: typeof reviewCount.status === "string" ? reviewCount.status : null,
        launchedDateStatus: isRecord(comparisonFacts.launchedDate) && typeof comparisonFacts.launchedDate.status === "string" ? comparisonFacts.launchedDate.status : "missing",
        evidenceId: typeof normalized.evidenceId === "string" ? normalized.evidenceId : null,
        evidenceVersion: typeof normalized.evidenceVersion === "number" ? normalized.evidenceVersion : null,
        capturedAt: typeof normalized.capturedAt === "string" ? normalized.capturedAt : null,
        contentHash: typeof normalized.contentHash === "string" ? normalized.contentHash : null,
      };
    }),
  });
}

async function findScan(scanId: string) {
  const scan = await prisma.marketScan.findUnique({ where: { id: scanId } });
  if (!scan || scan.ownerScope !== OWNER) throw new V5CoreError("MARKET_ANALYSIS_NOT_FOUND", "市场分析不存在。", 404);
  return scan;
}

function workflowProjection(scan: Awaited<ReturnType<typeof findScan>>) {
  return readMarketWorkflowMetadata(parseJsonRecord(scan.sampleDefinitionJson), {
    scanId: scan.id,
    sampleHash: scan.sampleHash,
    metricsHash: hashJson(parseJsonRecord(scan.metricsJson)),
    metricsVersion: scan.metricsVersion,
  });
}

function normalizeWorkflowReason(value: unknown, status: MarketGateStatus): string | null {
  if (value === null || value === undefined) {
    if (status === "PENDING") return null;
    throw new V5CoreError("MARKET_GATE_REASON_REQUIRED", "Market Gate 需要记录人工理由。", 422);
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 2_000) {
    throw new V5CoreError("MARKET_GATE_REASON_INVALID", "Market Gate 理由必须是 1～2000 字符。", 422);
  }
  return value.trim();
}

function assertCurrentMarketWorkflow(scan: Awaited<ReturnType<typeof findScan>>, expectedScanHash: string, reconfirmSupplementary = false) {
  if (scan.sampleHash !== expectedScanHash) {
    throw new V5CoreError("MARKET_SNAPSHOT_STALE", "市场分析快照已变化，请刷新后重新确认。", 409, false, true);
  }
  const definition = parseJsonRecord(scan.sampleDefinitionJson);
  const supplementary = isRecord(definition.marketIntelligence) ? definition.marketIntelligence : {};
  const projection = workflowProjection(reconfirmSupplementary ? { ...scan, sampleDefinitionJson: JSON.stringify({ ...definition, marketIntelligence: { ...supplementary, needsHumanReview: false } }) } : scan);
  if (projection.stale) {
    throw new V5CoreError("MARKET_WORKFLOW_STALE", "市场闸门绑定已过期，请刷新后重新确认当前市场快照。", 409, false, true, { staleReason: projection.staleReason });
  }
  return projection;
}

async function updateMarketWorkflow(scan: Awaited<ReturnType<typeof findScan>>, metadata: Parameters<typeof writeMarketWorkflowMetadata>[1], reconfirmSupplementary = false) {
  const definition = parseJsonRecord(scan.sampleDefinitionJson);
  const supplementary = isRecord(definition.marketIntelligence) ? definition.marketIntelligence : null;
  const sourceJson = reconfirmSupplementary && supplementary ? JSON.stringify({ ...definition, marketIntelligence: { ...supplementary, needsHumanReview: false } }) : scan.sampleDefinitionJson;
  const result = await prisma.marketScan.updateMany({ where: { id: scan.id, updatedAt: scan.updatedAt, archivedAt: null }, data: { sampleDefinitionJson: writeMarketWorkflowMetadata(sourceJson, metadata), updatedAt: new Date(Math.max(Date.now(), scan.updatedAt.getTime() + 1)) } });
  if (result.count !== 1) throw new V5CoreError("CAS_CONFLICT", "市场判断已被其它操作更新，请刷新后重试。", 409, false, true);
  return findScan(scan.id);
}

export async function saveMarketGate(input: {
  context: AccessContext;
  scanId: string;
  status: MarketGateStatus;
  reason?: string | null;
  missingDataAcknowledged?: boolean;
  expectedScanHash: string;
  expectedVersion: unknown;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (!MARKET_GATE_STATUSES.includes(input.status)) throw new V5CoreError("MARKET_GATE_STATUS_INVALID", "Market Gate 状态无效。", 400);
  if (input.status === "PENDING") throw new V5CoreError("MARKET_GATE_PENDING_FORBIDDEN", "PENDING 是系统状态，请选择通过、补充验证、暂缓或放弃。", 422);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const reason = normalizeWorkflowReason(input.reason, input.status);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "market-analysis:gate",
    resourceKey: input.scanId,
    idempotencyKey: input.idempotencyKey,
    requestBody: { status: input.status, reason, missingDataAcknowledged: input.missingDataAcknowledged === true, expectedScanHash: input.expectedScanHash, expectedVersion },
    execute: async () => {
      const scan = await findScan(input.scanId);
      assertExpectedVersionMatches(expectedVersion, scan.updatedAt);
      const projection = assertCurrentMarketWorkflow(scan, input.expectedScanHash, true);
      const readiness = input.status === "PROCEED" ? assertProceedReadiness(scan, input.missingDataAcknowledged === true) : decisionReadinessOf(scan);
      const now = new Date().toISOString();
      const nextMetadata = {
        ...projection.metadata,
        revision: projection.metadata.revision + 1,
        marketGate: {
          ...projection.metadata.marketGate,
          status: input.status,
          reason,
          chosenAt: now,
          chosenBy: OWNER,
          missingDataAcknowledged: input.status === "PROCEED" && input.missingDataAcknowledged === true,
          missingDataCodes: input.status === "PROCEED" ? readiness.acknowledgeableMissing.map((x) => x.code) : [],
        },
        representatives: projection.metadata.representatives,
      };
      const updated = await updateMarketWorkflow(scan, nextMetadata, true);
      return scanViewWithLifecycle(updated);
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function saveMarketRepresentatives(input: {
  context: AccessContext;
  scanId: string;
  expectedScanHash: string;
  expectedVersion: unknown;
  items: Array<{ marketSampleKey: string; asin: string; subjectKey: string; role: string; note?: string | null; researchRecommendation?: unknown }>;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (!input.items.length || input.items.length > 50) throw new V5CoreError("REPRESENTATIVE_SELECTION_INVALID", "代表商品至少选择 1 款，最多保存 50 款。", 422);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "market-analysis:representatives",
    resourceKey: input.scanId,
    idempotencyKey: input.idempotencyKey,
    requestBody: { expectedScanHash: input.expectedScanHash, expectedVersion, items: input.items },
    execute: async () => {
      const scan = await findScan(input.scanId);
      assertExpectedVersionMatches(expectedVersion, scan.updatedAt);
      const projection = assertCurrentMarketWorkflow(scan, input.expectedScanHash);
      if (decisionReadinessOf(scan).sampleSufficiency === "INSUFFICIENT_SAMPLE") assertProceedReadiness(scan, false);
      if (projection.effectiveGateStatus !== "PROCEED") throw new V5CoreError("MARKET_GATE_REQUIRED", "请先由人工将 Market Gate 设为 PROCEED。", 409, false, true);
      assertProceedReadiness(scan, projection.metadata.marketGate.missingDataAcknowledged);
      const snapshot = parseSnapshot(scan.sampleSnapshotJson);
      const byKey = new Map(snapshot.items.map((item) => [`${scan.id}:${String(item.asin).toUpperCase()}`, item]));
      const archived = new Set((await prisma.v5MarketSampleLifecycle.findMany({ where: { ownerScope: OWNER, scanId: scan.id, archivedAt: { not: null } }, select: { marketSampleKey: true } })).map((item) => item.marketSampleKey));
      const seen = new Set<string>();
      const approved = approvedResearchSubjects(parseJsonRecord(scan.sampleDefinitionJson));
      const now = new Date().toISOString();
      const representatives: MarketRepresentative[] = [];
      const intelligence = input.items.some((item) => item.researchRecommendation !== undefined)
        ? await (await import("@/lib/server/marketIntelligenceService")).getMarketIntelligence({ context: input.context, scanId: input.scanId }) : null;
      for (const item of input.items) {
        if (typeof item.note !== "string" || !item.note.trim() || item.note.trim().length > 1000) throw new V5CoreError("REPRESENTATIVE_REASON_REQUIRED", "每款代表商品必须填写 1～1000 字符的选择理由。", 422);
        if (!REPRESENTATIVE_ROLES.includes(item.role as (typeof REPRESENTATIVE_ROLES)[number])) throw new V5CoreError("REPRESENTATIVE_ROLE_INVALID", "代表商品角色无效。", 422);
        const key = item.marketSampleKey.trim();
        const sample = byKey.get(key);
        if (!sample || archived.has(key) || (approved && !approved.has(String(sample.subjectKey))) || String(sample.asin).toUpperCase() !== item.asin.trim().toUpperCase() || sample.subjectKey !== item.subjectKey.trim()) {
          throw new V5CoreError("SAMPLE_NOT_IN_SCAN", "代表商品必须属于当前未归档的 MarketScan 快照。", 422);
        }
        if (seen.has(key)) throw new V5CoreError("REPRESENTATIVE_DUPLICATE", "代表商品不能重复选择同一个市场样本。", 422);
        seen.add(key);
        let researchContext: MarketRepresentative["researchContext"];
        if (item.researchRecommendation !== undefined) {
          const selection = item.researchRecommendation;
          if (!isRecord(selection) || typeof selection.reportId !== "string" || typeof selection.inputHash !== "string"
            || !Array.isArray(selection.opportunityIds) || !selection.opportunityIds.every((id) => typeof id === "string")) throw new V5CoreError("MARKET_RECOMMENDATION_INVALID", "推荐选择信息不完整，请重新核对。", 422);
          const report = intelligence?.reports.find((entry) => entry.id === selection.reportId);
          if (!report || !intelligence?.statistics?.subjects.includes(item.subjectKey)) throw new V5CoreError("MARKET_RECOMMENDATION_STALE", "推荐或正式样本已变化，请刷新并重新核对。", 409);
          try { researchContext = buildOpportunityResearchSnapshot(report, item.subjectKey, selection as OpportunityResearchSelection, intelligence.inputHash); }
          catch (error) { throw new V5CoreError(error instanceof Error ? error.message : "MARKET_RECOMMENDATION_INVALID", "推荐依据已变化或不完整，请刷新报告并重新核对；未保存选择。", 409); }
        } else {
          // Editing a reason or saving other representatives must not discard a previously adopted brief.
          researchContext = projection.metadata.representatives.items.find((entry) => entry.marketSampleKey === key)?.researchContext;
        }
        representatives.push({
          marketSampleKey: key,
          asin: String(sample.asin).toUpperCase(),
          subjectKey: sample.subjectKey,
          role: item.role as MarketRepresentative["role"],
          note: item.note.trim(),
          selectedAt: now,
          selectedBy: OWNER,
          ...(researchContext ? { researchContext } : {}),
        });
      }
      const nextMetadata = {
        ...projection.metadata,
        revision: projection.metadata.revision + 1,
        representatives: {
          ...projection.metadata.representatives,
          selectedAt: now,
          selectedBy: OWNER,
          items: representatives,
        },
      };
      const updated = await updateMarketWorkflow(scan, nextMetadata);
      return scanViewWithLifecycle(updated);
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function listMarketAnalyses(input: { context: AccessContext; include?: string; marketplace?: string; limit?: number }) {
  requireOwnerContext(input.context);
  const include = input.include ?? "active";
  if (!["active", "archived", "all"].includes(include)) throw new V5CoreError("INVALID_FILTER", "include 参数无效。", 400);
  const where = {
    ownerScope: OWNER,
    ...(include === "active" ? { archivedAt: null } : include === "archived" ? { archivedAt: { not: null } } : {}),
    ...(input.marketplace ? { marketplace: input.marketplace.toUpperCase() } : {}),
  };
  const scans = await prisma.marketScan.findMany({ where, orderBy: { updatedAt: "desc" }, take: Math.min(input.limit ?? 50, 100) });
  return { items: await Promise.all(scans.map((scan) => scanViewWithLifecycle(scan))), nextCursor: null };
}

export async function getMarketAnalysis(input: { context: AccessContext; scanId: string; include?: string }) {
  requireOwnerContext(input.context);
  const scan = await findScan(input.scanId);
  if (scan.archivedAt && input.include !== "archived" && input.include !== "all") {
    throw new V5CoreError("MARKET_ANALYSIS_NOT_FOUND", "市场分析已归档，请显式请求归档视图。", 404);
  }
  const view = await scanViewWithLifecycle(scan);
  return { ...view, handoffEligible: scan.archivedAt === null && view.sampleItems.length > 0, dependencySummary: dependencySummary(scan.id, view.sampleSnapshot) };
}

/**
 * 读取来源批次的商品事实（类目 + 标题），用于评估类目证据与本研究范围关系。
 *
 * 只读；没有批次、类目或标题时保持为空，不猜测、不推断。
 */
async function readSampleScopeFacts(scan: { sampleDefinitionJson: string }): Promise<{
  categories: Array<string | null>;
  titles: Array<string | null>;
  categoryPaths: Array<string | null>;
}> {
  const productBatchId = parseJsonRecord(scan.sampleDefinitionJson).productBatchId;
  if (typeof productBatchId !== "string" || productBatchId.trim() === "") return { categories: [], titles: [], categoryPaths: [] };
  const items = await prisma.productBatchItem.findMany({
    where: { batchId: productBatchId, archivedAt: null },
    orderBy: { ordinal: "asc" },
    select: { normalizedProductJson: true },
  });
  const categories: Array<string | null> = [];
  const titles: Array<string | null> = [];
  const categoryPaths: Array<string | null> = [];
  for (const item of items) {
    const normalized = parseJsonRecord(item.normalizedProductJson);
    const category = typeof normalized.category === "string" && normalized.category.trim() !== "" ? normalized.category.trim() : null;
    categories.push(category);
    // 只有带 ":" 的才是结构化类目路径；单段一级类目不构造成细分证据。
    categoryPaths.push(category !== null && category.includes(":") ? category : null);
    const title = typeof normalized.title === "string" ? normalized.title.trim()
      : typeof normalized.productTitle === "string" ? normalized.productTitle.trim()
        : null;
    titles.push(title && title !== "" ? title : null);
  }
  return { categories, titles, categoryPaths };
}

/**
 * 读取 02 市场研究的类目市场证据视图（只读）。
 *
 * 类目指标是 SellerSprite 第三方估算，独立于 MarketScan 的样本指标；
 * 未显式绑定时只返回可绑定列表，不做任何自动关联。
 */
export async function getMarketCategoryEvidence(input: { context: AccessContext; scanId: string }) {
  requireOwnerContext(input.context);
  const scan = await findScan(input.scanId);
  const facts = await readSampleScopeFacts(scan);
  const view = await buildCategoryEvidenceView({
    nicheDefinition: parseJsonRecord(scan.nicheDefinitionJson),
    marketplace: scan.marketplace,
    sampleCategories: facts.categories,
    sampleTitles: facts.titles,
    sampleCategoryPaths: facts.categoryPaths,
  });
  return {
    scanId: scan.id,
    marketplace: scan.marketplace,
    resourceVersion: resourceVersion(scan.updatedAt),
    ...view,
  };
}

/**
 * 显式绑定 / 解绑类目市场证据。
 *
 * - `subjectKey: null` 表示解绑；
 * - 绑定前必须证明该主体在本 EvidenceStore 中真实可读且站点匹配（fail-closed）；
 * - 若来源批次商品类目与所选类目没有交集（或无法证明相关），必须由用户显式确认范围差异；
 * - 只改写 `nicheDefinitionJson.parameters`，不触碰样本快照、sampleHash 与 metrics。
 */
export async function saveMarketCategoryEvidenceBinding(input: {
  context: AccessContext;
  scanId: string;
  subjectKey: string | null;
  acknowledgeScopeWarning?: boolean;
  expectedVersion: unknown;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (input.subjectKey !== null && !isCategoryMarketSubjectKey(input.subjectKey)) {
    throw new V5CoreError("MARKET_CATEGORY_EVIDENCE_INVALID", "类目市场证据主体不合法。", 400);
  }
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "market-analysis:category-evidence-binding",
    resourceKey: input.scanId,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      subjectKey: input.subjectKey,
      acknowledgeScopeWarning: input.acknowledgeScopeWarning === true,
      expectedVersion,
    },
    execute: async () => {
      const scan = await findScan(input.scanId);
      assertExpectedVersionMatches(expectedVersion, scan.updatedAt);
      if (input.subjectKey !== null) {
        const detail = await readCategoryEvidenceDetail(input.subjectKey, { marketplace: scan.marketplace });
        if (!detail) {
          throw new V5CoreError("MARKET_CATEGORY_EVIDENCE_INVALID", "所选类目市场证据不存在、站点不匹配或已损坏，未建立绑定。", 422);
        }
        const scopeFacts = await readSampleScopeFacts(scan);
        const assessment = assessCategoryScope({
          categoryLabel: detail.label,
          sampleCategories: scopeFacts.categories,
          sampleTitles: scopeFacts.titles,
          sampleCategoryPaths: scopeFacts.categoryPaths,
        });
        // 只有「细分范围匹配」才允许直接绑定；其余三种都要人工确认范围差异。
        if (assessment.level !== "range_matched" && input.acknowledgeScopeWarning !== true) {
          throw new V5CoreError(
            "MARKET_CATEGORY_EVIDENCE_SCOPE_UNCONFIRMED",
            `${assessment.reason} 若仍要绑定，请确认「已知范围差异，仍作为参考观察」。`,
            422,
          );
        }
      }
      const nicheDefinition = parseJsonRecord(scan.nicheDefinitionJson);
      const parameters = isRecord(nicheDefinition.parameters) ? { ...nicheDefinition.parameters } : {};
      if (input.subjectKey === null) delete parameters[CATEGORY_EVIDENCE_BINDING_PARAM];
      else parameters[CATEGORY_EVIDENCE_BINDING_PARAM] = input.subjectKey;
      const updated = await prisma.marketScan.update({
        where: { id: scan.id },
        data: { nicheDefinitionJson: JSON.stringify({ ...nicheDefinition, parameters }) },
      });
      return scanViewWithLifecycle(updated);
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function createMarketAnalysis(input: {
  context: AccessContext; scanName: string; marketplace: string; niche: Record<string, unknown>;
  source: Record<string, unknown>; idempotencyKey: string; expectedBatchVersion?: unknown;
}) {
  requireOwnerContext(input.context);
  const productBatchId = typeof input.source.productBatchId === "string" ? input.source.productBatchId : "";
  if (!productBatchId) throw new V5CoreError("MARKET_ANALYSIS_INPUT_INVALID", "缺少 source.productBatchId。", 400);
  const batch = await prisma.productBatch.findFirst({ where: { id: productBatchId, ownerSubject: OWNER } });
  if (!batch || batch.batchStatus !== "ready" || batch.archivedAt !== null) throw new V5CoreError("SOURCE_NOT_READY", "来源批次尚未 ready 或已归档。", 422);
  if (input.expectedBatchVersion !== undefined) assertExpectedVersionMatches(assertExpectedVersion(input.expectedBatchVersion), batch.updatedAt);
  const rawItemIds = Array.isArray(input.source.itemIds) ? input.source.itemIds : null;
  if (rawItemIds && (rawItemIds.length === 0 || rawItemIds.some((id) => typeof id !== "string")
    || new Set(rawItemIds).size !== rawItemIds.length)) {
    throw new V5CoreError("SOURCE_ITEM_SELECTION_INVALID", "请选择当前批次中的有效商品条目。", 422);
  }
  const items = await prisma.productBatchItem.findMany({ where: { batchId: batch.id, archivedAt: null, ...(rawItemIds ? { id: { in: rawItemIds.filter((id): id is string => typeof id === "string") } } : {}) }, orderBy: { ordinal: "asc" } });
  if (rawItemIds && items.length !== rawItemIds.length) {
    throw new V5CoreError("SOURCE_ITEMS_BATCH_MISMATCH", "所选商品包含其它批次、已归档或不存在的条目，请按批次分别生成市场分析。", 422);
  }
  if (!items.length) throw new V5CoreError("SOURCE_NO_ELIGIBLE_SAMPLE", "来源批次没有可用于市场分析的样本。", 422);
  const validSet = resolveValidMarketProductSet({ items, batchMarketplace: batch.marketplace });
  const validIds = new Set(validSet.validItemIds);
  const eligibleItems = items.filter((item) => validIds.has(item.id));
  const dedupe = dedupeParentVariations(eligibleItems.map((item) => ({
    id: item.id,
    productKey: item.productKey,
    ordinal: item.ordinal,
    asin: item.asin,
    parentAsin: item.parentAsin,
    familyProjectionJson: item.familyProjectionJson,
    rankingJson: item.rankingJson,
  })));
  const selectedItemIds = new Set(dedupe.selectedItemIds);
  const selectedItems = eligibleItems.filter((item) => selectedItemIds.has(item.id));
  if (!selectedItems.length) throw new V5CoreError("SOURCE_NO_ELIGIBLE_SAMPLE", "来源批次经确定性父子变体处理后没有可用于市场分析的样本。", 422);
  const resourceKey = `${productBatchId}:${hashJson({ scanName: input.scanName, marketplace: input.marketplace, niche: input.niche, itemIds: selectedItems.map((item) => item.id) })}`;
  const result = await withV5Receipt({
    context: input.context, operation: "market-analysis:create", resourceKey, idempotencyKey: input.idempotencyKey,
        requestBody: { scanName: input.scanName, marketplace: input.marketplace, niche: input.niche, source: { productBatchId, itemIds: selectedItems.map((item) => item.id) }, expectedBatchVersion: input.expectedBatchVersion ?? null },
    execute: async () => {
      const nicheKind = typeof input.niche.kind === "string" ? input.niche.kind : "keyword";
      const created = await createMarketScan({
        context: input.context,
        scanName: input.scanName.trim(), marketplace: input.marketplace.trim().toUpperCase() || "US",
        nicheKind: nicheKind as NicheDefinitionKind,
        nicheLabel: typeof input.niche.label === "string" && input.niche.label.trim() ? input.niche.label : input.scanName,
        nicheNotes: typeof input.niche.notes === "string" ? input.niche.notes : null,
        nicheParameters: typeof input.niche.parameters === "object" && input.niche.parameters !== null && !Array.isArray(input.niche.parameters) ? input.niche.parameters as Record<string, string | number | boolean | null> : null,
        productBatchId,
        subjectKeys: selectedItems.map((item) => item.productKey),
        requestedLimit: selectedItems.length,
        observedAt: batch.importedAt?.toISOString() ?? null,
        insufficientSampleReason: typeof input.source.insufficientSampleReason === "string" ? input.source.insufficientSampleReason : null,
      } satisfies CreateMarketScanInput).catch((error: unknown) => {
        if (error instanceof MarketScanServiceError) {
          throw new V5CoreError(error.code.toUpperCase(), error.message, error.httpStatus);
        }
        throw error;
      });
        const persisted = await prisma.marketScan.findUniqueOrThrow({ where: { id: created.id } });
        const initialWorkflow = buildInitialMarketWorkflowMetadata({
          scanId: persisted.id,
          sampleHash: persisted.sampleHash,
          metricsHash: hashJson(parseJsonRecord(persisted.metricsJson)),
          metricsVersion: persisted.metricsVersion,
          parentVariationDedup: dedupe,
        });
        const withWorkflow = await prisma.marketScan.update({
          where: { id: persisted.id },
          data: { sampleDefinitionJson: writeMarketWorkflowMetadata(persisted.sampleDefinitionJson, initialWorkflow) },
        });
        return scanViewWithLifecycle(withWorkflow);
      },
  });
  return { ...result.value, replayed: result.replayed };
}

// ---------------------------------------------------------------------------
// D0-004：创建市场研究前的权威样本预检（只读，不写 receipt、不创建 MarketScan）
// ---------------------------------------------------------------------------

export type MarketAnalysisSamplePreviewItem = {
  readonly id: string;
  readonly asin: string | null;
  readonly reason: string;
  readonly label: string;
};

export type MarketAnalysisSamplePreviewStage = {
  readonly stage: "status" | "variant" | "evidence" | "deterministic";
  readonly label: string;
  readonly droppedCount: number;
  readonly items: readonly MarketAnalysisSamplePreviewItem[];
};

export type MarketAnalysisSamplePreview = {
  readonly productBatchId: string;
  readonly batchName: string;
  readonly marketplace: string;
  /** 来源批次原始商品数（对账口径）。 */
  readonly sourceItemCount: number;
  /** 初步有效数：来源页当前显示的状态口径（有效证据状态 + 确定性折叠）。 */
  readonly preliminaryValidCount: number;
  /** 最终可冻结的市场样本数：与实际创建时 metrics.validSampleCount 完全同源（权威口径）。 */
  readonly finalFreezableCount: number;
  readonly minimumRequired: number;
  readonly sufficient: boolean;
  readonly parentVariationNotice: string;
  readonly stages: readonly MarketAnalysisSamplePreviewStage[];
};

const EVIDENCE_STAGE_LABELS: Readonly<Record<string, string>> = {
  EVIDENCE_PROJECTION_MISSING: "证据投影缺失或版本/哈希不匹配，无法按锁定版本组成样本",
  NO_USABLE_ASIN: "证据缺少可用 ASIN，无法进入市场样本",
};

const DETERMINISTIC_STAGE_LABELS: Readonly<Record<string, string>> = {
  INVALID_ASIN: "样本 ASIN 不合法",
  SUBJECT_MISMATCH: "样本主体与商品事实不一致",
  MARKETPLACE_MISMATCH: "样本不属于当前站点",
  REQUIRED_FACT_MISSING: "缺少必填事实（如标题）",
  EVIDENCE_BINDING_INVALID: "证据绑定不完整或已失效",
  EVIDENCE_BLOCKED: "证据被阻断 / 否决",
};

const PREVIEW_STAGE_ITEM_LIMIT = 30;

/** 与 frozenMarketValidity 同源的完整性判定，用于给出细粒度排除原因。 */
function previewIntegrityValid(item: MarketScanSampleItemV1): boolean {
  try {
    const policyVersion = (item as { sampleValidityPolicyVersion?: unknown }).sampleValidityPolicyVersion;
    return item.factValuesFingerprint === factValuesFingerprintOf({ subjectKey: item.subjectKey, factValues: item.factValues })
      && (policyVersion === undefined || policyVersion === MARKET_SAMPLE_POLICY_VERSION);
  } catch {
    return false;
  }
}

/**
 * 创建前样本预检：完整镜像 createMarketAnalysis → createMarketScan 的样本口径
 * （状态有效集合 → 确定性父子变体折叠 → 证据投影 → 冻结确定性有效性），
 * 但只读不写。返回「来源数 / 初步有效 / 最终可冻结 / 逐阶段排除原因」，
 * 前端在创建确认框中消费，避免出现「页面显示 30、提交被 409 判 29」的口径分叉（D0-004）。
 */
export async function previewMarketAnalysisSample(input: {
  readonly context: AccessContext;
  readonly productBatchId: string;
  readonly marketplace: string;
}): Promise<MarketAnalysisSamplePreview> {
  requireOwnerContext(input.context);
  const marketplace = (input.marketplace || "").trim().toUpperCase() || "US";
  const batch = await prisma.productBatch.findFirst({ where: { id: input.productBatchId, ownerSubject: OWNER } });
  if (!batch || batch.batchStatus !== "ready" || batch.archivedAt !== null) {
    throw new V5CoreError("SOURCE_NOT_READY", "来源批次尚未 ready 或已归档。", 422);
  }
  if (batch.marketplace.trim().toUpperCase() !== marketplace) {
    throw new V5CoreError("MARKET_ANALYSIS_INPUT_INVALID", "ProductBatch 的 marketplace 与请求 marketplace 不一致。", 422);
  }

  // ① 状态口径（与来源页 validSampleCount 同一 resolver，含归档排除说明）
  const allItems = await prisma.productBatchItem.findMany({ where: { batchId: batch.id }, orderBy: { ordinal: "asc" } });
  const statusSet = resolveValidMarketProductSet({ items: allItems, batchMarketplace: batch.marketplace, declaredItemCount: batch.itemCount ?? null });
  const validIdSet = new Set(statusSet.validItemIds);
  const eligibleItems = allItems.filter((item) => item.archivedAt === null && validIdSet.has(item.id));

  // ② 确定性父子变体折叠（与 createMarketAnalysis 同一 dedupeParentVariations）
  const dedupe = dedupeParentVariations(eligibleItems.map((item) => ({
    id: item.id,
    productKey: item.productKey,
    ordinal: item.ordinal,
    asin: item.asin,
    parentAsin: item.parentAsin,
    familyProjectionJson: item.familyProjectionJson,
    rankingJson: item.rankingJson,
  })));
  const selectedIdSet = new Set(dedupe.selectedItemIds);
  const selectedItems = eligibleItems.filter((item) => selectedIdSet.has(item.id));
  if (!selectedItems.length) {
    throw new V5CoreError("SOURCE_NO_ELIGIBLE_SAMPLE", "来源批次经确定性父子变体处理后没有可用于市场分析的样本。", 422);
  }

  // ③④ 证据投影 + 样本快照 + 指标（与实际创建共用 prepareMarketScanSample，口径完全一致）
  const prepared = await prepareMarketScanSample({
    context: input.context,
    // niche 仅影响样本快照 hash，不参与样本资格与指标；预检用占位定义。
    scanName: `${batch.batchName} 样本预检`,
    marketplace,
    nicheKind: "keyword" as NicheDefinitionKind,
    nicheLabel: "sample-preview",
    productBatchId: batch.id,
    subjectKeys: selectedItems.map((item) => item.productKey),
    requestedLimit: selectedItems.length,
    observedAt: batch.importedAt?.toISOString() ?? null,
  } satisfies CreateMarketScanInput).catch((error: unknown) => {
    if (error instanceof MarketScanServiceError) {
      throw new V5CoreError(error.code.toUpperCase(), error.message, error.httpStatus);
    }
    throw error;
  });

  const statusItems: MarketAnalysisSamplePreviewItem[] = statusSet.excludedReasons
    .slice(0, PREVIEW_STAGE_ITEM_LIMIT)
    .map(({ itemId, reason }) => {
      const item = allItems.find((candidate) => candidate.id === itemId);
      return { id: itemId, asin: item?.asin ?? null, reason, label: MARKET_PRODUCT_EXCLUSION_LABELS[reason] };
    });

  const variantExcluded = eligibleItems.filter((item) => !selectedIdSet.has(item.id));
  const variantItems: MarketAnalysisSamplePreviewItem[] = variantExcluded
    .slice(0, PREVIEW_STAGE_ITEM_LIMIT)
    .map((item) => ({
      id: item.id,
      asin: item.asin,
      reason: "DUPLICATE_PARENT_VARIANT",
      label: MARKET_PRODUCT_EXCLUSION_LABELS.DUPLICATE_PARENT_VARIANT,
    }));

  const scopeSubjects = new Set(prepared.productBatchScope?.subjectKeys ?? []);
  const snapshotSubjects = new Set(prepared.sampleSnapshot.items.map((item) => item.subjectKey));
  const projectionBySubject = new Map(prepared.projections.map((projection) => [projection.subjectKey, projection]));
  const evidenceDropped = [...scopeSubjects].filter((subjectKey) => !snapshotSubjects.has(subjectKey));
  const evidenceItems: MarketAnalysisSamplePreviewItem[] = evidenceDropped
    .slice(0, PREVIEW_STAGE_ITEM_LIMIT)
    .map((subjectKey) => {
      const reason = projectionBySubject.has(subjectKey) ? "NO_USABLE_ASIN" : "EVIDENCE_PROJECTION_MISSING";
      const parts = subjectKey.split(":");
      return { id: subjectKey, asin: parts[parts.length - 1] ?? null, reason, label: EVIDENCE_STAGE_LABELS[reason] };
    });

  const frozen = projectFrozenMarketValidity(prepared.sampleSnapshot.items, marketplace);
  const deterministicItems: MarketAnalysisSamplePreviewItem[] = frozen.excludedReasons
    .slice(0, PREVIEW_STAGE_ITEM_LIMIT)
    .map(({ itemId, reason }) => {
      const item = prepared.sampleSnapshot.items[Number(itemId)];
      let fine: string = reason;
      if (item && previewIntegrityValid(item)) {
        fine = evaluateMarketSampleValidity({
          asin: item.asin,
          subjectKey: item.subjectKey,
          marketplace,
          factValues: item.factValues,
          evidenceId: item.evidenceId,
          evidenceVersion: item.evidenceVersion,
          sourceProofHash: item.sourceProofHash,
          capturedAt: item.capturedAt,
          integrityValid: true,
          evidenceStatus: item.evidenceStatus,
          parentAsin: item.parentAsin ?? null,
        }).reason;
      } else if (item) {
        fine = "EVIDENCE_BINDING_INVALID";
      }
      const useFine = DETERMINISTIC_STAGE_LABELS[fine] !== undefined;
      return {
        id: item ? item.subjectKey : itemId,
        asin: item?.asin ?? null,
        reason: useFine ? fine : reason,
        label: useFine
          ? DETERMINISTIC_STAGE_LABELS[fine]
          : MARKET_PRODUCT_EXCLUSION_LABELS[reason as keyof typeof MARKET_PRODUCT_EXCLUSION_LABELS],
      };
    });

  const finalFreezableCount = prepared.metrics.validSampleCount;
  const minimumRequired = statusSet.minimumRequired;

  return {
    productBatchId: batch.id,
    batchName: batch.batchName,
    marketplace,
    sourceItemCount: statusSet.rawCount,
    preliminaryValidCount: statusSet.validCount,
    finalFreezableCount,
    minimumRequired,
    sufficient: finalFreezableCount >= minimumRequired,
    parentVariationNotice: statusSet.parentVariationDedup.notice,
    stages: [
      { stage: "status", label: "证据状态与站点校验", droppedCount: statusSet.excludedReasons.length, items: statusItems },
      { stage: "variant", label: "父子变体折叠", droppedCount: variantExcluded.length, items: variantItems },
      { stage: "evidence", label: "证据投影与样本编组", droppedCount: evidenceDropped.length, items: evidenceItems },
      { stage: "deterministic", label: "冻结样本确定性校验", droppedCount: frozen.excludedReasons.length, items: deterministicItems },
    ],
  };
}

export async function marketScanAction(input: {
  context: AccessContext; scanId: string; action: "archive" | "restore" | "delete"; expectedVersion: unknown;
  idempotencyKey: string; expectedEvidenceBinding?: unknown;
}) {
  requireOwnerContext(input.context);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const result = await withV5Receipt({
    context: input.context, operation: `market-analysis:${input.action}`, resourceKey: input.scanId,
    idempotencyKey: input.idempotencyKey, requestBody: { action: input.action, expectedVersion, expectedEvidenceBinding: input.expectedEvidenceBinding ?? null },
    execute: async () => {
      const scan = await findScan(input.scanId);
      assertExpectedVersionMatches(expectedVersion, scan.updatedAt);
      const snapshot = parseSnapshot(scan.sampleSnapshotJson);
      if (input.action === "delete") {
        const candidateIds = await prisma.opportunityCandidate.findMany({ where: { sourceMetaJson: { contains: scan.id } }, select: { id: true } });
        const taskIds = candidateIds.length ? await prisma.viralAnalysisRecord.findMany({ where: { resultJson: { contains: candidateIds[0].id } }, select: { id: true } }) : [];
        const nicheRefs = await prisma.nicheOpportunity.findFirst({ where: { OR: [{ latestMarketScanId: scan.id }, { scanRefsJson: { contains: scan.id } }] }, select: { id: true } });
        if (candidateIds.length || taskIds.length || nicheRefs) throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "市场分析仍被研究链引用，只能归档。", 409, false, true);
        await prisma.marketScan.delete({ where: { id: scan.id } });
        return { scan: { id: scan.id }, outcome: "deleted", dependencySummary: dependencySummary(scan.id, snapshot) };
      }
      if (input.action === "restore" && scan.archivedAt === null) throw new V5CoreError("NOT_ARCHIVED", "市场分析当前未归档。", 409, false, true);
      const updated = await prisma.marketScan.update({ where: { id: scan.id }, data: { archivedAt: input.action === "archive" ? new Date() : null } });
      return { scan: await scanViewWithLifecycle(updated), outcome: input.action === "archive" ? "archived" : "restored", dependencySummary: { ...dependencySummary(scan.id, snapshot), deleteBlockedBy: [] } };
    },
  });
  return { ...result.value, replayed: result.replayed };
}

async function marketSampleAction(input: {
  context: AccessContext;
  marketSampleKey: string;
  action: MarketSampleLifecycleAction;
  expectedVersion: unknown;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const parsed = parseMarketSampleKey(input.marketSampleKey);
  if (!parsed) throw new V5CoreError("BULK_ACTION_INVALID", "marketSampleKey 格式无效。", 400);
  const expectedVersion = typeof input.expectedVersion === "string" ? input.expectedVersion : null;
  if (!expectedVersion) throw new V5CoreError("CAS_VERSION_REQUIRED", "市场样本操作必须携带 expectedVersion。", 409, false, true);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: `market-sample:${input.action}`,
    resourceKey: input.marketSampleKey,
    idempotencyKey: input.idempotencyKey,
    requestBody: { action: input.action, expectedVersion },
    execute: async () => {
      const current = await findMarketSample(parsed.scanId, parsed.marketSampleKey);
      const currentVersion = sampleResourceVersion(current.scan.sampleHash, current.marketSampleKey, current.lifecycle?.archivedAt ?? null);
      if (currentVersion !== expectedVersion) throw new V5CoreError("CAS_CONFLICT", "市场样本已变化，请刷新后重试。", 409, false, true, { currentVersion });
      const dependencySummary = await sampleDependencySummary(current.scan.id, current.marketSampleKey);
      if (input.action === "delete") {
        if (dependencySummary.deleteBlockedBy.length) {
          throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "市场样本仍被研究链引用，只能归档。", 409, false, true, { dependencySummary });
        }
        if (current.lifecycle) await prisma.v5MarketSampleLifecycle.delete({ where: { id: current.lifecycle.id } });
        return { id: current.marketSampleKey, scanId: current.scan.id, outcome: "deleted", currentVersion, dependencySummary };
      }
      if (input.action === "restore" && !current.lifecycle?.archivedAt) {
        throw new V5CoreError("NOT_ARCHIVED", "市场样本当前未归档。", 409, false, true);
      }
      if (input.action === "archive" && current.lifecycle?.archivedAt) {
        throw new V5CoreError("ALREADY_ARCHIVED", "市场样本当前已归档。", 409, false, true);
      }
      const archivedAt = input.action === "archive" ? new Date() : null;
      const state = current.lifecycle
        ? await prisma.v5MarketSampleLifecycle.update({ where: { id: current.lifecycle.id }, data: { archivedAt } })
        : await prisma.v5MarketSampleLifecycle.create({ data: { ownerScope: OWNER, scanId: current.scan.id, marketSampleKey: current.marketSampleKey, archivedAt } });
      return {
        id: current.marketSampleKey,
        scanId: current.scan.id,
        outcome: input.action === "archive" ? "archived" : "restored",
        archivedAt: state.archivedAt?.toISOString() ?? null,
        currentVersion: sampleResourceVersion(current.scan.sampleHash, current.marketSampleKey, state.archivedAt),
        dependencySummary: { ...dependencySummary, deleteBlockedBy: [] },
      };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function marketBulkAction(input: {
  context: AccessContext; resource: "market_scan" | "market_sample"; action: "archive" | "restore" | "delete";
  items: Array<{ id: string; expectedVersion: unknown }>; idempotencyKey: string; expectedScanHash?: string;
}) {
  requireOwnerContext(input.context);
  if (!["market_scan", "market_sample"].includes(input.resource) || !["archive", "restore", "delete"].includes(input.action)) {
    throw new V5CoreError("BULK_ACTION_INVALID", "市场批量操作类型无效。", 400);
  }
  if (!input.items.length || input.items.length > MAX_BULK) throw new V5CoreError(input.items.length > MAX_BULK ? "BULK_ACTION_TOO_LARGE" : "BULK_ACTION_INVALID", "批量操作数量无效。", 400);
  const receipt = await withV5Receipt({
    context: input.context, operation: `market:${input.resource}:bulk:${input.action}`, resourceKey: input.items.map((item) => item.id).sort().join(","), idempotencyKey: input.idempotencyKey,
    requestBody: input,
    execute: async () => {
      const results: Array<Record<string, unknown>> = [];
      for (const item of input.items) {
        try {
          if (input.resource === "market_sample") {
            const parsed = parseMarketSampleKey(item.id);
            if (!parsed) throw new V5CoreError("BULK_ACTION_INVALID", "marketSampleKey 格式无效。", 400);
            const current = await findMarketSample(parsed.scanId, parsed.marketSampleKey);
            if (input.expectedScanHash && current.scan.sampleHash !== input.expectedScanHash) {
              throw new V5CoreError("MARKET_SNAPSHOT_STALE", "市场分析快照已变化，请刷新后重试。", 409, false, true);
            }
            const result = await marketSampleAction({ context: input.context, marketSampleKey: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` });
            results.push({ id: item.id, scanId: parsed.scanId, outcome: result.outcome, code: null, currentVersion: result.currentVersion, dependencySummary: result.dependencySummary });
          } else {
            const result = await marketScanAction({ context: input.context, scanId: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` });
            results.push({ id: item.id, scanId: item.id, outcome: result.outcome, code: null, currentVersion: (result.scan as Record<string, unknown>)?.resourceVersion ?? null, dependencySummary: result.dependencySummary });
          }
        } catch (error) {
          const v5 = error instanceof V5CoreError ? error : new V5CoreError("INTERNAL_ERROR", "项目操作失败。", 500);
          results.push({ id: item.id, outcome: "failed", code: v5.code, currentVersion: null });
        }
      }
      return { resource: input.resource, action: input.action, total: results.length, succeeded: results.filter((item) => item.outcome !== "failed").length, failed: results.filter((item) => item.outcome === "failed").length, results };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function handoffMarketToResearch(input: {
  context: AccessContext; scanId: string; expectedScanHash: string; selections: Array<{ marketSampleKey: string; asin: string; subjectKey: string; role?: string }>; idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  if (input.selections.length < 1 || input.selections.length > 50) throw new V5CoreError("SELECTION_LIMIT_INVALID", "一次研究交接必须选择 1 到 50 个样本。", 422);
  const scan = await findScan(input.scanId);
  if (scan.sampleHash !== input.expectedScanHash) throw new V5CoreError("MARKET_SNAPSHOT_STALE", "市场分析快照已变化，请刷新后重新选择。", 409, false, true);
  const workflow = assertCurrentMarketWorkflow(scan, input.expectedScanHash);
  if (decisionReadinessOf(scan).sampleSufficiency === "INSUFFICIENT_SAMPLE") assertProceedReadiness(scan, false);
  if (workflow.effectiveGateStatus !== "PROCEED") throw new V5CoreError("MARKET_GATE_REQUIRED", "请先完成人工 Market Gate，并将状态设为 PROCEED。", 409, false, true);
  assertProceedReadiness(scan, workflow.metadata.marketGate.missingDataAcknowledged);
  if (!workflow.metadata.representatives.items.length) throw new V5CoreError("REPRESENTATIVE_SELECTION_REQUIRED", "请先保存至少一个代表商品，再发起商品研究。", 409, false, true);
  const snapshot = parseSnapshot(scan.sampleSnapshotJson);
  const byKey = new Map(snapshot.items.map((item) => [`${scan.id}:${String(item.asin).toUpperCase()}`, item]));
  const representativeByKey = new Map(workflow.metadata.representatives.items.map((item) => [item.marketSampleKey, item]));
  const adopted = input.selections.map((item) => representativeByKey.get(item.marketSampleKey)?.researchContext).filter(Boolean);
  if (adopted.length) {
    const intelligence = await (await import("@/lib/server/marketIntelligenceService")).getMarketIntelligence({ context: input.context, scanId: input.scanId });
    if (adopted.some((brief) => brief!.inputHash !== intelligence.inputHash)) throw new V5CoreError("MARKET_RECOMMENDATION_STALE", "已保存的机会依据已变化，请在 02 复核并重新保存研究目的后交接。", 409);
  }
  const approved = approvedResearchSubjects(parseJsonRecord(scan.sampleDefinitionJson));
  const archivedSamples = new Set((await prisma.v5MarketSampleLifecycle.findMany({ where: { ownerScope: OWNER, scanId: scan.id, archivedAt: { not: null } }, select: { marketSampleKey: true } })).map((item) => item.marketSampleKey));
  const resourceKey = `${scan.id}:${input.selections.map((item) => item.marketSampleKey).sort().join(",")}:${input.expectedScanHash}`;
  const receipt = await withV5Receipt({
    context: input.context, operation: "market-analysis:research-handoff", resourceKey, idempotencyKey: input.idempotencyKey,
    requestBody: { selections: input.selections, expectedScanHash: input.expectedScanHash },
    execute: async () => {
      const items: Array<Record<string, unknown>> = [];
      for (const selection of input.selections) {
        const sample = byKey.get(selection.marketSampleKey);
        const representative = representativeByKey.get(selection.marketSampleKey);
        if (!sample || !representative || archivedSamples.has(selection.marketSampleKey) || (approved && !approved.has(String(sample.subjectKey))) || String(sample.asin).toUpperCase() !== selection.asin.toUpperCase() || sample.subjectKey !== selection.subjectKey || (selection.role && selection.role !== representative.role)) {
          items.push({ marketSampleKey: selection.marketSampleKey, asin: selection.asin, outcome: "failed", code: representative ? "SAMPLE_NOT_IN_SCAN" : "REPRESENTATIVE_NOT_SAVED" });
          continue;
        }
        try {
          const itemResult = await prisma.$transaction(async (tx) => {
            const asin = selection.asin.toUpperCase();
            const existing = (await tx.opportunityCandidate.findMany({ where: { sourceMetaJson: { contains: `\"asin\":\"${asin}\"` } }, orderBy: { createdAt: "asc" } })).find((candidate) => {
              const meta = parseJsonRecord(candidate.sourceMetaJson);
              const provenance = isRecord(meta.marketProvenance) ? meta.marketProvenance : {};
              return meta.asin === asin && meta.marketplace === scan.marketplace
                && provenance.scanId === scan.id && provenance.marketSampleKey === selection.marketSampleKey;
            });
            const sourceMeta = existing ? parseJsonRecord(existing.sourceMetaJson) : {};
            const provenance = Array.isArray(sourceMeta.provenance) ? sourceMeta.provenance : [];
            const marketProvenance = {
              scanId: scan.id,
              marketScanId: scan.id,
              marketSampleKey: selection.marketSampleKey,
              sampleHash: scan.sampleHash,
              metricsVersion: scan.metricsVersion,
              analysisScopeHash: hashJson([...(approved ?? new Set(snapshot.items.map((item) => String(item.subjectKey))))].sort()),
              analysisSubjects: [...(approved ?? new Set(snapshot.items.map((item) => String(item.subjectKey))))].sort(),
              marketReport: (() => { const state = parseJsonRecord(scan.sampleDefinitionJson).marketIntelligence; const reports = isRecord(state) && Array.isArray(state.reports) ? state.reports : []; const last = reports.at(-1); return isRecord(last) ? { id: last.id, inputHash: last.inputHash, generatedAt: last.generatedAt } : null; })(),
              marketDecisionStatus: "PROCEED",
              role: representative.role,
              representativeNote: representative.note,
              ...(representative.researchContext ? { opportunityResearch: representative.researchContext } : {}),
            } as const;
            const sampleTitle = isRecord(sample.factValues) && isRecord(sample.factValues.title) && sample.factValues.title.presence === "present" && typeof sample.factValues.title.value === "string"
              ? sample.factValues.title.value
              : (isRecord(sample.title) && sample.title.presence === "present" && typeof sample.title.value === "string" ? sample.title.value : asin);
            const sampleSubjectKey = typeof sample.subjectKey === "string" && sample.subjectKey.trim() ? sample.subjectKey.trim() : `amazon:${scan.marketplace}:${asin}`;
            const sampleEvidenceId = typeof sample.evidenceId === "string" ? sample.evidenceId.trim() : null;
            const sampleEvidenceVersion = typeof sample.evidenceVersion === "number" ? sample.evidenceVersion : null;
            const sampleProofHash = typeof sample.sourceProofHash === "string" ? sample.sourceProofHash.trim() : null;

            const evidenceBinding = buildV5MarketCandidateEvidenceBinding({
              subjectKey: sampleSubjectKey,
              evidenceId: sampleEvidenceId,
              evidenceVersion: sampleEvidenceVersion,
              contentHash: sampleProofHash,
            });
            const sourceMetaNext = buildV5MarketCandidateV3Meta({
              existingSourceMeta: sourceMeta,
              asin,
              title: sampleTitle,
              marketplace: scan.marketplace,
              provenance,
              marketProvenance,
              evidenceBinding,
              sourceLayerCapture: {
                version: sampleEvidenceVersion,
                evidenceId: sampleEvidenceId,
                contentHash: sampleProofHash,
                subjectKey: sampleSubjectKey,
              },
              factHash: hashJson(sample.factValues ?? sample.productFactFingerprint),
              evidenceHash: hashJson({ evidenceId: sampleEvidenceId, evidenceVersion: sampleEvidenceVersion, sourceProofHash: sampleProofHash }),
            });
            const candidate = existing
              ? await tx.opportunityCandidate.update({ where: { id: existing.id }, data: { sourceMetaJson: JSON.stringify(sourceMetaNext), updatedAt: new Date() } })
              : await tx.opportunityCandidate.create({ data: {
                name: sampleTitle,
                rawInput: asin, link: null, source: "market_analysis", status: "pending", sourceMetaJson: JSON.stringify(sourceMetaNext), analysisJson: "{}",
              } });
            if (candidate.convertedTaskId) {
              const existingTask = await tx.viralAnalysisRecord.findUnique({ where: { id: candidate.convertedTaskId }, select: { id: true, resultJson: true } });
              if (existingTask) {
                const root = parseJsonRecord(existingTask.resultJson);
                const existingV5Research = isRecord(root.v5Research) ? root.v5Research : {};
                await createTaskResultJsonMutator({ ownerDatabase: tx })({ context: input.context,
                  taskId: existingTask.id, writer: "market-research-handoff",
                  mutate: (current) => ({ result: { ...current, marketProvenance,
                    v5Research: { ...(isRecord(current.v5Research) ? current.v5Research : existingV5Research), marketProvenance } }, value: null }),
                });
              }
              return { candidate, taskId: candidate.convertedTaskId, candidateOutcome: "reused", taskOutcome: "reused", marketProvenance };
            }
            const task = await tx.viralAnalysisRecord.create({ data: {
              type: "workflow", title: `${candidate.name} 商品研究`, platform: "market-analysis", productUrl: null, materialText: candidate.name, source: "market_analysis", score: 0, level: "", oneLineSummary: "", decisionStatus: "pending",
              // 任务身份必须与「开始研究」骨架（startResearchTask）同一契约：
              // candidateToTask.version 是 getResearchTaskCandidateId 的权威判据，
              // 缺失会让该任务在人工决定 / 图片 / VOC 证据路径上被判定为「无候选绑定」。
              resultJson: JSON.stringify({ type: "v5-research", candidateToTask: { version: 1, candidateId: candidate.id, confirmation: "research_started", confirmedAt: new Date().toISOString() }, marketProvenance, v5Research: { schema: "v5-research.v1", candidateId: candidate.id, asin, marketplace: scan.marketplace, title: candidate.name, factHash: hashJson(sample.factValues ?? sample.productFactFingerprint), evidenceHash: hashJson({ evidenceId: sample.evidenceId, evidenceVersion: sample.evidenceVersion, sourceProofHash: sample.sourceProofHash }), evidenceRefs: [sample.evidenceId ? `evidence:${sample.evidenceId}` : null, sample.evidenceId].filter((x): x is string => Boolean(x)), researchRevision: 0, report: null, reportHash: null, advisory: null, myChoice: null, temporaryWatches: [], marketProvenance } }),
            } });
            const linked = await tx.opportunityCandidate.updateMany({ where: { id: candidate.id, convertedTaskId: null }, data: { convertedTaskId: task.id, lastActionAt: new Date() } });
            if (linked.count !== 1) throw new V5CoreError("TASK_CONVERSION_CONFLICT", "候选刚刚已转入研究，请刷新。", 409, false, true);
            return { candidate, taskId: task.id, candidateOutcome: existing ? "reused" : "created", taskOutcome: "created", marketProvenance };
          });
          let factRecovery: { status: string; code?: string } = { status: "attached" };
          try {
            const { attachProductFactToExistingCandidate } = await import("@/lib/sourceLayer/server/candidateFactRecovery");
            await attachProductFactToExistingCandidate({ candidateId: itemResult.candidate.id, context: input.context });
          } catch (error) {
            factRecovery = { status: "unavailable", code: error && typeof error === "object" && "code" in error ? String(error.code) : "FACT_RECOVERY_FAILED" };
          }
          items.push({ marketSampleKey: selection.marketSampleKey, asin: selection.asin, role: representative.role, candidateId: itemResult.candidate.id, taskId: itemResult.taskId, candidateOutcome: itemResult.candidateOutcome, taskOutcome: itemResult.taskOutcome, marketProvenance: itemResult.marketProvenance, factRecovery, researchRecordIdentity: { taskId: itemResult.taskId, researchRevision: 0, researchRecordKey: `${itemResult.taskId}:0` } });
        } catch (error) {
          const v5 = error instanceof V5CoreError ? error : new V5CoreError("HANDOFF_PARTIAL_FAILURE", "研究交接失败。", 409, true, true);
          items.push({ marketSampleKey: selection.marketSampleKey, asin: selection.asin, outcome: "failed", code: v5.code });
        }
      }
      return { scanId: scan.id, items, partial: items.some((item) => item.outcome === "failed"), replayed: false };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}
