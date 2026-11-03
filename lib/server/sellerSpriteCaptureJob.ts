import { createHash, randomUUID } from "node:crypto";

export const SELLERSPRITE_CAPTURE_JOB_SCHEMA = 2 as const;
const MAX_CHECKPOINT_ROWS = 10_000;
const MAX_EVIDENCE_REFS = 10_000;
const DEFAULT_LEASE_MS = 120_000;

export type SellerSpriteCaptureModule = "sellersprite_product_market" | "reverse_asin" | "keyword_mining_trend" | "historical_trend";
export type SellerSpriteCaptureJobStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED";
export type SellerSpriteCaptureLimitation =
  | "query_finished" | "source_limit_declared" | "human_login_required" | "captcha_or_stop_page"
  | "budget_stop" | "technical_error" | "cancelled" | "unknown"
  // 主体补证的结构性受阻：与「技术错误」「套餐限制」分开，便于用户知道下一步做什么。
  | "source_page_not_ready" | "no_verified_values" | "source_identity_mismatch"
  | "source_page_redirected" | "source_identity_unconfirmed";

export type SellerSpriteCaptureCounters = {
  reportedTotalRows: number | null;
  accessibleRows: number | null;
  capturedUniqueRows: number;
  structuredValidRows: number;
  persistedEvidenceRows: number;
  unavailableRows: number | null;
};

export type SellerSpriteCaptureDiagnostics = {
  actualVisibleRows: number;
  duplicatesRejected: number;
  rejectedRows: number;
  windowsProcessed: number;
  /** Null means this task had no prior cursor to restore. */
  cursorRestored?: boolean | null;
};

export type SellerSpriteCaptureCursor = { page: number; scrollY: number; scrollTarget?: "document" | "table" };

export type SellerSpriteCaptureJob = {
  schemaVersion: typeof SELLERSPRITE_CAPTURE_JOB_SCHEMA;
  jobId: string;
  module: SellerSpriteCaptureModule;
  marketplace: "US";
  query: Readonly<Record<string, string>>;
  queryFingerprint: string;
  accessScopeHash: string;
  status: SellerSpriteCaptureJobStatus;
  createdAt: string;
  updatedAt: string;
  attemptGeneration: number;
  /** Snapshot generation is independent of a worker retry / process-recovery attempt. */
  captureGeneration?: number;
  snapshotFingerprint?: string | null;
  /** Hash of the last persisted visible window, used to resume an interrupted row-evidence write safely. */
  cursorWindowFingerprint?: string | null;
  fence: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /** Maximum visible result windows a single user-triggered attempt may traverse. */
  windowBudget: number;
  cursor: SellerSpriteCaptureCursor | null;
  rowKeys: readonly string[];
  structuredValidRowKeys: readonly string[];
  persistedRowKeys?: readonly string[];
  evidenceRefs: readonly string[];
  diagnostics?: SellerSpriteCaptureDiagnostics;
  counters: SellerSpriteCaptureCounters;
  limitationReason: SellerSpriteCaptureLimitation;
  lastErrorCode: string | null;
  /** Previous access-limit checkpoints survive explicit, bounded source rechecks. */
  sourceRechecks?: readonly { at: string; attemptGeneration: number; status: SellerSpriteCaptureJobStatus; limitationReason: SellerSpriteCaptureLimitation; lastErrorCode: string | null }[];
};

export type SellerSpriteCaptureJobInput = {
  module: SellerSpriteCaptureModule;
  marketplace: "US";
  query: Readonly<Record<string, string>>;
  windowBudget?: number;
  /** Caller scope is hashed; it is never persisted as a raw identity or credential. */
  accessScope: string;
};

