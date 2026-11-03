/**
 * Phase 2：NicheOpportunity 持久化。
 *
 * 机会池只保存编组元数据和分析 / 状态 JSON；商品事实仍由 MarketScan 持有。
 * 所有查询都固定 ownerScope，避免把 OpportunityCandidate 或旧 Research 记录混入。
 */

import type { PrismaClient } from "@prisma/client";

import {
  buildInitialHumanDecision,
  buildInitialLarkSync,
  buildMarketOpportunityNicheDefinition,
  parseMarketOpportunityAnalysisSnapshot,
  parseMarketOpportunityAiInterpretation,
  parseMarketOpportunityHumanDecision,
  parseMarketOpportunityLarkSync,
  parseMarketOpportunityNicheDefinition,
  parseMarketOpportunityScanRefs,
  parseMarketOpportunitySchemaVersion,
  serializeOpportunityJson,
  assertOpportunityIdentity,
  type MarketOpportunityContractErrorCode,
} from "@/lib/marketOpportunity/contract";
import { compareMarketScans } from "@/lib/marketOpportunity/comparison";
import {
  MARKET_OPPORTUNITY_ANALYSIS_SCHEMA,
  MARKET_OPPORTUNITY_OWNER_SCOPE,
  MARKET_OPPORTUNITY_SCHEMA,
  type MarketOpportunityAiInterpretation,
  type MarketOpportunityAnalysisSnapshot,
  type MarketOpportunityHumanDecision,
  type MarketOpportunityLarkSync,
  type MarketOpportunityRecordView,
  type MarketOpportunityScanRef,
} from "@/lib/marketOpportunity/types";
import {
  buildInitialRepresentativeSelectionSet,
  parseRepresentativeSelectionSet,
  type RepresentativeSelection,
  type RepresentativeSelectionSet,
} from "@/lib/marketOpportunity/representatives";
import {
  buildInitialProductProjectSync,
  parseProductConcept,
  parseProductConceptHumanDecision,
  parseProductProjectSync,
  type ProductConceptHumanDecision,
  type ProductConceptSnapshot,
  type ProductProjectSync,
} from "@/lib/marketOpportunity/concept";
import { stableStringify } from "@/lib/marketScan/metrics";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";
import { createMarketScanRepository, type MarketScanRepository } from "@/lib/server/marketScanRepository";
import { prisma } from "@/lib/server/db";

const MAX_LIST_LIMIT = 100;

export type MarketOpportunityCreateInput = {
  readonly name: string;
  readonly latestMarketScanId: string;
  readonly scanIds?: readonly string[];
};

export class MarketOpportunityPersistenceError extends Error {
  constructor(
    public readonly code:
      | "market_opportunity_persist_failed"
      | "market_opportunity_invalid_record"
      | "market_opportunity_not_found"
      | "market_opportunity_conflict",
    message: string,
    public readonly detailCode?: MarketOpportunityContractErrorCode,
  ) {
    super(message);
    this.name = "MarketOpportunityPersistenceError";
  }
}

