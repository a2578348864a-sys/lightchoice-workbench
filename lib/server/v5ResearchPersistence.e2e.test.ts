import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownerContext = { mode: "owner" as const, token: "isolated-owner-token" };
const refs = {
  product: "evidence:evidence-contract-test",
  review: "attachment:review-contract-test",
  voice: "attachment:customer-voice-contract-test",
  keyword: "attachment:keyword-contract-test",
  trend: "attachment:trend-contract-test",
  blockedReview: "attachment:blocked-review-contract-test",
};

const researchBundle = {
  schemaVersion: "research-input-bundle.v1",
  taskId: "task-v5-contract-reopen",
  candidateId: "candidate-v5-contract-reopen",
  subjectKey: "amazon:US:B0CONTRACT01",
  productFact: { schema: "product-fact.v3", subjectKey: "amazon:US:B0CONTRACT01", sourceProof: { evidenceId: "evidence-contract-test" } },
  sourceEvidenceRefs: [
    { refId: refs.product, evidenceId: "evidence-contract-test", contentHash: "1".repeat(64) },
    { refId: refs.review, evidenceId: "evidence-contract-test", contentHash: "2".repeat(64) },
    { refId: refs.voice, evidenceId: "evidence-contract-test", contentHash: "6".repeat(64) },
    { refId: refs.keyword, evidenceId: "evidence-contract-test", contentHash: "3".repeat(64) },
    { refId: refs.trend, evidenceId: "evidence-contract-test", contentHash: "4".repeat(64) },
    { refId: refs.blockedReview, evidenceId: "evidence-contract-test", contentHash: "5".repeat(64) },
  ],
  reviewEvidence: [{ attachmentId: "review-contract-test", contentHash: "2".repeat(64) }],
  customerVoiceEvidence: [{
    attachmentId: "customer-voice-contract-test",
    contentHash: "6".repeat(64),
    source: "amazon_review",
    observationCount: 1,
    omittedCount: 0,
    observations: [{
      refId: refs.voice,
      externalContentId: "review-voice-fixture-1",
      parentContentId: null,
      threadId: null,
      subreddit: null,
      depth: null,
      contentType: "review",
      title: "Cap durability",
      text: "The cap leaked during a hike.",
      rating: 2,
      verifiedPurchase: true,
      publishedAt: "2026-09-20T00:00:00.000Z",
      engagement: null,
      authorRef: null,
      provenance: { accessBasis: "first_party_visible_page" },
      identityMatch: "EXACT",
      ownerExperience: null,
    }],
  }],
  keywordEvidence: [{ attachmentId: "keyword-contract-test", contentHash: "3".repeat(64) }],
  trendObservations: Array.from({ length: 8 }, (_, index) => ({ observationId: `trend-${index}`, capturedAt: `2026-09-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`, valueKind: "estimated", value: 100 + index, field: "monthly_sales", source: "sellersprite_plugin", evidenceRefs: [refs.trend] })),
  missingFields: [],
  conflicts: [],
  freshness: { latestCapturedAt: "2026-09-27T00:00:00.000Z", ageDays: 0 },
  traceId: "isolated-contract-trace",
};

let tempRoot = "";
let databaseUrl = "";
let prisma: import("@prisma/client").PrismaClient | undefined;
let originalDatabaseUrl: string | undefined;
let originalProvider: string | undefined;
let callAiJsonMock: ReturnType<typeof vi.fn> | undefined;

