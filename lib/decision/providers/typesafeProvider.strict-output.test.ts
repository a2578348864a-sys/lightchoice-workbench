import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductFacts } from "@/lib/decision/types";
import { TypeSafeDecisionProvider } from "./typesafeProvider";

const facts: ProductFacts = {
  title: "Test Product",
  brand: "Brand",
  category: "Kitchen",
  price: 19.99,
  rating: 4.4,
  reviewCount: 1200,
  rootCategoryBsr: 1234,
  subCategoryBsr: null,
  estimatedMonthlySales: 800,
  estimatedMonthlyRevenueUsd: 15999,
  asin: "B0TEST0001",
  marketplace: "Amazon US",
};

function jevBody(answers: unknown) {
  return { model: "jev-latest", answers };
}

function mockJevResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("JEV-001 · TypeSafe adapter 严格输出校验", () => {
  beforeEach(() => {
    process.env["TYPESAFE_API_KEY"] = "test-key";
    process.env["TYPESAFE_BASE_URL"] = "https://typesafe.test/v1";
  });

  afterEach(() => {
    delete process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_BASE_URL"];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("合法输出：正常解析为 completed，并按契约二次校验", async () => {
    vi.stubGlobal("fetch", mockJevResponse(jevBody({
      priority: { type: "choice", choice: "P1", confidence: 0.9, probabilities: { P1: 0.8 } },
      score: { type: "score", score: 2 },
      has_data_risk: { type: "noul", noul: 0.1 },
    })));

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("completed");
    expect(decision.priority).toBe("P1");
    expect(decision.score).toBe(100);
    expect(decision.confidence).toBe(0.9);
    expect(decision.provider).toBe("typesafe");
  });

  it("未知 priority 枚举：降级为 failed，绝不归一为 P2", async () => {
    vi.stubGlobal("fetch", mockJevResponse(jevBody({
      priority: { type: "choice", choice: "URGENT", confidence: 0.9 },
      score: { type: "score", score: 2 },
    })));

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("failed");
    expect(decision.reasons[0]).toContain("无法识别的 priority");
  });

  it("缺 priority.choice：降级为 failed", async () => {
    vi.stubGlobal("fetch", mockJevResponse(jevBody({
      score: { type: "score", score: 1 },
    })));

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("failed");
  });

  it("score 非法（字符串 / 越界）：降级为 failed，不用固定分数兜底", async () => {
    for (const score of ["2" as unknown as number, -1, 999]) {
      vi.stubGlobal("fetch", mockJevResponse(jevBody({
        priority: { type: "choice", choice: "P2", confidence: 0.5 },
        score: { type: "score", score },
      })));

      const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

      expect(decision.status).toBe("failed");
      expect(decision.reasons[0]).toContain("score 无效");
    }
  });

  it("confidence 缺失或非法：降级为 failed，不使用 0.5 默认值", async () => {
    vi.stubGlobal("fetch", mockJevResponse(jevBody({
      priority: { type: "choice", choice: "P2" },
      score: { type: "score", score: 1 },
    })));

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("failed");
    expect(decision.reasons[0]).toContain("confidence 无效");
  });

  it("畸形 JSON：降级为 failed，不抛出", async () => {
    vi.stubGlobal("fetch", mockJevResponse("{ not json"));

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("failed");
    expect(decision.reasons[0]).toContain("无法解析的 JSON");
  });

  it("未配置 API Key：unavailable，不发起网络请求", async () => {
    delete process.env["TYPESAFE_API_KEY"];
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const decision = await new TypeSafeDecisionProvider().analyzeProduct(facts);

    expect(decision.status).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
