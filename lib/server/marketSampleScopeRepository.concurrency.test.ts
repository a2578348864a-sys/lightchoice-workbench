/**
 * 人工范围确认的数据库级并发测试（真实 SQLite，非 Mock）。
 *
 * 用隔离库副本验证：
 * 1. 两个请求持相同 scopeRevision 并发写入 → 只有一个成功（原子 CAS）；
 * 2. 并发首次确认 → 唯一约束保证只有一个插入成功；
 * 3. 撤销后 revision 递增，旧 revision 不能再写。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";

const SCAN_ID = "cmvclxeeq0000biaimg6jobrq";
const SAMPLE_KEY = `${SCAN_ID}:B07PR9NM54`;

let tempDir = "";
let dbPath = "";
type Repo = typeof import("@/lib/server/marketSampleScopeRepository");
let repo: Repo;
let prismaClient: { $queryRawUnsafe: (sql: string) => Promise<unknown>; $disconnect: () => Promise<void> };

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "scope-cas-"));
  dbPath = join(tempDir, "dev.db");
  // 用仓库内已登记的迁移初始化临时库：不依赖任何本机路径或正式数据副本。
  const database = new DatabaseSync(dbPath);
  try {
    replayAllCheckedInMigrations(database);
  } finally {
    database.close();
  }
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
  repo = await import("@/lib/server/marketSampleScopeRepository");
  const db = await import("@/lib/server/db");
  prismaClient = db.prisma as unknown as typeof prismaClient;
  // 临时副本中清除该 scan 的历史人工确认，保证用例从干净状态开始
  await prismaClient.$queryRawUnsafe(`DELETE FROM "V5MarketSampleLifecycle" WHERE "scanId" = '${SCAN_ID}'`);
});

afterAll(async () => {
  await prismaClient?.$disconnect();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function casInput(revision: number, status: "IN_SCOPE" | "OUT_OF_SCOPE" | "REVOKED") {
  return {
    id: "",
    expectedScopeRevision: revision,
    scopeStatus: status,
    scopeReason: status === "REVOKED" ? null : "并发测试",
    scopeSampleHash: status === "REVOKED" ? null : "hash-1",
    scopeNicheHash: status === "REVOKED" ? null : "niche-1",
    scopeConfirmedAtMs: status === "REVOKED" ? null : Date.now(),
    scopeConfirmedBy: status === "REVOKED" ? null : "owner:v1",
    nowMs: Date.now(),
  };
}

describe("sample scope CAS (real sqlite)", () => {
  it("并发首次确认：只有一个插入成功", async () => {
    await repo.insertSampleScope({
      scanId: SCAN_ID,
      marketSampleKey: SAMPLE_KEY,
      scopeStatus: "IN_SCOPE",
      scopeReason: "首次",
      scopeSampleHash: "hash-1",
      scopeNicheHash: "niche-1",
      scopeConfirmedAtMs: Date.now(),
      scopeConfirmedBy: "owner:v1",
      nowMs: Date.now(),
    });

    const rows = await repo.listSampleScopeRows(SCAN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeRevision).toBe(1);
    expect(rows[0].scopeStatus).toBe("IN_SCOPE");

    // 同一 key 再次插入（模拟并发首个请求）→ 唯一约束拒绝
    await expect(repo.insertSampleScope({
      scanId: SCAN_ID,
      marketSampleKey: SAMPLE_KEY,
      scopeStatus: "OUT_OF_SCOPE",
      scopeReason: "并发第二个",
      scopeSampleHash: "hash-1",
      scopeNicheHash: "niche-1",
      scopeConfirmedAtMs: Date.now(),
      scopeConfirmedBy: "owner:v1",
      nowMs: Date.now(),
    })).rejects.toBeTruthy();
  });

  it("相同 revision 的两个并发更新：只有一个生效", async () => {
    const [first] = await repo.listSampleScopeRows(SCAN_ID);
    const results = await Promise.all([
      repo.casUpdateSampleScope({ ...casInput(1, "OUT_OF_SCOPE"), id: first.id }),
      repo.casUpdateSampleScope({ ...casInput(1, "IN_SCOPE"), id: first.id }),
    ]);
    expect(results.sort()).toEqual([0, 1]);

    const [after] = await repo.listSampleScopeRows(SCAN_ID);
    expect(after.scopeRevision).toBe(2);
    expect(["IN_SCOPE", "OUT_OF_SCOPE"]).toContain(after.scopeStatus);
  });

  it("撤销使 revision 递增，旧 revision 写入被拒绝", async () => {
    const [row] = await repo.listSampleScopeRows(SCAN_ID);
    const revoked = await repo.casUpdateSampleScope({ ...casInput(row.scopeRevision, "REVOKED"), id: row.id });
    expect(revoked).toBe(1);

    const [afterRevoke] = await repo.listSampleScopeRows(SCAN_ID);
    expect(afterRevoke.scopeStatus).toBe("REVOKED");
    expect(afterRevoke.scopeRevision).toBe(row.scopeRevision + 1);

    const staleWrite = await repo.casUpdateSampleScope({ ...casInput(row.scopeRevision, "IN_SCOPE"), id: row.id });
    expect(staleWrite).toBe(0);
  });
});
