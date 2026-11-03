import { prisma } from "@/lib/server/db";
import { requireOwnerContext, V5CoreError } from "@/lib/server/v5CoreCommon";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { buildVocProjection } from "@/lib/research/vocProjection";
import { buildCompetitorComparison } from "@/lib/research/competitorComparison";
import { buildOpportunityProjection } from "@/lib/research/opportunityProjection";
import { DEEP_RESEARCH_SCHEMA, type DeepResearchPayload } from "@/lib/research/deepResearchTypes";
import type { AccessContext } from "@/lib/server/accessPassword";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type RepresentativeInput = { asin: string; subjectKey: string; role: "benchmark" | "newcomer" | "pain_point"; note: string | null };
type SnapshotItemInput = { asin: string; subjectKey: string; capturedAt: string | null; factValues: unknown };

const ROLES = new Set(["benchmark", "newcomer", "pain_point"]);

function readRepresentatives(sampleDefinitionJson: string | null): RepresentativeInput[] {
  const definition = parseRecord(sampleDefinitionJson);
  const workflow = isRecord(definition.workflow) ? definition.workflow : {};
  const representatives = isRecord(workflow.representatives) ? workflow.representatives : {};
  const items = Array.isArray(representatives.items) ? representatives.items : [];
  const out: RepresentativeInput[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const asin = typeof item.asin === "string" ? item.asin.trim().toUpperCase() : "";
    const role = typeof item.role === "string" ? item.role : "";
    if (!/^[A-Z0-9]{10}$/u.test(asin) || !ROLES.has(role)) continue;
    const subjectKey = typeof item.subjectKey === "string" && item.subjectKey.trim()
      ? item.subjectKey.trim()
      : `amazon:US:${asin}`;
    out.push({
      asin,
      subjectKey,
      role: role as RepresentativeInput["role"],
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : null,
    });
  }
  return out;
}

function readSnapshotItems(sampleSnapshotJson: string | null): SnapshotItemInput[] {
  const snapshot = parseRecord(sampleSnapshotJson);
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const out: SnapshotItemInput[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const asin = typeof item.asin === "string" ? item.asin.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{10}$/u.test(asin)) continue;
    out.push({
      asin,
      subjectKey: typeof item.subjectKey === "string" && item.subjectKey.trim() ? item.subjectKey.trim() : `amazon:US:${asin}`,
      capturedAt: typeof item.capturedAt === "string" ? item.capturedAt : null,
      factValues: item.factValues ?? null,
    });
  }
  return out;
}

/**
 * 03 商品深研：只读深度分析投影。
 *
 * 组装顺序：任务/候选 → 市场来源（代表商品+快照）→ ResearchInputBundle（评论证据）→ 三个纯投影。
 * 不写 ProductFact / EvidenceStore / resultJson；不调用 AI；不改变任何研究或决策状态。
 */
export async function buildDeepResearchView(input: { context: AccessContext; taskId: string }): Promise<DeepResearchPayload> {
  requireOwnerContext(input.context);
  const taskId = input.taskId?.trim();
  if (!taskId) throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", "研究任务不存在。", 404);

  const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: taskId }, select: { id: true, type: true, resultJson: true } });
  if (!task || task.type !== "workflow") throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", "正式商品深研任务不存在。", 404);

  const root = parseRecord(task.resultJson);
  const candidateId = isRecord(root.candidateToTask) && typeof root.candidateToTask.candidateId === "string"
    ? root.candidateToTask.candidateId
    : typeof root.candidateId === "string" ? root.candidateId : null;
  const candidate = candidateId
    ? await prisma.opportunityCandidate.findUnique({ where: { id: candidateId }, select: { id: true, sourceMetaJson: true } })
    : null;
  const meta = parseRecord(candidate?.sourceMetaJson ?? null);
  const provenance = isRecord(root.marketProvenance) ? root.marketProvenance : isRecord(meta.marketProvenance) ? meta.marketProvenance : null;
  const scanId = provenance && typeof provenance.marketScanId === "string" ? provenance.marketScanId : null;

  const scan = scanId
    ? await prisma.marketScan.findUnique({
      where: { id: scanId },
      select: { id: true, scanName: true, sampleDefinitionJson: true, sampleSnapshotJson: true, archivedAt: true },
    })
    : null;

  const representatives = readRepresentatives(scan?.sampleDefinitionJson ?? null);
  const items = readSnapshotItems(scan?.sampleSnapshotJson ?? null);

  const bundle = await buildResearchInputBundle({ context: input.context, taskId, recordDiagnostic: false });
  const subjectKey = bundle.subjectKey;
  const observationCapturedAt = bundle.freshness.latestCapturedAt ?? "";
  const observations = (bundle.customerVoiceEvidence ?? []).map((group) => ({
    attachmentId: group.attachmentId,
    contentHash: group.contentHash,
    subjectKey,
    capturedAt: observationCapturedAt,
    source: group.source,
    observations: group.observations.map((observation) => ({
      externalContentId: observation.externalContentId,
      contentHash: observation.contentHash,
      source: observation.source,
      text: observation.text,
      title: observation.title,
      rating: observation.rating,
      publishedAt: observation.publishedAt,
      verifiedPurchase: observation.verifiedPurchase,
      contentType: observation.contentType,
      provenance: { sourceAttachmentId: observation.provenance?.sourceAttachmentId ?? null },
    })),
  }));
  const voc = buildVocProjection({ attachments: bundle.reviewEvidence ?? [], observations });
  const comparison = buildCompetitorComparison({
    scanId: scan?.id ?? null,
    scanName: scan?.scanName ?? null,
    representatives,
    items,
  });
  const opportunities = buildOpportunityProjection({ voc, comparison });

  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA,
    taskId,
    generatedAt: new Date().toISOString(),
    voc,
    comparison,
    opportunities,
  };
}

/** 供详情页选择「代表商品角色」展示用（不额外请求证据库）。 */
export async function readResearchMarketRole(input: { context: AccessContext; taskId: string }): Promise<string | null> {
  requireOwnerContext(input.context);
  const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: input.taskId }, select: { resultJson: true } });
  const root = parseRecord(task?.resultJson ?? null);
  const candidateId = isRecord(root.candidateToTask) && typeof root.candidateToTask.candidateId === "string" ? root.candidateToTask.candidateId : null;
  const candidate = candidateId ? await prisma.opportunityCandidate.findUnique({ where: { id: candidateId }, select: { sourceMetaJson: true } }) : null;
  const meta = parseRecord(candidate?.sourceMetaJson ?? null);
  const provenance = isRecord(root.marketProvenance) ? root.marketProvenance : isRecord(meta.marketProvenance) ? meta.marketProvenance : null;
  return provenance && typeof provenance.role === "string" ? provenance.role : null;
}
