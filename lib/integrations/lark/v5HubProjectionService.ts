import "server-only";
import { createHash } from "node:crypto";

import type { LarkConfig } from "./types";
import {
  LarkApiError,
  batchCreateRecords,
  batchUpdateRecords,
  listTableFields,
  readBitableTextValue,
  searchTableRecords,
} from "./baseClient";
import { decideHubRecordMatch, HubDuplicateKeyError } from "./v5HubMatching";
import { V5_HUB_TABLES, validateV5HubRemoteSchema, v5HubLogicalKeyFromDisplayFields, type HubTableContract } from "./v5HubSchema";

import {
  getV5HubConfig,
  V5_HUB_AUTHORIZED_TEST_BASE_ID,
  V5_HUB_TEST_BASE_TABLE_IDS,
} from "./v5HubConfig";
export { V5_HUB_AUTHORIZED_TEST_BASE_ID, V5_HUB_TEST_BASE_TABLE_IDS };
type V5HubTableId = HubTableContract["id"];
const V5_HUB_CLIENT_TOKEN_NAMESPACE = "ab7f3d7e-2d83-5d5f-a365-49f80a6c39d2";

export type V5HubProjectionResult =
  | { readonly status: "CREATED"; readonly recordId: string }
  | { readonly status: "UPDATED"; readonly recordId: string }
  | { readonly status: "UNCHANGED"; readonly recordId: string };

export type V5HubProjectionRow = {
  readonly logicalKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

export class V5HubProjectionError extends Error {
  constructor(
    public readonly code:
      | "V5_HUB_WRONG_BASE"
      | "V5_HUB_SCHEMA_DRIFT"
      | "V5_HUB_DUPLICATE_LOGICAL_KEY"
      | "V5_HUB_IMMUTABLE_PACKET_CONFLICT"
      | "V5_HUB_IMMUTABLE_RECORD_CONFLICT"
      | "V5_HUB_WRITE_READBACK_MISMATCH"
      | "V5_HUB_API_REJECTED"
      | "V5_HUB_WRITE_RESULT_UNKNOWN",
    public readonly upstreamCode?: string,
    public readonly upstreamStatus?: number,
    public readonly larkCode?: number,
    public readonly upstreamMessage?: string,
  ) {
    super([code, upstreamCode, upstreamStatus, larkCode, upstreamMessage].filter((value) => value !== undefined).join(":"));
    this.name = "V5HubProjectionError";
  }
}

type HubFilterCondition = { readonly field_name: string; readonly operator: "is"; readonly value: readonly string[] };

function projectionKeyConditions(table: HubTableContract, payload: Record<string, unknown>): HubFilterCondition[] {
  return table.logicalUniqueKey.map((key) => {
    const field = table.fields.find((candidate) => candidate.name === key);
    if (!field) throw new Error(`V5_HUB_UNIQUE_KEY_NOT_ALLOWLISTED:${table.id}:${key}`);
    const value = payload[field.displayName];
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
      throw new Error(`V5_HUB_PROJECTION_KEY_MISSING:${table.id}:${key}`);
    }
    return { field_name: field.displayName, operator: "is", value: [String(value)] };
  });
}

function logicalKeyValue(conditions: readonly HubFilterCondition[]): string {
  return conditions.length === 1
    ? conditions[0].value[0]
    : JSON.stringify(conditions.map(({ field_name, value }) => [field_name, value[0]]));
}

/** Composite keys are stable ordered JSON tuples in the contract's declared key order. */
export function v5HubLogicalKey(tableId: V5HubTableId, fields: Readonly<Record<string, unknown>>): string {
  return v5HubLogicalKeyFromDisplayFields(tableId, fields);
}

function sameProjection(existing: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([fieldName, value]) => {
    const actual = existing[fieldName];
    if (typeof value === "string") {
      if (typeof actual === "number" && !Number.isNaN(Date.parse(value))) {
        return new Date(actual).toISOString() === new Date(value).toISOString();
      }
      return readBitableTextValue(actual) === value;
    }
    return JSON.stringify(actual ?? null) === JSON.stringify(value ?? null);
  });
}

