/** Explicit opt-in integration against an online SQLite backup and copied public evidence.
 * Never connects to the running user DB. No real AI request is possible in this suite. */
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const ai = vi.hoisted(() => ({ fail: false, timeout: false, recommend: false, inputs: [] as Record<string, unknown>[] }));
vi.mock("@/lib/server/aiClient", async (importOriginal) => {
 const actual=await importOriginal<typeof import("@/lib/server/aiClient")>();
 const importConfig=(env:Record<string,string|undefined>)=>actual.getAiConfig({...env,AI_PROVIDER:"deepseek",DEEPSEEK_MODEL:"offline-fixture-market"});
 return ({
  getAiConfig: (env=process.env) => importConfig(env),
  callAiJson: vi.fn(async (options: { messages: Array<{ content: string }> }) => {
    const input = JSON.parse(options.messages[1].content); ai.inputs.push(input);
    if (ai.timeout) return { ok: false, error: { code: "timeout" } };
    if (ai.fail) return { ok: false, error: { code: "invalid_api_key" } };
    if (Array.isArray(input.items)) return { ok: true, data: { translations: input.items.map((item: {id:string}) => ({ id:item.id,text:"隔离测试译文，不代表真实翻译服务成功" })) } };
    const refId = (input.evidence as Array<{ id: string }>)[0].id;
    const reviewResults = Object.fromEntries(((input.reviews ?? []) as Array<{ reviewRef: string }>).map((r) => [r.reviewRef, [] as string[]]));
    const comparisonSubjects = ((input.comparisonSubjects ?? []) as string[]);
    return {
      ok: true,
      data: {
        schema: "market-intelligence-report.v3",
        judgment: { text: "隔离测试报告；不代表真实AI验收。", canJudge: "可核对样本。", cannotJudge: "不可推断全市场。", nature: "inference", citations: [refId] },
        findings: [{ title: "测试发现", section: "overview", nature: "inference", what: "样本价格分布集中。", why: "用于测试验证。", basis: "锁定样本。", limits: ["仅隔离测试"], citations: [refId] }],
        riskGaps: [{ title: "测试风险", text: "样本有限。", gap: "无历史序列。", impact: "不能判断趋势。", nature: "fact", citations: [refId] }],
        productOpportunities: ai.recommend ? [{ id: "o1", title: "隔离测试研究假设", buyerProblem: "仅用于合同验收", scenario: "测试场景", hypothesis: "测试改进假设，不代表商业机会", unverified: ["成本与性能未知"], counterEvidence: [], rejectionConditions: ["实测无改善则放弃"], developmentConstraints: ["尚无报价和供应条件"], citations: [input.samples[0].evidence.id] }] : [],
        recommendationDecision: ai.recommend ? { status: "recommend", reason: "隔离测试验证研究对象交接，不代表真实AI推荐", citations: [input.samples[0].evidence.id] } : { status: "insufficient", reason: "隔离测试不制造商业推荐，待核对真实机会。", citations: [] },
        researchRecommendations: ai.recommend ? [{ subjectKey: input.samples[0].subjectKey, opportunityIds: ["o1"], role: "benchmark", rationale: "测试：研究主流方案", researchQuestions: ["测试：改进是否保留已有优点？"], citations: [input.samples[0].evidence.id] }] : [],
        nextActions: [{ question: "测试问题？", neededEvidence: "测试证据", howToVerify: "测试方法", doneWhen: "测试完成", citations: [refId] }],
        workspaces: Object.fromEntries(["competition", "demand", "voice", "comparison"].map((key) => [
          key,
          key === "comparison" && !comparisonSubjects.length
            ? { status: "insufficient", reason: "未选择对比商品。", summary: { text: "未对比。", nature: "unknown", citations: [] }, limits: [] }
            : { status: "assessed", reason: "", summary: { text: "隔离测试报告；不代表真实AI验收。", nature: "inference", citations: [refId] }, limits: ["仅测试"] },
        ])),
        comparisonSubjects,
        comparisonItems: comparisonSubjects.map((subjectKey) => ({ subjectKey, advantages: ["测试优势"], limitations: ["测试局限"], unknowns: ["测试待验"], citations: [refId] })),
        comparisonDifferences: [],
        voiceThemes: [],
        reviewResults,
      },
    };
  }),
});});
import { prisma } from "@/lib/server/db";
import { getMarketIntelligence, updateMarketIntelligence } from "./marketIntelligenceService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import { projectProductFactEvidence } from "@/lib/server/research/productFactEvidenceProjection";
import { projectResearchDetailFacts } from "@/lib/server/research/researchDetailFactProjection";
import { GET, POST } from "@/app/api/market-analysis/[scanId]/intelligence/route";
import { NextRequest } from "next/server";
import { POST as captureModule } from "@/app/api/source-layer/acquire/module/route";
import { getMarketAnalysis, saveMarketGate, saveMarketRepresentatives, handoffMarketToResearch } from "@/lib/server/v5MarketService";
import { readScopeConfirmationView, saveScopeConfirmations } from "@/lib/server/marketScopeConfirmationService";
import { GET as researchDetailGet } from "@/app/api/research/[taskId]/route";
const root = process.env.MARKET_INTELLIGENCE_SNAPSHOT_ROOT;
const context = { mode: "owner" as const, token: "" };
const scanId = "cmv78ci4v0002dglj9gt6g6tq";

