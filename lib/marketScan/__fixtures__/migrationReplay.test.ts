import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { replayAllCheckedInMigrations } from "./migrationReplay";

describe("canonical database uses every checked-in migration", () => {
  it("replays the complete directory and includes lifecycle, monitoring and event contracts", () => {
    const root = mkdtempSync(join(tmpdir(), "v5-migration-meta-"));
    const db = new DatabaseSync(join(root, "test.db"));
    try {
      const expected = readdirSync(resolve("prisma/migrations"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
      expect(replayAllCheckedInMigrations(db)).toEqual(expected);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(["ProductBatch", "V5OperationReceipt",
        "V5MarketSampleLifecycle", "WatchTarget", "MonitoringRun", "agent_events"]));
      const columns = db.prepare('PRAGMA table_info("ProductBatchItem")').all().map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["archivedAt", "updatedAt"]));
      db.prepare('INSERT INTO agent_events (id,module,event,level,message) VALUES (?,?,?,?,?)')
        .run("event-1", "fixture", "migration", "info", "migration contract");
      expect(db.prepare("SELECT metadataJson FROM agent_events WHERE id=?").get("event-1")?.metadataJson).toBe("{}");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
