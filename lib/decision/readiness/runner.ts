/**
 * Jev Research Readiness — 隔离执行器（最终收口版）
 *
 * 职责边界（本轮最重要的技术验收）：
 * - **只**运行 Research Readiness Advisory；
 * - 不调用 DeepSeek；不生成/刷新 Research Report 与 reportHash；不改写 Human Decision；
 *   不写 EvidenceStore；不写任何持久化状态。
 * - 失败一律映射为 failed / unavailable，绝不静默降级为桩成功。
 *
 * 注意：本模块不 import 任何 AI Provider 客户端、不 import v5ResearchService、
 * 不 import 数据库访问层 —— 这是「独立调用安全」的结构性保证。
 *
 * 历史修复沉淀：
 * - P0-1（输入指纹）：稳定规范化 + SHA-256（复用 lib/server/v5CanonicalHash），并拒绝会被静默丢失的类型。
 * - P0-1（请求计数）：作用域计数器 + **调用结束后**才读取，覆盖全部退出路径；并发不可归属时返回 null。
 * - P0-3（并发去重）→ 最终轮升级为「provider + 四元组 + 指纹 + 请求代次」。
 * - P1-1（失败缓存）：成功缓存只保存 available。
 * - P0-2（费用 vs 计量）：请求次数观测 ≠ 费用硬配额；本模块不实现任何配额或真实调用。
 */
import { hashJson } from "@/lib/server/v5CanonicalHash";
import type {
  JevReadinessInput,
  ReadinessAdviceProvider,
  ReadinessInputBinding,
  ReadinessRunResult,
  ReadinessSideEffects,
  RequestTracker,
} from "./types";
import { parseJevReadinessAdvice } from "./schema";

/** 四元组绑定比较：任一变化即视为 stale（不使用 TTL）。 */
export function isAdviceStale(adviceBinding: ReadinessInputBinding, current: ReadinessInputBinding): boolean {
  return adviceBinding.reportHash !== current.reportHash
    || adviceBinding.factHash !== current.factHash
    || adviceBinding.evidenceHash !== current.evidenceHash
    || adviceBinding.researchRevision !== current.researchRevision;
}

/** 绑定的稳定键（用于缓存/幂等，不包含时间） */
export function bindingKey(binding: ReadinessInputBinding): string {
  return [binding.reportHash ?? "-", binding.factHash ?? "-", binding.evidenceHash ?? "-", binding.researchRevision ?? "-"].join("|");
}

const MAX_FINGERPRINT_DEPTH = 12;

/**
 * 拒绝"会被静默丢失"的输入。`canonicalJson` 会把 undefined / 非有限数 / function / symbol / bigint
 * 归一成 "null" —— 业务字段悄悄变成这些类型而指纹不变，就会造成错误的缓存命中/去重。
 */