function sameProjectionExcept(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>,
  mutableField: string,
): boolean {
  const immutableExpected = Object.fromEntries(Object.entries(expected).filter(([name]) => name !== mutableField));
  return sameProjection(existing, immutableExpected);
}

function addProjectionRecordName(tableId: V5HubTableId, payload: Record<string, unknown>, logicalKey: string): void {
  const prefix: Readonly<Record<V5HubTableId, string>> = {
    T01: "商品",
    T02: "研究包",
    T03: "买家声音",
    T04: "关键词",
    T05: "产品概念",
    T06: "监控事件",
  };
  const identity = payload["ASIN"] ?? payload["主体键"] ?? logicalKey;
  const recordName = tableId === "T02"
    ? `${prefix[tableId]} ${String(payload["ASIN"] ?? "")} r${String(payload["修订版本"] ?? "")}`
    : `${prefix[tableId]} ${String(identity)}`;
  payload["记录名称"] = recordName.trim();
}

function deterministicClientToken(name: string): string {
  const namespaceBytes = Buffer.from(V5_HUB_CLIENT_TOKEN_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MAX_PROJECTION_BATCH_SIZE = 50;

/**
 * Read-only recovery for a stale operation receipt. It returns results only
 * when every allowlisted logical key has exactly one row and the complete
 * projected payload already matches. It never creates or updates records.
 */
export async function reconcileV5HubRecordsReadOnly(input: {
  readonly config: LarkConfig;
  readonly tableId: V5HubTableId;
  readonly rows: readonly V5HubProjectionRow[];
}): Promise<readonly V5HubProjectionResult[] | null> {
  const hubConfig = getV5HubConfig();
  if (input.config.appToken !== hubConfig.baseId) throw new V5HubProjectionError("V5_HUB_WRONG_BASE");
  if (input.rows.length === 0) return [];
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === input.tableId);
  if (!table) throw new Error("V5_HUB_PROJECTION_TABLE_MISSING");
  const remoteTableId = hubConfig.tables[input.tableId];
  const schema = await listTableFields({ ...input.config, tableId: remoteTableId });
  if (!validateV5HubRemoteSchema(input.tableId, schema).isValid) throw new V5HubProjectionError("V5_HUB_SCHEMA_DRIFT");

  const seenKeys = new Set<string>();
  const results: V5HubProjectionResult[] = [];
  for (const row of input.rows) {
    if (!row.logicalKey.trim() || seenKeys.has(row.logicalKey)) return null;
    seenKeys.add(row.logicalKey);
    const payload = { ...row.fields } as Record<string, unknown>;
    const filterConditions = projectionKeyConditions(table, payload);
    if (logicalKeyValue(filterConditions) !== row.logicalKey) return null;
    addProjectionRecordName(input.tableId, payload, row.logicalKey);
    const matches = await searchTableRecords({ ...input.config, tableId: remoteTableId }, {
      fieldNames: Object.keys(payload),
      filter: { conjunction: "and", conditions: filterConditions },
      pageSize: 100,
    });
    if (matches.length !== 1 || !sameProjection(matches[0].fields, payload)) return null;
    results.push({ status: "UNCHANGED", recordId: matches[0].record_id });
  }
  return results;
}

/**
 * Batch projection for the explicitly authorized Test Base. It preflights the
 * complete input set before any write, serializes writes by table, and reads
 * every logical key back before reporting success.
 */
export async function projectV5HubRecords(input: {
  readonly config: LarkConfig;
  readonly tableId: V5HubTableId;
  readonly rows: readonly V5HubProjectionRow[];
  readonly batchSize?: number;
}): Promise<readonly V5HubProjectionResult[]> {
  const hubConfig = getV5HubConfig();
  if (input.config.appToken !== hubConfig.baseId) {
    throw new V5HubProjectionError("V5_HUB_WRONG_BASE");
  }
  if (input.rows.length === 0) return [];
  const batchSize = input.batchSize ?? MAX_PROJECTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_PROJECTION_BATCH_SIZE) {
    throw new Error("V5_HUB_BATCH_SIZE_INVALID");
  }
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === input.tableId);
  if (!table) throw new Error("V5_HUB_PROJECTION_TABLE_MISSING");
  const remoteTableId = hubConfig.tables[input.tableId];
  const schema = await listTableFields({ ...input.config, tableId: remoteTableId });
  const schemaReadback = validateV5HubRemoteSchema(input.tableId, schema);
  if (!schemaReadback.isValid) throw new V5HubProjectionError("V5_HUB_SCHEMA_DRIFT");
  const seenKeys = new Set<string>();
  const prepared: Array<{
    readonly logicalKey: string;
    readonly payload: Record<string, unknown>;
    readonly existingRecordId: string | null;
    readonly initialResult: V5HubProjectionResult | null;
    readonly filterConditions: readonly HubFilterCondition[];
  }> = [];

  // Read and validate every key before the first remote write.
  for (const row of input.rows) {
    if (!row.logicalKey.trim()) throw new Error("V5_HUB_PROJECTION_IDENTITY_MISSING");
    if (seenKeys.has(row.logicalKey)) throw new V5HubProjectionError("V5_HUB_DUPLICATE_LOGICAL_KEY");
    seenKeys.add(row.logicalKey);
    const payload = { ...row.fields } as Record<string, unknown>;
    const filterConditions = projectionKeyConditions(table, payload);
    if (logicalKeyValue(filterConditions) !== row.logicalKey) throw new Error("V5_HUB_PROJECTION_KEY_MISMATCH");
    addProjectionRecordName(input.tableId, payload, row.logicalKey);

    const matches = await searchTableRecords({ ...input.config, tableId: remoteTableId }, {
      fieldNames: Object.keys(payload),
      filter: { conjunction: "and", conditions: filterConditions },
      pageSize: 100,
    });
    let match: ReturnType<typeof decideHubRecordMatch>;
    try {
      match = decideHubRecordMatch(matches);
    } catch (error) {
      if (error instanceof HubDuplicateKeyError) throw new V5HubProjectionError("V5_HUB_DUPLICATE_LOGICAL_KEY");
      throw error;
    }

    if (match.action === "update") {
      if (sameProjection(matches[0].fields, payload)) {
        prepared.push({ logicalKey: row.logicalKey, payload, existingRecordId: match.recordId, initialResult: { status: "UNCHANGED", recordId: match.recordId }, filterConditions });
      } else if (input.tableId === "T02") {
        throw new V5HubProjectionError("V5_HUB_IMMUTABLE_PACKET_CONFLICT");
      } else if (input.tableId === "T05" && sameProjectionExcept(matches[0].fields, payload, "人工决策状态")) {
        // The T05 content/version remains immutable; only the mirror of an
        // already accepted local Human Decision may advance on this revision.
        prepared.push({ logicalKey: row.logicalKey, payload, existingRecordId: match.recordId, initialResult: null, filterConditions });
      } else if (input.tableId !== "T01" && input.tableId !== "T04") {
        throw new V5HubProjectionError("V5_HUB_IMMUTABLE_RECORD_CONFLICT");
      } else {
        prepared.push({ logicalKey: row.logicalKey, payload, existingRecordId: match.recordId, initialResult: null, filterConditions });
      }
    } else {
      prepared.push({ logicalKey: row.logicalKey, payload, existingRecordId: null, initialResult: null, filterConditions });
    }
  }

  const output = new Array<V5HubProjectionResult>(prepared.length);
  prepared.forEach((row, index) => { if (row.initialResult) output[index] = row.initialResult; });
  const toUpdate = prepared.map((row, index) => ({ ...row, index })).filter((row) => row.existingRecordId && !row.initialResult);
  const toCreate = prepared.map((row, index) => ({ ...row, index })).filter((row) => !row.existingRecordId);

  for (const chunk of chunkProjectionRows(toUpdate, batchSize)) {
    const writeRows = chunk.map((row) => ({ record_id: row.existingRecordId!, fields: row.payload }));
    try {
      await batchUpdateRecords({ ...input.config, tableId: remoteTableId }, writeRows, {
        clientToken: deterministicClientToken(`${input.config.appToken}:${input.tableId}:update:${JSON.stringify(chunk.map(({ logicalKey, payload }) => [logicalKey, payload]))}`),
        maxRetries: 0,
      });
    } catch (error) {
      const reconciled = await reconcileChunk(input, remoteTableId, chunk, "UPDATED");
      if (!reconciled) throw projectionWriteError(error);
      for (const row of chunk) output[row.index] = reconciled.get(row.logicalKey)!;
      continue;
    }
    const reconciled = await reconcileChunk(input, remoteTableId, chunk, "UPDATED");
    if (!reconciled) throw new V5HubProjectionError("V5_HUB_WRITE_READBACK_MISMATCH");
    for (const row of chunk) output[row.index] = reconciled.get(row.logicalKey)!;
  }

  for (const chunk of chunkProjectionRows(toCreate, batchSize)) {
    let created: Awaited<ReturnType<typeof batchCreateRecords>>;
    try {
      created = await batchCreateRecords({ ...input.config, tableId: remoteTableId }, chunk.map((row) => ({ fields: row.payload })), {
        clientToken: deterministicClientToken(`${input.config.appToken}:${input.tableId}:create:${JSON.stringify(chunk.map(({ logicalKey, payload }) => [logicalKey, payload]))}`),
        maxRetries: 0,
      });
    } catch (error) {
      const reconciled = await reconcileChunk(input, remoteTableId, chunk, "CREATED");
      if (!reconciled) throw projectionWriteError(error);
      for (const row of chunk) output[row.index] = reconciled.get(row.logicalKey)!;
      continue;
    }
    if (created.length !== chunk.length) throw new V5HubProjectionError("V5_HUB_WRITE_READBACK_MISMATCH");
    const reconciled = await reconcileChunk(input, remoteTableId, chunk, "CREATED");
    if (!reconciled) throw new V5HubProjectionError("V5_HUB_WRITE_READBACK_MISMATCH");
    for (const row of chunk) output[row.index] = reconciled.get(row.logicalKey)!;
  }
  return output;
}

