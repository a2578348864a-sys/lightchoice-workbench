import "server-only";

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/server/db";
import {
  cancelSellerSpriteCaptureJob,
  bindSellerSpriteCaptureSnapshot,
  claimSellerSpriteCaptureJob,
  claimSellerSpriteSourceRecheck,
  createSellerSpriteCaptureJob,
  pauseSellerSpriteCaptureJob,
  recordSellerSpriteCaptureProgress,
  resumeSellerSpriteCaptureJob,
  retrySellerSpriteCaptureJob,
  setSellerSpriteCaptureWindowBudget,
  sellerSpriteCaptureJobFingerprint,
  SELLERSPRITE_CAPTURE_JOB_SCHEMA,
  type SellerSpriteCaptureJob,
  type SellerSpriteCaptureJobInput,
} from "@/lib/server/sellerSpriteCaptureJob";

const OPERATION = "source-layer:sellersprite-capture-job:v2";
const ACTOR_SCOPE = "owner:v1";
const IDEMPOTENCY_KEY = "sellersprite-capture-job.v2";
// At 10,000 rows the bounded stable/valid/persisted identity lists exceed 512 KiB.
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

type ReceiptRow = {
  id: string;
  actorScope: string;
  operation: string;
  resourceKey: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseJson: string | null;
  expiresAt: Date | null;
  updatedAt: Date;
};

type RepositoryClient = Pick<PrismaClient, "v5OperationReceipt">;
type ProgressInput = Omit<Parameters<typeof recordSellerSpriteCaptureProgress>[1], "worker" | "fence">;

function parseJob(raw: string | null, row?: ReceiptRow): SellerSpriteCaptureJob | null {
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as SellerSpriteCaptureJob;
    const value: SellerSpriteCaptureJob = {
      ...parsed,
      captureGeneration: parsed.captureGeneration ?? 0,
      snapshotFingerprint: parsed.snapshotFingerprint ?? null,
      cursorWindowFingerprint: parsed.cursorWindowFingerprint ?? null,
      persistedRowKeys: parsed.persistedRowKeys ?? [],
      windowBudget: parsed.windowBudget ?? 8,
      diagnostics: parsed.diagnostics ?? { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    };
    const statuses = ["PENDING", "RUNNING", "PAUSED", "COMPLETE", "PARTIAL", "FAILED", "CANCELLED"];
    const modules = ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend", "historical_trend"];
    const counters = value.counters;
    const counterValues = counters && Object.values(counters).filter((item) => item !== null);
    if (value.schemaVersion !== SELLERSPRITE_CAPTURE_JOB_SCHEMA
      || typeof value.jobId !== "string" || !value.jobId
      || !modules.includes(value.module) || value.marketplace !== "US" || !statuses.includes(value.status)
      || !/^[a-f0-9]{64}$/u.test(value.queryFingerprint)
      || !/^[a-f0-9]{64}$/u.test(value.accessScopeHash)
      || sellerSpriteCaptureJobFingerprint({ module: value.module, marketplace: value.marketplace, query: value.query, accessScopeHash: value.accessScopeHash }) !== value.queryFingerprint
      || !value.query || typeof value.query !== "object" || Object.values(value.query).some((item) => typeof item !== "string")
      || !Array.isArray(value.rowKeys) || !Array.isArray(value.structuredValidRowKeys) || !Array.isArray(value.evidenceRefs)
      || !Array.isArray(value.persistedRowKeys)
      || value.rowKeys.some((item) => typeof item !== "string" || !item.trim())
      || value.structuredValidRowKeys.some((item) => typeof item !== "string" || !item.trim() || !value.rowKeys.includes(item))
      || value.persistedRowKeys.some((item) => typeof item !== "string" || !item.trim() || !value.structuredValidRowKeys.includes(item))
      || value.evidenceRefs.some((item) => typeof item !== "string" || !item.trim())
      || value.rowKeys.length > 10_000 || value.structuredValidRowKeys.length > 10_000 || value.persistedRowKeys.length > 10_000 || value.evidenceRefs.length > 10_000
      || new Set(value.rowKeys).size !== value.rowKeys.length
      || new Set(value.structuredValidRowKeys).size !== value.structuredValidRowKeys.length
      || new Set(value.persistedRowKeys).size !== value.persistedRowKeys.length
      || new Set(value.evidenceRefs).size !== value.evidenceRefs.length
      || !counters || !counterValues || counterValues.some((item) => !Number.isSafeInteger(item) || item < 0)
      || counters.structuredValidRows > counters.capturedUniqueRows
      || counters.structuredValidRows !== value.structuredValidRowKeys.length
      || counters.persistedEvidenceRows !== value.persistedRowKeys.length
      || counters.capturedUniqueRows !== value.rowKeys.length
      || counters.persistedEvidenceRows > counters.structuredValidRows
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))
      || !Number.isSafeInteger(value.attemptGeneration) || value.attemptGeneration < 0
      || !Number.isSafeInteger(value.windowBudget) || value.windowBudget < 1 || value.windowBudget > 20
      || !Number.isSafeInteger(value.captureGeneration) || (value.captureGeneration ?? 0) < 0
      || (value.snapshotFingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.snapshotFingerprint ?? ""))
      || (value.cursorWindowFingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.cursorWindowFingerprint ?? ""))
      || !value.diagnostics
      || [value.diagnostics.actualVisibleRows, value.diagnostics.duplicatesRejected, value.diagnostics.rejectedRows, value.diagnostics.windowsProcessed]
        .some((item) => !Number.isSafeInteger(item) || item < 0)
      || (value.diagnostics.cursorRestored !== undefined && value.diagnostics.cursorRestored !== null && typeof value.diagnostics.cursorRestored !== "boolean")
      || !Number.isSafeInteger(value.fence) || value.fence < 0
      || ((value.status === "RUNNING") !== (value.leaseOwner !== null && value.leaseExpiresAt !== null))
      || (row && (value.jobId !== row.id || value.queryFingerprint !== row.resourceKey || value.status !== row.status))) return null;
    return value;
  } catch {
    return null;
  }
}

export class SellerSpriteCaptureJobRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SellerSpriteCaptureJobRepositoryError";
  }
}

export function createSellerSpriteCaptureJobRepository(database: RepositoryClient = prisma) {
  const table = database.v5OperationReceipt;

  function unique(queryFingerprint: string) {
    return { where: { actorScope_operation_resourceKey_idempotencyKey: {
      actorScope: ACTOR_SCOPE, operation: OPERATION, resourceKey: queryFingerprint, idempotencyKey: IDEMPOTENCY_KEY,
    } } };
  }

  async function getRow(jobId: string): Promise<ReceiptRow | null> {
    return await table.findUnique({ where: { id: jobId } }) as ReceiptRow | null;
  }

  async function mutate(
    jobId: string,
    transform: (job: SellerSpriteCaptureJob) => SellerSpriteCaptureJob | null,
    options: { now: Date; worker?: string; fence?: number } ,
  ): Promise<SellerSpriteCaptureJob | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const row = await getRow(jobId);
      const current = row?.actorScope === ACTOR_SCOPE && row.operation === OPERATION ? parseJob(row.responseJson, row) : null;
      if (!row || !current) return null;
      if (options.worker && (current.status !== "RUNNING" || current.leaseOwner !== options.worker
        || current.fence !== options.fence || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= options.now.getTime())) return null;
      const next = transform(current);
      if (!next) return null;
      const responseJson = JSON.stringify(next);
      if (Buffer.byteLength(responseJson, "utf8") > MAX_CHECKPOINT_BYTES) return null;
      const expiresAt = next.status === "RUNNING" && next.leaseExpiresAt
        ? new Date(next.leaseExpiresAt)
        : next.status === "PENDING" ? options.now : null;
      const updated = await table.updateMany({
        where: {
          id: row.id,
          status: row.status,
          updatedAt: row.updatedAt,
          responseJson: row.responseJson,
          ...(options.worker ? { expiresAt: { gt: options.now } } : {}),
        },
        data: { status: next.status, responseJson, expiresAt },
      });
      if (updated.count === 1) return next;
    }
    throw new SellerSpriteCaptureJobRepositoryError("JOB_UPDATE_CONTENTION");
  }

  return {
    async ensure(input: SellerSpriteCaptureJobInput, now = new Date()): Promise<{ job: SellerSpriteCaptureJob; created: boolean }> {
      const proposed = createSellerSpriteCaptureJob(input, now);
      const existingRow = await table.findUnique(unique(proposed.queryFingerprint)) as ReceiptRow | null;
      const existing = existingRow ? parseJob(existingRow.responseJson, existingRow) : null;
      if (existingRow && !existing) throw new SellerSpriteCaptureJobRepositoryError("JOB_CHECKPOINT_INVALID");
      if (existing) {
        if (input.windowBudget === undefined || input.windowBudget === existing.windowBudget || existing.status === "RUNNING"
          || existing.status === "COMPLETE" || existing.status === "CANCELLED") return { job: existing, created: false };
        const updated = await mutate(existing.jobId, (current) =>
          setSellerSpriteCaptureWindowBudget(current, input.windowBudget as number, now), { now });
        if (!updated) throw new SellerSpriteCaptureJobRepositoryError("JOB_WINDOW_BUDGET_UPDATE_REJECTED");
        return { job: updated, created: false };
      }
      const job = { ...proposed, jobId: randomUUID() };
      try {
        await table.create({ data: {
          id: job.jobId,
          actorScope: ACTOR_SCOPE,
          operation: OPERATION,
          resourceKey: job.queryFingerprint,
          idempotencyKey: IDEMPOTENCY_KEY,
          requestHash: job.queryFingerprint,
          status: job.status,
          responseJson: JSON.stringify(job),
          expiresAt: now,
        } });
        return { job, created: true };
      } catch (error) {
        const racedRow = await table.findUnique(unique(job.queryFingerprint)) as ReceiptRow | null;
        const raced = racedRow ? parseJob(racedRow.responseJson, racedRow) : null;
        if (raced) return { job: raced, created: false };
        throw error;
      }
    },

    async getByFingerprint(queryFingerprint: string): Promise<SellerSpriteCaptureJob | null> {
      const row = await table.findUnique(unique(queryFingerprint)) as ReceiptRow | null;
      if (!row || row.actorScope !== ACTOR_SCOPE || row.operation !== OPERATION) return null;
      return parseJob(row.responseJson, row);
    },

    async getById(jobId: string): Promise<SellerSpriteCaptureJob | null> {
      const row = await getRow(jobId);
      if (!row || row.actorScope !== ACTOR_SCOPE || row.operation !== OPERATION) return null;
      return parseJob(row.responseJson, row);
    },

    async claim(jobId: string, worker: string, now = new Date(), leaseMs = 120_000) {
      const claimBox: { value: ReturnType<typeof claimSellerSpriteCaptureJob> } = { value: null };
      const job = await mutate(jobId, (current) => {
        claimBox.value = claimSellerSpriteCaptureJob(current, worker, now, leaseMs);
        return claimBox.value?.job ?? null;
      }, { now });
      return job && claimBox.value ? { job, fence: claimBox.value.fence } : null;
    },

    async claimSourceRecheck(jobId: string, worker: string, now = new Date()) {
      const job = await mutate(jobId, (current) => claimSellerSpriteSourceRecheck(current, worker, now)?.job ?? null, { now });
      return job ? { job, fence: job.fence } : null;
    },

    async bindSnapshot(jobId: string, worker: string, fence: number, snapshot: {
      snapshotFingerprint: string;
      reportedTotalRows: number | null;
      accessibleRows: number | null;
      unavailableRows: number | null;
      forceNewGeneration?: boolean;
    }, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => bindSellerSpriteCaptureSnapshot(current, {
        ...snapshot, worker, fence, now,
      }), { now, worker, fence });
    },

    async saveProgress(jobId: string, worker: string, fence: number, progress: ProgressInput): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => recordSellerSpriteCaptureProgress(current, {
        ...progress, worker, fence,
      }), { now: progress.now, worker, fence });
    },

    async pause(jobId: string, actor: string, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => pauseSellerSpriteCaptureJob(current, now, actor), { now });
    },

    async resume(jobId: string, actor: string, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => resumeSellerSpriteCaptureJob(current, now, actor), { now });
    },

    async retry(jobId: string, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => retrySellerSpriteCaptureJob(current, now), { now });
    },

    async setWindowBudget(jobId: string, windowBudget: number, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => setSellerSpriteCaptureWindowBudget(current, windowBudget, now), { now });
    },

    async cancel(jobId: string, actor: string, now = new Date()): Promise<SellerSpriteCaptureJob | null> {
      return mutate(jobId, (current) => cancelSellerSpriteCaptureJob(current, now, actor), { now });
    },

    async listResumable(now = new Date(), limit = 100): Promise<SellerSpriteCaptureJob[]> {
      const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
      const rows = await table.findMany({
        where: { actorScope: ACTOR_SCOPE, operation: OPERATION, status: { in: ["PENDING", "RUNNING"] },
          OR: [{ expiresAt: null }, { expiresAt: { lte: now } }] },
        orderBy: { createdAt: "asc" },
        take: bounded,
      }) as ReceiptRow[];
      return rows.flatMap((row) => {
        const job = parseJob(row.responseJson, row);
        if (!job) return [];
        if (job.status === "RUNNING" && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now.getTime())) return [];
        if (job.status === "PENDING" && job.updatedAt > now.toISOString()) return [];
        return [job];
      });
    },
  };
}
