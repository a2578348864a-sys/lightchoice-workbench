import { normalize, resolve } from "node:path";

/**
 * Real-data WRITE test fail-closed guard.
 *
 * 默认 `npm test` 绝不写生产状态：
 * - 未显式 opt-in（V5_REAL_DATA_WRITE_TEST=1）→ 不执行写验收；
 * - 显式 opt-in 后必须同时给出 DATABASE_URL 与 SOURCE_LAYER_STORE_DIR，
 *   且解析后的路径不得等于正式 prisma/dev.db / data/source-layer-store；
 * - 任何不满足 → throw REFUSE_PRODUCTION_WRITE_TEST（硬失败，绝不 skip/警告放行）。
 *
 * 正式路径定义（规范口径）：
 *   resolve(process.cwd(), "prisma/dev.db")
 *   resolve(process.cwd(), "data/source-layer-store")
 * 比较前 normalize；Windows 大小写不敏感。
 */

export type RealDataWriteGuardVerdict = {
  /** 是否允许执行写验收 */
  readonly execute: boolean;
  /** 拒绝原因（非 opt-in 时为 null：默认跳过不算拒绝） */
  readonly refusal: string | null;
};

/** 归一化为可比较的绝对路径（去 file: 前缀、normalize、Windows 大小写兼容）。 */
export function canonicalizePath(input: string, cwd: string = process.cwd()): string {
  let raw = String(input ?? "").trim();
  if (/^file:/i.test(raw)) raw = raw.replace(/^file:/i, "");
  // file:///C:/x 或 ///C:/x → C:/x
  if (/^\/{2,}[A-Za-z]:/.test(raw)) raw = raw.replace(/^\/+/, "");
  raw = raw.replace(/\//g, "\\");
  const isAbs = /^[A-Za-z]:\\/.test(raw) || raw.startsWith("\\\\");
  const abs = isAbs ? raw : resolve(cwd, raw);
  const normalized = normalize(resolve(abs));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function formalDatabasePath(cwd: string = process.cwd()): string {
  return canonicalizePath(resolve(cwd, "prisma", "dev.db"), cwd);
}

export function formalEvidenceStorePath(cwd: string = process.cwd()): string {
  return canonicalizePath(resolve(cwd, "data", "source-layer-store"), cwd);
}

export function evaluateRealDataWriteGuard(input: {
  readonly optInEnv?: string | null;
  readonly databaseUrl?: string | null;
  readonly evidenceStoreDir?: string | null;
  readonly cwd?: string;
}): RealDataWriteGuardVerdict {
  const cwd = input.cwd ?? process.cwd();
  const optedIn = input.optInEnv === "1";
  if (!optedIn) {
    return { execute: false, refusal: null };
  }

  const db = input.databaseUrl ?? null;
  const ev = input.evidenceStoreDir ?? null;
  if (!db || !ev) {
    const missing = [!db ? "DATABASE_URL" : null, !ev ? "SOURCE_LAYER_STORE_DIR" : null].filter(Boolean).join("+");
    return { execute: false, refusal: `MISSING_EXPLICIT_ENV(${missing})` };
  }

  const dbCanon = canonicalizePath(db, cwd);
  if (dbCanon === formalDatabasePath(cwd)) {
    return { execute: false, refusal: `FORMAL_DATABASE_PATH(${dbCanon})` };
  }
  const evCanon = canonicalizePath(ev, cwd);
  if (evCanon === formalEvidenceStorePath(cwd)) {
    return { execute: false, refusal: `FORMAL_EVIDENCE_STORE_PATH(${evCanon})` };
  }
  return { execute: true, refusal: null };
}

/** fail-closed 断言：opt-in 且不满足派生路径条件 → 硬抛 REFUSE_PRODUCTION_WRITE_TEST。 */
export function assertRealDataWriteGuard(input: {
  readonly optInEnv?: string | null;
  readonly databaseUrl?: string | null;
  readonly evidenceStoreDir?: string | null;
  readonly cwd?: string;
}): RealDataWriteGuardVerdict {
  const verdict = evaluateRealDataWriteGuard(input);
  if (verdict.refusal) {
    throw new Error(`REFUSE_PRODUCTION_WRITE_TEST: ${verdict.refusal}`);
  }
  return verdict;
}
