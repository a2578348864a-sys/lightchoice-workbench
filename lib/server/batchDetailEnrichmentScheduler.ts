import "server-only";
import { readCaptureRuntimeConfig } from "@/scripts/ops/capture-runtime-config.mjs";

import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import { LOCAL_OWNER_PRINCIPAL } from "@/lib/server/accessPassword";
import { enrichBatchWithAmazonDetail } from "@/lib/server/batchDetailEnrichmentService";
import {
  BATCH_DETAIL_JOB_SCHEMA_VERSION,
  createInitialBatchDetailJobItems,
  deriveBatchDetailJobProgress,
  hasAmazonSearchDetailEnrichmentIntent,
  MAX_DETAIL_ITEM_AUTO_ATTEMPTS,
  parsePersistedBatchDetailJob,
  retryDelayMs,
  selectNextBatchDetailItems,
  type BatchDetailEnrichmentJobStatus,
  type PersistedBatchDetailJob,
  type PersistedBatchDetailJobItem,
} from "@/lib/server/batchDetailEnrichmentJob";
import {
  createBatchDetailEnrichmentJobRepository,
  type BatchDetailEnrichmentJobRepository,
} from "@/lib/server/batchDetailEnrichmentJobRepository";
import { V5CoreError } from "@/lib/server/v5CoreCommon";
import { prisma } from "@/lib/server/db";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import type { ProductBatchStore, ProductBatchView } from "@/lib/productBatchStore";
import type { BatchDetailEnrichmentItemResult } from "@/lib/server/batchDetailEnrichmentService";

const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 5_000;
const HANDOFF_RECONCILE_INTERVAL_MS = 60_000;
const MAX_JOBS_PER_TICK = 1;
const HUMAN_GATE_CODES = new Set(["CAPTCHA_DETECTED", "LOGIN_REQUIRED"]);

export type BatchDetailWorkerResult = {
  item: BatchDetailEnrichmentItemResult | null;
  traceId: string | null;
  runReceiptId: string;
};

export type BatchDetailEnrichmentSchedulerDependencies = {
  repository?: BatchDetailEnrichmentJobRepository;
  reconcileMarkedBatches?: () => Promise<number>;
  runAsin?: (input: { batchId: string; asin: string; idempotencyKey: string; traceId: string }) => Promise<BatchDetailWorkerResult>;
  now?: () => Date;
  intervalMs?: number;
  schedulePolling?: boolean;
  heartbeatMs?: number;
  onDiagnostic?: (diagnostic: BatchDetailSchedulerDiagnostic) => void;
};

export type BatchDetailSchedulerDiagnostic = {
  event: "amazon_detail_scheduler_error";
  jobId: string | null;
  batchId: string | null;
  errorCode: string;
  timestamp: string;
  stage: string;
  leaseOwner: string | null;
};

/** 确认某批次是否已存在 BatchCaptureRun（唯一任务权威）。存在即不得由旧 Detail Job 调度器补跑。 */
export type BatchCaptureRunPresenceProbe = (batchId: string) => Promise<boolean>;

/**
 * 旧 Detail Job 自动补跑的显式开关（默认关闭，fail-safe）。
 *
 * 变更原因（P0）：`detailEnrichmentIntent.autoEnqueue` 已改为 false，但**历史批次**的
 * 快照里仍然写着 true。如果仅依赖该意图位，一旦有人开启
 * `V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER`，调度器会立刻扫描并自动补跑历史 60 件商品批次。
 * 因此把「自动补跑」变为**必须显式开启**的兼容能力，默认不补跑任何历史批次。
 */
export function isLegacyDetailAutoEnqueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.V5_ENABLE_LEGACY_DETAIL_AUTO_ENQUEUE === "1";
}