beforeEach(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "v5-research-contract-"));
  const databasePath = join(tempRoot, "contract.db");
  databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const sqlite = new DatabaseSync(databasePath);
  try { replayAllCheckedInMigrations(sqlite); } finally { sqlite.close(); }

  originalDatabaseUrl = process.env.DATABASE_URL;
  originalProvider = process.env.V5_RESEARCH_PROVIDER;
  process.env.DATABASE_URL = databaseUrl;
  delete process.env.V5_RESEARCH_PROVIDER;
  callAiJsonMock = vi.fn().mockResolvedValue({ ok: true, data: {
    summary: { text: "Evidence-backed contract report", evidenceRefs: [refs.product] },
    opportunities: [{ text: "Contract opportunity", evidenceRefs: [refs.keyword] }], risks: [],
    vocAnalysis: { painPoints: [{ text: "The cap leaked during a hike.", evidenceRefs: [refs.voice] }], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
    citations: [refs.product, refs.keyword, refs.voice].map(source => ({ quote: "Fixture observation", source })),
  } });
  vi.doMock("@/lib/server/aiClient", () => ({
    getAiConfig: () => ({ ok: true, data: { provider: "deepseek" } }),
    callAiJson: callAiJsonMock,
  }));
  vi.doMock("@/lib/server/research/researchInputBundle", () => ({
    buildResearchInputBundle: vi.fn().mockResolvedValue(researchBundle),
  }));
  await vi.resetModules();
  Reflect.deleteProperty(globalThis, "prisma");
  ({ prisma } = await import("@/lib/server/db"));

  const legacyReport = { schema: "research-report.v1", generatedAt: "2026-09-26T00:00:00.000Z", summary: "Existing legacy report" };
  const legacyDecision = {
    status: "continue",
    nextAction: "continue_research",
    notes: "Human review remains bound to the legacy report.",
    updatedAt: "2026-09-26T00:01:00.000Z",
    updatedBy: "owner",
    reviewedReportHash: "a".repeat(64),
  };
  await prisma!.viralAnalysisRecord.create({
    data: {
      id: researchBundle.taskId,
      type: "workflow",
      decisionStatus: "pending",
      title: "Contract persistence fixture",
      platform: "amazon",
      materialText: "Synthetic isolated test fixture",
      source: "isolated-test",
      score: 0,
      level: "low",
      oneLineSummary: "Synthetic isolated test fixture",
      resultJson: JSON.stringify({
        type: "workflow",
        candidateToTask: { candidateId: researchBundle.candidateId },
        researchReport: { reportJson: legacyReport, reportHash: "a".repeat(64), generatedAt: legacyReport.generatedAt },
        researchReportHash: "a".repeat(64),
        researchDecision: legacyDecision,
      }),
    },
  });
});

