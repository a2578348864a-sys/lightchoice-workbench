import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pull: vi.fn(), boundedJsonBody: vi.fn(), boundedJsonBodyErrorResponse: vi.fn() }));
vi.mock("@/lib/server/v5HubDecisionPullService", () => ({ pullV5HubHumanDecisions: mocks.pull }));
vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@/lib/server/v5ApiRoute", () => ({
  authResponse: vi.fn(),
  boundedJsonBody: mocks.boundedJsonBody,
  boundedJsonBodyErrorResponse: mocks.boundedJsonBodyErrorResponse,
  originError: vi.fn(),
  writeAuth: () => ({ ok: true, context: { mode: "owner", token: "" } }), writeOriginOk: () => true,
  v5ErrorResponse: (error: Error) => Response.json({ ok: false, error: { message: error.message } }, { status: 500 }),
}));
vi.mock("@/lib/server/v5CoreCommon", () => ({
  okResponse: (data: unknown) => ({ body: { ok: true, data } }),
  requireIdempotencyKey: (key: string) => key,
  safeParseBody: (body: unknown) => body,
}));

import { POST } from "./route";

describe("POST /api/feishu-hub/decisions/pull", () => {
  beforeEach(() => vi.clearAllMocks());

  it("takes no decision payload from the caller and requires only an idempotency key", async () => {
    mocks.pull.mockResolvedValueOnce({ decisions: 0, appliedRecordIds: [], replayed: false });
    mocks.boundedJsonBody.mockImplementationOnce((request: { json: () => Promise<unknown> }) => request.json());
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "pull-1" }),
      json: async () => ({ idempotencyKey: "body-key", records: [{ status: "APPROVE" }] }),
    } as never;

    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.decisions).toBe(0);
    expect(mocks.pull).toHaveBeenCalledWith({ context: { mode: "owner", token: "" }, idempotencyKey: "pull-1" });
    expect(mocks.boundedJsonBody).toHaveBeenCalledWith(request, 1024);
  });

  it("rejects an oversized request body before invoking the remote decision pull", async () => {
    mocks.boundedJsonBody.mockRejectedValueOnce(new Error("REQUEST_BODY_TOO_LARGE"));
    mocks.boundedJsonBodyErrorResponse.mockReturnValueOnce(Response.json({ ok: false }, { status: 413 }));
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "pull-large" }),
    } as never;

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(mocks.pull).not.toHaveBeenCalled();
  });
});
