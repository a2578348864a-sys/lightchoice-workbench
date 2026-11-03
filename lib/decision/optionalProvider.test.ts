import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const facts = {
  title: "Test product",
  brand: null,
  category: "storage",
  price: 12.5,
  rating: 4.5,
  reviewCount: 120,
  rootCategoryBsr: 1000,
  subCategoryBsr: 20,
  estimatedMonthlySales: 900,
  estimatedMonthlyRevenueUsd: 11250,
  asin: "B0OPTIONAL01",
  marketplace: "Amazon US",
} as const;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function analyze() {
  const { analyzeResearchPriority } = await import("@/lib/decision/decisionEngine");
  const { _resetProviderCacheForTest } = await import("@/lib/decision/providers/index");
  _resetProviderCacheForTest();
  return analyzeResearchPriority(facts);
}

describe("TypeSafe Jev optional / hot-swappable provider boundary", () => {
  it("explicit mock is usable in test and is visibly marked mock", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DECISION_PROVIDER", "mock");

    const result = await analyze();

    expect(result.status).toBe("completed");
    expect(result.provider).toBe("mock");
  });

  it("production never executes Mock, even when misconfigured as mock", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECISION_PROVIDER", "mock");

    const result = await analyze();

    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
    expect(result.model).toBe("not-configured");
  });

  it("missing Jev key returns unavailable and keeps the decision call non-blocking", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECISION_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "");

    const result = await analyze();

    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
    expect(result.reasons.join(" ")).toContain("API Key");
  });

  it.each([429, 500, 503])("Jev HTTP %s keeps the core decision call alive without Mock substitution", async (status) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECISION_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://typesafe.test/v1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider failure", { status }));

    const result = await analyze();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
  });

  it("Jev timeout is unavailable, not a silent Mock result", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECISION_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://typesafe.test/v1");
    const timeout = new Error("timeout");
    timeout.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    const result = await analyze();

    expect(result.status).toBe("failed");
    expect(result.provider).toBe("unavailable");
    expect(result.reasons.join(" ")).toContain("超时");
  });

  it("successful Jev response is marked typesafe and remains advisory", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECISION_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://typesafe.test/v1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "jev-test",
      answers: {
        priority: { type: "choice", choice: "P1", confidence: 0.9 },
        score: { type: "score", score: 1.8 },
        has_data_risk: { type: "noul", noul: 0.1 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await analyze();

    expect(result.status).toBe("completed");
    expect(result.provider).toBe("typesafe");
    expect(result.model).toBe("jev-test");
    expect(result.priority).toBe("P1");
  });
});
