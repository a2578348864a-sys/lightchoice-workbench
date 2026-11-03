import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { buildResearchFactSnapshot } from "@/lib/server/research/researchEngine";
import { getLarkConfig } from "@/lib/integrations/lark/config";
import { mapProductConceptToV5HubFields, mapProductFactToV5HubFields, mapResearchPacketToV5HubFields } from "@/lib/integrations/lark/v5HubProjection";
import { projectV5HubRecord, v5HubLogicalKey } from "@/lib/integrations/lark/v5HubProjectionService";
import { buildV5ResearchPacket } from "@/lib/server/research/researchPacketBuilder";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { prisma } from "@/lib/server/db";
import { hashJson, requireOwnerContext, V5CoreError, withV5Receipt } from "@/lib/server/v5CoreCommon";
import { parseProductConcept } from "@/lib/marketOpportunity/concept";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResearchProjectionInput = {
  readonly context: AccessContext;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly expectedReportHash: string;
  readonly expectedFactHash: string;
  readonly expectedEvidenceHash: string;
  readonly idempotencyKey: string;
};

async function assertProjectionClaims(input: Pick<ResearchProjectionInput, "context" | "taskId" | "expectedRevision" | "expectedReportHash" | "expectedFactHash" | "expectedEvidenceHash">) {
  const { getResearchDetail } = await import("@/lib/server/v5ResearchService");
  const detail = await getResearchDetail({ context: input.context, taskId: input.taskId });
  if (detail.stale || detail.researchRevision !== input.expectedRevision || detail.reportHash !== input.expectedReportHash
    || detail.factHash !== input.expectedFactHash || detail.evidenceHash !== input.expectedEvidenceHash) {
    throw new V5CoreError("REPORT_STALE", "研究来源或报告已变化，未向飞书发布当前投影。", 409, false, true);
  }
  const reason = claimConsumptionBlockReason(detail.claimAudit);
  if (reason) throw new V5CoreError("RESEARCH_CLAIMS_NOT_CONSUMABLE", claimConsumptionNotice(detail.claimAudit), 409);
  if (detail.claimAudit?.verdict === "NEEDS_DOWNGRADE") {
    throw new V5CoreError("RESEARCH_CLAIMS_REVIEW_REQUIRED", "研究仍有待降级表述，请先在本地复核；不向飞书发布为有效结论。", 409);
  }
}

async function prepareResearchProjection(input: ResearchProjectionInput) {
  const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: input.taskId } });
  if (!task || task.type !== "workflow") throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", "正式 Research 任务不存在。", 404);
  const root = JSON.parse(task.resultJson) as Record<string, unknown>;
  const state = isRecord(root.v5Research) ? root.v5Research : null;
  if (!state) throw new V5CoreError("RESEARCH_PACKET_INPUT_MISSING", "研究任务缺少版本化 Research 状态。", 409);
  if (state.researchRevision !== input.expectedRevision) throw new V5CoreError("RESEARCH_REVISION_STALE", "研究版本已变化，请刷新后重试。", 409, false, true);
  if (!isRecord(state.report) || state.reportHash !== input.expectedReportHash || hashJson(state.report) !== input.expectedReportHash) {
    throw new V5CoreError("REPORT_STALE", "Research 报告绑定已变化。", 409, false, true);
  }

  const configResult = getLarkConfig();
  if (!configResult.ok) throw new V5CoreError("FEISHU_CREDENTIAL_MISSING", `飞书投影凭据未配置：${configResult.missingKeys.join(", ")}`, 503, false);
  const bundle = await buildResearchInputBundle({ context: input.context, taskId: input.taskId, recordDiagnostic: false });
  if (!bundle.productFact || bundle.taskId !== input.taskId) {
    throw new V5CoreError("RESEARCH_PACKET_INPUT_MISSING", "ResearchInputBundle 缺少匹配任务的 ProductFact。", 409);
  }
  const expectedFactHash = hashJson(bundle.productFact);
  const expectedEvidenceHash = hashJson(bundle.sourceEvidenceRefs
    .map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
    .sort((left, right) => left.refId.localeCompare(right.refId)));
  if (state.factHash !== expectedFactHash || input.expectedFactHash !== expectedFactHash) {
    throw new V5CoreError("FACT_STALE", "ProductFact 绑定已变化，请刷新 Research 后重试。", 409, false, true);
  }
  if (state.evidenceHash !== expectedEvidenceHash || input.expectedEvidenceHash !== expectedEvidenceHash) {
    throw new V5CoreError("EVIDENCE_STALE", "EvidenceStore 绑定已变化，请刷新 Research 后重试。", 409, false, true);
  }

  await assertProjectionClaims(input);
  const packet = buildV5ResearchPacket({
    productFact: bundle.productFact,
    facts: buildResearchFactSnapshot(bundle.productFact),
    researchInputBundle: bundle,
    taskId: input.taskId,
    revision: input.expectedRevision,
    marketplace: String(state.marketplace ?? "US"),
    generatedAt: new Date().toISOString(),
  });
  return {
    context: input.context,
    config: configResult.config,
    taskId: input.taskId,
    researchRevision: input.expectedRevision,
    reportHash: input.expectedReportHash,
    researchFactHash: expectedFactHash,
    researchEvidenceHash: expectedEvidenceHash,
    conceptState: isRecord(root.productConceptV5) ? root.productConceptV5 : null,
    packet,
    packetFields: mapResearchPacketToV5HubFields(packet),
    productFields: mapProductFactToV5HubFields({
      productFact: bundle.productFact,
      packet,
      projectedAt: new Date().toISOString(),
    }),
  };
}

