import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/server/db";
import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { authResponse, jsonBody, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import { checkAmazonSessionReadiness } from "@/lib/server/amazonSessionReadiness";
import { resolveBatchSearchNavigationUsed } from "@/lib/server/batchCaptureSearchNavigation";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function service() {
  return createBatchCaptureRunService({
    database: prisma as never,
    // D2-1H：「继续」遇人工单元时真实复查 Amazon 登录环境（readiness 级）
    checkSessionReadiness: checkAmazonSessionReadiness,
  });
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  const params = new URL(request.url).searchParams;
  const batchId = params.get("batchId");
  try {
    if (params.get("history") === "1") {
      const runs = await service().listRuns({ context: auth.context, batchId });
      return NextResponse.json({ ok: true, data: { runs } });
    }
    let run = await service().status({ context: auth.context, batchId });
    // 只读回绑：历史 Run 搜索单元可能缺 evidenceId，而 EvidenceStore 已有合法搜索证据。
    // 不写库；避免把「回执未绑定」投影成「有效证据不足」。
    if (run && typeof batchId === "string" && batchId.trim()) {
      try {
        const store = getProductBatchStore(auth.context);
        const items = await store.getBatchItems(batchId.trim());
        const { readVerifiedAmazonSearchEvidence } = await import("@/lib/server/amazonSearchProductBatchHandoff");
        const { projectBatchCaptureRunSearchEvidence } = await import("@/lib/server/batchCaptureRunService");
        const verified = await readVerifiedAmazonSearchEvidence({ context: auth.context, items });
        const byAsin = new Map(verified.map((entry) => [entry.asin, entry.evidenceId]));
        run = projectBatchCaptureRunSearchEvidence(run, byAsin);
      } catch {
        // fail-soft：投影失败时保持原回执口径，不阻断只读状态接口。
      }
    }
    return NextResponse.json({ ok: true, data: { run } });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!sameOrigin(request)) {
    return NextResponse.json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, { status: 403 });
  }
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ ok: false, error: { code: "INVALID_INPUT", message: "请求体必须是 JSON object。" } }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const action = record.action;
    const api = service();
    if (action === "start") {
      const batchId = typeof record.batchId === "string" ? record.batchId : null;
      if (!batchId) return errorResponse(400, "batch_id_required", "必须提供 batchId。");
      /**
       * 搜索阶段导航消耗必须来自服务端持久化的批次回执，**绝不采信浏览器提交的数字**：
       * 否则用户传入 0 就能把已经发生的真实导航消耗清零。
       */
      let batch;
      try {
        batch = await getProductBatchStore(auth.context).getBatch(batchId);
      } catch {
        return errorResponse(409, "BATCH_LOOKUP_FAILED", "无法读取该商品批次，未创建运行。");
      }
      if (!batch) return errorResponse(404, "BATCH_NOT_FOUND", "商品批次不存在。");
      const searchNavigation = resolveBatchSearchNavigationUsed(batch);
      if (!searchNavigation.known) {
        return errorResponse(409, searchNavigation.code, searchNavigation.reason);
      }
      const result = await api.start({
        context: auth.context,
        batchId,
        authorizedItemLimit: record.authorizedItemLimit,
        allowedModules: record.allowedModules,
        maxItemsPerAdvance: record.maxItemsPerAdvance,
        searchEvidence: record.searchEvidence,
        // 只传服务端推导值；忽略客户端可能提交的任何 searchNavigationUsed。
        searchNavigationUsed: searchNavigation.used,
      });
      return NextResponse.json({
        ok: true,
        data: {
          ...result,
          searchNavigationProvenance: {
            provenance: searchNavigation.provenance,
            used: searchNavigation.used,
            reason: searchNavigation.reason,
          },
        },
      }, { status: result.created ? 201 : 200 });
    }
    if (action === "recover_stalled_execution") {
      /**
       * 人工确认恢复：只在「旧执行器生死未知」时使用。
       * 必须提供精确身份（runId / 运行代次 / 执行代次）与核对原因；
       * 普通按钮不能清空租约，任何身份不符一律拒绝。
       */
      const run = await api.recoverStalledExecution({
        context: auth.context,
        batchId: record.batchId,
        runId: record.runId,
        runGeneration: record.runGeneration,
        executionEpoch: record.executionEpoch,
        reason: record.reason,
      });
      return NextResponse.json({ ok: true, data: { run } });
    }
    if (action === "authorize_navigation_top_up") {
      /**
       * 导航预算追加授权：显式额度 + 必填用途 + 授权编号，全部写入 run 台账。
       * 不是取消上限：单次增量、总硬顶、执行中拒绝、owner 鉴权四重约束。
       */
      const run = await api.authorizeNavigationTopUp({
        context: auth.context,
        batchId: record.batchId,
        authorizationId: record.authorizationId,
        amount: record.amount,
        purpose: record.purpose,
      });
      return NextResponse.json({ ok: true, data: { run } });
    }
    if (action === "prepare_product_market_query") {
      const run = await api.prepareProductMarketQuery({
        context: auth.context,
        batchId: record.batchId,
        query: record.query,
      });
      return NextResponse.json({ ok: true, data: { run } });
    }
    if (action === "prepare_keyword_mining_query") {
      const run = await api.prepareKeywordMiningQuery({
        context: auth.context,
        batchId: record.batchId,
        query: record.keywordMiningQuery,
      });
      return NextResponse.json({ ok: true, data: { run } });
    }
    if (action === "advance") {
      const run = await api.advance({
        context: auth.context,
        batchId: record.batchId,
        maxItemsPerAdvance: record.maxItemsPerAdvance,
        allowRetry: record.allowRetry === true,
      });
      return NextResponse.json({ ok: true, data: { run } });
    }
    if (action === "drive") {
      try {
        const run = await api.drive({
          context: auth.context,
          batchId: record.batchId,
          maxSlices: typeof record.maxSlices === "number" ? record.maxSlices : undefined,
          allowRetry: record.allowRetry === true,
        });
        return NextResponse.json({ ok: true, data: { run } });
      } catch (error) {
        /**
         * 同步推进被拒绝（如环境门禁 LOCAL_ENVIRONMENT_REQUIRED）时，
         * 把原因持久化到 run（fail-soft）——否则「刷新后正确回显」只存在于内存态，
         * 用户重新打开面板就再也看不到为什么无法推进。
         * 错误仍按原样抛给调用方：控制流行为不变。
         */
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : null;
        if (code === "LOCAL_ENVIRONMENT_REQUIRED") {
          await api.noteExecutionBlocked({
            context: auth.context,
            batchId: record.batchId,
            code,
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    if (action === "pause" || action === "resume" || action === "cancel" || action === "retry") {
      const run = await api.control({ context: auth.context, batchId: record.batchId, action });
      /**
       * 成功进入可执行状态后立即有界启动执行器（resume / retry）：
       * - allowRetry=true：drive 才会把 failed_retryable 单元纳入本轮可执行集；
       * - 结果区分「已在运行 / 已启动 / 环境门禁 / 启动失败」，绝不吞掉错误后仍显示成功。
       */
      let drive: {
        started: boolean;
        alreadyRunning: boolean;
        runId: string | null;
        status: string | null;
        errorCode: string | null;
        message: string;
      } | null = null;
      const targetBatchId = typeof record.batchId === "string" && record.batchId.trim()
        ? record.batchId.trim()
        : null;
      const shouldDrive = (action === "resume" || action === "retry")
        && run.status === "RUNNING"
        && targetBatchId !== null;
      if (shouldDrive && targetBatchId) {
        const { getBatchCaptureRunExecutor } = await import("@/lib/server/batchCaptureRunExecutor");
        const executor = getBatchCaptureRunExecutor();
        try {
          const priorActive = typeof executor.isRunning === "function"
            ? executor.isRunning(run.runId)
            : false;
          const started = await executor.ensureRunning({
            context: auth.context,
            batchId: targetBatchId,
            ...(action === "retry" || run.retryAuthorized === true ? { allowRetry: true } : {}),
          });
          if (priorActive || (!started.started && started.status === "RUNNING" && !started.errorCode)) {
            drive = {
              started: false,
              alreadyRunning: true,
              runId: started.runId ?? run.runId,
              status: started.status ?? run.status,
              errorCode: null,
              message: "执行器已在推进该批次，未重复启动。",
            };
          } else if (started.started) {
            drive = {
              started: true,
              alreadyRunning: priorActive,
              runId: started.runId,
              status: started.status,
              errorCode: null,
              message: action === "retry"
                ? "重试已授权，执行器已启动并只推进符合条件的失败单元。"
                : "已继续，执行器已启动。",
            };
          } else if (started.errorCode) {
            const blockedMessage = started.errorCode === "LOCAL_ENVIRONMENT_REQUIRED"
              ? "执行器未能启动：本地采集环境未开启（LOCAL_ENVIRONMENT_REQUIRED）。任务状态已如实回写，请开启采集环境后重试。"
              : `执行器未能启动（${started.errorCode}）。`;
            drive = {
              started: false,
              alreadyRunning: false,
              runId: started.runId,
              status: started.status,
              errorCode: started.errorCode,
              message: blockedMessage,
            };
          } else {
            drive = {
              started: false,
              alreadyRunning: false,
              runId: started.runId,
              status: started.status,
              errorCode: "EXECUTOR_NOT_STARTED",
              message: `执行器未启动（当前状态 ${started.status ?? "未知"}）。任务状态已返回，请刷新后查看服务端回执。`,
            };
          }
        } catch (error) {
          const code = error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "EXECUTOR_START_FAILED";
          const message = error instanceof Error ? error.message : "执行器启动失败";
          drive = {
            started: false,
            alreadyRunning: false,
            runId: run.runId,
            status: run.status,
            errorCode: code,
            message,
          };
          // 仍返回已持久化的 control 结果，但把真实失败带给前端（HTTP 仍 200 + data.drive）。
        }
      }
      return NextResponse.json({ ok: true, data: { run, drive } });
    }
    return NextResponse.json({ ok: false, error: { code: "INVALID_ACTION", message: "任务操作无效。" } }, { status: 400 });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
