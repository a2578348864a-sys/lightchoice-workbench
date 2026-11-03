import type { AccessContext } from "@/lib/server/accessPassword";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/server/db";
import {
  createBatchCaptureRunService,
  type BatchCaptureRunService,
} from "@/lib/server/batchCaptureRunService";
import type { BatchCaptureRun } from "@/lib/server/batchCaptureRun";
import { isBatchCaptureScopeAllowed } from "@/lib/server/acquisitionScope";

/**
 * 批次自动采集「有界可靠执行器」。
 *
 * 约束（与 AGENTS / P0 指令一致）：
 * - **不是全局 Scheduler**：只推进调用方显式授权的 batchId/runId，绝不扫描/领取其他批次或历史 Job。
 * - **不是不受控的 HTTP fire-and-forget**：每个 run 至多一个在进程内的有界循环，
 *   由数据库运行租约（V5OperationReceipt.expiresAt）兜底保证「同批次同代次仅一个合法执行者」；
 *   进度每片持久化，暂停/中止立即停止；进程退出后由下一次 ensureRunning 从持久化断点续跑。
 * - 预算有界：maxSlices 与 run.maxItemsPerAdvance 双重夹紧。
 */

const TERMINAL_STATUSES = ["PAUSED", "CANCELLED", "COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED"];

export type BatchCaptureRunExecutorDeps = {
  service?: BatchCaptureRunService;
  env?: () => NodeJS.ProcessEnv;
  /** 单次 ensureRunning 触发的最大片数（有界预算）。 */
  maxSlices?: number;
  onError?: (info: { batchId: string; runId: string | null; code: string; errorName: string | null; message: string }) => void;
};

export type BatchCaptureRunExecutor = {
  ensureRunning(input: { context: AccessContext; batchId: string; allowRetry?: boolean }): Promise<{
    started: boolean;
    runId: string | null;
    status: string | null;
    /** 启动被同步拒绝时的稳定错误码（如 LOCAL_ENVIRONMENT_REQUIRED）；正常启动或终态为 null。 */
    errorCode?: string | null;
  }>;
  isRunning(runId: string): boolean;
  activeCount(): number;
  /** 等待所有在跑的执行结束（测试与关闭时使用）。 */
  waitForIdle(): Promise<void>;
};

