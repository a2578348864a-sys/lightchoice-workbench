import "server-only";

/**
 * Product Source Layer V1.2 — Evidence Store（Phase 1 / 三、3 + 六、版本与生命周期）
 *
 * 原则：
 * - 外部数据先作为 Evidence；采集结果永远不能直接进入 AI 结论；
 * - 同一商品多次采集产生 version1 / version2 / version3，禁止覆盖历史；
 * - 每个版本保存原始数据、来源、时间、版本号；
 * - 按访问主体（owner:v1 / visitor:<id>）物理隔离，Owner 正式路径不会写入访客目录；
 * - 审计与证据分离：审计是 append-only 的独立文件，证据按版本独立成文件。
 *
 * 存储介质选择说明：
 * 采用文件存储而非新增 Prisma 模型，因为本任务是「新增来源入口」，
 * 不应触发数据库结构重大变化（V1.2 九、Agent 执行规则：必须停止项）。
 * 目录可用 SOURCE_LAYER_STORE_DIR 覆盖；测试使用 .next/test-stores 隔离。
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  appendAuditEntries,
  appendAuditEntry,
  type AuditTraceFields,
  parseAuditLog,
  type AuditEntryInput,
  type AuditLogEntry,
} from "@/lib/sourceLayer/auditLog";
import {
  diagnosticEventToAuditInput,
  type DiagnosticEvent,
} from "@/lib/sourceLayer/diagnostics";
import {
  assignEvidenceVersion,
  type EvidenceVersionAssignment,
} from "@/lib/sourceLayer/expiration";
import type { CapturePackage } from "@/lib/sourceLayer/capturePackage";
import type { CaptureLifecycleState } from "@/lib/sourceLayer/stateMachine";
import {
  parseSourceEvidenceAttachment,
  sourceEvidenceAttachmentFileName,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";
import {
  parseSourceRawArtifact,
  rawArtifactMetadataFileNameFor,
  sha256OfRawArtifact,
  type SourceRawArtifact,
} from "@/lib/sourceLayer/rawArtifact";
import { withFileLock } from "@/lib/server/atomicFileStore";
import {
  parseEvidenceRecord,
  captureContentHashOf,
  contentHashOf,
  type CaptureEvidenceRecord,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  assertCategoryMarketCaptureBatch,
  categoryMarketSubjectKey,
  isCategoryMarketSubjectKey,
  type CategoryMarketCaptureBatch,
} from "@/lib/sourceLayer/categoryMarketCapture";
import { parseSellerSpriteQuerySubjectKey } from "@/lib/sourceLayer/queryEvidenceSubject";
import {
  parseTrendObservation,
  type TrendObservation,
} from "@/lib/sourceLayer/v2/contracts";

export const EVIDENCE_STORE_SCHEMA = "source-evidence-store.v1" as const;
export const EVIDENCE_SUBJECT_SCHEMA = "source-evidence-subject.v1" as const;
const MAX_AUDIT_FILE_ENTRIES = 2000;

export type EvidenceSubjectIndexEntry = {
  subjectKey: string;
  marketplace: string;
  sourceType: CapturePackage["sourceProof"]["sourceType"];
  latestVersion: number;
  versions: number[];
  latestCapturedAt: string;
  latestVerdict: CaptureEvidenceRecord["validation"]["verdict"];
  /** 新版索引保存状态机快照；旧索引缺失时由调用方按旧字段兼容。 */
  latestState?: CaptureLifecycleState;
  updatedAt: string;
  operator: string;
  displayTitle: string | null;
  asin: string | null;
};

export type EvidenceSubjectIndex = {
  schemaVersion: typeof EVIDENCE_STORE_SCHEMA;
  subjects: EvidenceSubjectIndexEntry[];
  updatedAt: string;
};

export type EvidenceSubjectRecord = {
  schemaVersion: typeof EVIDENCE_SUBJECT_SCHEMA;
  subjectKey: string;
  marketplace: string;
  updatedAt: string;
  operator: string;
  /** 版本历史（含最新），按版本号升序；内容不可变。 */
  versions: CaptureEvidenceRecord[];
  integrityIssues?: Array<{ fileName: string; code: string }>;
  /** 关键词/评论等非 ProductFact 证据，存于同一 EvidenceStore，不参与商品版本号。 */
  attachments?: SourceEvidenceAttachment[];
  /** 类目市场快照与商品版本分开建模，但继续使用同一 EvidenceStore、主体目录和审计日志。 */
  marketCaptures?: CategoryMarketCaptureBatch[];
  /** 原始下载/导出文件的元数据；二进制本体与版本、审计同目录保存。 */
  rawArtifacts?: SourceRawArtifact[];
};

