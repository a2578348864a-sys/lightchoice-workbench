import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { checkedInMigrationNames, replayAllCheckedInMigrations } from "./migrationReplay";

export const MARKET_SCAN_MIGRATIONS = checkedInMigrationNames();

/** 用真实 migration SQL 建一个临时 SQLite，供持久化 / 集成测试使用。 */
export function createMigratedSqliteDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "market-scan-db-"));
  const databasePath = join(root, "test.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  replayAllCheckedInMigrations(database);
  database.close();
  return { root, databasePath };
}

export function cleanupMigratedSqliteDatabase(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** 测试内直接读表做副作用断言（Candidate / Task 计数、既有表结构）。 */
export function openSqlite(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export function fileDatabaseUrl(databasePath: string): string {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
