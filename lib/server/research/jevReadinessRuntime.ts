/**
 * Jev Research Readiness — 运行时护栏（进程内；本轮「最小无持久化」方案）。
 *
 * 职责（全部发生在**进入 Provider 之前**或复用既有隔离执行器内部机制）：
 * - 调用前拒绝：Idempotency-Key 重放、同版本重复请求命中会话缓存、强制重跑冷却；
 * - 单飞并发去重（复用 Spike `createReadinessCache` 的 in-flight 机制）；
 * - 最近结果记录（供详情读侧展示「已运行 / 已失效」），不写任何持久化存储。
 *
 * 明确边界（本轮如实声明）：
 * - 进程内限制 ≠ 跨进程 / 跨重启的全局硬预算；重启后计数与幂等均失效；
 * - 因此真实 TypeSafe Provider 在策略层保持 fail-closed；本运行时的单次计数只作观测与防误重试。
 */
import "server-only";

import { bindingKey, createCumulativeRequestTracker, createReadinessCache, createScopedRequestTracker, inputFingerprint } from "@/lib/decision/readiness/runner";
import { JEV_READINESS_MAX_EXTERNAL_REQUESTS_PER_RUN, JEV_READINESS_RERUN_COOLDOWN_MS, type JevReadinessProviderKind } from "@/lib/decision/readiness/policy";
import { createReadinessProviderForRun } from "@/lib/decision/providers/readinessIndex";
import type {
  JevReadinessInput,
  ReadinessAdviceProvider,
  ReadinessRunResult,
} from "@/lib/decision/readiness/types";

export type ReadinessPeek = {
  readonly result: ReadinessRunResult;
  readonly ranAt: number;
  /** 绑定四元组与输入指纹均与当前一致（True=当前有效；False=已失效）。 */
  readonly fresh: boolean;
};

export type GuardedReadinessOutcome =
  | { readonly ok: true; readonly result: ReadinessRunResult; readonly cached: boolean; readonly deduped: boolean; readonly replayed: boolean }
  | { readonly ok: false; readonly code: "JEV_READINESS_IDEMPOTENCY_CONFLICT" | "JEV_READINESS_RERUN_COOLDOWN"; readonly message: string };

type LastRunEntry = {
  readonly bindingKeyValue: string;
  readonly fingerprint: string;
  readonly result: ReadinessRunResult;
  readonly ranAt: number;
};

type IdempotencyEntry = { readonly fingerprint: string; readonly result: ReadinessRunResult };

const MAX_IDEMPOTENCY_ENTRIES = 64;

