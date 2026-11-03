import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ project: vi.fn(), boundedJsonBody: vi.fn(), boundedJsonBodyErrorResponse: vi.fn() }));
vi.mock("@/lib/server/v5HubSourceProjectionService", () => ({ projectV3KeywordEvidenceToV5Hub: mocks.project }));
vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@/lib/server/v5ApiRoute", () => ({
  authResponse: vi.fn(), boundedJsonBody: mocks.boundedJsonBody, boundedJsonBodyErrorResponse: mocks.boundedJsonBodyErrorResponse, originError: vi.fn(),
  writeAuth: () => ({ ok: true, context: { mode: "owner", token: "" } }), writeOriginOk: () => true,
  v5ErrorResponse: (error: Error) => Response.json({ ok: false, error: { message: error.message } }, { status: 500 }),
}));
vi.mock("@/lib/server/v5CoreCommon", () => ({
  okResponse: (data: unknown) => ({ body: { ok: true, data } }),
  requireIdempotencyKey: (key: string) => key,
  safeParseBody: (body: unknown) => body,
}));

import { POST } from "./route";

describe("POST /api/feishu-hub/keywords/[subjectKey]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts identity and idempotency only; caller cannot provide projected fields", async () => {
    mocks.project.mockResolvedValueOnce({ status: "PROJECTED", replayed: false });
    mocks.boundedJsonBody.mockImplementationOnce((request: { json: () => Promise<unknown> }) => request.json());
    const request = {
      headers: new Headers({ "Content-Type": "application/json", "Idempotency-Key": "keywords-1" }),
      json: async () => ({ fields: { injected: "ignored" }, idempotencyKey: "body-key" }),
    } as never;
    const response = await POST(request, { params: Promise.resolve({ subjectKey: "amazon:US:B000000001" }) });
    expect(response.status).toBe(200);
    expect(mocks.project).toHaveBeenCalledWith({
      context: { mode: "owner", token: "" }, subjectKey: "amazon:US:B000000001", idempotencyKey: "keywords-1",
    });
    expect(mocks.project.mock.calls[0]?.[0]).not.toHaveProperty("fields");
    expect(mocks.boundedJsonBody).toHaveBeenCalledWith(request, 1024);
  });

  it("rejects oversized input before invoking the projection service", async () => {
    mocks.boundedJsonBody.mockRejectedValueOnce(new Error("REQUEST_BODY_TOO_LARGE"));
    mocks.boundedJsonBodyErrorResponse.mockReturnValueOnce(Response.json({ ok: false }, { status: 413 }));
    const request = { headers: new Headers({ "Idempotency-Key": "keyword-large" }) } as never;
    const response = await POST(request, { params: Promise.resolve({ subjectKey: "amazon:US:B000000001" }) });
    expect(response.status).toBe(413);
    expect(mocks.project).not.toHaveBeenCalled();
  });
});