export type EvidenceStore = {
  listSubjects(): Promise<EvidenceSubjectIndexEntry[]>;
  /** Query subjects stay outside the product index; discovery is read-only. */
  listQuerySubjects?(): Promise<string[]>;
  /** Reads the newest category market snapshot from this same EvidenceStore, without mutating its index. */
  getLatestCategoryMarketCapture?(): Promise<{ subjectKey: string; batch: CategoryMarketCaptureBatch } | null>;
  /**
   * 只读枚举本 EvidenceStore 中已存在的类目市场查询主体。
   * 类目主体不进入商品索引（`index.json`），因此必须直接读取主体目录；
   * 仅返回主体键与节点号，内容仍通过 `getSubject()` 读取，保持单一权威。
   */
  listCategoryMarketSubjects?(): Promise<Array<{ subjectKey: string; nodeId: string }>>;
  getSubject(subjectKey: string): Promise<EvidenceSubjectRecord | null>;
  getAudit(subjectKey: string): Promise<AuditLogEntry[]>;
  /** 统一诊断仍写入同一 EvidenceStore 的审计文件，不建立第二套日志存储。 */
  appendDiagnosticEvent?(input: {
    event: DiagnosticEvent;
    operator: string;
    now: Date;
  }): Promise<{ subjectKey: string; event: DiagnosticEvent }>;
  /** V2 趋势观测仍落在同一主体 EvidenceStore；按日+字段+内容去重，不做版本裁剪。 */
  listTrendObservations?(subjectKey: string): Promise<TrendObservation[]>;
  appendTrendObservation?(input: {
    observation: TrendObservation;
    operator: string;
    now: Date;
  }): Promise<{ subjectKey: string; created: boolean; duplicate: boolean; observation: TrendObservation }>;
  appendEvidence(input: {
    evidence: CaptureEvidenceRecord;
    auditEntries: readonly AuditEntryInput[];
    operator: string;
    now: Date;
    trace?: AuditTraceFields;
  }): Promise<EvidenceAppendResult>;
  /** 同一 EvidenceStore 中的附属证据；不改变商品版本号或 READY 状态。 */
  appendAttachment?(input: {
    attachment: SourceEvidenceAttachment;
    auditEntries?: readonly AuditEntryInput[];
    operator: string;
    now: Date;
  }): Promise<{
    subjectKey: string;
    created: boolean;
    duplicate: boolean;
    attachment: SourceEvidenceAttachment;
  }>;
  /** 类目市场机会事实追加写入同一 EvidenceStore，不创建 ProductFact 版本。 */
  appendCategoryMarketCapture?(input: {
    subjectKey: string;
    batch: CategoryMarketCaptureBatch;
    operator: string;
    now: Date;
  }): Promise<{
    subjectKey: string;
    created: boolean;
    duplicate: boolean;
    contentHash: string;
    batch: CategoryMarketCaptureBatch;
  }>;
  /** 同一 EvidenceStore 中保留原始下载/导出文件，不创建第二事实库。 */
  appendRawArtifact?(input: {
    artifact: SourceRawArtifact;
    bytes: Uint8Array;
    operator: string;
    now: Date;
  }): Promise<{
    subjectKey: string;
    created: boolean;
    duplicate: boolean;
    artifact: SourceRawArtifact;
  }>;
};

export type EvidenceAppendResult = {
  subjectKey: string;
  version: number;
  created: boolean;
  /** 内容指纹重复时为 true（同一次采集重复提交不会生成新版本）。 */
  duplicate: boolean;
  assignment: EvidenceVersionAssignment;
  record: EvidenceSubjectRecord;
};

