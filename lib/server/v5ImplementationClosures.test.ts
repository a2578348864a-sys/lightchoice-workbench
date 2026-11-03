import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { seedP4ReadPath } from "@/lib/server/__fixtures__/p4ReadPathFixture";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null, provider: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key); return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
vi.mock("@/lib/server/aiClient", () => ({ getAiConfig: () => ({ ok: true, data: { provider: "deepseek" } }), callAiJson: state.provider }));
let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "v5-closures-p8-")); const path = join(root, "fixture.db"), db = new DatabaseSync(path);
  try { expect(replayAllCheckedInMigrations(db)).toHaveLength(checkedInMigrationNames().length); } finally { db.close(); }
  state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
  vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence")); vi.stubEnv("V5_RESEARCH_PROVIDER", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden_in_contract"); }));
  state.provider.mockImplementation(async (input: any) => {
    const refs = JSON.parse(input.messages[1].content).allowedEvidenceRefs;
    return { ok: true, data: { summary: { text: "可追溯研究摘要", evidenceRefs: [refs[0]] }, opportunities: [{ text: "需人工验证的机会", evidenceRefs: [refs[0]] }],
      risks: [{ text: "需人工核对的风险", evidenceRefs: [refs[0]] }], vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "已有观察", source: refs[0] }] } };
  });
  await seedP4ReadPath(state.client);
});
afterEach(async () => { await state.client?.$disconnect(); state.client = null; vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const { prisma } = await import("@/lib/server/db");
const { withV5Receipt, V5CoreError } = await import("@/lib/server/v5CoreCommon");
const {
  getResearchDetail,
  runResearchAdvisory,
  systemSuggestion,
  validateCitationsAndAssumptions,
  bindNarrativesWithCitations,
  loadCanonicalResearchBoundary,
  validateNarrativeDraft,
  RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT,
} = await import("@/lib/server/v5ResearchService");
const {
  getFeishuConnectionStatus,
  syncResearchTask,
  resetPreflightSuccessForTest,
  recordPreflightSuccess,
} = await import("@/lib/server/v5FeishuService");

import type { OwnerAccessContext } from "@/lib/server/accessPassword";

describe("V5 Implementation Closures Unit Verification", () => {
  const ownerContext: OwnerAccessContext = { mode: "owner", token: "owner_test_token" };

  it("Research Provider JSON contract rejects missing and unknown schema fields before binding", () => {
    expect(RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT).toContain("只输出一个");
    expect(RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT).toContain("禁止 Markdown fence");
    expect(RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT).toContain("不要输出额外字段");
    expect(RESEARCH_PROVIDER_JSON_CONTRACT_PROMPT).toContain('"ownershipClaims": []');
    const validDraft = {
      summary: { text: "summary", evidenceRefs: ["evidence:allowed"] },
      opportunities: [],
      risks: [],
      vocAnalysis: {
        painPoints: [], positiveSignals: [], failureModes: [], useCases: [],
        replacementSignals: [], switchReasons: [], ownershipClaims: [],
      },
      citations: [{ quote: "quote", source: "evidence:allowed" }],
    };
    expect(validateNarrativeDraft(validDraft)).toMatchObject({ ok: true });
    expect(validateNarrativeDraft({ ...validDraft, citations: undefined })).toMatchObject({ ok: false, errorClass: "required_field_missing" });
    expect(validateNarrativeDraft({ ...validDraft, unsupported: "do not silently discard" })).toMatchObject({ ok: false, errorClass: "unknown_field" });
    expect(validateNarrativeDraft([{ ...validDraft }])).toMatchObject({ ok: false, errorClass: "root_not_object" });

    // Empty evidenceRefs stay on the pre-existing unverified path; they never become a verified conclusion.
    const unbound = bindNarrativesWithCitations({
      summary: { text: "unverified", evidenceRefs: [] },
      citations: [],
    }, ["evidence:allowed"]);
    expect(unbound.summary).toBeNull();
    expect(unbound.unverifiedAssumptions.some((item) => item.includes("缺少合法 citation"))).toBe(true);
  });

  it("Contract Fix: withV5Receipt allows retrying when previous attempt failed", async () => {
    const key = `test-retry-idemp-${Date.now()}`;
    let callCount = 0;

    // First attempt fails
    await expect(
      withV5Receipt({
        context: ownerContext,
        operation: "test:retry_operation",
        resourceKey: "res_1",
        idempotencyKey: key,
        requestBody: { action: "attempt_1" },
        execute: async () => {
          callCount++;
          throw new V5CoreError("SIMULATED_FAILURE", "故意触发失败测试", 500, true);
        },
      })
    ).rejects.toThrow("故意触发失败测试");

    expect(callCount).toBe(1);

    // Verify receipt in DB is marked "failed"
    const receipt = await prisma.v5OperationReceipt.findFirst({
      where: {
        actorScope: "owner:v1",
        operation: "test:retry_operation",
        idempotencyKey: key,
      },
    });
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("failed");
    expect(receipt?.errorCode).toBe("SIMULATED_FAILURE");

    // Second attempt with SAME idempotencyKey should be allowed to retry instead of throwing!
    const retryResult = await withV5Receipt({
      context: ownerContext,
      operation: "test:retry_operation",
      resourceKey: "res_1",
      idempotencyKey: key,
      requestBody: { action: "attempt_1" },
      execute: async () => {
        callCount++;
        return { success: true, count: callCount };
      },
    });

    expect(callCount).toBe(2);
    expect(retryResult.replayed).toBe(false);
    expect(retryResult.value).toEqual({ success: true, count: 2 });

    // Third attempt with SAME idempotencyKey replays the succeeded result
    const replayResult = await withV5Receipt({
      context: ownerContext,
      operation: "test:retry_operation",
      resourceKey: "res_1",
      idempotencyKey: key,
      requestBody: { action: "attempt_1" },
      execute: async () => {
        callCount++;
        return { success: true, count: 999 };
      },
    });

    expect(callCount).toBe(2); // No new execution!
    expect(replayResult.replayed).toBe(true);
    expect(replayResult.value).toEqual({ success: true, count: 2 });
  });

  it("Closure 2: getResearchDetail returns unified DTO with required V5 fields", async () => {
    // Find an existing task in DB
    const task = await prisma.viralAnalysisRecord.findFirst({
      where: { type: "workflow" },
    });

    expect(task).not.toBeNull();
    if (!task) throw new Error("required_seed_missing");

    const detail = await getResearchDetail({
      context: ownerContext,
      taskId: task.id,
    });

    // Verify all 5 critical contract fields required by user prompt
    expect(detail).toHaveProperty("deepseek");
    expect(detail).toHaveProperty("evidenceRiskGate");
    expect(detail).toHaveProperty("compositeSuggestion");
    expect(detail).toHaveProperty("myChoice");
    expect(detail).toHaveProperty("ResearchRecordIdentity");

    // Verify ResearchRecordIdentity structure
    expect(detail.ResearchRecordIdentity).toMatchObject({
      taskId: task.id,
      researchRecordKey: `${task.id}:${detail.researchRevision ?? 0}`,
    });

    // Verify deepseek shape
    expect(detail.deepseek).toHaveProperty("status");
    expect(["available", "unavailable", "failed"]).toContain(detail.deepseek.status);

    // Verify evidenceRiskGate shape
    expect(detail.evidenceRiskGate).toHaveProperty("status");
    expect(detail.evidenceRiskGate).toHaveProperty("evidenceSufficiency");
    expect(detail.evidenceRiskGate).toHaveProperty("blockingRisk");

    // Verify compositeSuggestion shape
    expect(detail.compositeSuggestion).toHaveProperty("status");
    expect(detail.compositeSuggestion).toHaveProperty("composite");
  });

  it("Closure 3: injected test Provider executes formal advisory against full migrations with zero network", async () => {
    const task = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-0" } });
    const boundary = await loadCanonicalResearchBoundary({ context: ownerContext, taskId: task.id }); expect(boundary.ok).toBe(true);
    const current = await getResearchDetail({ context: ownerContext, taskId: task.id }); expect(current.myChoice).toBeNull();
    const updated = await runResearchAdvisory({ context: ownerContext, taskId: task.id, expectedRevision: current.researchRevision,
      requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"], idempotencyKey: crypto.randomUUID() });
    expect(updated.deepseek.status).toBe("available"); expect(updated.deepseek.summary).toBeTruthy();
    expect(Array.isArray(updated.deepseek.opportunities)).toBe(true); expect(Array.isArray(updated.deepseek.risks)).toBe(true);
    if (!Array.isArray(updated.deepseek.opportunities) || !Array.isArray(updated.deepseek.risks)) throw new Error("formal_provider_array_contract_required");
    expect(updated.deepseek.opportunities.length).toBeGreaterThan(0); expect(updated.deepseek.risks.length).toBeGreaterThan(0);
    const refreshed = await getResearchDetail({ context: ownerContext, taskId: task.id });
    expect(refreshed.reportHash).toBeTruthy(); expect(refreshed.report?.summary).toBe(updated.deepseek.summary);
    const refs = refreshed.report!.allowedEvidenceRefs as string[]; expect(refs.length).toBeGreaterThan(0);
    for (const citation of refreshed.report!.citations as Array<{ source: string }>) expect(refs).toContain(citation.source);
    expect(state.provider).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it("Closure 4: Feishu test adapter operates with REAL_FEISHU_WRITES = 0", async () => {
    process.env.V5_FEISHU_ADAPTER = "test";

    const connection = getFeishuConnectionStatus();
    expect(connection).toHaveProperty("status");

    // Attempting sync under test mode writes to local v5FeishuSyncMetadata without network mutation
    const task = await prisma.viralAnalysisRecord.findFirst({
      where: { type: "workflow" },
    });
    expect(task).not.toBeNull();
    if (!task) throw new Error("required_seed_missing");

    const detail = await getResearchDetail({
      context: ownerContext,
      taskId: task.id,
    });

    expect(detail.reportHash).toBeTruthy(); expect(detail.factHash).toBeTruthy(); expect(detail.evidenceHash).toBeTruthy();
    {
      if (!detail.reportHash || !detail.factHash || !detail.evidenceHash) throw new Error("formal_report_binding_required");
      const syncRes = await syncResearchTask({
        context: ownerContext,
        taskId: task.id,
        expectedReportHash: detail.reportHash,
        expectedFactHash: detail.factHash,
        expectedEvidenceHash: detail.evidenceHash,
        idempotencyKey: `feishu-test-sync-${Date.now()}`,
      });

      expect(syncRes.state).toBe("SYNCED");
      expect(syncRes.items[0].remoteRecordId).toMatch(/^test_rec_/);
    }
  });

  it("Closure 4b: withV5Receipt rejects retry when previous failure was non-retryable", async () => {
    const nonRetryKey = `test-non-retry-${Date.now()}`;
    let callCount = 0;

    // First attempt fails with non-retryable error
    await expect(
      withV5Receipt({
        context: ownerContext,
        operation: "test:non_retry_op",
        resourceKey: "res_non_retry",
        idempotencyKey: nonRetryKey,
        requestBody: { data: "test" },
        execute: async () => {
          callCount++;
          throw new V5CoreError("FATAL_NON_RETRYABLE", "致命非可重试错误", 400, false, true);
        },
      })
    ).rejects.toThrow("致命非可重试错误");

    expect(callCount).toBe(1);

    // Subsequent attempt with SAME idempotency key must reject retry and refuse to continue
    await expect(
      withV5Receipt({
        context: ownerContext,
        operation: "test:non_retry_op",
        resourceKey: "res_non_retry",
        idempotencyKey: nonRetryKey,
        requestBody: { data: "test" },
        execute: async () => {
          callCount++;
          return { success: true };
        },
      })
    ).rejects.toThrow();

    // Call count must remain 1: execute() was NOT called!
    expect(callCount).toBe(1);
  });

  it("Closure 1b: Evidence/Risk Gate separates sufficiency, blockingRisk is unavailable, composite defaults to no_suggestion", () => {
    const fakeStateWithEvidence = {
      schema: "v5-research.v1" as const,
      candidateId: "cand_1",
      asin: "B0TESTASIN1",
      marketplace: "US",
      title: "Test Product",
      factHash: "hash_fact_123",
      evidenceHash: "hash_evid_456",
      evidenceRefs: ["ref_1", "ref_2"],
      researchRevision: 1,
      report: null,
      reportHash: null,
      advisory: null,
      myChoice: null,
      temporaryWatches: [],
    };

    const suggestion = systemSuggestion(fakeStateWithEvidence);
    // 证据充分度单独计算
    expect(suggestion.evidenceSufficiency).toBe("adequate");
    // blockingRisk 必须为 unavailable（无确定性规则引擎能力）
    expect(suggestion.blockingRisk).toBe("unavailable");
    // 不能因为证据存在就直接 recommend_proceed，安全默认必须为 no_suggestion
    expect(suggestion.composite).toBe("no_suggestion");

    // 没有证据时：
    const fakeStateNoEvidence = {
      ...fakeStateWithEvidence,
      factHash: null,
      evidenceHash: null,
      evidenceRefs: [],
    };
    const noEvidSuggestion = systemSuggestion(fakeStateNoEvidence);
    expect(noEvidSuggestion.evidenceSufficiency).toBe("insufficient");
    expect(noEvidSuggestion.blockingRisk).toBe("unavailable");
    expect(noEvidSuggestion.composite).toBe("no_suggestion");
  });

  it("Closure 1c: systemSuggestion 带 decisionDelivery 时输出确定性真实值（P0-DC-01）", async () => {
    type DecisionDelivery = import("@/lib/server/research/decisionDelivery").DecisionDelivery;
    const baseState = {
      schema: "v5-research.v1" as const,
      candidateId: "cand_1",
      asin: "B0TESTASIN1",
      marketplace: "US",
      title: "Test Product",
      factHash: "hash_fact_123",
      evidenceHash: "hash_evid_456",
      evidenceRefs: ["ref_1", "ref_2"],
      researchRevision: 1,
      report: null,
      reportHash: null,
      advisory: null,
      myChoice: null,
      temporaryWatches: [],
    };
    const summary = {
      researchPriority: "P2" as const,
      recommendedNextAction: "补充数据" as const,
      keyReasons: [],
      blockingRisks: [],
      missingInformation: ["当前售价"],
      actionReasons: ["核心决策数据缺失"],
      checklist: [],
    };
    const gate = { status: "warning" as const, hasBlockingRisk: false, rules: [], blockingReasons: [], warningReasons: [] };

    const missingDelivery: DecisionDelivery = {
      status: "available",
      assembleVersion: "decision-delivery.v1",
      aiInvoked: false,
      decisionSummary: summary,
      riskGate: gate,
      riskCounts: { blocking: 0, warning: 1, notComputable: 2, passed: 8 },
    };
    const suggestionMissing = systemSuggestion(baseState, missingDelivery);
    expect(suggestionMissing.blockingRisk).toBe("insufficient_evidence");
    expect(suggestionMissing.composite).toBe("no_suggestion");

    const blockedDelivery: DecisionDelivery = {
      ...missingDelivery,
      decisionSummary: { ...summary, recommendedNextAction: "暂停" },
      riskCounts: { blocking: 1, warning: 0, notComputable: 0, passed: 10 },
    };
    const suggestionBlocked = systemSuggestion(baseState, blockedDelivery);
    expect(suggestionBlocked.blockingRisk).toBe("present");
    expect(suggestionBlocked.composite).toBe("watch_carefully");

    const cleanDelivery: DecisionDelivery = {
      ...missingDelivery,
      decisionSummary: { ...summary, recommendedNextAction: "继续研究", missingInformation: [] },
      riskCounts: { blocking: 0, warning: 0, notComputable: 0, passed: 11 },
    };
    const suggestionClean = systemSuggestion(baseState, cleanDelivery);
    expect(suggestionClean.blockingRisk).toBe("none");
    expect(suggestionClean.composite).toBe("recommend_proceed");

    // 无 delivery 时安全默认保持（与 Closure 1b 一致）
    const fallback = systemSuggestion(baseState);
    expect(fallback.blockingRisk).toBe("unavailable");
    expect(fallback.composite).toBe("no_suggestion");
  });

  it("Closure 2b: narrative ↔ citation 强绑定阻止未验证结论泄漏", () => {
    const allowed = ["evidence:ev-1", "evidence:ev-2"];

    // 合法 citation → 正式 narrative
    const valid = bindNarrativesWithCitations(
      {
        summary: { text: "正式摘要", evidenceRefs: ["evidence:ev-1"] },
        opportunities: [{ text: "合法机会", evidenceRefs: ["evidence:ev-1"] }],
        risks: [{ text: "合法风险", evidenceRefs: ["evidence:ev-2"] }],
        citations: [
          { quote: "事实", source: "evidence:ev-1" },
          { quote: "样本", source: "evidence:ev-2" },
        ],
      },
      allowed,
      ["缺失商品字段事实: profit.fbaFee"],
    );
    expect(valid.summary).toBe("正式摘要");
    expect(valid.opportunities).toEqual(["合法机会"]);
    expect(valid.risks).toEqual(["合法风险"]);
    expect(valid.citations).toHaveLength(2);
    expect(valid.unverifiedAssumptions.some((a) => a.includes("缺失商品字段事实"))).toBe(true);
    expect(valid.narrativeBindings).toHaveLength(3);

    const voiceBound = bindNarrativesWithCitations({
      vocAnalysis: {
        painPoints: [{ text: "The cap leaked during a hike.", evidenceRefs: ["attachment:voice-1"] }],
        positiveSignals: [],
        failureModes: [{ text: "It stopped working.", evidenceRefs: ["attachment:voice-unverified"] }],
        useCases: [],
        replacementSignals: [],
        switchReasons: [],
        ownershipClaims: [],
      },
      citations: [{ quote: "The cap leaked during a hike.", source: "attachment:voice-1" }],
    }, ["attachment:voice-1"]);
    expect(voiceBound.vocAnalysis.painPoints).toEqual([{
      text: "The cap leaked during a hike.",
      evidenceRefs: ["attachment:voice-1"],
    }]);
    expect(voiceBound.vocAnalysis.failureModes).toEqual([]);
    expect(voiceBound.unverifiedAssumptions.some((item) => item.includes("vocAnalysis.failureModes"))).toBe(true);
    expect(voiceBound.narrativeBindings).toContainEqual({
      field: "vocAnalysis.painPoints[0]",
      text: "The cap leaked during a hike.",
      evidenceRefs: ["attachment:voice-1"],
    });

    // 无 citation → 不进入正式 narrative
    const noCitation = bindNarrativesWithCitations(
      {
        summary: { text: "无引用摘要", evidenceRefs: [] },
        opportunities: ["裸字符串机会"],
        risks: [],
        citations: [],
      },
      allowed,
    );
    expect(noCitation.summary).toBeNull();
    expect(noCitation.opportunities).toEqual([]);
    expect(noCitation.unverifiedAssumptions.some((a) => a.includes("缺少合法 citation"))).toBe(true);

    // 非法 / allowlist 外 citation → fail-closed / unverified
    const illegal = bindNarrativesWithCitations(
      {
        summary: { text: "被污染摘要", evidenceRefs: ["evidence:evil"] },
        citations: [{ quote: "伪造", source: "evidence:evil" }],
      },
      allowed,
    );
    expect(illegal.summary).toBeNull();
    expect(illegal.unverifiedAssumptions.some((a) => a.includes("allowlist 外") || a.includes("evidence:evil"))).toBe(true);
    expect(illegal.citations).toHaveLength(0);

    // unverifiedAssumptions 不得默认无条件 []
    expect(illegal.unverifiedAssumptions.length).toBeGreaterThan(0);

    // 兼容 API：validateCitationsAndAssumptions 仍返回合法 citation 与 unverified
    const { validCitations, unverifiedAssumptions } = validateCitationsAndAssumptions(
      [
        { quote: "Good bass", source: "evidence:ev-1" },
        { quote: "Fabricated", source: "unverified_blog_source" },
      ],
      allowed,
      ["brand"],
      ["价格冲突"],
    );
    expect(validCitations).toEqual([{ quote: "Good bass", source: "evidence:ev-1", refId: "evidence:ev-1" }]);
    expect(unverifiedAssumptions.some((a) => a.includes("unverified_blog_source"))).toBe(true);
    expect(unverifiedAssumptions.some((a) => a.includes("缺失商品字段事实"))).toBe(true);
    expect(unverifiedAssumptions.some((a) => a.includes("数据冲突"))).toBe(true);
    expect(unverifiedAssumptions.length).toBeGreaterThan(0);
  });

  it("Closure 2c: EvidenceStore 不可读时不生成正式结论", async () => {
    // 不存在的 task / 无 ProductFact → 正式边界 fail-closed
    const boundary = await loadCanonicalResearchBoundary({
      context: ownerContext,
      taskId: "task_missing_evidence_does_not_exist",
    });
    expect(boundary.ok).toBe(false);
    if (!boundary.ok) {
      expect(["EVIDENCE_BINDING_MISSING", "PRODUCT_FACT_MISSING", "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING"]).toContain(
        boundary.errorCode,
      );
    }
  });

  it("Closure 3b: Feishu connection status requires real preflight proof", () => {
    // 1. Without credentials configured: preflight is failed
    const saved = {
      appId: process.env.FEISHU_APP_ID,
      secret: process.env.FEISHU_APP_SECRET,
      token: process.env.FEISHU_BASE_APP_TOKEN,
      mTable: process.env.FEISHU_MARKET_TABLE_ID,
      rTable: process.env.FEISHU_RESEARCH_TABLE_ID,
      v5T02: process.env.V5_HUB_TABLE_T02,
    };

    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_BASE_APP_TOKEN;
    delete process.env.FEISHU_MARKET_TABLE_ID;
    delete process.env.FEISHU_RESEARCH_TABLE_ID;
    resetPreflightSuccessForTest();

    const notConfigured = getFeishuConnectionStatus();
    expect(notConfigured.configured).toBe(false);
    expect(notConfigured.preflight).toBe("failed");

    // 2. Configured credentials present, but no preflight run yet: MUST NOT be passed!
    process.env.FEISHU_APP_ID = "cli_mock_appid";
    process.env.FEISHU_APP_SECRET = "mock_secret";
    process.env.FEISHU_BASE_APP_TOKEN = "mock_base_token";
    process.env.FEISHU_MARKET_TABLE_ID = "tbl_market_mock";
    process.env.FEISHU_RESEARCH_TABLE_ID = "tbl_research_mock";

    const statusBefore = getFeishuConnectionStatus();
    expect(statusBefore.configured).toBe(true);
    expect(statusBefore.preflight).not.toBe("passed");
    expect(statusBefore.preflight).toBe("unverified");

    // 3. After real preflight proof is recorded: becomes passed
    recordPreflightSuccess();
    const statusAfter = getFeishuConnectionStatus();
    expect(statusAfter.preflight).toBe("passed");

    // P7 separates the Hub T02 contract from the legacy archive table; no fallback.
    delete process.env.FEISHU_RESEARCH_TABLE_ID;
    process.env.V5_HUB_TABLE_T02 = "tbl_research_from_v5_hub";
    resetPreflightSuccessForTest();
    const v5HubConfigured = getFeishuConnectionStatus();
    expect(v5HubConfigured.configured).toBe(false);

    // Clean up
    if (saved.appId) process.env.FEISHU_APP_ID = saved.appId; else delete process.env.FEISHU_APP_ID;
    if (saved.secret) process.env.FEISHU_APP_SECRET = saved.secret; else delete process.env.FEISHU_APP_SECRET;
    if (saved.token) process.env.FEISHU_BASE_APP_TOKEN = saved.token; else delete process.env.FEISHU_BASE_APP_TOKEN;
    if (saved.mTable) process.env.FEISHU_MARKET_TABLE_ID = saved.mTable; else delete process.env.FEISHU_MARKET_TABLE_ID;
    if (saved.rTable) process.env.FEISHU_RESEARCH_TABLE_ID = saved.rTable; else delete process.env.FEISHU_RESEARCH_TABLE_ID;
    if (saved.v5T02) process.env.V5_HUB_TABLE_T02 = saved.v5T02; else delete process.env.V5_HUB_TABLE_T02;
  });

  // ────────────────────────────────────────────────────────────────────────────
  // P0 证据可信度（V6_RESEARCH_EVIDENCE_INTEGRITY_P0_FIX）
  // 目标不变量：AI 没有合法证据支撑的具体事实，不能继续伪装成已验证的研究结论。
  // ────────────────────────────────────────────────────────────────────────────

  const ILLEGAL_REF = "attachment:att-61e7709290c34556c5cf7892"; // 白名单外（真实存在于 EvidenceStore 的变体附件）
  const UNSUPPORTED_CLAIM = "该 ASIN 属于以 B0D34DNMCL 为父体的多变体家族，同系列提供黑/橙/红等颜色。";

  it("P0-EI-1: 混合引用摘要被整条拒收，绝不保留原句并挂上剩余合法引用", async () => {
    const task = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-0" } });
    const before = await getResearchDetail({ context: ownerContext, taskId: task.id });
    const providerCallsBefore = state.provider.mock.calls.length;

    state.provider.mockImplementationOnce(async (input: any) => {
      const refs = JSON.parse(input.messages[1].content).allowedEvidenceRefs as string[];
      return { ok: true, data: {
        summary: { text: UNSUPPORTED_CLAIM, evidenceRefs: [refs[0], ILLEGAL_REF] },
        opportunities: [{ text: "合法机会：价格锚点清晰。", evidenceRefs: [refs[0]] }],
        risks: [{ text: "合法风险：核心商业字段缺失。", evidenceRefs: [refs[0]] }],
        vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
        citations: [{ quote: "9.99", source: refs[0] }],
      } };
    });

    const updated = await runResearchAdvisory({
      context: ownerContext, taskId: task.id, expectedRevision: before.researchRevision,
      requested: ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"], idempotencyKey: crypto.randomUUID(),
    });
    expect(state.provider.mock.calls.length).toBe(providerCallsBefore + 1);
    expect(updated.deepseek.status).toBe("available");
    expect(updated.deepseek.summary).toBeNull();

    const after = await getResearchDetail({ context: ownerContext, taskId: task.id });
    const persisted = after.report as Record<string, unknown>;
    expect(persisted.summary).toBeNull();
    expect(persisted.opportunities).toEqual(["合法机会：价格锚点清晰。"]);
    expect(persisted.risks).toEqual(["合法风险：核心商业字段缺失。"]);
    // 失去支撑的事实不得出现在任何已验证结论面（未验证假设通道保留审计是允许且必需的）
    const verifiedSurface = JSON.stringify({
      summary: persisted.summary, opportunities: persisted.opportunities, risks: persisted.risks,
      vocAnalysis: persisted.vocAnalysis, narrativeBindings: persisted.narrativeBindings, citations: persisted.citations,
    });
    expect(verifiedSurface).not.toContain("B0D34DNMCL");
    // 拒收审计可追溯
    const claims = persisted.rejectedClaims as Array<{ field: string; illegalRefs: string[]; disposition: string }>;
    expect(claims.some((claim) => claim.field === "summary" && claim.illegalRefs.includes(ILLEGAL_REF)
      && claim.disposition === "rejected_whole_statement")).toBe(true);
    // 版本前进、人工决策与门禁不变、无外部网络
    expect(after.researchRevision).toBe(before.researchRevision + 1);
    expect(after.myChoice).toBeNull();
    expect(after.hasHumanDecision).toBe(false);
    expect(JSON.stringify(after.decisionDelivery)).toBe(JSON.stringify(before.decisionDelivery));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("P0-EI-2: 历史污染研报在正式详情读侧被安全屏蔽，原始记录与人工决策零改动", async () => {
    const { hashJson } = await import("@/lib/server/v5CanonicalHash");
    const task = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-0" } });
    const before = await getResearchDetail({ context: ownerContext, taskId: task.id });
    const trustedHash = before.reportHash;
    const trustedRevision = before.researchRevision;

    // 模拟历史遗留：报告正文含失去支撑的事实，审计里留下绑定阶段拒收记录
    const contaminated = {
      ...(before.report as Record<string, unknown>),
      summary: UNSUPPORTED_CLAIM,
      unverifiedAssumptions: [
        `summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
      ],
    };
    const root = JSON.parse(task.resultJson);
    root.v5Research.report = contaminated;
    root.v5Research.reportHash = hashJson(contaminated);
    await prisma.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: JSON.stringify(root) } });

    const detail = await getResearchDetail({ context: ownerContext, taskId: task.id });

    // 读侧：污染摘要暂停展示 + 明确提示原因
    expect(detail.report?.summary).toBeNull();
    expect(detail.reportIntegrity.suppressed).toBe(true);
    expect(detail.reportIntegrity.suppressedSummary).toBe(true);
    expect(detail.reportIntegrity.notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail.deepseek)).not.toContain("B0D34DNMCL");
    // 合法字段与版本绑定不受影响（不得「删掉全部研究内容」蒙混过关）
    expect(detail.report?.schema).toBe("research-report.v5");
    expect(Array.isArray(detail.report?.citations)).toBe(true);
    expect((detail.report?.citations as unknown[]).length).toBe((before.report?.citations as unknown[]).length);
    expect(Array.isArray(detail.report?.opportunities)).toBe(true);
    expect(Array.isArray(detail.report?.risks)).toBe(true);
    expect(Array.isArray(detail.report?.unverifiedAssumptions)).toBe(true);
    expect(detail.researchRevision).toBe(trustedRevision);
    expect(detail.myChoice).toBeNull();
    expect(detail.hasHumanDecision).toBe(false);

    // 原始持久化记录未被静默篡改（正文与 reportHash 原样保留，不伪装修复）
    const raw = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: task.id } });
    const rawReport = JSON.parse(raw.resultJson).v5Research.report;
    expect(rawReport.summary).toBe(UNSUPPORTED_CLAIM);
    expect(JSON.parse(raw.resultJson).v5Research.reportHash).toBe(hashJson(contaminated));
    expect(hashJson(contaminated)).not.toBe(trustedHash);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("P0-EI-3: 证据污染研报不得作为产品概念/决策材料来源（读侧边界阻断）", async () => {
    const { hashJson } = await import("@/lib/server/v5CanonicalHash");
    const { generateProductConceptV5 } = await import("@/lib/server/productConceptV5Service");
    const task = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-0" } });
    const before = await getResearchDetail({ context: ownerContext, taskId: task.id });
    const contaminated = {
      ...(before.report as Record<string, unknown>),
      summary: UNSUPPORTED_CLAIM,
      unverifiedAssumptions: [`summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`],
    };
    const root = JSON.parse(task.resultJson);
    root.v5Research.report = contaminated;
    root.v5Research.reportHash = hashJson(contaminated);
    const resultJsonBefore = JSON.stringify(root);
    await prisma.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: resultJsonBefore } });

    await expect(generateProductConceptV5({ context: ownerContext, taskId: task.id }))
      .rejects.toMatchObject({ code: "RESEARCH_REPORT_EVIDENCE_UNVERIFIED" });

    // 阻断必须发生在任何写入之前
    const raw = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: task.id } });
    expect(raw.resultJson).toBe(resultJsonBefore);
    expect(fetch).not.toHaveBeenCalled();
  });
});
