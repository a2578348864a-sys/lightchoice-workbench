/**
 * 人工研究范围确认的持久化访问层（raw SQL）。
 *
 * 为什么用 raw SQL：
 * 本机 Prisma CLI 无法执行（`prisma generate` / `migrate deploy` 均被环境终止），
 * 因此不能重新生成带新字段的 Prisma Client。这里用最小 raw 语句读写 P3 新增列，
 * 其余列仍由既有 Prisma Client 访问；表结构变更由正式 migration 文件承载。
 *
 * CAS 说明：`UPDATE ... WHERE id = ? AND scopeRevision = ?` 是**单条原子语句**，
 * 并发下只有一个请求能命中；未命中即冲突，绝不静默覆盖。
 */

import "server-only";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/server/db";

export const SCOPE_OWNER = "owner:v1";

export type SampleScopeRow = {
  readonly id: string;
  readonly marketSampleKey: string;
  readonly archivedAtMs: number | null;
  readonly scopeStatus: string | null;
  readonly scopeReason: string | null;
  readonly scopeSampleHash: string | null;
  readonly scopeNicheHash: string | null;
  readonly scopeConfirmedAtMs: number | null;
  readonly scopeConfirmedBy: string | null;
  readonly scopeRevision: number;
};

type RawRow = {
  id: string;
  marketSampleKey: string;
  archivedAt: number | bigint | null;
  scopeStatus: string | null;
  scopeReason: string | null;
  scopeSampleHash: string | null;
  scopeNicheHash: string | null;
  scopeConfirmedAt: number | bigint | null;
  scopeConfirmedBy: string | null;
  scopeRevision: number | bigint;
};

function toNumber(value: number | bigint | null): number | null {
  if (value === null) return null;
  return typeof value === "bigint" ? Number(value) : value;
}

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function listSampleScopeRows(scanId: string, db: DbClient = prisma): Promise<SampleScopeRow[]> {
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT "id", "marketSampleKey", "archivedAt", "scopeStatus", "scopeReason",
           "scopeSampleHash", "scopeNicheHash", "scopeConfirmedAt", "scopeConfirmedBy", "scopeRevision"
    FROM "V5MarketSampleLifecycle"
    WHERE "ownerScope" = ${SCOPE_OWNER} AND "scanId" = ${scanId}
  `);
  return rows.map((row) => ({
    id: row.id,
    marketSampleKey: row.marketSampleKey,
    archivedAtMs: toNumber(row.archivedAt),
    scopeStatus: row.scopeStatus,
    scopeReason: row.scopeReason,
    scopeSampleHash: row.scopeSampleHash,
    scopeNicheHash: row.scopeNicheHash,
    scopeConfirmedAtMs: toNumber(row.scopeConfirmedAt),
    scopeConfirmedBy: row.scopeConfirmedBy,
    scopeRevision: Number(row.scopeRevision),
  }));
}

/** 原子 CAS 更新；返回受影响行数（0 = 版本冲突）。 */
export async function casUpdateSampleScope(input: {
  readonly id: string;
  readonly expectedScopeRevision: number;
  readonly scopeStatus: "IN_SCOPE" | "OUT_OF_SCOPE" | "REVOKED";
  readonly scopeReason: string | null;
  readonly scopeSampleHash: string | null;
  readonly scopeNicheHash: string | null;
  readonly scopeConfirmedAtMs: number | null;
  readonly scopeConfirmedBy: string | null;
  readonly nowMs: number;
}, db: DbClient = prisma): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "V5MarketSampleLifecycle"
    SET "scopeStatus" = ${input.scopeStatus},
        "scopeReason" = ${input.scopeReason},
        "scopeSampleHash" = ${input.scopeSampleHash},
        "scopeNicheHash" = ${input.scopeNicheHash},
        "scopeConfirmedAt" = ${input.scopeConfirmedAtMs},
        "scopeConfirmedBy" = ${input.scopeConfirmedBy},
        "scopeRevision" = "scopeRevision" + 1,
        "updatedAt" = ${input.nowMs}
    WHERE "id" = ${input.id} AND "scopeRevision" = ${input.expectedScopeRevision}
  `);
}

/** 首次确认：插入 lifecycle 行（唯一约束保证并发首次只有一个成功）。 */
export async function insertSampleScope(input: {
  readonly scanId: string;
  readonly marketSampleKey: string;
  readonly scopeStatus: "IN_SCOPE" | "OUT_OF_SCOPE" | "REVOKED";
  readonly scopeReason: string | null;
  readonly scopeSampleHash: string | null;
  readonly scopeNicheHash: string | null;
  readonly scopeConfirmedAtMs: number | null;
  readonly scopeConfirmedBy: string | null;
  readonly nowMs: number;
}, db: DbClient = prisma): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "V5MarketSampleLifecycle"
      ("id", "ownerScope", "scanId", "marketSampleKey", "archivedAt", "createdAt", "updatedAt",
       "scopeStatus", "scopeReason", "scopeSampleHash", "scopeNicheHash", "scopeConfirmedAt", "scopeConfirmedBy", "scopeRevision")
    VALUES
      (${randomUUID()}, ${SCOPE_OWNER}, ${input.scanId}, ${input.marketSampleKey}, NULL, ${input.nowMs}, ${input.nowMs},
       ${input.scopeStatus}, ${input.scopeReason}, ${input.scopeSampleHash}, ${input.scopeNicheHash},
       ${input.scopeConfirmedAtMs}, ${input.scopeConfirmedBy}, 1)
  `);
}