export class EvidenceStoreError extends Error {
  constructor(
    public readonly code:
      | "evidence_store_invalid"
      | "evidence_subject_invalid"
      | "evidence_content_hash_mismatch"
      | "evidence_id_invalid"
      | "evidence_subject_key_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

/* ── 路径与主体隔离 ─────────────────────────────────────────────── */

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/;
const OPERATOR_DIR_PATTERN = /^[A-Za-z0-9._\-]{1,64}$/;

function storeRoot(): string {
  if (process.env.SOURCE_LAYER_STORE_DIR) return resolve(process.env.SOURCE_LAYER_STORE_DIR);
  if (process.env.NODE_ENV === "test") {
    return resolve(process.cwd(), ".next", "test-stores", "source-layer");
  }
  return resolve(process.cwd(), "data", "source-layer-store");
}

/**
 * 只读暴露「本进程实际使用的证据根目录」。
 * 供批次隔离性断言使用：必须证明读写都落在 scratch 副本内，而不是正式 EvidenceStore。
 */
export function resolveEvidenceStoreRoot(): string {
  return storeRoot();
}

export function assertSafeSubjectKey(subjectKey: string): string {
  if (!SUBJECT_KEY_PATTERN.test(subjectKey)) {
    throw new EvidenceStoreError("evidence_subject_invalid", "商品身份键不合法。");
  }
  return subjectKey;
}

/**
 * 访问主体 → 目录名。
 * 必须剔除 `:`（Windows 目录名非法）、路径分隔符与 `.` 序列，
 * 因此 `owner:v1` 映射为 `owner-v1`；不同主体不会产生同名目录。
 */
export function assertSafeOperatorDir(operator: string): string {
  const normalized = operator
    .trim()
    .toLowerCase()
    .replace(/[:\\/]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || !OPERATOR_DIR_PATTERN.test(normalized)) {
    throw new EvidenceStoreError("evidence_subject_invalid", "访问主体标识不合法。");
  }
  return normalized;
}

const UNSAFE_PATH_CHAR = /[^A-Za-z0-9._-]/;

/**
 * 逻辑主体键 → 文件系统安全名。
 * Windows 目录名与文件名都不允许 `:`、`|`、`@`、`%` 等字符，因此逐字符百分号编码，
 * 一次编码（不二次转义），保证映射可逆且不同身份键不会碰撞。
 */
export function toSafePathSegment(value: string): string {
  if (value === "." || value === "..") return value.replaceAll(".", "%2E");
  let out = "";
  for (const character of value) {
    if (!UNSAFE_PATH_CHAR.test(character)) {
      out += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function subjectDir(operator: string, subjectKey: string): string {
  return resolve(
    storeRoot(),
    assertSafeOperatorDir(operator),
    "subjects",
    toSafePathSegment(assertSafeSubjectKey(subjectKey)),
  );
}

function auditPath(operator: string, subjectKey: string): string {
  return resolve(
    storeRoot(),
    assertSafeOperatorDir(operator),
    "audit",
    `${toSafePathSegment(assertSafeSubjectKey(subjectKey))}.json`,
  );
}

/* ── 原子写（与既有 demo-sandbox 存储同构） ─────────────────────── */

function ensureDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDirectory(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new EvidenceStoreError("evidence_store_invalid", "来源证据文件已损坏，已 fail-closed。");
  }
}

/* ── 主体记录读写 ───────────────────────────────────────────────── */

function subjectFilePath(operator: string, subjectKey: string, version: number): string {
  return resolve(subjectDir(operator, subjectKey), `v${String(version).padStart(4, "0")}.json`);
}

function categoryMarketCaptureFilePath(operator: string, subjectKey: string, contentHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new EvidenceStoreError("evidence_content_hash_mismatch", "类目市场快照指纹不合法。");
  }
  return resolve(subjectDir(operator, subjectKey), `m-${contentHash}.json`);
}

function parseEvidenceRecordStrict(value: unknown): CaptureEvidenceRecord | null {
  return parseEvidenceRecord(value);
}

function readVersions(operator: string, subjectKey: string, integrityIssues: NonNullable<EvidenceSubjectRecord["integrityIssues"]> = []): CaptureEvidenceRecord[] {
  const directory = subjectDir(operator, subjectKey);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((name) => /^v\d{4}\.json$/.test(name))
    .sort();
  const versions: CaptureEvidenceRecord[] = [];
  let firstFailure: unknown;
  for (const file of files) {
    try {
    const parsed = parseEvidenceRecordStrict(readJson(resolve(directory, file)));
    if (!parsed) {
      throw new EvidenceStoreError("evidence_store_invalid", "来源证据版本文件不合法，已 fail-closed。");
    }
    if (parsed.subjectKey !== subjectKey) {
      throw new EvidenceStoreError("evidence_subject_key_mismatch", "来源证据版本与主体不匹配。");
    }
    if (captureContentHashOf(parsed.pkg) !== parsed.contentHash) {
      throw new EvidenceStoreError("evidence_content_hash_mismatch", "来源证据内容与绑定指纹不一致，已隔离该版本。");
    }
    versions.push(parsed);
    } catch (error) {
      firstFailure ??= error;
      integrityIssues.push({ fileName: file, code: error instanceof EvidenceStoreError ? error.code : "evidence_store_invalid" });
    }
  }
  if (versions.length === 0 && firstFailure) throw firstFailure;
  return versions;
}

function readAttachments(operator: string, subjectKey: string, integrityIssues?: NonNullable<EvidenceSubjectRecord["integrityIssues"]>): SourceEvidenceAttachment[] {
  const directory = subjectDir(operator, subjectKey);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((name) => /^a-[a-f0-9]{64}\.json$/.test(name))
    .sort();
  const attachments: SourceEvidenceAttachment[] = [];
  for (const file of files) {
    try {
    const parsed = parseSourceEvidenceAttachment(readJson(resolve(directory, file)));
    if (!parsed || parsed.subjectKey !== subjectKey) {
      throw new EvidenceStoreError("evidence_store_invalid", "来源附属证据文件不合法，已 fail-closed。");
    }
    attachments.push(parsed);
    } catch (error) {
      if (!integrityIssues) throw error;
      integrityIssues.push({ fileName: file, code: "evidence_store_invalid" });
    }
  }
  return attachments;
}

function readCategoryMarketCaptures(
  operator: string,
  subjectKey: string,
  integrityIssues?: NonNullable<EvidenceSubjectRecord["integrityIssues"]>,
): CategoryMarketCaptureBatch[] {
  const directory = subjectDir(operator, subjectKey);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((name) => /^m-[a-f0-9]{64}\.json$/u.test(name))
    .sort();
  const batches: CategoryMarketCaptureBatch[] = [];
  for (const file of files) {
    try {
      const value = readJson(resolve(directory, file));
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new EvidenceStoreError("evidence_store_invalid", "类目市场快照文件不合法，已 fail-closed。");
      }
      const record = value as Record<string, unknown>;
      if (record.schemaVersion !== "source-category-market-capture.v1"
        || record.subjectKey !== subjectKey
        || typeof record.contentHash !== "string"
        || !/^[a-f0-9]{64}$/u.test(record.contentHash)) {
        throw new EvidenceStoreError("evidence_store_invalid", "类目市场快照元数据不合法，已 fail-closed。");
      }
      assertCategoryMarketCaptureBatch(record.batch);
      const batch = record.batch as CategoryMarketCaptureBatch;
      if (categoryMarketSubjectKey(batch.category.nodeId) !== subjectKey
        || contentHashOf({ subjectKey, batch }) !== record.contentHash
        || file !== `m-${record.contentHash}.json`) {
        throw new EvidenceStoreError("evidence_content_hash_mismatch", "类目市场快照主体或内容指纹不一致。");
      }
      batches.push(batch);
    } catch (error) {
      if (!integrityIssues) throw error;
      integrityIssues.push({ fileName: file, code: error instanceof EvidenceStoreError ? error.code : "evidence_store_invalid" });
    }
  }
  return batches.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)
    || left.batchId.localeCompare(right.batchId));
}