export function createBatchCaptureRunExecutor(deps: BatchCaptureRunExecutorDeps = {}): BatchCaptureRunExecutor {
  const service = deps.service ?? createBatchCaptureRunService({ database: prisma as never });
  const env = deps.env ?? (() => process.env);
  const maxSlices = deps.maxSlices ?? 240;
  const active = new Map<string, Promise<void>>();

  async function ensureRunning(input: { context: AccessContext; batchId: string; allowRetry?: boolean }): Promise<{
    started: boolean;
    runId: string | null;
    status: string | null;
    errorCode?: string | null;
  }> {
    let run: BatchCaptureRun | null = null;
    try {
      run = await service.getRun(input.batchId);
    } catch {
      return { started: false, runId: null, status: null, errorCode: null };
    }
    if (!run) return { started: false, runId: null, status: null, errorCode: null };
    if (TERMINAL_STATUSES.includes(run.status)) return { started: false, runId: run.runId, status: run.status, errorCode: null };
    if (active.has(run.runId)) return { started: false, runId: run.runId, status: run.status, errorCode: null };

    /**
     * 环境门禁预检（同步）。
     *
     * drive() 的第一道门禁就是 LOCAL_ACQUISITION_ENABLED。若在这里异步启动后才失败，
     * 错误只会进入进程日志（历史缺陷：界面显示「已启动 / 等待启动」永远不变、无原因）。
     * 预检失败时：同步持久化 run 级回执（noteExecutionBlocked，fail-soft），
     * 并如实返回 started:false + errorCode —— 绝不伪装成「已启动」。
     */
    const envNow = env();
    if (envNow.LOCAL_ACQUISITION_ENABLED !== "true") {
      const blockedCode = "LOCAL_ENVIRONMENT_REQUIRED";
      if (typeof service.noteExecutionBlocked === "function") {
        await service.noteExecutionBlocked({
          context: input.context,
          batchId: input.batchId,
          runId: run.runId,
          code: blockedCode,
        }).catch(() => undefined);
      }
      return { started: false, runId: run.runId, status: run.status, errorCode: blockedCode };
    }
    // 运行范围门禁：缺省只允许单 ASIN 采集。在租约与 worker 启动之前直接返回，
    // 不写任何业务回执，也不占用执行代次。
    if (!isBatchCaptureScopeAllowed(envNow)) {
      return {
        started: false,
        runId: run.runId,
        status: run.status,
        errorCode: "BATCH_CAPTURE_SCOPE_DISABLED",
      };
    }

    const runId = run.runId;
    /**
     * 执行器自己持有租约令牌：停止确认必须绑定「运行代次 + 执行代次 + 租约所有者」，
     * 否则普通 API 调用可以伪造「执行器已退出」。
     */
    const leaseOwner = `drive-${randomUUID()}`;
    const task = (async () => {
      /**
       * 本代次实际持有的执行代次号。
       *
       * 根因修复：以前 finally 只在 PAUSED/CANCELLED 时确认停止。执行器以
       * `PARTIAL`（预算耗尽 / 仍有达重试上限的失败）或 `COMPLETED` 正常结束时，
       * 代次永远不被确认，`executionEpoch > acknowledgedEpoch` 一直成立，
       * 于是「追加导航预算」「恢复」都会被 `BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN` 拦住，
       * 必须人工 `recover_stalled_execution` 才能继续 —— 这是可用性缺陷，不是安全门禁。
       *
       * 这里记录**自己**的代次号（来自 drive 的返回值），而不是无条件读最新值：
       * 若期间已有新代次接手，用旧代次号去确认会绑定失败并被服务端拒绝，
       * 从而保证「旧执行器不得确认或覆盖新代次」。
       */
      let observedEpoch: number | null = null;
      try {
        const settled = await service.drive({
          context: input.context,
          batchId: input.batchId,
          env: env(),
          maxSlices,
          /**
           * 「一次启动 → 自动推进」：默认允许**有界自动重试**（attempts < MAX、受预算与门禁约束）。
           * 之前这里写 `=== true`：调用方不显式传参时把 drive 的自动重试默认值又关掉了，
           * 真实续采因此只推 6 片就停在 PARTIAL，3 个可重试单元没有被重试。
           * 只有调用方明确 allowRetry:false 才禁用。
           */
          allowRetry: input.allowRetry !== false,
          leaseOwner,
        });
        observedEpoch = typeof settled?.executionEpoch === "number" ? settled.executionEpoch : null;
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "BATCH_CAPTURE_DRIVE_FAILED";
        /**
         * 把异步失败持久化到 run（fail-soft）：否则 run 停在原状态且无任何痕迹，
         * 用户与刷新后的系统都无法知道「为什么没有被推进」。
         */
        if (typeof service.noteExecutionBlocked === "function") {
          await service.noteExecutionBlocked({
            context: input.context,
            batchId: input.batchId,
            runId,
            code,
          }).catch(() => undefined);
        }
        deps.onError?.({
          batchId: input.batchId,
          runId,
          code,
          errorName: error instanceof Error ? error.name : null,
          message: error instanceof Error ? error.message : String(error),
        });
        // 进程内循环已退出，但状态可能停在 PAUSED/CANCELLED；读回真实状态以决定是否确认停止。
        const latest = await service.getRun(input.batchId).catch(() => null);
        observedEpoch = latest?.executionEpoch ?? null;
      } finally {
        /**
         * 事实 B/B'：只有执行器真正退出循环（不再发起新导航）时才确认「已停止」，
         * 并据此安全释放租约（事实 C）。UI 不应仅凭 status=PAUSED/CANCELLED 就宣称已停止。
         *
         * **任何结束形态都要确认**：正常终态（COMPLETED / PARTIAL / FAILED / HUMAN_REQUIRED）、
         * 控制态（PAUSED / CANCELLED）与异常退出都必须关闭本代次，否则预算追加与恢复会被永久阻塞。
         * 服务端 `acknowledgeStop` 会校验 runId + 执行代次 + 租约所有者三元绑定：
         * 绑定不成立（例如已有新代次接手）时它自己会拒绝关闭，因此旧执行器不可能覆盖新代次。
         */
        if (observedEpoch !== null && typeof service.acknowledgeStop === "function") {
          await service.acknowledgeStop({
            context: input.context,
            batchId: input.batchId,
            runId,
            executionEpoch: observedEpoch,
            leaseOwner,
          }).catch(() => undefined);
        }
        active.delete(runId);
      }
    })();
    active.set(runId, task);
    return { started: true, runId, status: run.status, errorCode: null };
  }

  return {
    ensureRunning,
    isRunning: (runId: string) => active.has(runId),
    activeCount: () => active.size,
    waitForIdle: async () => {
      // 允许执行过程中再次入队，循环直到无活跃任务。
      while (active.size > 0) {
        await Promise.all([...active.values()]);
      }
    },
  };
}

let singleton: BatchCaptureRunExecutor | null = null;

/**
 * 结构化诊断：只记录可安全外传的字段（batchId / runId / errorCode / 阶段 / 时间）。
 * 绝不写入 Cookie、Token、代理凭据或页面内容。
 */
export type BatchCaptureRunDriveDiagnostic = {
  stage: "drive";
  batchId: string;
  runId: string | null;
  errorCode: string;
  errorName: string | null;
  message: string;
  timestamp: string;
};

/** 明显的凭据形态：先整体打码，再限长。 */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /(bearer\s+)[A-Za-z0-9._\-]+/giu,
  /((?:cookie|set-cookie|authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|passwd|pwd|proxy[_-]?auth)\s*[=:]\s*)[^\s;,]+/giu,
  /([?&](?:token|key|secret|signature|sig|password)=)[^&\s]+/giu,
];

/**
 * 脱敏 + 限长：先对明显的凭据形态整体打码，再过滤不可打印字符。
 * 不输出 Cookie / Token / 代理密钥等敏感数据。
 */
export function sanitizeDriveMessage(raw: string): string {
  let text = String(raw ?? "");
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  const kept = (text.match(/[\u4e00-\u9fa5A-Za-z0-9\s，。：；、（）()《》\-_.:;,'"!?/\\\[\]]/gu) ?? []).join("");
  return kept.replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** 进程级单例（生产路径使用）；测试请用 createBatchCaptureRunExecutor 注入依赖。 */
export function getBatchCaptureRunExecutor(): BatchCaptureRunExecutor {
  if (!singleton) {
    singleton = createBatchCaptureRunExecutor({
      onError: ({ batchId, runId, code, errorName, message }) => {
        // 静默失败曾导致：真实环境里 drive 抛错却没有任何日志或用户可见状态。
        const diagnostic: BatchCaptureRunDriveDiagnostic = {
          stage: "drive",
          batchId,
          runId,
          errorCode: code,
          errorName,
          message: sanitizeDriveMessage(message),
          timestamp: new Date().toISOString(),
        };
        console.error("[batch-capture-run-executor]", JSON.stringify(diagnostic));
      },
    });
  }
  return singleton;
}