/** 创建独立运行时实例（测试可各自创建，互不污染）。 */
export function createJevReadinessRuntime() {
  const cache = createReadinessCache();
  const lastRuns = new Map<string, LastRunEntry>();
  const idempotency = new Map<string, IdempotencyEntry>();
  const activeRuns = new Map<string, Promise<ReadinessRunResult>>();

  const keyOf = (taskId: string, providerId: string) => `${taskId}::${providerId}`;

  function rememberIdempotency(key: string, fingerprint: string, result: ReadinessRunResult): void {
    idempotency.set(key, { fingerprint, result });
    while (idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = idempotency.keys().next().value;
      if (oldest === undefined) break;
      idempotency.delete(oldest);
    }
  }

  async function run(input: {
    readonly taskId: string;
    readonly input: JevReadinessInput;
    readonly provider: ReadinessAdviceProvider;
    readonly providerKind: JevReadinessProviderKind;
    readonly idempotencyKey: string;
    readonly forceRefresh: boolean;
    readonly now?: number;
  }): Promise<GuardedReadinessOutcome> {
    const nowMs = input.now ?? Date.now();
    const fingerprinted = inputFingerprint(input.input);
    const providerId = input.provider.providerId;
    const runKey = keyOf(input.taskId, providerId);
    const currentBindingKey = bindingKey(input.input.binding);
    const activeKey = `${runKey}::${currentBindingKey}::${fingerprinted}`;

    // 1) Idempotency-Key 重放：同 key + 同指纹直接返回历史结果；同 key 不同输入 → 拒绝。
    const replay = idempotency.get(input.idempotencyKey);
    if (replay) {
      if (replay.fingerprint !== fingerprinted) {
        return { ok: false, code: "JEV_READINESS_IDEMPOTENCY_CONFLICT", message: "同一 Idempotency-Key 已用于不同输入；已拒绝且未发起任何请求。" };
      }
      return { ok: true, result: replay.result, cached: true, deduped: false, replayed: true };
    }

    // The generic cache supports deliberate generation races for its own tests and callers.
    // The production Jev boundary serializes same-version work so concurrent tabs cannot
    // bypass the per-version rerun confirmation/cooldown contract.
    const active = activeRuns.get(activeKey);
    if (active) {
      const result = await active;
      rememberIdempotency(input.idempotencyKey, fingerprinted, result);
      return { ok: true, result, cached: false, deduped: true, replayed: false };
    }

    const last = lastRuns.get(runKey);

    // 2) 同版本（四元组 + 指纹一致）重复请求：优先返回会话缓存，不重复发起外部调用。
    if (!input.forceRefresh && last && last.bindingKeyValue === currentBindingKey && last.fingerprint === fingerprinted) {
      rememberIdempotency(input.idempotencyKey, fingerprinted, last.result);
      return { ok: true, result: last.result, cached: true, deduped: false, replayed: false };
    }

    // 3) 强制重跑冷却：同版本在冷却窗口内拒绝（不发起任何请求）。
    if (input.forceRefresh && last && last.bindingKeyValue === currentBindingKey && last.fingerprint === fingerprinted) {
      const elapsed = nowMs - last.ranAt;
      if (elapsed < JEV_READINESS_RERUN_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((JEV_READINESS_RERUN_COOLDOWN_MS - elapsed) / 1000);
        return { ok: false, code: "JEV_READINESS_RERUN_COOLDOWN", message: `同版本重跑冷却中：请约 ${waitSeconds} 秒后再试（本次未发起任何请求）。` };
      }
    }

    // 4) 请求计量（P0-D 诚实性）：
    //    - typesafe：计数 fetch + 累计请求计数器（真实计量 fetch 尝试次数；单飞场景可归属）；
    //    - offline：作用域计数器（离线桩实现零网络，由单元测试钉住 → 0 为实测值）。
    //    并发下不可归属时 observed() 返回 null → UI 显示「未测量」，绝不假装 0。
    let attemptCount = 0;
    const countingFetch: typeof fetch = (...args) => {
      if (attemptCount >= JEV_READINESS_MAX_EXTERNAL_REQUESTS_PER_RUN) {
        throw new Error("JEV_READINESS_EXTERNAL_REQUEST_LIMIT");
      }
      attemptCount += 1;
      return fetch(...args);
    };
    const runProvider = input.providerKind === "typesafe"
      ? createReadinessProviderForRun({ kind: "typesafe", provider: input.provider, reason: null }, { fetchImpl: countingFetch })
      : input.provider;
    const requestTracker = input.providerKind === "typesafe"
      ? createCumulativeRequestTracker(() => attemptCount)
      : createScopedRequestTracker().tracker;

    // 5) 执行（Spike 缓存负责单飞并发去重；Provider 失败由执行器映射为 failed，不重试）。
    const execution = cache.run({ input: input.input, provider: runProvider, requestTracker, forceRefresh: input.forceRefresh });
    const activeResult = execution.then((outcome) => outcome.result);
    activeRuns.set(activeKey, activeResult);
    let outcome: Awaited<typeof execution>;
    try {
      outcome = await execution;
    } finally {
      if (activeRuns.get(activeKey) === activeResult) activeRuns.delete(activeKey);
    }
    if (!outcome.cached && !outcome.deduped) {
      lastRuns.set(runKey, { bindingKeyValue: currentBindingKey, fingerprint: fingerprinted, result: outcome.result, ranAt: nowMs });
    }
    rememberIdempotency(input.idempotencyKey, fingerprinted, outcome.result);
    return { ok: true, result: outcome.result, cached: outcome.cached, deduped: outcome.deduped, replayed: false };
  }

  /** 读取最近一次运行（含失效判定）；只读、不触发任何调用。 */
  function peek(taskId: string, providerId: string, input: JevReadinessInput): ReadinessPeek | null {
    const entry = lastRuns.get(keyOf(taskId, providerId));
    if (!entry) return null;
    const fresh = entry.bindingKeyValue === bindingKey(input.binding) && entry.fingerprint === inputFingerprint(input);
    return { result: entry.result, ranAt: entry.ranAt, fresh };
  }

  function stats() {
    return {
      providerCalls: cache.providerCallCount(),
      cachedEntries: cache.cachedEntryCount(),
      inFlight: cache.inFlightCount(),
      lastRuns: lastRuns.size,
      idempotencyEntries: idempotency.size,
    };
  }

  return { run, peek, stats };
}

export type JevReadinessRuntime = ReturnType<typeof createJevReadinessRuntime>;

let defaultRuntime: JevReadinessRuntime | null = null;

/** 进程级默认实例（服务层使用；测试请用 createJevReadinessRuntime 自建实例）。 */
export function getJevReadinessRuntime(): JevReadinessRuntime {
  if (!defaultRuntime) defaultRuntime = createJevReadinessRuntime();
  return defaultRuntime;
}

/** 仅测试用：重置默认实例。 */
export function _resetJevReadinessRuntimeForTest(): void {
  defaultRuntime = null;
}
