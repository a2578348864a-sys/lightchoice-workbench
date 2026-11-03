import "server-only";

import { V5_HUB_TABLES, validateV5HubRemoteSchema } from "@/lib/integrations/lark/v5HubSchema";
import {
  LarkApiError,
  batchUpdateRecords,
  listTableFields,
  readBitableTextValue,
  searchTableRecords,
} from "@/lib/integrations/lark/baseClient";
import { getLarkConfig } from "@/lib/integrations/lark/config";
import {
  getV5HubConfig,
  V5HubConfigError,
  V5_HUB_TEST_BASE_TABLE_IDS,
} from "@/lib/integrations/lark/v5HubConfig";
import {
  type CanonicalDecisionStatus,
} from "@/lib/types/v5DecisionStatus";
import {
  parseV5HubPacketDecisionRecord,
  V5HubPacketDecisionRecordError,
  type V5HubPacketHumanDecision,
} from "@/lib/integrations/lark/v5HubPacketDecisionPull";
import {
  parseV5HubDecisionRecord,
  V5HubDecisionRecordError,
  type V5HubHumanDecision,
} from "@/lib/integrations/lark/v5HubDecisionPull";
import type { LarkConfig } from "@/lib/integrations/lark/types";
import { readProductConceptV5 } from "@/lib/server/productConceptV5Service";
import { prisma } from "@/lib/server/db";
import { mutateTaskResultJson, TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";
import type { AccessContext } from "@/lib/server/accessPassword";
import { hashJson, requireOwnerContext, V5CoreError, withV5Receipt } from "@/lib/server/v5CoreCommon";

function fail(code: string, message: string, status = 409): never {
  throw new V5CoreError(code, message, status, false, status === 409);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type T01MirrorResult =
  | { readonly status: "MIRROR_APPLIED"; readonly recordId: string; readonly decisionStatus: string; readonly beforeStatus: string }
  | { readonly status: "MIRROR_RECOVERED"; readonly recordId: string; readonly decisionStatus: string; readonly beforeStatus: string }
  | { readonly status: "MIRROR_UNCHANGED"; readonly recordId: string; readonly decisionStatus: string; readonly beforeStatus: string }
  | { readonly status: "MIRROR_FAILED"; readonly error: string; readonly subjectKey: string }
  | { readonly status: "MIRROR_SKIPPED_NOT_FOUND"; readonly subjectKey: string };

export type CompensatingItemRecord = {
  readonly taskId: string;
  readonly beforeLocalState: {
    readonly decisionStatus: string;
    readonly resultJson: string;
  } | null;
  readonly afterLocalState: {
    readonly decisionStatus: string;
    readonly canonicalStatus: CanonicalDecisionStatus;
    readonly choice: string;
  };
  readonly beforeT01State: {
    readonly recordId: string;
    readonly decisionStatus: string;
  } | null;
  readonly afterT01State: {
    readonly recordId: string;
    readonly decisionStatus: string;
  } | null;
  readonly t02RecordId: string;
};

/**
 * Reconciles T01 product record decision status with the authoritative human decision.
 * Executed on both APPLY and UNCHANGED paths to guarantee eventual mirror convergence.
 */
export async function ensureT01DecisionMirror(
  config: LarkConfig,
  decision: V5HubPacketHumanDecision,
  isFirstApply: boolean,
): Promise<T01MirrorResult> {
  const hubConfig = getV5HubConfig();
  const t01TableId = hubConfig.tables.T01;
  const targetT01Status = decision.status === "APPROVE" ? "PROCEED"
    : decision.status === "DROP" ? "REJECTED"
    : decision.status === "PAUSE" ? "PAUSED"
    : "NEED_INFO";

  try {
    const t01Records = await searchTableRecords({ ...config, tableId: t01TableId }, {
      fieldNames: ["主体键", "决策状态"],
      pageSize: 100,
    });
    const matchingT01 = t01Records.find(
      (r) => readBitableTextValue(r.fields["主体键"]) === decision.subjectKey,
    );
    if (!matchingT01) {
      return { status: "MIRROR_SKIPPED_NOT_FOUND", subjectKey: decision.subjectKey };
    }

    const currentT01Status = readBitableTextValue(matchingT01.fields["决策状态"]);
    if (currentT01Status === targetT01Status) {
      return { status: "MIRROR_UNCHANGED", recordId: matchingT01.record_id, decisionStatus: targetT01Status, beforeStatus: currentT01Status };
    }

    await batchUpdateRecords({ ...config, tableId: t01TableId }, [{
      record_id: matchingT01.record_id,
      fields: { "决策状态": targetT01Status },
    }]);

    return {
      status: isFirstApply ? "MIRROR_APPLIED" : "MIRROR_RECOVERED",
      recordId: matchingT01.record_id,
      decisionStatus: targetT01Status,
      beforeStatus: currentT01Status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "MIRROR_FAILED", error: message, subjectKey: decision.subjectKey };
  }
}

function validateConceptDecisionAgainstCurrent(
  decision: V5HubHumanDecision,
  current: Awaited<ReturnType<typeof readProductConceptV5>>,
): "APPLY" | "UNCHANGED" {
  const concept = current.concept;
  const binding = current.currentBinding;
  if (!concept || !binding || current.stale) fail("FEISHU_DECISION_CONCEPT_UNAVAILABLE", "本地当前产品概念或 Research 绑定不可用。");
  if (decision.taskId !== current.taskId
    || decision.conceptId !== concept.conceptId
    || decision.subjectKey !== binding.subjectKey
    || decision.conceptRevision !== concept.revision
    || decision.reportHash !== binding.reportHash
    || decision.factHash !== binding.factHash
    || decision.evidenceHash !== binding.evidenceHash
    || decision.packetHash !== current.packetHash) {
    fail("FEISHU_DECISION_BINDING_STALE", "飞书决策与本地当前 Concept、Research 或 Packet 绑定不一致。");
  }

  return "APPLY";
}

/** Pull validates team recommendations only. Human decisions and T01 mirrors are unchanged. */
export async function pullV5HubHumanDecisions(input: { readonly context: AccessContext; readonly idempotencyKey: string }) {
  requireOwnerContext(input.context);
  let hub: ReturnType<typeof getV5HubConfig>;
  try { hub = getV5HubConfig(); }
  catch (error) {
    if (error instanceof V5HubConfigError) fail(error.code, "飞书端建议配置未完成，仍可在 Workbench 保存本地决策。", 503);
    throw error;
  }
  const receipt = await withV5Receipt({ context: input.context, operation: "feishu-hub:team-recommendation-pull:v2",
    resourceKey: hub.baseId, idempotencyKey: input.idempotencyKey, requestBody: { schemaVersion: "v5-team-recommendation-pull.v2" }, execute: async () => {
      const result = getLarkConfig();
      if (!result.ok) fail("FEISHU_CREDENTIAL_MISSING", "飞书凭据未配置。", 503);
      const config = result.config;
      if (config.appToken !== hub.baseId) fail("V5_HUB_WRONG_BASE", "飞书端建议仅允许配置的 Feishu Base。", 403);
      const received: string[] = [], unchanged: string[] = [], failedConceptRecordIds: string[] = [];
      const conceptFailureDetails: Array<{ recordId: string; errorCode: string }> = [];
      let scanned = 0, pendingReview = 0, packetPending = 0, conceptPending = 0, conceptScanned = 0, conceptStatus = "NOT_CONFIGURED";
      const seenRecords = new Set<string>(), seenTasks = new Set<string>();
      const prepared: Array<{ task: { id: string; updatedAt: Date; resultJson: string }; state: Record<string, unknown>; namespace: "teamRecommendation" | "conceptTeamRecommendation"; recommendation: Record<string, unknown> }> = [];
      const statusOf = (status: V5HubPacketHumanDecision["status"]) => status === "APPROVE" ? "RECOMMEND_PROCEED" : status === "VALIDATE_MORE" ? "RECOMMEND_VALIDATE_MORE" : status === "PAUSE" ? "RECOMMEND_PAUSE" : "RECOMMEND_DROP";
      const prepare = async (decision: V5HubPacketHumanDecision | V5HubHumanDecision, kind: "RESEARCH" | "CONCEPT") => {
        const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: decision.taskId } });
        if (!task || task.type !== "workflow") fail("FEISHU_DECISION_TASK_NOT_FOUND", "Research 任务不存在。");
        const root = JSON.parse(task.resultJson), state = isRecord(root.v5Research) ? root.v5Research : null;
        if (!state || !isRecord(state.report) || typeof state.reportHash !== "string" || hashJson(state.report) !== state.reportHash) fail("RESEARCH_REPORT_REQUIRED", "飞书端建议必须绑定已有正式研究报告。");
        const detail = await (await import("@/lib/server/v5ResearchService")).getResearchDetail({ context: input.context, taskId: task.id });
        if (detail.reportStale) fail("RESEARCH_EVIDENCE_STALE", "研究证据已变化，暂不能接收该飞书端建议。");
        let binding: Record<string, unknown>;
        if (kind === "RESEARCH") {
          const packet = decision as V5HubPacketHumanDecision;
          const active = isRecord(state.feishuHubPacketBinding) ? state.feishuHubPacketBinding : null;
          if (!active || active.schemaVersion !== "v5-hub-packet-binding.v1" || active.status !== "active") fail("FEISHU_DECISION_PACKET_BINDING_MISSING", "缺少当前权威研究包绑定。");
          if (packet.taskId !== active.taskId || packet.subjectKey !== active.subjectKey || packet.revision !== active.revision
            || active.reportHash !== state.reportHash
            || packet.packetHash !== active.packetHash || packet.factHash !== active.factHash || packet.evidenceHash !== active.evidenceHash
            || state.researchRevision !== active.revision || state.factHash !== active.factHash
            || packet.asin !== state.asin || packet.marketplace !== state.marketplace
            || (active.recordId && packet.recordId !== active.recordId)) fail("FEISHU_DECISION_BINDING_STALE", "飞书端建议与当前研究包绑定不一致。");
          binding = { reportHash: state.reportHash, factHash: state.factHash, evidenceHash: state.evidenceHash, researchRevision: state.researchRevision, packetHash: packet.packetHash, packetEvidenceHash: packet.evidenceHash, subjectKey: packet.subjectKey };
        } else {
          const conceptDecision = decision as V5HubHumanDecision;
          const current = await readProductConceptV5({ context: input.context, taskId: task.id });
          validateConceptDecisionAgainstCurrent(conceptDecision, current);
          binding = { reportHash: state.reportHash, factHash: state.factHash, evidenceHash: state.evidenceHash, researchRevision: state.researchRevision,
            packetHash: conceptDecision.packetHash, subjectKey: conceptDecision.subjectKey, conceptId: conceptDecision.conceptId, conceptRevision: conceptDecision.conceptRevision };
        }
        const payload = { kind, recommendationStatus: statusOf(decision.status), reason: decision.reason,
          personalReview: "personalReview" in decision ? (decision.personalReview ?? null) : null,
          reviewerIdentity: decision.reviewerIdentity, reviewedAt: decision.reviewedAt, bindingHashes: binding,
          source: { kind: "feishu_hub", baseId: config.appToken, recordId: decision.recordId } };
        const id = hashJson(payload), namespace = kind === "RESEARCH" ? "teamRecommendation" : "conceptTeamRecommendation";
        const existing = isRecord(state[namespace]) ? state[namespace] : null;
        if (existing?.id === id) { unchanged.push(decision.recordId); return; }
        if (typeof existing?.reviewedAt === "string" && existing.reviewedAt > decision.reviewedAt) fail("TEAM_RECOMMENDATION_STALE", "拒绝旧版本飞书端建议覆盖当前建议。");
        prepared.push({ task, state, namespace, recommendation: { ...payload, id, status: "VERIFIED_TEAM_RECOMMENDATION", receivedAt: new Date().toISOString() } });
      };
      const readRecords = async (tableId: "T02" | "T05") => {
        const table = V5_HUB_TABLES.find(row => row.id === tableId);
        if (!table) fail("V5_HUB_SCHEMA_MISSING", "Hub 表契约不存在。", 500);
        const fields = await listTableFields({ ...config, tableId: hub.tables[tableId] });
        if (!validateV5HubRemoteSchema(tableId, fields).isValid) fail("V5_HUB_SCHEMA_DRIFT", "Hub 表结构与字段契约不一致。");
        return searchTableRecords({ ...config, tableId: hub.tables[tableId] }, { fieldNames: table.fields.map(field => field.displayName), pageSize: 100, automaticFields: true, userIdType: "open_id" });
      };
      let packets;
      try { packets = await readRecords("T02"); }
      catch (error) { if (error instanceof LarkApiError) fail("FEISHU_DECISION_READ_FAILED", "飞书端建议读取失败。", error.status === 403 ? 403 : error.status === 429 ? 429 : 503); throw error; }
      scanned += packets.length;
      for (const record of packets) {
        if (!record.record_id || seenRecords.has("T02:" + record.record_id)) fail("FEISHU_DECISION_DUPLICATE_RECORD", "T02 记录 ID 缺失或重复。");
        seenRecords.add("T02:" + record.record_id);
        let decision;
        try { decision = parseV5HubPacketDecisionRecord(record); } catch (error) { if (error instanceof V5HubPacketDecisionRecordError) fail(error.code, "T02 建议或审核身份不可验证。"); throw error; }
        if (!decision) { pendingReview++; packetPending++; continue; }
        if (seenTasks.has("T02:" + decision.taskId)) fail("FEISHU_DECISION_DUPLICATE_TASK", "同一任务存在多条 T02 建议。");
        seenTasks.add("T02:" + decision.taskId); await prepare(decision, "RESEARCH");
      }
      try {
        const concepts = await readRecords("T05"); conceptStatus = "AVAILABLE"; conceptScanned = concepts.length; scanned += concepts.length;
        for (const record of concepts) {
          try {
            if (!record.record_id || seenRecords.has("T05:" + record.record_id)) fail("FEISHU_DECISION_DUPLICATE_RECORD", "T05 记录 ID 缺失或重复。");
            seenRecords.add("T05:" + record.record_id);
            const decision = parseV5HubDecisionRecord(record);
            if (!decision) { pendingReview++; conceptPending++; continue; }
            if (seenTasks.has("T05:" + decision.taskId)) fail("FEISHU_DECISION_DUPLICATE_TASK", "同一任务存在多条 T05 建议。");
            seenTasks.add("T05:" + decision.taskId); await prepare(decision, "CONCEPT");
          } catch (error) { failedConceptRecordIds.push(record.record_id); conceptFailureDetails.push({ recordId: record.record_id, errorCode: error instanceof V5CoreError || error instanceof V5HubDecisionRecordError ? error.code : "CONCEPT_RECOMMENDATION_FAILED" }); }
        }
      } catch (error) { conceptStatus = "UNAVAILABLE"; console.info("[team-recommendation] optional T05 unavailable", { code: error instanceof V5CoreError ? error.code : "T05_READ_FAILED" }); }
      // Only the pending projection is written. CAS never changes Human Decision fields.
      const groups = new Map<string, typeof prepared>();
      for (const item of prepared) groups.set(item.task.id, [...(groups.get(item.task.id) ?? []), item]);
      for (const items of groups.values()) {
        const first = items[0], changes = Object.fromEntries(items.map(item => [item.namespace, item.recommendation]));
        try {
          await mutateTaskResultJson({ context: input.context, taskId: first.task.id, writer: "feishu-hub-decision",
            expectedStorageVersion: { updatedAt: first.task.updatedAt, resultJson: first.task.resultJson },
            mutate: current => ({ result: { ...current, v5Research: { ...first.state, ...changes } }, value: null }) });
        } catch (error) { if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") fail("CHOICE_CAS_CONFLICT", "飞书端建议保存并发冲突，请刷新重试。"); throw error; }
        received.push(...items.map(item => (item.recommendation.source as Record<string, unknown>).recordId as string));
      }
      const accounted = received.length + unchanged.length + pendingReview + failedConceptRecordIds.length;
      if (scanned !== accounted) fail("PULL_STATS_RECONCILIATION_ERROR", "飞书端建议扫描统计对账失败。");
      return { scannedRecords: scanned, recommendationsReceived: received.length, recommendationRecordIds: received, unchanged: unchanged.length,
        pendingReview, failedOrSkipped: failedConceptRecordIds.length, unaccounted: 0, applied: 0, appliedRecordIds: [], appliedConceptRecordIds: [], appliedItems: [] as CompensatingItemRecord[], mirrorResults: [] as T01MirrorResult[],
        mirrorStatus: "NOT_APPLICABLE_PULL_DOES_NOT_APPLY", unchangedRecordIds: unchanged, failedConceptRecordIds, conceptFailureDetails, conceptStatus,
        packetDecisions: { scanned: packets.length, found: [...seenTasks].filter(id => id.startsWith("T02:")).length, recommendationsReceived: prepared.filter(item => item.namespace === "teamRecommendation").length, applied: [] as string[], unchanged: unchanged.filter(id => seenRecords.has("T02:" + id)), pendingReview: packetPending },
        conceptDecisions: { scanned: conceptScanned, found: [...seenTasks].filter(id => id.startsWith("T05:")).length, recommendationsReceived: prepared.filter(item => item.namespace === "conceptTeamRecommendation").length, applied: [] as string[], unchanged: unchanged.filter(id => seenRecords.has("T05:" + id)), failed: failedConceptRecordIds, pendingReview: conceptPending },
        decisions: seenTasks.size,
        breakdown: { scanned, recommendationsReceived: received.length, applied: 0, unchanged: unchanged.length, pendingReview, failedOrSkipped: failedConceptRecordIds.length, unaccounted: 0 } };
    } });
  return { ...receipt.value, receiptId: receipt.receiptId, replayed: receipt.replayed };
}

