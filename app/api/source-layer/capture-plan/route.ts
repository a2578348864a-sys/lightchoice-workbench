import { NextRequest, NextResponse } from "next/server";

import { isBatchCaptureScopeAllowed } from "@/lib/server/acquisitionScope";

import { prisma } from "@/lib/server/db";
import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { authResponse, jsonBody, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { V5CoreError } from "@/lib/server/v5CoreCommon";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { resolveBatchSearchNavigationUsed } from "@/lib/server/batchCaptureSearchNavigation";
import {
  MarketCapturePlanError,
  deriveAuthoritativeMarketCapturePlan,
  isMarketCaptureStrategyId,
  type MarketCaptureModuleId,
  type MarketCapturePlan,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 市场采集计划（Market Capture Plan）—— 预览与一次确认。
 *
 *   GET  ?batchId=...&strategyId=...&marketTargetItemCount=...   只读预览，不启动采集
 *   POST { batchId, strategyId, marketTargetItemCount, planFingerprint }
 *        用户明确确认后：服务端重算权威计划 → 比对指纹 → 创建 Capture Run → 有界驱动
 *
 * 边界：
 * - 计划永远由**服务端**依据可信批次与实际能力重算；客户端提交的计划内容一律不作为权威；
 * - 唯一的客户端输入是「策略 + 目标数量（+ 可选授权数量）」，其余（预算、模块矩阵、导航上限）服务端推导；
 * - 重复确认幂等：同一计划指纹复用同一运行代次；指纹不同一律拒绝，不悄悄沿用旧授权；
 * - 预览与确认都**不访问** Amazon / SellerSprite。
 */

const STRATEGY_SET = ["full_market_capture", "quick_market_scan"] as const;

const CONFLICT_PLAN_CODES = new Set([
  "capture_plan_capacity_empty",
  "capture_plan_navigation_exceeds_budget",
  "capture_plan_module_coverage_invalid",
]);

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * 计划推导错误 → 稳定的业务错误码。
 * 策略层抛出的 `MarketCapturePlanError` 必须被翻译成明确原因，
 * 不能退化成 INTERNAL_ERROR（否则用户看不到「为什么不能建计划」）。
 */
function planAwareErrorResponse(error: unknown): NextResponse {
  if (error instanceof MarketCapturePlanError) {
    const status = CONFLICT_PLAN_CODES.has(error.code) ? 409 : 400;
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message, retryable: false, conflict: status === 409 } },
      { status },
    );
  }
  return v5ErrorResponse(error);
}

type BatchPlanContext = {
  batchId: string;
  batchCapacity: number;
  searchNavigationUsed: number;
  searchNavigationKnown: boolean;
  searchNavigationCode: string | null;
  searchNavigationReason: string | null;
  batchSourceType: string | null;
};

/**
 * 已存在 Capture Run 的只读摘要。
 * 只含「计划绑定 + 控制状态」事实，不含任何采集进度或证据断言——
 * 真实来源采集状态始终以 BatchCaptureRun 面板的回执与 Evidence 为准。
 */
type ExistingRunSummary = {
  runId: string;
  status: string;
  /** 绑定的计划指纹；旧代次（无计划绑定）为 null。 */
  planFingerprint: string | null;
  planStrategyId: string | null;
  authorizedItemLimit: number;
};

/**
 * 从可信批次推导计划输入。
 * 批次容量 = 未归档且有合法 ASIN 的**去重**条目数（与 Capture Run 的可执行集合同口径）。
 */
async function loadPlanContext(
  context: Parameters<typeof getProductBatchStore>[0],
  batchId: string,
): Promise<BatchPlanContext> {
  const store = getProductBatchStore(context);
  const batch = await store.getBatch(batchId).catch(() => null);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "商品批次不存在。", 404);
  if (batch.batchStatus !== "ready") {
    throw new V5CoreError("BATCH_NOT_READY", "只有 ready 批次可以生成采集计划。", 409);
  }
  const items = await store.getBatchItems(batchId);
  const asins = [...new Set(
    items
      .filter((item) => !item.archivedAt && typeof item.asin === "string" && /^[A-Z0-9]{10}$/iu.test(item.asin.trim()))
      .map((item) => item.asin!.trim().toUpperCase()),
  )];
  const navigation = resolveBatchSearchNavigationUsed(batch);
  let batchSourceType: string | null = null;
  try {
    const parsed = JSON.parse(batch.normalizedSnapshotJson ?? "{}") as Record<string, unknown>;
    batchSourceType = typeof parsed.sourceType === "string" ? parsed.sourceType : null;
  } catch {
    batchSourceType = null;
  }
  return {
    batchId,
    batchCapacity: asins.length,
    // 预览容忍未知（按 0 显示）；真正创建运行前会再次 fail-closed 校验。
    searchNavigationUsed: navigation.known ? navigation.used : 0,
    searchNavigationKnown: navigation.known,
    searchNavigationCode: navigation.known ? null : navigation.code,
    searchNavigationReason: navigation.known ? null : navigation.reason,
    batchSourceType,
  };
}

