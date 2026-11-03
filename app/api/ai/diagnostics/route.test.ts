import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ai/diagnostics/route";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  process.env.ENABLE_AI_DIAGNOSTICS = "1";
  process.env.QX_RUNTIME_MODE = "local_owner";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.ENABLE_AI_DIAGNOSTICS;
  delete process.env.QX_RUNTIME_MODE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

describe("GET /api/ai/diagnostics", () => {
  it("只返回脱敏配置快照，不返回 API Key", async () => {
    process.env.OPENAI_API_KEY = "test-secret-that-must-not-leak";
    const response = await GET(new NextRequest("http://127.0.0.1:3011/api/ai/diagnostics", { headers: { host: "127.0.0.1:3011" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.keyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("test-secret-that-must-not-leak");
  });

  it("显式 checkModels 才进入 Provider 检查，并保留失败契约", async () => {
    process.env.OPENAI_API_KEY = "test-only-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));

    const response = await GET(new NextRequest("http://127.0.0.1:3011/api/ai/diagnostics?checkModels=1", { headers: { host: "127.0.0.1:3011" } }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("provider_unavailable");
  });

  it("本地单用户：诊断端点不再因未登录被拒（无 401）", async () => {
    delete process.env.QX_RUNTIME_MODE;
    process.env.ENABLE_AI_DIAGNOSTICS = "1";
    const response = await GET(new NextRequest("http://127.0.0.1:3011/api/ai/diagnostics", { headers: { host: "127.0.0.1:3011" } }));
    const body = await response.json();

    expect(response.status).not.toBe(401);
    expect(body.error?.code).not.toBe("invalid_access");
  });

  it("未显式启用时保持 404，不暴露诊断能力", async () => {
    delete process.env.ENABLE_AI_DIAGNOSTICS;
    const response = await GET(new NextRequest("http://127.0.0.1:3011/api/ai/diagnostics", { headers: { host: "127.0.0.1:3011" } }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, error: { code: "not_found", message: "Not found." } });
  });
});
