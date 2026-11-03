import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectResearchTaskToV5Hub: vi.fn(),
  projectProductConceptToV5Hub: vi.fn(),
  syncResearchTask: vi.fn(),
  writeAuth: vi.fn((_request?: unknown) => ({ ok: true as const, context: { mode: "owner" as const, token: "" } })),
}));

vi.mock("@/lib/server/v5HubResearchProjectionService", () => ({
  projectResearchTaskToV5Hub: mocks.projectResearchTaskToV5Hub,
  projectProductConceptToV5Hub: mocks.projectProductConceptToV5Hub,
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@/lib/server/v5FeishuService", () => ({ syncResearchTask: mocks.syncResearchTask }));
vi.mock("@/lib/server/v5ResearchService", () => ({
  runJevReadinessAdvisory: vi.fn(), runResearchAdvisory: vi.fn(), researchTaskAction: vi.fn(), saveResearchChoice: vi.fn(), saveTemporaryWatch: vi.fn(),
  applyResearchTeamRecommendation: vi.fn(),
}));
vi.mock("@/lib/server/v5ApiRoute", () => ({
  authResponse: (auth: { status?: number; code?: string; message?: string }) => Response.json({ ok: false, error: { code: auth.code ?? "UNAUTHORIZED", message: auth.message ?? "denied" } }, { status: auth.status ?? 401 }),
  jsonBody: (request: { json: () => Promise<unknown> }) => request.json(),
  originError: () => Response.json({ ok: false, error: { code: "ORIGIN_NOT_ALLOWED" } }, { status: 403 }),
  writeAuth: (request: unknown) => mocks.writeAuth(request),
  writeOriginOk: () => true,
  v5ErrorResponse: (error: Error & { code?: string; status?: number }) => Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/server/v5CoreCommon", () => ({
  okResponse: (data: unknown) => ({ body: { ok: true, data } }),
  requireIdempotencyKey: (key: string) => key,
  safeParseBody: (body: unknown) => body,
  V5CoreError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
  },
}));

import { POST } from "./route";

describe("POST /api/research/[taskId]/feishu-hub-sync", () => {
  it("passes only current version/hash bindings to the server-owned projection service", async () => {
    mocks.projectResearchTaskToV5Hub.mockResolvedValueOnce({ packetHash: "hash", replayed: false });
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "sync-1" }),
      json: async () => ({
        expectedRevision: 4, expectedReportHash: "report", expectedFactHash: "fact",
        expectedEvidenceHash: "evidence", idempotencyKey: "sync-1", fields: { injected: "must-not-be-used" },
      }),
    } as never;

    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "feishu-hub-sync" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.packetHash).toBe("hash");
    expect(mocks.projectResearchTaskToV5Hub).toHaveBeenCalledWith({
      context: { mode: "owner", token: "" }, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: "report", expectedFactHash: "fact", expectedEvidenceHash: "evidence", idempotencyKey: "sync-1",
    });
    expect(mocks.projectResearchTaskToV5Hub.mock.calls[0]?.[0]).not.toHaveProperty("fields");
  });

  it("routes T05 concept projection through current Research bindings and ignores client field payloads", async () => {
    mocks.projectProductConceptToV5Hub.mockResolvedValueOnce({ conceptId: "pcv5-1", packetHash: "hash", replayed: false });
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "concept-sync-1" }),
      json: async () => ({
        expectedRevision: 4, expectedReportHash: "report", expectedFactHash: "fact",
        expectedEvidenceHash: "evidence", idempotencyKey: "concept-sync-1", fields: { injected: "ignored" },
      }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "feishu-hub-concept-sync" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.conceptId).toBe("pcv5-1");
    expect(mocks.projectProductConceptToV5Hub).toHaveBeenCalledWith({
      context: { mode: "owner", token: "" }, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: "report", expectedFactHash: "fact", expectedEvidenceHash: "evidence", idempotencyKey: "concept-sync-1",
    });
    expect(mocks.projectProductConceptToV5Hub.mock.calls[0]?.[0]).not.toHaveProperty("fields");
  });
});

