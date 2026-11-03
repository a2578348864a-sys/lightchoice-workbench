/**
 * lib/decision/providers/index.ts
 *
 * Provider 注册表与工厂。
 *
 * 根据 DECISION_PROVIDER 环境变量选择 provider 实例。
 * 调用方只需 import { getDecisionProvider }，业务层对具体 provider 完全透明。
 *
 * 支持的 DECISION_PROVIDER 值：
 * - "mock"：仅非生产环境显式使用
 * - "typesafe"：TypeSafe AI (Jev) 真实 API
 * - 默认/生产误配：unavailable（不伪造 Jev 结果）
 */
import "server-only";

import type { DecisionProvider } from "@/lib/decision/types";
import { MockDecisionProvider } from "@/lib/decision/providers/mockProvider";
import { TypeSafeDecisionProvider } from "@/lib/decision/providers/typesafeProvider";
import { buildFailedDecision } from "@/lib/decision/schemas/productDecision";

export type SupportedDecisionProviderId = "mock" | "typesafe" | "unavailable";

const unavailableProvider: DecisionProvider = {
  providerId: "unavailable",
  async analyzeProduct() {
    return buildFailedDecision("unavailable", "not-configured");
  },
  async analyzeResearchPriority() {
    return buildFailedDecision("unavailable", "not-configured");
  },
};

/** 已注册的 provider 工厂 */
const PROVIDER_REGISTRY: Record<SupportedDecisionProviderId, () => DecisionProvider> = {
  mock: () => new MockDecisionProvider(),
  typesafe: () => new TypeSafeDecisionProvider(),
  unavailable: () => unavailableProvider,
};

/** 解析当前配置的 provider ID */
function resolveProviderId(): SupportedDecisionProviderId {
  const raw = process.env["DECISION_PROVIDER"]?.trim().toLowerCase();
  if (raw === "typesafe") return "typesafe";
  // Mock 只能在非生产环境显式启用；生产缺省/误配均保持可见的 unavailable。
  if (raw === "mock" && process.env.NODE_ENV !== "production") return "mock";
  return "unavailable";
}

// 单例缓存（进程内复用）
let _cachedProvider: DecisionProvider | null = null;
let _cachedProviderId: string | null = null;

/**
 * 获取当前配置的 DecisionProvider 实例。
 * 业务层通过 decisionEngine.ts 调用，不应直接使用本函数。
 */
export function getDecisionProvider(): DecisionProvider {
  const id = resolveProviderId();
  if (_cachedProvider && _cachedProviderId === id) {
    return _cachedProvider;
  }
  const factory = PROVIDER_REGISTRY[id];
  _cachedProvider = factory();
  _cachedProviderId = id;
  return _cachedProvider;
}

/**
 * 仅测试用：重置 provider 缓存（允许在测试中切换 provider）。
 */
export function _resetProviderCacheForTest(): void {
  _cachedProvider = null;
  _cachedProviderId = null;
}
