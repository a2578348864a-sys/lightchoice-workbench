import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { collectAmazonSearchWithPlaywright, type AmazonSearchBrowserCollectionResult, type AmazonSearchPageCheckpoint } from "@/lib/server/captureRecipeBrowser";
import { createAmazonSearchProductBatch, type AmazonSearchEvidenceCheckpointRef } from "@/lib/server/amazonSearchProductBatchHandoff";
import { HARD_MAX_AUTHORIZED_ITEMS, deriveSearchPages } from "@/lib/server/batchCaptureRun";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";
import { prisma } from "@/lib/server/db";
import { hashJson } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEARCH_OPERATION = "source-layer:amazon-search-collection:v1";
const SEARCH_RESOURCE_KEY = "amazon-search";
const SEARCH_CHECKPOINT_SCHEMA = "amazon-search-operation-checkpoint.v1";
const OWNER_SCOPE = "owner:v1";

type SearchOperationJournal = {
  schemaVersion: typeof SEARCH_CHECKPOINT_SCHEMA;
  operationId: string;
  traceId: string;
  query: string;
  authorizedItemLimit: number;
  pages: Array<{
    page: number;
    state: "navigating" | "extracted" | "validated" | "evidence_persisted" | "blocked";
    pageStatus: string;
    observationCount: number;
    errorCode?: string;
    evidenceReferences: AmazonSearchEvidenceCheckpointRef[];
  }>;
  evidenceReferences: AmazonSearchEvidenceCheckpointRef[];
  navigationUsed: number;
  stage: "initialized" | "source_started" | "handoff_pending" | "complete" | "recovery_required";
  owner: { host: string; pid: number } | null;
  planSummary: { pageCount: number; totalObservationCount: number; pageStatuses: string[] } | null;
};

function parseJournal(value: string | null | undefined): SearchOperationJournal | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Partial<SearchOperationJournal>;
    if (row.schemaVersion !== SEARCH_CHECKPOINT_SCHEMA || typeof row.operationId !== "string"
      || typeof row.traceId !== "string" || !Array.isArray(row.pages) || !Array.isArray(row.evidenceReferences)
      || !Number.isSafeInteger(row.authorizedItemLimit) || !Number.isSafeInteger(row.navigationUsed)) return null;
    return row as SearchOperationJournal;
  } catch {
    return null;
  }
}

function operationOwnerAlive(owner: SearchOperationJournal["owner"]): boolean | null {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : null;
    return code === "ESRCH" ? false : null;
  }
}

function uniqueEvidenceReferences(references: readonly AmazonSearchEvidenceCheckpointRef[]): AmazonSearchEvidenceCheckpointRef[] {
  const byKey = new Map<string, AmazonSearchEvidenceCheckpointRef>();
  for (const reference of references) {
    const key = [reference.subjectKey, reference.evidenceVersion, reference.captureId, reference.evidenceId, reference.contentHash].join("\0");
    byKey.set(key, reference);
  }
  return [...byKey.values()];
}

