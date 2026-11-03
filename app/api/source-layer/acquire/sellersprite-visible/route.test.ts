import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  isSameOriginRequest: vi.fn(),
  captureSellerSpriteVisibleQuery: vi.fn(),
  collectSellerSpriteVisibleModuleWithPlaywright: vi.fn(),
  evidenceStore: { getSubject: vi.fn() },
  createEvidenceStore: vi.fn(),
  jobRepository: { ensure: vi.fn(), getByFingerprint: vi.fn(), claim: vi.fn(), claimSourceRecheck: vi.fn(), retry: vi.fn(), saveProgress: vi.fn(), getById: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/accessPassword", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/lib/server/sellerSpriteVisibleQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/sellerSpriteVisibleQuery")>();
  return { ...actual, captureSellerSpriteVisibleQuery: mocks.captureSellerSpriteVisibleQuery };
});
vi.mock("@/lib/server/sellerSpriteVisibleBrowser", () => ({
  collectSellerSpriteVisibleModuleWithPlaywright: mocks.collectSellerSpriteVisibleModuleWithPlaywright,
}));
vi.mock("@/lib/server/sellerSpriteCaptureJobRepository", () => ({
  createSellerSpriteCaptureJobRepository: () => mocks.jobRepository,
}));
vi.mock("@/lib/sourceLayer/server/evidenceStore", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sourceLayer/server/evidenceStore")>(),
  createEvidenceStore: mocks.createEvidenceStore,
}));

import { NextRequest } from "next/server";
import { sellerSpriteCaptureAccessScopeHash } from "@/lib/server/sellerSpriteCaptureJob";
import { POST } from "@/app/api/source-layer/acquire/sellersprite-visible/route";
import { sellerSpriteKeywordMiningQuerySubjectKey } from "@/lib/server/sellerSpriteVisibleQuery";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/source-layer/acquire/sellersprite-visible", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseBody = {
  module: "reverse_asin",
  sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
  subjectKey: "amazon:US:B012345678",
  identity: { asin: "B012345678" },
  queryInput: { module: "reverse_asin", targetAsin: "B012345678", marketplace: "US" },
};

