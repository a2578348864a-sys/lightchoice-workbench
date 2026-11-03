import "server-only";

import { randomUUID } from "node:crypto";

import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import {
  batchCreateRecords,
  batchUpdateRecords,
  listTableFields,
  readBitableTextValue,
  searchTableRecords,
  type LarkBitableRecord,
  type LarkClientOptions,
} from "./baseClient";
import { getLarkCommodityPoolConfig } from "./config";
import {
  COMMODITY_POOL_FACT_FIELDS,
  COMMODITY_POOL_DECISION_FIELDS,
  mapCommodityDecisionToRow,
  mapProductFactToCommodityRow,
  validateCommodityPoolFields,
  type CommodityDecisionRow,
  type CommodityPoolRow,
} from "./commodityTableContract";
import type { LarkConfig, LarkFieldMeta } from "./types";

export const COMMODITY_SYNC_CHUNK_SIZE = 50 as const;
export const COMMODITY_SUBJECT_KEY_PATTERN = /^amazon:[A-Za-z0-9_-]{1,16}:[A-Z0-9]{10}$/u;

export type CommoditySyncAction = "created" | "updated" | "skipped" | "conflict" | "failed";

export type CommoditySyncRecordResult = {
  readonly subjectKey: string;
  readonly action: CommoditySyncAction;
  readonly recordId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type CommoditySyncBatchResult = {
  readonly total: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly conflictCount: number;
  readonly failedCount: number;
  readonly results: readonly CommoditySyncRecordResult[];
  readonly syncedAt: string;
  readonly requestClientToken: string;
};

export type CommoditySyncCandidate = {
  readonly subjectKey: string;
  readonly rowFields: CommodityPoolRow;
};

export type CommoditySyncPlan = {
  readonly toCreate: readonly CommoditySyncCandidate[];
  readonly toUpdate: readonly (CommoditySyncCandidate & { readonly recordId: string })[];
  readonly duplicateSubjectKeys: readonly { readonly subjectKey: string; readonly matchCount: number }[];
};

export type CommodityDecisionSyncInput = {
  readonly subjectKey: string;
  readonly decision: CommodityDecisionRow;
};

export type CommodityDecisionSyncCandidate = {
  readonly subjectKey: string;
  /** 创建时带 subjectKey；更新时由 pickDecisionFields 严格裁剪。 */
  readonly rowFields: CommodityPoolRow;
};

export type CommodityDecisionSyncPlan = {
  readonly toCreate: readonly CommodityDecisionSyncCandidate[];
  readonly toUpdate: readonly (CommodityDecisionSyncCandidate & { readonly recordId: string })[];
  readonly duplicateSubjectKeys: readonly { readonly subjectKey: string; readonly matchCount: number }[];
};

export type CommodityPoolPreflightResult = {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly tableAccessible: boolean;
  readonly writable: boolean;
  readonly appToken?: string;
  readonly tableId?: string;
  readonly missingFields: readonly string[];
  readonly missingWriteFields: readonly string[];
  readonly missingOptionalFields: readonly string[];
  readonly incompatibleFields: readonly {
    readonly fieldName: string;
    readonly expectedType: string;
    readonly actualType: string;
  }[];
  readonly fieldMapping: Record<string, LarkFieldMeta>;
  readonly missingConfigKeys?: readonly string[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type CommoditySyncAuditEntry = {
  readonly event: "conflict" | "lookup_failed" | "create_failed" | "update_failed";
  readonly subjectKey?: string;
  readonly matchCount?: number;
  readonly errorCode?: string;
};

export type BatchCommoditySyncOptions = {
  readonly config?: LarkConfig;
  readonly clientOptions?: LarkClientOptions;
  readonly baseUrl?: string;
  readonly qualityStatus?: string;
  readonly requestClientToken?: string;
  readonly auditLogger?: (entry: CommoditySyncAuditEntry) => void;
};

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function pickFactFields(row: CommodityPoolRow): Record<string, unknown> {
  return Object.fromEntries(
    COMMODITY_POOL_FACT_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(row, field))
      .map((field) => [field, row[field]]),
  );
}

function pickDecisionFields(row: CommodityPoolRow): Record<string, unknown> {
  return Object.fromEntries(
    COMMODITY_POOL_DECISION_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(row, field))
      .map((field) => [field, row[field]]),
  );
}

/** 将远端 records/search 结果转换为 0/1/>1 的 fail-closed 计划。 */
export function planCommoditySyncRecords(
  candidates: readonly CommoditySyncCandidate[],
  existingRecords: readonly LarkBitableRecord[],
): CommoditySyncPlan {
  const recordsBySubjectKey = new Map<string, LarkBitableRecord[]>();
  for (const record of existingRecords) {
    const subjectKey = readBitableTextValue(record.fields.subjectKey);
    if (!subjectKey) continue;
    const records = recordsBySubjectKey.get(subjectKey) ?? [];
    records.push(record);
    recordsBySubjectKey.set(subjectKey, records);
  }

  const toCreate: CommoditySyncCandidate[] = [];
  const toUpdate: (CommoditySyncCandidate & { readonly recordId: string })[] = [];
  const duplicateSubjectKeys: { subjectKey: string; matchCount: number }[] = [];
  for (const candidate of candidates) {
    const matches = recordsBySubjectKey.get(candidate.subjectKey) ?? [];
    if (matches.length > 1) {
      duplicateSubjectKeys.push({ subjectKey: candidate.subjectKey, matchCount: matches.length });
    } else if (matches.length === 1) {
      toUpdate.push({ ...candidate, recordId: matches[0].record_id });
    } else {
      toCreate.push(candidate);
    }
  }
  return { toCreate, toUpdate, duplicateSubjectKeys };
}

/** 决策回写沿用同一 subjectKey 查重规则，但更新字段严格限制为决策列。 */
export function planCommodityDecisionSyncRecords(
  candidates: readonly CommodityDecisionSyncCandidate[],
  existingRecords: readonly LarkBitableRecord[],
): CommodityDecisionSyncPlan {
  const recordsBySubjectKey = new Map<string, LarkBitableRecord[]>();
  for (const record of existingRecords) {
    const subjectKey = readBitableTextValue(record.fields.subjectKey);
    if (!subjectKey) continue;
    const records = recordsBySubjectKey.get(subjectKey) ?? [];
    records.push(record);
    recordsBySubjectKey.set(subjectKey, records);
  }

  const toCreate: CommodityDecisionSyncCandidate[] = [];
  const toUpdate: (CommodityDecisionSyncCandidate & { readonly recordId: string })[] = [];
  const duplicateSubjectKeys: { subjectKey: string; matchCount: number }[] = [];
  for (const candidate of candidates) {
    const matches = recordsBySubjectKey.get(candidate.subjectKey) ?? [];
    if (matches.length > 1) {
      duplicateSubjectKeys.push({ subjectKey: candidate.subjectKey, matchCount: matches.length });
    } else if (matches.length === 1) {
      toUpdate.push({ ...candidate, recordId: matches[0].record_id });
    } else {
      toCreate.push(candidate);
    }
  }
  return { toCreate, toUpdate, duplicateSubjectKeys };
}

function defaultAuditLogger(entry: CommoditySyncAuditEntry): void {
  // 只记录业务主键和错误类别，不记录凭证、响应正文或商品整行数据。
  console.warn("[feishu commodity sync]", entry);
}

export class LarkCommodityPoolDestination {
  constructor(
    private readonly customConfig?: LarkConfig,
    private readonly clientOptions: LarkClientOptions = {},
    private readonly auditLogger: (entry: CommoditySyncAuditEntry) => void = defaultAuditLogger,
  ) {}

  private resolveConfig():
    | { readonly ok: true; readonly config: LarkConfig }
    | { readonly ok: false; readonly missingKeys: readonly string[] } {
    if (this.customConfig) return { ok: true, config: this.customConfig };
    return getLarkCommodityPoolConfig();
  }

  async preflight(): Promise<CommodityPoolPreflightResult> {
    const configResult = this.resolveConfig();
    if (!configResult.ok) {
      return {
        configured: false,
        connected: false,
        tableAccessible: false,
        writable: false,
        missingFields: [],
        missingWriteFields: [],
        missingOptionalFields: [],
        incompatibleFields: [],
        fieldMapping: {},
        missingConfigKeys: configResult.missingKeys,
        errorCode: "LARK_CONFIG_MISSING",
        errorMessage: `飞书配置缺失: ${configResult.missingKeys.join(", ")}`,
      };
    }

    try {
      const remoteFields = await listTableFields(configResult.config, this.clientOptions);
      const validation = validateCommodityPoolFields(remoteFields);
      return {
        configured: true,
        connected: true,
        tableAccessible: true,
        writable: validation.isValid,
        appToken: configResult.config.appToken,
        tableId: configResult.config.tableId,
        missingFields: validation.missingRequiredFields,
        missingWriteFields: validation.missingWriteFields,
        missingOptionalFields: validation.missingOptionalFields,
        incompatibleFields: validation.incompatibleFields,
        fieldMapping: validation.fieldMapping,
        errorCode: validation.isValid ? undefined : "TABLE_FIELDS_MISMATCH",
        errorMessage: validation.isValid
          ? undefined
          : `飞书商品池字段契约不满足，缺少字段: ${validation.missingWriteFields.join(", ") || "无"}`,
      };
    } catch (error) {
      const errorCode = error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "LARK_CONNECTION_FAILED";
      return {
        configured: true,
        connected: false,
        tableAccessible: false,
        writable: false,
        appToken: configResult.config.appToken,
        tableId: configResult.config.tableId,
        missingFields: [],
        missingWriteFields: [],
        missingOptionalFields: [],
        incompatibleFields: [],
        fieldMapping: {},
        errorCode,
        errorMessage: error instanceof Error ? error.message : "无法连接飞书商品池。",
      };
    }
  }

  async sync(
    productFacts: readonly ProductFact[],
    options: Omit<BatchCommoditySyncOptions, "config" | "clientOptions" | "auditLogger"> = {},
  ): Promise<CommoditySyncBatchResult> {
    const syncedAt = new Date().toISOString();
    const requestClientToken = options.requestClientToken ?? randomUUID();
    const candidates: CommoditySyncCandidate[] = productFacts.map((productFact) => ({
      subjectKey: productFact.subjectKey,
      rowFields: mapProductFactToCommodityRow(productFact, {
        baseUrl: options.baseUrl,
        qualityStatus: options.qualityStatus,
      }),
    }));
    const results: CommoditySyncRecordResult[] = [];

    if (!isUuidV4(requestClientToken)) {
      return {
        total: candidates.length,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        conflictCount: 0,
        failedCount: candidates.length,
        results: candidates.map((candidate) => ({
          subjectKey: candidate.subjectKey,
          action: "failed",
          errorCode: "CLIENT_TOKEN_INVALID",
          errorMessage: "请求级 client_token 必须是 UUIDv4。",
        })),
        syncedAt,
        requestClientToken,
      };
    }

    const configResult = this.resolveConfig();
    if (!configResult.ok) {
      return {
        total: candidates.length,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        conflictCount: 0,
        failedCount: candidates.length,
        results: candidates.map((candidate) => ({
          subjectKey: candidate.subjectKey,
          action: "failed",
          errorCode: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS",
          errorMessage: `未配置飞书凭据 (${configResult.missingKeys.join(", ")})，同步已安全拦截。`,
        })),
        syncedAt,
        requestClientToken,
      };
    }

    const preflight = await this.preflight();
    if (!preflight.writable) {
      return {
        total: candidates.length,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        conflictCount: 0,
        failedCount: candidates.length,
        results: candidates.map((candidate) => ({
          subjectKey: candidate.subjectKey,
          action: "failed",
          errorCode: preflight.errorCode ?? "PREFLIGHT_FAILED",
          errorMessage: preflight.errorMessage ?? "飞书商品池预检未通过。",
        })),
        syncedAt,
        requestClientToken,
      };
    }

    let createdCount = 0;
    let updatedCount = 0;
    let conflictCount = 0;
    let clientTokenIndex = 0;
    const batches = chunkArray(candidates, COMMODITY_SYNC_CHUNK_SIZE);

    for (const batch of batches) {
      const invalid = batch.filter((candidate) => !COMMODITY_SUBJECT_KEY_PATTERN.test(candidate.subjectKey));
      for (const candidate of invalid) {
        results.push({
          subjectKey: candidate.subjectKey,
          action: "failed",
          errorCode: "SUBJECT_KEY_INVALID",
          errorMessage: "商品池同步要求 subjectKey 格式为 amazon:<marketplace>:<ASIN>。",
        });
      }
      const valid = batch.filter((candidate) => COMMODITY_SUBJECT_KEY_PATTERN.test(candidate.subjectKey));
      if (valid.length === 0) continue;

      let existingRecords: readonly LarkBitableRecord[];
      try {
        existingRecords = await searchTableRecords(
          configResult.config,
          {
            fieldNames: ["subjectKey"],
            filter: {
              conjunction: "or",
              conditions: valid.map((candidate) => ({
                field_name: "subjectKey",
                operator: "is",
                value: [candidate.subjectKey],
              })),
            },
            pageSize: 500,
          },
          this.clientOptions,
        );
      } catch (error) {
        const errorCode = error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "IDEMPOTENCY_LOOKUP_FAILED";
        this.auditLogger({ event: "lookup_failed", errorCode });
        for (const candidate of valid) {
          results.push({
            subjectKey: candidate.subjectKey,
            action: "failed",
            errorCode: "IDEMPOTENCY_LOOKUP_FAILED",
            errorMessage: error instanceof Error ? error.message : "商品池查重失败，已取消该分片写入。",
          });
        }
        continue;
      }

      const plan = planCommoditySyncRecords(valid, existingRecords);
      for (const duplicate of plan.duplicateSubjectKeys) {
        conflictCount++;
        this.auditLogger({
          event: "conflict",
          subjectKey: duplicate.subjectKey,
          matchCount: duplicate.matchCount,
          errorCode: "DUPLICATE_SUBJECT_KEY_RECORDS",
        });
        results.push({
          subjectKey: duplicate.subjectKey,
          action: "conflict",
          errorCode: "DUPLICATE_SUBJECT_KEY_RECORDS",
          errorMessage: `飞书商品池存在 ${duplicate.matchCount} 条相同 subjectKey 记录，已 fail-closed。`,
        });
      }

      if (plan.toCreate.length > 0) {
        try {
          const response = await batchCreateRecords(
            configResult.config,
            plan.toCreate.map((candidate) => ({ fields: candidate.rowFields as Record<string, unknown> })),
            { ...this.clientOptions, clientToken: clientTokenForChunk(requestClientToken, clientTokenIndex++) },
          );
          if (response.length !== plan.toCreate.length) {
            throw new Error(`飞书批量新增响应数量异常：请求 ${plan.toCreate.length} 条，返回 ${response.length} 条。`);
          }
          plan.toCreate.forEach((candidate, index) => {
            createdCount++;
            results.push({ subjectKey: candidate.subjectKey, action: "created", recordId: response[index].record_id });
          });
        } catch (error) {
          const errorCode = error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "BATCH_CREATE_FAILED";
          this.auditLogger({ event: "create_failed", errorCode });
          for (const candidate of plan.toCreate) {
            results.push({
              subjectKey: candidate.subjectKey,
              action: "failed",
              errorCode: "BATCH_CREATE_FAILED",
              errorMessage: error instanceof Error ? error.message : "飞书批量新增失败。",
            });
          }
        }
      }

      if (plan.toUpdate.length > 0) {
        try {
          const response = await batchUpdateRecords(
            configResult.config,
            plan.toUpdate.map((candidate) => ({
              record_id: candidate.recordId,
              fields: pickFactFields(candidate.rowFields),
            })),
            { ...this.clientOptions, clientToken: clientTokenForChunk(requestClientToken, clientTokenIndex++) },
          );
          if (response.length !== plan.toUpdate.length) {
            throw new Error(`飞书批量更新响应数量异常：请求 ${plan.toUpdate.length} 条，返回 ${response.length} 条。`);
          }
          for (const candidate of plan.toUpdate) {
            updatedCount++;
            results.push({ subjectKey: candidate.subjectKey, action: "updated", recordId: candidate.recordId });
          }
        } catch (error) {
          const errorCode = error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "BATCH_UPDATE_FAILED";
          this.auditLogger({ event: "update_failed", errorCode });
          for (const candidate of plan.toUpdate) {
            results.push({
              subjectKey: candidate.subjectKey,
              action: "failed",
              errorCode: "BATCH_UPDATE_FAILED",
              errorMessage: error instanceof Error ? error.message : "飞书批量更新失败。",
            });
          }
        }
      }
    }

    return {
      total: candidates.length,
      createdCount,
      updatedCount,
      skippedCount: results.filter((result) => result.action === "skipped").length,
      conflictCount,
      failedCount: results.filter((result) => result.action === "failed").length,
      results,
      syncedAt,
      requestClientToken,
    };
  }

  /**
   * 将已保存的人工决定投影到商品池。
   *
   * 这个入口故意不复用事实同步的整行映射：已有行只发送决策列，避免
   * 人工决定写回时覆盖商品事实；没有行时只创建 subjectKey + 决策列，
   * 后续事实同步仍可按同一 subjectKey 补齐其余字段。
   */
  async syncDecisions(
    inputs: readonly CommodityDecisionSyncInput[],
    options: Omit<BatchCommoditySyncOptions, "config" | "clientOptions" | "auditLogger"> = {},
  ): Promise<CommoditySyncBatchResult> {
    const syncedAt = new Date().toISOString();
    const requestClientToken = options.requestClientToken ?? randomUUID();
    const candidates: CommodityDecisionSyncCandidate[] = inputs.map((input) => ({
      subjectKey: input.subjectKey,
      rowFields: {
        subjectKey: input.subjectKey,
        ...mapCommodityDecisionToRow(input.decision),
      },
    }));
    const emptyResult = (errorCode: string, errorMessage: string): CommoditySyncBatchResult => ({
      total: candidates.length,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      conflictCount: 0,
      failedCount: candidates.length,
      results: candidates.map((candidate) => ({
        subjectKey: candidate.subjectKey,
        action: "failed",
        errorCode,
        errorMessage,
      })),
      syncedAt,
      requestClientToken,
    });

    if (!isUuidV4(requestClientToken)) {
      return emptyResult("CLIENT_TOKEN_INVALID", "请求级 client_token 必须是 UUIDv4。");
    }

    const configResult = this.resolveConfig();
    if (!configResult.ok) {
      return emptyResult(
        "LIVE_SYNC_BLOCKED_BY_CREDENTIALS",
        `未配置飞书凭据 (${configResult.missingKeys.join(", ")})，同步已安全拦截。`,
      );
    }

    const preflight = await this.preflight();
    if (!preflight.writable) {
      return emptyResult(
        preflight.errorCode ?? "PREFLIGHT_FAILED",
        preflight.errorMessage ?? "飞书商品池预检未通过。",
      );
    }

    const results: CommoditySyncRecordResult[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let conflictCount = 0;
    let clientTokenIndex = 0;

    for (const batch of chunkArray(candidates, COMMODITY_SYNC_CHUNK_SIZE)) {
      const invalid = batch.filter((candidate) => !COMMODITY_SUBJECT_KEY_PATTERN.test(candidate.subjectKey));
      for (const candidate of invalid) {
        results.push({
          subjectKey: candidate.subjectKey,
          action: "failed",
          errorCode: "SUBJECT_KEY_INVALID",
          errorMessage: "商品池决策回写要求 subjectKey 格式为 amazon:<marketplace>:<ASIN>。",
        });
      }
      const valid = batch.filter((candidate) => COMMODITY_SUBJECT_KEY_PATTERN.test(candidate.subjectKey));
      if (valid.length === 0) continue;

      let existingRecords: readonly LarkBitableRecord[];
      try {
        existingRecords = await searchTableRecords(
          configResult.config,
          {
            fieldNames: ["subjectKey"],
            filter: {
              conjunction: "or",
              conditions: valid.map((candidate) => ({
                field_name: "subjectKey",
                operator: "is",
                value: [candidate.subjectKey],
              })),
            },
            pageSize: 500,
          },
          this.clientOptions,
        );
      } catch (error) {
        const errorCode = error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "IDEMPOTENCY_LOOKUP_FAILED";
        this.auditLogger({ event: "lookup_failed", errorCode });
        for (const candidate of valid) {
          results.push({
            subjectKey: candidate.subjectKey,
            action: "failed",
            errorCode: "IDEMPOTENCY_LOOKUP_FAILED",
            errorMessage: error instanceof Error ? error.message : "商品池查重失败，已取消该分片写入。",
          });
        }
        continue;
      }

      const plan = planCommodityDecisionSyncRecords(valid, existingRecords);
      for (const duplicate of plan.duplicateSubjectKeys) {
        conflictCount++;
        this.auditLogger({
          event: "conflict",
          subjectKey: duplicate.subjectKey,
          matchCount: duplicate.matchCount,
          errorCode: "DUPLICATE_SUBJECT_KEY_RECORDS",
        });
        results.push({
          subjectKey: duplicate.subjectKey,
          action: "conflict",
          errorCode: "DUPLICATE_SUBJECT_KEY_RECORDS",
          errorMessage: `飞书商品池存在 ${duplicate.matchCount} 条相同 subjectKey 记录，已 fail-closed。`,
        });
      }

      if (plan.toCreate.length > 0) {
        try {
          const response = await batchCreateRecords(
            configResult.config,
            plan.toCreate.map((candidate) => ({ fields: candidate.rowFields as Record<string, unknown> })),
            { ...this.clientOptions, clientToken: clientTokenForChunk(requestClientToken, clientTokenIndex++) },
          );
          if (response.length !== plan.toCreate.length) {
            throw new Error(`飞书批量新增响应数量异常：请求 ${plan.toCreate.length} 条，返回 ${response.length} 条。`);
          }
          plan.toCreate.forEach((candidate, index) => {
            createdCount++;
            results.push({ subjectKey: candidate.subjectKey, action: "created", recordId: response[index].record_id });
          });
        } catch (error) {
          const errorCode = error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "BATCH_CREATE_FAILED";
          this.auditLogger({ event: "create_failed", errorCode });
          for (const candidate of plan.toCreate) {
            results.push({
              subjectKey: candidate.subjectKey,
              action: "failed",
              errorCode: "BATCH_CREATE_FAILED",
              errorMessage: error instanceof Error ? error.message : "飞书批量新增失败。",
            });
          }
        }
      }

      if (plan.toUpdate.length > 0) {
        try {
          const response = await batchUpdateRecords(
            configResult.config,
            plan.toUpdate.map((candidate) => ({
              record_id: candidate.recordId,
              fields: pickDecisionFields(candidate.rowFields),
            })),
            { ...this.clientOptions, clientToken: clientTokenForChunk(requestClientToken, clientTokenIndex++) },
          );
          if (response.length !== plan.toUpdate.length) {
            throw new Error(`飞书批量更新响应数量异常：请求 ${plan.toUpdate.length} 条，返回 ${response.length} 条。`);
          }
          for (const candidate of plan.toUpdate) {
            updatedCount++;
            results.push({ subjectKey: candidate.subjectKey, action: "updated", recordId: candidate.recordId });
          }
        } catch (error) {
          const errorCode = error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "BATCH_UPDATE_FAILED";
          this.auditLogger({ event: "update_failed", errorCode });
          for (const candidate of plan.toUpdate) {
            results.push({
              subjectKey: candidate.subjectKey,
              action: "failed",
              errorCode: "BATCH_UPDATE_FAILED",
              errorMessage: error instanceof Error ? error.message : "飞书批量更新失败。",
            });
          }
        }
      }
    }

    return {
      total: candidates.length,
      createdCount,
      updatedCount,
      skippedCount: results.filter((result) => result.action === "skipped").length,
      conflictCount,
      failedCount: results.filter((result) => result.action === "failed").length,
      results,
      syncedAt,
      requestClientToken,
    };
  }
}

function clientTokenForChunk(requestToken: string, chunkIndex: number): string {
  // 第一个写请求沿用调用方 token，后续分片各自使用 UUID；每次 HTTP 重试
  // 都复用传给 baseClient 的同一个 token。
  return chunkIndex === 0 ? requestToken : randomUUID();
}

export async function syncBatchCommodityFacts(
  productFacts: readonly ProductFact[],
  options: BatchCommoditySyncOptions = {},
): Promise<CommoditySyncBatchResult> {
  const destination = new LarkCommodityPoolDestination(
    options.config,
    options.clientOptions,
    options.auditLogger ?? defaultAuditLogger,
  );
  return destination.sync(productFacts, {
    baseUrl: options.baseUrl,
    qualityStatus: options.qualityStatus,
    requestClientToken: options.requestClientToken,
  });
}

export async function syncCommodityDecisions(
  inputs: readonly CommodityDecisionSyncInput[],
  options: BatchCommoditySyncOptions = {},
): Promise<CommoditySyncBatchResult> {
  const destination = new LarkCommodityPoolDestination(
    options.config,
    options.clientOptions,
    options.auditLogger ?? defaultAuditLogger,
  );
  return destination.syncDecisions(inputs, {
    requestClientToken: options.requestClientToken,
  });
}
