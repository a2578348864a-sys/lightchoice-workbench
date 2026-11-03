import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/server/db";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import type { BatchCaptureRun } from "@/lib/server/batchCaptureRun";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { readV3ModuleEvidence, type V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/source-layer/batch-capture/external-evidence?batchId=...
 *
 * 只读列出「已经存在、但不属于本轮自动采集单元」的 V3 手工附件：
 *   - 商品级主体：batch 的每个 ASIN（`amazon:<marketplace>:<ASIN>`）× {反查 ASIN, 历史趋势}；
 *   - 查询级主体：run 的 productMarketQueries / keywordMiningQueries 的 querySubjectKey
 *     × {商品市场, 关键词挖掘}。
 *
 * 纪律：
 * - **不写**任何 EvidenceStore / DB / 文件；只调用只读入口 `readV3ModuleEvidence`；
 * - fail-soft：单个主体读取失败只记录到 totals.failures，不影响整体响应；
 * - 不声明这些附件「已进入研究」或「已消费」；去向说明由面板另行展示；
 * - 鉴权与同目录 `batch-capture` 只读路由一致（owner-only；本地单用户即 Local Owner）。
 */

/** 商品级手工附件所属模块。 */
const PRODUCT_LEVEL_MODULES = ["reverse_asin", "historical_trend"] as const satisfies readonly V3ModuleId[];
/** 查询级附件所属模块。 */
const QUERY_LEVEL_MODULES = ["sellersprite_product_market", "keyword_mining_trend"] as const satisfies readonly V3ModuleId[];

type ExternalEvidenceSubject = {
  subjectKey: string;
  module: V3ModuleId;
  attachmentCount: number;
  latestCapturedAt: string | null;
};

type ExternalEvidenceFailure = {
  subjectKey: string;
  module: V3ModuleId | null;
  message: string;
};

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message, retryable: false, conflict: false } }, { status });
}

function isProductLevelModule(moduleId: V3ModuleId): boolean {
  return (PRODUCT_LEVEL_MODULES as readonly string[]).includes(moduleId);
}

function optionalMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知读取错误。";
}