function writeBinaryAtomic(filePath: string, bytes: Uint8Array): void {
  ensureDirectory(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function readRawArtifacts(operator: string, subjectKey: string, integrityIssues?: NonNullable<EvidenceSubjectRecord["integrityIssues"]>): SourceRawArtifact[] {
  const directory = subjectDir(operator, subjectKey);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory);
  const metadataHashes = new Set(
    names.flatMap((name) => {
      const match = /^r-([a-f0-9]{64})\.meta\.json$/.exec(name);
      return match ? [match[1]] : [];
    }),
  );
  const files = names
    .filter((name) => {
      if (/^r-[a-f0-9]{64}\.meta\.json$/.test(name)) return true;
      const legacy = /^r-([a-f0-9]{64})\.json$/.exec(name);
      // 兼容旧的 xlsx/csv 元数据文件名；JSON 本体若有新元数据文件，
      // 同名的二进制本体不能被误当作旧元数据解析。
      return legacy !== null && !metadataHashes.has(legacy[1]);
    })
    .sort();
  const artifacts: SourceRawArtifact[] = [];
  for (const file of files) {
    try {
    const parsed = parseSourceRawArtifact(readJson(resolve(directory, file)));
    if (!parsed || parsed.subjectKey !== subjectKey) {
      throw new EvidenceStoreError("evidence_store_invalid", "原始来源文件元数据不合法，已 fail-closed。");
    }
    const storedFile = resolve(directory, parsed.storageFileName);
    if (!existsSync(storedFile) || statSync(storedFile).size !== parsed.byteLength) {
      throw new EvidenceStoreError("evidence_store_invalid", "原始来源文件本体缺失或大小不匹配，已 fail-closed。");
    }
    artifacts.push(parsed);
    } catch (error) {
      if (!integrityIssues) throw error;
      integrityIssues.push({ fileName: file, code: "evidence_store_invalid" });
    }
  }
  return artifacts;
}

/**
 * 查询级主体记录（SellerSprite 类目查询 / seedKeyword 查询）。
 *
 * 这些主体没有、也不允许伪造商品版本，因此只按「同主体目录下的附属证据与
 * 原始文件」构建只读记录；它不进入商品索引（`index.json`），
 * 也不会出现在 `listSubjects()` 的商品台账中。
 * 没有附件与原始文件时返回 null（与「不存在的商品主体」保持同样语义）。
 */
function readQuerySubjectRecord(
  operator: string,
  subjectKey: string,
  integrityIssues: NonNullable<EvidenceSubjectRecord["integrityIssues"]>,
): EvidenceSubjectRecord | null {
  const identity = parseSellerSpriteQuerySubjectKey(subjectKey);
  if (!identity) return null;
  const attachments = readAttachments(operator, subjectKey, integrityIssues);
  const rawArtifacts = readRawArtifacts(operator, subjectKey, integrityIssues);
  if (attachments.length === 0 && rawArtifacts.length === 0) return null;
  const updatedAt = [...attachments.map((item) => item.capturedAt), ...rawArtifacts.map((item) => item.capturedAt)]
    .sort()
    .at(-1) ?? "";
  return {
    schemaVersion: EVIDENCE_SUBJECT_SCHEMA,
    subjectKey,
    marketplace: identity.marketplace,
    updatedAt,
    operator,
    versions: [],
    ...(integrityIssues.length ? { integrityIssues } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(rawArtifacts.length > 0 ? { rawArtifacts } : {}),
  };
}

function readAudit(operator: string, subjectKey: string): AuditLogEntry[] {
  const parsed = readJson(auditPath(operator, subjectKey));
  if (parsed === null) return [];
  const entries = parseAuditLog(parsed);
  if (entries.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
    throw new EvidenceStoreError("evidence_store_invalid", "审计文件不合法，已 fail-closed。");
  }
  return entries;
}

/* ── Store 实现 ─────────────────────────────────────────────────── */

export function createEvidenceStore(operator: string): EvidenceStore {
  const operatorDir = assertSafeOperatorDir(operator);

  function indexFilePath(): string {
    return resolve(storeRoot(), operatorDir, "index.json");
  }

  function readIndex(): EvidenceSubjectIndex {
    const parsed = readJson(indexFilePath());
    if (parsed === null) {
      return { schemaVersion: EVIDENCE_STORE_SCHEMA, subjects: [], updatedAt: "" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EvidenceStoreError("evidence_store_invalid", "来源证据索引不合法，已 fail-closed。");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== EVIDENCE_STORE_SCHEMA || !Array.isArray(record.subjects)) {
      throw new EvidenceStoreError("evidence_store_invalid", "来源证据索引版本不匹配，已 fail-closed。");
    }
    return record as unknown as EvidenceSubjectIndex;
  }

  return {
    async listSubjects() {
      return readIndex().subjects;
    },

    async listQuerySubjects() {
      const directory = resolve(storeRoot(), operatorDir, "subjects");
      if (!existsSync(directory)) return [];
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        try {
          const key = decodeURIComponent(entry.name);
          return parseSellerSpriteQuerySubjectKey(key) ? [key] : [];
        } catch { return []; }
      }).sort();
    },

    async getLatestCategoryMarketCapture() {
      const subjectsDirectory = resolve(storeRoot(), operatorDir, "subjects");
      if (!existsSync(subjectsDirectory)) return null;

      let latest: { subjectKey: string; batch: CategoryMarketCaptureBatch } | null = null;
      for (const entry of readdirSync(subjectsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let subjectKey: string;
        try {
          subjectKey = decodeURIComponent(entry.name);
        } catch {
          continue;
        }
        if (!isCategoryMarketSubjectKey(subjectKey)) continue;

        const captures = readCategoryMarketCaptures(operatorDir, subjectKey);
        const batch = captures[captures.length - 1];
        if (!batch) continue;
        if (!latest || batch.capturedAt.localeCompare(latest.batch.capturedAt) > 0
          || (batch.capturedAt === latest.batch.capturedAt && batch.batchId.localeCompare(latest.batch.batchId) > 0)) {
          latest = { subjectKey, batch };
        }
      }
      return latest;
    },

    async listCategoryMarketSubjects() {
      const subjectsDirectory = resolve(storeRoot(), operatorDir, "subjects");
      if (!existsSync(subjectsDirectory)) return [];
      const subjects: Array<{ subjectKey: string; nodeId: string }> = [];
      for (const entry of readdirSync(subjectsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let subjectKey: string;
        try {
          subjectKey = decodeURIComponent(entry.name);
        } catch {
          continue;
        }
        if (!isCategoryMarketSubjectKey(subjectKey)) continue;
        subjects.push({ subjectKey, nodeId: subjectKey.slice("market:US:category:".length) });
      }
      return subjects.sort((left, right) => left.subjectKey.localeCompare(right.subjectKey));
    },

    async getSubject(subjectKey) {
      const integrityIssues: NonNullable<EvidenceSubjectRecord["integrityIssues"]> = [];
      const versions = readVersions(operatorDir, subjectKey, integrityIssues);
      if (isCategoryMarketSubjectKey(subjectKey)) {
        const marketCaptures = readCategoryMarketCaptures(operatorDir, subjectKey, integrityIssues);
        if (marketCaptures.length === 0) return null;
        return {
          schemaVersion: EVIDENCE_SUBJECT_SCHEMA,
          subjectKey,
          marketplace: "US",
          updatedAt: marketCaptures[marketCaptures.length - 1]!.capturedAt,
          operator: operatorDir,
          versions,
          ...(integrityIssues.length ? { integrityIssues } : {}),
          marketCaptures,
        };
      }
      if (versions.length === 0) return readQuerySubjectRecord(operatorDir, subjectKey, integrityIssues);
      const attachments = readAttachments(operatorDir, subjectKey, integrityIssues);
      const rawArtifacts = readRawArtifacts(operatorDir, subjectKey, integrityIssues);
      return {
        schemaVersion: EVIDENCE_SUBJECT_SCHEMA,
        subjectKey,
        marketplace: versions[versions.length - 1].pkg.marketplace,
        updatedAt: versions[versions.length - 1].validation.checkedAt,
        operator: operatorDir,
        versions,
        ...(integrityIssues.length ? { integrityIssues } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(rawArtifacts.length > 0 ? { rawArtifacts } : {}),
      };
    },

    async getAudit(subjectKey) {
      return readAudit(operatorDir, subjectKey);
    },

    async appendDiagnosticEvent({ event, operator: _operator, now }) {
      return withFileLock(indexFilePath(), () => {
        const subjectKey = assertSafeSubjectKey(event.subjectKey ?? "");
        const baseAudit = readAudit(operatorDir, subjectKey);
        const auditInput = diagnosticEventToAuditInput(event);
        const entry = appendAuditEntry(baseAudit, {
          ...auditInput,
          operator: _operator,
          timestamp: now.toISOString(),
        });
        if (entry.length === 0) {
          throw new EvidenceStoreError("evidence_store_invalid", "诊断审计条目缺失，已 fail-closed。");
        }
        const trimmed = entry.length > MAX_AUDIT_FILE_ENTRIES
          ? entry.slice(entry.length - MAX_AUDIT_FILE_ENTRIES)
          : entry;
        writeJsonAtomic(auditPath(operatorDir, subjectKey), trimmed);
        return { subjectKey, event };
      });
    },

    async listTrendObservations(subjectKey) {
      return readTrendObservations(operatorDir, subjectKey);
    },

    async appendTrendObservation({ observation, operator: _operator, now }) {
      return withFileLock(indexFilePath(), () => {
        const subjectKey = assertSafeSubjectKey(observation.subjectKey);
        const versions = readVersions(operatorDir, subjectKey);
        if (versions.length === 0) {
          throw new EvidenceStoreError("evidence_subject_invalid", "趋势观测必须绑定到已存在的商品来源证据。");
        }
        const existing = readTrendObservations(operatorDir, subjectKey);
        const duplicate = existing.find((item) => item.dedupeKey === observation.dedupeKey) ?? null;
        const baseAudit = readAudit(operatorDir, subjectKey);
        const nextAudit = appendAuditEntry(baseAudit, {
          eventKind: "diagnostic",
          reason: duplicate ? "重复趋势观测，复用既有观测" : "趋势观测持久化",
          timestamp: now.toISOString(),
          subjectKey,
          operator: _operator,
          module: "TREND_OBSERVATION",
          phase: "persist",
          eventType: "trend_observation_persisted",
          severity: "info",
          sourceType: observation.sourceType,
          evidenceRefs: observation.evidenceRefs,
          contentHash: observation.contentHash,
          detail: {
            field: observation.field,
            capturedDate: observation.capturedDate,
            duplicate: duplicate !== null,
          },
        });
        writeJsonAtomic(auditPath(operatorDir, subjectKey), nextAudit.slice(-MAX_AUDIT_FILE_ENTRIES));
        if (duplicate) {
          return { subjectKey, created: false, duplicate: true, observation: duplicate };
        }
        writeJsonAtomic(trendFilePath(operatorDir, subjectKey, observation.dedupeKey), observation);
        return { subjectKey, created: true, duplicate: false, observation };
      });
    },

    async appendEvidence({ evidence, auditEntries, operator: _operator, now, trace }) {
      void _operator;
      return withFileLock(indexFilePath(), () => {
      const subjectKey = assertSafeSubjectKey(evidence.subjectKey);
      if (!evidence.evidenceId.startsWith("ev-")) {
        throw new EvidenceStoreError("evidence_id_invalid", "Evidence 标识不合法。");
      }
      if (captureContentHashOf(evidence.pkg) !== evidence.contentHash) {
        throw new EvidenceStoreError("evidence_content_hash_mismatch", "Evidence 内容指纹不一致，已拒绝写入。");
      }
      const existing = readVersions(operatorDir, subjectKey);
      const latest = existing.length > 0 ? existing[existing.length - 1] : null;
      // 重复判定按内容指纹在整个版本历史中查找：同一份证据被原样重放时
      // 应复用该版本，而不是产生一个内容完全相同的伪新版本。
      const duplicateOf = existing.find((item) => item.contentHash === evidence.contentHash) ?? null;

      // 审计先行：审计写入成功才落证据（AUDIT_REQUIRED 的落地方式）。
      const baseAudit = readAudit(operatorDir, subjectKey);
      const withCaptureEvent = appendAuditEntry(baseAudit, {
        eventKind: "capture_event",
        reason: duplicateOf
          ? `重复采集事件，复用 v${duplicateOf.version}`
          : "采集事件已接收",
        timestamp: now.toISOString(),
        captureId: evidence.captureId,
        subjectKey,
        operator: _operator,
        ...trace,
        module: trace?.module ?? "EVIDENCE_STORE",
        phase: trace?.phase ?? "persist",
        eventType: trace?.eventType ?? "capture_event",
        detail: {
          contentHash: evidence.contentHash,
          duplicate: duplicateOf !== null,
          version: duplicateOf?.version ?? evidence.version,
        },
      });
      const withEvidenceAudit = appendAuditEntry(withCaptureEvent, {
        eventKind: "evidence_persisted",
        reason: duplicateOf
          ? `重复采集，复用 v${duplicateOf.version}`
          : "证据版本持久化",
        timestamp: now.toISOString(),
        captureId: evidence.captureId,
        subjectKey,
        operator: operatorDir,
        ...trace,
        module: trace?.module ?? "EVIDENCE_STORE",
        phase: trace?.phase ?? "persist",
        eventType: trace?.eventType ?? "evidence_persisted",
        detail: { contentHash: evidence.contentHash, verdict: evidence.validation.verdict },
      });
      const merged = appendAuditEntries(withEvidenceAudit, auditEntries);
      const trimmed = merged.length > MAX_AUDIT_FILE_ENTRIES
        ? merged.slice(merged.length - MAX_AUDIT_FILE_ENTRIES)
        : merged;
      if (trimmed.length === 0) {
        throw new EvidenceStoreError("evidence_store_invalid", "审计条目缺失，已 fail-closed。");
      }
      writeJsonAtomic(auditPath(operatorDir, subjectKey), trimmed);

      if (duplicateOf) {
        return {
          subjectKey,
          version: duplicateOf.version,
          created: false,
          duplicate: true,
          assignment: {
            version: duplicateOf.version,
            retainedVersions: existing.map((item) => item.version),
            prunedVersions: [],
          },
          record: {
            schemaVersion: EVIDENCE_SUBJECT_SCHEMA,
            subjectKey,
            marketplace: duplicateOf.pkg.marketplace,
            updatedAt: now.toISOString(),
            operator: operatorDir,
            versions: existing,
          },
        };
      }

      const storedVersionNumbers = (existsSync(subjectDir(operatorDir, subjectKey)) ? readdirSync(subjectDir(operatorDir, subjectKey)) : []).flatMap((name) => {
        const match = /^v(\d{4})\.json$/u.exec(name);
        return match ? [Number(match[1])] : [];
      });
      const assignment = assignEvidenceVersion(storedVersionNumbers);
      if (assignment.prunedVersions.length) {
        const pruningAudit = appendAuditEntry(trimmed, { eventKind: "diagnostic", subjectKey,
          operator: operatorDir, timestamp: now.toISOString(), module: "EVIDENCE_STORE", phase: "persist",
          eventType: "evidence_versions_pruned", severity: "warning", reason: "版本保留上限裁剪；下游不得静默重绑定已裁剪版本。",
          detail: { prunedVersions: assignment.prunedVersions.join(","), retainedVersions: assignment.retainedVersions.join(","), incomingVersion: assignment.version },
        });
        writeJsonAtomic(auditPath(operatorDir, subjectKey), pruningAudit.slice(-MAX_AUDIT_FILE_ENTRIES));
      }
      const versioned: CaptureEvidenceRecord = { ...evidence, version: assignment.version };
      writeJsonAtomic(subjectFilePath(operatorDir, subjectKey, assignment.version), versioned);
      for (const pruned of assignment.prunedVersions) {
        const file = subjectFilePath(operatorDir, subjectKey, pruned);
        if (existsSync(file)) unlinkSync(file);
      }

      const versions = [
        ...existing.filter((item) => !assignment.prunedVersions.includes(item.version)),
        versioned,
      ].sort((left, right) => left.version - right.version);

      const subjectEntry: EvidenceSubjectIndexEntry = {
        subjectKey,
        marketplace: versioned.pkg.marketplace,
        sourceType: versioned.sourceType,
        latestVersion: versioned.version,
        versions: versions.map((item) => item.version),
        latestCapturedAt: versioned.capturedAt,
        latestVerdict: versioned.validation.verdict,
        ...(versioned.validation.captureState ? { latestState: versioned.validation.captureState } : {}),
        updatedAt: now.toISOString(),
        operator: operatorDir,
        displayTitle: versioned.pkg.fields.title,
        asin: versioned.pkg.fields.asin,
      };
      const index = readIndex();
      const subjects = [
        ...index.subjects.filter((item) => item.subjectKey !== subjectKey),
        subjectEntry,
      ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      writeJsonAtomic(indexFilePath(), {
        schemaVersion: EVIDENCE_STORE_SCHEMA,
        subjects,
        updatedAt: now.toISOString(),
      } satisfies EvidenceSubjectIndex);

      return {
        subjectKey,
        version: versioned.version,
        created: true,
        duplicate: false,
        assignment,
        record: {
          schemaVersion: EVIDENCE_SUBJECT_SCHEMA,
          subjectKey,
          marketplace: versioned.pkg.marketplace,
          updatedAt: now.toISOString(),
          operator: operatorDir,
          versions,
        },
      };
      });
    },
    async appendAttachment({ attachment, auditEntries = [], operator: _operator, now }) {
      return withFileLock(indexFilePath(), () => {
        const subjectKey = assertSafeSubjectKey(attachment.subjectKey);
        const versions = readVersions(operatorDir, subjectKey);
        // 商品级附属证据必须绑定已存在的商品版本；查询级主体（SellerSprite 类目/seedKeyword
        // 查询）没有商品版本，允许在同主体目录下独立保存，且不产生任何商品版本。
        if (versions.length === 0 && parseSellerSpriteQuerySubjectKey(subjectKey) === null) {
          throw new EvidenceStoreError("evidence_subject_invalid", "附属证据必须绑定到已存在的商品来源证据。");
        }
        const existing = readAttachments(operatorDir, subjectKey);
        const duplicateOf = existing.find(
          (item) => item.kind === attachment.kind && item.contentHash === attachment.contentHash,
        ) ?? null;
        const baseAudit = readAudit(operatorDir, subjectKey);
        const withAttachmentAudit = appendAuditEntry(baseAudit, {
          eventKind: "evidence_attachment_persisted",
          reason: duplicateOf ? `重复附属证据，复用 ${duplicateOf.attachmentId}` : "附属证据持久化",
          timestamp: now.toISOString(),
          captureId: attachment.attachmentId,
          subjectKey,
          operator: _operator,
          detail: {
            kind: attachment.kind,
            contentHash: attachment.contentHash,
            duplicate: duplicateOf !== null,
          },
        });
        const merged = appendAuditEntries(withAttachmentAudit, auditEntries);
        const trimmed = merged.length > MAX_AUDIT_FILE_ENTRIES
          ? merged.slice(merged.length - MAX_AUDIT_FILE_ENTRIES)
          : merged;
        if (trimmed.length === 0) {
          throw new EvidenceStoreError("evidence_store_invalid", "附属证据审计条目缺失，已 fail-closed。");
        }
        writeJsonAtomic(auditPath(operatorDir, subjectKey), trimmed);
        if (duplicateOf) {
          return { subjectKey, created: false, duplicate: true, attachment: duplicateOf };
        }
        writeJsonAtomic(
          resolve(subjectDir(operatorDir, subjectKey), sourceEvidenceAttachmentFileName(attachment.contentHash)),
          attachment,
        );
        return { subjectKey, created: true, duplicate: false, attachment };
      });
    },

    async appendCategoryMarketCapture({ subjectKey, batch, operator: _operator, now }) {
      return withFileLock(indexFilePath(), () => {
        const safeSubjectKey = assertSafeSubjectKey(subjectKey);
        assertCategoryMarketCaptureBatch(batch);
        if (!isCategoryMarketSubjectKey(safeSubjectKey)
          || categoryMarketSubjectKey(batch.category.nodeId) !== safeSubjectKey) {
          throw new EvidenceStoreError("evidence_subject_key_mismatch", "类目市场快照与主体键不匹配。");
        }
        if (Number.isNaN(now.getTime())) {
          throw new EvidenceStoreError("evidence_subject_invalid", "类目市场快照采集时间不合法。");
        }

        const contentHash = contentHashOf({ subjectKey: safeSubjectKey, batch });
        const filePath = categoryMarketCaptureFilePath(operatorDir, safeSubjectKey, contentHash);
        const existing = readCategoryMarketCaptures(operatorDir, safeSubjectKey);
        const duplicate = existing.find((item) => item.batchId === batch.batchId) ?? null;
        if (duplicate && contentHashOf({ subjectKey: safeSubjectKey, batch: duplicate }) !== contentHash) {
          throw new EvidenceStoreError("evidence_content_hash_mismatch", "类目市场批次标识已绑定到不同内容。");
        }
        if (!duplicate) {
          writeJsonAtomic(filePath, {
            schemaVersion: "source-category-market-capture.v1",
            subjectKey: safeSubjectKey,
            contentHash,
            batch,
          });
        }
        const nextAudit = appendAuditEntry(readAudit(operatorDir, safeSubjectKey), {
          eventKind: "evidence_attachment_persisted",
          reason: duplicate ? "重复类目市场快照，复用已保存批次" : "类目市场机会快照持久化",
          timestamp: now.toISOString(),
          captureId: batch.batchId,
          subjectKey: safeSubjectKey,
          operator: _operator,
          module: "EVIDENCE_STORE",
          phase: "persist",
          eventType: "category_market_capture_persisted",
          severity: "info",
          sourceType: "sellersprite_plugin",
          evidenceRefs: [batch.batchId, `category-market:${contentHash}`],
          contentHash,
          detail: {
            kind: "sellersprite_category_market_capture_v1",
            rowCount: batch.rowCount,
            duplicate: duplicate !== null,
            amazonConfirmed: false,
          },
        });
        writeJsonAtomic(auditPath(operatorDir, safeSubjectKey), nextAudit.slice(-MAX_AUDIT_FILE_ENTRIES));
        return {
          subjectKey: safeSubjectKey,
          created: duplicate === null,
          duplicate: duplicate !== null,
          contentHash,
          batch: duplicate ?? batch,
        };
      });
    },

    async appendRawArtifact({ artifact, bytes, operator: _operator, now }) {
      void _operator;
      return withFileLock(indexFilePath(), () => {
        const subjectKey = assertSafeSubjectKey(artifact.subjectKey);
        const versions = readVersions(operatorDir, subjectKey);
        // 与附属证据同一规则：查询级主体可保存原始来源文件，商品级主体必须已有商品版本。
        if (versions.length === 0 && parseSellerSpriteQuerySubjectKey(subjectKey) === null) {
          throw new EvidenceStoreError("evidence_subject_invalid", "原始来源文件必须绑定到已存在的商品来源证据。");
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.byteLength) {
          throw new EvidenceStoreError("evidence_content_hash_mismatch", "原始来源文件大小与元数据不一致。");
        }
        if (sha256OfRawArtifact(bytes) !== artifact.sha256) {
          throw new EvidenceStoreError("evidence_content_hash_mismatch", "原始来源文件内容指纹与元数据不一致。");
        }
        const existing = readRawArtifacts(operatorDir, subjectKey);
        const duplicateOf = existing.find((item) => item.sha256 === artifact.sha256) ?? null;
        if (duplicateOf) {
          return { subjectKey, created: false, duplicate: true, artifact: duplicateOf };
        }
        const baseAudit = readAudit(operatorDir, subjectKey);
        const nextAudit = appendAuditEntry(baseAudit, {
          eventKind: "evidence_attachment_persisted",
          reason: "原始来源下载/导出文件持久化",
          timestamp: now.toISOString(),
          subjectKey,
          operator: operatorDir,
          module: "EVIDENCE_STORE",
          phase: "persist",
          eventType: "raw_artifact_persisted",
          severity: "info",
          sourceType: artifact.sourceType,
          recipeVersion: artifact.provenance.parserVersion,
          evidenceRefs: [artifact.artifactId, `raw:${artifact.sha256}`],
          contentHash: artifact.sha256,
          detail: {
            artifactKind: artifact.kind,
            format: artifact.format,
            byteLength: artifact.byteLength,
            acquisitionMode: artifact.provenance.acquisitionMode,
          },
        });
        writeJsonAtomic(auditPath(operatorDir, subjectKey), nextAudit.slice(-MAX_AUDIT_FILE_ENTRIES));
        writeBinaryAtomic(resolve(subjectDir(operatorDir, subjectKey), artifact.storageFileName), bytes);
        writeJsonAtomic(
          resolve(subjectDir(operatorDir, subjectKey), rawArtifactMetadataFileNameFor(artifact.sha256)),
          artifact,
        );
        return { subjectKey, created: true, duplicate: false, artifact };
      });
    },
  };
}

function trendDirectory(operator: string, subjectKey: string): string {
  return resolve(subjectDir(operator, subjectKey), "trend");
}

function trendFilePath(operator: string, subjectKey: string, dedupeKey: string): string {
  return resolve(trendDirectory(operator, subjectKey), `t-${dedupeKey}.json`);
}

function readTrendObservations(operator: string, subjectKey: string): TrendObservation[] {
  const directory = trendDirectory(operator, subjectKey);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^t-[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => {
      const parsed = parseTrendObservation(readJson(resolve(directory, name)));
      if (!parsed || parsed.subjectKey !== subjectKey) {
        throw new EvidenceStoreError("evidence_store_invalid", "趋势观测文件不合法，已 fail-closed。");
      }
      return parsed;
    });
}