/**
 * Safe receipt-scoped compensation for a previously applied Feishu Hub Decision Pull.
 *
 * Rules:
 * - BLANKET_PENDING_RESET = FORBIDDEN: Restores T01 mirror to exact beforeT01State.decisionStatus.
 * - COMPENSATION_RESTORES_BEFORE_STATE = YES: Restores local ViralAnalysisRecord to exact beforeLocalState.
 * - MISSING_BEFORE_STATE_AUTO_COMPENSATION = FORBIDDEN: Fails closed if any record lacks a valid beforeState.
 * - Scoped strictly to the records affected by the target receipt.
 */
export async function compensateV5HubDecisionPullReceipt(input: {
  readonly context: AccessContext;
  readonly receiptId: string;
}) {
  requireOwnerContext(input.context);
  const receipt = await prisma.v5OperationReceipt.findUnique({
    where: { id: input.receiptId },
  });
  if (!receipt) {
    fail("RECEIPT_NOT_FOUND", `未找到回执记录: ${input.receiptId}`, 404);
  }
  if (!receipt.responseJson) {
    fail("RECEIPT_DATA_EMPTY", "回执无有效返回数据。", 400);
  }
  const data = JSON.parse(receipt.responseJson);

  // BLOCKER-2: Fail-closed verification for T05 Concept Decision compensation
  const appliedConceptRecordIds: readonly string[] = Array.isArray(data.appliedConceptRecordIds)
    ? data.appliedConceptRecordIds
    : (Array.isArray(data.conceptDecisions?.applied) ? data.conceptDecisions.applied : []);
  if (appliedConceptRecordIds.length > 0) {
    fail(
      "COMPENSATION_SCOPE_UNSUPPORTED_T05",
      "该 Pull 包含 Product Concept / T05 决策写入，当前 R0 自动补偿仅支持 T02 + T01，禁止自动回滚，需人工审计。",
      409,
    );
  }

  const appliedItems: readonly CompensatingItemRecord[] = Array.isArray(data.appliedItems) ? data.appliedItems : [];
  if (appliedItems.length === 0) {
    return {
      compensated: true,
      receiptId: input.receiptId,
      recordsRestored: 0,
      t01MirrorsRestored: 0,
      details: [],
    };
  }

  // Fail-closed verification: every record MUST have valid beforeState
  for (const item of appliedItems) {
    if (!item.beforeLocalState || typeof item.beforeLocalState.decisionStatus !== "string" || !item.beforeLocalState.resultJson) {
      fail("MISSING_BEFORE_STATE_AUTO_COMPENSATION", `任务 ${item.taskId} 缺失操作前本地状态快照，禁止自动补偿，已转入人工对账。`, 409);
    }
  }

  const larkConfigResult = getLarkConfig();
  const hubConfig = getV5HubConfig();

  // BLOCKER-1: Current-State CAS Precheck (PRECHECK ALL TARGETS -> ALL SAFE -> THEN APPLY RESTORE)
  type PrecheckedLocalSnapshot = {
    readonly taskId: string;
    readonly decisionStatus: string;
    readonly canonicalStatus: string | null;
    readonly choice: string | null;
    readonly updatedAt: Date;
    readonly resultJson: string;
  };
  const precheckedSnapshots = new Map<string, PrecheckedLocalSnapshot>();

  // 1. Precheck all Local records
  for (const item of appliedItems) {
    const currentTask = await prisma.viralAnalysisRecord.findUnique({
      where: { id: item.taskId },
      select: { id: true, decisionStatus: true, resultJson: true, updatedAt: true },
    });
    if (!currentTask) {
      fail("COMPENSATION_STATE_DIVERGED", `任务 ${item.taskId} 不存在，状态已漂移，禁止补偿。`, 409);
    }

    let currentCanonical: string | null = null;
    let currentChoice: string | null = null;
    if (typeof currentTask.resultJson === "string") {
      try {
        const parsed = JSON.parse(currentTask.resultJson);
        currentCanonical = parsed?.v5Research?.myChoice?.canonicalStatus ?? null;
        currentChoice = parsed?.v5Research?.myChoice?.choice ?? null;
      } catch {
        // ignore parse error
      }
    }

    const expectedDecisionStatus = item.afterLocalState.decisionStatus;
    const expectedCanonical = item.afterLocalState.canonicalStatus;
    const expectedChoice = item.afterLocalState.choice;

    if (
      currentTask.decisionStatus !== expectedDecisionStatus ||
      currentCanonical !== expectedCanonical ||
      currentChoice !== expectedChoice
    ) {
      fail(
        "COMPENSATION_STATE_DIVERGED",
        `任务 ${item.taskId} 当前决策状态 (status: ${currentTask.decisionStatus}, canonical: ${currentCanonical}, choice: ${currentChoice}) 与回执记录的 afterLocalState (status: ${expectedDecisionStatus}, canonical: ${expectedCanonical}, choice: ${expectedChoice}) 不一致，状态已漂移，禁止补偿覆盖后来的新决策。`,
        409,
      );
    }

    precheckedSnapshots.set(item.taskId, {
      taskId: item.taskId,
      decisionStatus: currentTask.decisionStatus,
      canonicalStatus: currentCanonical,
      choice: currentChoice,
      updatedAt: currentTask.updatedAt,
      resultJson: currentTask.resultJson,
    });
  }

  // 2. Precheck all T01 records
  const itemsWithT01 = appliedItems.filter((i) => i.afterT01State?.recordId && i.afterT01State?.decisionStatus);
  if (itemsWithT01.length > 0) {
    if (!larkConfigResult.ok) {
      fail("T01_COMPENSATION_STATE_DIVERGED", "飞书配置不可用，无法校验 T01 镜像当前状态，禁止补偿。", 409);
    }
    const t01Records = await searchTableRecords(
      { ...larkConfigResult.config, tableId: hubConfig.tables.T01 },
      { fieldNames: ["主体键", "决策状态"], pageSize: 100 },
    );
    for (const item of itemsWithT01) {
      const matchingT01 = t01Records.find((r) => r.record_id === item.afterT01State!.recordId);
      if (!matchingT01) {
        fail("T01_COMPENSATION_STATE_DIVERGED", `T01 镜像记录 ${item.afterT01State!.recordId} 不存在，状态已漂移，禁止补偿。`, 409);
      }
      const currentT01Status = readBitableTextValue(matchingT01.fields["决策状态"]);
      if (currentT01Status !== item.afterT01State!.decisionStatus) {
        fail(
          "T01_COMPENSATION_STATE_DIVERGED",
          `T01 记录 ${item.afterT01State!.recordId} 当前决策状态 (${currentT01Status}) 与回执记录的 afterT01State (${item.afterT01State!.decisionStatus}) 不一致，状态已漂移，禁止补偿覆盖后来的新决策。`,
          409,
        );
      }
    }
  }

  // --- RESTORE PHASE: All targets safe, apply restoration with CAS updateMany ---
  let t01RestoredCount = 0;
  let localRestoredCount = 0;
  const compensationLogs = [];

  for (const item of appliedItems) {
    const prechecked = precheckedSnapshots.get(item.taskId);
    if (!prechecked) {
      fail("COMPENSATION_STATE_DIVERGED", `任务 ${item.taskId} 缺失预检快照，禁止补偿。`, 409);
    }

    // 1. Restore local task with write-time CAS binding prechecked updatedAt & resultJson
    try {
      const previousRoot = JSON.parse(item.beforeLocalState!.resultJson) as Record<string, unknown>;
      await mutateTaskResultJson({ context: input.context, taskId: item.taskId, writer: "feishu-hub-decision",
        expectedStorageVersion: { resultJson: prechecked.resultJson, updatedAt: prechecked.updatedAt },
        mutate: (current, snapshot) => {
          if (snapshot.decisionStatus !== prechecked.decisionStatus) fail("COMPENSATION_STATE_DIVERGED", "恢复前决策状态已变化。", 409);
          return { result: { ...current, v5Research: previousRoot.v5Research }, decisionStatus: item.beforeLocalState!.decisionStatus, value: null };
        },
      });
    } catch (error) {
      if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") fail("COMPENSATION_STATE_DIVERGED", "本地恢复发生并发冲突，已中止。", 409);
      throw error;
    }
    localRestoredCount++;

    // 2. Restore T01 mirror without blanket PENDING reset
    if (larkConfigResult.ok && item.beforeT01State?.recordId && item.beforeT01State?.decisionStatus) {
      await batchUpdateRecords(
        { ...larkConfigResult.config, tableId: hubConfig.tables.T01 },
        [{
          record_id: item.beforeT01State.recordId,
          fields: { "决策状态": item.beforeT01State.decisionStatus },
        }],
      );
      t01RestoredCount++;
    }

    compensationLogs.push({
      taskId: item.taskId,
      restoredLocalDecisionStatus: item.beforeLocalState!.decisionStatus,
      restoredT01DecisionStatus: item.beforeT01State?.decisionStatus ?? null,
    });
  }

  return {
    compensated: true,
    receiptId: input.receiptId,
    recordsRestored: localRestoredCount,
    t01MirrorsRestored: t01RestoredCount,
    details: compensationLogs,
  };
}
