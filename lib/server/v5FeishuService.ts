import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { hashJson, requireOwnerContext, V5CoreError, withV5Receipt } from "@/lib/server/v5CoreCommon";
import {
  batchCreateRecords,
  batchUpdateRecords,
  LarkApiError,
  listTableFields,
  searchTableRecords,
} from "@/lib/integrations/lark/baseClient";
import type { LarkConfig } from "@/lib/integrations/lark/types";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";

type SyncTable = "market_samples" | "research_archive";

type SyncRowInput = {
  businessKey: string;
  localId: string;
  projection: Record<string, unknown>;
  projectionHash: string;
  idempotencyKey: string;
};

type SyncRowOutcome = {
  businessKey: string;
  localId: string;
  remoteRecordId: string | null;
  action: "created" | "updated" | "unchanged" | "failed";
  attempt: number;
  idempotencyKey: string;
  projectionHash: string;
  errorCode: string | null;
  retryable: boolean;
};

export type SyncBatchResult = {
  syncId: string;
  table: SyncTable;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  pending: number;
  state: "SYNCED" | "PARTIAL" | "FAILED";
  items: SyncRowOutcome[];
  retryable: boolean;
  message?: string;
};

interface FeishuSyncAdapter {
  sync(params: {
    context: AccessContext;
    table: SyncTable;
    resourceType: string;
    resourceId: string;
    rows: SyncRowInput[];
  }): Promise<SyncBatchResult>;
}

function configSnapshot() {
  const appId = (process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || "").trim();
  const appSecret = (process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || "").trim();
  const baseToken = (process.env.FEISHU_BASE_APP_TOKEN || process.env.LARK_BASE_APP_TOKEN || "").trim();
  const marketTable = (process.env.FEISHU_MARKET_TABLE_ID || process.env.LARK_BASE_TABLE_ID || "").trim();
  const researchTable = (process.env.FEISHU_RESEARCH_TABLE_ID || "").trim();
  const openApiDomain = (process.env.FEISHU_OPEN_API_DOMAIN || process.env.LARK_OPEN_API_DOMAIN || "https://open.feishu.cn").trim();
  return {
    configured: Boolean(appId && appSecret && baseToken && marketTable && researchTable),
    appId,
    appSecret,
    baseToken,
    marketTable,
    researchTable,
    openApiDomain,
  };
}

let lastPreflightSuccessAt: string | null = null;

export function recordPreflightSuccess() {
  lastPreflightSuccessAt = new Date().toISOString();
}

export function resetPreflightSuccessForTest() {
  lastPreflightSuccessAt = null;
}

export function getFeishuConnectionStatus() {
  const config = configSnapshot();
  const hasRealPreflight = Boolean(lastPreflightSuccessAt);
  const preflightStatus = !config.configured
    ? "failed"
    : hasRealPreflight
    ? "passed"
    : "unverified";

  return {
    configured: config.configured,
    status: config.configured ? "ready" : "not_configured",
    preflight: preflightStatus,
    marketTableReady: config.configured && preflightStatus === "passed",
    researchTableReady: config.configured && preflightStatus === "passed",
    baseOpenUrl: allowlistedWorkbenchUrl(),
    displayName: (process.env.FEISHU_DISPLAY_NAME || process.env.LARK_BASE_DISPLAY_NAME || "").trim() || null,
    lastCheckedAt: new Date().toISOString(),
    lastSuccessAt: lastPreflightSuccessAt,
    lastError: config.configured ? null : { code: "FEISHU_CREDENTIAL_MISSING", message: "服务端尚未配置飞书连接。", retryable: false },
  };
}

function allowlistedWorkbenchUrl(): string | null {
  const raw = (process.env.WORKBENCH_LINK || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    const allowlist = (process.env.WORKBENCH_LINK_ALLOWLIST || "").split(",").map((item) => item.trim()).filter(Boolean);
    return allowlist.some((origin) => url.origin === origin.replace(/\/$/, "")) ? url.toString() : null;
  } catch {
    return null;
  }
}

