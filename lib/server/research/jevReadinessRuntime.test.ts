import { afterEach, describe, expect, it, vi } from "vitest";

import { createJevReadinessRuntime } from "@/lib/server/research/jevReadinessRuntime";
import type { JevReadinessInput, ReadinessAdviceProvider } from "@/lib/decision/readiness/types";
import { createOfflineAdviceProvider, TransportFailure } from "@/lib/decision/readiness/offlineProvider";

function fixtureInput(overrides: Partial<JevReadinessInput> = {}): JevReadinessInput {
  return {
    schema: "jev-readiness-input.v1",
    taskId: "task-1",
    asin: "B0TEST0001",
    binding: { reportHash: "r1", factHash: "f1", evidenceHash: "e1", researchRevision: 1 },
    riskGateSummary: null,
    missingInformation: ["基础事实·品牌"],
    decisionSummary: null,
    verifiedNarratives: [{ text: "有证据的结论", evidenceRefs: ["attachment:att-1"] }],
    unverifiedNarratives: [],
    voc: null,
    vocRefResolution: { strategy: "externalContentId_to_observation_evidenceRefs", mappedThemeRefs: 0, unmappedRefs: [], downgradedThemes: [] },
    allowedEvidenceRefs: ["attachment:att-1"],
    fieldPresence: { bsr: "missing" },
    ...overrides,
  };
}

function okAdvicePayload(input: JevReadinessInput): unknown {
  return {
    status: "available",
    readiness: "NEED_MORE_EVIDENCE",
    reviewQuestions: [{ text: "复核问题", evidenceRefs: ["attachment:att-1"] }],
    contradictions: [],
    missingEvidence: ["BSR"],
    limitations: ["离线桩不判定语义支持"],
    inputBinding: { ...input.binding },
  };
}

