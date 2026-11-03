import "server-only";

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/server/db";
import { hashJson } from "@/lib/server/v5CanonicalHash";
import {
  BATCH_DETAIL_JOB_SCHEMA_VERSION,
  MAX_DETAIL_ITEM_AUTO_ATTEMPTS,
  parsePersistedBatchDetailJob,
  type PersistedBatchDetailJob,
  type PersistedBatchDetailJobItem,
} from "@/lib/server/batchDetailEnrichmentJob";

const OPERATION = "source-layer:batch-detail-job:v1";
const RESOURCE_SCOPE = "owner:v1";
const IDEMPOTENCY_KEY = "amazon-detail-job.v1";

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

export class BatchDetailEnrichmentJobRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BatchDetailEnrichmentJobRepositoryError";
  }
}

export type BatchDetailEnrichmentJobRepository = ReturnType<typeof createBatchDetailEnrichmentJobRepository>;

export function createBatchDetailEnrichmentJobRepository(database: RepositoryClient = prisma) {
  const table = database.v5OperationReceipt;

  function whereUnique(batchId: string) {
    return {
      where: {
        actorScope_operation_resourceKey_idempotencyKey: {
          actorScope: RESOURCE_SCOPE,
          operation: OPERATION,
          resourceKey: batchId,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      },
    };
  }

  function mapRow(row: ReceiptRow | null): PersistedBatchDetailJob | null {
    if (!row || row.actorScope !== RESOURCE_SCOPE || row.operation !== OPERATION || !row.responseJson) return null;
    const job = parsePersistedBatchDetailJob(row.responseJson);
    if (!job || job.jobId !== row.id || job.batchId !== row.resourceKey || job.status !== row.status) return null;
    return job;
  }

  async function findById(jobId: string): Promise<ReceiptRow | null> {
    return await table.findUnique({ where: { id: jobId } }) as ReceiptRow | null;
  }

  async function updateJob(
    jobId: string,
    update: (current: PersistedBatchDetailJob) => PersistedBatchDetailJob | null,
    options: { now?: Date; leaseOwner?: string; allowPausedLease?: boolean; allowCancelledLease?: boolean } = {},
  ): Promise<PersistedBatchDetailJob | null> {
    const now = options.now ?? new Date();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const row = await findById(jobId);
      const current = mapRow(row);
      if (!row || !current) return null;
      if (options.leaseOwner && current.leaseOwner !== options.leaseOwner) return null;
      if (options.leaseOwner && (current.status !== "RUNNING" || !current.leaseExpiresAt
        || Date.parse(current.leaseExpiresAt) <= now.getTime())) return null;
      const next = update(current);
      if (!next) return null;
      const expiresAt = next.status === "RUNNING" && next.leaseExpiresAt
        ? new Date(next.leaseExpiresAt)
        : next.status === "PENDING"
          ? new Date(next.nextRunAt ?? now.toISOString())
          : null;
      const changed = await table.updateMany({
        where: { id: row.id, status: row.status, updatedAt: row.updatedAt, responseJson: row.responseJson,
          ...(options.leaseOwner ? { expiresAt: { gt: now } } : {}),
        },
        data: {
          status: next.status,
          responseJson: JSON.stringify({ ...next, updatedAt: now.toISOString() }),
          expiresAt,
        },
      });
      if (changed.count === 1) return { ...next, updatedAt: now.toISOString() };
    }
    throw new BatchDetailEnrichmentJobRepositoryError("JOB_UPDATE_CONTENTION");
  }

  return {
    async ensure(input: {
      batchId: string;
      items: readonly PersistedBatchDetailJobItem[];
      now?: Date;
    }): Promise<{ job: PersistedBatchDetailJob; created: boolean }> {
      const now = input.now ?? new Date();
      if (!/^[A-Za-z0-9_-]{10,64}$/u.test(input.batchId)
        || input.items.length < 1
        || input.items.length > 500
        || new Set(input.items.map((item) => item.asin)).size !== input.items.length) {
        throw new BatchDetailEnrichmentJobRepositoryError("JOB_INPUT_INVALID");
      }
      const requestHash = hashJson({
        schemaVersion: BATCH_DETAIL_JOB_SCHEMA_VERSION,
        batchId: input.batchId,
        items: input.items.map(({ itemId, asin }) => ({ itemId, asin })),
      });
      const existing = mapRow(await table.findUnique(whereUnique(input.batchId)) as ReceiptRow | null);
      if (existing) {
        const row = await table.findUnique(whereUnique(input.batchId)) as ReceiptRow | null;
        if (row?.requestHash !== requestHash) throw new BatchDetailEnrichmentJobRepositoryError("JOB_INPUT_CHANGED");
        return { job: existing, created: false };
      }

      const jobId = randomUUID();
      const created: PersistedBatchDetailJob = {
        schemaVersion: BATCH_DETAIL_JOB_SCHEMA_VERSION,
        jobId,
        batchId: input.batchId,
        status: "PENDING",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        startedAt: null,
        finishedAt: null,
        attemptCount: 0,
        lastErrorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: now.toISOString(),
        traceIds: [],
        items: input.items.map((item) => ({ ...item })),
      };
      try {
        await table.create({
          data: {
            id: jobId,
            actorScope: RESOURCE_SCOPE,
            operation: OPERATION,
            resourceKey: input.batchId,
            idempotencyKey: IDEMPOTENCY_KEY,
            requestHash,
            status: created.status,
            responseJson: JSON.stringify(created),
            expiresAt: now,
          },
        });
        return { job: created, created: true };
      } catch (error) {
        const racedRow = await table.findUnique(whereUnique(input.batchId)) as ReceiptRow | null;
        const raced = mapRow(racedRow);
        if (raced && racedRow?.requestHash === requestHash) return { job: raced, created: false };
        if (raced) throw new BatchDetailEnrichmentJobRepositoryError("JOB_INPUT_CHANGED");
        throw error;
      }
    },

    async get(batchId: string): Promise<PersistedBatchDetailJob | null> {
      return mapRow(await table.findUnique(whereUnique(batchId)) as ReceiptRow | null);
    },

    async getById(jobId: string): Promise<PersistedBatchDetailJob | null> {
      return mapRow(await findById(jobId));
    },

    async listDue(now = new Date(), limit = 100): Promise<PersistedBatchDetailJob[]> {
      const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
      const rows = await table.findMany({
        where: {
          actorScope: RESOURCE_SCOPE,
          operation: OPERATION,
          status: { in: ["PENDING", "RUNNING"] },
          OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
        },
        orderBy: { createdAt: "asc" },
        take: boundedLimit,
      }) as ReceiptRow[];
      return rows.flatMap((row) => {
        const job = mapRow(row);
        if (!job) return [];
        const dueAt = job.status === "RUNNING" ? job.leaseExpiresAt : job.nextRunAt;
        return !dueAt || Date.parse(dueAt) <= now.getTime() ? [job] : [];
      });
    },

    async claim(input: {
      jobId: string;
      owner: string;
      now?: Date;
      leaseMs?: number;
    }): Promise<PersistedBatchDetailJob | null> {
      const now = input.now ?? new Date();
      const row = await findById(input.jobId);
      const current = mapRow(row);
      if (!row || !current || (current.status !== "PENDING" && current.status !== "RUNNING")) return null;
      const dueAt = current.status === "RUNNING" ? current.leaseExpiresAt : current.nextRunAt;
      if (dueAt && Date.parse(dueAt) > now.getTime()) return null;
      const leaseExpiresAt = new Date(now.getTime() + Math.max(60_000, input.leaseMs ?? 120_000)).toISOString();
      const recoveredItems = current.items.map((item) => item.status === "RUNNING"
        ? {
            ...item,
            status: item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? "FAILED_PERMANENT" as const : "FAILED_RETRYABLE" as const,
            nextAttemptAt: item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? null : now.toISOString(),
            lastErrorCode: item.lastErrorCode ?? "WORKER_RESTARTED_DURING_ITEM",
          }
        : item);
      const next: PersistedBatchDetailJob = {
        ...current,
        status: "RUNNING",
        updatedAt: now.toISOString(),
        startedAt: current.startedAt ?? now.toISOString(),
        finishedAt: null,
        attemptCount: current.attemptCount + 1,
        leaseOwner: input.owner,
        leaseExpiresAt,
        nextRunAt: null,
        items: recoveredItems,
      };
      const claimed = await table.updateMany({
        where: {
          id: row.id,
          status: row.status,
          updatedAt: row.updatedAt,
          responseJson: row.responseJson,
          ...(row.status === "RUNNING" ? { expiresAt: { lte: now } } : {}),
        },
        data: { status: next.status, responseJson: JSON.stringify(next), expiresAt: new Date(leaseExpiresAt) },
      });
      return claimed.count === 1 ? next : null;
    },

    updateJob,

    async pause(batchId: string, now = new Date()): Promise<PersistedBatchDetailJob | null> {
      const current = mapRow(await table.findUnique(whereUnique(batchId)) as ReceiptRow | null);
      if (!current || !["PENDING", "RUNNING"].includes(current.status)) return current;
      return updateJob(current.jobId, (job) => !["PENDING", "RUNNING"].includes(job.status) ? null : ({
        ...job,
        status: "PAUSED",
        updatedAt: now.toISOString(),
        nextRunAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        finishedAt: null,
        items: job.items.map((item) => item.status === "RUNNING"
          ? { ...item, status: item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? "FAILED_PERMANENT" : "FAILED_RETRYABLE", nextAttemptAt: null, lastErrorCode: "JOB_PAUSED_DURING_ITEM" }
          : item),
      }), { now });
    },

    async resume(batchId: string, now = new Date()): Promise<PersistedBatchDetailJob | null> {
      const current = mapRow(await table.findUnique(whereUnique(batchId)) as ReceiptRow | null);
      if (!current || !["PAUSED", "FAILED", "CANCELLED"].includes(current.status)) return current;
      return updateJob(current.jobId, (job) => !["PAUSED", "FAILED", "CANCELLED"].includes(job.status) ? null : ({
        ...job,
        status: "PENDING",
        updatedAt: now.toISOString(),
        finishedAt: null,
        lastErrorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: now.toISOString(),
        items: job.items.map((item) => ["HUMAN_REQUIRED", "FAILED_PERMANENT"].includes(item.status)
          || (item.status === "FAILED_RETRYABLE" && item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS)
          ? { ...item, status: "PENDING", attemptCount: 0, nextAttemptAt: null, lastErrorCode: null }
          : item),
      }), { now });
    },

    async cancel(batchId: string, now = new Date()): Promise<PersistedBatchDetailJob | null> {
      const current = mapRow(await table.findUnique(whereUnique(batchId)) as ReceiptRow | null);
      if (!current || ["COMPLETED", "CANCELLED"].includes(current.status)) return current;
      return updateJob(current.jobId, (job) => ["COMPLETED", "CANCELLED"].includes(job.status) ? null : ({
        ...job,
        status: "CANCELLED",
        updatedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        nextRunAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        lastErrorCode: null,
        items: job.items.map((item) => item.status === "RUNNING"
          ? { ...item, status: "FAILED_RETRYABLE", nextAttemptAt: now.toISOString(), lastErrorCode: "JOB_CANCELLED_DURING_ITEM" }
          : item),
      }), { now });
    },

    async reconcileRestartedLeases(now = new Date()): Promise<number> {
      const due = await table.findMany({
        where: {
          actorScope: RESOURCE_SCOPE,
          operation: OPERATION,
          status: "RUNNING",
          expiresAt: { lte: now },
        },
        orderBy: { createdAt: "asc" },
        take: 200,
      }) as ReceiptRow[];
      let recovered = 0;
      for (const row of due) {
        const job = mapRow(row);
        if (!job || job.status !== "RUNNING" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now.getTime()) continue;
        const changed = await updateJob(job.jobId, (current) => current.status !== "RUNNING" || !current.leaseExpiresAt
          || Date.parse(current.leaseExpiresAt) > now.getTime() ? null : ({
          ...current,
          status: "PENDING",
          updatedAt: now.toISOString(),
          nextRunAt: now.toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
          items: current.items.map((item) => item.status === "RUNNING"
            ? { ...item, status: item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? "FAILED_PERMANENT" : "FAILED_RETRYABLE", nextAttemptAt: item.attemptCount >= MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? null : now.toISOString(), lastErrorCode: item.lastErrorCode ?? "WORKER_RESTARTED_DURING_ITEM" }
            : item),
        }), { now });
        if (changed?.status === "PENDING") recovered += 1;
      }
      return recovered;
    },
  };
}