describe.runIf(Boolean(root))("market intelligence isolated real-evidence snapshot", () => {
  beforeAll(async () => {
    if (!root || !resolve(root).startsWith(resolve(".tmp/market-intelligence-acceptance")) || process.env.DATABASE_URL !== `file:${resolve(root, "database/dev.db").replaceAll("\\", "/")}` || resolve(process.env.SOURCE_LAYER_STORE_DIR ?? "") !== resolve(root, "evidence/source-layer-store")) throw new Error("DISPOSABLE_SNAPSHOT_BINDING_REQUIRED");
    expect(JSON.parse(readFileSync(resolve(root, "snapshot-manifest.json"), "utf8")).files.length).toBeGreaterThan(0);
    // Prune synthetic offline-fixture-market reports from prior test runs in this disposable snapshot DB.
    const row = await prisma.marketScan.findUniqueOrThrow({ where: { id: scanId } });
    const def = JSON.parse(row.sampleDefinitionJson);
    if (def.marketIntelligence?.reports) {
      delete def.marketIntelligence.reports;
      await prisma.marketScan.update({ where: { id: scanId }, data: { sampleDefinitionJson: JSON.stringify(def) } });
    }
    await prisma.v5OperationReceipt.deleteMany({ where: { resourceKey: scanId } });
  });
  afterAll(async () => { vi.unstubAllEnvs(); await prisma.$disconnect(); });

  it("reads real locked prices, four module states and quote provenance without changing the snapshot", async () => {
    const before = await prisma.marketScan.findUniqueOrThrow({ where: { id: scanId } });
    const view = await getMarketIntelligence({ context, scanId });
    expect(view.samples.length).toBeGreaterThan(20);
    expect(view.samples.filter((s) => s.price !== null).length).toBeGreaterThan(10);
    expect(view.samples.every((s) => /^[a-f0-9]{64}$/u.test(s.evidence.contentHash))).toBe(true);
    expect(await prisma.marketScan.findUnique({ where: { id: scanId } })).toEqual(before);
    writeFileSync(resolve(root!, "intelligence-readback.json"), JSON.stringify({ scanId, samples: view.samples.length, valid: view.samples.filter((s) => s.valid).length, sources: view.sources.map((s) => ({ module: s.module, subject: s.subjectKey, status: s.status })), keywords: view.keywords.length, reviews: view.reviews.length, trends: view.trends.length, queries: view.bindingCandidates, provider: view.provider }, null, 2));
  });

  it("reproduces B0HFS7K4GP BSR 138 through fact projection and detail DTO", async () => {
    const source = await createEvidenceStore("owner:v1").getSubject("amazon:US:B0HFS7K4GP");
    expect(source?.versions.length).toBeGreaterThan(0);
    const fact = projectProductFactEvidence(adaptEvidenceToProductFact({ evidence: source!.versions.at(-1)! }), source!.attachments ?? []);
    const detail = projectResearchDetailFacts(fact);
    expect(fact.market.bsr.value).toBe(138);
    expect(detail.bsr).toBe(138);
    expect(detail.fieldEvidence.bsr?.length).toBeGreaterThan(0);
    const response = await researchDetailGet(new NextRequest("http://127.0.0.1:3422/api/research/cmv795sm70005z7uk29v9d837", { headers: { Host: "127.0.0.1:3422" } }), { params: Promise.resolve({ taskId: "cmv795sm70005z7uk29v9d837" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.facts.bsr).toBe(138);
    expect(body.data.facts.fbaFee).toBeNull();
    expect(body.data.facts.fbaFeeNature).toBe("unknown");
  });

  it("keeps missing credentials fail-closed at the actual HTTP contract", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "placeholder"); vi.stubEnv("AI_API_KEY", "");
    const url = `http://127.0.0.1:3422/api/market-analysis/${scanId}/intelligence`;
    const get = await GET(new NextRequest(url, { headers: { Host: "127.0.0.1:3422" } }), { params: Promise.resolve({ scanId }) });
    const body = await get.json();
    expect(get.status).toBe(200); expect(body.data.provider.code).toBe("PROVIDER_NOT_CONFIGURED");
    const post = await POST(new NextRequest(url, { method: "POST", headers: { Host: "127.0.0.1:3422", Origin: "http://127.0.0.1:3422", "Content-Type": "application/json", "Idempotency-Key": `snapshot-missing-${Date.now()}` }, body: JSON.stringify({ action: "generate", expectedVersion: body.data.resourceVersion, expectedInputHash: body.data.inputHash }) }), { params: Promise.resolve({ scanId }) });
    expect(post.status).toBe(409); expect((await post.json()).error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(ai.inputs).toHaveLength(0);
  });

  it("saves/reloads/idempotently replays explicit query binding without changing frozen metrics or human gate", async () => {
    const view = await getMarketIntelligence({ context, scanId });
    const before = await prisma.marketScan.findUniqueOrThrow({ where: { id: scanId } });
    const key = view.bindingCandidates.find((c) => c.module === "keyword_mining_trend")?.subjectKey ?? view.bindingCandidates[0]?.subjectKey;
    const request = { context, scanId, action: "bind" as const, subjectKeys: key ? [key] : [], expectedVersion: view.resourceVersion, idempotencyKey: `snapshot-bind-${Date.now()}` };
    await updateMarketIntelligence(request);
    const replay = await updateMarketIntelligence(request);
    expect(replay.replayed).toBe(true);
    const readback = await getMarketIntelligence({ context, scanId });
    expect(readback.queryBindings).toEqual(request.subjectKeys);
    const after = await prisma.marketScan.findUniqueOrThrow({ where: { id: scanId } });
    expect(after.sampleSnapshotJson).toBe(before.sampleSnapshotJson); expect(after.metricsJson).toBe(before.metricsJson);
    expect(JSON.parse(after.sampleDefinitionJson).workflow).toEqual(JSON.parse(before.sampleDefinitionJson).workflow);
  });

  it("offline Provider validates exact refs, persists history, rejects stale/CAS and retains old report on Provider failure", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-contract-key"); vi.stubEnv("AI_API_KEY", ""); vi.stubEnv("MARKET_RESEARCH_REAL_AI_ENABLED", "true");
    const current = await getMarketIntelligence({ context, scanId });
    const request = { context, scanId, action: "generate" as const, expectedVersion: current.resourceVersion, expectedInputHash: current.inputHash, idempotencyKey: `snapshot-report-${Date.now()}` };
    const generated = await updateMarketIntelligence(request);
    const readback = await getMarketIntelligence({ context, scanId });
    expect(readback.reports.at(-1)?.inputHash).toBe(readback.inputHash);
    expect(readback.reports.at(-1)?.model).toBe("offline-fixture-market");
    expect(readback.reports.at(-1)?.inputManifest?.reviewIds).toEqual((ai.inputs.at(-1)?.reviews as Array<{id:string}>).map(r=>r.id));
    expect(readback.reports.at(-1)?.inputManifest?.evidence.length).toBeGreaterThan(0);
    expect((await updateMarketIntelligence(request)).replayed).toBe(true);
    expect(ai.inputs).toHaveLength(1);
    await expect(updateMarketIntelligence({ ...request, idempotencyKey: `snapshot-cas-${Date.now()}` })).rejects.toMatchObject({ code: "CAS_CONFLICT" });
    await expect(updateMarketIntelligence({ ...request, expectedVersion: generated.resourceVersion, expectedInputHash: "obsolete", idempotencyKey: `snapshot-stale-${Date.now()}` })).rejects.toMatchObject({ code: "MARKET_RESEARCH_INPUT_STALE" });
    ai.fail = true;
    await expect(updateMarketIntelligence({ ...request, expectedVersion: generated.resourceVersion, idempotencyKey: `snapshot-fail-${Date.now()}` })).rejects.toMatchObject({ code: "MARKET_AI_PROVIDER_FAILED" });
    expect((await getMarketIntelligence({ context, scanId })).reports).toEqual(readback.reports);

    // Paid AI succeeds, but persistence fails with CAS_CONFLICT; retry saves without re-calling AI.
    ai.fail = false;
    const callsBeforeRecovery = ai.inputs.length;
    const realUpdateMany = prisma.marketScan.updateMany.bind(prisma.marketScan);
    const spy = vi.spyOn(prisma.marketScan, "updateMany").mockResolvedValueOnce({ count: 0 });
    try {
      await expect(updateMarketIntelligence({
        ...request,
        comparisonSubjects: ["amazon:US:B0CFTP6JR4"],
        expectedVersion: generated.resourceVersion,
        idempotencyKey: `snapshot-save-fail-${Date.now()}`,
      })).rejects.toMatchObject({ code: "CAS_CONFLICT" });
    } finally {
      spy.mockImplementation(realUpdateMany);
      spy.mockRestore();
    }
    expect(ai.inputs).toHaveLength(callsBeforeRecovery + 1);
    const afterSaveFail = await getMarketIntelligence({ context, scanId });
    expect(afterSaveFail.recoverableReport).toMatchObject({
      inputHash: afterSaveFail.inputHash,
      comparisonSubjects: ["amazon:US:B0CFTP6JR4"],
      reason: "CAS_CONFLICT",
      stale: false,
    });
    const recovered = await updateMarketIntelligence({
      ...request,
      comparisonSubjects: ["amazon:US:B0CFTP6JR4"],
      expectedVersion: afterSaveFail.resourceVersion,
      idempotencyKey: `snapshot-save-recover-${Date.now()}`,
    });
    expect(ai.inputs).toHaveLength(callsBeforeRecovery + 1);
    expect(recovered.recoverableReport).toBeUndefined();
    expect(recovered.reports.at(-1)?.comparisonSubjects).toEqual(["amazon:US:B0CFTP6JR4"]);
  });

  it("requires a new human market decision after report regeneration and preserves representatives", async () => {
    const before = await getMarketAnalysis({ context, scanId });
    expect(before.marketGate.stale).toBe(true);
    expect(before.marketGate.effectiveStatus).toBe("PENDING");
    await expect(handoffMarketToResearch({ context, scanId, expectedScanHash: before.sampleHash, selections: [{ marketSampleKey: `${scanId}:${before.sampleItems[0].asin}`, asin: before.sampleItems[0].asin, subjectKey: `amazon:US:${before.sampleItems[0].asin}` }], idempotencyKey: `snapshot-no-bypass-${Date.now()}` })).rejects.toMatchObject({ code: "MARKET_WORKFLOW_STALE" });
    const confirmed = await saveMarketGate({ context, scanId, status: "PAUSE", reason: "隔离自动化测试：重新确认市场判断，不代表真实业务决定", expectedVersion: before.resourceVersion, expectedScanHash: before.sampleHash, idempotencyKey: `snapshot-reconfirm-${Date.now()}` });
    expect(confirmed.marketGate.stale).toBe(false);
    expect(confirmed.marketGate.effectiveStatus).toBe("PAUSE");
    expect(confirmed.representatives).toEqual(before.representatives);
  });

  it("wires all four supplement contracts through the real route/Gateway/Store into 02 without changing product grain", async () => {
    const stamp = new Date().toISOString();
    const keywordFingerprint = randomBytes(32).toString("hex");
    const productFingerprint = randomBytes(32).toString("hex");
    const keywordKey = `sellersprite:US:keyword-mining:${keywordFingerprint}`;
    const productKey = `sellersprite:US:product-market:${productFingerprint}`;
    const subjectKey = "amazon:US:B0HFS7K4GP";
    const fixtures = [
      { module: "reverse_asin", subjectKey, identity: { asin: "B0HFS7K4GP" }, data: { rows: [{ keyword: "fixture reverse mat", monthlySearches: 1200 }] } },
      { module: "keyword_mining_trend", subjectKey: keywordKey, identity: { keyword: "fixture seed mat" }, data: { queryContract: { queryFingerprint: keywordFingerprint }, rows: [{ keyword: "fixture seed mat", monthlySearches: 5000 }] } },
      { module: "sellersprite_product_market", subjectKey: productKey, identity: { category: "fixture category" }, data: { queryContract: { queryFingerprint: productFingerprint }, visibleSnapshot: { tables: [{ headers: ["ASIN", "商品名称", "价格", "预估FBA费", "月销量"], rows: [["B0HFS7K4GP", "fixture product", "$15.88", "$4.25", "200"]] }] } } },
      { module: "historical_trend", subjectKey, identity: { asin: "B0HFS7K4GP" }, data: { series: [{ date: "2026-08", price: 15 }, { date: "2026-09", price: 16 }] } },
    ];
    const evidenceIds: string[] = [];
    for (const fixture of fixtures) {
      const response = await captureModule(new NextRequest("http://127.0.0.1:3422/api/source-layer/acquire/module", { method: "POST", headers: { Host: "127.0.0.1:3422", Origin: "http://127.0.0.1:3422", "Content-Type": "application/json" }, body: JSON.stringify({ ...fixture, sourceType: "sellersprite_plugin", acquisitionMode: "VISIBLE_CHART", provider: "SellerSprite", sourceSurface: "synthetic_test_fixture_no_external_collection", sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse", metricNature: "provider_estimate", status: "VALIDATED_AVAILABLE", capturedAt: stamp, evidenceOnly: true }) }));
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(201);
      const source = await createEvidenceStore("owner:v1").getSubject(fixture.subjectKey);
      const saved = source?.attachments?.find((a) => a.payload.module === fixture.module && a.capturedAt === stamp);
      expect(saved).toBeTruthy(); expect(source?.rawArtifacts?.length).toBeGreaterThan(0);
      evidenceIds.push(saved!.attachmentId);
    }
    const beforeBind = await getMarketIntelligence({ context, scanId });
    expect(beforeBind.keywords.some((k) => k.subjectKey === keywordKey)).toBe(false);
    const bound = await updateMarketIntelligence({ context, scanId, action: "bind", subjectKeys: [keywordKey, productKey], expectedVersion: beforeBind.resourceVersion, idempotencyKey: `snapshot-bind-four-${Date.now()}` });
    expect(bound.samples).toEqual(beforeBind.samples);
    expect(bound.keywords.some((k) => k.subjectKey === keywordKey && k.searchVolume === 5000)).toBe(true);
    expect(bound.keywords.some((k) => k.subjectKey === subjectKey && k.searchVolume === 1200)).toBe(true);
    expect(bound.productMarkets[0]).toMatchObject({ subjectKey: productKey, rows: [{ asin: "B0HFS7K4GP", fbaFee: 4.25, monthlySales: 200 }] });
    expect(bound.trends.some((t) => t.subjectKey === subjectKey && t.points.length === 2)).toBe(true);
    expect(evidenceIds.every((id) => bound.sources.some((s) => s.evidence.evidenceId === id && s.status === "available"))).toBe(true);
    expect((await getMarketAnalysis({ context, scanId })).marketGate.effectiveStatus).toBe("PENDING");
  });

  it("applies formal exclusion only on explicit action and keeps chart/report input at the same 31 of 34 identities", async () => {
    const before = await getMarketIntelligence({context,scanId});
    const frozen = await prisma.marketScan.findUniqueOrThrow({where:{id:scanId}});
    const scope = await readScopeConfirmationView(scanId);
    const selected = scope.rows.filter((r)=>before.statistics!.subjects.includes(r.subjectKey)).slice(0,3);
    const save = async (restore:boolean) => {
      const fresh = await readScopeConfirmationView(scanId);
      await saveScopeConfirmations({context,scanId,expectedScanHash:fresh.scanHash,idempotencyKey:`scope-${restore}-${Date.now()}`,items:selected.map((row)=>{ const now=fresh.rows.find((r)=>r.marketSampleKey===row.marketSampleKey)!;return {marketSampleKey:row.marketSampleKey,asin:row.asin,subjectKey:row.subjectKey,status:restore?(row.reviewStatus==="OUT_OF_SCOPE"?"OUT_OF_SCOPE" as const:row.reviewStatus==="IN_SCOPE"?"IN_SCOPE" as const:"UNREVIEWED" as const):"OUT_OF_SCOPE" as const,reason:restore?(row.review?.reason??""):"隔离范围验收，不代表实际商品分类",expectedVersion:now.currentVersion,expectedScopeRevision:now.scopeRevision};})});
    };
    try {
      await save(false);
      const marked = await getMarketIntelligence({context,scanId});
      expect(marked.statistics!.sampleCount).toBe(before.statistics!.sampleCount);
      expect(marked.scope!.changed).toBe(true);
      await expect(updateMarketIntelligence({context,scanId,action:"apply-scope",expectedScopeHash:"obsolete",expectedVersion:marked.resourceVersion,idempotencyKey:`scope-stale-${Date.now()}`})).rejects.toMatchObject({code:"MARKET_SCOPE_CHANGED"});
      const applied = await updateMarketIntelligence({context,scanId,action:"apply-scope",expectedScopeHash:marked.scope!.hash,expectedVersion:marked.resourceVersion,idempotencyKey:`scope-apply-${Date.now()}`});
      expect(applied.statistics!.sampleCount).toBe(before.statistics!.sampleCount-3);
      expect(applied.scope!.changed).toBe(false);
      ai.fail=false;
      await updateMarketIntelligence({context,scanId,action:"generate",expectedVersion:applied.resourceVersion,expectedInputHash:applied.inputHash,idempotencyKey:`scope-report-${Date.now()}`});
      expect(ai.inputs.at(-1)?.statistics).toEqual(applied.statistics);
      expect((ai.inputs.at(-1)?.samples as unknown[]).length).toBe(applied.statistics!.sampleCount);
      const after = await prisma.marketScan.findUniqueOrThrow({where:{id:scanId}});
      expect(after.sampleSnapshotJson).toBe(frozen.sampleSnapshotJson);expect(after.metricsJson).toBe(frozen.metricsJson);
      expect((await getMarketAnalysis({context,scanId})).marketGate.effectiveStatus).toBe("PENDING");
    } finally {
      await save(true);
      const fresh=await getMarketIntelligence({context,scanId});
      await updateMarketIntelligence({context,scanId,action:"apply-scope",expectedScopeHash:fresh.scope!.hash,expectedVersion:fresh.resourceVersion,idempotencyKey:`scope-restore-${Date.now()}`});
    }
  });

  it("persists explicit translations, reuses cache and leaves statistics/report input unchanged", async () => {
    ai.fail=false;
    const before=await getMarketIntelligence({context,scanId}), calls=ai.inputs.length;
    const id=`title:${before.samples.find((s)=>before.statistics!.subjects.includes(s.subjectKey))!.subjectKey}`;
    const translated=await updateMarketIntelligence({context,scanId,action:"translate",targetIds:[id],expectedVersion:before.resourceVersion,idempotencyKey:`translate-${Date.now()}`});
    expect(translated.translations?.[id]?.text).toContain("隔离测试译文");
    expect(translated.inputHash).toBe(before.inputHash);
    expect(translated.statistics).toEqual(before.statistics);
    const count=ai.inputs.length;
    expect(count-calls).toBeLessThanOrEqual(1);
    await updateMarketIntelligence({context,scanId,action:"translate",targetIds:[id],expectedVersion:translated.resourceVersion,idempotencyKey:`translate-cache-${Date.now()}`});
    expect(ai.inputs).toHaveLength(count);
    expect((await getMarketIntelligence({context,scanId})).translations?.[id]).toEqual(translated.translations?.[id]);
  });

  it("blocks a different-key retry after uncertain AI timeout and requires explicit provider reconciliation", async () => {
    ai.fail=false; ai.timeout=true;
    const before=await getMarketIntelligence({context,scanId}), calls=ai.inputs.length;
    const request={context,scanId,action:"generate" as const,expectedVersion:before.resourceVersion,expectedInputHash:before.inputHash};
    try {
      await expect(updateMarketIntelligence({...request,idempotencyKey:`timeout-${Date.now()}`})).rejects.toMatchObject({code:"MARKET_AI_RESULT_UNKNOWN"});
      await expect(updateMarketIntelligence({...request,idempotencyKey:`timeout-again-${Date.now()}`})).rejects.toMatchObject({code:"MARKET_AI_RESULT_UNKNOWN"});
      expect(ai.inputs).toHaveLength(calls+1);
      expect((await getMarketIntelligence({context,scanId})).reports).toEqual(before.reports);
      await expect(updateMarketIntelligence({...request,action:"resolve-ai",idempotencyKey:`no-ack-${Date.now()}`})).rejects.toMatchObject({code:"MARKET_AI_PROVIDER_CHECK_REQUIRED"});
    } finally {
      ai.timeout=false;
      const resolved=await updateMarketIntelligence({...request,action:"resolve-ai",confirmedProviderChecked:true,idempotencyKey:`timeout-resolved-${Date.now()}`});
      expect(resolved.aiOperations).toEqual([]);
      expect(ai.inputs).toHaveLength(calls+1);
    }
  });

  it("persists an adopted opportunity through the human gate into 03 and replays without duplicate tasks", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-contract-key"); vi.stubEnv("AI_API_KEY", ""); vi.stubEnv("MARKET_RESEARCH_REAL_AI_ENABLED", "true");
    ai.fail = false; ai.timeout = false; ai.recommend = true;
    try {
      const before = await getMarketIntelligence({ context, scanId });
      await updateMarketIntelligence({ context, scanId, action: "generate", expectedVersion: before.resourceVersion, expectedInputHash: before.inputHash, idempotencyKey: `opportunity-generate-${Date.now()}` });
      const generated = await getMarketIntelligence({ context, scanId });
      const report = generated.reports.at(-1)!;
      const recommendation = report.researchRecommendations![0];
      expect(report.recommendationDecision?.status).toBe("recommend");
      const scan = await getMarketAnalysis({ context, scanId });
      const sample = scan.sampleItems.find((item) => recommendation.subjectKey === `amazon:US:${item.asin}`)!;
      const marketSampleKey = `${scanId}:${sample.asin}`;
      const item = { marketSampleKey, asin: sample.asin, subjectKey: recommendation.subjectKey, role: "benchmark", note: "隔离测试人工选择理由", researchRecommendation: { reportId: report.id, inputHash: report.inputHash, opportunityIds: ["o1"] } };
      await expect(saveMarketRepresentatives({ context, scanId, expectedScanHash: scan.sampleHash, expectedVersion: scan.resourceVersion, items: [item], idempotencyKey: `opportunity-gate-block-${Date.now()}` })).rejects.toMatchObject({ code: "MARKET_WORKFLOW_STALE" });
      const confirmed = await saveMarketGate({ context, scanId, status: "PROCEED", missingDataAcknowledged: true, reason: "隔离自动化验收，不代表真实市场决定", expectedVersion: scan.resourceVersion, expectedScanHash: scan.sampleHash, idempotencyKey: `opportunity-human-${Date.now()}` });
      await saveMarketRepresentatives({ context, scanId, expectedScanHash: confirmed.sampleHash, expectedVersion: confirmed.resourceVersion, items: [item], idempotencyKey: `opportunity-select-${Date.now()}` });
      const reread = await getMarketAnalysis({ context, scanId });
      expect(reread.representatives.items[0].researchContext?.recommendation.researchQuestions).toEqual(recommendation.researchQuestions);
      const handoff = { context, scanId, expectedScanHash: reread.sampleHash, selections: [{ marketSampleKey, asin: sample.asin, subjectKey: recommendation.subjectKey }], idempotencyKey: `opportunity-handoff-${Date.now()}` };
      const result = await handoffMarketToResearch(handoff);
      expect(result.partial).toBe(false);
      const taskId = result.items[0].taskId as string;
      const task = await prisma.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } });
      expect(JSON.parse(task.resultJson!).marketProvenance.opportunityResearch).toEqual(reread.representatives.items[0].researchContext);
      const taskCount = await prisma.viralAnalysisRecord.count();
      expect((await handoffMarketToResearch(handoff)).replayed).toBe(true);
      expect(await prisma.viralAnalysisRecord.count()).toBe(taskCount);
      const response = await researchDetailGet(new NextRequest(`http://127.0.0.1:3422/api/research/${taskId}`, { headers: { Host: "127.0.0.1:3422" } }), { params: Promise.resolve({ taskId }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.marketProvenance.opportunityResearch.reportId).toBe(report.id);
    } finally { ai.recommend = false; }
  }, 60_000); // Real SQLite + several complete immutable-evidence projections, not a unit-test timeout.
});
