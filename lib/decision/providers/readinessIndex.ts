/**
 * lib/decision/providers/readinessIndex.ts
 *
 * Readiness Provider 注册表（与旧 decisionEngine 的 Provider 注册表平行，互不影响）。
 *
 * 解析结果完全由 `readJevReadinessPolicy` 决定：
 * - 未配置 / 未知值 / 未确认预算 / 未允许离线 → unavailable（不伪造、不自动退回 Mock）；
 * - typesafe 当前固定 fail-closed：需完成可执行的费用硬门禁与真实协议验证后才能开放；
 * - offline 仅在 JEV_READINESS_ALLOW_OFFLINE=true（测试显式标记）时可用。
 *
 * 业务层只通过本工厂获取 Provider；禁止在服务代码中直接构造具体 Provider。
 */
import "server-only";

import type { ReadinessAdviceProvider } from "@/lib/decision/readiness/types";
import { createOfflineAdviceProvider } from "@/lib/decision/readiness/offlineProvider";
import { readJevReadinessPolicy, type EnvLike, type JevReadinessProviderKind } from "@/lib/decision/readiness/policy";
import { TypeSafeReadinessProvider } from "@/lib/decision/providers/readinessTypesafeProvider";

export type ResolvedReadinessProvider = {
  readonly kind: JevReadinessProviderKind;
  readonly provider: ReadinessAdviceProvider;
  /** kind=unavailable 时的机器可读原因；可用时为 null。 */
  readonly reason: string | null;
};

/** 不可用占位 Provider：返回显式 unavailable 载荷，绝不发起任何请求。 */
export const unavailableReadinessProvider: ReadinessAdviceProvider = {
  providerId: "readiness-unavailable",
  async advise(input) {
    return {
      status: "unavailable",
      readiness: null,
      reviewQuestions: [],
      contradictions: [],
      missingEvidence: [],
      limitations: ["Jev readiness Provider 不可用（未配置或未授权）。"],
      inputBinding: { ...input.binding },
    };
  },
};

/** 解析当前配置下的 Readiness Provider。 */
export function getReadinessAdviceProvider(env: EnvLike = process.env): ResolvedReadinessProvider {
  const policy = readJevReadinessPolicy(env);
  if (policy.providerKind === "typesafe") {
    return { kind: "unavailable", provider: unavailableReadinessProvider, reason: "JEV_READINESS_REAL_PROVIDER_NOT_VERIFIED" };
  }
  if (policy.providerKind === "offline") {
    return { kind: "offline", provider: createOfflineAdviceProvider("ok"), reason: null };
  }
  return {
    kind: "unavailable",
    provider: unavailableReadinessProvider,
    reason: policy.providerReason ?? "JEV_READINESS_PROVIDER_NOT_CONFIGURED",
  };
}

/**
 * 为单次运行创建 Provider 实例（可选注入计量 fetch）。
 * - typesafe：返回带注入 fetchImpl 的新实例（运行时请求计量；协议未校准前其默认构造器
 *   仍不构造请求 → 不发起任何调用，实测 0 次）；
 * - 其他类型：原样返回（offline 桩零网络、unavailable 占位）。
 */
export function createReadinessProviderForRun(
  resolved: ResolvedReadinessProvider,
  options: { fetchImpl?: typeof fetch } = {},
): ReadinessAdviceProvider {
  if (resolved.kind === "typesafe" && options.fetchImpl) {
    return new TypeSafeReadinessProvider({ fetchImpl: options.fetchImpl });
  }
  return resolved.provider;
}
