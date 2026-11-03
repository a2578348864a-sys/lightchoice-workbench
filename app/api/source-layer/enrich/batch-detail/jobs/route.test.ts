import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuth: vi.fn(),
  authResponse: vi.fn(() => Response.json({ ok: false }, { status: 401 })),
  jsonBody: vi.fn(async (request: Request) => request.json()),
  v5ErrorResponse: vi.fn((error: unknown) => Response.json({
    ok: false,
    error: { code: error instanceof Error ? (error as Error & { code?: string }).code : "ERROR" },
  }, { status: 500 })),
  sameOrigin: vi.fn(),
  getJob: vi.fn(),
  ensureJob: vi.fn(),
  controlJob: vi.fn(),
  runOne: vi.fn(),
}));

vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/v5ApiRoute", () => ({
  authResponse: mocks.authResponse,
  jsonBody: mocks.jsonBody,
  readAuth: mocks.readAuth,
  v5ErrorResponse: mocks.v5ErrorResponse,
}));
vi.mock("@/lib/server/batchDetailEnrichmentScheduler", () => ({
  controlBatchDetailEnrichmentJob: mocks.controlJob,
  ensureBatchDetailEnrichmentJob: mocks.ensureJob,
  getBatchDetailEnrichmentJob: mocks.getJob,
  runBatchDetailEnrichmentJobOnce: mocks.runOne,
}));

import { GET, POST } from "./route";

const owner = { mode: "owner", token: "" } as const;
const batchId = "batch-job-route-01";

function request(method: "GET" | "POST", body?: unknown): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/enrich/batch-detail/jobs?batchId=" + batchId, {
    method,
    headers: {
      host: "localhost:3010",
      origin: "http://localhost:3010",
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Amazon batch detail jobs API", () => {
  it("runs only a named batch with the hard one-item budget", async () => {
    mocks.runOne.mockResolvedValue({ jobId: "job-01", status: "PENDING" });
    const response = await POST(request("POST", { batchId, action: "run-one" }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.attemptedLimit).toBe(1);
    expect(mocks.runOne).toHaveBeenCalledWith({ context: owner, batchId });
    expect(mocks.controlJob).not.toHaveBeenCalled();
  });
  it("does not accept an expanded run budget", async () => {
    const response = await POST(request("POST", { batchId, action: "run-one", limit: 60 }));
    expect((await response.json()).error.code).toBe("INVALID_INPUT");
    expect(mocks.runOne).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuth.mockReturnValue({ ok: true, context: owner });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.getJob.mockResolvedValue({
      scheduled: true,
      job: { jobId: "job-01", status: "RUNNING" },
      progress: { status: "RUNNING", total: 60, enriched: 12, partial: 1, pending: 47 },
    });
    mocks.ensureJob.mockResolvedValue({ job: { jobId: "job-01", status: "PENDING" }, created: true });
    mocks.controlJob.mockResolvedValue({ jobId: "job-01", status: "PAUSED" });
  });

  it("returns persisted job progress on refresh without ensuring or running capture", async () => {
    const response = await GET(request("GET"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.progress).toMatchObject({ total: 60, enriched: 12, partial: 1, pending: 47 });
    expect(mocks.getJob).toHaveBeenCalledWith({ context: owner, batchId });
    expect(mocks.ensureJob).not.toHaveBeenCalled();
    expect(mocks.controlJob).not.toHaveBeenCalled();
  });

  it("supports explicit creation, pause, and resume through same-origin owner writes", async () => {
    const created = await POST(request("POST", { batchId, action: "ensure" }));
    expect(created.status).toBe(201);
    expect((await created.json()).data.job.status).toBe("PENDING");
    expect(mocks.ensureJob).toHaveBeenCalledWith({ context: owner, batchId });

    const paused = await POST(request("POST", { batchId, action: "pause" }));
    expect(paused.status).toBe(200);
    expect(mocks.controlJob).toHaveBeenCalledWith({ context: owner, batchId, action: "pause" });

    mocks.getJob.mockResolvedValueOnce({ scheduled: true, job: { jobId: "job-01", status: "PAUSED" } });
    const resumed = await POST(request("POST", { batchId, action: "resume" }));
    expect(resumed.status).toBe(200);
    expect(mocks.controlJob).toHaveBeenCalledWith({ context: owner, batchId, action: "resume" });
  });

  it("ensures a durable job when resume is requested for an older unscheduled batch", async () => {
    mocks.getJob.mockResolvedValueOnce({ scheduled: false, job: null, progress: { total: 60, pending: 60 } });
    const response = await POST(request("POST", { batchId, action: "resume" }));

    expect(response.status).toBe(200);
    expect(mocks.ensureJob).toHaveBeenCalledWith({ context: owner, batchId });
    expect(mocks.controlJob).not.toHaveBeenCalled();
  });

  it("rejects invalid batch ids and cross-origin mutations", async () => {
    const invalid = new NextRequest("http://localhost:3010/api/source-layer/enrich/batch-detail/jobs?batchId=bad", { method: "GET" });
    expect((await GET(invalid)).status).toBe(400);

    mocks.sameOrigin.mockReturnValue(false);
    const rejected = await POST(request("POST", { batchId, action: "ensure" }));
    expect(rejected.status).toBe(403);
    expect(mocks.ensureJob).not.toHaveBeenCalled();
  });
});
