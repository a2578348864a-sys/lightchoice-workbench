import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { appendAmazonSearchProductBatch, readVerifiedAmazonSearchEvidence, type AmazonSearchEvidenceCheckpointRef } from "@/lib/server/amazonSearchProductBatchHandoff";
import { getBatchCaptureRunExecutor } from "@/lib/server/batchCaptureRunExecutor";
import { resolveBatchSearchNavigationUsed } from "@/lib/server/batchCaptureSearchNavigation";
import { collectAmazonSearchWithPlaywright, type AmazonSearchPageCheckpoint } from "@/lib/server/captureRecipeBrowser";
import { prisma } from "@/lib/server/db";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { createProductBatchRepository } from "@/lib/server/productBatchRepository";
import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { hashJson, V5CoreError } from "@/lib/server/v5CoreCommon";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { deriveMarketCaptureExpansionCounts, type MarketCaptureExpansionPreview } from "@/lib/sourceLayer/captureStrategy/marketCaptureExpansion";
import { HARD_MAX_AUTHORIZED_ITEMS } from "@/lib/sourceLayer/captureBudgetConstants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNER_SCOPE = "owner:v1";
const EXPANSION_OPERATION = "source-layer:market-capture-expansion:v1";
const EXPANSION_LOCK_OPERATION = "source-layer:market-capture-expansion-lock:v1";
const ACTIVE_LOCK_KEY = "active";
const service = createBatchCaptureRunService({ database: prisma as never });
const productBatchRepository = createProductBatchRepository();

type ExpansionLockCheckpoint = {
  [key: string]: unknown;
  authorizationId: string;
  owner?: { host: string; pid: number } | null;
  stage?: string;
  startedAt?: string;
  batchId?: string;
};

function parseExpansionLockCheckpoint(value: string | null | undefined): ExpansionLockCheckpoint | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.authorizationId !== "string") return null;
    const ownerValue = record.owner;
    const owner = ownerValue && typeof ownerValue === "object" && !Array.isArray(ownerValue)
      ? ownerValue as { host?: unknown; pid?: unknown }
      : null;
    return {
      ...record,
      authorizationId: record.authorizationId,
      owner: owner && typeof owner.host === "string" && Number.isSafeInteger(owner.pid)
        ? { host: owner.host, pid: owner.pid as number }
        : null,
      stage: typeof record.stage === "string" ? record.stage : "unknown",
      startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
      batchId: typeof record.batchId === "string" ? record.batchId : undefined,
    };
  } catch {
    return null;
  }
}

function processIsDefinitelyGone(owner: ExpansionLockCheckpoint["owner"]): boolean {
  if (!owner || owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as Error & { code?: unknown }).code === "ESRCH";
  }
}

async function readActiveExpansionLock(batchId: string) {
  return prisma.v5OperationReceipt.findUnique({
    where: { actorScope_operation_resourceKey_idempotencyKey: {
      actorScope: OWNER_SCOPE,
      operation: EXPANSION_LOCK_OPERATION,
      resourceKey: batchId,
      idempotencyKey: ACTIVE_LOCK_KEY,
    } },
  });
}

async function updateBatchExpansionLockStage(input: { id: string; authorizationId: string; stage: string; extra?: Record<string, unknown> }): Promise<void> {
  const current = await prisma.v5OperationReceipt.findUnique({ where: { id: input.id } });
  if (!current || current.status !== "processing" || current.requestHash !== input.authorizationId) return;
  const checkpoint = parseExpansionLockCheckpoint(current.responseJson);
  if (!checkpoint || checkpoint.authorizationId !== input.authorizationId) return;
  await prisma.v5OperationReceipt.updateMany({
    where: { id: input.id, status: "processing", requestHash: input.authorizationId, updatedAt: current.updatedAt },
    data: { responseJson: JSON.stringify({ ...checkpoint, ...input.extra, stage: input.stage }), updatedAt: new Date() },
  });
}

async function inspectExpansionRecovery(input: { batchId: string; authorizationId?: string; run: Awaited<ReturnType<typeof service.status>> }) {
  const lock = await readActiveExpansionLock(input.batchId);
  const checkpoint = parseExpansionLockCheckpoint(lock?.responseJson);
  if (!lock || !checkpoint) return { available: false, reason: "未发现可检查的扩充锁。" };
  if (lock.status === "recovery_required") return {
    available: false,
    recoveryRequired: true,
    manualReviewRequired: true,
    authorizationId: checkpoint.authorizationId,
    stage: checkpoint.stage ?? "unknown",
    reason: "扩充进程已退出，但来源访问或检查点证据无法完整核验；系统保留批次锁等待人工对账，不会重复搜索。",
  };
  const explicitlyQueuedForRecovery = lock.status === "recovery_pending";
  if (lock.status !== "processing" && !explicitlyQueuedForRecovery) return { available: false, reason: "未发现处理中或待人工恢复的扩充锁。" };
  if (input.authorizationId && checkpoint.authorizationId !== input.authorizationId) return { available: false, reason: "扩充锁编号与请求不一致。" };
  if (!explicitlyQueuedForRecovery && !processIsDefinitelyGone(checkpoint.owner)) return { available: false, reason: "无法证明原扩充进程已在本机退出；保持锁定。" };
  if (input.run && getBatchCaptureRunExecutor().isRunning(input.run.runId)) return { available: false, reason: "Run 执行器仍在本机运行；保持锁定。" };
  const expansionAlreadyStarted = Boolean(input.run?.authorizationLedger?.some((entry) => entry.authorizationId === checkpoint.authorizationId));
  if (input.run && ["RUNNING", "WAITING"].includes(input.run.status) && !expansionAlreadyStarted) return { available: false, reason: "旧 Run 仍是活动或等待状态；先按执行器恢复流程核实，不解除扩充锁。" };
  if (input.run?.expansionLock && input.run.expansionLock.authorizationId !== checkpoint.authorizationId) return { available: false, reason: "Run 锁归属与扩充操作回执不一致；需人工核对。" };
  return {
    available: true,
    authorizationId: checkpoint.authorizationId,
    stage: checkpoint.stage ?? "unknown",
    ownerPid: checkpoint.owner?.pid ?? null,
    ownerHost: checkpoint.owner?.host ?? null,
    recoveryPending: explicitlyQueuedForRecovery,
    requiresProfileConfirmation: true,
    message: "原服务进程已退出且 Run 执行器未运行。请先确认 Amazon 专用浏览器和 Profile 已关闭，再执行人工恢复；不会删除历史回执或锁文件。",
  };
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function requireBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "必须提供有效的 batchId。", 400);
  }
  return value.trim();
}

