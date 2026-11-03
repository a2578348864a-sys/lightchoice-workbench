import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeMonitoringRequest: vi.fn(),
  createMonitoringRepository: vi.fn(),
  runMonitoringTarget: vi.fn(),
  repository: { getWatch: vi.fn(), listRuns: vi.fn() },
}));
vi.mock("@/lib/server/continuousMonitoringHttp", () => ({
  authorizeMonitoringRequest: mocks.authorizeMonitoringRequest,
  monitoringError: (status: number, code: string, message: string) => new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  }),
}));
vi.mock("@/lib/server/continuousMonitoringRepository", () => ({ createMonitoringRepository: mocks.createMonitoringRepository }));
vi.mock("@/lib/server/continuousMonitoringService", () => ({ runMonitoringTarget: mocks.runMonitoringTarget }));

import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/monitoring/targets/[id]/runs/route";

const ctx = { params: Promise.resolve({ id: "watch-one" }) };

function request(method: string, url = "http://localhost/api/monitoring/targets/watch-one/runs", origin = "http://localhost") {
  return new NextRequest(url, { method, headers: { host: new URL(url).host, origin } });
}

describe("monitoring run API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeMonitoringRequest.mockReturnValue(null);
    mocks.repository.getWatch.mockResolvedValue({ id: "watch-one" });
    mocks.repository.listRuns.mockResolvedValue([{ id: "run-one", status: "SUCCEEDED" }]);
    mocks.createMonitoringRepository.mockReturnValue(mocks.repository);
    mocks.runMonitoringTarget.mockResolvedValue({ status: "OVERLAP", run: { id: "run-overlap", status: "SKIPPED_OVERLAP" } });
  });

  it("returns bounded history and requires a known WatchTarget", async () => {
    const response = await GET(request("GET", "http://localhost/api/monitoring/targets/watch-one/runs?take=999"), ctx);
    expect(response.status).toBe(200);
    expect(mocks.repository.listRuns).toHaveBeenCalledWith("watch-one", 100);
    mocks.repository.getWatch.mockResolvedValue(null);
    expect((await GET(request("GET"), ctx)).status).toBe(404);
  });

  it("returns 410 MONITORING_RETIRED for manual checks without running capture", async () => {
    const response = await POST(request("POST"), ctx);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "MONITORING_RETIRED" } });
    expect(mocks.createMonitoringRepository).not.toHaveBeenCalled();
    expect(mocks.repository.listRuns).not.toHaveBeenCalled();
    expect(mocks.runMonitoringTarget).not.toHaveBeenCalled();
  });

  it("returns the same retirement error even for cross-origin manual checks", async () => {
    const response = await POST(request("POST", undefined, "https://attacker.example"), ctx);
    expect(response.status).toBe(410);
    expect(mocks.runMonitoringTarget).not.toHaveBeenCalled();
  });
});