describe("POST choice / apply-team-recommendation readinessAcknowledged 透传（P0-DC-04）", () => {
  it("choice 路由把 readinessAcknowledged=true 透传给 saveResearchChoice", async () => {
    const { saveResearchChoice } = await import("@/lib/server/v5ResearchService");
    vi.mocked(saveResearchChoice).mockResolvedValueOnce({ taskId: "task-1" } as never);
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "choice-ack-1" }),
      json: async () => ({
        canonicalStatus: "PROCEED", readinessAcknowledged: true,
        expectedRevision: 1, expectedReportHash: "r", expectedFactHash: "f", expectedEvidenceHash: "e",
      }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "choice" }) });
    expect(response.status).toBe(200);
    expect(vi.mocked(saveResearchChoice)).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", readinessAcknowledged: true }),
    );
  });

  it("choice 路由在未携带标记时透传 false（服务端门禁自行裁决）", async () => {
    const { saveResearchChoice } = await import("@/lib/server/v5ResearchService");
    vi.mocked(saveResearchChoice).mockResolvedValueOnce({ taskId: "task-1" } as never);
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "choice-ack-2" }),
      json: async () => ({
        choice: "WATCH",
        expectedRevision: 1, expectedReportHash: "r", expectedFactHash: "f", expectedEvidenceHash: "e",
      }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "choice" }) });
    expect(response.status).toBe(200);
    expect(vi.mocked(saveResearchChoice)).toHaveBeenCalledWith(
      expect.objectContaining({ readinessAcknowledged: false }),
    );
  });

  it("apply-team-recommendation 路由同样透传 readinessAcknowledged", async () => {
    const { applyResearchTeamRecommendation } = await import("@/lib/server/v5ResearchService");
    vi.mocked(applyResearchTeamRecommendation).mockResolvedValueOnce({ taskId: "task-1" } as never);
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "apply-ack-1" }),
      json: async () => ({
        recommendationId: "rec-1", confirmed: true, readinessAcknowledged: true,
        expectedRevision: 1, expectedReportHash: "r", expectedFactHash: "f", expectedEvidenceHash: "e",
      }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "apply-team-recommendation" }) });
    expect(response.status).toBe(200);
    expect(vi.mocked(applyResearchTeamRecommendation)).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", readinessAcknowledged: true }),
    );
  });
});

describe("POST /api/research/[taskId]/jev-readiness-advisory（独立 dispatch 与安全门禁）", () => {
  it("路由到 runJevReadinessAdvisory，绝不触碰 runResearchAdvisory（DeepSeek 研报生成）", async () => {
    const service = await import("@/lib/server/v5ResearchService");
    vi.mocked(service.runJevReadinessAdvisory).mockResolvedValueOnce({ jevStatus: "available", meta: { cached: false } } as never);
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "jev-1" }),
      json: async () => ({ expectedRevision: 4, expectedFactHash: "f", expectedEvidenceHash: "e", confirmRerun: false, idempotencyKey: "jev-1", injectedField: "must-be-ignored" }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "jev-readiness-advisory" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.jevStatus).toBe("available");
    expect(vi.mocked(service.runJevReadinessAdvisory)).toHaveBeenCalledWith({
      context: { mode: "owner", token: "" }, taskId: "task-1", expectedRevision: 4,
      expectedFactHash: "f", expectedEvidenceHash: "e", confirmRerun: false, idempotencyKey: "jev-1",
    });
    expect(vi.mocked(service.runResearchAdvisory)).not.toHaveBeenCalled();
  });

  it("缺少有效 expectedRevision → 在进入服务层之前拒绝（0 调用）", async () => {
    const service = await import("@/lib/server/v5ResearchService");
    vi.mocked(service.runJevReadinessAdvisory).mockClear();
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "jev-2" }),
      json: async () => ({}),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "jev-readiness-advisory" }) });
    expect(vi.mocked(service.runJevReadinessAdvisory)).not.toHaveBeenCalled();
    expect(response.status).not.toBe(200);
  });

  it("缺少 expectedFactHash 或 expectedEvidenceHash → 拒绝且不进入服务层", async () => {
    const service = await import("@/lib/server/v5ResearchService");
    vi.mocked(service.runJevReadinessAdvisory).mockClear();
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "jev-2b" }),
      json: async () => ({ expectedRevision: 4, expectedFactHash: "f" }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "jev-readiness-advisory" }) });
    expect(response.status).toBe(400);
    expect(vi.mocked(service.runJevReadinessAdvisory)).not.toHaveBeenCalled();
  });

  it("鉴权失败 → 服务层零调用（writeAuth 前置门禁）", async () => {
    mocks.writeAuth.mockReturnValueOnce({ ok: false, status: 403, code: "origin_denied", message: "denied" } as never);
    const service = await import("@/lib/server/v5ResearchService");
    vi.mocked(service.runJevReadinessAdvisory).mockClear();
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "jev-3" }),
      json: async () => ({ expectedRevision: 4 }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", action: "jev-readiness-advisory" }) });
    expect(response.status).toBe(403);
    expect(vi.mocked(service.runJevReadinessAdvisory)).not.toHaveBeenCalled();
  });
});
