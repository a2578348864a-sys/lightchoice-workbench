import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function checkedInMigrationNames(): string[] {
  return readdirSync(resolve("prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name).sort();
}

export function replayAllCheckedInMigrations(database: DatabaseSync): string[] {
  const names = checkedInMigrationNames();
  for (const name of names) {
    database.exec(readFileSync(resolve("prisma/migrations", name, "migration.sql"), "utf8"));
  }
  database.exec("PRAGMA foreign_keys = ON");
  return names;
}

let schemaSql: string | undefined;
/** Historical regression fixture only; never the canonical contract database. */
export function createDbPushShapedRegressionDatabase(path: string): void {
  schemaSql ??= execFileSync(process.execPath, [
    resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty",
    "--to-schema-datamodel", resolve("prisma/schema.prisma"), "--script",
  ], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", DATABASE_URL: "file:" + path.replaceAll("\\", "/") } });
  const database = new DatabaseSync(path);
  try {
    database.exec(schemaSql);
    database.exec("PRAGMA foreign_keys = ON");
  } finally {
    database.close();
  }
}