export async function reconcileMarkedAmazonSearchBatchJobs(input: {
  store: Pick<ProductBatchStore, "listBatches" | "getBatchItems">;
  repository: BatchDetailEnrichmentJobRepository;
  now?: () => Date;
  /** 批次的 BatchCaptureRun 存在性探测；返回 true 表示该批次由 Capture Run 负责，必须跳过。 */
  hasCaptureRun?: BatchCaptureRunPresenceProbe;
  /** 是否允许为历史批次自动建旧 Detail Job；默认关闭。 */
  legacyAutoEnqueueAllowed?: boolean;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  const legacyAllowed = input.legacyAutoEnqueueAllowed ?? isLegacyDetailAutoEnqueueEnabled();
  if (!legacyAllowed) return 0;
  const batches: ProductBatchView[] = await input.store.listBatches();
  let created = 0;
  for (const batch of batches) {
    // 双任务权威防护：已有 Capture Run 的批次一律不由旧 Job 调度器推进。
    if (input.hasCaptureRun && await input.hasCaptureRun(batch.id)) continue;
    if (!hasAmazonSearchDetailEnrichmentIntent(batch) || (batch.acceptedCount ?? 0) < 1) continue;
    if (await input.repository.get(batch.id)) continue;
    const items = createInitialBatchDetailJobItems(await input.store.getBatchItems(batch.id));
    if (!items.length) continue;
    const ensured = await input.repository.ensure({ batchId: batch.id, items, now: now() });
    if (ensured.created) created += 1;
  }
  return created;
}

function defaultRunAsin(input: { batchId: string; asin: string; idempotencyKey: string; traceId: string }): Promise<BatchDetailWorkerResult> {
  return enrichBatchWithAmazonDetail({
    context: LOCAL_OWNER_PRINCIPAL,
    batchId: input.batchId,
    targetAsin: input.asin,
    limit: 1,
    traceId: input.traceId,
    idempotencyKey: input.idempotencyKey,
  }).then((result) => ({
    item: result.value.items.find((item) => item.asin === input.asin) ?? null,
    traceId: result.value.traceId,
    runReceiptId: result.receiptId,
  }));
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof V5CoreError
    ? error.code
    : error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "DETAIL_WORKER_FAILED";
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "DETAIL_WORKER_FAILED";
}

function itemForResult(input: {
  item: PersistedBatchDetailJobItem;
  result: BatchDetailEnrichmentItemResult | null;
  traceId: string | null;
  receiptId: string;
  now: Date;
}): PersistedBatchDetailJobItem {
  const { item, result, now } = input;
  const validResult = result && result.asin === item.asin && result.itemId === item.itemId
    && ["enriched", "captured_partial", "skipped_enriched", "failed_permanent", "failed_human", "failed_retryable"].includes(result.status)
    && typeof result.captured === "boolean" && Number.isFinite(result.durationMs)
    && (result.errorCode === null || typeof result.errorCode === "string")
    && (!["enriched", "captured_partial", "skipped_enriched"].includes(result.status)
      || (typeof result.evidenceId === "string" && result.evidenceId.length > 0 && Number.isSafeInteger(result.evidenceVersion) && result.evidenceVersion! > 0))
    && (result.status !== "skipped_enriched" || ["enriched", "captured_partial"].includes(result.existingEnrichmentStatus ?? ""));
  if (!validResult) {
    const exhausted = item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS;
    return {
      ...item,
      status: exhausted ? "FAILED_PERMANENT" : "FAILED_RETRYABLE",
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(item.attemptCount)).toISOString(),
      lastErrorCode: "DETAIL_WORKER_RESULT_MISSING",
      traceId: input.traceId ?? item.traceId,
      runReceiptId: input.receiptId,
    };
  }
  const status: PersistedBatchDetailJobItem["status"] = result.status === "enriched" || (result.status === "skipped_enriched" && result.existingEnrichmentStatus === "enriched")
    ? "ENRICHED"
    : result.status === "captured_partial" || (result.status === "skipped_enriched" && result.existingEnrichmentStatus === "captured_partial")
      ? "CAPTURED_PARTIAL"
      : result.status === "failed_permanent"
        ? "FAILED_PERMANENT"
        : result.status === "failed_human"
          ? "HUMAN_REQUIRED"
          : "FAILED_RETRYABLE";
  const exhausted = status === "FAILED_RETRYABLE" && item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS;
  return {
    ...item,
    status: exhausted ? "FAILED_PERMANENT" : status,
    nextAttemptAt: status === "FAILED_RETRYABLE" && !exhausted
      ? new Date(now.getTime() + retryDelayMs(item.attemptCount)).toISOString()
      : null,
    lastErrorCode: result.errorCode,
    evidenceId: result.evidenceId,
    evidenceVersion: result.evidenceVersion,
    captureOrigin: result.captureOrigin ?? null,
    traceId: input.traceId ?? item.traceId,
    runReceiptId: input.receiptId,
  };
}

