#!/usr/bin/env node

/**
 * DB-Protection.2 — SQLite + EvidenceStore 备份 / 校验 / 恢复
 *
 * Usage:
 *   node scripts/ops/db/protect-sqlite-db.mjs summary
 *   node scripts/ops/db/protect-sqlite-db.mjs backup [--reason predeploy] [--evidence] [--full]
 *   node scripts/ops/db/protect-sqlite-db.mjs verify --backup <backupDir>
 *   node scripts/ops/db/protect-sqlite-db.mjs restore --backup <backupDir> --target <isolatedDir> [--force]
 *   node scripts/ops/db/protect-sqlite-db.mjs predeploy
 *   node scripts/ops/db/protect-sqlite-db.mjs postdeploy --baseline <path>
 *
 * 设计要点（P2-2）：
 * - 数据库不再裸拷贝：用 SQLite `VACUUM INTO` 生成一致快照（源库只读、无需停服），
 *   快照随后做 `PRAGMA integrity_check`、关键表计数、sha256 与可读性校验。
 * - EvidenceStore 走「镜像 + 清单」：只补新增/变化文件，清单记录相对路径、大小与 sha256，
 *   恢复时只按清单还原，形成可核对的恢复点（清单之后的文件不属于该恢复点）。
 * - 恢复只能写入隔离目录：拒绝正式库/正式证据根/仓库目录，拒绝非空目标（除非 --force），
 *   失败即非零退出，绝不覆盖正式数据。
 *
 * Does NOT: print DATABASE_URL, full resultJson, env values, or DB contents.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

// Load .env / .env.local silently for DATABASE_URL only (never printed).
// Uses cwd which is the project root when run via npm.
const cwd = resolve(process.cwd());
function loadDatabaseUrl() {
  for (const envName of [".env", ".env.local"]) {
    try {
      const envPath = join(cwd, envName);
      if (!existsSync(envPath)) continue;
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          if (key === "DATABASE_URL" && process.env.DATABASE_URL === undefined) {
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            process.env.DATABASE_URL = val;
            return;
          }
        }
      }
    } catch { /* continue to next */ }
  }
}
loadDatabaseUrl();

const BACKUP_ROOT = join(cwd, ".local-backups", "db-guard");
const EVIDENCE_MIRROR = join(BACKUP_ROOT, "evidence-store");
const MANIFEST_SCHEMA = "evidence-store-manifest.v1";
const RESTORE_POINT_SCHEMA = "db-guard-restore-point.v1";

// ── DB path resolution ────────────────────────────

function getRawDbUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Cannot locate SQLite database.");
  }
  return url;
}

function safeDbBasename() {
  const url = getRawDbUrl();
  if (url.startsWith("file:")) {
    const pathPart = url.slice(5);
    return basename(pathPart) || "unknown.db";
  }
  return basename(url) || "unknown.db";
}

function resolveDbPath() {
  const url = getRawDbUrl();
  if (!url.startsWith("file:")) {
    throw new Error("Only file: SQLite URLs are supported.");
  }
  const relative = url.slice(5);
  // Support Windows absolute paths like file:C:/...
  if (/^[A-Za-z]:[\\/]/.test(relative)) {
    return relative;
  }
  // Resolve relative path from cwd (project root when run via npm)
  let resolved = resolve(relative);
  // If not found, try prisma/ subdirectory (Prisma convention for relative URLs)
  if (!existsSync(resolved)) {
    const altResolved = resolve("prisma", basename(relative));
    if (existsSync(altResolved)) {
      resolved = altResolved;
    }
  }
  return resolved;
}

function safeDbPathLabel() {
  const p = resolveDbPath();
  const parts = p.split(/[\\/]/);
  // Only show last 2 segments
  return parts.slice(-2).join("/");
}

function evidenceSourceRoot() {
  const configured = process.env.SOURCE_LAYER_STORE_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : join(cwd, "data", "source-layer-store"));
}

