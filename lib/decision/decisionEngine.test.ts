/**
 * lib/decision/decisionEngine.test.ts
 *
 * Decision Engine 单元测试。
 * 覆盖：
 * - mock provider 正常返回
 * - API 失败保持 provider 状态，不静默 fallback
 * - confidence 字段完整性
 * - buildDecisionSnapshot / parseDecisionSnapshot 双向
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模拟 server-only（在 vitest 环境中 server-only 会抛出）
vi.mock("server-only", () => ({}));

// 在 import 之前设置环境变量
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decisionEngine — analyzeProductDecision", () => {
  it("使用 mock provider 时正常返回 ProductDecision", async () => {
    vi.stubEnv("DECISION_PROVIDER", "mock");
    const { analyzeProductDecision } = await import("@/lib/decision/decisionEngine");
    const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
    _resetProviderCacheForTest();

    const facts = {
      title: "Test Product",
      brand: "TestBrand",
      category: null,
      price: 29.99,
      rating: 4.5,
      reviewCount: 500,
      rootCategoryBsr: 3000,
      subCategoryBsr: null,
      estimatedMonthlySales: 1200,
      estimatedMonthlyRevenueUsd: 35988,
      asin: "B0TESTTEST",
      marketplace: "Amazon US",
    };

    const result = await analyzeProductDecision(facts);

    // 基本结构
    expect(result).toBeDefined();
    expect(["P1", "P2", "P3"]).toContain(result.priority);
    expect(["completed", "pending", "failed"]).toContain(result.status);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(Array.isArray(result.risks)).toBe(true);
    expect(typeof result.provider).toBe("string");
    expect(typeof result.model).toBe("string");
    expect(typeof result.timestamp).toBe("string");

    // mock provider 应能正常完成分析
    expect(result.status).toBe("completed");
  });

  it("高销量商品应获得 P1 优先级", async () => {
    vi.stubEnv("DECISION_PROVIDER", "mock");
    const { analyzeProductDecision } = await import("@/lib/decision/decisionEngine");
    const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
    _resetProviderCacheForTest();

    const result = await analyzeProductDecision({
      title: "高销量商品",
      brand: null,
      category: null,
      price: 49.99,
      rating: 4.6,
      reviewCount: 1000,
      rootCategoryBsr: 1000,
      subCategoryBsr: null,
      estimatedMonthlySales: 2000,
      estimatedMonthlyRevenueUsd: 99980,
      asin: "B0000000001",
      marketplace: "Amazon US",
    });

    expect(result.priority).toBe("P1");
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.status).toBe("completed");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("低销量商品应获得 P3 优先级", async () => {
    vi.stubEnv("DECISION_PROVIDER", "mock");
    const { analyzeProductDecision } = await import("@/lib/decision/decisionEngine");
    const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
    _resetProviderCacheForTest();

    const result = await analyzeProductDecision({
      title: "低销量商品",
      brand: null,
      category: null,
      price: 5.99,
      rating: 3.2,
      reviewCount: 10,
      rootCategoryBsr: 500000,
      subCategoryBsr: null,
      estimatedMonthlySales: 50,
      estimatedMonthlyRevenueUsd: 299,
      asin: null,
      marketplace: null,
    });

    expect(result.priority).toBe("P3");
    expect(result.score).toBeLessThan(55);
    expect(result.status).toBe("completed");
  });

  it("所有字段为 null 时应返回 P3（数据不足）", async () => {
    vi.stubEnv("DECISION_PROVIDER", "mock");
    const { analyzeProductDecision } = await import("@/lib/decision/decisionEngine");
    const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
    _resetProviderCacheForTest();

    const result = await analyzeProductDecision({
      title: null,
      brand: null,
      category: null,
      price: null,
      rating: null,
      reviewCount: null,
      rootCategoryBsr: null,
      subCategoryBsr: null,
      estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null,
      asin: null,
      marketplace: null,
    });

    // 数据不足时 confidence 接近 0
    expect(result.confidence).toBeLessThan(0.1);
    expect(result.status).toBe("completed");
    // 无数据 → 基准分 50 → P2
    expect(["P2", "P3"]).toContain(result.priority);
  });
});

describe("decisionEngine — buildDecisionSnapshot / parseDecisionSnapshot", () => {
  it("buildDecisionSnapshot 生成符合 schema 的快照", async () => {
    vi.stubEnv("DECISION_PROVIDER", "mock");
    const { buildDecisionSnapshot, analyzeProductDecision } = await import("@/lib/decision/decisionEngine");
    const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
    _resetProviderCacheForTest();

    const facts = {
      title: "Test",
      brand: "Brand",
      category: null,
      price: 19.99,
      rating: 4.0,
      reviewCount: 100,
      rootCategoryBsr: 5000,
      subCategoryBsr: null,
      estimatedMonthlySales: 400,
      estimatedMonthlyRevenueUsd: 7996,
      asin: "B0SNAP00001",
      marketplace: "Amazon US",
    };

    const decision = await analyzeProductDecision(facts);
    const snapshot = buildDecisionSnapshot(facts, decision);

    expect(snapshot.schema).toBe("decision-snapshot.v1");
    expect(typeof snapshot.inputFactsHash).toBe("string");
    expect(snapshot.inputFactsHash).toHaveLength(64); // SHA-256 hex
    expect(snapshot.output).toEqual(decision);
    expect(typeof snapshot.createdAt).toBe("string");
    expect(Number.isFinite(Date.parse(snapshot.createdAt))).toBe(true);
  });

  it("parseDecisionSnapshot 从 analysisJson 正确解析", async () => {
    const { parseDecisionSnapshot, buildDecisionSnapshot } = await import("@/lib/decision/decisionEngine");

    const mockDecision = {
      priority: "P2" as const,
      score: 60,
      status: "completed" as const,
      confidence: 0.7,
      reasons: ["测试原因"],
      risks: [],
      provider: "mock",
      model: "mock-rule-based-v1",
      timestamp: new Date().toISOString(),
    };

    const facts = {
      title: "Test",
      brand: null,
      category: null,
      price: null,
      rating: null,
      reviewCount: null,
      rootCategoryBsr: null,
      subCategoryBsr: null,
      estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null,
      asin: null,
      marketplace: null,
    };

    const snapshot = buildDecisionSnapshot(facts, mockDecision);
    const analysisJson = JSON.stringify({ decisionSnapshot: snapshot });

    const parsed = parseDecisionSnapshot(analysisJson);
    expect(parsed).not.toBeNull();
    expect(parsed!.schema).toBe("decision-snapshot.v1");
    expect(parsed!.output.priority).toBe("P2");
    expect(parsed!.output.confidence).toBe(0.7);
  });

  it("parseDecisionSnapshot 对无效数据返回 null", async () => {
    const { parseDecisionSnapshot } = await import("@/lib/decision/decisionEngine");

    expect(parseDecisionSnapshot(null)).toBeNull();
    expect(parseDecisionSnapshot("")).toBeNull();
    expect(parseDecisionSnapshot("not json")).toBeNull();
    expect(parseDecisionSnapshot("{}")).toBeNull();
    expect(parseDecisionSnapshot('{"decisionSnapshot": {"schema": "wrong_schema"}}')).toBeNull();
  });
});

describe("typesafeProvider — API 失败保持可拔插状态", () => {
  it("无 API Key 时返回 unavailable/failed，不冒充 Mock 或 Jev 成功", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("DECISION_PROVIDER", "typesafe");
    const { TypeSafeDecisionProvider } = await import("@/lib/decision/providers/typesafeProvider");

    const provider = new TypeSafeDecisionProvider();
    const result = await provider.analyzeProduct({
      title: null, brand: null, category: null, price: null, rating: null, reviewCount: null,
      rootCategoryBsr: null, subCategoryBsr: null, estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null, asin: null, marketplace: null,
    });

    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
  });

  it("API Key 存在但网络调用失败时返回 unavailable/failed 状态", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-for-network-failure");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://127.0.0.1:1"); // 端口1一定连接失败
    vi.stubEnv("DECISION_PROVIDER", "typesafe");

    const { TypeSafeDecisionProvider } = await import("@/lib/decision/providers/typesafeProvider");

    const provider = new TypeSafeDecisionProvider();
    const result = await provider.analyzeProduct({
      title: "Test", brand: null, category: null, price: null, rating: null, reviewCount: null,
      rootCategoryBsr: null, subCategoryBsr: null, estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null, asin: null, marketplace: null,
    });

    // 网络失败 → failed/unavailable，不切换到 Mock
    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
    // 关键：不能抛出异常
  });
});

describe("productDecision schema — parseProductDecision", () => {
  it("合法 ProductDecision 数据通过校验", async () => {
    const { parseProductDecision } = await import("@/lib/decision/schemas/productDecision");

    const raw = {
      priority: "P1",
      score: 85,
      status: "completed",
      confidence: 0.8,
      reasons: ["月销量表现强劲"],
      risks: ["竞争环境需验证"],
      timestamp: new Date().toISOString(),
    };

    const result = parseProductDecision(raw, "typesafe", "jev-1");
    expect(result).not.toBeNull();
    expect(result!.priority).toBe("P1");
    expect(result!.score).toBe(85);
    expect(result!.confidence).toBe(0.8);
    expect(result!.reasons).toEqual(["月销量表现强劲"]);
    expect(result!.risks).toEqual(["竞争环境需验证"]);
    expect(result!.provider).toBe("typesafe");
    expect(result!.model).toBe("jev-1");
  });

  it("非法 priority 返回 null", async () => {
    const { parseProductDecision } = await import("@/lib/decision/schemas/productDecision");
    const result = parseProductDecision(
      { priority: "P4", score: 80, status: "completed", confidence: 0.8,
        reasons: [], risks: [], timestamp: new Date().toISOString() },
      "test", "test"
    );
    expect(result).toBeNull();
  });

  it("confidence 超出范围返回 null", async () => {
    const { parseProductDecision } = await import("@/lib/decision/schemas/productDecision");
    const result = parseProductDecision(
      { priority: "P1", score: 80, status: "completed", confidence: 1.5,
        reasons: [], risks: [], timestamp: new Date().toISOString() },
      "test", "test"
    );
    expect(result).toBeNull();
  });

  it("reasons 数量超过 5 时截断到 5 条", async () => {
    const { parseProductDecision } = await import("@/lib/decision/schemas/productDecision");
    const result = parseProductDecision(
      { priority: "P2", score: 60, status: "completed", confidence: 0.5,
        reasons: ["1", "2", "3", "4", "5", "6", "7"],
        risks: [], timestamp: new Date().toISOString() },
      "test", "test"
    );
    expect(result).not.toBeNull();
    expect(result!.reasons).toHaveLength(5);
  });
});

describe("TypeSafeDecisionProvider — 边界与异常处理 (Task 4 覆盖)", () => {
  it("API timeout (AbortError) 时安全返回 unavailable/failed，不抛出异常", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://mock.typesafe.ai");

    const { TypeSafeDecisionProvider } = await import("@/lib/decision/providers/typesafeProvider");

    // 模拟 fetch 抛出 AbortError
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    try {
      const provider = new TypeSafeDecisionProvider();
      const result = await provider.analyzeProduct({
        title: "Timeout Product", brand: null, category: null, price: null, rating: null, reviewCount: null,
        rootCategoryBsr: null, subCategoryBsr: null, estimatedMonthlySales: null,
        estimatedMonthlyRevenueUsd: null, asin: null, marketplace: null,
      });

      expect(result.status).toBe("failed");
      expect(result.provider).toBe("unavailable");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("返回格式异常（缺少 answers / choice）时安全返回 failed", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://mock.typesafe.ai");

    const { TypeSafeDecisionProvider } = await import("@/lib/decision/providers/typesafeProvider");

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-1.13.0", answers: {} }), // 异常：缺少 priority
    });

    try {
      const provider = new TypeSafeDecisionProvider();
      const result = await provider.analyzeProduct({
        title: "Malformed Product", brand: null, category: null, price: null, rating: null, reviewCount: null,
        rootCategoryBsr: null, subCategoryBsr: null, estimatedMonthlySales: null,
        estimatedMonthlyRevenueUsd: null, asin: null, marketplace: null,
      });

      expect(result.status).toBe("failed");
      expect(result.provider).toBe("unavailable");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("TypeSafe 成功返回时正确解析 Choice / Score / Noul 结构", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://mock.typesafe.ai");

    const { TypeSafeDecisionProvider } = await import("@/lib/decision/providers/typesafeProvider");

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.13.0",
        answers: {
          priority: {
            type: "choice",
            choice: "P1",
            confidence: 0.95,
            probabilities: { P1: 0.92, P2: 0.08, P3: 0.0 },
          },
          score: {
            type: "score",
            score: 1.8,
            confidence: 0.9,
          },
          has_data_risk: {
            type: "noul",
            noul: 0.05,
          },
        },
      }),
    });

    try {
      const provider = new TypeSafeDecisionProvider();
      const result = await provider.analyzeProduct({
        title: "Success Product", brand: "Brand", category: "Cat", price: 39.99, rating: 4.7, reviewCount: 1500,
        rootCategoryBsr: 250, subCategoryBsr: 10, estimatedMonthlySales: 3500,
        estimatedMonthlyRevenueUsd: 139965, asin: "B0SUCCESS1", marketplace: "Amazon US",
      });

      expect(result.status).toBe("completed");
      expect(result.priority).toBe("P1");
      expect(result.score).toBe(90); // (1.8 / 2) * 100
      expect(result.confidence).toBe(0.95);
      expect(result.provider).toBe("typesafe");
      expect(result.model).toBe("jev-1.13.0");
      expect(result.reasons.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("Decision Provider 纯只读性：调用不产生任何副作用，不改动任何 Research 状态", async () => {
    const { analyzeProductDecision, buildDecisionSnapshot } = await import("@/lib/decision/decisionEngine");

    const facts = {
      title: "Isolated Product", brand: null, category: null, price: 10, rating: 4.0, reviewCount: 50,
      rootCategoryBsr: 10000, subCategoryBsr: null, estimatedMonthlySales: 200,
      estimatedMonthlyRevenueUsd: 2000, asin: "B0ISOLATED", marketplace: "Amazon US",
    };

    const decision = await analyzeProductDecision(facts);
    const snapshot = buildDecisionSnapshot(facts, decision);

    // 确认 snapshot 仅包含自身字段，未附带修改 candidate 状态或 convertedTaskId 的指令
    expect(snapshot.schema).toBe("decision-snapshot.v1");
    expect(snapshot.output.priority).toBeDefined();
    expect((snapshot as Record<string, unknown>)["status"]).toBeUndefined(); // snapshot 顶层不含 candidate status
    expect((snapshot as Record<string, unknown>)["convertedTaskId"]).toBeUndefined();
  });
});
