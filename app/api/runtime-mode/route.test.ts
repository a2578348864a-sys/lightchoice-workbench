import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/runtime-mode/route";

const ENV_KEYS = ["QX_RUNTIME_MODE", "ACCESS_PASSWORD", "PUBLIC_SHOWCASE"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("GET /api/runtime-mode（本地单用户）", () => {
  it("无任何环境变量 → local_owner 且 noAuthOwner=true", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const res = await GET(new NextRequest("http://127.0.0.1:3010/api/runtime-mode", { method: "GET" }));
    const json = await res.clone().json();
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("local_owner");
    expect(json.noAuthOwner).toBe(true);
  });

  it("显式 QX_RUNTIME_MODE 不再改变结果", async () => {
    for (const value of ["local_owner", "public_showcase"]) {
      process.env.QX_RUNTIME_MODE = value;
      const res = await GET(new NextRequest("http://127.0.0.1:3010/api/runtime-mode", { method: "GET" }));
      const json = await res.clone().json();
      expect(json.mode).toBe("local_owner");
      expect(json.noAuthOwner).toBe(true);
    }
  });
});