function sqlQuotePath(path) {
  return `'${resolve(path).replaceAll("\\", "/").replaceAll("'", "''")}'`;
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function openClient(dbPath) {
  return new PrismaClient({
    datasources: { db: { url: `file:${resolve(dbPath).replaceAll("\\", "/")}` } },
  });
}

async function integrityCheck(client) {
  try {
    const rows = await client.$queryRawUnsafe("PRAGMA integrity_check");
    const value = rows?.[0]?.integrity_check ?? rows?.[0]?.integritycheck ?? null;
    return { ok: value === "ok", value: typeof value === "string" ? value.slice(0, 120) : "unknown" };
  } catch (error) {
    return { ok: false, value: `probe_failed:${error instanceof Error ? error.message.slice(0, 80) : "unknown"}` };
  }
}

/** 关键表计数：表不存在时记 null，不阻塞旧库。 */
async function keyCounts(client) {
  const specs = [
    ["workflowTasks", "SELECT count(*) AS c FROM ViralAnalysisRecord WHERE type = 'workflow'"],
    ["viralAnalysisRecords", "SELECT count(*) AS c FROM ViralAnalysisRecord"],
    ["marketScans", "SELECT count(*) AS c FROM MarketScan"],
    ["opportunityCandidates", "SELECT count(*) AS c FROM OpportunityCandidate"],
    ["operationReceipts", "SELECT count(*) AS c FROM V5OperationReceipt"],
  ];
  const out = {};
  for (const [key, sql] of specs) {
    try {
      const rows = await client.$queryRawUnsafe(sql);
      out[key] = Number(rows?.[0]?.c ?? 0);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

// ── quick_check ────────────────────────────────────

function quickCheck() {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return { ok: false, reason: "db_file_missing", details: "Database file does not exist." };
  }
  const size = statSync(dbPath).size;
  if (size === 0) {
    return { ok: false, reason: "db_file_empty", details: "Database file exists but is empty (0 bytes)." };
  }
  // Basic SQLite header check: "SQLite format 3\0"
  try {
    const header = readFileSync(dbPath, { encoding: "utf-8", flag: "r" }).slice(0, 16);
    if (!header.startsWith("SQLite format 3")) {
      return { ok: false, reason: "invalid_sqlite_header", details: "Database file does not start with valid SQLite header." };
    }
  } catch {
    return { ok: false, reason: "db_read_error", details: "Cannot read database file for header check." };
  }
  return { ok: true, size };
}

// ── Counts (legacy summary) ────────────────────────

async function countTasks() {
  const prisma = new PrismaClient();
  try {
    return await prisma.viralAnalysisRecord.count();
  } finally {
    await prisma.$disconnect();
  }
}

async function countListingSnapshots() {
  const prisma = new PrismaClient();
  try {
    const records = await prisma.viralAnalysisRecord.findMany({
      select: { id: true, resultJson: true },
    });
    let total = 0;
    let realAi = 0;
    for (const r of records) {
      try {
        const parsed = JSON.parse(r.resultJson);
        const snap = parsed?.aiListingPackSnapshot;
        if (snap?.snapshotType === "ai_listing_pack") {
          total += 1;
          if (snap.source === "real_ai_draft") realAi += 1;
        }
      } catch { /* skip malformed JSON */ }
    }
    return { total, realAi };
  } finally {
    await prisma.$disconnect();
  }
}

// ── EvidenceStore mirror ───────────────────────────

function walkFiles(root, current = root, out = []) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    // 跳过符号链接/重解析点：备份不跟随链接，避免越出证据根
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkFiles(root, full, out);
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * 证据镜像同步：只复制缺失或大小不同的文件（证据按 hash 命名、天然只增不改），
 * 然后对**源目录全部文件**与镜像逐项做 sha256 核对，生成一一对应的清单。
 */
async function syncEvidenceStore({ sourceRoot, mirrorRoot, full = false }) {
  if (!existsSync(sourceRoot)) {
    throw new Error("EvidenceStore root does not exist; refusing to write a partial manifest.");
  }
  if (full && existsSync(mirrorRoot)) {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
  mkdirSync(mirrorRoot, { recursive: true });

  const files = walkFiles(sourceRoot);
  let copied = 0;
  let reused = 0;
  for (const file of files) {
    const rel = relative(sourceRoot, file);
    const target = join(mirrorRoot, rel);
    const sourceSize = statSync(file).size;
    const targetExists = existsSync(target);
    if (!targetExists || statSync(target).size !== sourceSize) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      copied += 1;
    } else {
      reused += 1;
    }
  }

  const manifestFiles = [];
  let totalBytes = 0;
  let verified = 0;
  for (const file of files) {
    const rel = relative(sourceRoot, file);
    const target = join(mirrorRoot, rel);
    if (!existsSync(target)) {
      throw new Error(`Evidence mirror is missing a file after sync: ${rel}`);
    }
    const [sourceHash, mirrorHash] = await Promise.all([sha256File(file), sha256File(target)]);
    if (sourceHash !== mirrorHash) {
      throw new Error(`Evidence mirror hash mismatch: ${rel}`);
    }
    const size = statSync(target).size;
    totalBytes += size;
    verified += 1;
    manifestFiles.push({ path: rel.split(sep).join("/"), size, sha256: sourceHash });
  }

  // 镜像里不属于源清单的旧文件不参与恢复，但统计出来提示是否需要人工清理
  const mirrorFiles = walkFiles(mirrorRoot);
  const known = new Set(manifestFiles.map((entry) => entry.path));
  const orphans = mirrorFiles
    .map((file) => relative(mirrorRoot, file).split(sep).join("/"))
    .filter((rel) => !known.has(rel));

  manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    capturedAt: new Date().toISOString(),
    sourceLabel: basename(sourceRoot),
    fileCount: manifestFiles.length,
    totalBytes,
    copied,
    reused,
    verified,
    orphanCount: orphans.length,
    files: manifestFiles,
  };
  return { manifest, orphans: orphans.slice(0, 20) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

// ── Backup ─────────────────────────────────────────

function stampNow() {
  // 毫秒级时间戳：同一秒内连续备份（如测试里 backup 后紧跟 predeploy）也必须拿到不同目录，
  // 否则 VACUUM INTO 会因目标文件已存在而失败（SQLite: output file already exists）。
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

/** 极端并发下同一毫秒仍可能撞名：递增后缀直到目录不存在。 */
function uniqueBackupDir() {
  const base = join(BACKUP_ROOT, stampNow());
  if (!existsSync(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Cannot allocate a unique backup directory.");
}

async function backupDb(reason = "manual", { withEvidence = false, fullEvidence = false } = {}) {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) throw new Error("Database file not found, cannot backup.");
  if (!quickCheck().ok) throw new Error("Database file failed pre-backup quick check.");

  const backupDir = uniqueBackupDir();
  const dbDir = join(backupDir, "database");
  mkdirSync(dbDir, { recursive: true });

  const dbName = safeDbBasename();
  const dest = join(dbDir, dbName);

  // 一致性快照：VACUUM INTO 不修改源库，也不需要停服
  const source = new PrismaClient();
  try {
    await source.$executeRawUnsafe(`VACUUM INTO ${sqlQuotePath(dest)}`);
  } finally {
    await source.$disconnect();
  }

  const size = existsSync(dest) ? statSync(dest).size : 0;
  if (size === 0) throw new Error("Backup database is empty after VACUUM INTO.");

  const snapshot = await openClient(dest);
  let integrity;
  let counts;
  try {
    integrity = await integrityCheck(snapshot);
    counts = await keyCounts(snapshot);
  } finally {
    await snapshot.$disconnect();
  }
  if (!integrity.ok) throw new Error(`Backup failed integrity_check: ${integrity.value}`);

  const sha256 = await sha256File(dest);
  const meta = {
    schemaVersion: "db-snapshot-meta.v2",
    timestamp: new Date().toISOString(),
    reason,
    method: "vacuum_into",
    dbBasename: dbName,
    backupPath: dest,
    sizeBytes: size,
    sha256,
    integrity: integrity.value,
    counts,
  };
  writeJson(join(dbDir, "backup-meta.json"), meta);

  let evidence = null;
  if (withEvidence) {
    const sourceRoot = evidenceSourceRoot();
    const synced = await syncEvidenceStore({ sourceRoot, mirrorRoot: EVIDENCE_MIRROR, full: fullEvidence });
    evidence = {
      manifestPath: join(EVIDENCE_MIRROR, "manifest.json"),
      manifestSha256: sha256Text(JSON.stringify(synced.manifest)),
      capturedAt: synced.manifest.capturedAt,
      fileCount: synced.manifest.fileCount,
      totalBytes: synced.manifest.totalBytes,
      copied: synced.manifest.copied,
      reused: synced.manifest.reused,
      orphanCount: synced.manifest.orphanCount,
    };
    writeJson(evidence.manifestPath, synced.manifest);
  }

  const restorePoint = {
    schemaVersion: RESTORE_POINT_SCHEMA,
    createdAt: new Date().toISOString(),
    reason,
    database: { file: join("database", dbName), sha256, sizeBytes: size, integrity: integrity.value, counts },
    evidence,
    consistencyNote: evidence
      ? "数据库快照与证据清单在同一备份动作内生成；恢复点只包含该清单列出的证据文件。"
      : "本次仅备份数据库，未包含证据清单。",
  };
  writeJson(join(backupDir, "restore-point.json"), restorePoint);

  return { backupDir, dest, size, sha256, meta, evidence, restorePoint };
}

// ── Verify ─────────────────────────────────────────

async function verifyBackup(backupDir) {
  const dir = resolve(backupDir);
  const metaPath = join(dir, "database", "backup-meta.json");
  if (!existsSync(metaPath)) throw new Error(`backup-meta.json not found under ${dir}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const dbFile = join(dir, "database", meta.dbBasename);
  if (!existsSync(dbFile)) throw new Error("Backup database file is missing.");

  const issues = [];
  const actualSha = await sha256File(dbFile);
  if (actualSha !== meta.sha256) issues.push("DB sha256 does not match backup-meta.json.");
  if (statSync(dbFile).size !== meta.sizeBytes) issues.push("DB size does not match backup-meta.json.");

  const client = await openClient(dbFile);
  let integrity;
  let counts;
  try {
    integrity = await integrityCheck(client);
    counts = await keyCounts(client);
  } finally {
    await client.$disconnect();
  }
  if (!integrity.ok) issues.push(`integrity_check failed: ${integrity.value}`);
  for (const [key, value] of Object.entries(counts)) {
    if (meta.counts?.[key] !== undefined && meta.counts[key] !== value) {
      issues.push(`count mismatch for ${key}: meta=${meta.counts[key]} actual=${value}`);
    }
  }

  const pointPath = join(dir, "restore-point.json");
  let evidence = null;
  if (existsSync(pointPath)) {
    const point = JSON.parse(readFileSync(pointPath, "utf-8"));
    if (point.evidence?.manifestPath && existsSync(point.evidence.manifestPath)) {
      const manifest = JSON.parse(readFileSync(point.evidence.manifestPath, "utf-8"));
      let checked = 0;
      for (const entry of manifest.files ?? []) {
        const target = join(EVIDENCE_MIRROR, entry.path);
        if (!existsSync(target)) {
          issues.push(`evidence file missing in mirror: ${entry.path}`);
          continue;
        }
        const hash = await sha256File(target);
        if (hash !== entry.sha256) issues.push(`evidence hash mismatch: ${entry.path}`);
        checked += 1;
      }
      if (checked !== manifest.fileCount) issues.push(`evidence file count mismatch: manifest=${manifest.fileCount} checked=${checked}`);
      evidence = { fileCount: manifest.fileCount, checked, orphanCount: manifest.orphanCount ?? 0 };
    } else if (point.evidence) {
      issues.push("restore-point references a missing evidence manifest.");
    }
  }

  return { ok: issues.length === 0, backupDir: dir, sha256: actualSha, integrity: integrity.value, counts, evidence, issues };
}

// ── Restore ────────────────────────────────────────

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 仓库根：由脚本位置推导（scripts/ops/db → 仓库根），与当前 cwd 无关。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 识别「正式数据根」形状：同目录同时存在 dev.db 与 demo-access.json，
 * 或路径位于 source-layer-store 之内。用于在 operator 指错 --allow-root 时兜底，
 * 不依赖当前 DATABASE_URL 指向哪里（换数据源后仍能挡住写入正式目录）。
 */
function assertNotInsideLiveDataRoot(path, label) {
  let cur = resolve(path);
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(cur) === "source-layer-store") {
      throw new Error(`${label} is inside an evidence store; choose an isolated directory.`);
    }
    if (existsSync(join(cur, "dev.db")) && existsSync(join(cur, "demo-access.json"))) {
      throw new Error(`${label} is inside a live data root; choose an isolated directory.`);
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

/**
 * 恢复目标护栏（deny-by-default）：
 * - 必须显式提供 `--allow-root`（操作者声明的隔离沙箱根），目标必须落在其内；
 * - 沙箱根本身不得与仓库、当前数据库目录、证据源根重叠；
 * - 目标不得落在上述任一目录内，且必须不存在或为空。
 *
 * 之前只用 cwd/当前 DATABASE_URL 判断，换一个 DATA_URL 指向副本后，
 * 就能把恢复写进别的正式数据根 —— 这是必须避免的。
 */
function assertRestoreTarget(target, allowRoot, { allowNonEmpty = false } = {}) {
  const resolved = resolve(target);
  if (!isAbsolute(resolved)) throw new Error("Restore target must be an absolute path.");
  if (!allowRoot) throw new Error("restore requires --allow-root <isolatedSandboxRoot>.");
  const allowed = resolve(allowRoot);
  if (!isAbsolute(allowed)) throw new Error("--allow-root must be an absolute path.");
  if (!existsSync(allowed)) throw new Error("--allow-root must exist; create the isolated sandbox first.");
  if (resolved === resolve(resolved, sep)) throw new Error("Restore target must not be a drive root.");

  const liveRoots = [REPO_ROOT, evidenceSourceRoot()];
  try {
    liveRoots.push(dirname(resolveDbPath()));
  } catch { /* DATABASE_URL 未设置时跳过 */ }

  for (const root of liveRoots) {
    if (isInside(root, allowed)) {
      throw new Error("--allow-root overlaps the repository or a live data root; choose an isolated directory.");
    }
  }
  assertNotInsideLiveDataRoot(allowed, "--allow-root");
  assertNotInsideLiveDataRoot(resolved, "Restore target");
  if (!isInside(allowed, resolved) || resolve(allowed) === resolved) {
    throw new Error("Restore target must be a child directory of --allow-root.");
  }
  for (const root of liveRoots) {
    if (isInside(root, resolved)) {
      throw new Error("Restore target overlaps a live data root or the repository; choose an isolated directory.");
    }
  }
  if (existsSync(resolved) && !allowNonEmpty) {
    const entries = readdirSync(resolved);
    if (entries.length > 0) throw new Error("Restore target must be empty or non-existent.");
  }
}

async function restoreBackup({ backupDir, target, allowRoot, force = false }) {
  const backup = await verifyBackup(backupDir);
  if (!backup.ok) {
    throw new Error(`Backup verification failed, restore aborted: ${backup.issues.slice(0, 3).join("; ")}`);
  }
  const resolvedTarget = resolve(target);
  if (!existsSync(resolvedTarget)) {
    // 先做静态护栏，再创建目录：避免先写后校验
    assertRestoreTarget(resolvedTarget, allowRoot);
    mkdirSync(resolvedTarget, { recursive: true });
  } else if (force) {
    // --force 只允许清理本工具生成过的目标，避免误删用户目录
    const entries = readdirSync(resolvedTarget);
    if (entries.length > 0 && !existsSync(join(resolvedTarget, "restore-report.json"))) {
      throw new Error("Refusing --force on a non-empty directory that was not produced by this tool.");
    }
    assertRestoreTarget(resolvedTarget, allowRoot, { allowNonEmpty: true });
    rmSync(resolvedTarget, { recursive: true, force: true });
    mkdirSync(resolvedTarget, { recursive: true });
  } else {
    assertRestoreTarget(resolvedTarget, allowRoot);
  }

  const meta = JSON.parse(readFileSync(join(backupDir, "database", "backup-meta.json"), "utf-8"));
  const dbTargetDir = join(resolvedTarget, "database");
  const evTargetRoot = join(resolvedTarget, "evidence", "source-layer-store");
  mkdirSync(dbTargetDir, { recursive: true });

  const dbTarget = join(dbTargetDir, meta.dbBasename);
  copyFileSync(join(backupDir, "database", meta.dbBasename), dbTarget);

  const restoredSha = await sha256File(dbTarget);
  if (restoredSha !== meta.sha256) throw new Error("Restored database sha256 mismatch.");

  const client = await openClient(dbTarget);
  let integrity;
  let counts;
  try {
    integrity = await integrityCheck(client);
    counts = await keyCounts(client);
  } finally {
    await client.$disconnect();
  }
  if (!integrity.ok) throw new Error(`Restored database failed integrity_check: ${integrity.value}`);
  for (const [key, value] of Object.entries(meta.counts ?? {})) {
    if (value !== null && counts[key] !== value) throw new Error(`Restored count mismatch for ${key}.`);
  }

  const point = JSON.parse(readFileSync(join(backupDir, "restore-point.json"), "utf-8"));
  let evidenceReport = null;
  if (point.evidence?.manifestPath) {
    const manifest = JSON.parse(readFileSync(point.evidence.manifestPath, "utf-8"));
    mkdirSync(evTargetRoot, { recursive: true });
    for (const entry of manifest.files ?? []) {
      const source = join(EVIDENCE_MIRROR, entry.path);
      const dest = join(evTargetRoot, entry.path);
      if (!existsSync(source)) throw new Error(`Evidence file missing in mirror: ${entry.path}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      const hash = await sha256File(dest);
      if (hash !== entry.sha256) throw new Error(`Restored evidence hash mismatch: ${entry.path}`);
    }
    evidenceReport = {
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      capturedAt: manifest.capturedAt,
      root: "evidence/source-layer-store",
      verified: true,
    };
  }

  const report = {
    schemaVersion: "restore-report.v1",
    restoredAt: new Date().toISOString(),
    backupDir: resolve(backupDir),
    target: resolvedTarget,
    database: {
      file: join("database", meta.dbBasename),
      sha256: restoredSha,
      sizeBytes: statSync(dbTarget).size,
      integrity: integrity.value,
      counts,
    },
    evidence: evidenceReport,
    mode: "isolated-restore",
  };
  writeJson(join(resolvedTarget, "restore-report.json"), report);
  return report;
}

// ── Baseline ───────────────────────────────────────

function baselinePath() {
  return join(BACKUP_ROOT, "baseline.json");
}

async function writeBaseline() {
  const qc = quickCheck();
  const taskCount = await countTasks();
  const snapCounts = await countListingSnapshots();
  const dbPath = resolveDbPath();
  const size = existsSync(dbPath) ? statSync(dbPath).size : 0;

  const baseline = {
    timestamp: new Date().toISOString(),
    dbBasename: safeDbBasename(),
    dbSizeBytes: size,
    quickCheck: qc,
    taskCount,
    listingSnapshotCount: snapCounts.total,
    realAiListingCount: snapCounts.realAi,
  };

  const bp = baselinePath();
  mkdirSync(dirname(bp), { recursive: true });
  writeFileSync(bp, JSON.stringify(baseline, null, 2), "utf-8");
  return { baseline, baselinePath: bp };
}

async function compareBaseline(baselineFile) {
  if (!existsSync(baselineFile)) {
    return { ok: false, reason: "baseline_missing", details: `Baseline file not found: ${baselineFile}` };
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselineFile, "utf-8"));
  } catch {
    return { ok: false, reason: "baseline_invalid", details: "Baseline file is not valid JSON." };
  }

  const qc = quickCheck();
  if (!qc.ok) {
    return { ok: false, reason: `quick_check_failed: ${qc.reason}`, details: qc.details };
  }

  const taskCount = await countTasks();
  const snapCounts = await countListingSnapshots();
  const dbPath = resolveDbPath();
  const currentSize = existsSync(dbPath) ? statSync(dbPath).size : 0;

  const issues = [];

  if (taskCount < baseline.taskCount) {
    issues.push(`Task count decreased from ${baseline.taskCount} to ${taskCount}.`);
  }
  if (snapCounts.total < baseline.listingSnapshotCount) {
    issues.push(`Listing snapshot count decreased from ${baseline.listingSnapshotCount} to ${snapCounts.total}.`);
  }
  if (snapCounts.realAi < baseline.realAiListingCount) {
    issues.push(`Real AI draft listing count decreased from ${baseline.realAiListingCount} to ${snapCounts.realAi}.`);
  }
  if (currentSize === 0) {
    issues.push("Current DB file size is 0.");
  }

  const result = {
    ok: issues.length === 0,
    baseline: {
      taskCount: baseline.taskCount,
      listingSnapshotCount: baseline.listingSnapshotCount,
      realAiListingCount: baseline.realAiListingCount,
      dbSizeBytes: baseline.dbSizeBytes,
    },
    current: {
      quickCheck: qc,
      taskCount,
      listingSnapshotCount: snapCounts.total,
      realAiListingCount: snapCounts.realAi,
      dbSizeBytes: currentSize,
    },
    issues,
  };

  return result;
}

// ── Safe summary output ────────────────────────────

function safeSummary(qc, taskCount, snapCounts) {
  console.log("═══════════════════════════════════");
  console.log("  DB Protection Summary");
  console.log("═══════════════════════════════════");
  console.log(`  DB basename     : ${safeDbBasename()}`);
  console.log(`  DB path (safe)  : ${safeDbPathLabel()}`);
  console.log(`  Quick check     : ${qc.ok ? "OK" : "FAIL — " + qc.reason}`);
  if (qc.ok) {
    console.log(`  DB size         : ${(qc.size / 1024).toFixed(1)} KB`);
  }
  console.log(`  Task count      : ${taskCount}`);
  console.log(`  Listing snapshots: ${snapCounts.total} (real AI draft: ${snapCounts.realAi})`);
  console.log("═══════════════════════════════════");
}

// ── CLI ────────────────────────────────────────────

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error("Usage: node protect-sqlite-db.mjs <summary|backup|verify|restore|predeploy|postdeploy> [options]");
    console.error("  backup  --reason <r> [--evidence] [--full]");
    console.error("  verify  --backup <backupDir>");
    console.error("  restore --backup <backupDir> --target <isolatedDir> --allow-root <isolatedSandboxRoot> [--force]");
    process.exit(1);
  }

  if (command === "summary") {
    const qc = quickCheck();
    const taskCount = await countTasks();
    const snapCounts = await countListingSnapshots();
    safeSummary(qc, taskCount, snapCounts);
    if (!qc.ok) process.exit(1);
  } else if (command === "backup") {
    const reason = argValue(args, "--reason") ?? "manual";
    const withEvidence = args.includes("--evidence");
    const fullEvidence = args.includes("--full");
    const result = await backupDb(reason, { withEvidence, fullEvidence });
    console.log(`Backup created (VACUUM INTO snapshot): ${result.backupDir}`);
    console.log(`  Reason          : ${result.meta.reason}`);
    console.log("  Method          : VACUUM INTO (consistent, no downtime)");
    console.log(`  Size            : ${(result.size / 1024).toFixed(1)} KB`);
    console.log(`  sha256          : ${result.sha256.slice(0, 16)}…`);
    console.log(`  integrity_check : ${result.meta.integrity}`);
    console.log(`  counts          : ${JSON.stringify(result.meta.counts)}`);
    if (result.evidence) {
      console.log(`  evidence mirror : ${result.evidence.fileCount} files / ${(result.evidence.totalBytes / 1024 / 1024).toFixed(1)} MB (copied ${result.evidence.copied}, reused ${result.evidence.reused}, orphans ${result.evidence.orphanCount})`);
    } else {
      console.log("  evidence mirror : skipped (add --evidence to include EvidenceStore)");
    }
    console.log(`  restore point   : ${join(result.backupDir, "restore-point.json")}`);
  } else if (command === "verify") {
    const backupDir = argValue(args, "--backup");
    if (!backupDir) throw new Error("verify requires --backup <backupDir>");
    const result = await verifyBackup(backupDir);
    if (!result.ok) {
      console.error("VERIFY FAILED");
      for (const issue of result.issues) console.error(`  ✗ ${issue}`);
      process.exit(1);
    }
    console.log(`Verify OK: ${result.backupDir}`);
    console.log(`  integrity_check : ${result.integrity}`);
    console.log(`  counts          : ${JSON.stringify(result.counts)}`);
    if (result.evidence) console.log(`  evidence        : ${result.evidence.checked}/${result.evidence.fileCount} files hashed`);
  } else if (command === "restore") {
    const backupDir = argValue(args, "--backup");
    const target = argValue(args, "--target");
    const allowRoot = argValue(args, "--allow-root");
    if (!backupDir || !target || !allowRoot) {
      throw new Error("restore requires --backup <backupDir>, --target <isolatedDir> and --allow-root <isolatedSandboxRoot>");
    }
    const report = await restoreBackup({ backupDir, target, allowRoot, force: args.includes("--force") });
    console.log(`Restore OK -> ${report.target}`);
    console.log(`  database        : ${report.database.file} (${report.database.integrity})`);
    console.log(`  counts          : ${JSON.stringify(report.database.counts)}`);
    if (report.evidence) console.log(`  evidence        : ${report.evidence.fileCount} files verified`);
    console.log(`  report          : ${join(report.target, "restore-report.json")}`);
  } else if (command === "predeploy") {
    console.log("Pre-deploy guard running...");
    const result = await backupDb("predeploy", { withEvidence: false });
    console.log(`Backup saved: ${result.backupDir}`);
    const { baseline } = await writeBaseline();
    console.log(`Baseline written: ${baselinePath()}`);
    const qc = baseline.quickCheck;
    safeSummary(qc, baseline.taskCount, { total: baseline.listingSnapshotCount, realAi: baseline.realAiListingCount });
    if (!qc.ok) {
      console.error("ERROR: Quick check failed. Abort deployment.");
      process.exit(1);
    }
  } else if (command === "postdeploy") {
    const baselineFile = argValue(args, "--baseline") ?? baselinePath();
    console.log(`Post-deploy guard running against baseline: ${baselineFile}`);
    const result = await compareBaseline(baselineFile);
    if (!result.ok) {
      console.error("═══════════════════════════════════");
      console.error("  DEPLOY GUARD FAILED");
      console.error("═══════════════════════════════════");
      const issues = result.issues ?? [result.reason ?? "Unknown failure"];
      for (const issue of issues) {
        console.error(`  ✗ ${issue}`);
      }
      if (result.baseline) {
        console.error("───────────────────────────────────");
        console.error("  Baseline:");
        console.error(`    Task count: ${result.baseline.taskCount}`);
        console.error(`    Listing snapshots: ${result.baseline.listingSnapshotCount}`);
        console.error(`    Real AI draft: ${result.baseline.realAiListingCount}`);
      }
      if (result.current) {
        console.error("  Current:");
        console.error(`    Task count: ${result.current.taskCount}`);
        console.error(`    Listing snapshots: ${result.current.listingSnapshotCount}`);
        console.error(`    Real AI draft: ${result.current.realAiListingCount}`);
      }
      console.error("═══════════════════════════════════");
      process.exit(1);
    }
    console.log("Post-deploy guard passed. Task counts and listing snapshots are intact.");
    const qc = result.current.quickCheck;
    safeSummary(qc, result.current.taskCount, { total: result.current.listingSnapshotCount, realAi: result.current.realAiListingCount });
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Valid commands: summary, backup, verify, restore, predeploy, postdeploy");
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 0)); // let Prisma disconnect cleanly
}

main().catch((err) => {
  console.error("DB Guard error:", err.message);
  process.exit(1);
});