/** 有界并发：避免一次打开过多目录句柄，同时保持按需求加载的响应速度。 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
}

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  // 本地单用户下 requireAuthenticated 恒为 Local Owner；这里仍显式 fail-closed，
  // 防止将来 visitor 上下文被误用于读取 owner 的 EvidenceStore 主体。
  if (auth.context.mode !== "owner") {
    return errorResponse(403, "FORBIDDEN", "仅 Owner 可查看已有手工附件。");
  }

  const batchId = new URL(request.url).searchParams.get("batchId")?.trim() ?? "";
  if (!batchId || batchId.length > 128) {
    return errorResponse(400, "BATCH_ID_REQUIRED", "batchId 必填且长度必须合法。");
  }

  try {
    const store = getProductBatchStore(auth.context);
    const batch = await store.getBatch(batchId);
    if (!batch) return errorResponse(404, "BATCH_NOT_FOUND", "商品批次不存在。");
    const items = await store.getBatchItems(batchId);

    const asins = [...new Set(items
      .filter((item) => !item.archivedAt
        && typeof item.asin === "string"
        && /^[A-Z0-9]{10}$/iu.test(item.asin.trim()))
      .map((item) => item.asin!.trim().toUpperCase()))];
    const marketplace = /^[A-Z]{2}$/u.test((batch.marketplace ?? "").trim().toUpperCase())
      ? batch.marketplace.trim().toUpperCase()
      : "US";

    /**
     * run 只用于拿查询级主体键；读取失败不影响商品级主体展示（fail-soft）。
     * 不调用任何推进/写入方法。
     */
    let run: BatchCaptureRun | null = null;
    try {
      run = await createBatchCaptureRunService({ database: prisma as never })
        .status({ context: auth.context, batchId });
    } catch {
      run = null;
    }

    const subjects: ExternalEvidenceSubject[] = [];
    const failures: ExternalEvidenceFailure[] = [];

    // ① 商品级：每个 ASIN 只读一次主体，再按模块分组，避免 N×2 次文件扫描。
    await mapWithConcurrency(asins, 8, async (asin) => {
      const subjectKey = `amazon:${marketplace}:${asin}`;
      try {
        const reading = await readV3ModuleEvidence({ context: auth.context, subjectKey });
        for (const moduleId of PRODUCT_LEVEL_MODULES) {
          const matches = reading.modules.filter((evidence) => evidence.module === moduleId);
          subjects.push({
            subjectKey,
            module: moduleId,
            attachmentCount: matches.length,
            // readV3ModuleEvidence 已按 capturedAt 倒序；没有附件时为 null（不伪造时间）。
            latestCapturedAt: matches[0]?.capturedAt ?? null,
          });
        }
      } catch (error) {
        failures.push({ subjectKey, module: null, message: optionalMessage(error) });
        for (const moduleId of PRODUCT_LEVEL_MODULES) {
          subjects.push({ subjectKey, module: moduleId, attachmentCount: 0, latestCapturedAt: null });
        }
      }
    });

    // ② 查询级：querySubjectKey 由 run 回执提供（sellersprite:<marketplace>:<module>:<fingerprint>）。
    const querySubjects = new Map<string, { subjectKey: string; module: V3ModuleId }>();
    for (const query of run?.productMarketQueries ?? []) {
      if (!query.querySubjectKey) continue;
      querySubjects.set(`${QUERY_LEVEL_MODULES[0]}:${query.querySubjectKey}`, {
        subjectKey: query.querySubjectKey,
        module: QUERY_LEVEL_MODULES[0],
      });
    }
    for (const query of run?.keywordMiningQueries ?? []) {
      if (!query.querySubjectKey) continue;
      querySubjects.set(`${QUERY_LEVEL_MODULES[1]}:${query.querySubjectKey}`, {
        subjectKey: query.querySubjectKey,
        module: QUERY_LEVEL_MODULES[1],
      });
    }
    for (const entry of querySubjects.values()) {
      try {
        const reading = await readV3ModuleEvidence({
          context: auth.context,
          subjectKey: entry.subjectKey,
          module: entry.module,
        });
        subjects.push({
          subjectKey: entry.subjectKey,
          module: entry.module,
          attachmentCount: reading.modules.length,
          latestCapturedAt: reading.modules[0]?.capturedAt ?? null,
        });
      } catch (error) {
        failures.push({ subjectKey: entry.subjectKey, module: entry.module, message: optionalMessage(error) });
        subjects.push({ subjectKey: entry.subjectKey, module: entry.module, attachmentCount: 0, latestCapturedAt: null });
      }
    }

    // 稳定顺序：商品级主体在前（按 subjectKey/module），查询级主体在后；不受并发读取完成顺序影响。
    subjects.sort((left, right) => {
      const scopeDiff = Number(!isProductLevelModule(left.module)) - Number(!isProductLevelModule(right.module));
      if (scopeDiff !== 0) return scopeDiff;
      return left.subjectKey.localeCompare(right.subjectKey) || left.module.localeCompare(right.module);
    });

    const withAttachments = subjects.filter((subject) => subject.attachmentCount > 0);
    const sumBy = (predicate: (subject: ExternalEvidenceSubject) => boolean): number =>
      subjects.filter(predicate).reduce((sum, subject) => sum + subject.attachmentCount, 0);
    const countBy = (predicate: (subject: ExternalEvidenceSubject) => boolean): number =>
      withAttachments.filter(predicate).length;

    return NextResponse.json({
      ok: true,
      data: {
        batchId,
        runId: run?.runId ?? null,
        subjects,
        totals: {
          /** 至少有一个附件的主题数（面板里的「已有 N 个附件」以 attachmentCount 为准）。 */
          subjectCount: withAttachments.length,
          checkedSubjectCount: subjects.length,
          attachmentCount: sumBy(() => true),
          productSubjectCount: countBy((subject) => isProductLevelModule(subject.module)),
          productAttachmentCount: sumBy((subject) => isProductLevelModule(subject.module)),
          querySubjectCount: countBy((subject) => !isProductLevelModule(subject.module)),
          queryAttachmentCount: sumBy((subject) => !isProductLevelModule(subject.module)),
          failedSubjectCount: failures.length,
          failures: failures.slice(0, 20),
          checkedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
