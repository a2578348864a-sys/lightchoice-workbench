import { describe, expect, it } from "vitest";

import {
  JEV_READINESS_MAX_EXTERNAL_REQUESTS_PER_RUN,
  JEV_READINESS_RERUN_COOLDOWN_MS,
  JEV_READINESS_TIMEOUT_MS,
  readJevReadinessPolicy,
} from "@/lib/decision/readiness/policy";
import { getReadinessAdviceProvider } from "@/lib/decision/providers/readinessIndex";

const ENV_KEYS = [
  "JEV_READINESS_ENABLED",
  "JEV_READINESS_PROVIDER",
  "JEV_READINESS_ALLOW_OFFLINE",
  "JEV_READINESS_BUDGET_ACK",
  "JEV_READINESS_MAX_TOKENS",
  "TYPESAFE_API_KEY",
] as const;

function envOf(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>): Record<string, string | undefined> {
  return { ...overrides };
}

describe("Jev Readiness 生产策略（默认全关）", () => {
  it("空环境：默认关闭、Provider 缺失", () => {
    const policy = readJevReadinessPolicy(envOf({}));
    expect(policy.enabled).toBe(false);
    expect(policy.providerKind).toBe("unavailable");
    expect(policy.providerReason).toBe("JEV_READINESS_PROVIDER_NOT_CONFIGURED");
  });

  it("功能开关兼容任务书规定的 1 与显式 true；其他值仍关闭", () => {
    expect(readJevReadinessPolicy(envOf({ JEV_READINESS_ENABLED: "1" })).enabled).toBe(true);
    expect(readJevReadinessPolicy(envOf({ JEV_READINESS_ENABLED: "true" })).enabled).toBe(true);
    expect(readJevReadinessPolicy(envOf({ JEV_READINESS_ENABLED: "yes" })).enabled).toBe(false);
  });

  it("未知 Provider 值一律 unavailable（不猜、不退回 Mock）", () => {
    const policy = readJevReadinessPolicy(envOf({ JEV_READINESS_PROVIDER: "mock" }));
    expect(policy.providerKind).toBe("unavailable");
    expect(policy.providerReason).toBe("JEV_READINESS_PROVIDER_UNKNOWN");
  });

  it("typesafe：未确认预算 → 不可用（真实调用视为 BLOCKED）", () => {
    const policy = readJevReadinessPolicy(envOf({ JEV_READINESS_PROVIDER: "typesafe" }));
    expect(policy.providerKind).toBe("unavailable");
    expect(policy.providerReason).toBe("JEV_READINESS_BUDGET_NOT_ACKNOWLEDGED");
  });

  it("typesafe + 预算确认仍 fail-closed：人工确认不替代跨进程预算硬门禁", () => {
    const policy = readJevReadinessPolicy(envOf({ JEV_READINESS_PROVIDER: "typesafe", JEV_READINESS_BUDGET_ACK: "true" }));
    expect(policy.providerKind).toBe("unavailable");
    expect(policy.providerReason).toBe("JEV_READINESS_REAL_PROVIDER_NOT_VERIFIED");
    expect(policy.budgetAcknowledged).toBe(true);
  });

  it("offline：未显式允许（测试标记缺失）→ 不可用", () => {
    const policy = readJevReadinessPolicy(envOf({ JEV_READINESS_PROVIDER: "offline" }));
    expect(policy.providerKind).toBe("unavailable");
    expect(policy.providerReason).toBe("JEV_READINESS_OFFLINE_NOT_ALLOWED");
  });

  it("offline + ALLOW_OFFLINE=true → 解析为 offline（仅测试用途）", () => {
    const policy = readJevReadinessPolicy(envOf({ JEV_READINESS_PROVIDER: "offline", JEV_READINESS_ALLOW_OFFLINE: "true" }));
    expect(policy.providerKind).toBe("offline");
    expect(policy.allowOffline).toBe(true);
  });

  it("常量与 token 预算默认值", () => {
    expect(JEV_READINESS_MAX_EXTERNAL_REQUESTS_PER_RUN).toBe(1);
    expect(JEV_READINESS_RERUN_COOLDOWN_MS).toBe(60_000);
    expect(JEV_READINESS_TIMEOUT_MS).toBe(15_000);
  });
});

describe("Readiness Provider 注册表（工厂解析）", () => {
  it("默认环境 → unavailable，reason 为未配置", () => {
    const resolved = getReadinessAdviceProvider(envOf({}));
    expect(resolved.kind).toBe("unavailable");
    expect(resolved.reason).toBe("JEV_READINESS_PROVIDER_NOT_CONFIGURED");
  });

  it("typesafe + 预算确认但缺 Key → unavailable（真实 Provider 保持硬关闭）", () => {
    const resolved = getReadinessAdviceProvider(envOf({ JEV_READINESS_PROVIDER: "typesafe", JEV_READINESS_BUDGET_ACK: "true" }));
    expect(resolved.kind).toBe("unavailable");
    expect(resolved.reason).toBe("JEV_READINESS_REAL_PROVIDER_NOT_VERIFIED");
  });

  it("typesafe + 预算确认 + Key 仍保持 unavailable（真实协议/费用门禁未验证）", () => {
    const resolved = getReadinessAdviceProvider(envOf({
      JEV_READINESS_PROVIDER: "typesafe",
      JEV_READINESS_BUDGET_ACK: "true",
      TYPESAFE_API_KEY: "test-key-not-real",
    }));
    expect(resolved.kind).toBe("unavailable");
    expect(resolved.reason).toBe("JEV_READINESS_REAL_PROVIDER_NOT_VERIFIED");
    expect(resolved.provider.providerId).toBe("readiness-unavailable");
  });

  it("offline + ALLOW_OFFLINE=true → offline（offline-stub:ok）", () => {
    const resolved = getReadinessAdviceProvider(envOf({ JEV_READINESS_PROVIDER: "offline", JEV_READINESS_ALLOW_OFFLINE: "true" }));
    expect(resolved.kind).toBe("offline");
    expect(resolved.provider.providerId).toBe("offline-stub:ok");
  });
});