type MarketOpportunityRow = {
  id: string;
  ownerScope: string;
  schemaVersion: string;
  name: string;
  marketplace: string;
  nicheKind: string;
  nicheDefinitionJson: string;
  latestMarketScanId: string;
  scanRefsJson: string;
  analysisSnapshotJson: string;
  aiInterpretationJson: string | null;
  humanDecisionJson: string | null;
  larkSyncJson: string;
  representativeSetJson: string;
  conceptSnapshotJson: string | null;
  conceptProjectSyncJson: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type MarketOpportunityRepository = {
  create(input: MarketOpportunityCreateInput): Promise<MarketOpportunityRecordView>;
  getById(id: string): Promise<MarketOpportunityRecordView | null>;
  list(input?: { readonly limit?: number }): Promise<MarketOpportunityRecordView[]>;
  setAiInterpretation(id: string, value: MarketOpportunityAiInterpretation): Promise<MarketOpportunityRecordView>;
  setHumanDecision(input: {
    readonly id: string;
    readonly status: MarketOpportunityHumanDecision["status"];
    readonly reason: string | null;
    readonly nextAction: string | null;
    readonly expectedRevision: number;
  }): Promise<MarketOpportunityRecordView>;
  setLarkSync(id: string, value: MarketOpportunityLarkSync): Promise<MarketOpportunityRecordView>;
  setRepresentatives(input: {
    readonly id: string;
    readonly items: readonly RepresentativeSelection[];
    readonly expectedRevision: number;
  }): Promise<MarketOpportunityRecordView>;
  setConceptSnapshot(id: string, value: ProductConceptSnapshot): Promise<MarketOpportunityRecordView>;
  setConceptHumanDecision(input: {
    readonly id: string;
    readonly value: ProductConceptHumanDecision;
    readonly expectedRevision: number;
  }): Promise<MarketOpportunityRecordView>;
  setConceptProjectSync(id: string, value: ProductProjectSync): Promise<MarketOpportunityRecordView>;
};

const ROW_SELECT = {
  id: true,
  ownerScope: true,
  schemaVersion: true,
  name: true,
  marketplace: true,
  nicheKind: true,
  nicheDefinitionJson: true,
  latestMarketScanId: true,
  scanRefsJson: true,
  analysisSnapshotJson: true,
  aiInterpretationJson: true,
  humanDecisionJson: true,
  larkSyncJson: true,
  representativeSetJson: true,
  conceptSnapshotJson: true,
  conceptProjectSyncJson: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "机会时间戳不合法。");
  }
  return date.toISOString();
}

function scanRefOf(scan: MarketScanRecordView): MarketOpportunityScanRef {
  return {
    scanId: scan.id,
    sampleHash: scan.sampleHash,
    metricsVersion: scan.metricsVersion,
    sampleCount: scan.sampleCount,
    createdAt: scan.createdAt,
  };
}

function missingEvidenceOf(scan: MarketScanRecordView): string[] {
  const missing: string[] = [];
  const metrics = scan.metrics;
  if (metrics.price.status !== "PRESENT") missing.push("metrics.price");
  if (metrics.sales.status !== "PRESENT") missing.push("metrics.sales");
  if (metrics.revenue.status !== "PRESENT") missing.push("metrics.revenue");
  if (metrics.brandConcentration.uniqueBrandCount.status !== "PRESENT") {
    missing.push("metrics.brandConcentration.uniqueBrandCount");
  }
  if (metrics.evidenceWindow.observedAtSource === "unknown") {
    missing.push("metrics.evidenceWindow.recordedObservedAt");
  }
  if (metrics.validSampleCount < metrics.sampleCount) missing.push("metrics.validSampleCount");
  return missing;
}

export function buildMarketOpportunityAnalysisSnapshot(input: {
  readonly latest: MarketScanRecordView;
  readonly history: readonly MarketScanRecordView[];
  readonly generatedAt?: Date;
}): MarketOpportunityAnalysisSnapshot {
  const generatedAt = input.generatedAt ?? new Date();
  if (Number.isNaN(generatedAt.getTime())) {
    throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "分析时间戳不合法。");
  }
  const previous = [...input.history]
    .filter((scan) => scan.id !== input.latest.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .at(-1) ?? null;
  return {
    schemaVersion: MARKET_OPPORTUNITY_ANALYSIS_SCHEMA,
    status: "READY",
    latestScanId: input.latest.id,
    scanRef: scanRefOf(input.latest),
    sampleDefinition: input.latest.sampleDefinition,
    metrics: input.latest.metrics,
    comparison: previous ? compareMarketScans(previous, input.latest) : null,
    missingEvidence: missingEvidenceOf(input.latest),
    generatedAt: generatedAt.toISOString(),
  };
}

function parseLarkJson(value: string): MarketOpportunityLarkSync {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "飞书同步 JSON 无法解析。");
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)
    && (raw as Record<string, unknown>).exportContractVersion === undefined) {
    raw = { ...raw, exportContractVersion: "opportunity-export.v1" };
  }
  return parseMarketOpportunityLarkSync(raw);
}

function parseRepresentativeJson(value: string): RepresentativeSelectionSet {
  const raw = parseJson(value, "representativeSetJson");
  if (Array.isArray(raw)) {
    return buildInitialRepresentativeSelectionSet();
  }
  return parseRepresentativeSelectionSet(raw);
}