/**
 * 计划 → Capture Run 的模块矩阵（**始终全部八模块**）。
 *
 * 为什么把未自动接线 / 本轮不安排的模块也传入：用户要求的「八模块矩阵」必须出现在
 * **最终覆盖报告**里，不能因为某模块没有 Worker 或本轮抽样策略不安排它，就从任务中消失。
 * 服务端会为它们建立 `source_input_required` 单元格（终态、无证据），因此它们既不会被推进，
 * 也永远不会被显示为已完成 —— 这比直接丢掉它们更诚实。
 */
function runMatrixModulesOf(plan: MarketCapturePlan): MarketCaptureModuleId[] {
  return plan.entries.map((entry) => entry.module);
}

function normalizeTargetCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new V5CoreError("MARKET_TARGET_COUNT_INVALID", "市场目标数量必须是 ≥ 0 的整数。", 400);
  }
  return parsed;
}

function normalizeAuthorizedCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new V5CoreError("MARKET_AUTHORIZED_COUNT_INVALID", "授权商品数量必须是 ≥ 1 的整数。", 400);
  }
  return parsed;
}

function requireBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "必须提供有效的 batchId。", 400);
  }
  return value.trim();
}

function requireStrategyId(value: unknown) {
  if (!isMarketCaptureStrategyId(value)) {
    throw new V5CoreError(
      "MARKET_STRATEGY_INVALID",
      `必须选择已冻结的采集策略（${STRATEGY_SET.join(" / ")}）。`,
      400,
    );
  }
  return value;
}

