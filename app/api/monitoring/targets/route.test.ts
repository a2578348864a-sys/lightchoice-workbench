import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerOnly: vi.fn(),
  createMonitoringRepository: vi.fn(),
  projectLatestCapture: vi.fn(),
  repository: {
    listWatches: vi.fn(),
    listRuns: vi.fn(),
    createWatch: vi.fn(),
  },
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireOwnerOnly: mocks.requireOwnerOnly }));
vi.mock("@/lib/server/continuousMonitoringRepository", () => ({
  createMonitoringRepository: mocks.createMonitoringRepository,
}));
vi.mock("@/lib/server/continuousMonitoringCaptureProjection", () => ({
  projectLatestCapture: mocks.projectLatestCapture,
}));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    opportunityCandidate: { findFirst: vi.fn().mockResolvedValue(null) },
    productBatchItem: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/monitoring/targets/route";

function request(input: { method: string; body?: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest("http://localhost/api/monitoring/targets", {
    method: input.method,
    headers: { host: "localhost", ...input.headers },
    body: input.body,
  });
}

describe("monitoring targets API boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwnerOnly.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.repository.listWatches.mockResolvedValue([]);
    mocks.repository.listRuns.mockResolvedValue([]);
    mocks.repository.createWatch.mockImplementation(async (watch) => watch);
    mocks.createMonitoringRepository.mockReturnValue(mocks.repository);
    mocks.projectLatestCapture.mockResolvedValue(null);
    delete process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER;
    delete process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;
  });

  it("reports the scheduler gate state without claiming it is running", async () => {
    const response = await GET(request({ method: "GET" }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.scheduler).toMatchObject({
      probe: "in_process",
      status: "not_started",
      configEnabled: false,
      started: false,
    });
    // The response must not echo raw environment switches or secrets.
    expect(JSON.stringify(payload)).not.toContain("V5_ENABLE");
    expect(JSON.stringify(payload)).not.toContain("token");
  });

  it("marks a watch without captured evidence and never fabricates capture values", async () => {
    mocks.repository.listWatches.mockResolvedValue([{
      id: "watch-1",
      subjectKey: "amazon:US:B0DKNN9WCX",
      captureModule: "amazon_detail",
      enabled: true,
      schedule: "daily@09:00",
      timezone: "Asia/Shanghai",
      policy: { cooldownMinutes: 120, rules: [] },
      lastRunAt: null,
      lastMeaningfulChangeAt: null,
      nextRunAt: "2026-10-23T01:00:00.000Z",
      activeRunId: null,
      createdAt: "2026-09-29T06:19:21.647Z",
      updatedAt: "2026-09-29T06:19:21.647Z",
    }]);
    mocks.repository.listRuns.mockResolvedValue([{
      id: "run-1",
      watchTargetId: "watch-1",
      triggerType: "SCHEDULED",
      status: "FAILED",
      outcome: "RUN_FAILED",
      startedAt: "2026-10-10T04:06:56.761Z",
      finishedAt: "2026-10-10T04:06:56.780Z",
      previousEvidenceRef: null,
      currentEvidenceRef: null,
      changeSummary: null,
      errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
      errorMessage: "本地采集环境未连接。",
      aiExplanation: null,
    }]);

    const response = await GET(request({ method: "GET" }));
    const payload = await response.json();
    expect(payload.data.watches[0]).toMatchObject({
      lastRunOutcome: "FAILED",
      lastRunResultOutcome: "RUN_FAILED",
      hasCapturedEvidence: false,
      latestCapture: null,
      captureProjection: "none",
    });
    expect(mocks.projectLatestCapture).not.toHaveBeenCalled();
  });

  it("degrades to unreadable instead of reusing an old value when projection fails", async () => {
    mocks.repository.listWatches.mockResolvedValue([{
      id: "watch-2",
      subjectKey: "amazon:US:B0DKNN9WCX",
      captureModule: "amazon_detail",
      enabled: true,
      schedule: "daily@09:00",
      timezone: "Asia/Shanghai",
      policy: { cooldownMinutes: 120, rules: [] },
      lastRunAt: "2026-10-22T10:54:56.919Z",
      lastMeaningfulChangeAt: null,
      nextRunAt: "2026-10-23T01:00:00.000Z",
      activeRunId: null,
      createdAt: "2026-09-29T06:19:21.647Z",
      updatedAt: "2026-09-29T06:19:21.647Z",
    }]);
    const reference = {
      subjectKey: "amazon:US:B0DKNN9WCX",
      module: "amazon_detail",
      attachmentId: "att-1",
      contentHash: "a".repeat(64),
      capturedAt: "2026-10-22T10:54:46.246Z",
      sourceType: "amazon_dom",
      provider: "Amazon",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "source_observed",
      rawArtifactId: "raw-1",
      rawArtifactHash: "b".repeat(64),
    };
    mocks.repository.listRuns.mockResolvedValue([{
      id: "run-2",
      watchTargetId: "watch-2",
      triggerType: "MANUAL",
      status: "SUCCEEDED",
      outcome: "NOT_COMPARABLE",
      startedAt: "2026-10-22T10:54:46.067Z",
      finishedAt: "2026-10-22T10:54:56.919Z",
      previousEvidenceRef: null,
      currentEvidenceRef: reference,
      changeSummary: null,
      errorCode: null,
      errorMessage: null,
      aiExplanation: null,
    }]);
    mocks.projectLatestCapture.mockResolvedValue(null);

    const response = await GET(request({ method: "GET" }));
    const payload = await response.json();
    expect(mocks.projectLatestCapture).toHaveBeenCalledWith(reference);
    expect(payload.data.watches[0]).toMatchObject({
      hasCapturedEvidence: true,
      latestCapture: null,
      captureProjection: "unreadable",
    });
  });

  it("requires Owner access and returns a generic denial without reading monitoring data", async () => {
    mocks.requireOwnerOnly.mockReturnValue({ ok: false, status: 403, code: "origin_denied", message: "denied" });
    const response = await GET(request({ method: "GET" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "origin_denied" } });
    expect(mocks.createMonitoringRepository).not.toHaveBeenCalled();
  });

  it("returns 410 MONITORING_RETIRED for create attempts without touching monitoring storage", async () => {
    const response = await POST(request({
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ asin: "b0113uzje2", schedule: "daily@21:00", timezone: "Asia/Shanghai" }),
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "MONITORING_RETIRED" } });
    expect(mocks.createMonitoringRepository).not.toHaveBeenCalled();
    expect(mocks.repository.createWatch).not.toHaveBeenCalled();
  });

  it("keeps the stable retirement error for arbitrary URLs, unsupported modules, malformed rules and cross-origin calls", async () => {
    const samples = [
      { origin: "https://attacker.example", body: { asin: "B0113UZJE2" } },
      { origin: "http://localhost", body: { asin: "B0113UZJE2", sourceUrl: "http://127.0.0.1:3010/api/health" } },
      { origin: "http://localhost", body: { asin: "B0113UZJE2", captureModule: "sellersprite_product_market" } },
      { origin: "http://localhost", body: { asin: "B0113UZJE2", policy: { cooldownMinutes: 20_000, rules: [] } } },
    ];
    for (const sample of samples) {
      const response = await POST(request({
        method: "POST",
        headers: { origin: sample.origin, "content-type": "application/json" },
        body: JSON.stringify(sample.body),
      }));
      expect(response.status).toBe(410);
      expect((await response.json()).error.code).toBe("MONITORING_RETIRED");
    }
    expect(mocks.createMonitoringRepository).not.toHaveBeenCalled();
    expect(mocks.repository.createWatch).not.toHaveBeenCalled();
  });
});