function requireTargetTotal(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)
    || parsed < 1 || parsed > HARD_MAX_AUTHORIZED_ITEMS) {
    throw new V5CoreError("CAPTURE_EXPANSION_TARGET_INVALID", `目标总数必须是 1–${HARD_MAX_AUTHORIZED_ITEMS} 的整数。`, 400);
  }
  return parsed;
}

function requireAuthorizationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{12,80}$/u.test(value.trim())) {
    throw new V5CoreError("CAPTURE_EXPANSION_AUTHORIZATION_ID_INVALID", "扩充确认编号无效。", 400);
  }
  return value.trim();
}

function sourceTypeOf(batch: { normalizedSnapshotJson: string | null }): string | null {
  try {
    const parsed: unknown = JSON.parse(batch.normalizedSnapshotJson ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sourceType = (parsed as Record<string, unknown>).sourceType;
    return typeof sourceType === "string" ? sourceType : null;
  } catch {
    return null;
  }
}

async function loadPreview(input: {
  context: Parameters<typeof getProductBatchStore>[0];
  batchId: string;
  targetTotal: number;
}): Promise<MarketCaptureExpansionPreview> {
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(input.batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "商品批次不存在。", 404);
  if (batch.batchStatus !== "ready" || batch.reportType !== "search_results"
    || sourceTypeOf(batch) !== "amazon_search_capture") {
    throw new V5CoreError("CAPTURE_EXPANSION_BATCH_UNSUPPORTED", "只支持扩充已就绪的 Amazon Search 商品批次。", 409);
  }
  const items = await store.getBatchItems(input.batchId);
  const activeItems = items.filter((item) => !item.archivedAt && typeof item.asin === "string"
    && /^[A-Z0-9]{10}$/iu.test(item.asin.trim()));
  const currentAsins = [...new Set(activeItems.map((item) => item.asin!.trim().toUpperCase()))];
  const verified = await readVerifiedAmazonSearchEvidence({ context: input.context, items: activeItems });
  const navigation = resolveBatchSearchNavigationUsed(batch);
  const run = await service.status({ context: input.context, batchId: input.batchId });
  const detailCompletedAsins = run?.cells
    .filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded"
      && cell.sourceVerified && cell.fieldComplete)
    .map((cell) => cell.asin) ?? [];
  const counts = deriveMarketCaptureExpansionCounts({
    currentAsins,
    authorizedAsins: run?.authorizedAsins ?? [],
    targetTotal: input.targetTotal,
    searchNavigationUsed: navigation.known ? navigation.used : null,
    validEvidenceCount: verified.length,
    detailCompletedAsins,
    run: run ? {
      runId: run.runId,
      runGeneration: run.runGeneration,
      version: run.version,
      status: run.status,
      executionEpoch: run.executionEpoch,
      acknowledgedEpoch: run.acknowledgedEpoch,
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      expansionInProgress: Boolean(run.expansionLock),
    } : null,
  });
  const planFingerprint = hashJson({
    schemaVersion: "market-capture-expansion-plan.v1",
    batchId: batch.id,
    batchUpdatedAt: batch.updatedAt,
    batchSourceSha256: batch.sourceFileSha256,
    currentAsins: currentAsins.slice().sort(),
    verifiedEvidence: verified.slice().sort((a, b) => a.asin.localeCompare(b.asin)),
    targetTotal: input.targetTotal,
    searchNavigationKnown: navigation.known,
    searchNavigationUsed: navigation.known ? navigation.used : null,
    run: run ? {
      runId: run.runId,
      runGeneration: run.runGeneration,
      version: run.version,
      status: run.status,
      authorizedAsins: run.authorizedAsins.slice().sort(),
      executionEpoch: run.executionEpoch,
      acknowledgedEpoch: run.acknowledgedEpoch,
      expansionLock: run.expansionLock?.authorizationId ?? null,
    } : null,
  });
  return { batchId: batch.id, ...counts, planFingerprint };
}

