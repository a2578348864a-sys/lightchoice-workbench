import "server-only";

import { mapResearchExportToLarkRecord } from "@/lib/research/larkMapping";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";
import {
  batchCreateRecords,
  batchUpdateRecords,
  listTableFields,
  readBitableTextValue,
  searchTableRecords,
  type LarkBitableRecord,
  type LarkClientOptions,
} from "./baseClient";
import { getLarkConfig } from "./config";
import { mapLarkRecordToBitableRow, validateTableFields } from "./tableContract";
import {
  syncCommodityDecisions,
  type BatchCommoditySyncOptions,
  type CommodityDecisionSyncInput,
  type CommoditySyncBatchResult,
} from "./batchCommoditySync";
import type {
  LarkConfig,
  LarkPreflightResult,
  LarkSyncBatchResult,
  LarkSyncRecordResult,
  ResearchExportDestination,
} from "./types";

const SYNC_CHUNK_SIZE = 50;

/**
 * Phase E：ProductResearchRecord 的人工决定写回统一商品池。
 * 保留旧的 ResearchExport ASIN 导出类作为兼容路径；新闭环只走 subjectKey。
 */
export async function syncResearchDecisionsToCommodityPool(
  inputs: readonly CommodityDecisionSyncInput[],
  options: BatchCommoditySyncOptions = {},
): Promise<CommoditySyncBatchResult> {
  return syncCommodityDecisions(inputs, options);
}

type LarkSyncCandidate = {
  readonly exportRecord: ResearchExportRecord;
  readonly asin: string;
  readonly rowFields: Record<string, unknown>;
};

export type LarkSyncPlan = {
  readonly toCreate: readonly LarkSyncCandidate[];
  readonly toUpdate: readonly (LarkSyncCandidate & { readonly recordId: string })[];
  readonly duplicateAsins: readonly { readonly asin: string; readonly matchCount: number }[];
};

/**
 * 将查重结果转换为写入计划。
 *
 * ASIN 是当前 V1 的唯一业务键：0 条创建、1 条更新、超过 1 条拒绝。
 * 该函数保持纯函数，确保重复数据不会在任何写入分支中被随意选取。
 */
