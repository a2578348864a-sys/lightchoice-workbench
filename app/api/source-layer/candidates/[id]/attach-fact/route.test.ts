import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireOwnerOnly: vi.fn(),
  attachProductFactToExistingCandidate: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireOwnerOnly: mocks.requireOwnerOnly,
}));

vi.mock("@/lib/sourceLayer/server/candidateFactRecovery", () => ({
  attachProductFactToExistingCandidate: mocks.attachProductFactToExistingCandidate,
  CandidateFactRecoveryError: class extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "CandidateFactRecoveryError";
    }
  },
}));

import { POST } from "./route";

describe("POST /api/source-layer/candidates/[id]/attach-fact", () => {
  beforeEach(() => {
    mocks.requireOwnerOnly.mockReset();
    mocks.attachProductFactToExistingCandidate.mockReset();
    mocks.requireOwnerOnly.mockReturnValue({ ok: true, context: { mode: "owner", token: "valid-token" } });
  });

  it("rejects unauthorized calls", async () => {
    mocks.requireOwnerOnly.mockReturnValueOnce({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
    const request = new NextRequest("http://127.0.0.1:3005/api/source-layer/candidates/cand-1/attach-fact", {
      method: "POST",
    });
    const response = await POST(request, { params: Promise.resolve({ id: "cand-1" }) });
    expect(response.status).toBe(401);
  });

  it("rejects demo/visitor calls before touching a formal Candidate", async () => {
    mocks.requireOwnerOnly.mockReturnValueOnce({
      ok: false,
      status: 403,
      code: "demo_action_forbidden",
      message: "访客体验模式下不写入正式任务数据。",
    });

    const request = new NextRequest("http://127.0.0.1:3005/api/source-layer/candidates/owner-candidate-1/attach-fact", {
      method: "POST",
    });
    const response = await POST(request, { params: Promise.resolve({ id: "owner-candidate-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.attachProductFactToExistingCandidate).not.toHaveBeenCalled();
  });

  it("returns 200 on successful fact attachment", async () => {
    mocks.attachProductFactToExistingCandidate.mockResolvedValueOnce({
      candidateId: "cand-1",
      asin: "B00000JBNX",
      productFact: { schema: "product-fact.v3" },
      alreadyAttached: false,
    });

    const request = new NextRequest("http://127.0.0.1:3005/api/source-layer/candidates/cand-1/attach-fact", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    const response = await POST(request, { params: Promise.resolve({ id: "cand-1" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.data.asin).toBe("B00000JBNX");
  });
});