export type FeishuHubPacketBinding = {
  readonly schemaVersion: "v5-hub-packet-binding.v1";
  readonly subjectKey: string;
  readonly taskId: string;
  readonly revision: number;
  readonly packetHash: string;
  readonly reportHash: string;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly projectedAt: string;
  readonly recordId?: string;
  readonly status: "active";
  readonly provenance: "PROJECTION" | "VERIFIED_LEGACY_PROJECTION_BINDING";
};

async function projectPreparedResearch(prepared: Awaited<ReturnType<typeof prepareResearchProjection>>) {
  const recheck = () => assertProjectionClaims({ context: prepared.context, taskId: prepared.taskId,
    expectedRevision: prepared.researchRevision, expectedReportHash: prepared.reportHash,
    expectedFactHash: prepared.researchFactHash, expectedEvidenceHash: prepared.researchEvidenceHash });
  await recheck();
  const packetProjection = await projectV5HubRecord({
    config: prepared.config,
    tableId: "T02",
    logicalKey: prepared.packet.packetHash,
    fields: prepared.packetFields,
  });
  await recheck();
  const productProjection = await projectV5HubRecord({
    config: prepared.config,
    tableId: "T01",
    logicalKey: prepared.packet.subjectKey,
    fields: prepared.productFields,
  });

  const binding: FeishuHubPacketBinding = {
    schemaVersion: "v5-hub-packet-binding.v1",
    subjectKey: prepared.packet.subjectKey,
    taskId: prepared.taskId,
    revision: prepared.packet.revision,
    packetHash: prepared.packet.packetHash,
    reportHash: prepared.reportHash,
    factHash: prepared.packet.factHash,
    evidenceHash: prepared.packet.evidenceHash,
    projectedAt: new Date().toISOString(),
    recordId: packetProjection.recordId,
    status: "active",
    provenance: "PROJECTION",
  };

  if (!packetProjection.recordId) {
    throw new V5CoreError("FEISHU_PROJECTION_RECORD_ID_MISSING", "飞书 T02 数据包投影缺少远程 recordId，拒绝持久化绑定。", 502);
  }

  const task = await prisma.viralAnalysisRecord.findUnique({
    where: { id: prepared.taskId },
    select: { id: true, resultJson: true, updatedAt: true },
  });
  if (!task) {
    throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", `未找到任务 ${prepared.taskId}，无法持久化飞书绑定。`, 404);
  }
  const root = typeof task.resultJson === "string" ? JSON.parse(task.resultJson) : (task.resultJson || {});
  const state = isRecord(root.v5Research) ? root.v5Research : {};
  if (state.researchRevision !== prepared.researchRevision || state.reportHash !== prepared.reportHash
    || !isRecord(state.report) || hashJson(state.report) !== prepared.reportHash
    || state.factHash !== prepared.researchFactHash || state.evidenceHash !== prepared.researchEvidenceHash) {
    throw new V5CoreError("FEISHU_PACKET_BINDING_CAS_CONFLICT", "投影期间研究绑定已变化，请重新投影当前版本。", 409, false, true);
  }
  const nextState = { ...state, feishuHubPacketBinding: binding };
  const nextResultJson = JSON.stringify({ ...root, v5Research: nextState });
  const updated = await prisma.viralAnalysisRecord.updateMany({
    where: { id: task.id, updatedAt: task.updatedAt, resultJson: task.resultJson },
    data: { resultJson: nextResultJson, updatedAt: new Date() },
  });
  if (updated.count !== 1) {
    throw new V5CoreError("FEISHU_PACKET_BINDING_CAS_CONFLICT", "保存研究包飞书权威绑定并发冲突，请重试。", 409, false, true);
  }

  return {
    taskId: prepared.taskId,
    subjectKey: prepared.packet.subjectKey,
    packetHash: prepared.packet.packetHash,
    packetProjection,
    productProjection,
    packetStatus: prepared.packet.packetStatus,
    binding,
  };
}