function assertFingerprintable(value: unknown, path = "$", depth = 0): void {
  if (depth > MAX_FINGERPRINT_DEPTH) throw new Error(`INPUT_TOO_DEEP:${path}`);
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new Error(`NON_FINITE_NUMBER:${path}`);
    return;
  }
  if (kind === "undefined" || kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new Error(`UNFINGERPRINTABLE:${path}:${kind}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFingerprintable(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (kind === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertFingerprintable(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`UNFINGERPRINTABLE:${path}:${kind}`);
}

/** 输入内容指纹：稳定规范化（递归键排序、数组保序）+ SHA-256。 */
export function inputFingerprint(input: JevReadinessInput): string {
  assertFingerprintable(input);
  return hashJson(input);
}

/* ────────────────────────────────────────────────────────────────
 * P0-1：请求计数器（作用域 / 全局累计）
 * ──────────────────────────────────────────────────────────────── */

/** 作用域计数器：并发下仍可可靠归属到具体调用。 */
export function createScopedRequestTracker() {
  const active: { local: { n: number } }[] = [];
  return {
    tracker: {
      kind: "scoped" as const,
      begin() {
        const entry = { local: { n: 0 } };
        active.push(entry);
        return {
          observed() {
            const index = active.indexOf(entry);
            if (index >= 0) active.splice(index, 1);
            return entry.local.n;
          },
        };
      },
    },
    /** 供真实 Provider 使用：任何通过它发出的请求计入当前活跃（栈顶）作用域 */
    scopedFetch: (..._args: unknown[]): never => {
      const top = active[active.length - 1];
      if (!top) throw new Error("REQUEST_NO_ACTIVE_SCOPE");
      top.local.n += 1;
      throw new Error("EXTERNAL_REQUEST_FORBIDDEN");
    },
    /** 供测试/离线桩模拟"本次调用确实发出了 N 次请求" */
    record(count = 1): void {
      const top = active[active.length - 1];
      if (!top) throw new Error("REQUEST_NO_ACTIVE_SCOPE");
      top.local.n += count;
    },
    activeScopeCount: () => active.length,
  };
}

/** 全局累计计数器：仅在单飞（无并发活跃作用域）时可归属，否则 observed() 返回 null。 */
export function createCumulativeRequestTracker(counter: () => number): RequestTracker {
  const active: { start: number }[] = [];
  return {
    kind: "cumulative",
    begin() {
      const entry = { start: counter() };
      active.push(entry);
      return {
        observed() {
          const index = active.indexOf(entry);
          if (index >= 0) active.splice(index, 1);
          if (active.length > 0) return null; // 仍有其他作用域活跃 → 无法可靠归属
          return Math.max(0, counter() - entry.start);
        },
      };
    },
  };
}

/* ────────────────────────────────────────────────────────────────
 * 执行器
 * ──────────────────────────────────────────────────────────────── */

/**
 * 执行一次 Research Readiness Advisory（纯函数式：无写入；外部请求由作用域计数器计量）。
 *
 * P0-1 关键：`observed()` 在 `provider.advise()` **返回或抛错之后**统一读取，
 * 覆盖成功 / failed / 抛异常 / 超时 / 429 / 500 全部退出路径。
 */
export async function runReadinessAdvisory(input: {
  readonly input: JevReadinessInput;
  readonly provider: ReadinessAdviceProvider;
  readonly requestTracker?: RequestTracker;
}): Promise<ReadinessRunResult> {
  const { input: readinessInput, provider, requestTracker } = input;
  const scope = requestTracker ? requestTracker.begin() : null;

  let raw: unknown;
  let thrown: unknown = null;
  try {
    raw = await provider.advise(readinessInput);
  } catch (error) {
    thrown = error;
  }

  // 无论成功、失败还是抛异常，都在调用结束后才读取（P0-1）
  const observed = scope ? scope.observed() : null;

  const sideEffects: ReadinessSideEffects = {
    // 结构性保证：本执行路径无 DeepSeek 依赖（见 import 守卫）
    deepseekInvoked: false,
    externalRequestAttempted: observed,
    stateWritten: false,
    reportRegenerated: false,
  };

  const base = {
    provider: provider.providerId,
    model: provider.model ?? null,
    generatedAt: new Date().toISOString(),
    sideEffects,
    sideEffectsVerification: observed === null ? "unverified" as const : "runtime_measured" as const,
    requestTrackerKind: requestTracker ? requestTracker.kind : ("none" as const),
    semanticSupport: "NOT_VERIFIED" as const,
  };

  if (thrown !== null) {
    const code = thrown instanceof Error && "code" in thrown ? String((thrown as { code?: unknown }).code) : "PROVIDER_THREW";
    return {
      ...base,
      status: "failed",
      advice: null,
      rejected: { reason: `PROVIDER_ERROR:${code}`, droppedQuestions: 0, droppedContradictions: 0, forbiddenFields: [], bindingMismatch: false },
      notes: [
        "Provider 抛出异常 → 映射为 failed；未降级为桩成功。",
        `外部请求观测（调用结束后读取）：${observed === null ? "未测量/无法归属" : `${observed} 次`}。`,
        "注意：请求次数观测不是费用硬配额；本模块不实现配额。",
      ],
    };
  }

  const parsed = parseJevReadinessAdvice(raw, readinessInput);
  if (!parsed.ok) {
    return {
      ...base,
      status: "failed",
      advice: null,
      rejected: {
        reason: parsed.reason,
        droppedQuestions: parsed.droppedQuestions,
        droppedContradictions: parsed.droppedContradictions,
        forbiddenFields: parsed.forbiddenFields,
        bindingMismatch: parsed.bindingMismatch,
      },
      notes: [
        "输出未通过契约校验 → 整份拒收并映射为 failed。",
        `外部请求观测（调用结束后读取）：${observed === null ? "未测量/无法归属" : `${observed} 次`}。`,
      ],
    };
  }

  const notes: string[] = [];
  if (parsed.droppedQuestions > 0 || parsed.droppedContradictions > 0) {
    notes.push(`拒收条目：问题 ${parsed.droppedQuestions} 条 / 矛盾 ${parsed.droppedContradictions} 条（引用不在白名单或文本为空）。`);
  }
  notes.push("引用合法性已机械校验；引用是否支持该描述属语义问题，离线无法判定 → NOT_VERIFIED。");
  notes.push(`外部请求观测（调用结束后读取）：${observed === null ? "未测量/无法归属" : `${observed} 次`}。`);
  if (observed === null) {
    notes.push("未获得可归属的作用域计量 → 不得据此声称零外部请求。");
  }

  return {
    ...base,
    status: parsed.advice.status,
    advice: parsed.advice,
    rejected: {
      reason: null,
      droppedQuestions: parsed.droppedQuestions,
      droppedContradictions: parsed.droppedContradictions,
      forbiddenFields: [],
      bindingMismatch: false,
    },
    notes,
  };
}

/* ────────────────────────────────────────────────────────────────
 * 缓存 + 幂等 + 并发去重 + 请求代次（P0-2）
 * ──────────────────────────────────────────────────────────────── */

type CacheEntry = {
  readonly fingerprint: string;
  readonly result: ReadinessRunResult;
  readonly generation: number;
};

type InFlightEntry = {
  readonly generation: number;
  readonly promise: Promise<ReadinessRunResult>;
};

/**
 * 进程内 Advisory 缓存。
 *
 * Key = `providerId :: bindingKey(四元组) :: inputFingerprint(完整输入)`。
 *
 * 读取语义（明确且一致）：**先加入最新 in-flight（拿到最新代次结果），再读缓存。**
 *
 * 代次规则（P0-2）：
 * - 每次 `forceRefresh`（或首次执行）都会为该 Key 分配一个新的、单调递增的 generation；
 * - 较旧代次的请求完成后**不得覆盖**较新代次写入的缓存；
 * - 较旧代次的请求完成后**不得删除**较新代次安装的 in-flight；
 * - 失败刷新不把旧结果伪装为新结果（失败本就未产生新结果，旧缓存保持原状但会被标注为上一代）。
 */
export function createReadinessCache() {
  const byKey = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  const latestGeneration = new Map<string, number>();
  let epoch = 0;
  let providerCalls = 0;

  const compositeKey = (providerId: string, input: JevReadinessInput) =>
    `${providerId}::${bindingKey(input.binding)}::${inputFingerprint(input)}`;

  return {
    async run(input: {
      input: JevReadinessInput;
      provider: ReadinessAdviceProvider;
      requestTracker?: RequestTracker;
      forceRefresh?: boolean;
    }): Promise<{ result: ReadinessRunResult; cached: boolean; deduped: boolean }> {
      const key = compositeKey(input.provider.providerId, input.input);

      if (!input.forceRefresh) {
        const pending = inFlight.get(key);
        if (pending) return { result: await pending.promise, cached: false, deduped: true };
        const existing = byKey.get(key);
        if (existing) return { result: existing.result, cached: true, deduped: false };
      }

      epoch += 1;
      const generation = epoch;
      latestGeneration.set(key, generation);
      providerCalls += 1;

      const promise = runReadinessAdvisory({
        input: input.input,
        provider: input.provider,
        requestTracker: input.requestTracker,
      });
      const entry: InFlightEntry = { generation, promise };
      inFlight.set(key, entry);

      try {
        const result = await promise;
        // 仅当代次仍是该 Key 的最新代次时才允许写缓存：旧请求不得覆盖较新刷新结果
        if (latestGeneration.get(key) === generation) {
          if (result.status === "available" && result.advice?.status === "available") {
            byKey.set(key, { fingerprint: inputFingerprint(input.input), result, generation });
          }
        }
        return { result, cached: false, deduped: false };
      } finally {
        // 只清理自己安装的、且未被更新代次取代的 in-flight
        if (inFlight.get(key) === entry && latestGeneration.get(key) === generation) {
          inFlight.delete(key);
        }
      }
    },

    /** 读取缓存（不触发请求）；绑定或指纹不符、或条目已被更新代次取代时返回 null。 */
    peek(input: JevReadinessInput, providerId: string): ReadinessRunResult | null {
      const key = compositeKey(providerId, input);
      const existing = byKey.get(key);
      if (!existing) return null;
      if (latestGeneration.get(key) !== existing.generation) return null;
      if (existing.result.advice && isAdviceStale(existing.result.advice.inputBinding, input.binding)) return null;
      return existing.result;
    },

    providerCallCount: () => providerCalls,
    cachedEntryCount: () => byKey.size,
    inFlightCount: () => inFlight.size,
    /** 当前 Key 的最新代次（测试用） */
    latestGenerationOf: (input: JevReadinessInput, providerId: string) => latestGeneration.get(compositeKey(providerId, input)) ?? null,
  };
}