function nextJobState(input: {
  job: PersistedBatchDetailJob;
  now: Date;
}): Pick<PersistedBatchDetailJob, "status" | "finishedAt" | "nextRunAt" | "leaseOwner" | "leaseExpiresAt" | "lastErrorCode"> {
  const { job, now } = input;
  const candidates = selectNextBatchDetailItems(job, now);
  if (candidates.length > 0) {
    return { status: "PENDING", finishedAt: null, nextRunAt: now.toISOString(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null };
  }
  const dueRetries = job.items
    .filter((item) => item.status === "FAILED_RETRYABLE" && item.attemptCount < MAX_DETAIL_ITEM_AUTO_ATTEMPTS && item.nextAttemptAt)
    .map((item) => Date.parse(item.nextAttemptAt!))
    .filter(Number.isFinite);
  if (dueRetries.length > 0) {
    return {
      status: "PENDING",
      finishedAt: null,
      nextRunAt: new Date(Math.min(...dueRetries)).toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
  }
  const hasFailed = job.items.some((item) => item.status === "FAILED_PERMANENT" || item.status === "FAILED_RETRYABLE");
  return {
    status: hasFailed ? "FAILED" : "COMPLETED",
    finishedAt: now.toISOString(),
    nextRunAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: hasFailed ? "DETAIL_ITEMS_FAILED" : null,
  };
}

export function createBatchDetailEnrichmentScheduler(dependencies: BatchDetailEnrichmentSchedulerDependencies = {}) {
  const repository = dependencies.repository ?? createBatchDetailEnrichmentJobRepository();
  const runAsin = dependencies.runAsin ?? defaultRunAsin;
  const now = dependencies.now ?? (() => new Date());
  const intervalMs = dependencies.intervalMs ?? DEFAULT_POLL_MS;
  const reconcileMarkedBatches = dependencies.reconcileMarkedBatches
    ?? (() => reconcileMarkedAmazonSearchBatchJobs({
      store: getProductBatchStore(LOCAL_OWNER_PRINCIPAL),
      repository,
      now,
      // 双任务权威防护：该批次已有 BatchCaptureRun 时，旧 Detail Job 调度器一律不介入。
      hasCaptureRun: async (batchId: string) => {
        const run = await createBatchCaptureRunService({ database: prisma as never }).status({
          context: LOCAL_OWNER_PRINCIPAL,
          batchId,
        });
        return run !== null;
      },
    }));
  let started = false;
  let tickInFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let lastHandoffReconcileAt = 0;

  function diagnose(stage: string, error: unknown, job?: PersistedBatchDetailJob, owner?: string) {
    const diagnostic: BatchDetailSchedulerDiagnostic = {
      event: "amazon_detail_scheduler_error", stage, errorCode: safeErrorCode(error),
      timestamp: now().toISOString(), jobId: job?.jobId ?? null, batchId: job?.batchId ?? null, leaseOwner: owner ?? null,
    };
    // Never serialize the thrown error: messages can contain proxy or session secrets.
    try {
      if (dependencies.onDiagnostic) dependencies.onDiagnostic(diagnostic);
      else console.error(JSON.stringify(diagnostic));
    } catch { console.error(JSON.stringify(diagnostic)); }
  }

  async function renewLease(jobId: string, owner: string): Promise<boolean> {
    const time = now();
    const renewed = await repository.updateJob(jobId, (job) => job.status === "RUNNING" && job.leaseOwner === owner
      ? { ...job, updatedAt: time.toISOString(), leaseExpiresAt: new Date(time.getTime() + LEASE_MS).toISOString() }
      : null, { now: time, leaseOwner: owner });
    return renewed?.status === "RUNNING" && renewed.leaseOwner === owner && !!renewed.leaseExpiresAt
      && Date.parse(renewed.leaseExpiresAt) > time.getTime();
  }

  async function pauseForFailure(job: PersistedBatchDetailJob, owner: string, code: string): Promise<void> {
    const time = now();
    const paused = await repository.updateJob(job.jobId, (job) => ({
      ...job,
      status: "PAUSED",
      updatedAt: time.toISOString(),
      finishedAt: null,
      lastErrorCode: code,
      nextRunAt: null,
      leaseExpiresAt: null,
      leaseOwner: null,
    }), { now: time, leaseOwner: owner });
    if (!paused) diagnose("pause_failure", { code: "LEASE_LOST" }, job, owner);
  }

  async function runClaimedJob(job: PersistedBatchDetailJob, owner: string, lease: { lost: boolean; stopHeartbeat: () => Promise<void> }, itemLimit = 30): Promise<void> {
    for (const selected of selectNextBatchDetailItems(job, now(), itemLimit)) {
      if (lease.lost) return;
      const current = await repository.getById(job.jobId);
      if (!current || current.leaseOwner !== owner || current.status !== "RUNNING") {
        diagnose("before_item", { code: "LEASE_LOST" }, job, owner);
        return;
      }
      if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= now().getTime()) {
        lease.lost = true;
        diagnose("before_item", { code: "LEASE_LOST" }, job, owner);
        return;
      }
      const selectedItem = current.items.find((item) => item.itemId === selected.itemId);
      if (!selectedItem || (selectedItem.status !== "PENDING" && selectedItem.status !== "FAILED_RETRYABLE")) continue;
      const time = now();
      const attemptTraceId = `batch-detail-attempt-${randomUUID()}`;
      const attemptItem: PersistedBatchDetailJobItem = {
        ...selectedItem,
        status: "RUNNING",
        attemptCount: selectedItem.attemptCount + 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        traceId: attemptTraceId,
      };
      const started = await repository.updateJob(job.jobId, (latest) => ({
        ...latest,
        updatedAt: time.toISOString(),
        traceIds: [...latest.traceIds.filter((traceId) => traceId !== attemptTraceId), attemptTraceId].slice(-100),
        items: latest.items.map((item) => item.itemId === attemptItem.itemId ? attemptItem : item),
      }), { now: time, leaseOwner: owner });
      if (!started) { diagnose("start_item", { code: "LEASE_LOST" }, job, owner); return; }
      if (lease.lost) return;

      let result: BatchDetailWorkerResult;
      try {
        result = await runAsin({
          batchId: job.batchId,
          asin: selectedItem.asin,
          idempotencyKey: `${job.jobId}:${selectedItem.asin}:${attemptItem.attemptCount}`,
          traceId: attemptTraceId,
        });
      } catch (error) {
        if (lease.lost) return;
        const errorCode = safeErrorCode(error);
        const failureTime = now();
        const retriable = error instanceof V5CoreError ? error.retryable : true;
        const failedItem: PersistedBatchDetailJobItem = {
          ...attemptItem,
          status: retriable && attemptItem.attemptCount < MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
          nextAttemptAt: retriable && attemptItem.attemptCount < MAX_DETAIL_ITEM_AUTO_ATTEMPTS
            ? new Date(failureTime.getTime() + retryDelayMs(attemptItem.attemptCount)).toISOString()
            : null,
          lastErrorCode: errorCode,
        };
        const saved = await repository.updateJob(job.jobId, (latest) => ({
          ...latest,
          updatedAt: failureTime.toISOString(),
          items: latest.items.map((item) => item.itemId === failedItem.itemId ? failedItem : item),
          lastErrorCode: errorCode,
        }), { now: failureTime, leaseOwner: owner });
        if (!saved) { diagnose("save_failure", { code: "LEASE_LOST" }, job, owner); return; }
        if (errorCode === "ENV_BLOCKED" || errorCode === "AMAZON_CAPTURE_PREFLIGHT_FAILED") {
          await lease.stopHeartbeat();
          if (lease.lost) return;
          await pauseForFailure(job, owner, errorCode);
          return;
        }
        continue;
      }

      if (lease.lost) return;
      const resultTime = now();
      const resultItem = itemForResult({
        item: attemptItem,
        result: result?.item ?? null,
        traceId: typeof result?.traceId === "string" ? result.traceId : null,
        receiptId: typeof result?.runReceiptId === "string" ? result.runReceiptId : "",
        now: resultTime,
      });
      const saved = await repository.updateJob(job.jobId, (latest) => ({
        ...latest,
        updatedAt: resultTime.toISOString(),
        traceIds: resultItem.traceId
          ? [...latest.traceIds.filter((traceId) => traceId !== resultItem.traceId), resultItem.traceId].slice(-100)
          : latest.traceIds,
        items: latest.items.map((item) => item.itemId === resultItem.itemId ? resultItem : item),
        lastErrorCode: resultItem.lastErrorCode,
      }), { now: resultTime, leaseOwner: owner });
      if (!saved) { diagnose("save_result", { code: "LEASE_LOST" }, job, owner); return; }

      if (HUMAN_GATE_CODES.has(resultItem.lastErrorCode ?? "") || resultItem.status === "HUMAN_REQUIRED") {
        await lease.stopHeartbeat();
        if (lease.lost) return;
        await pauseForFailure(job, owner, resultItem.lastErrorCode ?? "HUMAN_ACTION_REQUIRED");
        return;
      }
      const latest = await repository.getById(job.jobId);
      if (!latest || latest.status !== "RUNNING" || latest.leaseOwner !== owner) {
        diagnose("before_next_item", { code: "LEASE_LOST" }, job, owner);
        return;
      }
    }

    await lease.stopHeartbeat();
    if (lease.lost) return;
    const time = now();
    const finished = await repository.updateJob(job.jobId, (latest) => {
      if (latest.status !== "RUNNING" || latest.leaseOwner !== owner) return null;
      const nextState = nextJobState({ job: latest, now: time });
      return { ...latest, ...nextState, updatedAt: time.toISOString() };
    }, { now: time, leaseOwner: owner });
    if (!finished) diagnose("finish_job", { code: "LEASE_LOST" }, job, owner);
  }

  async function executeClaimed(claimed: PersistedBatchDetailJob, owner: string, itemLimit = 30): Promise<void> {
        let heartbeatInFlight: Promise<void> | null = null;
        let heartbeatStopped = false;
        const lease = { lost: false, stopHeartbeat: async () => {
          heartbeatStopped = true;
          clearInterval(heartbeat);
          if (heartbeatInFlight) await heartbeatInFlight;
        } };
        const heartbeat = setInterval(() => {
          if (lease.lost || heartbeatStopped || heartbeatInFlight) return;
          heartbeatInFlight = (async () => {
            try {
              if (!await renewLease(claimed.jobId, owner)) {
                lease.lost = true;
                diagnose("heartbeat", { code: "LEASE_LOST" }, claimed, owner);
              }
            } catch (error) {
              lease.lost = true;
              diagnose("heartbeat", { code: "LEASE_LOST" }, claimed, owner);
              diagnose("heartbeat_repository", error, claimed, owner);
            }
          })().finally(() => { heartbeatInFlight = null; });
        }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
        heartbeat.unref();
        try {
          await runClaimedJob(claimed, owner, lease, itemLimit);
        } finally {
          await lease.stopHeartbeat();
        }
  }

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    let stage = "handoff_reconcile";
    let activeJob: PersistedBatchDetailJob | undefined;
    let activeOwner: string | undefined;
    try {
      const time = now();
      if (time.getTime() - lastHandoffReconcileAt >= HANDOFF_RECONCILE_INTERVAL_MS) {
        lastHandoffReconcileAt = time.getTime();
        await reconcileMarkedBatches();
      }
      stage = "lease_reconcile";
      await repository.reconcileRestartedLeases(time);
      stage = "list_due";
      const due = await repository.listDue(time, 100);
      for (const candidate of due.slice(0, MAX_JOBS_PER_TICK)) {
        const owner = randomUUID();
        activeJob = candidate;
        activeOwner = owner;
        stage = "claim";
        const claimed = await repository.claim({ jobId: candidate.jobId, owner, now: time, leaseMs: LEASE_MS });
        if (!claimed) continue;
        stage = "run_job";
        await executeClaimed(claimed, owner);
        break;
      }
    } catch (error) {
      diagnose(stage, error, activeJob, activeOwner);
    } finally {
      tickInFlight = false;
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      if (dependencies.schedulePolling !== false) {
        timer = setInterval(() => { void tick(); }, intervalMs);
        timer.unref();
      }
      queueMicrotask(() => { void tick(); });
    },
    runDueNow: tick,
    async runOne(batchId: string): Promise<PersistedBatchDetailJob> {
      // No global list/reconcile/start, no polling and at most one source attempt.
      const job = await repository.get(batchId);
      if (!job) throw new V5CoreError("DETAIL_JOB_NOT_FOUND", "详情补齐任务不存在。", 404);
      if (!["PENDING", "RUNNING"].includes(job.status)) {
        throw new V5CoreError("DETAIL_JOB_NOT_RUNNABLE", "请先人工处理阻塞并恢复任务。", 409);
      }
      const owner = randomUUID();
      const claimed = await repository.claim({ jobId: job.jobId, owner, now: now(), leaseMs: LEASE_MS });
      if (!claimed) throw new V5CoreError("DETAIL_JOB_BUSY", "任务正在运行或尚未到可执行时间，请稍后读取状态。", 409);
      await executeClaimed(claimed, owner, 1);
      const saved = await repository.getById(job.jobId);
      if (!saved) throw new V5CoreError("DETAIL_JOB_NOT_FOUND", "任务状态暂时无法读取。", 404);
      return saved;
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },
    getState(): { started: boolean; tickInFlight: boolean } {
      return { started, tickInFlight };
    },
  };
}

type SchedulerGlobal = typeof globalThis & {
  __batchDetailEnrichmentScheduler?: ReturnType<typeof createBatchDetailEnrichmentScheduler>;
};

/** Called by the Node.js instrumentation hook for every local server process. */
export async function startBatchDetailEnrichmentScheduler(): Promise<void> {
  const globalState = globalThis as SchedulerGlobal;
  if (globalState.__batchDetailEnrichmentScheduler) return;
  const scheduler = createBatchDetailEnrichmentScheduler();
  globalState.__batchDetailEnrichmentScheduler = scheduler;
  await scheduler.start();
}

export async function ensureBatchDetailEnrichmentJob(input: {
  context: AccessContext;
  batchId: string;
  now?: Date;
}): Promise<{ job: PersistedBatchDetailJob; created: boolean }> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许启动正式 Amazon 商品详情补齐。", 403);
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(input.batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "商品批次不存在。", 404);
  if (batch.batchStatus !== "ready") throw new V5CoreError("BATCH_NOT_READY", "只有 ready 批次可以补齐商品详情。", 409, true);
  const items = createInitialBatchDetailJobItems(await store.getBatchItems(batch.id));
  if (!items.length) throw new V5CoreError("BATCH_HAS_NO_ASINS", "该批次没有可补齐的 Amazon ASIN。", 409);
  return createBatchDetailEnrichmentJobRepository().ensure({ batchId: batch.id, items, now: input.now });
}