async function projectResearchWithReceipt(
  input: ResearchProjectionInput,
  prepare: () => ReturnType<typeof prepareResearchProjection>,
) {
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "feishu-hub:research-projection",
    resourceKey: input.taskId,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      expectedRevision: input.expectedRevision,
      expectedReportHash: input.expectedReportHash,
      expectedFactHash: input.expectedFactHash,
      expectedEvidenceHash: input.expectedEvidenceHash,
    },
    execute: async () => projectPreparedResearch(await prepare()),
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

/** Build authoritative local inputs and project only to the fixed authorized Test Base. */
export async function projectResearchTaskToV5Hub(input: ResearchProjectionInput) {
  requireOwnerContext(input.context);
  return projectResearchWithReceipt(input, () => prepareResearchProjection(input));
}

/** Project a current V5 ProductConcept bound to the exact T02 Packet version. */
export async function projectProductConceptToV5Hub(input: ResearchProjectionInput) {
  requireOwnerContext(input.context);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "feishu-hub:concept-projection:v1",
    resourceKey: input.taskId,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      expectedRevision: input.expectedRevision,
      expectedReportHash: input.expectedReportHash,
      expectedFactHash: input.expectedFactHash,
      expectedEvidenceHash: input.expectedEvidenceHash,
    },
    execute: async () => {
      const prepared = await prepareResearchProjection(input);
      const conceptState = prepared.conceptState;
      if (!conceptState || !isRecord(conceptState.concept)) {
        throw new V5CoreError("PRODUCT_CONCEPT_REQUIRED", "当前 Research 尚无产品概念快照。", 409);
      }
      const concept = parseProductConcept(conceptState.concept);
      const currentBinding = {
        sourceType: "research_v5" as const,
        subjectKey: prepared.packet.subjectKey,
        researchTaskId: input.taskId,
        researchRevision: input.expectedRevision,
        reportHash: input.expectedReportHash,
        factHash: input.expectedFactHash,
        evidenceHash: input.expectedEvidenceHash,
        generatedAt: concept.sourceBinding?.generatedAt ?? new Date(0).toISOString(),
      };
      const fields = mapProductConceptToV5HubFields({
        concept,
        taskId: input.taskId,
        currentBinding,
        expectedPacketHash: prepared.packet.packetHash,
        projectedAt: new Date().toISOString(),
      });

      const research = await projectResearchWithReceipt(input, async () => prepared);
      await assertProjectionClaims(input);
      const projection = await projectV5HubRecord({
        config: prepared.config,
        tableId: "T05",
        logicalKey: v5HubLogicalKey("T05", fields),
        fields,
      });
      return {
        taskId: input.taskId,
        subjectKey: prepared.packet.subjectKey,
        conceptId: concept.conceptId,
        revision: concept.revision,
        packetHash: prepared.packet.packetHash,
        packetProjection: research.packetProjection,
        productProjection: research.productProjection,
        conceptProjection: projection,
      };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}