function ownerScopeFor(context: { mode: string; demoAccessId?: string }): string {
  return context.mode === "owner" ? OWNER_SCOPE : `demo:${context.demoAccessId ?? "unknown"}`;
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");
  }
  const record = body as { query?: unknown; pages?: unknown; maxAppearances?: unknown; authorizedItemLimit?: unknown; operationId?: unknown };
  if (typeof record.query !== "string" || !record.query.trim()) {
    return errorResponse(400, "query_required", "搜索关键词不能为空。");
  }
  /**
   * 预算硬门禁：必须显式声明本次授权的商品数量上限。
   * 服务端**不会**默认使用 60 件 —— 缺失或非法一律 fail-closed，
   * 避免「前端未传数量」时静默采集远超授权范围的商品。
   */
  const authorizedItemLimit = record.authorizedItemLimit;
  if (typeof authorizedItemLimit !== "number" || !Number.isSafeInteger(authorizedItemLimit)
    || authorizedItemLimit < 1 || authorizedItemLimit > HARD_MAX_AUTHORIZED_ITEMS) {
    return errorResponse(400, "authorized_item_limit_required",
      `必须显式声明本次授权的商品数量上限（1–${HARD_MAX_AUTHORIZED_ITEMS}）；服务端不会默认任何数量。`);
  }
  // 由授权上限推导分页与样本上限，二者都不得超过它；授权数量 ≠ 无限翻页授权。
  const maxAppearances = authorizedItemLimit;
  const pages = deriveSearchPages(authorizedItemLimit);
  if (record.pages !== undefined && record.pages !== pages) {
    return errorResponse(400, "page_budget_conflict",
      `pages 必须与授权上限推导值一致（期望 ${pages}）。`);
  }
  if (record.maxAppearances !== undefined && record.maxAppearances !== maxAppearances) {
    return errorResponse(400, "sample_budget_conflict",
      `maxAppearances 必须等于授权上限（期望 ${maxAppearances}）。`);
  }

  const operationId = typeof record.operationId === "string" ? record.operationId.trim() : randomUUID();
  if (!/^[A-Za-z0-9_-]{8,100}$/u.test(operationId)) {
    return errorResponse(400, "operation_id_invalid", "搜索操作编号格式无效。请重新发起搜索。");
  }
  const actorScope = ownerScopeFor(auth.context);
  const requestHash = hashJson({ schemaVersion: SEARCH_CHECKPOINT_SCHEMA, query: record.query.trim(), authorizedItemLimit, pages, maxAppearances });
  const receiptWhere = {
    actorScope_operation_resourceKey_idempotencyKey: {
      actorScope,
      operation: SEARCH_OPERATION,
      resourceKey: SEARCH_RESOURCE_KEY,
      idempotencyKey: operationId,
    },
  };
  let receiptId: string | null = null;
  let journal: SearchOperationJournal | null = null;
  let recoveryOnly = false;
  try {
    const prior = await prisma.v5OperationReceipt.findUnique({ where: receiptWhere });
    if (prior) {
      if (prior.requestHash !== requestHash) return errorResponse(409, "AMAZON_SEARCH_IDEMPOTENCY_CONFLICT", "同一搜索操作编号不能用于不同关键词或授权数量。");
      journal = parseJournal(prior.responseJson);
      if (!journal) return errorResponse(409, "AMAZON_SEARCH_CHECKPOINT_UNREADABLE", "搜索操作回执无法安全读取；系统没有重新访问 Amazon。请查看批次与证据后再发起新的明确授权。");
      receiptId = prior.id;
      if (prior.status === "handoff_pending") {
        recoveryOnly = true;
      } else if (prior.status !== "processing") {
        const cached = (() => { try { return JSON.parse(prior.responseJson ?? "") as { httpStatus?: number; body?: unknown }; } catch { return null; } })();
        if (cached && Number.isInteger(cached.httpStatus) && cached.body) return NextResponse.json(cached.body, { status: cached.httpStatus });
        return errorResponse(409, "AMAZON_SEARCH_RESULT_UNAVAILABLE", "该搜索操作已结束，但最终回执不可用；没有重新访问 Amazon。请查看批次与证据。");
      } else {
        const alive = operationOwnerAlive(journal.owner);
        if (alive !== false) return errorResponse(409, alive === true ? "AMAZON_SEARCH_OPERATION_IN_PROGRESS" : "AMAZON_SEARCH_OWNER_UNVERIFIED", alive === true
          ? "同一搜索操作仍在执行；请稍后读取原结果，不要重复启动。"
          : "无法核实原搜索进程的主机与退出状态；系统没有重复搜索。请检查运行进程和批次状态。");
        if (journal.evidenceReferences.length === 0) {
          const responseBody = { ok: false, error: { status: "failed", code: "AMAZON_SEARCH_RECOVERY_REQUIRED", message: "原进程已退出，但没有可核验的已持久化 Evidence 引用；为避免重复访问或漏数，本次不会自动重搜。请查看搜索回执后再用新的操作编号明确重试。", traceId: journal.traceId, operationId } };
          journal.stage = "recovery_required";
          journal.owner = null;
          await prisma.v5OperationReceipt.updateMany({ where: { id: prior.id, status: "processing" }, data: { status: "blocked", responseJson: JSON.stringify({ ...journal, httpStatus: 409, body: responseBody }), errorCode: "AMAZON_SEARCH_RECOVERY_REQUIRED", updatedAt: new Date() } });
          return NextResponse.json(responseBody, { status: 409 });
        }
        recoveryOnly = true;
        journal.stage = "handoff_pending";
        journal.owner = null;
        const claimed = await prisma.v5OperationReceipt.updateMany({ where: { id: prior.id, status: "processing", updatedAt: prior.updatedAt }, data: { status: "handoff_pending", responseJson: JSON.stringify(journal), updatedAt: new Date() } });
        if (claimed.count !== 1) return errorResponse(409, "AMAZON_SEARCH_OPERATION_IN_PROGRESS", "搜索回执状态刚刚变化；请刷新后查看结果，没有启动新的搜索。");
      }
    } else {
      journal = {
        schemaVersion: SEARCH_CHECKPOINT_SCHEMA,
        operationId,
        traceId: newTraceId(),
        query: record.query.trim(),
        authorizedItemLimit,
        pages: [],
        evidenceReferences: [],
        navigationUsed: 0,
        stage: "initialized",
        owner: { host: hostname(), pid: process.pid },
        planSummary: null,
      };
      const created = await prisma.v5OperationReceipt.create({ data: {
        actorScope,
        operation: SEARCH_OPERATION,
        resourceKey: SEARCH_RESOURCE_KEY,
        idempotencyKey: operationId,
        requestHash,
        status: "processing",
        responseJson: JSON.stringify(journal),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      } });
      receiptId = created.id;
    }
    if (!journal || !receiptId) return errorResponse(500, "AMAZON_SEARCH_CHECKPOINT_FAILED", "无法建立搜索恢复回执；本次没有启动浏览器。");
    const traceId = journal.traceId;
    const persistJournal = async (status = "processing") => {
      if (!receiptId || !journal) return;
      await prisma.v5OperationReceipt.updateMany({
        where: { id: receiptId, status: { in: ["processing", "handoff_pending"] } },
        data: { status, responseJson: JSON.stringify(journal), updatedAt: new Date() },
      });
    };
    const persistPageCheckpoint = async (checkpoint: AmazonSearchPageCheckpoint) => {
      if (!journal) return;
      const existing = journal.pages.findIndex((entry) => entry.page === checkpoint.page);
      const normalized = { ...checkpoint, evidenceReferences: checkpoint.evidenceReferences.map((reference) => ({ ...reference })) };
      if (existing >= 0) journal.pages[existing] = normalized;
      else journal.pages.push(normalized);
      journal.pages.sort((a, b) => a.page - b.page);
      journal.evidenceReferences = uniqueEvidenceReferences(journal.pages.flatMap((entry) => entry.evidenceReferences));
      journal.navigationUsed = Math.max(journal.navigationUsed, checkpoint.page);
      const successfulPages = journal.pages.filter((entry) => entry.state === "validated" || entry.state === "evidence_persisted");
      journal.planSummary = {
        pageCount: successfulPages.length,
        totalObservationCount: successfulPages.reduce((sum, entry) => sum + entry.observationCount, 0),
        pageStatuses: successfulPages.map((entry) => entry.pageStatus),
      };
      await persistJournal();
    };
    let result: AmazonSearchBrowserCollectionResult;
    if (recoveryOnly) {
      result = {
        status: "captured",
        traces: [{ traceId, status: "completed" } as never],
        plan: journal.planSummary ? {
          schemaVersion: "amazon-search-capture-plan.v1",
          query: journal.query,
          pageCount: journal.planSummary.pageCount,
          totalObservationCount: journal.planSummary.totalObservationCount,
          pageStatuses: journal.planSummary.pageStatuses,
          emptyResultReason: null,
          observations: [],
        } : null,
        captures: [],
        partial: true,
        navigationUsed: journal.navigationUsed,
        pageCheckpoints: journal.pages,
        errorCode: null,
        errorMessage: null,
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      };
    } else {
      journal.stage = "source_started";
      await persistJournal();
      result = await collectAmazonSearchWithPlaywright({
        context: auth.context,
        query: journal.query,
        pages,
        maxAppearances,
        traceId,
        onPageCheckpoint: persistPageCheckpoint,
      });
      journal.navigationUsed = result.navigationUsed ?? journal.navigationUsed;
      if (result.plan) journal.planSummary = {
        pageCount: result.plan.pageCount,
        totalObservationCount: result.plan.totalObservationCount,
        pageStatuses: result.plan.pageStatuses,
      };
      if (result.pageCheckpoints) {
        for (const checkpoint of result.pageCheckpoints) {
          const existing = journal.pages.findIndex((entry) => entry.page === checkpoint.page);
          const normalized = { ...checkpoint, evidenceReferences: checkpoint.evidenceReferences.map((reference) => ({ ...reference })) };
          if (existing >= 0) journal.pages[existing] = normalized;
          else journal.pages.push(normalized);
        }
        journal.pages.sort((a, b) => a.page - b.page);
        journal.evidenceReferences = uniqueEvidenceReferences(journal.pages.flatMap((entry) => entry.evidenceReferences));
      }
      journal.stage = journal.evidenceReferences.length > 0 ? "handoff_pending" : "source_started";
      journal.owner = null;
      await persistJournal(journal.evidenceReferences.length > 0 ? "handoff_pending" : "processing");
    }
    if (result.status === "captured") {
      for (const capture of result.captures) {
        const firstItem = capture.capture.items[0] ?? null;
        await recordCaptureApiDiagnostic({
          context: auth.context,
          traceId: result.traces[0]?.traceId ?? capture.traceId,
          sourceType: capture.source,
          subjectKey: firstItem?.subjectKey ?? null,
          captureId: firstItem?.captureId ?? null,
          evidenceRefs: capture.capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
          contentHash: firstItem?.contentHash ?? null,
          status: "succeeded",
          reason: "Amazon search API completed after Capture Gateway persistence.",
        }).catch(() => undefined);
      }
      let productBatchHandoff;
      try {
        if (!result.plan || journal.evidenceReferences.length === 0) {
          throw new Error("SEARCH_EVIDENCE_CHECKPOINT_MISSING");
        }
        productBatchHandoff = await createAmazonSearchProductBatch({
          context: auth.context,
          query: result.plan?.query ?? record.query,
          traceId: result.traces[0]?.traceId ?? traceId,
          plan: result.plan,
          captures: result.captures,
          persistedEvidenceReferences: recoveryOnly ? journal.evidenceReferences : undefined,
          // 持久化搜索阶段导航回执，供后续 BCR 继承同一共享预算（不默认 0）。
          // 页数回执反映实际被访问的页面；采样上限提前满足时不虚增导航消耗。
          searchNavigationUsed: result.navigationUsed ?? journal.navigationUsed ?? result.plan?.pageCount ?? pages,
        });
      } catch {
        journal.stage = "handoff_pending";
        journal.owner = null;
        await persistJournal("handoff_pending").catch(() => undefined);
        console.error("[source-layer/amazon-search]", { traceId, code: "PRODUCT_BATCH_HANDOFF_FAILED", captured: true });
        return NextResponse.json({
          ok: false,
          data: { ...result, operationId, partial: true, productBatchHandoff: null,
            postWriteFailures: [...(result.postWriteFailures ?? []), { code: "PRODUCT_BATCH_HANDOFF_FAILED", subjectKey: null }] },
          error: {
            status: "failed",
            code: "PRODUCT_BATCH_HANDOFF_FAILED",
            message: "Amazon Search Evidence 已持久化，但商品批次交接失败；使用同一操作编号重试只会恢复交接，不会重新搜索。",
            traceId: result.traces[0]?.traceId ?? traceId,
            operationId,
          },
        }, { status: 500 });
      }
      /**
       * P0 解耦：搜索**只**保存证据并建立批次，不再自动创建任何后续采集任务。
       *
       * 变更原因：此前搜索成功后会立刻 start BatchCaptureRun 并 ensureRunning()，
       * 在用户尚未确认采集计划的情况下就发起商品级导航；同时旧 Detail Job 也保留了
       * autoEnqueue 意图，形成双任务权威。现在的正式流程是：
       *   Search → ProductBatch(ready) → 生成 MarketCapturePlan → **等待用户确认** → Capture Run。
       *
       * 因此这里只返回「需要确认」的状态与计划预览入口信息，不 start / 不 drive / 不入队。
       */
      const responseBody = {
        ok: true,
        data: {
          ...result,
          operationId,
          authorizedItemLimit,
          traceId: result.traces[0]?.traceId ?? result.captures[0]?.traceId ?? null,
          productBatchHandoff,
          detailEnrichmentJob: null,
          batchCaptureRun: null,
          // 批次已就绪但采集尚未授权：调用方必须显式获取并确认采集计划。
          capturePlan: {
            required: true,
            state: "WAITING_CAPTURE_PLAN",
            batchId: productBatchHandoff.batchId,
            previewPath: `/api/source-layer/capture-plan?batchId=${encodeURIComponent(productBatchHandoff.batchId ?? "")}`,
          },
        },
      };
      journal.stage = "complete";
      journal.owner = null;
      await prisma.v5OperationReceipt.updateMany({ where: { id: receiptId, status: { in: ["processing", "handoff_pending"] } }, data: {
        status: result.partial ? "partial" : "completed",
        errorCode: result.errorCode,
        responseJson: JSON.stringify({ ...journal, httpStatus: 201, body: responseBody }),
        updatedAt: new Date(),
      } });
      return NextResponse.json(responseBody, { status: 201 });
    }
    const failureBody = {
      ok: false,
      error: {
        status: result.status,
        code: result.errorCode ?? "amazon_search_collect_failed",
        message: result.errorMessage ?? "Amazon 市场搜索采集未完成。",
        traceId: result.traces[0]?.traceId ?? traceId,
        operationId,
        sessionDiagnostics: result.sessionDiagnostics ?? null,
      },
    };
    const hasEvidenceCheckpoint = journal.evidenceReferences.length > 0;
    journal.stage = hasEvidenceCheckpoint ? "handoff_pending" : "complete";
    journal.owner = null;
    await prisma.v5OperationReceipt.updateMany({ where: { id: receiptId, status: { in: ["processing", "handoff_pending"] } }, data: {
      status: hasEvidenceCheckpoint ? "handoff_pending" : "blocked",
      errorCode: result.errorCode,
      responseJson: JSON.stringify(hasEvidenceCheckpoint ? journal : { ...journal, httpStatus: result.status === "failed" ? 500 : 409, body: failureBody }),
      updatedAt: new Date(),
    } });
    return NextResponse.json(failureBody, { status: result.status === "failed" ? 500 : 409 });
  } catch (error) {
    const thrownCode = error instanceof Error && "code" in error
      ? String((error as Error & { code: unknown }).code)
      : "";
    const code = thrownCode === "PROFILE_BROWSER_CLOSE_FAILED" || thrownCode === "PROFILE_LOCK_OWNERSHIP_LOST"
      ? thrownCode
      : "amazon_search_collect_failed";
    const closeUnconfirmed = code === "PROFILE_BROWSER_CLOSE_FAILED" || code === "PROFILE_LOCK_OWNERSHIP_LOST";
    const traceId = journal?.traceId ?? "unavailable";
    const hasEvidenceCheckpoint = Boolean(journal?.evidenceReferences.length);
    const responseBody = {
      ok: false,
      error: {
        status: "failed",
        code: hasEvidenceCheckpoint ? "PRODUCT_BATCH_HANDOFF_FAILED" : code,
        message: closeUnconfirmed
          ? "Amazon 搜索浏览器未能确认关闭，Profile 锁已保留；请核对操作回执和已保存证据后再继续。"
          : hasEvidenceCheckpoint
            ? "Amazon 搜索 Evidence 已保存在操作回执中，但批次交接未完成；使用同一操作编号重试只会恢复交接，不会重新访问 Amazon。"
            : "Amazon 市场搜索发生异常。请先检查采集审计与已持久化证据，不要自动重试。",
        traceId,
        operationId,
      },
    };
    if (journal && receiptId) {
      journal.stage = hasEvidenceCheckpoint ? "handoff_pending" : "complete";
      journal.owner = null;
      await prisma.v5OperationReceipt.updateMany({ where: { id: receiptId, status: { in: ["processing", "handoff_pending"] } }, data: {
        status: hasEvidenceCheckpoint ? "handoff_pending" : "blocked",
        errorCode: hasEvidenceCheckpoint ? "PRODUCT_BATCH_HANDOFF_FAILED" : code,
        responseJson: JSON.stringify(hasEvidenceCheckpoint ? journal : { ...journal, httpStatus: 500, body: responseBody }),
        updatedAt: new Date(),
      } }).catch(() => undefined);
    }
    console.error("[source-layer/amazon-search]", { traceId, code: hasEvidenceCheckpoint ? "PRODUCT_BATCH_HANDOFF_FAILED" : code });
    return NextResponse.json(responseBody, { status: 500 });
  }
}
