import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashJson } from "@/lib/server/v5CoreCommon";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  itemsCount: 5,
  run: null as Record<string, unknown> | null,
  receipts: [] as Array<Record<string, unknown>>,
  receiptId: 0,
  getBatch: vi.fn(),
  resolveNavigation: vi.fn(),
  readVerified: vi.fn(),
  collect: vi.fn(),
  append: vi.fn(),
  status: vi.fn(),
  reserveExpansion: vi.fn(),
  releaseExpansion: vi.fn(),
  startExpansion: vi.fn(),
  isRunning: vi.fn(),
  ensureRunning: vi.fn(),
}));

vi.mock("@/lib/server/v5ApiRoute", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/v5ApiRoute")>("@/lib/server/v5ApiRoute");
  return { ...actual, readAuth: mocks.auth };
});
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/amazonSearchProductBatchHandoff", () => ({
  appendAmazonSearchProductBatch: mocks.append,
  readVerifiedAmazonSearchEvidence: mocks.readVerified,
}));
vi.mock("@/lib/server/batchCaptureRunExecutor", () => ({
  getBatchCaptureRunExecutor: () => ({ isRunning: mocks.isRunning, ensureRunning: mocks.ensureRunning }),
}));
vi.mock("@/lib/server/batchCaptureSearchNavigation", () => ({ resolveBatchSearchNavigationUsed: mocks.resolveNavigation }));
vi.mock("@/lib/server/captureRecipeBrowser", () => ({ collectAmazonSearchWithPlaywright: mocks.collect }));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    v5OperationReceipt: {
      findUnique: async ({ where }: { where: { id?: string; actorScope_operation_resourceKey_idempotencyKey?: Record<string, unknown> } }) => {
        if (where.id) return mocks.receipts.find((row) => row.id === where.id) ?? null;
        const key = where.actorScope_operation_resourceKey_idempotencyKey;
        return key ? mocks.receipts.find((row) => Object.entries(key).every(([name, value]) => row[name] === value)) ?? null : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (mocks.receipts.some((row) => ["actorScope", "operation", "resourceKey", "idempotencyKey"]
          .every((key) => row[key] === data[key]))) throw new Error("unique_constraint");
        const row = { id: `receipt-${++mocks.receiptId}`, ...data, updatedAt: new Date() };
        mocks.receipts.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mocks.receipts.find((entry) => Object.entries(where).every(([key, value]) => entry[key] === value));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({
    getBatch: async () => mocks.getBatch(),
    getBatchItems: async () => Array.from({ length: mocks.itemsCount }, (_, index) => ({
      id: `item-${index}`,
      asin: `B${String(index + 1).padStart(9, "0")}`,
      ordinal: index,
      archivedAt: null,
    })),
  }),
}));
vi.mock("@/lib/server/productBatchRepository", () => ({ createProductBatchRepository: () => ({}) }));
vi.mock("@/lib/server/batchCaptureRunService", () => ({
  createBatchCaptureRunService: () => ({
    status: async () => mocks.status(),
    reserveExpansion: mocks.reserveExpansion,
    releaseExpansion: mocks.releaseExpansion,
    startExpansion: mocks.startExpansion,
  }),
}));
vi.mock("@/lib/sourceLayer/diagnostics", () => ({ newTraceId: () => "isolated-expansion-trace" }));

import { GET, POST } from "./route";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const BATCH_ID = "batch-market-0001";
const AUTHORIZATION_ID = "auth_expansion_test_001";

function run(status: string, generation = 1): Record<string, unknown> {
  return {
    runId: `run-${generation}`,
    batchId: BATCH_ID,
    status,
    runGeneration: generation,
    version: 2,
    authorizedAsins: Array.from({ length: 5 }, (_, index) => `B${String(index + 1).padStart(9, "0")}`),
    executionEpoch: 1,
    acknowledgedEpoch: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    cells: [],
  };
}

function getRequest(targetTotal: number): NextRequest {
  return new NextRequest(`http://localhost:3010/api/source-layer/capture-plan/expand?batchId=${BATCH_ID}&targetTotal=${targetTotal}`);
}

