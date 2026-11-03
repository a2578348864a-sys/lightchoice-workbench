/**
 * P3 市场研究范围人工确认 —— 正式保存/读取服务。
 *
 * 设计要点：
 * - 与 archive 完全分离，不改 `archivedAt`；
 * - 三重版本：批次 `expectedScanHash` + 样本 `expectedVersion`（sampleResourceVersion）+ 人工确认 `expectedScopeRevision`；
 * - 事务内逐条 CAS（单条 `UPDATE ... WHERE scopeRevision = ?` 原子语句），并发首次创建依赖唯一约束兜底；
 * - 幂等回执只做请求去重，人工状态仍以业务行为准；同 Key 不同 Body 由回执层拒绝；
 * - 不参与 validSampleCount / Market Gate / 代表商品 / Research Handoff。
 *
 * 注：本机 Prisma CLI 不可用，新字段通过 `marketSampleScopeRepository` 的 raw SQL 读写，
 * 表结构由正式 migration 文件承载（未改动既有列语义）。
 */

import "server-only";

import { Prisma } from "@prisma/client";
import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { requireOwnerContext, withV5Receipt, V5CoreError } from "@/lib/server/v5CoreCommon";
import { hashJson } from "@/lib/server/v5CanonicalHash";
import {
  buildScopeConfirmationRows,
  summarizeScopeConfirmations,
  validateScopeConfirmationBatch,
  type ScopeConfirmationInput,
  type ScopeConfirmationRecord,
  type ScopeConfirmationRow,
  type ScopeConfirmationSummary,
} from "@/lib/marketScan/scopeConfirmation";
import {
  SCOPE_OWNER,
  casUpdateSampleScope,
  insertSampleScope,
  listSampleScopeRows,
} from "@/lib/server/marketSampleScopeRepository";

const OPERATION = "market-analysis:scope-confirmation";

export type ScopeConfirmationSaveResult = {
  readonly scanId: string;
  readonly items: readonly ScopeConfirmationRow[];
  readonly summary: ScopeConfirmationSummary;
  readonly replayed: boolean;
  readonly idempotent: boolean;
};

function parseSnapshot(value: string): { items: Array<Record<string, unknown>> } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const items = (parsed as Record<string, unknown>).items;
      if (Array.isArray(items)) {
        return { items: items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) };
      }
    }
  } catch {
    /* fallthrough */
  }
  return { items: [] };
}

function sampleTitleOf(factValues: unknown): string | null {
  if (typeof factValues !== "object" || factValues === null || Array.isArray(factValues)) return null;
  const title = (factValues as Record<string, unknown>).title;
  if (typeof title !== "object" || title === null || Array.isArray(title)) return null;
  const record = title as Record<string, unknown>;
  return record.presence === "present" && typeof record.value === "string" && record.value.trim()
    ? record.value.trim()
    : null;
}

/** 与 marketSampleAction 同一版本口径（样本快照 + key + 归档状态）。 */
function sampleResourceVersion(sampleHash: string, marketSampleKey: string, archivedAtMs: number | null): string {
  return hashJson({
    sampleHash,
    marketSampleKey,
    archivedAt: archivedAtMs === null ? null : new Date(archivedAtMs).toISOString(),
  });
}

/** 研究目标哈希：nicheDefinition 变化时旧确认失效（与样本快照解耦）。 */
function nicheHashOf(nicheDefinitionJson: string): string {
  return hashJson({ nicheDefinition: nicheDefinitionJson });
}

async function loadScan(scanId: string) {
  const scan = await prisma.marketScan.findFirst({ where: { id: scanId } });
  if (!scan) throw new V5CoreError("MARKET_SCAN_NOT_FOUND", "没有找到该市场扫描。", 404);
  if (scan.archivedAt !== null) {
    throw new V5CoreError("MARKET_SCAN_ARCHIVED", "该市场扫描已归档，不能修改人工范围确认。", 409, false, true);
  }
  return scan;
}

