import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  requireOwnerOnly: vi.fn(),
  getAuthoritativeCandidate: vi.fn(),
  analyzeResearchPriority: vi.fn(),
  buildDecisionSnapshot: vi.fn(),
  parseDecisionSnapshot: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireAuthenticated: mocks.requireAuthenticated,
  requireOwnerOnly: mocks.requireOwnerOnly,
}));

vi.mock("@/lib/server/candidateAuthority", () => ({
  getAuthoritativeCandidate: mocks.getAuthoritativeCandidate,
}));

vi.mock("@/lib/server/db", () => ({
  prisma: { opportunityCandidate: { update: mocks.update } },
}));

vi.mock("@/lib/decision/decisionEngine", () => ({
  analyzeResearchPriority: mocks.analyzeResearchPriority,
  buildDecisionSnapshot: mocks.buildDecisionSnapshot,
  parseDecisionSnapshot: mocks.parseDecisionSnapshot,
}));

import { GET, POST } from "./route";

const OWNER_CONTEXT = { mode: "owner" as const, token: "owner-token" };

function formalCandidate() {
  return {
    id: "cand-1",
    name: "Test Product",
    rawInput: "input",
    link: null,
    score: 80,
    source: "sellersprite",
    keyword: "",
    riskLevel: "low",
    riskLabel: "低",
    summaryLabel: "",
    status: "worth_analyzing",
    sourceMetaJson: "{}",
    analysisJson: "{}",
    convertedTaskId: null,
    originProductBatchItemId: null,
  };
}

function request(method: "GET" | "POST") {
  return new NextRequest("http://localhost/api/decision/research-priority/cand-1", { method });
}

const routeContext = { params: Promise.resolve({ candidateId: "cand-1" }) };

describe("AUTH-001 · Decision Priority 路由对象授权", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: OWNER_CONTEXT });
    mocks.requireOwnerOnly.mockReturnValue({ ok: true, context: OWNER_CONTEXT });
    mocks.parseDecisionSnapshot.mockReturnValue(null);
    mocks.analyzeResearchPriority.mockResolvedValue({
      priority: "P1",
      score: 80,
      status: "completed",
      confidence: 0.8,
      reasons: [],
      risks: [],
      provider: "typesafe",
      model: "jev-latest",
      timestamp: "2026-09-21T00:00:00.000Z",
    });
    mocks.buildDecisionSnapshot.mockReturnValue({
      schema: "decision-snapshot.v1",
      provider: "typesafe",
      model: "jev-latest",
      inputFactsHash: "hash",
      output: { priority: "P1" },
      createdAt: "2026-09-21T00:00:00.000Z",
    });
    mocks.update.mockResolvedValue({});
  });

  it("Demo/访客的 POST 一律 403，且不读取候选、不调用 Provider、不写入", async () => {
    mocks.requireOwnerOnly.mockReturnValue({
      ok: false,
      status: 403,
      code: "demo_action_forbidden",
      message: "访客体验模式下不写入正式任务数据。",
    });

    const response = await POST(request("POST"), routeContext);

    expect(response.status).toBe(403);
    expect(mocks.getAuthoritativeCandidate).not.toHaveBeenCalled();
    expect(mocks.analyzeResearchPriority).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("跨范围候选（对象授权返回 null）→ 404，且不调用 Provider、不写入", async () => {
    mocks.getAuthoritativeCandidate.mockResolvedValue(null);

    const response = await POST(request("POST"), routeContext);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("candidate_not_found");
    expect(mocks.analyzeResearchPriority).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("GET 跨范围候选 → 404（不区分不存在与无权，避免探测存在性）", async () => {
    mocks.getAuthoritativeCandidate.mockResolvedValue(null);

    const response = await GET(request("GET"), routeContext);

    expect(response.status).toBe(404);
    expect(mocks.analyzeResearchPriority).not.toHaveBeenCalled();
  });

  it("Owner 正式候选：正常分析并写回 analysisJson", async () => {
    mocks.getAuthoritativeCandidate.mockResolvedValue(formalCandidate());

    const response = await POST(request("POST"), routeContext);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.cached).toBe(false);
    expect(mocks.getAuthoritativeCandidate).toHaveBeenCalledWith(OWNER_CONTEXT, "cand-1");
    expect(mocks.analyzeResearchPriority).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cand-1" },
    }));
  });

  it("GET 只读取已授权候选的既有快照，不触发 Provider", async () => {
    mocks.getAuthoritativeCandidate.mockResolvedValue(formalCandidate());
    mocks.parseDecisionSnapshot.mockReturnValue({
      createdAt: "2026-09-21T00:00:00.000Z",
      output: { priority: "P2" },
    });

    const response = await GET(request("GET"), routeContext);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ priority: "P2" });
    expect(mocks.analyzeResearchPriority).not.toHaveBeenCalled();
  });
});