function tableId(table: SyncTable): string {
  const config = configSnapshot();
  return table === "market_samples" ? config.marketTable : config.researchTable;
}

async function saveFailedMetadata(input: {
  context: AccessContext;
  resourceType: string;
  resourceId: string;
  table: SyncTable;
  businessKey: string;
  projectionHash: string;
  idempotencyKey: string;
  code: string;
  message: string;
  retryable?: boolean;
}) {
  const actorScope = input.context.mode === "owner" ? "owner:v1" : `visitor:${input.context.demoAccessId}`;
  return prisma.v5FeishuSyncMetadata.upsert({
    where: { actorScope_tableName_businessKey: { actorScope, tableName: input.table, businessKey: input.businessKey } },
    create: {
      actorScope,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      tableName: input.table,
      businessKey: input.businessKey,
      projectionHash: input.projectionHash,
      state: "FAILED",
      attempt: 1,
      lastAttemptAt: new Date(),
      errorCode: input.code,
      errorMessage: input.message,
      retryable: input.retryable ?? false,
      idempotencyKey: input.idempotencyKey,
    },
    update: {
      projectionHash: input.projectionHash,
      state: "FAILED",
      attempt: { increment: 1 },
      lastAttemptAt: new Date(),
      errorCode: input.code,
      errorMessage: input.message,
      retryable: input.retryable ?? false,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

function emptyBatch(
  table: SyncTable,
  items: Array<{ businessKey: string; localId: string; projectionHash: string; idempotencyKey: string }>,
  code: string,
  message: string,
): SyncBatchResult {
  return {
    syncId: `sync_${Date.now()}`,
    table,
    total: items.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: items.length,
    pending: 0,
    state: "FAILED",
    items: items.map((item) => ({
      ...item,
      remoteRecordId: null,
      action: "failed",
      attempt: 1,
      errorCode: code,
      retryable: false,
    })),
    retryable: false,
    message,
  };
}

/**
 * 隔离测试适配器：
 * 保证在自动化测试和本地验证期间 REAL_FEISHU_WRITES = 0，
 * 使用本地 v5FeishuSyncMetadata 模拟状态对齐与幂等。
 */
class TestFeishuAdapter implements FeishuSyncAdapter {
  async sync(params: {
    context: AccessContext;
    table: SyncTable;
    resourceType: string;
    resourceId: string;
    rows: SyncRowInput[];
  }): Promise<SyncBatchResult> {
    const items: SyncRowOutcome[] = [];
    for (const row of params.rows) {
      const existing = await prisma.v5FeishuSyncMetadata.findUnique({
        where: {
          actorScope_tableName_businessKey: {
            actorScope: "owner:v1",
            tableName: params.table,
            businessKey: row.businessKey,
          },
        },
      });

      const action =
        existing?.projectionHash === row.projectionHash && existing.state === "SYNCED"
          ? "unchanged"
          : existing
          ? "updated"
          : "created";

      await prisma.v5FeishuSyncMetadata.upsert({
        where: {
          actorScope_tableName_businessKey: {
            actorScope: "owner:v1",
            tableName: params.table,
            businessKey: row.businessKey,
          },
        },
        create: {
          actorScope: "owner:v1",
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          tableName: params.table,
          businessKey: row.businessKey,
          projectionHash: row.projectionHash,
          remoteRecordId: `test_rec_${Date.now()}`,
          state: "SYNCED",
          attempt: 1,
          lastAttemptAt: new Date(),
          lastSuccessAt: new Date(),
          retryable: false,
          idempotencyKey: row.idempotencyKey,
        },
        update: {
          projectionHash: row.projectionHash,
          state: "SYNCED",
          attempt: { increment: 1 },
          lastAttemptAt: new Date(),
          lastSuccessAt: new Date(),
          errorCode: null,
          errorMessage: null,
          retryable: false,
          idempotencyKey: row.idempotencyKey,
        },
      });

      items.push({
        businessKey: row.businessKey,
        localId: row.localId,
        remoteRecordId: existing?.remoteRecordId ?? `test_rec_${Date.now()}`,
        action,
        attempt: (existing?.attempt ?? 0) + 1,
        idempotencyKey: row.idempotencyKey,
        projectionHash: row.projectionHash,
        errorCode: null,
        retryable: false,
      });
    }

    return {
      syncId: `sync_${Date.now()}`,
      table: params.table,
      total: items.length,
      created: items.filter((item) => item.action === "created").length,
      updated: items.filter((item) => item.action === "updated").length,
      unchanged: items.filter((item) => item.action === "unchanged").length,
      failed: 0,
      pending: 0,
      state: "SYNCED",
      items,
      retryable: false,
    };
  }
}

/**
 * 生产真实飞书适配器：
 * 完整实现 preflight / search / create / update / 429 backoff / retry / reconcile。
 */
export class ProductionFeishuAdapter implements FeishuSyncAdapter {
  async sync(params: {
    context: AccessContext;
    table: SyncTable;
    resourceType: string;
    resourceId: string;
    rows: SyncRowInput[];
  }): Promise<SyncBatchResult> {
    const config = configSnapshot();
    if (!config.configured) {
      for (const row of params.rows) {
        await saveFailedMetadata({
          context: params.context,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          table: params.table,
          businessKey: row.businessKey,
          projectionHash: row.projectionHash,
          idempotencyKey: row.idempotencyKey,
          code: "FEISHU_CREDENTIAL_MISSING",
          message: "未配置飞书服务端凭证，已安全跳过真实写入。",
        });
      }
      return emptyBatch(params.table, params.rows, "FEISHU_CREDENTIAL_MISSING", "飞书未配置，本地事实仍可正常使用。");
    }

    const tId = tableId(params.table);
    const larkConfig: LarkConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      appToken: config.baseToken,
      tableId: tId,
      openApiDomain: config.openApiDomain,
    };

    // 1. Preflight：验证目标多维表格可达性及字段结构
    try {
      await listTableFields(larkConfig);
      recordPreflightSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "飞书预检失败";
      for (const row of params.rows) {
        await saveFailedMetadata({
          context: params.context,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          table: params.table,
          businessKey: row.businessKey,
          projectionHash: row.projectionHash,
          idempotencyKey: row.idempotencyKey,
          code: "FEISHU_PREFLIGHT_FAILED",
          message: msg,
        });
      }
      return emptyBatch(params.table, params.rows, "FEISHU_PREFLIGHT_FAILED", msg);
    }

    // 2. Search, Reconcile, Create/Update
    const items: SyncRowOutcome[] = [];
    for (const row of params.rows) {
      try {
        const existing = await prisma.v5FeishuSyncMetadata.findUnique({
          where: {
            actorScope_tableName_businessKey: {
              actorScope: "owner:v1",
              tableName: params.table,
              businessKey: row.businessKey,
            },
          },
        });

        // 查重：若无本地 recordId，从飞书远端按业务主键严格搜索已有记录
        let remoteRecordId = existing?.remoteRecordId ?? null;
        if (!remoteRecordId) {
          let searchRes: readonly { record_id: string; fields?: Record<string, unknown> }[];
          try {
            searchRes = await searchTableRecords(larkConfig, {
              filter: {
                conjunction: "and",
                conditions: [{ field_name: "业务主键", operator: "is", value: [row.businessKey] }],
              },
              pageSize: 5,
            });
          } catch (searchErr) {
            // searchTableRecords 失败：不允许当成 []，必须 fail-closed / retryable
            const code = searchErr instanceof LarkApiError ? searchErr.code : "FEISHU_SEARCH_FAILED";
            const msg = searchErr instanceof Error ? searchErr.message : "飞书记录检索失败";
            throw new V5CoreError(code, `查重检索失败: ${msg}`, 502, true);
          }

          if (searchRes.length === 0) {
            // 查重返回 0：Create
            remoteRecordId = null;
          } else if (searchRes.length === 1) {
            // 查重返回 1：Update / Reconcile
            remoteRecordId = searchRes[0].record_id;
          } else {
            // 查重返回 >1：FEISHU_DUPLICATE_KEY，禁止随机覆盖
            throw new V5CoreError(
              "FEISHU_DUPLICATE_KEY",
              `飞书远端存在重复主键记录 (${searchRes.length} 条): ${row.businessKey}，禁止随机覆盖。`,
              409,
              false,
              true,
            );
          }
        }

        // Reconcile：如内容指纹未变且远端已有记录，跳过写操作
        if (existing?.projectionHash === row.projectionHash && existing.state === "SYNCED" && remoteRecordId) {
          items.push({
            businessKey: row.businessKey,
            localId: row.localId,
            remoteRecordId,
            action: "unchanged",
            attempt: (existing?.attempt ?? 0) + 1,
            idempotencyKey: row.idempotencyKey,
            projectionHash: row.projectionHash,
            errorCode: null,
            retryable: false,
          });
          continue;
        }

        // Create 或 Update（baseClient 内置 429 速率限制及重试）
        let action: "created" | "updated" = "created";
        if (remoteRecordId) {
          await batchUpdateRecords(larkConfig, [{ record_id: remoteRecordId, fields: row.projection }]);
          action = "updated";
        } else {
          const created = await batchCreateRecords(larkConfig, [{ fields: row.projection }]);
          remoteRecordId = created[0]?.record_id ?? null;
          action = "created";
        }

        await prisma.v5FeishuSyncMetadata.upsert({
          where: {
            actorScope_tableName_businessKey: {
              actorScope: "owner:v1",
              tableName: params.table,
              businessKey: row.businessKey,
            },
          },
          create: {
            actorScope: "owner:v1",
            resourceType: params.resourceType,
            resourceId: params.resourceId,
            tableName: params.table,
            businessKey: row.businessKey,
            projectionHash: row.projectionHash,
            remoteRecordId,
            state: "SYNCED",
            attempt: 1,
            lastAttemptAt: new Date(),
            lastSuccessAt: new Date(),
            retryable: false,
            idempotencyKey: row.idempotencyKey,
          },
          update: {
            projectionHash: row.projectionHash,
            remoteRecordId,
            state: "SYNCED",
            attempt: { increment: 1 },
            lastAttemptAt: new Date(),
            lastSuccessAt: new Date(),
            errorCode: null,
            errorMessage: null,
            retryable: false,
            idempotencyKey: row.idempotencyKey,
          },
        });

        items.push({
          businessKey: row.businessKey,
          localId: row.localId,
          remoteRecordId,
          action,
          attempt: (existing?.attempt ?? 0) + 1,
          idempotencyKey: row.idempotencyKey,
          projectionHash: row.projectionHash,
          errorCode: null,
          retryable: false,
        });
      } catch (rowErr: any) {
        const isDuplicateKey = rowErr instanceof V5CoreError && rowErr.code === "FEISHU_DUPLICATE_KEY";
        const errCode = rowErr instanceof V5CoreError
          ? rowErr.code
          : rowErr instanceof LarkApiError
          ? rowErr.code
          : "FEISHU_ROW_FAILED";
        const errMsg = rowErr instanceof Error ? rowErr.message : "飞书行同步失败";
        const retryable = isDuplicateKey ? false : (rowErr instanceof V5CoreError ? Boolean(rowErr.retryable) : true);

        await saveFailedMetadata({
          context: params.context,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          table: params.table,
          businessKey: row.businessKey,
          projectionHash: row.projectionHash,
          idempotencyKey: row.idempotencyKey,
          code: errCode,
          message: errMsg,
          retryable,
        });
        items.push({
          businessKey: row.businessKey,
          localId: row.localId,
          remoteRecordId: null,
          action: "failed",
          attempt: 1,
          idempotencyKey: row.idempotencyKey,
          projectionHash: row.projectionHash,
          errorCode: errCode,
          retryable,
        });
      }
    }

    const failedCount = items.filter((item) => item.action === "failed").length;
    return {
      syncId: `sync_${Date.now()}`,
      table: params.table,
      total: items.length,
      created: items.filter((item) => item.action === "created").length,
      updated: items.filter((item) => item.action === "updated").length,
      unchanged: items.filter((item) => item.action === "unchanged").length,
      failed: failedCount,
      pending: 0,
      state: failedCount === items.length ? "FAILED" : failedCount > 0 ? "PARTIAL" : "SYNCED",
      items,
      retryable: failedCount > 0,
    };
  }
}

function getFeishuAdapter(): FeishuSyncAdapter {
  if (process.env.V5_FEISHU_ADAPTER === "test" || process.env.NODE_ENV === "test") {
    return new TestFeishuAdapter();
  }
  return new ProductionFeishuAdapter();
}

async function executeSync(input: {
  context: AccessContext;
  table: SyncTable;
  resourceType: string;
  resourceId: string;
  rows: Array<{ businessKey: string; localId: string; projection: Record<string, unknown> }>;
  idempotencyKey: string;
}): Promise<SyncBatchResult & { replayed: boolean }> {
  requireOwnerContext(input.context);
  const rows = input.rows.map((row) => ({
    ...row,
    projectionHash: hashJson(row.projection),
    idempotencyKey: `${input.idempotencyKey}:${row.businessKey}`,
  }));

  const result = await withV5Receipt({
    context: input.context,
    operation: `feishu:${input.table}`,
    resourceKey: `${input.resourceId}:${rows.map((row) => row.businessKey).sort().join(",")}`,
    idempotencyKey: input.idempotencyKey,
    requestBody: {
      table: input.table,
      resourceId: input.resourceId,
      rows: rows.map((row) => ({ businessKey: row.businessKey, projectionHash: row.projectionHash })),
    },
    execute: async () => {
      const adapter = getFeishuAdapter();
      return adapter.sync({
        context: input.context,
        table: input.table,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        rows,
      });
    },
  });

  return { ...result.value, replayed: result.replayed };
}

export async function syncMarketScan(input: {
  context: AccessContext;
  scanId: string;
  expectedScanHash: string;
  sampleKeys?: string[];
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const scan = await prisma.marketScan.findFirst({ where: { id: input.scanId, ownerScope: "owner:v1" } });
  if (!scan) throw new V5CoreError("MARKET_ANALYSIS_NOT_FOUND", "市场分析不存在。", 404);
  if (scan.sampleHash !== input.expectedScanHash) {
    throw new V5CoreError("MARKET_SNAPSHOT_STALE", "市场分析快照已变化。", 409, false, true);
  }
  const snapshot = JSON.parse(scan.sampleSnapshotJson) as { items?: Array<Record<string, unknown>> };
  const selected = new Set(input.sampleKeys ?? []);
  const items = (snapshot.items ?? []).filter(
    (item) => !selected.size || selected.has(`${scan.id}:${String(item.asin).toUpperCase()}`),
  );
  return executeSync({
    context: input.context,
    table: "market_samples",
    resourceType: "MarketScan",
    resourceId: scan.id,
    idempotencyKey: input.idempotencyKey,
    rows: items.map((item) => ({
      businessKey: `${scan.id}:${String(item.asin).toUpperCase()}`,
      localId: scan.id,
      projection: {
        ...item,
        scanId: scan.id,
        sampleHash: scan.sampleHash,
        metricsVersion: scan.metricsVersion,
        workbenchLink: allowlistedWorkbenchUrl(),
      },
    })),
  });
}

export async function syncResearchTask(input: {
  context: AccessContext;
  taskId: string;
  expectedReportHash: string;
  expectedFactHash: string;
  expectedEvidenceHash: string;
  idempotencyKey: string;
}) {
  requireOwnerContext(input.context);
  const task = await prisma.viralAnalysisRecord.findFirst({ where: { id: input.taskId, type: "workflow" } });
  if (!task) throw new V5CoreError("RESEARCH_TASK_NOT_FOUND", "研究任务不存在。", 404);
  const root = JSON.parse(task.resultJson) as Record<string, unknown>;
  const state = root.v5Research as Record<string, unknown> | undefined;
  if (
    !state ||
    (state.reportHash ?? "") !== (input.expectedReportHash ?? "") ||
    (state.factHash ?? "") !== (input.expectedFactHash ?? "") ||
    (state.evidenceHash ?? "") !== (input.expectedEvidenceHash ?? "")
  ) {
    throw new V5CoreError("REPORT_STALE", "研究绑定已变化。", 409, false, true);
  }
  // 动态加载避免研究读侧与飞书服务的循环依赖；在 adapter/网络/回执写入之前检查。
  const { getResearchDetail } = await import("@/lib/server/v5ResearchService");
  const detail = await getResearchDetail({ context: input.context, taskId: input.taskId });
  if (detail.stale || detail.reportHash !== input.expectedReportHash
    || detail.factHash !== input.expectedFactHash || detail.evidenceHash !== input.expectedEvidenceHash) {
    throw new V5CoreError("REPORT_STALE", "研究来源或报告已变化，请重新读取后复核。", 409, false, true);
  }
  const blockReason = claimConsumptionBlockReason(detail.claimAudit);
  if (blockReason) throw new V5CoreError("RESEARCH_CLAIMS_NOT_CONSUMABLE", claimConsumptionNotice(detail.claimAudit), 409);
  // 旧表没有专用警告字段；在不改远端 schema 的前提下，待降级内容先留在本地复核。
  if (detail.claimAudit?.verdict === "NEEDS_DOWNGRADE") {
    throw new V5CoreError("RESEARCH_CLAIMS_REVIEW_REQUIRED", "研究存在待降级表述，请先在本地复核；本次未向飞书发送。", 409);
  }
  const revision = Number(state.researchRevision ?? 0);
  const key = `${task.id}:${revision}`;
  return executeSync({
    context: input.context,
    table: "research_archive",
    resourceType: "ViralAnalysisRecord",
    resourceId: task.id,
    idempotencyKey: input.idempotencyKey,
    rows: [
      {
        businessKey: key,
        localId: task.id,
        projection: {
          researchRecordKey: key,
          taskId: task.id,
          researchRevision: revision,
          asin: state.asin,
          reportHash: state.reportHash,
          factHash: state.factHash,
          evidenceHash: state.evidenceHash,
          myChoice: state.myChoice ?? null,
          workbenchLink: allowlistedWorkbenchUrl(),
        },
      },
    ],
  });
}

export async function getFeishuSyncStatus(input: {
  context: AccessContext;
  resourceType: string;
  resourceId: string;
  table?: string;
}) {
  requireOwnerContext(input.context);
  const rows = await prisma.v5FeishuSyncMetadata.findMany({
    where: {
      actorScope: "owner:v1",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.table ? { tableName: input.table } : {}),
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!rows.length) throw new V5CoreError("SYNC_METADATA_NOT_FOUND", "尚无同步记录。", 404);
  return {
    items: rows.map((row) => ({
      businessKey: row.businessKey,
      state: row.state,
      projectionHash: row.projectionHash,
      remoteRecordId: row.remoteRecordId,
      attempt: row.attempt,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      retryable: row.retryable,
    })),
  };
}