/** 计数 Provider：记录 advise 调用次数，可注入返回/抛错。 */
function countedProvider(impl: (input: JevReadinessInput) => Promise<unknown> | unknown): {
  provider: ReadinessAdviceProvider;
  calls: () => number;
} {
  let calls = 0;
  return {
    provider: {
      providerId: "counted-test-provider",
      async advise(input) {
        calls += 1;
        return impl(input);
      },
    },
    calls: () => calls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JevReadinessRuntime — 费用前置拦截与去重（P0-D）", () => {
  it("首次运行：调用 1 次；同版本重复请求命中会话缓存（0 次新调用）", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async (input) => okAdvicePayload(input));
    const input = fixtureInput();

    const first = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.result.status).toBe("available");
      expect(first.cached).toBe(false);
      expect(first.replayed).toBe(false);
    }
    expect(counted.calls()).toBe(1);

    const second = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k2", forceRefresh: false, now: 2_000 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.cached).toBe(true);
    expect(counted.calls()).toBe(1); // 未重复扣减
  });

  it("同一 Idempotency-Key 重放：返回原结果且不新增调用；不同输入复用同 Key → 冲突拒绝", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async (input) => okAdvicePayload(input));
    const input = fixtureInput();

    const first = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "same-key", forceRefresh: false, now: 1_000 });
    expect(first.ok).toBe(true);
    const replay = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "same-key", forceRefresh: false, now: 1_100 });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(counted.calls()).toBe(1);

    const differentInput = fixtureInput({ binding: { reportHash: "r2", factHash: "f1", evidenceHash: "e1", researchRevision: 2 } });
    const conflict = await runtime.run({ taskId: input.taskId, input: differentInput, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "same-key", forceRefresh: false, now: 1_200 });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("JEV_READINESS_IDEMPOTENCY_CONFLICT");
    expect(counted.calls()).toBe(1);
  });

  it("强制重跑冷却：同版本冷却窗口内拒绝（0 次新调用）；冷却结束后才允许重跑", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async (input) => okAdvicePayload(input));
    const input = fixtureInput();

    await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });
    expect(counted.calls()).toBe(1);

    const withinCooldown = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k2", forceRefresh: true, now: 30_000 });
    expect(withinCooldown.ok).toBe(false);
    if (!withinCooldown.ok) expect(withinCooldown.code).toBe("JEV_READINESS_RERUN_COOLDOWN");
    expect(counted.calls()).toBe(1);

    const afterCooldown = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k3", forceRefresh: true, now: 61_001 });
    expect(afterCooldown.ok).toBe(true);
    if (afterCooldown.ok) expect(afterCooldown.cached).toBe(false);
    expect(counted.calls()).toBe(2);
  });

  it("并发同输入：单飞去重，只发起 1 次 Provider 调用", async () => {
    const runtime = createJevReadinessRuntime();
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    const counted = countedProvider(async (input) => {
      await gate;
      return okAdvicePayload(input);
    });
    const input = fixtureInput();

    const p1 = runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "c1", forceRefresh: false, now: 1_000 });
    const p2 = runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "c2", forceRefresh: false, now: 1_000 });
    resolveGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(counted.calls()).toBe(1);
  });

  it("冷却结束后的并发确认重跑仍单飞，只发起 1 次 Provider 调用", async () => {
    const runtime = createJevReadinessRuntime();
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    let providerInvocations = 0;
    const counted = countedProvider(async (input) => {
      providerInvocations += 1;
      if (providerInvocations === 2) await gate;
      return okAdvicePayload(input);
    });
    const input = fixtureInput();

    await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "initial", forceRefresh: false, now: 1_000 });
    expect(counted.calls()).toBe(1);

    const first = runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "rerun-1", forceRefresh: true, now: 62_000 });
    await Promise.resolve();
    const second = runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "rerun-2", forceRefresh: true, now: 62_000 });
    resolveGate();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) expect(secondResult.deduped).toBe(true);
    expect(counted.calls()).toBe(2);
  });

  it("Provider 抛 429：映射 failed、无自动重试；同版本重复请求返回缓存失败（不重复扣减）", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async () => { throw new TransportFailure("HTTP_429", "rate limited"); });
    const input = fixtureInput();

    const first = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.result.status).toBe("failed");
      expect(first.result.rejected.reason).toBe("PROVIDER_ERROR:HTTP_429");
    }
    expect(counted.calls()).toBe(1);

    const repeat = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k2", forceRefresh: false, now: 2_000 });
    expect(repeat.ok).toBe(true);
    if (repeat.ok) expect(repeat.cached).toBe(true);
    expect(counted.calls()).toBe(1);
  });

  it("Provider 超时：映射 failed、只调用一次", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async () => { throw new TransportFailure("ETIMEDOUT", "timeout"); });
    const input = fixtureInput();
    const outcome = await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.status).toBe("failed");
    expect(counted.calls()).toBe(1);
  });

  it("离线桩：0 网络请求（全局 fetch 不被触碰）且可产出 available", async () => {
    const runtime = createJevReadinessRuntime();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("EXTERNAL_REQUEST_FORBIDDEN");
    });
    const input = fixtureInput();
    const outcome = await runtime.run({
      taskId: input.taskId,
      input,
      provider: createOfflineAdviceProvider("ok"),
      providerKind: "offline",
      idempotencyKey: "k1",
      forceRefresh: false,
      now: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe("available");
      expect(outcome.result.provider.startsWith("offline-stub")).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("peek：当前绑定+指纹命中为 fresh；绑定变化后为 stale（不回传为当前建议）", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async (input) => okAdvicePayload(input));
    const input = fixtureInput();
    await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });

    const fresh = runtime.peek(input.taskId, counted.provider.providerId, input);
    expect(fresh?.fresh).toBe(true);

    const mutated = fixtureInput({ binding: { reportHash: "r1", factHash: "f1", evidenceHash: "e1", researchRevision: 2 } });
    const stale = runtime.peek(mutated.taskId, counted.provider.providerId, mutated);
    expect(stale).not.toBeNull();
    expect(stale?.fresh).toBe(false);
  });

  it("运行统计：providerCalls 与实际调用一致", async () => {
    const runtime = createJevReadinessRuntime();
    const counted = countedProvider(async (input) => okAdvicePayload(input));
    const input = fixtureInput();
    await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k1", forceRefresh: false, now: 1_000 });
    await runtime.run({ taskId: input.taskId, input, provider: counted.provider,
      providerKind: "offline", idempotencyKey: "k2", forceRefresh: false, now: 2_000 });
    expect(runtime.stats().providerCalls).toBe(1);
    expect(counted.calls()).toBe(1);
  });

  it("typesafe 计量通道：使用计数 fetch + 累计计数器；协议未校准 → 不构造请求、实测 0 次且原 provider 不被调用", async () => {
    const runtime = createJevReadinessRuntime();
    const stubAdvise = vi.fn();
    const input = fixtureInput();
    const outcome = await runtime.run({
      taskId: input.taskId,
      input,
      provider: { providerId: "typesafe-readiness", advise: stubAdvise },
      providerKind: "typesafe",
      idempotencyKey: "ts-1",
      forceRefresh: false,
      now: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe("unavailable");
      expect(outcome.result.provider).toBe("typesafe-readiness");
      expect(outcome.result.sideEffectsVerification).toBe("runtime_measured");
      expect(outcome.result.sideEffects.externalRequestAttempted).toBe(0);
      expect(outcome.result.requestTrackerKind).toBe("cumulative");
    }
    expect(stubAdvise).not.toHaveBeenCalled();
  });
});