export type SellerSpriteCaptureClaim = { job: SellerSpriteCaptureJob; fence: number };

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stable(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function sellerSpriteCaptureAccessScopeHash(accessScope: string): string {
  return digest(accessScope.trim());
}

export function sellerSpriteCaptureJobFingerprint(input: {
  module: SellerSpriteCaptureModule;
  marketplace: "US";
  query: Readonly<Record<string, string>>;
  accessScopeHash: string;
}): string {
  return digest({ module: input.module, marketplace: input.marketplace, query: input.query, accessScopeHash: input.accessScopeHash });
}

function validTime(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function validCursor(value: SellerSpriteCaptureCursor | null): boolean {
  return value === null || (Number.isSafeInteger(value.page) && value.page >= 1
    && Number.isSafeInteger(value.scrollY) && value.scrollY >= 0
    && (value.scrollTarget === undefined || value.scrollTarget === "document" || value.scrollTarget === "table"));
}

function validCoverageSnapshot(input: Pick<SellerSpriteCaptureCounters,
  "reportedTotalRows" | "accessibleRows" | "unavailableRows">): boolean {
  const { reportedTotalRows, accessibleRows, unavailableRows } = input;
  const counts = [reportedTotalRows, accessibleRows, unavailableRows];
  if (counts.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) return false;
  if (reportedTotalRows === null) return true;
  if (accessibleRows !== null && accessibleRows > reportedTotalRows) return false;
  if (unavailableRows !== null && unavailableRows > reportedTotalRows) return false;
  return accessibleRows === null || unavailableRows === null
    || accessibleRows + unavailableRows <= reportedTotalRows;
}

function cursorRegresses(previous: SellerSpriteCaptureJob["cursor"], next: SellerSpriteCaptureJob["cursor"]): boolean {
  if (previous && !next) return true;
  if (!previous || !next) return false;
  return next.page < previous.page || (next.page === previous.page && next.scrollY < previous.scrollY);
}

export function createSellerSpriteCaptureJob(input: SellerSpriteCaptureJobInput, now = new Date()): SellerSpriteCaptureJob {
  if (!validTime(now) || !input.accessScope.trim() || !input.query || Object.keys(input.query).length === 0
    || (input.windowBudget !== undefined && (!Number.isSafeInteger(input.windowBudget) || input.windowBudget < 1 || input.windowBudget > 20))
    || Object.keys(input.query).length > 24
    || Object.entries(input.query).some(([key, value]) => !key.trim() || /^(?:authorization|cookie|token|secret|password|api[_-]?key)$/iu.test(key)
      || typeof value !== "string" || !value.trim() || value.length > (key === "sourceUrl" && input.query.kind === "single_subject_current_page" ? 4096 : 160) || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new Error("SELLERSPRITE_CAPTURE_JOB_INPUT_INVALID");
  }
  const query = Object.fromEntries(Object.entries(input.query).map(([key, value]) => [key.trim(), value.normalize("NFC").trim()]));
  const accessScopeHash = sellerSpriteCaptureAccessScopeHash(input.accessScope);
  const queryFingerprint = sellerSpriteCaptureJobFingerprint({ module: input.module, marketplace: input.marketplace, query, accessScopeHash });
  const timestamp = now.toISOString();
  return {
    schemaVersion: SELLERSPRITE_CAPTURE_JOB_SCHEMA,
    jobId: randomUUID(),
    module: input.module,
    marketplace: input.marketplace,
    query,
    queryFingerprint,
    accessScopeHash,
    status: "PENDING",
    createdAt: timestamp,
    updatedAt: timestamp,
    attemptGeneration: 0,
    captureGeneration: 0,
    snapshotFingerprint: null,
    cursorWindowFingerprint: null,
    fence: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    windowBudget: input.windowBudget ?? 8,
    cursor: null,
    rowKeys: [],
    structuredValidRowKeys: [],
    persistedRowKeys: [],
    evidenceRefs: [],
    diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    counters: {
      reportedTotalRows: null,
      accessibleRows: null,
      capturedUniqueRows: 0,
      structuredValidRows: 0,
      persistedEvidenceRows: 0,
      unavailableRows: null,
    },
    limitationReason: "unknown",
    lastErrorCode: null,
  };
}

export function bindSellerSpriteCaptureSnapshot(
  job: SellerSpriteCaptureJob,
  input: {
    worker: string;
    fence: number;
    now: Date;
    snapshotFingerprint: string;
    reportedTotalRows: number | null;
    accessibleRows: number | null;
    unavailableRows: number | null;
    forceNewGeneration?: boolean;
  },
): SellerSpriteCaptureJob | null {
  if (!validTime(input.now) || job.status !== "RUNNING" || job.leaseOwner !== input.worker || job.fence !== input.fence
    || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= input.now.getTime()
    || !validCoverageSnapshot(input)
    || !/^[a-f0-9]{64}$/u.test(input.snapshotFingerprint)) return null;
  if (job.snapshotFingerprint === input.snapshotFingerprint && !input.forceNewGeneration) {
    if (job.counters.reportedTotalRows === input.reportedTotalRows
      && job.counters.accessibleRows === input.accessibleRows
      && job.counters.unavailableRows === input.unavailableRows) return job;
    // 同一快照的重复绑定只刷新来源覆盖数字（页面上总量/可访问/未开放的解析差异），
    // 绝不重置累计计数、rowKeys 或断点 —— 那会把已保存结果显示成被清空。
    return {
      ...job,
      updatedAt: input.now.toISOString(),
      counters: {
        ...job.counters,
        reportedTotalRows: input.reportedTotalRows,
        accessibleRows: input.accessibleRows,
        unavailableRows: input.unavailableRows,
      },
    };
  }
  return {
    ...job,
    updatedAt: input.now.toISOString(),
    captureGeneration: (job.captureGeneration ?? 0) + 1,
    snapshotFingerprint: input.snapshotFingerprint,
    cursorWindowFingerprint: null,
    cursor: null,
    rowKeys: [],
    structuredValidRowKeys: [],
    persistedRowKeys: [],
    counters: {
      reportedTotalRows: input.reportedTotalRows,
      accessibleRows: input.accessibleRows,
      capturedUniqueRows: 0,
      structuredValidRows: 0,
      persistedEvidenceRows: 0,
      unavailableRows: input.unavailableRows,
    },
    diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    limitationReason: "unknown",
    lastErrorCode: null,
  };
}

export function claimSellerSpriteCaptureJob(
  job: SellerSpriteCaptureJob,
  worker: string,
  now = new Date(),
  leaseMs = 120_000,
): SellerSpriteCaptureClaim | null {
  if (!validTime(now) || !worker.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1
    || leaseMs > 30 * 60_000
    || job.status === "PAUSED" || job.status === "COMPLETE" || job.status === "PARTIAL"
    || job.status === "FAILED" || job.status === "CANCELLED") return null;
  if (job.status === "RUNNING" && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now.getTime())) return null;
  const reclaim = job.status === "RUNNING";
  const claimed: SellerSpriteCaptureJob = {
    ...job,
    status: "RUNNING",
    updatedAt: now.toISOString(),
    attemptGeneration: reclaim || job.attemptGeneration === 0 ? job.attemptGeneration + 1 : job.attemptGeneration,
    fence: job.fence + 1,
    leaseOwner: worker,
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
  return { job: claimed, fence: claimed.fence };
}

export function recordSellerSpriteCaptureProgress(
  job: SellerSpriteCaptureJob,
  input: {
    worker: string;
    fence: number;
    now: Date;
    rowKeys: readonly string[];
    structuredValidRowKeys?: readonly string[];
    evidenceRefs: readonly string[];
    cursor: SellerSpriteCaptureCursor | null;
    counters: Partial<SellerSpriteCaptureCounters>;
    persistedRowKeys?: readonly string[];
    cursorWindowFingerprint?: string | null;
    diagnostics?: Partial<SellerSpriteCaptureDiagnostics>;
    limitationReason?: SellerSpriteCaptureLimitation;
    lastErrorCode?: string | null;
    status?: "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED";
  },
): SellerSpriteCaptureJob | null {
  if (!validTime(input.now) || job.status !== "RUNNING" || job.leaseOwner !== input.worker || job.fence !== input.fence
    || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= input.now.getTime()
    || !validCursor(input.cursor) || cursorRegresses(job.cursor, input.cursor)
    || (input.cursorWindowFingerprint !== undefined && input.cursorWindowFingerprint !== null
      && !/^[a-f0-9]{64}$/u.test(input.cursorWindowFingerprint))) return null;
  const rowKeys = [...new Set([...job.rowKeys, ...input.rowKeys.map((key) => key.trim()).filter(Boolean)])];
  const structuredValidRowKeys = [...new Set([
    ...job.structuredValidRowKeys,
    ...(input.structuredValidRowKeys ?? []).map((key) => key.trim()).filter(Boolean),
  ])];
  const persistedRowKeys = [...new Set([
    ...(job.persistedRowKeys ?? []),
    ...(input.persistedRowKeys ?? []).map((key) => key.trim()).filter(Boolean),
  ])];
  const evidenceRefs = [...new Set([...job.evidenceRefs, ...input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean)])];
  const diagnostics = { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0,
    ...(job.diagnostics ?? {}), ...(input.diagnostics ?? {}) };
  if (rowKeys.length > MAX_CHECKPOINT_ROWS || structuredValidRowKeys.length > MAX_CHECKPOINT_ROWS
    || persistedRowKeys.length > MAX_CHECKPOINT_ROWS
    || evidenceRefs.length > MAX_EVIDENCE_REFS) return null;
  if (structuredValidRowKeys.some((key) => !rowKeys.includes(key))
    || persistedRowKeys.some((key) => !structuredValidRowKeys.includes(key))) return null;
  const counters = { ...job.counters, ...input.counters };
  if (!validCoverageSnapshot(counters)) return null;
  const countValues = Object.values(counters).filter((value): value is number => value !== null);
  const diagnosticValues = [diagnostics.actualVisibleRows, diagnostics.duplicatesRejected, diagnostics.rejectedRows, diagnostics.windowsProcessed];
  if (countValues.some((value) => !Number.isSafeInteger(value) || value < 0)
    || diagnosticValues.some((value) => !Number.isSafeInteger(value) || value < 0)
    || (diagnostics.cursorRestored !== undefined && diagnostics.cursorRestored !== null && typeof diagnostics.cursorRestored !== "boolean")
    || counters.capturedUniqueRows !== rowKeys.length
    || counters.capturedUniqueRows < job.counters.capturedUniqueRows
    || counters.structuredValidRows < job.counters.structuredValidRows
    || counters.persistedEvidenceRows < job.counters.persistedEvidenceRows
    || counters.structuredValidRows > counters.capturedUniqueRows
    || counters.structuredValidRows !== structuredValidRowKeys.length
    || counters.persistedEvidenceRows !== persistedRowKeys.length
    || counters.persistedEvidenceRows > counters.structuredValidRows
    || diagnostics.actualVisibleRows < (job.diagnostics?.actualVisibleRows ?? 0)
    || diagnostics.duplicatesRejected < (job.diagnostics?.duplicatesRejected ?? 0)
    || diagnostics.rejectedRows < (job.diagnostics?.rejectedRows ?? 0)
    || diagnostics.windowsProcessed < (job.diagnostics?.windowsProcessed ?? 0)
    || (counters.accessibleRows !== null && counters.capturedUniqueRows > counters.accessibleRows)
    || (counters.reportedTotalRows !== null && counters.capturedUniqueRows > counters.reportedTotalRows)
    || (job.counters.reportedTotalRows !== null && counters.reportedTotalRows !== job.counters.reportedTotalRows)
    || (job.counters.accessibleRows !== null && counters.accessibleRows !== job.counters.accessibleRows)
    || (job.counters.unavailableRows !== null && counters.unavailableRows !== job.counters.unavailableRows)) return null;
  const done = input.status !== undefined && input.status !== "RUNNING";
  return {
    ...job,
    status: input.status ?? "RUNNING",
    updatedAt: input.now.toISOString(),
    leaseOwner: done ? null : job.leaseOwner,
    leaseExpiresAt: done ? null : new Date(input.now.getTime() + DEFAULT_LEASE_MS).toISOString(),
    cursor: input.cursor,
    cursorWindowFingerprint: input.cursorWindowFingerprint === undefined
      ? job.cursorWindowFingerprint ?? null
      : input.cursorWindowFingerprint,
    rowKeys,
    structuredValidRowKeys,
    persistedRowKeys,
    evidenceRefs,
    diagnostics,
    counters,
    limitationReason: input.limitationReason ?? job.limitationReason,
    lastErrorCode: input.lastErrorCode === undefined ? job.lastErrorCode : input.lastErrorCode,
  };
}

export function pauseSellerSpriteCaptureJob(job: SellerSpriteCaptureJob, now: Date, actor: string): SellerSpriteCaptureJob | null {
  if (!validTime(now) || !actor.trim() || !["RUNNING", "PENDING", "PARTIAL"].includes(job.status)) return null;
  return { ...job, status: "PAUSED", updatedAt: now.toISOString(), leaseOwner: null, leaseExpiresAt: null };
}

export function resumeSellerSpriteCaptureJob(job: SellerSpriteCaptureJob, now: Date, actor: string): SellerSpriteCaptureJob | null {
  if (!validTime(now) || !actor.trim() || job.status !== "PAUSED" || job.limitationReason === "source_limit_declared") return null;
  return {
    ...job,
    status: "PENDING",
    updatedAt: now.toISOString(),
    attemptGeneration: job.attemptGeneration + 1,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
}

export function setSellerSpriteCaptureWindowBudget(
  job: SellerSpriteCaptureJob,
  windowBudget: number,
  now: Date,
): SellerSpriteCaptureJob | null {
  if (!validTime(now) || !Number.isSafeInteger(windowBudget) || windowBudget < 1 || windowBudget > 20
    || job.status === "RUNNING" || job.status === "COMPLETE" || job.status === "CANCELLED") return null;
  return { ...job, windowBudget, updatedAt: now.toISOString() };
}

export function retrySellerSpriteCaptureJob(job: SellerSpriteCaptureJob, now: Date): SellerSpriteCaptureJob | null {
  if (!validTime(now) || (job.status !== "PARTIAL" && job.status !== "FAILED")
    || job.limitationReason === "source_limit_declared") return null;
  return {
    ...job,
    status: "PENDING",
    updatedAt: now.toISOString(),
    attemptGeneration: job.attemptGeneration + 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    limitationReason: "unknown",
    lastErrorCode: null,
  };
}

export function cancelSellerSpriteCaptureJob(job: SellerSpriteCaptureJob, now: Date, actor: string): SellerSpriteCaptureJob | null {
  if (!validTime(now) || !actor.trim() || !["PENDING", "RUNNING", "PAUSED", "PARTIAL"].includes(job.status)) return null;
  return {
    ...job,
    status: "CANCELLED",
    updatedAt: now.toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
    limitationReason: "cancelled",
  };
}

/** An explicit user action, never used by normal retry, polling or the scheduler.
 * Claims one window atomically; the source limit remains until real source results
 * replace it. Failure/uncertainty must remain blocked in the route checkpoint. */
export function claimSellerSpriteSourceRecheck(job: SellerSpriteCaptureJob, worker: string, now = new Date()): SellerSpriteCaptureClaim | null {
  if (!validTime(now) || !worker.trim() || job.limitationReason !== "source_limit_declared"
    || (!(["PARTIAL", "FAILED", "PAUSED"].includes(job.status))
      && !(job.status === "RUNNING" && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now.getTime()))) return null;
  const claimed: SellerSpriteCaptureJob = {
    ...job, status: "RUNNING", updatedAt: now.toISOString(), windowBudget: 1,
    attemptGeneration: job.attemptGeneration + 1, fence: job.fence + 1,
    leaseOwner: worker, leaseExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    sourceRechecks: [...(job.sourceRechecks ?? []), { at: now.toISOString(), attemptGeneration: job.attemptGeneration, status: job.status, limitationReason: job.limitationReason, lastErrorCode: job.lastErrorCode }],
  };
  return { job: claimed, fence: claimed.fence };
}