export async function getBatchDetailEnrichmentJob(input: {
  context: AccessContext;
  batchId: string;
  now?: Date;
}): Promise<{ scheduled: boolean; job: PersistedBatchDetailJob | null; progress: ReturnType<typeof deriveBatchDetailJobProgress>; executionMode: "scheduled" | "manual_only"; acquisitionEnabled: boolean }> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许读取正式 Amazon 商品详情补齐状态。", 403);
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(input.batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "商品批次不存在。", 404);
  const repository = createBatchDetailEnrichmentJobRepository();
  const persisted = await repository.get(batch.id);
  const config = readCaptureRuntimeConfig();
  const execution = { executionMode: config.detailExecution, acquisitionEnabled: config.enabled };
  if (persisted) return { ...execution, scheduled: true, job: persisted, progress: deriveBatchDetailJobProgress(persisted) };
  const ephemeral: PersistedBatchDetailJob = {
    schemaVersion: BATCH_DETAIL_JOB_SCHEMA_VERSION,
    jobId: "",
    batchId: batch.id,
    status: "PENDING",
    createdAt: (input.now ?? new Date()).toISOString(),
    updatedAt: (input.now ?? new Date()).toISOString(),
    startedAt: null,
    finishedAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextRunAt: null,
    traceIds: [],
    items: createInitialBatchDetailJobItems(await store.getBatchItems(batch.id)),
  };
  return { ...execution, scheduled: false, job: null, progress: deriveBatchDetailJobProgress(ephemeral) };
}

