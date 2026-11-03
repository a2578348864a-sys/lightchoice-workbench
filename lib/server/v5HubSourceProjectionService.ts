import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { readV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { getLarkConfig } from "@/lib/integrations/lark/config";
import {
  mapCustomerVoiceAttachmentsToV5HubRows,
  mapMonitoringRunToV5HubRow,
  mapV3KeywordAttachmentsToV5HubRows,
} from "@/lib/integrations/lark/v5HubProjection";
import {
  projectV5HubRecord,
  projectV5HubRecords,
  reconcileV5HubRecordsReadOnly,
} from "@/lib/integrations/lark/v5HubProjectionService";
import { V5_HUB_SCHEMA_VERSION } from "@/lib/integrations/lark/v5HubSchema";
import { createMonitoringRepository } from "@/lib/server/continuousMonitoringRepository";
import {
  requireOwnerContext,
  V5CoreError,
  withV5Receipt,
  hashJson,
} from "@/lib/server/v5CoreCommon";

function requireConfiguredTestBase() {
  const result = getLarkConfig();
  if (!result.ok) {
    throw new V5CoreError("FEISHU_CREDENTIAL_MISSING", `飞书投影配置缺失：${result.missingKeys.join(", ")}`, 503);
  }
  return result.config;
}

/** Read existing Canonical EvidenceStore keyword attachments and project them to T04 only. */
export async function projectV3KeywordEvidenceToV5Hub(input: {
  readonly context: AccessContext;
  readonly subjectKey: string;
  readonly idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const readback = await readV3ModuleEvidence({ context: input.context, subjectKey: input.subjectKey });
  const attachments = readback.evidenceStore?.attachments ?? [];
  const sourceEvidenceBinding = attachments
    .filter((attachment) => attachment.kind === "v3_reverse_asin_v1" || attachment.kind === "v3_keyword_mining_trend_v1")
    .map(({ attachmentId, contentHash, capturedAt }) => ({ attachmentId, contentHash, capturedAt }))
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  const rows = mapV3KeywordAttachmentsToV5HubRows({ subjectKey: input.subjectKey, attachments });
  if (rows.length === 0) {
    return { status: "NO_ELIGIBLE_EVIDENCE" as const, subjectKey: input.subjectKey, projections: [], replayed: false };
  }
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "feishu-hub:keyword-projection:v1",
    resourceKey: input.subjectKey,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      schemaVersion: V5_HUB_SCHEMA_VERSION,
      subjectKey: input.subjectKey,
      sourceEvidenceHash: hashJson(sourceEvidenceBinding),
      projectionHash: hashJson(rows),
    },
    reconcileProcessing: {
      staleAfterMs: 60_000,
      run: async () => {
        const config = requireConfiguredTestBase();
        const projections = await reconcileV5HubRecordsReadOnly({ config, tableId: "T04", rows });
        return projections ? { status: "PROJECTED" as const, subjectKey: input.subjectKey, projections } : null;
      },
    },
    execute: async () => {
      const config = requireConfiguredTestBase();
      const projections = await projectV5HubRecords({ config, tableId: "T04", rows });
      return { status: "PROJECTED" as const, subjectKey: input.subjectKey, projections };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

/** Read canonical Customer Voice attachments and project only count/provenance aggregates to T03. */
export async function projectCustomerVoiceEvidenceToV5Hub(input: {
  readonly context: AccessContext;
  readonly subjectKey: string;
  readonly idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const readback = await readV3ModuleEvidence({ context: input.context, subjectKey: input.subjectKey });
  const attachments = readback.evidenceStore?.attachments ?? [];
  const voiceAttachments = attachments.filter((attachment) => attachment.kind === "customer_voice_observation_v1");
  const sourceEvidenceBinding = voiceAttachments
    .map(({ attachmentId, contentHash, capturedAt }) => ({ attachmentId, contentHash, capturedAt }))
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  const rows = mapCustomerVoiceAttachmentsToV5HubRows({ subjectKey: input.subjectKey, attachments });
  if (rows.length === 0) {
    return { status: "NO_ELIGIBLE_EVIDENCE" as const, subjectKey: input.subjectKey, projections: [], replayed: false };
  }
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "feishu-hub:customer-voice-projection:v1",
    resourceKey: input.subjectKey,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      schemaVersion: V5_HUB_SCHEMA_VERSION,
      subjectKey: input.subjectKey,
      sourceEvidenceHash: hashJson(sourceEvidenceBinding),
      projectionHash: hashJson(rows),
    },
    reconcileProcessing: {
      staleAfterMs: 60_000,
      run: async () => {
        const config = requireConfiguredTestBase();
        const projections = await reconcileV5HubRecordsReadOnly({ config, tableId: "T03", rows });
        return projections ? { status: "PROJECTED" as const, subjectKey: input.subjectKey, projections } : null;
      },
    },
    execute: async () => {
      const config = requireConfiguredTestBase();
      const projections = await projectV5HubRecords({ config, tableId: "T03", rows });
      return { status: "PROJECTED" as const, subjectKey: input.subjectKey, projections };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

/** Project one finalized MonitoringRun; does not run or mutate Continuous Monitoring. */
export async function projectMonitoringRunToV5Hub(input: {
  readonly context: AccessContext;
  readonly monitoringRunId: string;
  readonly idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const repository = createMonitoringRepository();
  const run = await repository.getRun(input.monitoringRunId);
  if (!run) throw new V5CoreError("MONITORING_RUN_NOT_FOUND", "监控运行不存在。", 404);
  const watch = await repository.getWatch(run.watchTargetId);
  if (!watch) throw new V5CoreError("MONITORING_WATCH_NOT_FOUND", "监控目标不存在。", 404);
  const row = mapMonitoringRunToV5HubRow({ subjectKey: watch.subjectKey, watchTargetId: watch.id, run });
  if (!row) throw new V5CoreError("MONITORING_RUN_NOT_FINALIZED", "监控运行尚未结束，暂不可投影。", 409);
  const receipt = await withV5Receipt({
    context: input.context,
    operation: "feishu-hub:monitoring-projection:v1",
    resourceKey: input.monitoringRunId,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      schemaVersion: V5_HUB_SCHEMA_VERSION,
      monitoringRunId: input.monitoringRunId,
      sourceProjectionHash: hashJson(row.fields),
    },
    execute: async () => {
      const config = requireConfiguredTestBase();
      const projection = await projectV5HubRecord({ config, tableId: "T06", logicalKey: row.logicalKey, fields: row.fields });
      return { status: "PROJECTED" as const, monitoringRunId: run.id, subjectKey: watch.subjectKey, projection };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}