export function planLarkSyncRecords(
  candidates: readonly LarkSyncCandidate[],
  existingRecords: readonly LarkBitableRecord[],
): LarkSyncPlan {
  const recordsByAsin = new Map<string, LarkBitableRecord[]>();
  for (const record of existingRecords) {
    const asin = readBitableTextValue(record.fields.ASIN);
    if (!asin) continue;
    const records = recordsByAsin.get(asin) ?? [];
    records.push(record);
    recordsByAsin.set(asin, records);
  }

  const toCreate: LarkSyncCandidate[] = [];
  const toUpdate: (LarkSyncCandidate & { recordId: string })[] = [];
  const duplicateAsins: { asin: string; matchCount: number }[] = [];

  for (const candidate of candidates) {
    const matches = recordsByAsin.get(candidate.asin) ?? [];
    if (matches.length > 1) {
      duplicateAsins.push({ asin: candidate.asin, matchCount: matches.length });
    } else if (matches.length === 1) {
      toUpdate.push({ ...candidate, recordId: matches[0].record_id });
    } else {
      toCreate.push(candidate);
    }
  }

  return { toCreate, toUpdate, duplicateAsins };
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export class LarkBaseDestination implements ResearchExportDestination {
  constructor(
    private readonly customConfig?: LarkConfig,
    private readonly clientOptions: LarkClientOptions = {},
  ) {}

  private resolveConfig():
    | { readonly ok: true; readonly config: LarkConfig }
    | { readonly ok: false; readonly missingKeys: readonly string[] } {
    if (this.customConfig) {
      return { ok: true, config: this.customConfig };
    }
    return getLarkConfig();
  }

  /**
   * 飞书连接预检（Preflight）。
   * 检查凭证可用性、Base/Table 可达性与字段契约完整性。
   */
  async preflight(): Promise<LarkPreflightResult> {
    const configResult = this.resolveConfig();
    if (!configResult.ok) {
      return {
        configured: false,
        connected: false,
        baseAccessible: false,
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

    const config = configResult.config;

    try {
      const remoteFields = await listTableFields(config, this.clientOptions);
      const validation = validateTableFields(remoteFields);

      return {
        configured: true,
        connected: true,
        baseAccessible: true,
        tableAccessible: true,
        writable: validation.isValid,
        appToken: config.appToken,
        tableId: config.tableId,
        missingFields: validation.missingRequiredFields,
        missingWriteFields: validation.missingWriteFields,
        missingOptionalFields: validation.missingOptionalFields,
        incompatibleFields: validation.incompatibleFields,
        fieldMapping: validation.fieldMapping,
        errorCode: validation.isValid ? undefined : "TABLE_FIELDS_MISMATCH",
        errorMessage: validation.isValid
          ? undefined
          : `飞书表结构不满足 V1 契约，缺少必须字段: ${validation.missingRequiredFields.join(", ") || "无"}；`
            + `缺少写入字段: ${validation.missingWriteFields.join(", ") || "无"}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法连接飞书多维表格";
      const code = (error as { code?: string }).code || "LARK_CONNECTION_FAILED";

      return {
        configured: true,
        connected: false,
        baseAccessible: false,
        tableAccessible: false,
        writable: false,
        appToken: config.appToken,
        tableId: config.tableId,
        missingFields: [],
        missingWriteFields: [],
        missingOptionalFields: [],
        incompatibleFields: [],
        fieldMapping: {},
        errorCode: code,
        errorMessage: message,
      };
    }
  }

  /**
   * 幂等单向同步：
   * 1. 查询飞书当前已有记录（以 ASIN 为主键）；
   * 2. 已有记录转为 update，未有记录转为 create；
   * 3. 分批调用飞书 batch API；
   * 4. 隔离单条/单批失败，返回精确的批次执行结果。
   */
  async sync(records: readonly ResearchExportRecord[]): Promise<LarkSyncBatchResult> {
    const syncedAt = new Date().toISOString();
    const configResult = this.resolveConfig();

    if (!configResult.ok) {
      return {
        total: records.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: records.length,
        syncedAt,
        blockedReason: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS",
        results: records.map((r) => ({
          taskId: r.taskId,
          asin: r.product.asin ?? "",
          action: "failed",
          errorCode: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS",
          errorMessage: `未配置飞书多维表格凭据 (${configResult.missingKeys.join(", ")})，同步已安全拦截。`,
        })),
      };
    }

    const config = configResult.config;

    // 先行执行 Preflight
    const preflightRes = await this.preflight();
    if (!preflightRes.writable) {
      return {
        total: records.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: records.length,
        syncedAt,
        results: records.map((r) => ({
          taskId: r.taskId,
          asin: r.product.asin ?? "",
          action: "failed",
          errorCode: preflightRes.errorCode ?? "PREFLIGHT_FAILED",
          errorMessage: preflightRes.errorMessage ?? "飞书多维表格连接或字段预检未通过。",
        })),
      };
    }

    const results: LarkSyncRecordResult[] = [];
    const validRecords: LarkSyncCandidate[] = [];

    // 过滤并准备行数据
    for (const record of records) {
      const asin = record.product.asin?.trim();
      if (!asin) {
        results.push({
          taskId: record.taskId,
          asin: "",
          action: "failed",
          errorCode: "ASIN_MISSING",
          errorMessage: "记录缺少有效 ASIN，无法保障幂等写入。",
        });
        continue;
      }
      const larkRecord = mapResearchExportToLarkRecord(record);
      const rowFields = mapLarkRecordToBitableRow(record, larkRecord, { syncedAt });
      validRecords.push({ exportRecord: record, asin, rowFields });
    }

    if (validRecords.length === 0) {
      return {
        total: records.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: results.length,
        results,
        syncedAt,
      };
    }

    // 检索已有记录以建立 ASIN -> record_id 索引（幂等判定）
    let existingRecords: readonly LarkBitableRecord[] = [];
    try {
      const asinsToLookup = Array.from(new Set(validRecords.map((r) => r.asin)));
      const searchFilter = {
        conjunction: "or",
        conditions: asinsToLookup.map((asin) => ({
          field_name: "ASIN",
          operator: "is",
          value: [asin],
        })),
      };

      existingRecords = await searchTableRecords(
        config,
        { fieldNames: ["ASIN"], filter: searchFilter, pageSize: 500 },
        this.clientOptions,
      );
    } catch (lookupErr) {
      // 检索失败，安全终止，避免盲目重复写入破坏幂等性
      const errMessage = lookupErr instanceof Error ? lookupErr.message : "检索已有记录失败";
      return {
        total: records.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: records.length,
        syncedAt,
        results: records.map((r) => ({
          taskId: r.taskId,
          asin: r.product.asin ?? "",
          action: "failed",
          errorCode: "IDEMPOTENCY_LOOKUP_FAILED",
          errorMessage: `幂等查重失败，已取消本批次同步: ${errMessage}`,
        })),
      };
    }

    const plan = planLarkSyncRecords(validRecords, existingRecords);
    const duplicateResults: LarkSyncRecordResult[] = [];
    for (const duplicate of plan.duplicateAsins) {
      for (const item of validRecords.filter((candidate) => candidate.asin === duplicate.asin)) {
        duplicateResults.push({
          taskId: item.exportRecord.taskId,
          asin: duplicate.asin,
          action: "failed",
          errorCode: "duplicate_asin_records",
          errorMessage: `ASIN ${duplicate.asin} 存在 ${duplicate.matchCount} 条飞书记录，已阻止同步以避免覆盖或继续创建重复数据。`,
        });
      }
    }
    results.push(...duplicateResults);

    const toCreate = plan.toCreate;
    const toUpdate = plan.toUpdate;

    let createdCount = 0;
    let updatedCount = 0;

    // 执行批量新增
    const createChunks = chunkArray(toCreate, SYNC_CHUNK_SIZE);
    for (const chunk of createChunks) {
      try {
        const payload = chunk.map((c) => ({ fields: c.rowFields }));
        const createdResponses = await batchCreateRecords(config, payload, this.clientOptions);
        chunk.forEach((item, idx) => {
          const resp = createdResponses[idx];
          results.push({
            taskId: item.exportRecord.taskId,
            asin: item.asin,
            action: "created",
            recordId: resp?.record_id,
          });
          createdCount++;
        });
      } catch (chunkErr) {
        const chunkMsg = chunkErr instanceof Error ? chunkErr.message : "批量新增失败";
        chunk.forEach((item) => {
          results.push({
            taskId: item.exportRecord.taskId,
            asin: item.asin,
            action: "failed",
            errorCode: "BATCH_CREATE_FAILED",
            errorMessage: chunkMsg,
          });
        });
      }
    }

    // 执行批量更新
    const updateChunks = chunkArray(toUpdate, SYNC_CHUNK_SIZE);
    for (const chunk of updateChunks) {
      try {
        const payload = chunk.map((c) => ({
          record_id: c.recordId,
          fields: c.rowFields,
        }));
        await batchUpdateRecords(config, payload, this.clientOptions);
        chunk.forEach((item) => {
          results.push({
            taskId: item.exportRecord.taskId,
            asin: item.asin,
            action: "updated",
            recordId: item.recordId,
          });
          updatedCount++;
        });
      } catch (chunkErr) {
        const chunkMsg = chunkErr instanceof Error ? chunkErr.message : "批量更新失败";
        chunk.forEach((item) => {
          results.push({
            taskId: item.exportRecord.taskId,
            asin: item.asin,
            action: "failed",
            errorCode: "BATCH_UPDATE_FAILED",
            errorMessage: chunkMsg,
          });
        });
      }
    }

    const failedCount = results.filter((r) => r.action === "failed").length;

    return {
      total: records.length,
      created: createdCount,
      updated: updatedCount,
      skipped: 0,
      failed: failedCount,
      results,
      syncedAt,
    };
  }
}