afterEach(async () => {
  await prisma?.$disconnect();
  prisma = undefined;
  Reflect.deleteProperty(globalThis, "prisma");
  vi.doUnmock("@/lib/server/research/researchInputBundle");
  vi.doUnmock("@/lib/server/aiClient");
  vi.doUnmock("@/lib/server/v5ApiRoute");
  await vi.resetModules();
  callAiJsonMock = undefined;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalProvider === undefined) delete process.env.V5_RESEARCH_PROVIDER;
  else process.env.V5_RESEARCH_PROVIDER = originalProvider;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("V5 Research generate → persist → DB reopen → API read contract", () => {
  it("projects legacy content presence and formal human-decision safety without exposing legacy report as V5", async () => {
    const task = await prisma!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: researchBundle.taskId } });
    const root = JSON.parse(task.resultJson) as Record<string, unknown>;
    root.humanDecision = { status: "approved" };
    await prisma!.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: JSON.stringify(root) } });

    const { getResearchDetail } = await import("@/lib/server/v5ResearchService");
    const detail = await getResearchDetail({ context: ownerContext, taskId: researchBundle.taskId });
    expect(detail.hasLegacyReport).toBe(true);
    expect(detail.hasHumanDecision).toBe(true);
    expect(detail.report).toBeNull();
    expect(detail.reportHash).toBeNull();
  }, 20_000);

  it("persists one generated V5 report without fabricating legacy bindings, then reads it after reopening SQLite", async () => {
    const { getResearchDetail: readLegacyOnlyDetail } = await import("@/lib/server/v5ResearchService");
    const { hashJson } = await import("@/lib/server/v5CoreCommon");
    const legacyOnly = await readLegacyOnlyDetail({ context: ownerContext, taskId: researchBundle.taskId });
    expect(legacyOnly.reportHash).toBeNull();
    expect(legacyOnly.factHash).toBeNull();
    expect(legacyOnly.evidenceHash).toBeNull();
    expect(legacyOnly.deepseek.status).toBe("unavailable");
    expect(legacyOnly.report).toBeNull();
    expect(legacyOnly.hasLegacyReport).toBe(true);
    expect(legacyOnly.hasHumanDecision).toBe(false);
    expect(legacyOnly.legacyV5GenerationAvailable).toBe(true);

    const { runResearchAdvisory } = await import("@/lib/server/v5ResearchService");
    const generated = await runResearchAdvisory({
      context: ownerContext,
      taskId: researchBundle.taskId,
      expectedRevision: 0,
      requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"],
      idempotencyKey: "isolated-v5-contract-generation",
    });

    expect(generated.deepseek.status).toBe("available");
    const firstRead = await prisma!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: researchBundle.taskId } });
    const firstResult = JSON.parse(firstRead.resultJson) as Record<string, any>;
    expect(firstResult.v5Research).toBeDefined();
    expect(firstResult.v5Research.report).toMatchObject({ schema: "research-report.v5" });
    expect(firstResult.v5Research.report.summary).toBeTruthy();
    expect(firstResult.v5Research.report.vocAnalysis.painPoints).toEqual([{
      text: "The cap leaked during a hike.",
      evidenceRefs: [refs.voice],
    }]);
    expect(firstResult.v5Research.report.narrativeBindings).toContainEqual({
      field: "vocAnalysis.painPoints[0]",
      text: "The cap leaked during a hike.",
      evidenceRefs: [refs.voice],
    });
    expect(firstResult.v5Research.report.citations.length).toBeGreaterThan(0);
    expect(firstResult.v5Research.reportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstResult.v5Research.factHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstResult.v5Research.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstResult.v5Research.reportHash).toBe(hashJson(firstResult.v5Research.report));
    expect(firstResult.v5Research.factHash).toBe(hashJson(researchBundle.productFact));
    expect(firstResult.v5Research.evidenceHash).toBe(hashJson(researchBundle.sourceEvidenceRefs
      .map((ref) => ({ refId: ref.refId, contentHash: ref.contentHash, evidenceId: ref.evidenceId }))
      .sort((left, right) => left.refId.localeCompare(right.refId))));
    expect(firstResult.v5Research.report.allowedEvidenceRefs).toEqual(expect.arrayContaining([
      refs.product, refs.review, refs.voice, refs.keyword, refs.trend,
    ]));
    expect(firstResult.v5Research.report.allowedEvidenceRefs).not.toContain(refs.blockedReview);
    expect(firstResult.v5Research.report.citations.map((citation: { source: string }) => citation.source))
      .not.toContain(refs.blockedReview);
    expect(firstResult.researchReport.reportHash).toBe("a".repeat(64));
    expect(firstResult.researchDecision.reviewedReportHash).toBe("a".repeat(64));
    await expect(runResearchAdvisory({
      context: ownerContext,
      taskId: researchBundle.taskId,
      expectedRevision: 0,
      requested: ["deepseek_summary"],
      idempotencyKey: "isolated-v5-contract-stale-revision",
    })).rejects.toMatchObject({ code: "RESEARCH_REVISION_STALE" });
    const afterStaleAttempt = await prisma!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: researchBundle.taskId } });
    expect(JSON.parse(afterStaleAttempt.resultJson).v5Research.reportHash).toBe(firstResult.v5Research.reportHash);
    expect(JSON.parse(afterStaleAttempt.resultJson).researchDecision.reviewedReportHash).toBe("a".repeat(64));

    await prisma!.$disconnect();
    prisma = undefined;
    Reflect.deleteProperty(globalThis, "prisma");
    await vi.resetModules();
    ({ prisma } = await import("@/lib/server/db"));
    const { getResearchDetail } = await import("@/lib/server/v5ResearchService");
    const detail = await getResearchDetail({ context: ownerContext, taskId: researchBundle.taskId });
    expect(detail.reportHash).toBe(firstResult.v5Research.reportHash);
    expect(detail.factHash).toBe(firstResult.v5Research.factHash);
    expect(detail.evidenceHash).toBe(firstResult.v5Research.evidenceHash);
    expect(detail.deepseek.status).toBe("available");
    expect(detail.report?.summary).toBeTruthy();
    expect(detail.report?.citations).toHaveLength(firstResult.v5Research.report.citations.length);

    vi.doMock("@/lib/server/v5ApiRoute", async () => {
      const { NextResponse } = await import("next/server");
      return {
        readAuth: () => ({ ok: true, context: ownerContext }),
        authResponse: () => NextResponse.json({ ok: false }, { status: 401 }),
        v5ErrorResponse: () => NextResponse.json({ ok: false }, { status: 500 }),
      };
    });
    const [{ GET }, { NextRequest }] = await Promise.all([
      import("@/app/api/research/[taskId]/route"),
      import("next/server"),
    ]);
    const response = await GET(new NextRequest(`http://localhost/api/research/${researchBundle.taskId}`), {
      params: Promise.resolve({ taskId: researchBundle.taskId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      reportHash: firstResult.v5Research.reportHash,
      factHash: firstResult.v5Research.factHash,
      evidenceHash: firstResult.v5Research.evidenceHash,
      deepseek: { status: "available" },
    });
  }, 30_000);

  it("keeps the prior report and final decision after a provider 4xx failure", async () => {
    const { runResearchAdvisory, saveResearchChoice, getResearchDetail } = await import("@/lib/server/v5ResearchService");
    const generated = await runResearchAdvisory({
      context: ownerContext,
      taskId: researchBundle.taskId,
      expectedRevision: 0,
      requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"],
      idempotencyKey: "isolated-v5-provider-failure-initial",
    });
    expect(generated.deepseek.status).toBe("available");
    const generatedDetail = await getResearchDetail({ context: ownerContext, taskId: researchBundle.taskId });
    const reportHash = generatedDetail.reportHash;
    const factHash = generated.factHash;
    const evidenceHash = generated.evidenceHash;
    if (!reportHash || !factHash || !evidenceHash) throw new Error("Provider failure test requires a complete initial report binding.");
    const generatedTask = await prisma!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: researchBundle.taskId } });

    const decision = await saveResearchChoice({
      context: ownerContext,
      taskId: researchBundle.taskId,
      expectedVersion: generatedTask.updatedAt.toISOString(),
      choice: "PROCEED",
      expectedRevision: generated.researchRevision,
      expectedReportHash: reportHash,
      expectedFactHash: factHash,
      expectedEvidenceHash: evidenceHash,
      readinessAcknowledged: true,
      idempotencyKey: "isolated-v5-provider-failure-final-choice",
    });
    expect(decision.myChoice).toMatchObject({ canonicalStatus: "PROCEED" });

    callAiJsonMock!.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid_api_key", message: "Provider authorization failed." },
      providerCallStarted: true,
      diagnostics: { providerHttpStatusClass: "client_error", responseFailureClass: "unknown_response_shape" },
    });
    const failedAttempt = await runResearchAdvisory({
      context: ownerContext,
      taskId: researchBundle.taskId,
      expectedRevision: generated.researchRevision,
      expectedFactHash: factHash,
      expectedEvidenceHash: evidenceHash,
      confirmFinalAdvisoryRegeneration: true,
      requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"],
      idempotencyKey: "isolated-v5-provider-failure-regeneration",
    });
    expect(failedAttempt.deepseek).toMatchObject({ status: "failed", errorCode: "invalid_api_key" });
    expect(failedAttempt.researchRevision).toBe(generated.researchRevision);

    const row = await prisma!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: researchBundle.taskId } });
    const persisted = JSON.parse(row.resultJson).v5Research;
    expect(persisted.reportHash).toBe(reportHash);
    expect(persisted.researchRevision).toBe(generated.researchRevision);
    expect(persisted.report.summary).toBe("Evidence-backed contract report");
    expect(persisted.myChoice).toMatchObject({ canonicalStatus: "PROCEED", scope: "FINAL" });

    const refreshed = await getResearchDetail({ context: ownerContext, taskId: researchBundle.taskId });
    expect(refreshed.reportHash).toBe(reportHash);
    expect(refreshed.researchRevision).toBe(generated.researchRevision);
    expect(refreshed.myChoice).toMatchObject({ canonicalStatus: "PROCEED", scope: "FINAL" });
    expect(refreshed.lastAdvisoryAttempt).toMatchObject({ status: "failed" });
    expect(refreshed.stale).toBe(false);
    expect(refreshed.reportStale).toBe(false);
  }, 30_000);
});