/** 读取侧：合并快照样本与已保存确认（不写库）。 */
export async function readScopeConfirmationView(scanId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<{
  scanHash: string;
  nicheHash: string;
  rows: ScopeConfirmationRow[];
  summary: ScopeConfirmationSummary;
}> {
  const scan = await client.marketScan.findFirst({ where: { id: scanId } });
  if (!scan) throw new V5CoreError("MARKET_SCAN_NOT_FOUND", "没有找到该市场扫描。", 404);
  const snapshot = parseSnapshot(scan.sampleSnapshotJson);
  const persisted = await listSampleScopeRows(scan.id, client);
  const nicheHash = nicheHashOf(scan.nicheDefinitionJson);

  const confirmations: ScopeConfirmationRecord[] = persisted.flatMap((row) => {
    const status = row.scopeStatus;
    if (status !== "IN_SCOPE" && status !== "OUT_OF_SCOPE" && status !== "REVOKED") return [];
    return [{
      marketSampleKey: row.marketSampleKey,
      status,
      reason: row.scopeReason,
      sampleHash: row.scopeSampleHash,
      nicheHash: row.scopeNicheHash,
      confirmedAt: row.scopeConfirmedAtMs === null ? null : new Date(row.scopeConfirmedAtMs).toISOString(),
      confirmedBy: row.scopeConfirmedBy,
      scopeRevision: row.scopeRevision,
    }];
  });
  const archivedByKey = new Map(persisted.map((row) => [row.marketSampleKey, row.archivedAtMs]));

  const rows = buildScopeConfirmationRows({
    scanId: scan.id,
    sampleHash: scan.sampleHash,
    nicheHash,
    samples: snapshot.items.map((item) => {
      const asin = String(item.asin ?? "").toUpperCase();
      const marketSampleKey = `${scan.id}:${asin}`;
      return {
        asin,
        subjectKey: typeof item.subjectKey === "string" ? item.subjectKey : `amazon:${scan.marketplace}:${asin}`,
        title: sampleTitleOf(item.factValues),
        systemSubtype: null,
        currentVersion: sampleResourceVersion(scan.sampleHash, marketSampleKey, archivedByKey.get(marketSampleKey) ?? null),
      };
    }),
    confirmations,
  });

  return { scanHash: scan.sampleHash, nicheHash, rows, summary: summarizeScopeConfirmations(rows) };
}

/**
 * 批量保存人工范围确认（全量校验 + 单事务写入 + 逐条原子 CAS）。
 * 任一成员冲突 → 整批回滚。
 */
export async function saveScopeConfirmations(input: {
  context: AccessContext;
  scanId: string;
  expectedScanHash: string;
  items: ScopeConfirmationInput[];
  idempotencyKey: string;
}): Promise<ScopeConfirmationSaveResult> {
  requireOwnerContext(input.context);
  const scan = await loadScan(input.scanId);

  // 幂等键按「原始请求体」绑定：同 Key 同 Body → 重放原结果；同 Key 不同 Body → 409。
  // 校验放在 execute 内部，重放时不再重复校验（否则旧 revision 会被误判为冲突）。
  const rawResourceKey = `${scan.id}:${input.items.map((item) => item.marketSampleKey.trim()).sort().join(",")}:${input.expectedScanHash}`;
  const receipt = await withV5Receipt({
    context: input.context,
    operation: OPERATION,
    resourceKey: rawResourceKey,
    idempotencyKey: input.idempotencyKey,
    requestBody: { expectedScanHash: input.expectedScanHash, items: input.items },
    execute: async () => {
      const view = await readScopeConfirmationView(scan.id);
      const validation = validateScopeConfirmationBatch({
        scanId: scan.id,
        sampleHash: view.scanHash,
        expectedScanHash: input.expectedScanHash,
        rows: view.rows,
        items: input.items,
      });
      if (!validation.ok) {
        const first = validation.errors[0];
        throw new V5CoreError(first.code, first.message, first.code === "MARKET_SNAPSHOT_STALE" ? 409 : 422, false, true, {
          errors: validation.errors,
        });
      }
      if (validation.idempotent) {
        return { scanId: scan.id, items: view.rows, summary: view.summary, replayed: false, idempotent: true };
      }

      const nowMs = Date.now();
      await prisma.$transaction(async (tx) => {
        const currentRows = await listSampleScopeRows(scan.id, tx);
        const byKey = new Map(currentRows.map((row) => [row.marketSampleKey, row]));
        for (const item of validation.normalized) {
          const revoke = item.status === "UNREVIEWED";
          const existing = byKey.get(item.marketSampleKey);
          const scopeStatus = revoke ? "REVOKED" : item.status;
          const scopeReason = revoke ? null : item.reason;
          // 撤销保留当时的快照/目标绑定，便于追溯；撤销状态不参与过期判定
          const scopeSampleHash = view.scanHash;
          const scopeNicheHash = view.nicheHash;
          const scopeConfirmedAtMs = revoke ? null : nowMs;
          const scopeConfirmedBy = revoke ? null : SCOPE_OWNER;

          if (!existing) {
            if (item.expectedScopeRevision !== 0) {
              throw new V5CoreError("SCOPE_REVISION_CONFLICT", "该样本的人工确认已被更新，请刷新后重试。", 409, false, true, {
                marketSampleKey: item.marketSampleKey,
              });
            }
            try {
              await insertSampleScope({
                scanId: scan.id,
                marketSampleKey: item.marketSampleKey,
                scopeStatus,
                scopeReason,
                scopeSampleHash,
                scopeNicheHash,
                scopeConfirmedAtMs,
                scopeConfirmedBy,
                nowMs,
              }, tx);
            } catch (error) {
              // 并发首次确认：唯一约束冲突 → 按冲突处理，绝不静默覆盖
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new V5CoreError("SCOPE_REVISION_CONFLICT", "该样本刚被其他操作确认，请刷新后重试。", 409, false, true, {
                  marketSampleKey: item.marketSampleKey,
                });
              }
              throw error;
            }
            continue;
          }

          const affected = await casUpdateSampleScope({
            id: existing.id,
            expectedScopeRevision: item.expectedScopeRevision,
            scopeStatus,
            scopeReason,
            scopeSampleHash,
            scopeNicheHash,
            scopeConfirmedAtMs,
            scopeConfirmedBy,
            nowMs,
          }, tx);
          if (affected !== 1) {
            throw new V5CoreError("SCOPE_REVISION_CONFLICT", "该样本的人工确认已被其他操作更新，请刷新后重试。", 409, false, true, {
              marketSampleKey: item.marketSampleKey,
              currentScopeRevision: existing.scopeRevision,
            });
          }
        }
      });

      const after = await readScopeConfirmationView(scan.id);
      return { scanId: scan.id, items: after.rows, summary: after.summary, replayed: false, idempotent: false };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}