/** Single-row convenience entry point; it shares the exact batch safeguards. */
export async function projectV5HubRecord(input: {
  readonly config: LarkConfig;
  readonly tableId: V5HubTableId;
  readonly logicalKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
}): Promise<V5HubProjectionResult> {
  const [result] = await projectV5HubRecords({
    config: input.config,
    tableId: input.tableId,
    rows: [{ logicalKey: input.logicalKey, fields: input.fields }],
  });
  return result;
}

function chunkProjectionRows<T>(rows: readonly T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) chunks.push(rows.slice(index, index + batchSize));
  return chunks;
}

async function reconcileChunk<T extends { readonly logicalKey: string; readonly payload: Record<string, unknown>; readonly index: number }>(
  input: { readonly config: LarkConfig; readonly tableId: V5HubTableId },
  remoteTableId: string,
  chunk: readonly T[],
  action: "CREATED" | "UPDATED",
): Promise<Map<string, V5HubProjectionResult> | null> {
  const results = new Map<string, V5HubProjectionResult>();
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === input.tableId);
  if (!table) return null;
  for (const row of chunk) {
    let matches;
    try {
      matches = await searchTableRecords({ ...input.config, tableId: remoteTableId }, {
        fieldNames: Object.keys(row.payload),
        filter: { conjunction: "and", conditions: projectionKeyConditions(table, row.payload) },
        pageSize: 100,
      });
    } catch {
      return null;
    }
    if (!Array.isArray(matches)) return null;
    if (matches.length !== 1 || !sameProjection(matches[0].fields, row.payload)) return null;
    results.set(row.logicalKey, { status: action, recordId: matches[0].record_id });
  }
  return results;
}

function projectionWriteError(error: unknown): V5HubProjectionError {
  if (error instanceof LarkApiError) {
    const isExplicitRejection = error.code.startsWith("lark_api_failed_");
    return new V5HubProjectionError(
      isExplicitRejection ? "V5_HUB_API_REJECTED" : "V5_HUB_WRITE_RESULT_UNKNOWN",
      error.code,
      error.status,
      error.larkCode,
      sanitizeUpstreamMessage(error.message),
    );
  }
  return new V5HubProjectionError("V5_HUB_WRITE_RESULT_UNKNOWN");
}

function sanitizeUpstreamMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/("(?:app_secret|tenant_access_token|access_token|token)"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .slice(0, 400);
}
