import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * provider 写入契约（C-4 P0）：
 * SellerSprite 来源/模块的 provider 必须在写入前通过校验；
 * 错误拼写（历史事故：SellerSphere）与缺失值一律 422 且零写入；
 * 其他合法 Provider 的既有调用不受影响。
 */
const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  isSameOriginRequest: vi.fn(),
  captureV3ModuleEvidence: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/accessPassword", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sourceLayer/v3ModuleEvidence")>();
  return { ...actual, captureV3ModuleEvidence: mocks.captureV3ModuleEvidence };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/source-layer/acquire/module/route";
import {
  normalizeProviderName,
  SELLERSPRITE_PROVIDER_NAME,
  sellerSpriteProviderContractViolation,
} from "@/lib/sourceLayer/v3ModuleRegistry";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/source-layer/acquire/module", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    module: "sellersprite_product_market",
    sourceType: "sellersprite_plugin",
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_observed",
    status: "AVAILABLE_WITH_LIMITATION",
    subjectKey: "amazon:US:B0CFTP6JR4",
    provider: SELLERSPRITE_PROVIDER_NAME,
    sourceSurface: "Keyword Reverse visible product summary card",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0CFTP6JR4",
    identity: { asin: "B0CFTP6JR4" },
    data: { bsr: { rank: 1571, category: "Home & Kitchen" } },
    ...overrides,
  };
}

function captureResult(provider: string) {
  return {
    moduleEvidence: { module: "sellersprite_product_market", status: "AVAILABLE_WITH_LIMITATION", limitations: [], acquisitionMode: "DOM_DIRECT", metricNature: "provider_observed", provider },
    attachment: { attachmentId: "att-1", contentHash: "a".repeat(64) },
    rawArtifact: { artifact: { artifactId: "raw-1", sha256: "b".repeat(64), format: "json", byteLength: 1 } },
    downstream: { readable: true },
    evidenceStore: { subjectKey: "amazon:US:B0CFTP6JR4", versions: [{ version: 1 }], attachments: [{}], rawArtifacts: [] },
  };
}

describe("acquire/module provider 写入契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner" } });
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.captureV3ModuleEvidence.mockResolvedValue(captureResult(SELLERSPRITE_PROVIDER_NAME));
  });

  it("正确值放行并统一落规范名", async () => {
    const response = await POST(request(baseBody()));
    expect(response.status).toBe(200);
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledTimes(1);
    const call = mocks.captureV3ModuleEvidence.mock.calls[0][0] as { moduleEvidence: { provider: string } };
    expect(call.moduleEvidence.provider).toBe("SellerSprite");
  });

  it("大小写/空白变体放行，但落库为规范名", async () => {
    const response = await POST(request(baseBody({ provider: "  sellersprite  " })));
    expect(response.status).toBe(200);
    const call = mocks.captureV3ModuleEvidence.mock.calls[0][0] as { moduleEvidence: { provider: string } };
    expect(call.moduleEvidence.provider).toBe("SellerSprite");
  });

  it("历史事故值 SellerSphere 被拒绝且零写入", async () => {
    const response = await POST(request(baseBody({ provider: "SellerSphere" })));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("SELLERSPRITE_PROVIDER_REQUIRED");
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("SellerSprite 来源缺失 provider 同样被拒绝且零写入", async () => {
    const response = await POST(request(baseBody({ provider: undefined })));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("SELLERSPRITE_PROVIDER_REQUIRED");
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("SellerSprite 模块（reverse_asin / keyword_mining_trend）同样受约束", async () => {
    for (const moduleId of ["reverse_asin", "keyword_mining_trend"]) {
      const response = await POST(request(baseBody({ module: moduleId, provider: "SellerSphere" })));
      expect(response.status, moduleId).toBe(422);
    }
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("SellerSprite 来源类型（sellersprite_xlsx）同样受约束", async () => {
    const response = await POST(request(baseBody({ sourceType: "sellersprite_xlsx", module: "historical_trend", provider: "SellerSphere" })));
    expect(response.status).toBe(422);
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("其他合法 Provider（Keepa 导表 + historical_trend）不受影响", async () => {
    mocks.captureV3ModuleEvidence.mockResolvedValue(captureResult("Keepa"));
    const response = await POST(request(baseBody({ module: "historical_trend", sourceType: "keepa_export", metricNature: "provider_estimate", provider: "Keepa" })));
    expect(response.status).toBe(200);
    const call = mocks.captureV3ModuleEvidence.mock.calls[0][0] as { moduleEvidence: { provider: string } };
    expect(call.moduleEvidence.provider).toBe("Keepa");
  });

  it("非 SellerSprite 来源缺失 provider 时保持既有回退，不被新契约拦截", async () => {
    mocks.captureV3ModuleEvidence.mockResolvedValue(captureResult("unknown-provider"));
    const response = await POST(request(baseBody({ module: "historical_trend", sourceType: "keepa_export", metricNature: "provider_estimate", provider: undefined })));
    expect(response.status).toBe(200);
    const call = mocks.captureV3ModuleEvidence.mock.calls[0][0] as { moduleEvidence: { provider: string } };
    expect(call.moduleEvidence.provider).toBe("unknown-provider");
  });
});

describe("provider 契约纯函数", () => {
  it("作用域判定：SellerSprite 来源或模块命中即纳入", () => {
    expect(sellerSpriteProviderContractViolation({ module: "reverse_asin", sourceType: "sellersprite_plugin", provider: "SellerSphere" })).toBe("SELLERSPRITE_PROVIDER_REQUIRED");
    expect(sellerSpriteProviderContractViolation({ module: "keyword_mining_trend", sourceType: "sellersprite_plugin", provider: null })).toBe("SELLERSPRITE_PROVIDER_REQUIRED");
    expect(sellerSpriteProviderContractViolation({ module: "sellersprite_product_market", sourceType: "sellersprite_plugin", provider: "SellerSprite" })).toBeNull();
  });

  it("非 SellerSprite 组合返回 null（不误伤其他 Provider）", () => {
    expect(sellerSpriteProviderContractViolation({ module: "historical_trend", sourceType: "keepa_export", provider: "Keepa" })).toBeNull();
    expect(sellerSpriteProviderContractViolation({ module: "amazon_detail", sourceType: "amazon_dom", provider: "Amazon" })).toBeNull();
    expect(sellerSpriteProviderContractViolation({ module: "historical_trend", sourceType: "keepa_export", provider: null })).toBeNull();
  });

  it("归一化仅用于比较，不改写原值", () => {
    expect(normalizeProviderName("  SellerSprite ")).toBe("sellersprite");
    expect(SELLERSPRITE_PROVIDER_NAME).toBe("SellerSprite");
  });
});