function postRequest(targetTotal: number, fingerprint: string, authorizationId = AUTHORIZATION_ID): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/capture-plan/expand", {
    method: "POST",
    headers: { host: "localhost:3010", origin: "http://localhost:3010", "content-type": "application/json" },
    body: JSON.stringify({ batchId: BATCH_ID, targetTotal, planFingerprint: fingerprint, authorizationId }),
  });
}

function recoveryRequest(authorizationId = AUTHORIZATION_ID, confirmProfileReleased = true): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/capture-plan/expand", {
    method: "POST",
    headers: { host: "localhost:3010", origin: "http://localhost:3010", "content-type": "application/json" },
    body: JSON.stringify({ action: "recover_stalled", batchId: BATCH_ID, authorizationId, confirmProfileReleased }),
  });
}

async function previewFingerprint(): Promise<string> {
  const response = await GET(getRequest(30));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.data.preview).toMatchObject({ currentItemCount: 5, targetTotal: 30, maxAdditionalSearchCount: 25, canConfirm: true });
  return body.data.preview.planFingerprint as string;
}

describe("/api/source-layer/capture-plan/expand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "true");
    mocks.itemsCount = 5;
    mocks.receipts = [];
    mocks.receiptId = 0;
    mocks.run = run("HUMAN_REQUIRED");
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.getBatch.mockReturnValue({
      id: BATCH_ID,
      batchStatus: "ready",
      reportType: "search_results",
      query: "isolated query",
      updatedAt: "2026-10-17T00:00:00.000Z",
      sourceFileSha256: "isolated-batch-hash",
      normalizedSnapshotJson: JSON.stringify({ sourceType: "amazon_search_capture" }),
    });
    mocks.resolveNavigation.mockReturnValue({ known: true, used: 1, provenance: "search_stage_receipt", reason: "" });
    mocks.readVerified.mockImplementation(async ({ items }: { items: Array<{ asin: string }> }) => items.map((item) => ({
      asin: item.asin,
      evidenceId: `evidence-${item.asin}`,
    })));
    mocks.reserveExpansion.mockResolvedValue({ runId: "run-1", status: "HUMAN_REQUIRED", runGeneration: 1 });
    mocks.releaseExpansion.mockResolvedValue(null);
    mocks.isRunning.mockReturnValue(false);
    mocks.ensureRunning.mockResolvedValue({ started: true, errorCode: null });
    mocks.startExpansion.mockImplementation(async () => {
      mocks.itemsCount = 23;
      mocks.run = run("HUMAN_REQUIRED", 2);
      return { created: true, newlyAuthorizedAsins: [], run: mocks.run };
    });
    mocks.status.mockImplementation(() => mocks.run);
    mocks.collect.mockResolvedValue({
      status: "captured",
      plan: { query: "isolated query", pageCount: 1 },
      captures: Array.from({ length: 18 }, (_, index) => ({ asin: `B${String(index + 6).padStart(9, "0")}` })),
    });
    mocks.append.mockImplementation(async () => {
      mocks.itemsCount = 23;
      return {
        addedCount: 18,
        duplicateProductCount: 0,
        validEvidenceCount: 23,
        newlyCapturedAsins: Array.from({ length: 18 }, (_, index) => `B${String(index + 6).padStart(9, "0")}`),
      };
    });
  });

  it("records 25-item search authorization, reports 23/30 honestly, and replays duplicate confirmation without searching twice", async () => {
    const fingerprint = await previewFingerprint();
    const request = postRequest(30, fingerprint);
    const first = await POST(request);
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      authorizationRecorded: true,
      searchStatus: "insufficient_results",
      targetReached: false,
      batchItemCount: 23,
      targetTotal: 30,
      addedCount: 18,
      runStatus: "HUMAN_REQUIRED",
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(mocks.collect).toHaveBeenCalledWith(expect.objectContaining({ startPage: 2, maxAppearances: 25 }));
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ searchNavigationUsed: 1 }));
    expect(mocks.ensureRunning).not.toHaveBeenCalled();

    const authorizationReceipt = mocks.receipts.find((row) => row.operation === "source-layer:market-capture-expansion:v1");
    expect(authorizationReceipt?.status).toBe("partial");
    const receiptJson = JSON.parse(String(authorizationReceipt?.responseJson)) as Record<string, unknown>;
    expect(receiptJson).toMatchObject({
      authorizationId: AUTHORIZATION_ID,
      kind: "expansion",
      targetTotal: 30,
      authorizedSearchItemLimit: 25,
      currentBatchItemCount: 5,
      searchStartPage: 2,
      searchPageCount: 1,
    });

    const replay = await POST(postRequest(30, fingerprint));
    expect(await replay.json()).toEqual(firstBody);
    expect(replay.status).toBe(200);
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it("records the authorization but blocks search and executor when local acquisition is disabled", async () => {
    const fingerprint = await previewFingerprint();
    vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "false");
    const response = await POST(postRequest(30, fingerprint));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      authorizationRecorded: true,
      searchStatus: "blocked",
      errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
      addedCount: 0,
      driveStarted: false,
      sourceAccess: "NONE",
    });
    // 关闭态：不启动浏览器/搜索、不写商品事实与证据、不启动执行器。
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("persists the confirmed authorization but blocks executor startup when the search reports a login gate", async () => {
    const fingerprint = await previewFingerprint();
    mocks.collect.mockResolvedValue({ status: "blocked", errorCode: "LOGIN_REQUIRED", errorMessage: "Amazon login required" });
    const response = await POST(postRequest(30, fingerprint));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      authorizationRecorded: true,
      searchStatus: "blocked",
      errorCode: "LOGIN_REQUIRED",
      batchItemCount: 5,
      targetTotal: 30,
      addedCount: 0,
      driveStarted: false,
    });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.startExpansion).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(mocks.releaseExpansion).toHaveBeenCalledTimes(1);
    const authorizationReceipt = mocks.receipts.find((row) => row.operation === "source-layer:market-capture-expansion:v1");
    const receiptJson = JSON.parse(String(authorizationReceipt?.responseJson)) as Record<string, unknown>;
    expect(receiptJson).toMatchObject({ authorizedSearchItemLimit: 25, targetTotal: 30, httpStatus: 200 });
  });

  it("does not begin search when an older executor is still live for the batch", async () => {
    const fingerprint = await previewFingerprint();
    mocks.isRunning.mockReturnValue(true);
    const response = await POST(postRequest(30, fingerprint, "auth_expansion_test_002"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("BATCH_CAPTURE_JOB_BUSY");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.reserveExpansion).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("serializes a second confirmation behind the batch-level expansion lock", async () => {
    const fingerprint = await previewFingerprint();
    mocks.receipts.push({
      id: "active-expansion-lock",
      actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion-lock:v1",
      resourceKey: BATCH_ID,
      idempotencyKey: "active",
      requestHash: "auth_expansion_test_001",
      status: "processing",
      responseJson: JSON.stringify({ authorizationId: "auth_expansion_test_001" }),
      updatedAt: new Date(),
    });
    const response = await POST(postRequest(30, fingerprint, "auth_expansion_test_002"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CAPTURE_EXPANSION_BUSY");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("persists verified pages and consumed navigation when a later page hits a human gate", async () => {
    const fingerprint = await previewFingerprint();
    const savedReference = {
      subjectKey: "amazon:US:B000000006",
      captureId: "capture-006",
      evidenceId: "evidence-006",
      evidenceVersion: 2,
      contentHash: "a".repeat(64),
    };
    mocks.collect.mockResolvedValue({
      status: "captured",
      partial: true,
      plan: { query: "isolated query", pageCount: 1, totalObservationCount: 1, pageStatuses: ["ok"] },
      captures: [],
      navigationUsed: 2,
      errorCode: "CAPTCHA_DETECTED",
      errorMessage: "第 3 页遇到验证码。",
      pageCheckpoints: [
        { page: 2, state: "evidence_persisted", pageStatus: "ok", observationCount: 1, evidenceReferences: [savedReference] },
        { page: 3, state: "blocked", pageStatus: "captcha", observationCount: 0, errorCode: "CAPTCHA_DETECTED", evidenceReferences: [] },
      ],
    });
    mocks.append.mockResolvedValue({ addedCount: 1, duplicateProductCount: 0, validEvidenceCount: 6, newlyCapturedAsins: ["B000000006"] });

    const response = await POST(postRequest(30, fingerprint));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ searchStatus: "blocked", addedCount: 1, navigationUsed: 2, driveStarted: false });
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({
      searchNavigationUsed: 2,
      persistedEvidenceReferences: [savedReference],
      captures: [],
    }));
    expect(mocks.startExpansion).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(mocks.releaseExpansion).toHaveBeenCalledTimes(1);
  });

  it("recovers a completed search checkpoint without visiting Amazon again", async () => {
    const fingerprint = await previewFingerprint();
    const authorization = {
      authorizationId: AUTHORIZATION_ID,
      kind: "expansion",
      targetTotal: 30,
      authorizedSearchItemLimit: 25,
      currentBatchItemCount: 5,
      searchStartPage: 2,
      searchPageCount: 2,
      planFingerprint: fingerprint,
    };
    const evidenceReference = {
      subjectKey: "amazon:US:B000000006",
      captureId: "capture-006",
      evidenceId: "evidence-006",
      evidenceVersion: 2,
      contentHash: "b".repeat(64),
    };
    mocks.run = { ...run("HUMAN_REQUIRED"), expansionLock: { authorizationId: AUTHORIZATION_ID }, authorizationLedger: [] };
    mocks.receipts.push({
      id: "active-expansion-lock",
      actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion-lock:v1",
      resourceKey: BATCH_ID,
      idempotencyKey: "active",
      requestHash: AUTHORIZATION_ID,
      status: "recovery_pending",
      responseJson: JSON.stringify({
        authorizationId: AUTHORIZATION_ID,
        batchId: BATCH_ID,
        owner: null,
        stage: "source_completed",
        traceId: "recovered-trace",
        searchStartPage: 2,
        navigationUsed: 2,
        searchStatus: "captured",
        evidenceReferences: [evidenceReference],
        planSummary: { pageCount: 2, totalObservationCount: 1, pageStatuses: ["ok", "ok"] },
        pages: [
          { page: 2, state: "evidence_persisted", pageStatus: "ok", observationCount: 1, evidenceReferences: [evidenceReference] },
          { page: 3, state: "validated", pageStatus: "ok", observationCount: 0, evidenceReferences: [] },
        ],
      }),
      updatedAt: new Date(),
    });
    mocks.receipts.push({
      id: "expansion-authorization",
      actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion:v1",
      resourceKey: BATCH_ID,
      idempotencyKey: AUTHORIZATION_ID,
      requestHash: hashJson({ schemaVersion: "market-capture-expansion-confirm.v1", batchId: BATCH_ID, targetTotal: 30, planFingerprint: fingerprint }),
      status: "processing",
      responseJson: JSON.stringify(authorization),
      updatedAt: new Date(),
    });

    const response = await POST(recoveryRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ addedCount: 18, batchItemCount: 23, sourceAccess: "ALREADY_ATTEMPTED" });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "recovered-trace",
      searchStartPage: 2,
      searchNavigationUsed: 2,
      persistedEvidenceReferences: [evidenceReference],
    }));
    expect(mocks.startExpansion).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(mocks.receipts.find((row) => row.id === "active-expansion-lock")?.status).toBe("completed");
  });

  it("refuses recovery until the operator confirms the dedicated Profile is closed", async () => {
    mocks.receipts.push({
      id: "pending-profile-confirmation",
      actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion-lock:v1",
      resourceKey: BATCH_ID,
      idempotencyKey: "active",
      requestHash: AUTHORIZATION_ID,
      status: "recovery_pending",
      responseJson: JSON.stringify({ authorizationId: AUTHORIZATION_ID, batchId: BATCH_ID, owner: null, stage: "source_started", navigationUsed: 1, traceId: "trace" }),
      updatedAt: new Date(),
    });

    const response = await POST(recoveryRequest(AUTHORIZATION_ID, false));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CAPTURE_EXPANSION_PROFILE_CONFIRMATION_REQUIRED");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.releaseExpansion).not.toHaveBeenCalled();
  });

  it("does not start later modules when the saved completed-page checkpoint carries a CAPTCHA gate", async () => {
    const fingerprint = await previewFingerprint();
    const authorization = {
      authorizationId: AUTHORIZATION_ID,
      kind: "expansion",
      targetTotal: 30,
      authorizedSearchItemLimit: 25,
      searchStartPage: 2,
      planFingerprint: fingerprint,
    };
    const evidenceReference = {
      subjectKey: "amazon:US:B000000006",
      captureId: "capture-006",
      evidenceId: "evidence-006",
      evidenceVersion: 2,
      contentHash: "d".repeat(64),
    };
    mocks.run = { ...run("HUMAN_REQUIRED"), expansionLock: { authorizationId: AUTHORIZATION_ID }, authorizationLedger: [] };
    mocks.receipts.push({
      id: "captcha-expansion-lock",
      actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion-lock:v1",
      resourceKey: BATCH_ID,
      idempotencyKey: "active",
      requestHash: AUTHORIZATION_ID,
      status: "recovery_pending",
      responseJson: JSON.stringify({
        authorizationId: AUTHORIZATION_ID, batchId: BATCH_ID, owner: null, stage: "source_completed",
        traceId: "captcha-trace", searchStartPage: 2, navigationUsed: 2, searchStatus: "captured",
        errorCode: "CAPTCHA_DETECTED", planSummary: { pageCount: 1, totalObservationCount: 1, pageStatuses: ["ok"] },
        evidenceReferences: [evidenceReference],
        pages: [
          { page: 2, state: "evidence_persisted", pageStatus: "ok", observationCount: 1, evidenceReferences: [evidenceReference] },
          { page: 3, state: "blocked", pageStatus: "captcha", observationCount: 0, errorCode: "CAPTCHA_DETECTED", evidenceReferences: [] },
        ],
      }),
      updatedAt: new Date(),
    });
    mocks.receipts.push({
      id: "captcha-expansion-authorization", actorScope: "owner:v1",
      operation: "source-layer:market-capture-expansion:v1", resourceKey: BATCH_ID, idempotencyKey: AUTHORIZATION_ID,
      requestHash: hashJson({ schemaVersion: "market-capture-expansion-confirm.v1", batchId: BATCH_ID, targetTotal: 30, planFingerprint: fingerprint }),
      status: "processing", responseJson: JSON.stringify(authorization), updatedAt: new Date(),
    });

    const response = await POST(recoveryRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.searchStatus).toBe("blocked");
    expect(body.data.addedCount).toBe(18);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.startExpansion).not.toHaveBeenCalled();
    expect(mocks.releaseExpansion).toHaveBeenCalledTimes(1);
  });

  it("keeps the batch locked for manual reconciliation when checkpoint Evidence cannot be handed off", async () => {
    const fingerprint = await previewFingerprint();
    const savedReference = {
      subjectKey: "amazon:US:B000000006",
      captureId: "capture-006",
      evidenceId: "evidence-006",
      evidenceVersion: 2,
      contentHash: "c".repeat(64),
    };
    mocks.collect.mockResolvedValue({
      status: "human_required",
      plan: null,
      captures: [],
      navigationUsed: 2,
      errorCode: "CAPTCHA_DETECTED",
      pageCheckpoints: [{ page: 2, state: "evidence_persisted", pageStatus: "ok", observationCount: 1, evidenceReferences: [savedReference] }],
    });
    mocks.append.mockRejectedValue(new Error("evidence_version_mismatch"));

    const response = await POST(postRequest(30, fingerprint));
    const body = await response.json();
    const activeLock = mocks.receipts.find((row) => row.operation === "source-layer:market-capture-expansion-lock:v1");

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CAPTURE_EXPANSION_EVIDENCE_RECONCILIATION_REQUIRED");
    expect(activeLock?.status).toBe("recovery_required");
    expect(mocks.releaseExpansion).not.toHaveBeenCalled();
    expect(mocks.startExpansion).not.toHaveBeenCalled();
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });
});
