import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/server/db";
import { isMonitoringSchedule, isValidTimeZone, parseMonitoringPolicy, type MonitoringSchedule } from "@/lib/server/continuousMonitoringContract";
import type { MonitoringEvidenceReference } from "@/lib/server/continuousMonitoringDiff";
import type { MonitoringPolicy } from "@/lib/server/continuousMonitoringDiff";

export type MonitoringRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED_OVERLAP" | "SKIPPED_DISABLED";
export type MonitoringTriggerType = "MANUAL" | "SCHEDULED";

export type MonitoringWatchTarget = {
  id: string;
  subjectKey: string;
  captureModule: "amazon_detail";
  enabled: boolean;
  schedule: MonitoringSchedule;
  timezone: string;
  policy: MonitoringPolicy;
  lastRunAt: string | null;
  lastMeaningfulChangeAt: string | null;
  nextRunAt: string;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MonitoringRunRecord = {
  id: string;
  watchTargetId: string;
  triggerType: MonitoringTriggerType;
  status: MonitoringRunStatus;
  outcome: string | null;
  startedAt: string;
  finishedAt: string | null;
  previousEvidenceRef: MonitoringEvidenceReference | null;
  currentEvidenceRef: MonitoringEvidenceReference | null;
  changeSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  aiExplanation: Record<string, unknown> | null;
};

export type MonitoringWatchPatch = Partial<{
  enabled: boolean;
  schedule: MonitoringSchedule;
  timezone: string;
  policy: MonitoringPolicy;
}>;

export type BeginMonitoringRunResult =
  | { kind: "STARTED"; watch: MonitoringWatchTarget; run: MonitoringRunRecord }
  | { kind: "OVERLAP"; run: MonitoringRunRecord }
  | { kind: "DISABLED"; run: MonitoringRunRecord }
  | { kind: "NOT_DUE" }
  | { kind: "NOT_FOUND" };

export type MonitoringRepository = {
  createWatch(input: MonitoringWatchTarget): Promise<MonitoringWatchTarget>;
  getWatch(id: string): Promise<MonitoringWatchTarget | null>;
  listWatches(): Promise<MonitoringWatchTarget[]>;
  updateWatch(id: string, patch: MonitoringWatchPatch, nextRunAt: string): Promise<MonitoringWatchTarget | null>;
  listDueWatches(now: Date): Promise<MonitoringWatchTarget[]>;
  latestBaseline(watchTargetId: string): Promise<MonitoringEvidenceReference | null>;
  beginRun(input: {
    watchTargetId: string;
    runId: string;
    triggerType: MonitoringTriggerType;
    startedAt: string;
    nextRunAt: string;
  }): Promise<BeginMonitoringRunResult>;
  completeRun(input: {
    runId: string;
    watchTargetId: string;
    finishedAt: string;
    outcome: string;
    previousEvidenceRef: MonitoringEvidenceReference | null;
    currentEvidenceRef: MonitoringEvidenceReference;
    changeSummary: Record<string, unknown>;
    aiExplanation: Record<string, unknown> | null;
    meaningfulChange: boolean;
  }): Promise<void>;
  failRun(input: {
    runId: string;
    watchTargetId: string;
    finishedAt: string;
    errorCode: string;
    errorMessage: string;
    previousEvidenceRef: MonitoringEvidenceReference | null;
  }): Promise<void>;
  listRuns(watchTargetId: string, take?: number): Promise<MonitoringRunRecord[]>;
  getRun(runId: string): Promise<MonitoringRunRecord | null>;
  recoverInterruptedRuns(now: string): Promise<number>;
};

type RawSqlClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type RawDatabase = RawSqlClient & {
  $transaction<T>(action: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

type WatchRow = {
  id: string;
  subjectKey: string;
  captureModule: string;
  enabled: number | boolean;
  schedule: string;
  timezone: string;
  policyJson: string;
  lastRunAt: string | Date | null;
  lastMeaningfulChangeAt: string | Date | null;
  nextRunAt: string | Date;
  activeRunId: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type RunRow = {
  id: string;
  watchTargetId: string;
  triggerType: string;
  status: string;
  outcome: string | null;
  startedAt: string | Date;
  finishedAt: string | Date | null;
  previousEvidenceRefJson: string | null;
  currentEvidenceRefJson: string | null;
  changeSummaryJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  aiExplanationJson: string | null;
};

export class MonitoringRepositoryError extends Error {
  constructor(public readonly code: "TARGET_ALREADY_EXISTS" | "STORAGE_CORRUPT" | "RUN_FINALIZE_CONFLICT") {
    super(code);
    this.name = "MonitoringRepositoryError";
  }
}
function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  return parsed.toISOString();
}

function jsonObject<T extends Record<string, unknown>>(value: string | null): T | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not_object");
    return parsed as T;
  } catch {
    throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  }
}

function mapWatch(row: WatchRow): MonitoringWatchTarget {
  let storedPolicy: unknown;
  try {
    storedPolicy = JSON.parse(row.policyJson);
  } catch {
    throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  }
  const policy = parseMonitoringPolicy(storedPolicy);
  if (row.captureModule !== "amazon_detail"
    || !isMonitoringSchedule(row.schedule)
    || !isValidTimeZone(row.timezone)
    || !policy) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  const nextRunAt = iso(row.nextRunAt);
  if (!nextRunAt) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  return {
    id: row.id,
    subjectKey: row.subjectKey,
    captureModule: "amazon_detail",
    enabled: row.enabled === true || row.enabled === 1,
    schedule: row.schedule,
    timezone: row.timezone,
    policy,
    lastRunAt: iso(row.lastRunAt),
    lastMeaningfulChangeAt: iso(row.lastMeaningfulChangeAt),
    nextRunAt,
    activeRunId: row.activeRunId,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

function mapRun(row: RunRow): MonitoringRunRecord {
  const triggerType = row.triggerType;
  const status = row.status;
  if ((triggerType !== "MANUAL" && triggerType !== "SCHEDULED")
    || !["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED_OVERLAP", "SKIPPED_DISABLED"].includes(status)) {
    throw new MonitoringRepositoryError("STORAGE_CORRUPT");
  }
  return {
    id: row.id,
    watchTargetId: row.watchTargetId,
    triggerType,
    status: status as MonitoringRunStatus,
    outcome: row.outcome,
    startedAt: iso(row.startedAt) as string,
    finishedAt: iso(row.finishedAt),
    previousEvidenceRef: jsonObject<MonitoringEvidenceReference>(row.previousEvidenceRefJson),
    currentEvidenceRef: jsonObject<MonitoringEvidenceReference>(row.currentEvidenceRefJson),
    changeSummary: jsonObject(row.changeSummaryJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    aiExplanation: jsonObject(row.aiExplanationJson),
  };
}

const WATCH_SELECT = Prisma.sql`
  SELECT "id", "subjectKey", "captureModule", "enabled", "schedule", "timezone", "policyJson",
         "lastRunAt", "lastMeaningfulChangeAt", "nextRunAt", "activeRunId", "createdAt", "updatedAt"
  FROM "WatchTarget"
`;

const RUN_SELECT = Prisma.sql`
  SELECT "id", "watchTargetId", "triggerType", "status", "outcome", "startedAt", "finishedAt",
         "previousEvidenceRefJson", "currentEvidenceRefJson", "changeSummaryJson", "errorCode", "errorMessage", "aiExplanationJson"
  FROM "MonitoringRun"
`;

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function createMonitoringRepository(database: PrismaClient = defaultPrisma): MonitoringRepository {
  const db = database as unknown as RawDatabase;

  async function findWatch(client: RawSqlClient, id: string): Promise<MonitoringWatchTarget | null> {
    const rows = await client.$queryRaw<WatchRow[]>(Prisma.sql`${WATCH_SELECT} WHERE "id" = ${id} LIMIT 1`);
    return rows[0] ? mapWatch(rows[0]) : null;
  }

  async function insertSkippedRun(
    tx: RawSqlClient,
    input: { runId: string; watchTargetId: string; triggerType: MonitoringTriggerType; now: string; status: "SKIPPED_OVERLAP" | "SKIPPED_DISABLED" },
  ): Promise<MonitoringRunRecord> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MonitoringRun" ("id", "watchTargetId", "triggerType", "status", "outcome", "startedAt", "finishedAt")
      VALUES (${input.runId}, ${input.watchTargetId}, ${input.triggerType}, ${input.status}, ${input.status}, ${input.now}, ${input.now})
    `);
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`${RUN_SELECT} WHERE "id" = ${input.runId} LIMIT 1`);
    if (!rows[0]) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
    return mapRun(rows[0]);
  }

  return {
    async createWatch(input) {
      try {
        await db.$executeRaw(Prisma.sql`
          INSERT INTO "WatchTarget" (
            "id", "subjectKey", "captureModule", "enabled", "schedule", "timezone", "policyJson",
            "lastRunAt", "lastMeaningfulChangeAt", "nextRunAt", "activeRunId", "createdAt", "updatedAt"
          ) VALUES (
            ${input.id}, ${input.subjectKey}, ${input.captureModule}, ${input.enabled}, ${input.schedule}, ${input.timezone}, ${toJson(input.policy)},
            ${input.lastRunAt}, ${input.lastMeaningfulChangeAt}, ${input.nextRunAt}, ${input.activeRunId}, ${input.createdAt}, ${input.updatedAt}
          )
        `);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        if (/UNIQUE constraint failed.*WatchTarget/iu.test(detail)) throw new MonitoringRepositoryError("TARGET_ALREADY_EXISTS");
        throw error;
      }
      const created = await findWatch(db, input.id);
      if (!created) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
      return created;
    },

    getWatch(id) {
      return findWatch(db, id);
    },

    async listWatches() {
      const rows = await db.$queryRaw<WatchRow[]>(Prisma.sql`${WATCH_SELECT} ORDER BY "createdAt" DESC LIMIT 200`);
      return rows.map(mapWatch);
    },

    async updateWatch(id, patch, nextRunAt) {
      const assignments: Prisma.Sql[] = [Prisma.sql`"nextRunAt" = ${nextRunAt}`, Prisma.sql`"updatedAt" = ${new Date().toISOString()}`];
      if (patch.enabled !== undefined) assignments.push(Prisma.sql`"enabled" = ${patch.enabled}`);
      if (patch.schedule !== undefined) assignments.push(Prisma.sql`"schedule" = ${patch.schedule}`);
      if (patch.timezone !== undefined) assignments.push(Prisma.sql`"timezone" = ${patch.timezone}`);
      if (patch.policy !== undefined) assignments.push(Prisma.sql`"policyJson" = ${toJson(patch.policy)}`);
      await db.$executeRaw(Prisma.sql`UPDATE "WatchTarget" SET ${Prisma.join(assignments, ", ")} WHERE "id" = ${id}`);
      return findWatch(db, id);
    },

    async listDueWatches(now) {
      const rows = await db.$queryRaw<WatchRow[]>(Prisma.sql`${WATCH_SELECT} WHERE "enabled" = 1 ORDER BY "nextRunAt" ASC LIMIT 200`);
      return rows.map(mapWatch).filter((watch) => Date.parse(watch.nextRunAt) <= now.getTime());
    },

    async latestBaseline(watchTargetId) {
      const rows = await db.$queryRaw<Array<{ currentEvidenceRefJson: string | null }>>(Prisma.sql`
        SELECT "currentEvidenceRefJson" FROM "MonitoringRun"
        WHERE "watchTargetId" = ${watchTargetId}
          AND "outcome" IN ('BASELINE_ESTABLISHED', 'CHANGE_DETECTED', 'COOLDOWN_SUPPRESSED')
          AND "currentEvidenceRefJson" IS NOT NULL
        ORDER BY "startedAt" DESC LIMIT 1
      `);
      return jsonObject<MonitoringEvidenceReference>(rows[0]?.currentEvidenceRefJson ?? null);
    },

    async beginRun(input) {
      return db.$transaction(async (tx) => {
        const watch = await findWatch(tx, input.watchTargetId);
        if (!watch) return { kind: "NOT_FOUND" } as const;
        if (watch.activeRunId) {
          const run = await insertSkippedRun(tx, { ...input, now: input.startedAt, status: "SKIPPED_OVERLAP" });
          return { kind: "OVERLAP", run } as const;
        }
        if (!watch.enabled) {
          const run = await insertSkippedRun(tx, { ...input, now: input.startedAt, status: "SKIPPED_DISABLED" });
          return { kind: "DISABLED", run } as const;
        }
        if (input.triggerType === "SCHEDULED" && Date.parse(watch.nextRunAt) > Date.parse(input.startedAt)) {
          return { kind: "NOT_DUE" } as const;
        }
        const claimed = await tx.$executeRaw(Prisma.sql`
          UPDATE "WatchTarget"
          SET "activeRunId" = ${input.runId}, "nextRunAt" = ${input.nextRunAt}, "updatedAt" = ${input.startedAt}
          WHERE "id" = ${input.watchTargetId} AND "enabled" = 1 AND "activeRunId" IS NULL
        `);
        if (claimed !== 1) {
          const latest = await findWatch(tx, input.watchTargetId);
          const status = latest?.enabled ? "SKIPPED_OVERLAP" : "SKIPPED_DISABLED";
          const run = await insertSkippedRun(tx, { ...input, now: input.startedAt, status });
          return status === "SKIPPED_OVERLAP" ? { kind: "OVERLAP", run } as const : { kind: "DISABLED", run } as const;
        }
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MonitoringRun" ("id", "watchTargetId", "triggerType", "status", "outcome", "startedAt")
          VALUES (${input.runId}, ${input.watchTargetId}, ${input.triggerType}, 'RUNNING', 'RUNNING', ${input.startedAt})
        `);
        const activeWatch = await findWatch(tx, input.watchTargetId);
        const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`${RUN_SELECT} WHERE "id" = ${input.runId} LIMIT 1`);
        if (!activeWatch || !rows[0]) throw new MonitoringRepositoryError("STORAGE_CORRUPT");
        return { kind: "STARTED", watch: activeWatch, run: mapRun(rows[0]) } as const;
      });
    },

    async completeRun(input) {
      await db.$transaction(async (tx) => {
        const updatedRun = await tx.$executeRaw(Prisma.sql`
          UPDATE "MonitoringRun"
          SET "status" = 'SUCCEEDED', "outcome" = ${input.outcome}, "finishedAt" = ${input.finishedAt},
              "previousEvidenceRefJson" = ${input.previousEvidenceRef ? toJson(input.previousEvidenceRef) : null},
              "currentEvidenceRefJson" = ${toJson(input.currentEvidenceRef)},
              "changeSummaryJson" = ${toJson(input.changeSummary)}, "aiExplanationJson" = ${input.aiExplanation ? toJson(input.aiExplanation) : null},
              "errorCode" = NULL, "errorMessage" = NULL
          WHERE "id" = ${input.runId} AND "status" = 'RUNNING'
        `);
        if (updatedRun !== 1) throw new MonitoringRepositoryError("RUN_FINALIZE_CONFLICT");
        const updatedWatch = await tx.$executeRaw(Prisma.sql`
          UPDATE "WatchTarget"
          SET "activeRunId" = NULL, "lastRunAt" = ${input.finishedAt},
              "lastMeaningfulChangeAt" = CASE WHEN ${input.meaningfulChange} = 1 THEN ${input.finishedAt} ELSE "lastMeaningfulChangeAt" END,
              "updatedAt" = ${input.finishedAt}
          WHERE "id" = ${input.watchTargetId} AND "activeRunId" = ${input.runId}
        `);
        if (updatedWatch !== 1) throw new MonitoringRepositoryError("RUN_FINALIZE_CONFLICT");
      });
    },

    async failRun(input) {
      await db.$transaction(async (tx) => {
        const updatedRun = await tx.$executeRaw(Prisma.sql`
          UPDATE "MonitoringRun"
          SET "status" = 'FAILED', "outcome" = 'RUN_FAILED', "finishedAt" = ${input.finishedAt},
              "previousEvidenceRefJson" = ${input.previousEvidenceRef ? toJson(input.previousEvidenceRef) : null},
              "errorCode" = ${input.errorCode}, "errorMessage" = ${input.errorMessage}
          WHERE "id" = ${input.runId} AND "status" = 'RUNNING'
        `);
        if (updatedRun !== 1) throw new MonitoringRepositoryError("RUN_FINALIZE_CONFLICT");
        const updatedWatch = await tx.$executeRaw(Prisma.sql`
          UPDATE "WatchTarget" SET "activeRunId" = NULL, "lastRunAt" = ${input.finishedAt}, "updatedAt" = ${input.finishedAt}
          WHERE "id" = ${input.watchTargetId} AND "activeRunId" = ${input.runId}
        `);
        if (updatedWatch !== 1) throw new MonitoringRepositoryError("RUN_FINALIZE_CONFLICT");
      });
    },

    async listRuns(watchTargetId, take = 50) {
      const boundedTake = Math.max(1, Math.min(100, Math.trunc(take)));
      const rows = await db.$queryRaw<RunRow[]>(Prisma.sql`${RUN_SELECT} WHERE "watchTargetId" = ${watchTargetId} ORDER BY "startedAt" DESC LIMIT ${boundedTake}`);
      return rows.map(mapRun);
    },

    async getRun(runId) {
      const rows = await db.$queryRaw<RunRow[]>(Prisma.sql`${RUN_SELECT} WHERE "id" = ${runId} LIMIT 1`);
      return rows[0] ? mapRun(rows[0]) : null;
    },

    async recoverInterruptedRuns(now) {
      return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; watchTargetId: string }>>(Prisma.sql`
          SELECT "id", "watchTargetId" FROM "MonitoringRun" WHERE "status" = 'RUNNING'
        `);
        if (rows.length === 0) return 0;
        await tx.$executeRaw(Prisma.sql`
          UPDATE "MonitoringRun" SET "status" = 'FAILED', "outcome" = 'RUN_FAILED', "finishedAt" = ${now},
            "errorCode" = 'APPLICATION_RESTARTED', "errorMessage" = '应用重启中断了本次检查。'
          WHERE "status" = 'RUNNING'
        `);
        await tx.$executeRaw(Prisma.sql`UPDATE "WatchTarget" SET "activeRunId" = NULL, "updatedAt" = ${now} WHERE "activeRunId" IS NOT NULL`);
        return rows.length;
      });
    },
  };
}