function parseProjectSyncJson(value: string): ProductProjectSync {
  let raw = parseJson(value, "conceptProjectSyncJson");
  if (raw && typeof raw === "object" && !Array.isArray(raw)
    && (raw as Record<string, unknown>).exportContractVersion === undefined) {
    raw = { ...raw, exportContractVersion: "product-project.v1" };
  }
  return parseProductProjectSync(raw);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", `${label} 无法解析。`);
  }
}

/** 反序列化边界：数据库内的 JSON 不能直接透传到 API。 */
export function parseMarketOpportunityRow(row: MarketOpportunityRow): MarketOpportunityRecordView {
  try {
    if (row.ownerScope !== MARKET_OPPORTUNITY_OWNER_SCOPE) {
      throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "机会 owner scope 不一致。");
    }
    parseMarketOpportunitySchemaVersion(row.schemaVersion);
    const nicheDefinition = parseMarketOpportunityNicheDefinition(
      parseJson(row.nicheDefinitionJson, "nicheDefinitionJson"),
    );
    const scanRefs = parseMarketOpportunityScanRefs(
      parseJson(row.scanRefsJson, "scanRefsJson"),
    );
    const analysisSnapshot = parseMarketOpportunityAnalysisSnapshot(
      parseJson(row.analysisSnapshotJson, "analysisSnapshotJson"),
    );
    const aiInterpretation = row.aiInterpretationJson === null
      ? null
      : parseMarketOpportunityAiInterpretationOrNull(row.aiInterpretationJson);
    const humanDecision = row.humanDecisionJson === null
      ? null
      : parseMarketOpportunityHumanDecisionOrNull(row.humanDecisionJson);
    const larkSync = parseLarkJson(row.larkSyncJson);
    const representativeSet = parseRepresentativeJson(row.representativeSetJson);
    const conceptSnapshot = row.conceptSnapshotJson === null
      ? null
      : parseProductConcept(parseJson(row.conceptSnapshotJson, "conceptSnapshotJson"));
    const conceptProjectSync = parseProjectSyncJson(row.conceptProjectSyncJson);
    assertOpportunityIdentity({
      latestScanId: row.latestMarketScanId,
      scanRefs,
      analysisSnapshot,
    });
    if (nicheDefinition.kind !== row.nicheKind) {
      throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "机会 nicheKind 不一致。");
    }
    return {
      id: row.id,
      ownerScope: row.ownerScope,
      schemaVersion: MARKET_OPPORTUNITY_SCHEMA,
      name: row.name,
      marketplace: row.marketplace,
      nicheKind: row.nicheKind,
      nicheDefinition,
      latestMarketScanId: row.latestMarketScanId,
      scanRefs,
      analysisSnapshot,
      aiInterpretation,
      humanDecision,
      larkSync,
      representativeSet,
      conceptSnapshot,
      conceptProjectSync,
      createdAt: isoOf(row.createdAt),
      updatedAt: isoOf(row.updatedAt),
    };
  } catch (error) {
    if (error instanceof MarketOpportunityPersistenceError) throw error;
    const detailCode = (error as { code?: MarketOpportunityContractErrorCode }).code;
    throw new MarketOpportunityPersistenceError(
      "market_opportunity_invalid_record",
      error instanceof Error ? error.message : "机会记录解析失败。",
      detailCode,
    );
  }
}

function parseMarketOpportunityAiInterpretationOrNull(value: string): MarketOpportunityAiInterpretation {
  return parseMarketOpportunityAiInterpretation(parseJson(value, "aiInterpretationJson"));
}

function parseMarketOpportunityHumanDecisionOrNull(value: string): MarketOpportunityHumanDecision {
  return parseMarketOpportunityHumanDecision(parseJson(value, "humanDecisionJson"));
}

function safeName(value: string): string {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 200) {
    throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "机会名称长度不合法。");
  }
  return normalized;
}