export async function controlBatchDetailEnrichmentJob(input: {
  context: AccessContext;
  batchId: string;
  action: "pause" | "resume" | "cancel";
  now?: Date;
}): Promise<PersistedBatchDetailJob | null> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许修改正式 Amazon 商品详情补齐任务。", 403);
  const repository = createBatchDetailEnrichmentJobRepository();
  if (input.action === "pause") return repository.pause(input.batchId, input.now);
  if (input.action === "resume") return repository.resume(input.batchId, input.now);
  return repository.cancel(input.batchId, input.now);
}

export function parseBatchDetailJobResponse(value: unknown): PersistedBatchDetailJob | null {
  return parsePersistedBatchDetailJob(value);
}

export function batchDetailJobStatus(value: unknown): BatchDetailEnrichmentJobStatus | null {
  return parsePersistedBatchDetailJob(value)?.status ?? null;
}

export async function runBatchDetailEnrichmentJobOnce(input: { context: AccessContext; batchId: string }): Promise<PersistedBatchDetailJob> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "仅本人可以手动补齐正式商品详情。", 403);
  if (!readCaptureRuntimeConfig().enabled) throw new V5CoreError("LOCAL_ENVIRONMENT_REQUIRED", "Amazon 主动采集未开启，未执行或修改任务。", 409);
  await ensureBatchDetailEnrichmentJob(input);
  return createBatchDetailEnrichmentScheduler({ schedulePolling: false }).runOne(input.batchId);
}