function normalizeSupplementalParam(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new V5CoreError("MARKET_SUPPLEMENTAL_MODULES_INVALID", "补充能力参数格式无效。", 400);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  const params = new URL(request.url).searchParams;
  try {
    const batchId = requireBatchId(params.get("batchId"));
    const strategyId = requireStrategyId(params.get("strategyId"));
    const context = await loadPlanContext(auth.context, batchId);
    const plan = deriveAuthoritativeMarketCapturePlan({
      strategyId,
      batchId,
      batchCapacity: context.batchCapacity,
      marketTargetItemCount: normalizeTargetCount(params.get("marketTargetItemCount")),
      authorizedItemCount: normalizeAuthorizedCount(params.get("authorizedItemCount")),
      searchNavigationUsed: context.searchNavigationUsed,
      includedSupplementalModules: normalizeSupplementalParam(params.get("supplementalModules")),
    });
    /**
     * 只读透出已存在的 Capture Run 摘要（不创建、不驱动）。
     * 目的：让计划面板在刷新后仍能如实显示「当前已确认策略 / 任务状态」，
     * 并把「Run 控制状态」与「真实来源采集状态」分开表述。
     * 读取失败时不阻塞预览，但必须标记为未知，面板不得把未知显示成「计划待确认」。
     */
    let existingRun: ExistingRunSummary | null = null;
    let existingRunReadFailed = false;
    try {
      const { createBatchCaptureRunService } = await import("@/lib/server/batchCaptureRunService");
      const service = createBatchCaptureRunService({ database: prisma as never });
      const run = await service.status({ context: auth.context, batchId });
      existingRun = run
        ? {
            runId: run.runId,
            status: run.status,
            planFingerprint: run.planFingerprint ?? null,
            planStrategyId: run.planStrategyId ?? null,
            authorizedItemLimit: run.authorizedItemLimit,
          }
        : null;
    } catch {
      existingRunReadFailed = true;
    }
    return NextResponse.json({
      ok: true,
      data: {
        plan,
        batchContext: {
          batchId: context.batchId,
          batchCapacity: context.batchCapacity,
          batchSourceType: context.batchSourceType,
          searchNavigationUsed: context.searchNavigationUsed,
          searchNavigationKnown: context.searchNavigationKnown,
        },
        existingRun,
        existingRunReadFailed,
        // 运行范围：批量计划确认是否被允许。前端据此禁用确认按钮并给出准确原因，
        // 不自行猜测服务端权限；服务端 start() 仍会独立校验（双保险）。
        acquisition: { batchCaptureScopeAllowed: isBatchCaptureScopeAllowed() },
        // 明确告知：预览不启动任何采集，也不写入任何证据。
        previewOnly: true,
      },
    });
  } catch (error) {
    return planAwareErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } },
      { status: 403 },
    );
  }
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "INVALID_INPUT", "请求体必须是 JSON object。");
    }
    const record = body as Record<string, unknown>;
    const batchId = requireBatchId(record.batchId);
    const strategyId = requireStrategyId(record.strategyId);
    const context = await loadPlanContext(auth.context, batchId);
    if (!context.searchNavigationKnown) {
      // 搜索阶段导航不可核验时不得创建运行（不伪造、不默认 0）。
      throw new V5CoreError(
        context.searchNavigationCode ?? "BATCH_SEARCH_NAVIGATION_UNKNOWN",
        context.searchNavigationReason ?? "无法核验搜索阶段导航消耗，已拒绝创建采集任务。",
        409,
      );
    }
    const navigationUsed = context.searchNavigationUsed;

    // 服务端权威重算：客户端不能提交预算、模块矩阵或导航上限。
    const plan = deriveAuthoritativeMarketCapturePlan({
      strategyId,
      batchId,
      batchCapacity: context.batchCapacity,
      marketTargetItemCount: normalizeTargetCount(record.marketTargetItemCount),
      authorizedItemCount: normalizeAuthorizedCount(record.authorizedItemCount),
      searchNavigationUsed: navigationUsed,
      includedSupplementalModules: Array.isArray(record.supplementalModules)
        ? record.supplementalModules
        : [],
    });

    /**
     * 指纹比对：用户确认的就是页面上看到的那个计划。
     * 若目标数量 / 授权数量 / 批次容量在确认期间变化，服务端重算后的指纹会不同，
     * 此处一律拒绝，强制用户看到新计划后重新确认（不会悄悄按更大的范围采集）。
     */
    const submittedFingerprint = record.planFingerprint;
    if (typeof submittedFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(submittedFingerprint)) {
      throw new V5CoreError("MARKET_PLAN_FINGERPRINT_REQUIRED", "确认时必须提交所确认计划的指纹。", 400);
    }
    if (submittedFingerprint !== plan.planFingerprint) {
      throw new V5CoreError(
        "MARKET_PLAN_FINGERPRINT_MISMATCH",
        "确认的计划与当前批次实际可执行的计划不一致（目标数量、授权数量或批次容量已变化），请刷新后重新确认。",
        409,
        false,
        true,
        { currentPlanFingerprint: plan.planFingerprint },
      );
    }

    const { createBatchCaptureRunService } = await import("@/lib/server/batchCaptureRunService");
    const { getBatchCaptureRunExecutor } = await import("@/lib/server/batchCaptureRunExecutor");
    const { readVerifiedAmazonSearchEvidence } = await import("@/lib/server/amazonSearchProductBatchHandoff");
    const service = createBatchCaptureRunService({ database: prisma as never });

    // 搜索阶段证据：创建 Run 时必须把 EvidenceStore 已有引用绑到搜索单元，
    // 否则矩阵会显示「有效证据 < 批次商品数」（回执未绑定，被误读成无证据）。
    const planItems = await getProductBatchStore(auth.context).getBatchItems(batchId).catch(() => []);
    const planSearchEvidence = (await readVerifiedAmazonSearchEvidence({ context: auth.context, items: planItems }))
      .map((entry) => ({ asin: entry.asin, evidenceRef: entry.evidenceId }));

    const started = await service.start({
      context: auth.context,
      batchId,
      authorizedItemLimit: plan.authorizedItemCount,
      allowedModules: runMatrixModulesOf(plan),
      searchNavigationUsed: navigationUsed,
      searchEvidence: planSearchEvidence,
      planFingerprint: plan.planFingerprint,
      planStrategyId: plan.strategyId,
    });

    /**
     * 回读校验（必须在启动执行器**之前**）：运行必须绑定到刚刚确认的计划指纹。
     * 绑定失败即拒绝推进，避免「按 A 计划授权、却按 B 计划执行」。
     */
    if (started.run.planFingerprint !== plan.planFingerprint) {
      throw new V5CoreError(
        "BATCH_CAPTURE_PLAN_BINDING_FAILED",
        "采集任务未能绑定到所确认的计划，已停止推进；请刷新后重试。",
        500,
      );
    }

    /**
     * 一次确认 → 自动推进：只在「已确认的计划」范围内启动有界执行器。
     * 不是全局 Scheduler，也不会扫描历史批次；来源前置门禁仍由执行器内部逐模块判断。
     *
     * 失败如实回报：执行器的同步预检（如 LOCAL_ACQUISITION_ENABLED 门禁）会返回
     * started:false + errorCode，这里必须透传到 driveError，供前端显示真实原因——
     * 不得把「创建成功」显示成「执行成功」。
     */
    let drive: { started: boolean; runId: string | null; status: string | null } | null = null;
    let driveError: string | null = null;
    if (started.run.status !== "CANCELLED" && started.run.status !== "FAILED") {
      try {
        const driveResult = await getBatchCaptureRunExecutor().ensureRunning({ context: auth.context, batchId });
        drive = { started: driveResult.started, runId: driveResult.runId, status: driveResult.status };
        driveError = driveResult.errorCode ?? null;
      } catch (error) {
        driveError = error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "BATCH_CAPTURE_DRIVE_FAILED";
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        plan,
        run: started.run,
        created: started.created,
        drive,
        driveError,
        // 再确认一次：创建运行本身不访问任何外部来源。
        sourceAccess: "NONE",
      },
    }, { status: started.created ? 201 : 200 });
  } catch (error) {
    return planAwareErrorResponse(error);
  }
}
