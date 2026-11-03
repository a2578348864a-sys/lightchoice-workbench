import "server-only";

import { createMonitoringRepository, type MonitoringRepository, type MonitoringWatchTarget } from "@/lib/server/continuousMonitoringRepository";
import { isContinuousMonitoringRetired } from "@/lib/server/continuousMonitoringRetirement";
import { runMonitoringTarget } from "@/lib/server/continuousMonitoringService";

export type MonitoringSchedulerDependencies = {
  repository?: MonitoringRepository;
  runTarget?: (watchTargetId: string) => Promise<unknown>;
  now?: () => Date;
  intervalMs?: number;
  schedulePolling?: boolean;
};

/**
 * 最近一次 tick 的可观测事实。
 * 只记录机器可读的原因码与计数，绝不记录 provider/浏览器细节、用户数据或凭据。
 */
export type MonitoringSchedulerTickState = {
  lastTickAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickStatus: "ok" | "error" | null;
  /** 机器原因码，例如 tick_failed / watch_run_failed。 */
  lastTickError: string | null;
  lastTickWatchCount: number | null;
  lastTickFailureCount: number | null;
};

export function createContinuousMonitoringScheduler(dependencies: MonitoringSchedulerDependencies = {}) {
  const repository = dependencies.repository ?? createMonitoringRepository();
  const now = dependencies.now ?? (() => new Date());
  const intervalMs = dependencies.intervalMs ?? 60_000;
  const runTarget = dependencies.runTarget ?? ((watchTargetId: string) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }));
  let started = false;
  let recoveryComplete = false;
  let tickInFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let tickState: MonitoringSchedulerTickState = {
    lastTickAt: null,
    lastTickFinishedAt: null,
    lastTickStatus: null,
    lastTickError: null,
    lastTickWatchCount: null,
    lastTickFailureCount: null,
  };

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    const startedAt = now().toISOString();
    let watchCount = 0;
    let failureCount = 0;
    let tickError: string | null = null;
    try {
      if (!recoveryComplete) {
        await repository.recoverInterruptedRuns(now().toISOString());
        recoveryComplete = true;
      }
      const due: MonitoringWatchTarget[] = await repository.listDueWatches(now());
      watchCount = due.length;
      for (const watch of due) {
        try {
          await runTarget(watch.id);
        } catch {
          // The run service persists the failure whenever its run has been claimed.
          // Scheduler logs intentionally omit provider/browser details and user data.
          failureCount += 1;
        }
      }
    } catch {
      // Keep the executor alive; a later poll retries DB recovery/read without mutating Evidence.
      tickError = "tick_failed";
    } finally {
      tickInFlight = false;
      tickState = {
        lastTickAt: startedAt,
        lastTickFinishedAt: now().toISOString(),
        lastTickStatus: tickError === null ? "ok" : "error",
        lastTickError: tickError ?? (failureCount > 0 ? "watch_run_failed" : null),
        lastTickWatchCount: watchCount,
        lastTickFailureCount: failureCount,
      };
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      if (dependencies.schedulePolling !== false) {
        timer = setInterval(() => { void tick(); }, intervalMs);
        timer.unref();
      }
      queueMicrotask(() => { void tick(); });
    },
    async runDueNow(): Promise<void> {
      await tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },
    getState(): {
      started: boolean;
      recoveryComplete: boolean;
      tickInFlight: boolean;
      tick: MonitoringSchedulerTickState;
    } {
      return { started, recoveryComplete, tickInFlight, tick: { ...tickState } };
    },
  };
}
type SchedulerGlobal = typeof globalThis & {
  __continuousMonitoringScheduler?: ReturnType<typeof createContinuousMonitoringScheduler>;
};

/** Called from Next.js instrumentation once per Node server process. */
export async function startContinuousMonitoringScheduler(): Promise<void> {
  // V6 退役硬门禁：即使调用方绕过配置判断，也不注册任何自动执行实例。
  if (isContinuousMonitoringRetired()) return;
  const globalState = globalThis as SchedulerGlobal;
  if (globalState.__continuousMonitoringScheduler) return;
  const scheduler = createContinuousMonitoringScheduler();
  globalState.__continuousMonitoringScheduler = scheduler;
  await scheduler.start();
}

/**
 * Single source of truth for the opt-in gate. `instrumentation.ts` and the read-only
 * status probe must agree, otherwise the UI could claim a scheduler that never starts.
 *
 * V6 退役：持续监控调度器永久关闭。保留原有环境变量判断以便历史配置兼容，
 * 但无论 `V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER` 如何设置都不会再启动。
 */
export function continuousMonitoringSchedulerConfigEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isContinuousMonitoringRetired()) return false;
  return env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER === "1"
    && env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER !== "1";
}

export type ContinuousMonitoringSchedulerRuntimeState = {
  status: "running" | "not_started";
  started: boolean;
  recoveryComplete: boolean;
  tickInFlight: boolean;
  lastTickAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickStatus: "ok" | "error" | null;
  lastTickError: string | null;
  lastTickWatchCount: number | null;
  lastTickFailureCount: number | null;
};

/**
 * Reads the scheduler instance registered on this process's globalThis. Returns null when
 * no instance exists, which means instrumentation never started it in this process.
 * Callers must report `not_started`, never `running`, in that case.
 */
export function readContinuousMonitoringSchedulerRuntimeState(): ContinuousMonitoringSchedulerRuntimeState | null {
  const scheduler = (globalThis as SchedulerGlobal).__continuousMonitoringScheduler;
  if (!scheduler) return null;
  const state = scheduler.getState();
  return {
    status: state.started ? "running" : "not_started",
    started: state.started,
    recoveryComplete: state.recoveryComplete,
    tickInFlight: state.tickInFlight,
    lastTickAt: state.tick.lastTickAt,
    lastTickFinishedAt: state.tick.lastTickFinishedAt,
    lastTickStatus: state.tick.lastTickStatus,
    lastTickError: state.tick.lastTickError,
    lastTickWatchCount: state.tick.lastTickWatchCount,
    lastTickFailureCount: state.tick.lastTickFailureCount,
  };
}