describe("SellerSprite visible query route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", role: "owner" } });
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.createEvidenceStore.mockReturnValue(mocks.evidenceStore);
    mocks.evidenceStore.getSubject.mockResolvedValue({ versions: [{ version: 1 }] });
    mocks.jobRepository.getByFingerprint.mockResolvedValue(null);
    const pending = {
      jobId: "job-1", status: "PENDING", attemptGeneration: 0, fence: 0, leaseOwner: null, leaseExpiresAt: null, windowBudget: 8,
      cursor: null, rowKeys: [], structuredValidRowKeys: [], evidenceRefs: [],
      counters: { reportedTotalRows: null, accessibleRows: null, capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: null },
    };
    const running = { ...pending, status: "RUNNING", attemptGeneration: 1, fence: 1, leaseOwner: "seller-sprite-route-123" };
    mocks.jobRepository.ensure.mockImplementation(async (input: { windowBudget?: number }) => ({
      job: { ...pending, windowBudget: input.windowBudget ?? 8 }, created: true,
    }));
    mocks.jobRepository.claim.mockResolvedValue({ job: running, fence: 1 });
    mocks.jobRepository.retry.mockResolvedValue(pending);
    mocks.jobRepository.saveProgress.mockImplementation(async (_jobId, _worker, _fence, progress) => ({ ...running, ...progress, status: progress.status }));
    mocks.jobRepository.getById.mockResolvedValue({ ...pending, accessScopeHash: sellerSpriteCaptureAccessScopeHash("owner") });
    mocks.jobRepository.pause.mockResolvedValue({ ...pending, status: "PAUSED" });
    mocks.jobRepository.resume.mockResolvedValue({ ...pending, status: "PENDING" });
    mocks.jobRepository.cancel.mockResolvedValue({ ...pending, status: "CANCELLED" });
  });

  it("requires a valid page-specific query input before invoking the collector", async () => {
    const response = await POST(request({ ...baseBody, queryInput: undefined }) as never);
    expect(response.status).toBe(400);
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("prepares seed-query evidence without inventing an ASIN and without executing collection", async () => {
    const queryInput = { module: "keyword_mining_trend" as const, seedKeyword: "silicone baking mat", marketplace: "US" as const };
    const response = await POST(request({action:"prepare",module:queryInput.module,sourceUrl:"https://www.sellersprite.com/v3/keyword-miner/",subjectKey:"sellersprite-query:auto",identity:{keyword:queryInput.seedKeyword},queryInput,windowBudget:1}));
    expect(response.status).toBe(201);
    expect(mocks.evidenceStore.getSubject).not.toHaveBeenCalled();
    expect(mocks.jobRepository.ensure).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({subjectKey:sellerSpriteKeywordMiningQuerySubjectKey(queryInput),seedKeyword:queryInput.seedKeyword}) }));
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("blocks a new product without base Evidence before creating a Job or opening SellerSprite", async () => {
    mocks.evidenceStore.getSubject.mockResolvedValueOnce(null);

    const response = await POST(request(baseBody) as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "evidence_missing", status: "human_required" });
    expect(body.error.message).toContain("先通过已授权的合法来源");
    expect(mocks.createEvidenceStore).toHaveBeenCalledWith("owner:v1");
    expect(mocks.evidenceStore.getSubject).toHaveBeenCalledWith(baseBody.subjectKey);
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.jobRepository.claim).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
    expect(mocks.collectSellerSpriteVisibleModuleWithPlaywright).not.toHaveBeenCalled();
  });

  it("blocks a malformed empty-version subject instead of inventing Product Evidence", async () => {
    mocks.evidenceStore.getSubject.mockResolvedValueOnce({ versions: [] });

    const response = await POST(request({ ...baseBody, action: "prepare" }) as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("evidence_missing");
    expect(body.error.status).toBe("human_required");
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("fails closed when the current access scope EvidenceStore cannot be read", async () => {
    mocks.evidenceStore.getSubject.mockRejectedValueOnce(new Error("read failed"));

    const response = await POST(request(baseBody) as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("subject_evidence_preflight_unavailable");
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("reads existing product Evidence from the authenticated demo scope", async () => {
    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "demo", role: "demo", demoAccessId: "demo-scope-7" },
    });

    const response = await POST(request({ ...baseBody, action: "prepare" }) as never);

    expect(response.status).toBe(201);
    expect(mocks.createEvidenceStore).toHaveBeenCalledWith("visitor:demo-scope-7");
    expect(mocks.evidenceStore.getSubject).toHaveBeenCalledWith(baseBody.subjectKey);
    expect(mocks.jobRepository.ensure).toHaveBeenCalledWith(expect.objectContaining({ accessScope: "demo:demo-scope-7" }));
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("rechecks existing Product Evidence on repeated prepare without writing a second evidence record", async () => {
    mocks.jobRepository.ensure.mockResolvedValue({
      job: { jobId: "same-idempotent-job", status: "PENDING", attemptGeneration: 0, windowBudget: 8 },
      created: false,
    });

    const first = await POST(request({ ...baseBody, action: "prepare" }) as never);
    const second = await POST(request({ ...baseBody, action: "prepare" }) as never);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mocks.jobRepository.ensure).toHaveBeenCalledTimes(2);
    expect(mocks.evidenceStore.getSubject).toHaveBeenCalledTimes(2);
    expect(Object.keys(mocks.evidenceStore)).toEqual(["getSubject"]);
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("fails closed when the SellerSprite query ASIN is not bound to its evidence subject", async () => {
    const response = await POST(request({ ...baseBody, subjectKey: "amazon:US:B099999999" }) as never);
    expect(response.status).toBe(400);
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
  });

  it("keeps the Amazon evidence subject separate from the Keyword Mining seed", async () => {
    const subjectKey = "amazon:US:B012345678";
    const response = await POST(request({
      action: "prepare",
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey,
      identity: { keyword: "wood cutting board" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "wood cutting board", marketplace: "US" },
    }) as never);

    expect(response.status).toBe(201);
    expect(mocks.jobRepository.ensure).toHaveBeenCalledWith(expect.objectContaining({
      module: "keyword_mining_trend",
      marketplace: "US",
      query: { subjectKey, seedKeyword: "wood cutting board", conditions: "{}" },
      accessScope: "owner",
    }));
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("rejects a Keyword Mining seed that differs from its query identity before creating a job", async () => {
    const response = await POST(request({
      action: "prepare",
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "different seed" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "wood cutting board", marketplace: "US" },
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("sellersprite_query_identity_mismatch");
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing reverse-ASIN identity before creating a durable job or opening CDP", async () => {
    const response = await POST(request({ ...baseBody, identity: {} }) as never);
    expect(response.status).toBe(400);
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("rejects an invalid user window budget before creating a durable job", async () => {
    const response = await POST(request({ ...baseBody, windowBudget: 21 }) as never);
    expect(response.status).toBe(400);
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("passes the typed query identity and returns Gateway evidence on success", async () => {
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValue({
      status: "captured",
      module: "reverse_asin",
      sourceUrl: baseBody.sourceUrl,
      snapshot: { queryInputs: ["B012345678"], tables: [] },
      capture: {
        gateway: { created: true, duplicate: false },
        attachment: { id: "attachment-1", attachmentId: "attachment-1" },
        rawArtifact: { created: true, duplicate: false, artifact: { id: "raw-1" } },
        downstream: { readable: true },
      },
      errorCode: null,
    });
    mocks.jobRepository.claim.mockResolvedValueOnce({
      job: {
        jobId: "job-1", status: "RUNNING", attemptGeneration: 1, fence: 1,
        leaseOwner: "seller-sprite-route-123", windowBudget: 2,
        cursor: null, rowKeys: [], structuredValidRowKeys: [], persistedRowKeys: [], evidenceRefs: [],
        counters: { reportedTotalRows: null, accessibleRows: null, capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: null },
      },
      fence: 1,
    });
    const response = await POST(request({ ...baseBody, windowBudget: 2 }) as never);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.captureSellerSpriteVisibleQuery).toHaveBeenCalledWith(expect.objectContaining({
      module: "reverse_asin",
      queryInput: baseBody.queryInput,
      sourceUrl: baseBody.sourceUrl,
      maxWindows: 2,
    }));
    expect(mocks.jobRepository.ensure).toHaveBeenCalledWith(expect.objectContaining({ windowBudget: 2 }));
    expect(body.data.attachment.id).toBe("attachment-1");
    expect(body.data.captureJob.status).toBe("PARTIAL");
    expect(body.data.provenance).toEqual(expect.arrayContaining(["NEW_JOB", "NEW_EVIDENCE", "QUERY_EXECUTED"]));
    expect(mocks.jobRepository.saveProgress).toHaveBeenCalledWith("job-1", "seller-sprite-route-123", 1,
      expect.objectContaining({ status: "PARTIAL", counters: expect.objectContaining({ capturedUniqueRows: 0 }) }));
  });

  it("distinguishes a reused prepared Job from new Evidence on its first capture", async () => {
    const preparedJob = {
      jobId: "prepared-job", status: "PENDING", attemptGeneration: 0, windowBudget: 8,
      evidenceRefs: [], persistedRowKeys: [], rowKeys: [], structuredValidRowKeys: [],
      counters: { reportedTotalRows: null, accessibleRows: null, capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: null },
    };
    mocks.jobRepository.getByFingerprint.mockResolvedValueOnce(preparedJob);
    mocks.jobRepository.ensure.mockResolvedValueOnce({ job: preparedJob, created: false });
    mocks.jobRepository.claim.mockResolvedValueOnce({
      job: { ...preparedJob, status: "RUNNING", attemptGeneration: 1, fence: 1, leaseOwner: "seller-sprite-route-123" },
      fence: 1,
    });
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValueOnce({
      status: "captured",
      module: "reverse_asin",
      sourceUrl: baseBody.sourceUrl,
      snapshot: { queryInputs: ["B012345678"], tables: [] },
      capture: {
        gateway: { created: true, duplicate: false },
        attachment: { id: "new-attachment", attachmentId: "new-attachment" },
        rawArtifact: { created: true, duplicate: false, artifact: { id: "new-raw" } },
        downstream: { readable: true },
      },
      errorCode: null,
    });

    const response = await POST(request(baseBody) as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.provenance).toEqual(expect.arrayContaining([
      "REUSED_JOB", "NEW_EVIDENCE", "QUERY_EXECUTED",
    ]));
    expect(body.data.provenance).not.toContain("HISTORICAL_EVIDENCE");
  });

  it("prepares a durable bounded job without opening SellerSprite", async () => {
    const response = await POST(request({ ...baseBody, action: "prepare", windowBudget: 3 }) as never);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data.captureJob.status).toBe("PENDING");
    expect(body.data.captureJob.windowBudget).toBe(3);
    expect(body.data.provenance).toEqual(expect.arrayContaining(["NEW_JOB", "NOT_EXECUTED"]));
    expect(mocks.jobRepository.claim).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("marks a reused Job's duplicate Gateway attachment as historical Evidence", async () => {
    const historicalJob = {
      jobId: "job-history", status: "PARTIAL", attemptGeneration: 1, windowBudget: 8,
      evidenceRefs: ["attachment:prior"], persistedRowKeys: ["generation:1:row-1"],
    };
    mocks.jobRepository.getByFingerprint.mockResolvedValueOnce(historicalJob);
    mocks.jobRepository.ensure.mockResolvedValueOnce({ job: historicalJob, created: false });
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValueOnce({
      status: "captured",
      module: "reverse_asin",
      sourceUrl: baseBody.sourceUrl,
      snapshot: { queryInputs: ["B012345678"], tables: [] },
      capture: {
        gateway: { created: false, duplicate: true },
        attachment: { id: "attachment-prior", attachmentId: "attachment-prior" },
        rawArtifact: { created: false, duplicate: true, artifact: { id: "raw-prior" } },
        downstream: { readable: true },
      },
      errorCode: null,
    });

    const response = await POST(request(baseBody) as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.provenance).toEqual(expect.arrayContaining([
      "REUSED_JOB", "HISTORICAL_EVIDENCE", "QUERY_EXECUTED",
    ]));
    expect(body.data.provenance).not.toContain("NEW_EVIDENCE");
  });

  it("persists a newly observed membership limit as PARTIAL with unknown access counts", async () => {
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValue({
      status: "limited",
      module: "reverse_asin",
      sourceUrl: baseBody.sourceUrl,
      snapshot: { queryInputs: ["B012345678"], tables: [] },
      capture: null,
      windows: [],
      traversal: {
        finalStatus: "PARTIAL",
        limitationReason: "source_limit_declared",
        errorCode: null,
        counters: {
          reportedTotalRows: 517,
          accessibleRows: null,
          capturedUniqueRows: 0,
          structuredValidRows: 0,
          persistedEvidenceRows: 0,
          unavailableRows: null,
        },
        diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
        cursor: null,
        captureGeneration: 1,
        snapshotFingerprint: "a".repeat(64),
      },
      errorCode: null,
    });

    const response = await POST(request(baseBody) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("PARTIAL");
    expect(body.data.coverage).toMatchObject({
      reportedTotalRows: 517,
      accessibleRows: null,
      capturedUniqueRows: 0,
      structuredValidRows: 0,
      persistedEvidenceRows: 0,
      unavailableRows: null,
    });
    expect(body.data.captureJob.limitationReason).toBe("source_limit_declared");
    expect(body.data.provenance).toEqual(expect.arrayContaining(["NEW_JOB", "SOURCE_LIMITED", "QUERY_EXECUTED"]));
    expect(mocks.jobRepository.saveProgress).toHaveBeenCalledWith("job-1", "seller-sprite-route-123", 1,
      expect.objectContaining({ status: "PARTIAL", limitationReason: "source_limit_declared", counters: expect.objectContaining({ reportedTotalRows: 517 }) }));
    expect(mocks.jobRepository.retry).not.toHaveBeenCalled();
  });

  it("preserves a declared plan limit and blocks retry before opening SellerSprite", async () => {
    mocks.jobRepository.getByFingerprint.mockResolvedValueOnce({
      jobId: "limited-job", status: "PARTIAL", attemptGeneration: 2, fence: 2,
      leaseOwner: null, leaseExpiresAt: null, windowBudget: 8, limitationReason: "source_limit_declared",
      evidenceRefs: ["attachment:historical"], persistedRowKeys: ["generation:1:row-1"],
    });
    const response = await POST(request({ ...baseBody, windowBudget: 8 }) as never);
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("capture_job_source_limited");
    expect(body.data.provenance).toEqual(expect.arrayContaining([
      "REUSED_JOB", "HISTORICAL_EVIDENCE", "SOURCE_LIMITED", "NOT_EXECUTED",
    ]));
    expect(mocks.jobRepository.ensure).not.toHaveBeenCalled();
    expect(mocks.createEvidenceStore).not.toHaveBeenCalled();
    expect(mocks.jobRepository.retry).not.toHaveBeenCalled();
    expect(mocks.jobRepository.claim).not.toHaveBeenCalled();
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("requires the exact blocked job and keeps access blocked when the explicit source recheck is unavailable", async () => {
    const limited = {jobId:"limited-job", status:"PARTIAL", attemptGeneration:2, fence:2, limitationReason:"source_limit_declared", windowBudget:8, cursor:null, evidenceRefs:["attachment:historical"], counters:{capturedUniqueRows:0,structuredValidRows:0,persistedEvidenceRows:0,reportedTotalRows:null,accessibleRows:null,unavailableRows:null}};
    mocks.jobRepository.getByFingerprint.mockResolvedValue(limited);
    const wrong = await POST(request({...baseBody,action:"recheck",jobId:"other-job"}));
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("source_recheck_not_required");
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
    mocks.jobRepository.ensure.mockResolvedValue({job:limited,created:false});
    mocks.jobRepository.claimSourceRecheck.mockResolvedValue({job:{...limited,status:"RUNNING",windowBudget:1,attemptGeneration:3,fence:3,leaseOwner:"recheck-worker"},fence:3});
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValue({status:"unavailable",module:"reverse_asin",sourceUrl:baseBody.sourceUrl,snapshot:null,capture:null,errorCode:"SELLERSPRITE_CDP_UNAVAILABLE"});
    const response = await POST(request({...baseBody,action:"recheck",jobId:"limited-job"}));
    expect(response.status).toBe(503);
    expect(mocks.captureSellerSpriteVisibleQuery).toHaveBeenCalledWith(expect.objectContaining({maxWindows:1,attemptGeneration:3}));
    expect(mocks.jobRepository.retry).not.toHaveBeenCalled();
    // 重新核验遇到 CDP/运行时技术失败时必须标 technical_error，不得冒充套餐限制。
    expect(mocks.jobRepository.saveProgress).toHaveBeenCalledWith("limited-job",expect.any(String),3,expect.objectContaining({limitationReason:"technical_error",lastErrorCode:"SELLERSPRITE_CDP_UNAVAILABLE"}));
    expect((await response.json()).data.captureJob.limitationReason).toBe("technical_error");
  });

  it("supports owner-bound status and pause controls without reopening the browser query", async () => {
    const response = await POST(request({ action: "pause", jobId: "job-1" }) as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.captureJob.status).toBe("PAUSED");
    expect(body.data.provenance).toEqual(expect.arrayContaining(["REUSED_JOB", "NOT_EXECUTED"]));
    expect(mocks.jobRepository.pause).toHaveBeenCalledWith("job-1", "owner");
    expect(mocks.captureSellerSpriteVisibleQuery).not.toHaveBeenCalled();
  });

  it("does not expose another access scope's job by guessed id", async () => {
    mocks.jobRepository.getById.mockResolvedValueOnce({ jobId: "guessed-id", accessScopeHash: "f".repeat(64) });
    const response = await POST(request({ action: "status", jobId: "guessed-id" }) as never);
    expect(response.status).toBe(404);
    expect(mocks.jobRepository.pause).not.toHaveBeenCalled();
  });

  it.each([
    ["human_required", 200, "SELLERSPRITE_CAPTCHA_REQUIRED"],
    ["unavailable", 503, "SELLERSPRITE_CDP_UNAVAILABLE"],
    ["empty", 200, "SELLERSPRITE_QUERY_EMPTY"],
    ["query_error", 200, "SELLERSPRITE_QUERY_ERROR_VISIBLE"],
  ] as const)("keeps %s as an explicit non-success state", async (status, httpStatus, errorCode) => {
    mocks.captureSellerSpriteVisibleQuery.mockResolvedValue({
      status,
      module: "reverse_asin",
      sourceUrl: baseBody.sourceUrl,
      snapshot: null,
      capture: null,
      errorCode,
    });
    const response = await POST(request(baseBody) as never);
    const body = await response.json();
    expect(response.status).toBe(httpStatus);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(errorCode);
    expect(mocks.jobRepository.saveProgress).toHaveBeenCalled();
  });
});
