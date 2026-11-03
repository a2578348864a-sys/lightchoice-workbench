import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * P5 批次的隔离工作区。
 *
 * 硬约束：批次会写库（V5 advisory 写 `V5OperationReceipt` 与 task resultJson），
 * 因此**只能**跑在正式数据库与 EvidenceStore 的副本上。本模块负责：
 *  1. 把正式库/证据复制到 scratch 根下；
 *  2. 提供「路径必须在 scratch 内」的断言（含 `..` 逃逸与跨盘判断）；
 *  3. 运行时断言：用 `PRAGMA database_list` 与 `resolveEvidenceStoreRoot()` 证明
 *     进程真正解析到的库文件与证据目录都在 scratch 内。
 */

export type P5IsolationPaths = {
  readonly scratchRoot: string;
  readonly databasePath: string;
  readonly evidenceStoreDir: string;
  readonly databaseUrl: string;
  readonly sourceDatabasePath: string;
  readonly sourceEvidenceStoreDir: string;
};

export class P5IsolationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "P5IsolationError";
  }
}

/** 目标路径必须在 root 内；越界（含 `..` 逃逸、跨盘）直接抛错。 */
export function assertPathInside(root: string, target: string, label: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new P5IsolationError(
      "P5_ISOLATION_ESCAPED",
      `${label} 不在 scratch 根内：${targetAbs}（root=${rootAbs}）。拒绝在正式数据上运行。`,
    );
  }
  return targetAbs;
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new P5IsolationError("P5_ISOLATION_SOURCE_MISSING", `${label} 不存在或不是目录：${path}`);
  }
}

function assertFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new P5IsolationError("P5_ISOLATION_SOURCE_MISSING", `${label} 不存在或不是文件：${path}`);
  }
}

/** 解析目标路径（不做复制），并断言都在 scratch 内。 */
export function resolveP5IsolationPaths(input: {
  readonly scratchRoot: string;
  readonly sourceDatabasePath: string;
  readonly sourceEvidenceStoreDir: string;
}): P5IsolationPaths {
  const scratchRoot = resolve(input.scratchRoot);
  const databasePath = assertPathInside(scratchRoot, join(scratchRoot, "database", "dev.db"), "隔离数据库路径");
  const evidenceStoreDir = assertPathInside(scratchRoot, join(scratchRoot, "evidence", "source-layer-store"), "隔离证据目录");
  return {
    scratchRoot,
    databasePath,
    evidenceStoreDir,
    databaseUrl: `file:${databasePath.replaceAll("\\", "/")}`,
    sourceDatabasePath: resolve(input.sourceDatabasePath),
    sourceEvidenceStoreDir: resolve(input.sourceEvidenceStoreDir),
  };
}

/**
 * 递归复制目录。
 *
 * 不用 `cpSync(..., {recursive:true})`：本机 Node 22 在 Windows 上复制含 >260 字符
 * 绝对路径的证据文件时会让进程**静默崩溃**（无异常、无输出）。逐文件复制实测稳定。
 */
function copyTree(source: string, target: string): number {
  let copied = 0;
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const stat = statSync(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copied += copyTree(from, to);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

function countFiles(root: string): number {
  let total = 0;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) total += countFiles(full);
    else total += 1;
  }
  return total;
}

/**
 * 复制正式库与证据到 scratch（每次重建，避免复用上次的写入残留）。
 * 删除动作只在已断言位于 scratch 内的目标上执行。
 */
export function prepareP5IsolatedWorkspace(input: {
  readonly scratchRoot: string;
  readonly sourceDatabasePath: string;
  readonly sourceEvidenceStoreDir: string;
}): P5IsolationPaths & { readonly copiedEvidenceFiles: number } {
  const paths = resolveP5IsolationPaths(input);
  assertFile(paths.sourceDatabasePath, "正式数据库");
  assertDirectory(paths.sourceEvidenceStoreDir, "正式 EvidenceStore");

  // 源与目标不得相同（否则等于直接写正式数据）。
  if (resolve(paths.sourceDatabasePath) === resolve(paths.databasePath)) {
    throw new P5IsolationError("P5_ISOLATION_SELF_REFERENCE", "隔离数据库路径与正式库相同，拒绝运行。");
  }

  mkdirSync(join(paths.scratchRoot, "database"), { recursive: true });
  mkdirSync(join(paths.scratchRoot, "evidence"), { recursive: true });

  rmSync(paths.databasePath, { force: true });
  copyFileSync(paths.sourceDatabasePath, paths.databasePath);

  rmSync(paths.evidenceStoreDir, { recursive: true, force: true });
  mkdirSync(paths.evidenceStoreDir, { recursive: true });
  const copiedEvidenceFiles = copyTree(paths.sourceEvidenceStoreDir, paths.evidenceStoreDir);

  const expected = countFiles(paths.sourceEvidenceStoreDir);
  if (copiedEvidenceFiles !== expected) {
    throw new P5IsolationError(
      "P5_ISOLATION_COPY_INCOMPLETE",
      `证据副本文件数 ${copiedEvidenceFiles} ≠ 源 ${expected}，隔离副本不完整，拒绝运行。`,
    );
  }

  assertPathInside(paths.scratchRoot, paths.databasePath, "复制后的数据库");
  assertPathInside(paths.scratchRoot, paths.evidenceStoreDir, "复制后的证据目录");
  return { ...paths, copiedEvidenceFiles };
}

export type P5RuntimeIsolationEvidence = {
  readonly databaseFile: string;
  readonly evidenceRoot: string;
  readonly scratchRoot: string;
};

/**
 * 运行时隔离证明：问进程自己「你实际用的是哪个库文件、哪个证据目录」，
 * 再断言二者都在 scratch 内。必须在 Prisma 客户端创建之后调用。
 */
export async function assertP5RuntimeIsolation(input: {
  readonly scratchRoot: string;
  readonly databasePath: string;
  readonly evidenceStoreDir: string;
}): Promise<P5RuntimeIsolationEvidence> {
  const [{ prisma }, { resolveEvidenceStoreRoot }] = await Promise.all([
    import("@/lib/server/db"),
    import("@/lib/sourceLayer/server/evidenceStore"),
  ]);

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("PRAGMA database_list");
  const main = rows.find((row) => String(row.name ?? "") === "main");
  const databaseFile = typeof main?.file === "string" ? main.file : "";
  if (!databaseFile) {
    throw new P5IsolationError("P5_ISOLATION_DB_UNKNOWN", "无法从 PRAGMA database_list 取得实际数据库文件路径。");
  }
  assertPathInside(input.scratchRoot, databaseFile, "运行时实际数据库");
  if (resolve(databaseFile) !== resolve(input.databasePath)) {
    throw new P5IsolationError(
      "P5_ISOLATION_DB_MISMATCH",
      `运行时数据库 ${databaseFile} 与预期副本 ${input.databasePath} 不一致。`,
    );
  }

  const evidenceRoot = resolveEvidenceStoreRoot();
  assertPathInside(input.scratchRoot, evidenceRoot, "运行时实际证据目录");
  if (resolve(evidenceRoot) !== resolve(input.evidenceStoreDir)) {
    throw new P5IsolationError(
      "P5_ISOLATION_EVIDENCE_MISMATCH",
      `运行时证据目录 ${evidenceRoot} 与预期副本 ${input.evidenceStoreDir} 不一致。`,
    );
  }

  return { databaseFile: resolve(databaseFile), evidenceRoot, scratchRoot: input.scratchRoot };
}