function uniqueIds(input: MarketOpportunityCreateInput): string[] {
  const ids = [input.latestMarketScanId, ...(input.scanIds ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

export function createMarketOpportunityRepository(
  client: PrismaClient = prisma,
  marketScans: MarketScanRepository = createMarketScanRepository(client),
): MarketOpportunityRepository {
  return {
    async create(input) {
      const latestId = input.latestMarketScanId.trim();
      if (!latestId) {
        throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "缺少 latestMarketScanId。");
      }
      const scanIds = uniqueIds(input);
      if (scanIds.length < 1 || scanIds.length > 100) {
        throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "关联扫描数量不合法。");
      }
      const scans = await Promise.all(scanIds.map((id) => marketScans.getById(id)));
      if (scans.some((scan) => scan === null)) {
        throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "关联的 MarketScan 不存在或不可访问。");
      }
      const resolvedScans = scans as MarketScanRecordView[];
      const latest = resolvedScans.find((scan) => scan.id === latestId);
      if (!latest) {
        throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "latest MarketScan 不存在或不可访问。");
      }
      const ordered = [...resolvedScans].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const scanRefs = ordered.map(scanRefOf);
      const analysisSnapshot = buildMarketOpportunityAnalysisSnapshot({
        latest,
        history: ordered,
      });
      const nicheDefinition = buildMarketOpportunityNicheDefinition(latest.nicheDefinition);
      const data = {
        ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE,
        schemaVersion: MARKET_OPPORTUNITY_SCHEMA,
        name: safeName(input.name),
        marketplace: latest.marketplace,
        nicheKind: nicheDefinition.kind,
        nicheDefinitionJson: serializeOpportunityJson(nicheDefinition, "nicheDefinitionJson"),
        latestMarketScanId: latest.id,
        scanRefsJson: serializeOpportunityJson(scanRefs, "scanRefsJson"),
        analysisSnapshotJson: serializeOpportunityJson(analysisSnapshot, "analysisSnapshotJson"),
        aiInterpretationJson: null,
        humanDecisionJson: serializeOpportunityJson(buildInitialHumanDecision(), "humanDecisionJson"),
        larkSyncJson: serializeOpportunityJson(buildInitialLarkSync(), "larkSyncJson"),
        representativeSetJson: serializeOpportunityJson(buildInitialRepresentativeSelectionSet(), "representativeSetJson"),
        conceptSnapshotJson: null,
        conceptProjectSyncJson: serializeOpportunityJson(buildInitialProductProjectSync(), "conceptProjectSyncJson"),
      };
      try {
        const row = await client.nicheOpportunity.create({ data, select: ROW_SELECT });
        return parseMarketOpportunityRow(row as MarketOpportunityRow);
      } catch (error) {
        if (error instanceof MarketOpportunityPersistenceError) throw error;
        throw new MarketOpportunityPersistenceError(
          "market_opportunity_persist_failed",
          error instanceof Error ? error.message : "机会池写入失败。",
        );
      }
    },

    async getById(id) {
      const row = await client.nicheOpportunity.findFirst({
        where: { id, ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE },
        select: ROW_SELECT,
      });
      return row ? parseMarketOpportunityRow(row as MarketOpportunityRow) : null;
    },

    async list(input) {
      const requested = input?.limit;
      const limit = Number.isSafeInteger(requested) && (requested as number) > 0
        ? Math.min(requested as number, MAX_LIST_LIMIT)
        : MAX_LIST_LIMIT;
      const rows = await client.nicheOpportunity.findMany({
        where: { ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
        select: ROW_SELECT,
      });
      return rows.map((row) => parseMarketOpportunityRow(row as MarketOpportunityRow));
    },

    async setAiInterpretation(id, value) {
      const current = await this.getById(id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      try {
        const row = await client.nicheOpportunity.update({
          where: { id },
          data: { aiInterpretationJson: serializeOpportunityJson(value, "aiInterpretationJson") },
          select: ROW_SELECT,
        });
        return parseMarketOpportunityRow(row as MarketOpportunityRow);
      } catch (error) {
        if (error instanceof MarketOpportunityPersistenceError) throw error;
        throw new MarketOpportunityPersistenceError("market_opportunity_persist_failed", "保存 AI 解释失败。");
      }
    },

    async setHumanDecision(input) {
      const current = await this.getById(input.id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      const oldDecision = current.humanDecision ?? buildInitialHumanDecision();
      if (oldDecision.revision !== input.expectedRevision) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "机会已被其他操作更新，请刷新后重试。");
      }
      const nextDecision = parseMarketOpportunityHumanDecision({
        status: input.status,
        reason: input.reason,
        nextAction: input.nextAction,
        decidedAt: new Date().toISOString(),
        revision: oldDecision.revision + 1,
      });
      const expectedJson = current.humanDecision === null
        ? null
        : serializeOpportunityJson(current.humanDecision, "humanDecisionJson");
      const updated = await client.nicheOpportunity.updateMany({
        where: {
          id: input.id,
          ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE,
          ...(expectedJson === null ? { humanDecisionJson: null } : { humanDecisionJson: expectedJson }),
        },
        data: { humanDecisionJson: serializeOpportunityJson(nextDecision, "humanDecisionJson") },
      });
      if (updated.count !== 1) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "机会已被其他操作更新，请刷新后重试。");
      }
      const result = await this.getById(input.id);
      if (!result) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      return result;
    },

    async setLarkSync(id, value) {
      const current = await this.getById(id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      const row = await client.nicheOpportunity.update({
        where: { id },
        data: { larkSyncJson: serializeOpportunityJson(value, "larkSyncJson") },
        select: ROW_SELECT,
      });
      return parseMarketOpportunityRow(row as MarketOpportunityRow);
    },

    async setRepresentatives(input) {
      const current = await this.getById(input.id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      if (current.representativeSet.revision !== input.expectedRevision) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "代表商品选择已更新，请刷新后重试。");
      }
      const next = parseRepresentativeSelectionSet({
        schemaVersion: "market-opportunity-representatives.v1",
        revision: current.representativeSet.revision + 1,
        items: input.items,
      });
      const expectedJson = serializeOpportunityJson(current.representativeSet, "representativeSetJson");
      const updated = await client.nicheOpportunity.updateMany({
        where: {
          id: input.id,
          ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE,
          representativeSetJson: { in: [expectedJson, JSON.stringify(current.representativeSet)] },
        },
        data: { representativeSetJson: serializeOpportunityJson(next, "representativeSetJson") },
      });
      if (updated.count !== 1) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "代表商品选择已更新，请刷新后重试。");
      }
      const result = await this.getById(input.id);
      if (!result) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      return result;
    },

    async setConceptSnapshot(id, value) {
      const current = await this.getById(id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      const parsed = parseProductConcept(value);
      if (parsed.opportunityId !== id) {
        throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "产品概念不属于当前机会。");
      }
      const row = await client.nicheOpportunity.update({
        where: { id },
        data: { conceptSnapshotJson: serializeOpportunityJson(parsed, "conceptSnapshotJson") },
        select: ROW_SELECT,
      });
      return parseMarketOpportunityRow(row as MarketOpportunityRow);
    },

    async setConceptHumanDecision(input) {
      const current = await this.getById(input.id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      if (!current.conceptSnapshot) throw new MarketOpportunityPersistenceError("market_opportunity_invalid_record", "请先生成产品概念。");
      if (current.conceptSnapshot.humanDecision.revision !== input.expectedRevision) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "产品概念已更新，请刷新后重试。");
      }
      const nextDecision = parseProductConceptHumanDecision(input.value);
      const next = parseProductConcept({
        ...current.conceptSnapshot,
        humanDecision: nextDecision,
      });
      const expectedJson = serializeOpportunityJson(current.conceptSnapshot, "conceptSnapshotJson");
      const updated = await client.nicheOpportunity.updateMany({
        where: {
          id: input.id,
          ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE,
          conceptSnapshotJson: expectedJson,
        },
        data: { conceptSnapshotJson: serializeOpportunityJson(next, "conceptSnapshotJson") },
      });
      if (updated.count !== 1) {
        throw new MarketOpportunityPersistenceError("market_opportunity_conflict", "产品概念已更新，请刷新后重试。");
      }
      const result = await this.getById(input.id);
      if (!result) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      return result;
    },

    async setConceptProjectSync(id, value) {
      const current = await this.getById(id);
      if (!current) throw new MarketOpportunityPersistenceError("market_opportunity_not_found", "机会不存在。");
      const parsed = parseProductProjectSync(value);
      const row = await client.nicheOpportunity.update({
        where: { id },
        data: { conceptProjectSyncJson: serializeOpportunityJson(parsed, "conceptProjectSyncJson") },
        select: ROW_SELECT,
      });
      return parseMarketOpportunityRow(row as MarketOpportunityRow);
    },
  };
}

export function scanRefsIdentityJson(value: readonly MarketOpportunityScanRef[]): string {
  return stableStringify(value);
}