function blockerResponse(preview: MarketCaptureExpansionPreview): { code: string; message: string } | null {
  switch (preview.blocker) {
    case "run_missing": return { code: "BATCH_CAPTURE_RUN_NOT_FOUND", message: "请先确认当前批次的原始采集计划，再扩充商品。" };
    case "run_state_unknown": return { code: "BATCH_CAPTURE_RUN_STATE_UNKNOWN", message: "无法确认当前任务状态，暂不能扩充。" };
    case "run_still_running": return { code: "BATCH_CAPTURE_RUN_STILL_ACTIVE", message: "当前任务仍在运行或等待执行；请先让它完成，或暂停并等待执行器确认退出。" };
    case "executor_not_confirmed_stopped": return { code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN", message: "执行器尚未确认退出；扩充已阻止，请等待退出确认或按既有流程人工核实。" };
    case "target_below_current_scope": return { code: "CAPTURE_EXPANSION_TARGET_BELOW_CURRENT", message: "目标总数不能小于当前商品数或既有授权范围。" };
    case "target_not_greater_than_current": return { code: "CAPTURE_EXPANSION_NOOP", message: "目标总数与当前批次相同，无需扩充。" };
    case "target_limit_exceeded": return { code: "CAPTURE_EXPANSION_TARGET_INVALID", message: `目标总数必须在 1–${HARD_MAX_AUTHORIZED_ITEMS} 件范围内。` };
    case "search_navigation_unknown": return { code: "BATCH_SEARCH_NAVIGATION_UNKNOWN", message: "批次缺少可核验的搜索导航回执；为避免重复访问，已阻止扩充。" };
    case "search_page_budget_exceeded": return { code: "CAPTURE_EXPANSION_SEARCH_BUDGET_EXCEEDED", message: "剩余搜索导航预算不足以覆盖本次目标。" };
    case "search_page_budget_exhausted": return { code: "CAPTURE_EXPANSION_SEARCH_BUDGET_EXHAUSTED", message: "Amazon 搜索页预算已用完；没有启动采集。" };
    case "expansion_in_progress": return { code: "BATCH_CAPTURE_EXPANSION_BUSY", message: "当前批次已有扩充操作在执行，请等待结果并刷新状态。" };
    default: return null;
  }
}

async function finalizeReceipt(input: {
  id: string;
  status: string;
  response: Record<string, unknown>;
  authorization?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await prisma.v5OperationReceipt.updateMany({
    where: { id: input.id, status: "processing" },
    data: {
      status: input.status,
      responseJson: JSON.stringify({ ...(input.authorization ?? {}), ...input.response }),
      updatedAt: now,
    },
  });
}

async function claimBatchExpansionLock(input: { batchId: string; authorizationId: string }): Promise<{ id: string } | null> {
  const where = {
    actorScope_operation_resourceKey_idempotencyKey: {
      actorScope: OWNER_SCOPE,
      operation: EXPANSION_LOCK_OPERATION,
      resourceKey: input.batchId,
      idempotencyKey: ACTIVE_LOCK_KEY,
    },
  };
  const prior = await prisma.v5OperationReceipt.findUnique({ where });
  if (!prior) {
    try {
      const created = await prisma.v5OperationReceipt.create({
        data: {
          actorScope: OWNER_SCOPE,
          operation: EXPANSION_LOCK_OPERATION,
          resourceKey: input.batchId,
          idempotencyKey: ACTIVE_LOCK_KEY,
          requestHash: input.authorizationId,
          status: "processing",
          responseJson: JSON.stringify({
            authorizationId: input.authorizationId,
            batchId: input.batchId,
            owner: { host: hostname(), pid: process.pid },
            stage: "confirmed",
            startedAt: new Date().toISOString(),
          } satisfies ExpansionLockCheckpoint),
        },
      });
      return { id: created.id };
    } catch {
      return null;
    }
  }
  if (prior.status === "processing") return null;
  const updated = await prisma.v5OperationReceipt.updateMany({
    where: { id: prior.id, status: prior.status, updatedAt: prior.updatedAt },
    data: {
      requestHash: input.authorizationId,
      status: "processing",
      responseJson: JSON.stringify({
        authorizationId: input.authorizationId,
        batchId: input.batchId,
        owner: { host: hostname(), pid: process.pid },
        stage: "confirmed",
        startedAt: new Date().toISOString(),
      } satisfies ExpansionLockCheckpoint),
      errorCode: null,
      updatedAt: new Date(),
    },
  });
  return updated.count === 1 ? { id: prior.id } : null;
}

async function releaseBatchExpansionLock(lockId: string, status: "completed" | "blocked"): Promise<void> {
  await prisma.v5OperationReceipt.updateMany({
    where: { id: lockId, status: "processing" },
    data: { status, updatedAt: new Date() },
  }).catch(() => undefined);
}

async function recoverStalledExpansion(input: {
  context: Parameters<typeof getProductBatchStore>[0];
  batchId: string;
  authorizationId: string;
  confirmProfileReleased: boolean;
}): Promise<{ ok: true; message: string; batchItemCount: number; addedCount: number; runStatus: string | null; sourceAccess: "NONE" | "ALREADY_ATTEMPTED"; searchStatus: "target_reached" | "insufficient_results" | "blocked" } | { ok: false; code: string; message: string }> {
  if (!input.confirmProfileReleased) return {
    ok: false,
    code: "CAPTURE_EXPANSION_PROFILE_CONFIRMATION_REQUIRED",
    message: "请先在本机确认 Amazon 专用浏览器和 Profile 已关闭，再勾选确认；系统不会删除 Profile 锁文件。",
  };
  const lock = await readActiveExpansionLock(input.batchId);
  const checkpoint = parseExpansionLockCheckpoint(lock?.responseJson);
  if (!lock || !["processing", "recovery_pending"].includes(lock.status) || !checkpoint || checkpoint.authorizationId !== input.authorizationId) return {
    ok: false,
    code: "CAPTURE_EXPANSION_RECOVERY_STATE_CHANGED",
    message: "扩充锁或授权编号已变化；请刷新状态，不执行恢复。",
  };
  const run = await service.status({ context: input.context, batchId: input.batchId });
  const inspection = await inspectExpansionRecovery({ batchId: input.batchId, authorizationId: input.authorizationId, run });
  if (!inspection.available) return {
    ok: false,
    code: "CAPTURE_EXPANSION_RECOVERY_UNSAFE",
    message: inspection.reason ?? "当前扩批状态无法安全恢复；保持锁定。",
  };
  const claimedAt = new Date().toISOString();
  const claim = await prisma.v5OperationReceipt.updateMany({
    where: { id: lock.id, status: lock.status, requestHash: input.authorizationId, updatedAt: lock.updatedAt },
    data: {
      status: "recovering",
      responseJson: JSON.stringify({ ...checkpoint, owner: { host: hostname(), pid: process.pid }, recoveryClaimedAt: claimedAt }),
      updatedAt: new Date(),
    },
  });
  if (claim.count !== 1) return {
    ok: false,
    code: "CAPTURE_EXPANSION_RECOVERY_RACE",
    message: "恢复期间锁状态发生变化；已保留现场，请刷新批次和 Run 状态后再操作。",
  };
  const markRecoveryRequired = async (code: string, message: string) => {
    const now = new Date();
    await prisma.v5OperationReceipt.updateMany({
      where: { id: lock.id, status: "recovering", requestHash: input.authorizationId },
      data: {
        status: "recovery_required",
        errorCode: code,
        responseJson: JSON.stringify({ ...checkpoint, stage: "recovery_required", recoveryErrorCode: code, recoveryMessage: message, owner: null }),
        updatedAt: now,
      },
    });
    return { ok: false as const, code, message };
  };
  const finishLock = async (status: "completed" | "blocked" | "partial", stage: string, extra: Record<string, unknown> = {}) => {
    const updated = await prisma.v5OperationReceipt.updateMany({
      where: { id: lock.id, status: "recovering", requestHash: input.authorizationId },
      data: {
        status,
        responseJson: JSON.stringify({ ...checkpoint, ...extra, stage, owner: null, recoveredAt: new Date().toISOString() }),
        updatedAt: new Date(),
      },
    });
    return updated.count === 1;
  };
  const authorization = await prisma.v5OperationReceipt.findUnique({
    where: { actorScope_operation_resourceKey_idempotencyKey: {
      actorScope: OWNER_SCOPE,
      operation: EXPANSION_OPERATION,
      resourceKey: input.batchId,
      idempotencyKey: input.authorizationId,
    } },
  });
  let authorizationData: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(authorization?.responseJson ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) authorizationData = parsed as Record<string, unknown>;
  } catch {
    authorizationData = null;
  }
  if (!authorization || !authorizationData) return markRecoveryRequired("CAPTURE_EXPANSION_AUTHORIZATION_UNREADABLE", "原扩充授权回执无法读取；扩充锁仍保留，未重新搜索。请人工核对授权和批次证据。");
  const targetTotal = authorizationData.targetTotal;
  const authorizedSearchItemLimit = authorizationData.authorizedSearchItemLimit;
  const searchStartPage = authorizationData.searchStartPage;
  const planFingerprint = authorizationData.planFingerprint;
  const requestHash = typeof planFingerprint === "string"
    ? hashJson({ schemaVersion: "market-capture-expansion-confirm.v1", batchId: input.batchId, targetTotal, planFingerprint })
    : null;
  if (authorization.requestHash !== requestHash
    || authorizationData.authorizationId !== input.authorizationId
    || authorizationData.kind !== "expansion"
    || !Number.isSafeInteger(targetTotal) || !Number.isSafeInteger(authorizedSearchItemLimit)
    || !Number.isSafeInteger(searchStartPage) || checkpoint.batchId && checkpoint.batchId !== input.batchId) {
    return markRecoveryRequired("CAPTURE_EXPANSION_AUTHORIZATION_MISMATCH", "扩充授权、目标数或页码与持久化检查点不一致；扩充锁仍保留，未重新搜索。");
  }
  const stage = checkpoint.stage ?? "unknown";
  const rawPages = Array.isArray(checkpoint.pages) ? checkpoint.pages : [];
  const pagesWellFormed = rawPages.every((page) => Boolean(page) && typeof page === "object" && !Array.isArray(page)
    && Number.isSafeInteger((page as Record<string, unknown>).page)
    && ["navigating", "extracted", "validated", "evidence_persisted", "blocked"].includes(String((page as Record<string, unknown>).state))
    && Array.isArray((page as Record<string, unknown>).evidenceReferences));
  const pages = rawPages.filter((page) => Boolean(page) && typeof page === "object" && !Array.isArray(page)) as unknown as AmazonSearchPageCheckpoint[];
  const references = pages.flatMap((page) => Array.isArray(page.evidenceReferences) ? page.evidenceReferences : []);
  const navigationUsed = checkpoint.navigationUsed;
  const isPreSource = ["confirmed", "reserved"].includes(stage);
  if (isPreSource && (navigationUsed === 0 || navigationUsed === undefined) && references.length === 0) {
    if (run?.expansionLock?.authorizationId === input.authorizationId) {
      await service.releaseExpansion({ context: input.context, batchId: input.batchId, authorizationId: input.authorizationId,
        message: "恢复确认：扩充在搜索页导航前中断；没有搜索页面或追加商品，可重新预览后再次确认。" });
    }
    if (!await finishLock("blocked", "manual_recovered_no_source_access")) return { ok: false, code: "CAPTURE_EXPANSION_RECOVERY_RACE", message: "恢复完成前扩充锁发生变化；请刷新确认状态。" };
    await finalizeReceipt({ id: authorization.id, status: "blocked", response: { httpStatus: 409, body: { ok: false, error: {
      code: "CAPTURE_EXPANSION_INTERRUPTED_BEFORE_SEARCH",
      message: "原操作在搜索页访问前中断，未追加商品；请刷新预览并使用新的确认编号。",
    } } } });
    return { ok: true, message: "已确认原操作未开始搜索并解除预留锁；没有再次访问 Amazon。请刷新预览后重新确认。", batchItemCount: (await getProductBatchStore(input.context).getBatchItems(input.batchId)).length, addedCount: 0, runStatus: run?.status ?? null, sourceAccess: "NONE", searchStatus: "blocked" };
  }
  if (!Number.isSafeInteger(navigationUsed) || Number(navigationUsed) < 1 || Number(navigationUsed) > HARD_MAX_AUTHORIZED_ITEMS
    || !Array.isArray(checkpoint.pages) || typeof checkpoint.traceId !== "string") {
    return markRecoveryRequired("CAPTURE_EXPANSION_CHECKPOINT_INCOMPLETE", "来源访问后缺少可核验的导航或页面检查点；扩充锁仍保留，系统不会重复搜索。请人工对账。");
  }
  if (Number(searchStartPage) + Number(navigationUsed) - 1 > 10) {
    return markRecoveryRequired("CAPTURE_EXPANSION_NAVIGATION_BUDGET_INVALID", "扩充页码超过批次硬上限；扩充锁仍保留，等待人工对账。");
  }
  const pageNumbers = pages.map((page) => page.page).sort((left, right) => left - right);
  const expectedPageNumbers = Array.from({ length: Number(navigationUsed) }, (_value, index) => Number(searchStartPage) + index);
  const journalReferences = Array.isArray(checkpoint.evidenceReferences) ? checkpoint.evidenceReferences : [];
  const referencesValid = references.every((reference) => Boolean(reference)
    && typeof reference.subjectKey === "string" && typeof reference.captureId === "string"
    && typeof reference.evidenceId === "string" && Number.isSafeInteger(reference.evidenceVersion)
    && reference.evidenceVersion > 0 && /^[a-f0-9]{64}$/u.test(reference.contentHash));
  if (!pagesWellFormed || hashJson(pageNumbers) !== hashJson(expectedPageNumbers)
    || pages.some((page) => page.state !== "evidence_persisted" && page.evidenceReferences.length > 0)
    || !referencesValid || hashJson(references) !== hashJson(journalReferences)) {
    return markRecoveryRequired("CAPTURE_EXPANSION_CHECKPOINT_MISMATCH", "页面导航、Evidence 引用或逐页检查点彼此不一致；扩充锁仍保留，系统不会重复搜索。请人工对账。");
  }
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(input.batchId);
  if (!batch?.query) return markRecoveryRequired("CAPTURE_EXPANSION_QUERY_MISSING", "原批次搜索词无法读取；扩充锁仍保留，未重新搜索。");
  let appended: Awaited<ReturnType<typeof appendAmazonSearchProductBatch>>;
  try {
    appended = await appendAmazonSearchProductBatch({
      context: input.context,
      batchId: input.batchId,
      query: batch.query,
      traceId: checkpoint.traceId,
      authorizationId: input.authorizationId,
      targetTotal: Number(targetTotal),
      searchStartPage: Number(searchStartPage),
      searchNavigationUsed: Number(navigationUsed),
      plan: null,
      captures: [],
      persistedEvidenceReferences: references,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "持久化 Evidence 核验失败。";
    return markRecoveryRequired("CAPTURE_EXPANSION_EVIDENCE_RECONCILIATION_REQUIRED", `保存的 Evidence 引用无法完成批次交接：${message} 扩充锁仍保留，未重新搜索。`);
  }
  const refreshedItems = await store.getBatchItems(input.batchId);
  const batchItemCount = new Set(refreshedItems.filter((item) => !item.archivedAt && item.asin).map((item) => item.asin!.trim().toUpperCase())).size;
  const completeCapturedSearch = ["source_completed", "batch_appended", "run_started"].includes(stage)
    && checkpoint.searchStatus === "captured" && !checkpoint.errorCode && Boolean(checkpoint.planSummary);
  const recoveredSearchStatus = completeCapturedSearch
    ? batchItemCount >= Number(targetTotal) ? "target_reached" as const : "insufficient_results" as const
    : "blocked" as const;
  let finalRun = run;
  let driveStarted = false;
  let driveError: string | null = null;
  if (completeCapturedSearch) {
    const alreadyStarted = Boolean(run?.authorizationLedger?.some((entry) => entry.authorizationId === input.authorizationId));
    if (!alreadyStarted) {
      if (!run?.expansionLock || run.expansionLock.authorizationId !== input.authorizationId) {
        return markRecoveryRequired("CAPTURE_EXPANSION_RUN_LOCK_MISMATCH", "Evidence 已交接批次，但 Run 扩充锁不匹配；锁仍保留，等待人工核对，不会重新搜索。");
      }
      const verifiedEvidence = await readVerifiedAmazonSearchEvidence({ context: input.context, items: refreshedItems });
      const expansion = await service.startExpansion({
        context: input.context,
        batchId: input.batchId,
        authorizationId: input.authorizationId,
        targetTotal: Number(targetTotal),
        authorizedSearchItemLimit: Number(authorizedSearchItemLimit),
        previousSearchNavigationUsed: Number(searchStartPage) - 1,
        expansionSearchNavigationUsed: Number(navigationUsed),
        newlyCapturedAsins: appended.newlyCapturedAsins,
        searchEvidence: verifiedEvidence.map((item) => ({ asin: item.asin, evidenceRef: item.evidenceId })),
      });
      finalRun = expansion.run;
    }
    if (finalRun && ["RUNNING", "WAITING"].includes(finalRun.status)) {
      const drive = await getBatchCaptureRunExecutor().ensureRunning({ context: input.context, batchId: input.batchId });
      driveStarted = drive.started;
      driveError = drive.errorCode ?? null;
    }
  } else if (run?.expansionLock?.authorizationId === input.authorizationId) {
    await service.releaseExpansion({ context: input.context, batchId: input.batchId, authorizationId: input.authorizationId,
      message: "已恢复并保存原操作产生的搜索导航与已验证 Evidence；原操作在完整搜索交接前中断或触发来源门禁，未自动启动后续模块。请处理来源门禁后刷新并重新确认剩余采集。" });
  }
  if (!await finishLock(completeCapturedSearch ? "completed" : "partial", completeCapturedSearch ? "recovered_run_handoff" : "recovered_partial_handoff", {
    appendedCount: appended.addedCount,
    validEvidenceCount: appended.validEvidenceCount,
    navigationUsed: Number(navigationUsed),
  })) return { ok: false, code: "CAPTURE_EXPANSION_RECOVERY_RACE", message: "批次交接已执行，但扩充锁状态发生变化；请刷新核对批次和 Run，勿重复搜索。" };
  const resultBody = {
    ok: true,
    data: {
      authorizationRecorded: true,
      searchStatus: recoveredSearchStatus,
      batchItemCount,
      targetTotal: Number(targetTotal),
      addedCount: appended.addedCount,
      validEvidenceCount: appended.validEvidenceCount,
      detailCompletedCount: new Set(finalRun?.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded"
        && cell.sourceVerified && cell.fieldComplete).map((cell) => cell.asin) ?? []).size,
      runId: finalRun?.runId ?? null,
      runStatus: finalRun?.status ?? null,
      runGeneration: finalRun?.runGeneration ?? null,
      driveStarted,
      driveError,
      sourceAccess: "ALREADY_ATTEMPTED",
      message: completeCapturedSearch
        ? `已从已验证检查点恢复批次交接：${appended.addedCount} 件新增，批次 ${batchItemCount}/${targetTotal}；没有重新访问 Amazon。`
        : `已保留原操作的 ${navigationUsed} 次搜索页导航和 ${appended.addedCount} 件已验证新增商品；原操作未完成或遇到来源门禁，未启动后续采集。请处理门禁后刷新预览。`,
    },
  };
  const receiptStatus = completeCapturedSearch ? (batchItemCount >= Number(targetTotal) ? "completed" : "partial") : "partial";
  await finalizeReceipt({ id: authorization.id, status: receiptStatus, response: { httpStatus: 200, body: resultBody } });
  return { ok: true, message: resultBody.data.message, batchItemCount, addedCount: appended.addedCount, runStatus: finalRun?.status ?? null,
    sourceAccess: "ALREADY_ATTEMPTED", searchStatus: recoveredSearchStatus };
}

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (auth.context.mode !== "owner") return errorResponse(403, "FORBIDDEN", "批次扩充仅允许 Owner 操作。");
  const params = new URL(request.url).searchParams;
  try {
    const batchId = requireBatchId(params.get("batchId"));
    const targetTotal = requireTargetTotal(params.get("targetTotal"));
    const preview = await loadPreview({ context: auth.context, batchId, targetTotal });
    const run = await service.status({ context: auth.context, batchId });
    const expansionRecovery = await inspectExpansionRecovery({ batchId, run });
    return NextResponse.json({ ok: true, data: { preview, previewOnly: true, localAcquisitionEnabled: process.env.LOCAL_ACQUISITION_ENABLED === "true", expansionRecovery } });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (auth.context.mode !== "owner") return errorResponse(403, "FORBIDDEN", "批次扩充仅允许 Owner 操作。");
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");

  let receiptId: string | null = null;
  let lockId: string | null = null;
  let lockedRunId: string | null = null;
  let operationBatchId: string | null = null;
  let operationAuthorizationId: string | null = null;
  let batchAppended = false;
  let authorizationRecord: Record<string, unknown> | null = null;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "INVALID_INPUT", "请求体必须是 JSON object。");
    const record = body as Record<string, unknown>;
    const batchId = requireBatchId(record.batchId);
    if (record.action === "recover_stalled") {
      const authorizationId = requireAuthorizationId(record.authorizationId);
      try {
        const recovered = await recoverStalledExpansion({
          context: auth.context,
          batchId,
          authorizationId,
          confirmProfileReleased: record.confirmProfileReleased === true,
        });
        return recovered.ok
          ? NextResponse.json({ ok: true, data: recovered })
          : errorResponse(409, recovered.code, recovered.message);
      } catch (error) {
        const current = await readActiveExpansionLock(batchId).catch(() => null);
        const checkpoint = parseExpansionLockCheckpoint(current?.responseJson);
        if (current?.status === "recovering" && checkpoint?.authorizationId === authorizationId) {
          await prisma.v5OperationReceipt.updateMany({
            where: { id: current.id, status: "recovering", requestHash: authorizationId },
            data: {
              status: "recovery_pending",
              responseJson: JSON.stringify({ ...checkpoint, owner: null, recoveryRetryable: true }),
              updatedAt: new Date(),
            },
          }).catch(() => undefined);
        }
        return v5ErrorResponse(error);
      }
    }
    const targetTotal = requireTargetTotal(record.targetTotal);
    const authorizationId = requireAuthorizationId(record.authorizationId);
    operationBatchId = batchId;
    operationAuthorizationId = authorizationId;
    if (typeof record.planFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.planFingerprint)) {
      return errorResponse(400, "CAPTURE_EXPANSION_FINGERPRINT_REQUIRED", "确认时必须提交扩充计划指纹。");
    }
    const requestHash = hashJson({ schemaVersion: "market-capture-expansion-confirm.v1", batchId, targetTotal, planFingerprint: record.planFingerprint });
    const prior = await prisma.v5OperationReceipt.findUnique({
      where: {
        actorScope_operation_resourceKey_idempotencyKey: {
          actorScope: OWNER_SCOPE,
          operation: EXPANSION_OPERATION,
          resourceKey: batchId,
          idempotencyKey: authorizationId,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== requestHash) return errorResponse(409, "CAPTURE_EXPANSION_IDEMPOTENCY_CONFLICT", "同一确认编号不能用于不同的扩充计划。");
      if (prior.status === "processing") return errorResponse(409, "CAPTURE_EXPANSION_BUSY", "该扩充确认仍在处理；请刷新读取服务端状态，不要重复启动搜索。");
      const cached = typeof prior.responseJson === "string" ? JSON.parse(prior.responseJson) as Record<string, unknown> : null;
      if (cached && typeof cached.httpStatus === "number") return NextResponse.json(cached.body, { status: cached.httpStatus });
      return errorResponse(409, "CAPTURE_EXPANSION_RESULT_UNAVAILABLE", "扩充确认已经处理，但结果回执不可用；请查看批次与运行状态。未重复搜索。");
    }
    const preview = await loadPreview({ context: auth.context, batchId, targetTotal });
    const blocker = blockerResponse(preview);
    if (blocker) return errorResponse(409, blocker.code, blocker.message);
    if (record.planFingerprint !== preview.planFingerprint) {
      return errorResponse(409, "CAPTURE_EXPANSION_FINGERPRINT_MISMATCH", "批次、任务或预算在预览后已变化；请刷新扩充计划再确认。");
    }
    authorizationRecord = {
      authorizationId,
      kind: "expansion",
      targetTotal,
      authorizedSearchItemLimit: preview.maxAdditionalSearchCount,
      plannedAdditionalAuthorizationCount: preview.plannedAdditionalAuthorizationCount,
      currentBatchItemCount: preview.currentItemCount,
      previousAuthorizedItemCount: preview.currentAuthorizedItemCount,
      searchStartPage: preview.searchStartPage,
      searchPageCount: preview.searchPageCount,
      confirmedAt: new Date().toISOString(),
    };
    const authorizationReceipt = await prisma.v5OperationReceipt.create({
      data: {
        actorScope: OWNER_SCOPE,
        operation: EXPANSION_OPERATION,
        resourceKey: batchId,
        idempotencyKey: authorizationId,
        requestHash,
        status: "processing",
        responseJson: JSON.stringify({ ...authorizationRecord, planFingerprint: preview.planFingerprint, stage: "confirmed" }),
      },
    });
    receiptId = authorizationReceipt.id;

    const batchLock = await claimBatchExpansionLock({ batchId, authorizationId });
    if (!batchLock) {
      const bodyResponse = { ok: false, error: { code: "CAPTURE_EXPANSION_BUSY", message: "该批次已有扩充操作进行中；旧 Run 未启动第二个执行器。" } };
      await finalizeReceipt({ id: authorizationReceipt.id, status: "blocked", authorization: authorizationRecord, response: { httpStatus: 409, body: bodyResponse } });
      return NextResponse.json(bodyResponse, { status: 409 });
    }
    lockId = batchLock.id;
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "confirmed", extra: { batchId } });
    if (preview.runId && getBatchCaptureRunExecutor().isRunning(preview.runId)) {
      const bodyResponse = { ok: false, error: { code: "BATCH_CAPTURE_JOB_BUSY", message: "旧 Run 的执行器仍在本机推进；扩充已阻止，未启动搜索。" } };
      await releaseBatchExpansionLock(lockId, "blocked");
      await finalizeReceipt({ id: authorizationReceipt.id, status: "blocked", authorization: authorizationRecord, response: { httpStatus: 409, body: bodyResponse } });
      return NextResponse.json(bodyResponse, { status: 409 });
    }

    const reserved = await service.reserveExpansion({ context: auth.context, batchId, authorizationId });
    lockedRunId = reserved.runId;
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "reserved", extra: { runId: reserved.runId, runGeneration: reserved.runGeneration } });
    if (process.env.LOCAL_ACQUISITION_ENABLED !== "true") {
      const bodyResponse = {
        ok: true,
        data: {
          authorizationRecorded: true,
          searchStatus: "blocked",
          errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
          message: "扩充授权已记录；本地采集未启用，因此没有启动浏览器、搜索或执行器。启用本地采集后请重新预览并另行确认。",
          batchItemCount: preview.currentItemCount,
          targetTotal,
          addedCount: 0,
          validEvidenceCount: preview.validEvidenceCount,
          detailCompletedCount: preview.detailCompletedCount,
          runId: reserved.runId,
          runStatus: reserved.status,
          runGeneration: reserved.runGeneration,
          driveStarted: false,
          driveError: "LOCAL_ENVIRONMENT_REQUIRED",
          sourceAccess: "NONE",
        },
      };
      await service.releaseExpansion({ context: auth.context, batchId, authorizationId, message: bodyResponse.data.message });
      await releaseBatchExpansionLock(lockId, "blocked");
      await finalizeReceipt({ id: authorizationReceipt.id, status: "blocked", authorization: authorizationRecord, response: { httpStatus: 200, body: bodyResponse } });
      return NextResponse.json(bodyResponse);
    }

    const store = getProductBatchStore(auth.context);
    const batch = await store.getBatch(batchId);
    const currentItems = await store.getBatchItems(batchId);
    if (!batch || !batch.query) throw new V5CoreError("CAPTURE_EXPANSION_QUERY_MISSING", "批次没有可继续使用的搜索词，已停止扩充。", 409);
    const currentAsins = [...new Set(currentItems.filter((item) => !item.archivedAt && item.asin).map((item) => item.asin!.trim().toUpperCase()))];
    const traceId = newTraceId();
    const persistedPages: AmazonSearchPageCheckpoint[] = [];
    const persistExpansionPage = async (checkpoint: AmazonSearchPageCheckpoint) => {
      const existing = persistedPages.findIndex((page) => page.page === checkpoint.page);
      if (existing >= 0) persistedPages[existing] = checkpoint;
      else persistedPages.push(checkpoint);
      persistedPages.sort((a, b) => a.page - b.page);
      const evidenceReferences = persistedPages.flatMap((page) => page.evidenceReferences);
      const successfulPages = persistedPages.filter((page) => page.state === "validated" || page.state === "evidence_persisted");
      await updateBatchExpansionLockStage({
        id: lockId!,
        authorizationId,
        stage: checkpoint.state === "blocked" ? "source_blocked" : `source_${checkpoint.state}`,
        extra: {
          traceId,
          pages: persistedPages,
          evidenceReferences,
          navigationUsed: Math.max(0, ...persistedPages.map((page) => page.page - preview.searchStartPage + 1)),
          planSummary: {
            pageCount: successfulPages.length,
            totalObservationCount: successfulPages.reduce((sum, page) => sum + page.observationCount, 0),
            pageStatuses: successfulPages.map((page) => page.pageStatus),
          },
        },
      });
    };
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "source_started", extra: { traceId, searchStartPage: preview.searchStartPage, navigationUsed: 0 } });
    const collection = await collectAmazonSearchWithPlaywright({
      context: auth.context,
      query: batch.query,
      pages: preview.searchPageCount,
      maxAppearances: preview.maxAdditionalSearchCount,
      startPage: preview.searchStartPage,
      excludeAsins: currentAsins,
      traceId,
      onPageCheckpoint: persistExpansionPage,
    });
    if (collection.pageCheckpoints) {
      for (const checkpoint of collection.pageCheckpoints) {
        if (!persistedPages.some((page) => page.page === checkpoint.page)) persistedPages.push(checkpoint);
      }
    }
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "source_completed", extra: {
      traceId,
      pages: persistedPages,
      evidenceReferences: persistedPages.flatMap((page) => page.evidenceReferences),
      navigationUsed: collection.navigationUsed ?? Math.max(0, ...persistedPages.map((page) => page.page - preview.searchStartPage + 1)),
      planSummary: collection.plan ? {
        pageCount: collection.plan.pageCount,
        totalObservationCount: collection.plan.totalObservationCount,
        pageStatuses: collection.plan.pageStatuses,
      } : null,
      searchStatus: collection.status,
      errorCode: collection.errorCode,
    } });
    if (collection.status !== "captured" || !collection.plan || Boolean(collection.errorCode)) {
      const code = collection.errorCode ?? collection.status.toUpperCase();
      const message = collection.errorMessage ?? `扩充搜索受阻（${code}）；没有追加商品，也没有启动详情执行器。`;
      const navigationUsed = collection.navigationUsed ?? Math.max(0, ...persistedPages.map((page) => page.page - preview.searchStartPage + 1));
      const evidenceReferences = persistedPages.flatMap((page) => page.evidenceReferences);
      let partialAppend: Awaited<ReturnType<typeof appendAmazonSearchProductBatch>> | null = null;
      if (navigationUsed > 0) {
        try {
          partialAppend = await appendAmazonSearchProductBatch({
            context: auth.context,
            batchId,
            query: batch.query,
            traceId,
            authorizationId,
            targetTotal,
            searchStartPage: preview.searchStartPage,
            searchNavigationUsed: navigationUsed,
            plan: collection.plan,
            captures: evidenceReferences.length === 0 ? collection.captures : [],
            persistedEvidenceReferences: evidenceReferences,
          });
          batchAppended = true;
          await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "partial_handoff_saved", extra: {
            traceId, navigationUsed, evidenceReferences, appendedCount: partialAppend.addedCount,
          } });
        } catch (handoffError) {
          const handoffMessage = handoffError instanceof Error ? handoffError.message : "Evidence 检查点无法写入批次。";
          const recoveryMessage = `搜索页已访问，但 Evidence/导航回执无法安全交接：${handoffMessage} 扩充锁已保留，不会重复搜索。请人工核对。`;
          const activeLock = await readActiveExpansionLock(batchId);
          const activeCheckpoint = parseExpansionLockCheckpoint(activeLock?.responseJson);
          await prisma.v5OperationReceipt.updateMany({
            where: { id: lockId, status: "processing", requestHash: authorizationId },
            data: { status: "recovery_required", errorCode: "CAPTURE_EXPANSION_EVIDENCE_RECONCILIATION_REQUIRED",
              responseJson: JSON.stringify({ ...(activeCheckpoint ?? {}), stage: "recovery_required", recoveryMessage, owner: null }), updatedAt: new Date() },
          });
          await finalizeReceipt({ id: receiptId!, status: "blocked", authorization: authorizationRecord ?? undefined,
            response: { httpStatus: 409, body: { ok: false, error: { code: "CAPTURE_EXPANSION_EVIDENCE_RECONCILIATION_REQUIRED", message: recoveryMessage } } } });
          return errorResponse(409, "CAPTURE_EXPANSION_EVIDENCE_RECONCILIATION_REQUIRED", recoveryMessage);
        }
      }
      await service.releaseExpansion({ context: auth.context, batchId, authorizationId, message });
      await releaseBatchExpansionLock(lockId, "blocked");
      const bodyResponse = {
        ok: true,
        data: {
          authorizationRecorded: true,
          searchStatus: "blocked",
          errorCode: code,
          message: partialAppend
            ? `${message} 已保存本轮 ${navigationUsed} 次搜索页导航及 ${partialAppend.addedCount} 件已验证商品；没有启动后续模块。`
            : message,
          navigationUsed,
          batchItemCount: preview.currentItemCount + (partialAppend?.addedCount ?? 0),
          targetTotal,
          addedCount: partialAppend?.addedCount ?? 0,
          duplicateProductCount: partialAppend?.duplicateProductCount ?? 0,
          validEvidenceCount: partialAppend?.validEvidenceCount ?? preview.validEvidenceCount,
          detailCompletedCount: preview.detailCompletedCount,
          runId: reserved.runId,
          runStatus: reserved.status,
          runGeneration: reserved.runGeneration,
          driveStarted: false,
          driveError: code,
          sourceAccess: "ATTEMPTED",
          traceId,
        },
      };
      await finalizeReceipt({ id: authorizationReceipt.id, status: "blocked", authorization: authorizationRecord, response: { httpStatus: 200, body: bodyResponse } });
      return NextResponse.json(bodyResponse);
    }

    const appended = await appendAmazonSearchProductBatch({
      context: auth.context,
      batchId,
      query: collection.plan.query,
      traceId,
      authorizationId,
      targetTotal,
      searchStartPage: preview.searchStartPage,
      searchNavigationUsed: collection.navigationUsed ?? collection.plan.pageCount,
      plan: collection.plan,
      captures: collection.captures,
    });
    batchAppended = true;
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "batch_appended", extra: { traceId, batchId, appendedCount: appended.addedCount } });
    const refreshedItems = await store.getBatchItems(batchId);
    const batchItemCount = new Set(refreshedItems.filter((item) => !item.archivedAt && item.asin).map((item) => item.asin!.toUpperCase())).size;
    const verifiedEvidence = await readVerifiedAmazonSearchEvidence({ context: auth.context, items: refreshedItems });
    const expansion = await service.startExpansion({
      context: auth.context,
      batchId,
      authorizationId,
      targetTotal,
      authorizedSearchItemLimit: preview.maxAdditionalSearchCount,
      previousSearchNavigationUsed: preview.searchNavigationUsed,
      expansionSearchNavigationUsed: collection.navigationUsed ?? collection.plan.pageCount,
      newlyCapturedAsins: appended.newlyCapturedAsins,
      searchEvidence: verifiedEvidence.map((item) => ({ asin: item.asin, evidenceRef: item.evidenceId })),
    });
    lockedRunId = expansion.run.runId;
    await updateBatchExpansionLockStage({ id: lockId, authorizationId, stage: "run_started", extra: { runId: expansion.run.runId, runGeneration: expansion.run.runGeneration, traceId } });

    let driveStarted = false;
    let driveError: string | null = null;
    if (expansion.run.status === "RUNNING" || expansion.run.status === "WAITING") {
      const drive = await getBatchCaptureRunExecutor().ensureRunning({ context: auth.context, batchId });
      driveStarted = drive.started;
      driveError = drive.errorCode ?? null;
    }
    const detailCompletedCount = new Set(expansion.run.cells
      .filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded" && cell.sourceVerified && cell.fieldComplete)
      .map((cell) => cell.asin)).size;
    const targetReached = batchItemCount >= targetTotal;
    const bodyResponse = {
      ok: true,
      data: {
        authorizationRecorded: true,
        searchStatus: targetReached ? "target_reached" : "insufficient_results",
        targetReached,
        batchItemCount,
        targetTotal,
        addedCount: appended.addedCount,
        duplicateProductCount: appended.duplicateProductCount,
        validEvidenceCount: appended.validEvidenceCount,
        detailCompletedCount,
        runId: expansion.run.runId,
        runStatus: expansion.run.status,
        runGeneration: expansion.run.runGeneration,
        driveStarted,
        driveError,
        sourceAccess: "CAPTURED",
        traceId,
        message: targetReached
          ? `已追加 ${appended.addedCount} 件，批次现有 ${batchItemCount}/${targetTotal} 件；详情进度以运行回执继续更新。`
          : `来源本轮仅找到 ${appended.addedCount} 件新商品，批次现有 ${batchItemCount}/${targetTotal} 件；可在来源条件允许时继续扩充。`,
      },
    };
    await releaseBatchExpansionLock(lockId, "completed");
    await finalizeReceipt({ id: authorizationReceipt.id, status: targetReached ? "completed" : "partial", authorization: authorizationRecord, response: { httpStatus: 200, body: bodyResponse } });
    return NextResponse.json(bodyResponse);
  } catch (error) {
    const core = error instanceof V5CoreError ? error : null;
    if (receiptId) {
      let recoveryQueued = false;
      if (lockId) {
        const activeLock = await readActiveExpansionLock(operationBatchId ?? "").catch(() => null);
        const checkpoint = parseExpansionLockCheckpoint(activeLock?.responseJson);
        const stage = checkpoint?.stage ?? "unknown";
        const hasSourceCheckpoint = Boolean(checkpoint && (
          (typeof checkpoint.navigationUsed === "number" && checkpoint.navigationUsed > 0)
          || ["source_completed", "partial_handoff_saved", "batch_appended", "run_started"].includes(stage)
        ));
        if (activeLock && checkpoint?.authorizationId === operationAuthorizationId && hasSourceCheckpoint) {
          const message = "扩充请求异常结束，但已确认 Amazon 搜索页访问或 Evidence 检查点；原扩充锁已保留。请刷新扩充面板，确认专用 Profile 已关闭后执行恢复；不要重新确认或重搜。";
          const queued = await prisma.v5OperationReceipt.updateMany({
            where: { id: activeLock.id, status: "processing", requestHash: operationAuthorizationId },
            data: {
              status: "recovery_pending",
              responseJson: JSON.stringify({ ...checkpoint, owner: null, recoveryMessage: message }),
              errorCode: core?.code ?? "CAPTURE_EXPANSION_RECOVERY_PENDING",
              updatedAt: new Date(),
            },
          }).catch(() => ({ count: 0 }));
          recoveryQueued = queued.count === 1;
        }
        if (!recoveryQueued) await releaseBatchExpansionLock(lockId, "blocked");
      }
      if (!recoveryQueued && lockedRunId) {
        await service.releaseExpansion({
          context: auth.context,
          batchId: operationBatchId ?? "",
          authorizationId: operationAuthorizationId ?? "",
          message: batchAppended
            ? "商品已追加到批次，但新运行代次未能创建；商品与 Evidence 均保留，刷新后查看并重新确认后续动作。"
            : core?.message,
        }).catch(() => undefined);
      }
      if (recoveryQueued) {
        const message = "扩充请求异常结束，但已保留搜索导航和证据交接锁；请刷新后确认 Amazon 专用 Profile 已关闭，再使用恢复入口继续。系统没有重复搜索或启动第二个执行器。";
        return errorResponse(409, "CAPTURE_EXPANSION_RECOVERY_PENDING", message);
      }
      const bodyResponse = {
        ok: false,
        error: {
          code: core?.code ?? "CAPTURE_EXPANSION_FAILED",
          message: core?.message ?? (batchAppended
            ? "商品已写入当前批次，但新运行代次创建失败；已保留商品与证据，请刷新查看持久化状态。"
            : "扩充未完成；请刷新后以服务端持久化状态为准。"),
          batchAppended,
        },
      };
      await finalizeReceipt({ id: receiptId, status: "blocked", authorization: authorizationRecord ?? undefined, response: { httpStatus: core?.status ?? 500, body: bodyResponse } }).catch(() => undefined);
    }
    return v5ErrorResponse(error);
  }
}
