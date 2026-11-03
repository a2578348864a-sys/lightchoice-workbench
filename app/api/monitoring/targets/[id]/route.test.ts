import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerOnly: vi.fn(),
  createMonitoringRepository: vi.fn(),
  repository: { getWatch: vi.fn(), updateWatch: vi.fn() },
}));
vi.mock("@/lib/server/demoGuard", () => ({ requireOwnerOnly: mocks.requireOwnerOnly }));
vi.mock("@/lib/server/continuousMonitoringRepository", () => ({ createMonitoringRepository: mocks.createMonitoringRepository }));

import { NextRequest } from "next/server";

import { GET, PATCH } from "@/app/api/monitoring/targets/[id]/route";

const watch = {
  id: "watch-one",
  subjectKey: "amazon:US:B0113UZJE2",
  captureModule: "amazon_detail" as const,
  enabled: true,
  schedule: "daily@09:00" as const,
  timezone: "Asia/Shanghai",
  policy: { cooldownMinutes: 120, rules: [{ field: "reviewCount", comparison: "numeric_delta" as const, absoluteThreshold: 1, relativeThreshold: null, enabled: true }] },
  lastRunAt: null,
  lastMeaningfulChangeAt: null,
  nextRunAt: "2026-09-28T01:00:00.000Z",
  activeRunId: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/monitoring/targets/watch-one", {
    method,
    headers: {
      host: "localhost",
      origin: "http://localhost",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = { params: Promise.resolve({ id: "watch-one" }) };

describe("monitoring target update API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwnerOnly.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.repository.getWatch.mockResolvedValue(watch);
    mocks.repository.updateWatch.mockImplementation(async (_id, patch) => ({ ...watch, ...patch }));
    mocks.createMonitoringRepository.mockReturnValue(mocks.repository);
  });

  it("returns 410 MONITORING_RETIRED for every edit, enable or disable attempt", async () => {
    const bodies = [
      { enabled: false, schedule: "daily@21:00", timezone: "Asia/Shanghai" },
      { subjectKey: "amazon:US:B000000000" },
      { timezone: "Not/AZone" },
      { enabled: true },
    ];
    for (const body of bodies) {
      const response = await PATCH(request("PATCH", body), context);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MONITORING_RETIRED" } });
    }
    const crossOrigin = new NextRequest("http://localhost/api/monitoring/targets/watch-one", {
      method: "PATCH",
      headers: { host: "localhost", origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await PATCH(crossOrigin, context)).status).toBe(410);
    expect(mocks.createMonitoringRepository).not.toHaveBeenCalled();
    expect(mocks.repository.updateWatch).not.toHaveBeenCalled();
  });

  it("returns a not-found contract instead of exposing storage details", async () => {
    mocks.repository.getWatch.mockResolvedValue(null);
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "watch_not_found" } });
  });
});
