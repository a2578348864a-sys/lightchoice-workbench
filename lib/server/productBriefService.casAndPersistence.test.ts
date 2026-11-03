import { auditResearchClaims, makeUnavailableClaimAudit } from "@/lib/research/evidenceAudit";
import { buildBriefMarkdown } from "@/lib/productBrief/export";
import { HUMAN_COMPARISON_NOTE, SOURCE_COMPARISON_NOTE_PREFIX } from "@/lib/productBrief/comparisonEvidence";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessContext } from "@/lib/server/accessPassword";
import { generateProductBrief, previewProductBrief, readProductBrief, saveProductBrief } from "./productBriefService";

/**
 * P3-02 异常路径（受控故障注入，只在本文件的 Prisma 替身上生效）：
 * A. 并发 CAS —— 另一个写入者先提交后，本请求的旧 storageVersion 必须被精确拒绝；
 * B. 落盘失败 —— 写入抛错时不得产生半个新版本，旧 Brief 与历史保持可读，重试只产生一个版本。
 */
const state = vi.hoisted(() => ({
  rows: new Map<string, { id: string; type: string; resultJson: string; updatedAt: Date; decisionStatus: string }>(),
  mode: "ok" as "ok" | "conflict" | "throw" | "race",
  updateCalls: 0,
  detail: vi.fn(),
  bundle: vi.fn(),
  voc: vi.fn(),
  findUnique: vi.fn(),
}));

function project(row: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: {
      findUnique: state.findUnique,
      updateMany: vi.fn(async (args: {
        where: { id: string; updatedAt: Date; resultJson: string; decisionStatus: string };
        data: { resultJson: string; updatedAt: Date; decisionStatus?: string };
      }) => {
        state.updateCalls += 1;
        if (state.mode === "throw") throw new Error("SQLITE_IOERR: disk I/O error (injected)");
        if (state.mode === "conflict") return { count: 0 };
        if (state.mode === "race") {
          // 读到写之间，另一个写入者抢先把同一行改掉（别的命名空间），本请求的旧版本条件因此失配
          const racing = state.rows.get(args.where.id);
          if (racing) {
            racing.resultJson = JSON.stringify({ ...JSON.parse(racing.resultJson), otherWriterNamespace: { touched: true } });
            racing.updatedAt = new Date(racing.updatedAt.getTime() + 1000);
          }
          return { count: 0 };
        }
        const row = state.rows.get(args.where.id);
        if (!row) return { count: 0 };
        // 真实 CAS：where 里的版本条件必须与当前行一致
        if (row.updatedAt.getTime() !== args.where.updatedAt.getTime() || row.resultJson !== args.where.resultJson) return { count: 0 };
        row.resultJson = args.data.resultJson;
        row.updatedAt = args.data.updatedAt;
        if (args.data.decisionStatus !== undefined) row.decisionStatus = args.data.decisionStatus;
        return { count: 1 };
      }),
    },
    marketScan: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("@/lib/server/v5ResearchService", () => ({ getResearchDetail: state.detail }));
vi.mock("@/lib/server/research/researchInputBundle", () => ({ buildResearchInputBundle: state.bundle }));
vi.mock("@/lib/server/vocAnalysis", () => ({ getVocAnalysis: state.voc }));

const context: AccessContext = { mode: "owner", token: "test-token" };
const taskId = "task-p302-fault";

function seed() {
  state.rows.clear();
  state.updateCalls = 0;
  state.mode = "ok";
  state.rows.set(taskId, {
    id: taskId,
    type: "workflow",
    resultJson: JSON.stringify({}),
    updatedAt: new Date("2026-10-28T00:00:00.000Z"),
    decisionStatus: "PROCEED",
  });
  state.findUnique.mockImplementation(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    const row = state.rows.get(args.where.id);
    return row ? project({ ...row }, args.select) : null;
  });
  state.bundle.mockResolvedValue({
    productFact: {
      sourceProof: { evidenceId: "ev-1" },
      basic: {
        title: { status: "present", value: "硅胶烘焙垫" },
        price: { status: "present", value: { amount: 19.99, currency: "USD" } },
      },
      profit: {},
      extended: {},
    },
  });
  state.voc.mockResolvedValue(null);
  const detail = {
    taskId,
    researchRevision: 1,
    stale: false,
    asin: "B0FAULTTEST",
    marketplace: "US",
    myChoice: { canonicalStatus: "PROCEED" },
    reportHash: "report-hash-1",
    factHash: "fact-hash-1",
    evidenceHash: "ev-hash-1",
    report: {
      schema: "research-report.v5",
      summary: "边缘防滑是被重复提到的具体问题，但材料、结构与使用场景都可能解释它。",
      opportunities: ["增加边缘凸起结构", "改良表面纹理"],
      risks: ["结构变更可能抬高模具成本"],
      vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
      narrativeBindings: [
        { field: "summary", text: "边缘防滑是被重复提到的具体问题，但材料、结构与使用场景都可能解释它。", evidenceRefs: ["evidence:s1"] },
        { field: "opportunities[0]", text: "增加边缘凸起结构", evidenceRefs: ["evidence:o1"] },
        { field: "opportunities[1]", text: "改良表面纹理", evidenceRefs: ["evidence:o2"] },
        { field: "risks[0]", text: "结构变更可能抬高模具成本", evidenceRefs: ["evidence:r1"] },
      ],
    },
  };
  state.detail.mockResolvedValue({ ...detail, claimAudit: auditResearchClaims({ summary: detail.report.summary,
    opportunities: detail.report.opportunities, risks: detail.report.risks, painPoints: detail.report.vocAnalysis.painPoints,
    salesGrade: "NOT_AVAILABLE", reviewBase: null }) });
}

async function currentRow() {
  const row = state.rows.get(taskId);
  return { raw: row?.resultJson ?? "", parsed: JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown> };
}

describe("P3-02 异常路径：并发 CAS 与落盘失败", () => {
  beforeEach(seed);

  it("预览之后需求单被他人修改时拒绝确认，保留已保存内容", async () => {
    await generateProductBrief({ context, taskId });
    const preview = await previewProductBrief({ context, taskId });
    await saveProductBrief({ context, taskId, expectedRevision: 1, patch: { status: "READY", targetUser: { text: "另一操作者的输入", nature: "ASSUMPTION", evidenceRefs: [] } } });
    await expect(generateProductBrief({ context, taskId, previewRevision: 1, previewSourceBinding: preview.next.sourceBinding })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_PREVIEW_STALE" });
    const current = await readProductBrief({ context, taskId });
    expect(current.brief?.revision).toBe(2);
    expect(current.brief?.targetUser?.text).toBe("另一操作者的输入");
  });

  it("预览之后研究来源变化时拒绝确认", async () => {
    await generateProductBrief({ context, taskId });
    const preview = await previewProductBrief({ context, taskId });
    const detail = await state.detail();
    state.detail.mockResolvedValue({ ...detail, reportHash: "new-report-hash" });
    await expect(generateProductBrief({ context, taskId, previewRevision: 1, previewSourceBinding: preview.next.sourceBinding })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_PREVIEW_STALE" });
    expect((await readProductBrief({ context, taskId })).brief?.revision).toBe(1);
  });

  it("A｜并发 CAS：旧 storageVersion 写入被拒绝，其他写入者的改动不被覆盖，人工内容不丢失", async () => {
    const first = await generateProductBrief({ context, taskId });
    expect(first.brief.revision).toBe(1);

    // 版本号仍是 1，但「读到写」之间另一个写入者改动了同一行（别的命名空间）：
    // 这是版本号未变、存储版本已推进的真实并发场景。
    state.mode = "race";
    const callsBefore = state.updateCalls;
    await expect(
      saveProductBrief({
        context,
        taskId,
        expectedRevision: 1,
        patch: { targetUser: { text: "并发中被拒绝的写入", nature: "ASSUMPTION", evidenceRefs: [] }, status: "DRAFT" } as never,
      }),
    ).rejects.toMatchObject({ code: "task_result_conflict" });

    state.mode = "ok";
    // 确实走到了写库并因版本不匹配被拒，而不是在业务前置检查处提前失败
    expect(state.updateCalls).toBeGreaterThan(callsBefore);

    // 另一个写入者的改动没有被覆盖，Brief 也没有被写成半截
    const afterRace = await currentRow();
    expect(afterRace.parsed.otherWriterNamespace).toEqual({ touched: true });
    const readAfterRace = await readProductBrief({ context, taskId });
    expect(readAfterRace.brief?.revision).toBe(1);
    expect(readAfterRace.brief?.targetUser?.text ?? null).toBeNull();

    // 重新读取后基于最新存储版本重试即可安全继续
    const retry = await saveProductBrief({
      context,
      taskId,
      expectedRevision: 1,
      patch: { targetUser: { text: "重新读取后写入", nature: "ASSUMPTION", evidenceRefs: [] }, status: "READY" } as never,
    });
    expect(retry.brief.revision).toBe(2);
    expect(retry.brief.targetUser?.text).toBe("重新读取后写入");
    const afterRetry = await currentRow();
    expect(afterRetry.parsed.otherWriterNamespace).toEqual({ touched: true });
  });

  it("B｜落盘失败：不产生半个版本，旧 Brief 可读，重试只产生一个版本且不继承批准", async () => {
    const first = await generateProductBrief({ context, taskId });
    expect(first.brief.revision).toBe(1);
    const beforeFailure = await currentRow();
    const preview = await previewProductBrief({ context, taskId });
    const input = { context, taskId, previewRevision: 1, previewSourceBinding: preview.next.sourceBinding, idempotencyKey: "retry-test" };

    // 写入阶段注入 I/O 失败
    state.mode = "throw";
    await expect(generateProductBrief(input)).rejects.toThrow(/SQLITE_IOERR/);
    state.mode = "ok";

    // 失败后存储完全未动：既没有 half 的 rev2，也没有被清空的旧 Brief
    const afterFailure = await currentRow();
    expect(afterFailure.raw).toBe(beforeFailure.raw);
    const readAfterFailure = await readProductBrief({ context, taskId });
    expect(readAfterFailure.brief?.revision).toBe(1);
    expect(readAfterFailure.history?.length ?? 0).toBe(0);

    // 重试成功且只产生一个版本；状态是 DRAFT，不继承旧批准
    const retry = await generateProductBrief(input);
    expect(retry.brief.revision).toBe(2);
    expect(retry.brief.status).toBe("DRAFT");
    expect((await generateProductBrief(input)).replayed).toBe(true);
    await expect(generateProductBrief({ ...input, resetDerivedFields: true })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
    const afterRetry = await readProductBrief({ context, taskId });
    expect(afterRetry.brief?.revision).toBe(2);
    expect(afterRetry.history?.map((item) => item.revision)).toEqual([1]);

    // 再读一次不会重复追加
    const stable = await readProductBrief({ context, taskId });
    expect(stable.history?.map((item) => item.revision)).toEqual([1]);
  });

  it("旧生成调用不能绕开已有需求单的预览", async () => {
    await generateProductBrief({ context, taskId });
    await expect(generateProductBrief({ context, taskId })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_PREVIEW_REQUIRED" });
    expect((await readProductBrief({ context, taskId })).brief?.revision).toBe(1);
  });

  it("首次创建成功后同键重试返回同一版本，改动请求内容被拒绝", async () => {
    const first = await generateProductBrief({ context, taskId, idempotencyKey: "initial-create" });
    const replay = await generateProductBrief({ context, taskId, idempotencyKey: "initial-create" });
    expect(first.brief.revision).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.brief.revision).toBe(1);
    await expect(generateProductBrief({ context, taskId, idempotencyKey: "initial-create", resetDerivedFields: true })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
    expect((await readProductBrief({ context, taskId })).history).toHaveLength(0);
  });

  it("C｜保存幂等：同键同内容重试不产生第二个版本", async () => {
    await generateProductBrief({ context, taskId });
    const patch = { targetUser: { text: "同键保存的人工输入", nature: "ASSUMPTION" as const, evidenceRefs: [] }, status: "READY" as const };
    const first = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-1" });
    expect(first.brief.revision).toBe(2);
    expect(first.replayed).toBe(false);

    const retry = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-1" });
    expect(retry.replayed).toBe(true);
    expect(retry.brief.revision).toBe(2);
    expect(retry.brief.targetUser?.text).toBe("同键保存的人工输入");

    const read = await readProductBrief({ context, taskId });
    expect(read.brief?.revision).toBe(2);
    expect(read.history?.map((item) => item.revision)).toEqual([1]);
  });

  it("C｜保存幂等：同键改内容被精确拒绝，不静默复用旧回执", async () => {
    await generateProductBrief({ context, taskId });
    const patch = { targetUser: { text: "第一次内容", nature: "ASSUMPTION" as const, evidenceRefs: [] }, status: "READY" as const };
    await saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-2" });
    await expect(saveProductBrief({
      context,
      taskId,
      expectedRevision: 1,
      patch: { ...patch, targetUser: { text: "改了内容", nature: "ASSUMPTION", evidenceRefs: [] } } as never,
      idempotencyKey: "save-2",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
    const read = await readProductBrief({ context, taskId });
    expect(read.brief?.revision).toBe(2);
    expect(read.brief?.targetUser?.text).toBe("第一次内容");
  });

  it("C｜保存落盘失败后同键重试：失败不假报成功，重试只成功一次", async () => {
    await generateProductBrief({ context, taskId });
    const before = await currentRow();
    const patch = { targetUser: { text: "故障后重试", nature: "ASSUMPTION" as const, evidenceRefs: [] }, status: "DRAFT" as const };
    state.mode = "throw";
    await expect(saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-3" })).rejects.toThrow(/SQLITE_IOERR/);
    state.mode = "ok";
    expect((await currentRow()).raw).toBe(before.raw);

    const retry = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-3" });
    expect(retry.brief.revision).toBe(2);
    expect(retry.replayed).toBe(false);
    const replay = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: patch as never, idempotencyKey: "save-3" });
    expect(replay.replayed).toBe(true);
    expect(replay.brief.revision).toBe(2);
    expect((await readProductBrief({ context, taskId })).history?.map((item) => item.revision)).toEqual([1]);
  });

  it("权威报告切换后：旧人工决定不能创建或更新 Brief，且不落任何记录", async () => {
    // 权威从旧报告切到新报告：detail.stale=true（DECISION_BINDING_CHANGED），
    // 旧决定绑定的是旧 hash，新权威 hash 不同。
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 2,
      stale: true,
      staleReason: "DECISION_BINDING_CHANGED",
      asin: "B0FAULTTEST",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED", bindingHashes: { reportHash: "old-report-hash", factHash: "fact-hash-1", evidenceHash: "ev-hash-1", researchRevision: 1 } },
      reportResolution: { status: "current", source: "v5", reportHash: "new-report-hash", generatedAt: null, researchRevision: 2, otherPresent: true, reason: "pointer_match", candidates: [] },
      reportHash: "new-report-hash",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: { schema: "research-report.v5", summary: "新报告摘要", opportunities: [], risks: [], vocAnalysis: { painPoints: [], failureModes: [], useCases: [] }, narrativeBindings: [] },
    });
    const beforeJson = state.rows.get(taskId)!.resultJson;
    const beforeUpdatedAt = state.rows.get(taskId)!.updatedAt.getTime();
    const beforeWrites = state.updateCalls;

    await expect(generateProductBrief({ context, taskId })).rejects.toMatchObject({ code: "RESEARCH_EVIDENCE_STALE" });
    await expect(saveProductBrief({ context, taskId, expectedRevision: 1, patch: { status: "DRAFT", targetUser: null } })).rejects.toMatchObject({ code: "RESEARCH_EVIDENCE_STALE" });

    // 拒绝路径不得写库：内容、更新时间、写入次数都不变
    expect(state.rows.get(taskId)!.resultJson).toBe(beforeJson);
    expect(state.rows.get(taskId)!.updatedAt.getTime()).toBe(beforeUpdatedAt);
    expect(state.updateCalls).toBe(beforeWrites);
  });
});


describe("证据审查消费门禁与人工草稿保护", () => {
  beforeEach(seed);
  const overclaim = "月购买量估算600件，说明已有稳定成交，值得开发。";
  function blockedAudit() {
    return auditResearchClaims({ summary: overclaim, opportunities: [], risks: [], painPoints: [], salesGrade: "ESTIMATED", reviewBase: null });
  }
  it.each(["BLOCKED", "UNAVAILABLE"] as const)("%s审查禁止新建需求单且不写入", async (verdict) => {
    const detail = await state.detail();
    const claimAudit = verdict === "BLOCKED" ? blockedAudit() : makeUnavailableClaimAudit("隔离读取失败");
    state.detail.mockResolvedValue({ ...detail, claimAudit });
    const before = await currentRow();
    const writes = state.updateCalls;
    await expect(generateProductBrief({ context, taskId })).rejects.toMatchObject({
      code: verdict === "BLOCKED" ? "RESEARCH_CLAIMS_BLOCKED" : "RESEARCH_CLAIM_AUDIT_UNAVAILABLE", status: 409,
    });
    expect((await currentRow()).raw).toBe(before.raw);
    expect(state.updateCalls).toBe(writes);
  });
  it.each(["BLOCKED", "UNAVAILABLE"] as const)("%s保留旧原文与人工draft，禁止批准，read→Markdown不泄漏越级句", async (verdict) => {
    await generateProductBrief({ context, taskId });
    const saved = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: {
      status: "DRAFT", targetUser: { text: "人工草稿保留：" + overclaim, nature: "ASSUMPTION", evidenceRefs: [] },
    } });
    expect(saved.brief.revision).toBe(2);
    const detail = await state.detail();
    const originalReport = { ...detail.report, summary: overclaim };
    const originalText = JSON.stringify(originalReport);
    const claimAudit = verdict === "BLOCKED" ? blockedAudit() : makeUnavailableClaimAudit("隔离审查失败");
    state.detail.mockResolvedValue({ ...detail, report: originalReport, claimAudit });
    const beforeApproval = await currentRow();
    const writes = state.updateCalls;
    await expect(saveProductBrief({ context, taskId, expectedRevision: 2, patch: { status: "APPROVED", targetUser: null } })).rejects.toMatchObject({
      code: verdict === "BLOCKED" ? "RESEARCH_CLAIMS_BLOCKED" : "RESEARCH_CLAIM_AUDIT_UNAVAILABLE", status: 409,
    });
    expect((await currentRow()).raw).toBe(beforeApproval.raw);
    expect(state.updateCalls).toBe(writes);
    const read = await readProductBrief({ context, taskId });
    expect(read.claimAudit).toEqual(claimAudit);
    expect(read.brief).toEqual({ ...saved.brief, claimAudit });
    expect(read.brief?.targetUser?.text).toBe("人工草稿保留：" + overclaim);
    expect(JSON.stringify((await state.detail()).report)).toBe(originalText);
    const markdown = buildBriefMarkdown(read.brief!);
    expect(markdown).toContain("暂停采信");
    expect(markdown).not.toContain(overclaim);
    expect(markdown).not.toContain("人工草稿保留：");
    expect((await currentRow()).raw).toBe(beforeApproval.raw); // read/export纯投影，不写回审查元数据
    const draft = await saveProductBrief({ context, taskId, expectedRevision: 2, patch: {
      status: "DRAFT", targetUser: { text: "人工继续编辑，等待补证", nature: "ASSUMPTION", evidenceRefs: [] },
    } });
    expect(draft.brief.revision).toBe(3);
    expect(draft.brief.targetUser?.text).toBe("人工继续编辑，等待补证");
    expect(JSON.stringify((await state.detail()).report)).toBe(originalText);
  });

  it("规格内容变化或新增行自报引用时，服务端清除旧引用并降级", async () => {
    state.bundle.mockResolvedValue({
      productFact: {
        sourceProof: { evidenceId: "ev-spec-1" },
        basic: {
          title: { status: "present", value: "硅胶烘焙垫" },
          price: { status: "present", value: { amount: 19.99, currency: "USD" } },
        },
        profit: {},
        extended: { material: { status: "present", value: "304 不锈钢" } },
      },
    });
    await generateProductBrief({ context, taskId });
    const generated = await readProductBrief({ context, taskId });
    const spec = generated.brief?.specifications?.find((row) => row.id === "spec_material");
    expect(spec?.evidenceRefs.length).toBeGreaterThan(0);
    expect(spec?.nature).toBe("FACT");

    const saved = await saveProductBrief({
      context,
      taskId,
      expectedRevision: generated.brief!.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        specifications: [{ ...spec!, value: "201 不锈钢", nature: "FACT", verification: "verified", evidenceRefs: ["evidence:forged"] }],
      },
    });
    const changed = saved.brief.specifications?.find((row) => row.id === "spec_material");
    expect(changed?.value).toBe("201 不锈钢");
    expect(changed?.evidenceRefs).toEqual([]);
    expect(changed?.nature).toBe("ASSUMPTION");
    expect(changed?.verification).toBe("unverified");

    const added = await saveProductBrief({
      context,
      taskId,
      expectedRevision: saved.brief.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        specifications: [
          ...(saved.brief.specifications ?? []),
          { id: "spec_forged", label: "新规格", value: "自报事实", unit: null, nature: "FACT", verification: "verified", evidenceRefs: ["evidence:forged"] },
        ],
      },
    });
    const forged = added.brief.specifications?.find((row) => row.id === "spec_forged");
    expect(forged?.evidenceRefs).toEqual([]);
    expect(forged?.nature).toBe("ASSUMPTION");
    expect(forged?.verification).toBe("unverified");
  });

  it("内容未变时服务端只信任已存规格与对照记录；客户端伪造引用或 FACT 被忽略", async () => {
    state.bundle.mockResolvedValue({
      productFact: {
        sourceProof: { evidenceId: "ev-spec-1" },
        basic: {
          title: { status: "present", value: "硅胶烘焙垫" },
          price: { status: "present", value: { amount: 19.99, currency: "USD" } },
        },
        profit: {},
        extended: { material: { status: "present", value: "304 不锈钢" } },
      },
    });
    await generateProductBrief({ context, taskId });
    const generated = await readProductBrief({ context, taskId });
    const spec = generated.brief?.specifications?.find((row) => row.id === "spec_material");
    expect(spec?.evidenceRefs.length).toBeGreaterThan(0);
    expect(spec?.nature).toBe("FACT");
    expect(spec?.verification).toBe("unverified");

    const trustedSpec = await saveProductBrief({
      context,
      taskId,
      expectedRevision: generated.brief!.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        specifications: [{ ...spec!, evidenceRefs: ["evidence:forged"], nature: "FACT", verification: "verified" }],
      },
    });
    const unchangedSpec = trustedSpec.brief.specifications?.find((row) => row.id === "spec_material");
    expect(unchangedSpec?.evidenceRefs).toEqual(spec?.evidenceRefs);
    expect(unchangedSpec?.nature).toBe("FACT");
    expect(unchangedSpec?.verification).toBe("unverified");

    const sourceComparison = generated.brief?.benchmarkComparison?.rows.find((row) => row.id === "cmp_price");
    expect(sourceComparison?.note?.startsWith(SOURCE_COMPARISON_NOTE_PREFIX)).toBe(true);
    const trustedComparison = await saveProductBrief({
      context,
      taskId,
      expectedRevision: trustedSpec.brief.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        benchmarkComparison: { rows: [{ ...sourceComparison!, nature: "FACT", note: "伪造来源" }] },
      },
    });
    const unchangedComparison = trustedComparison.brief.benchmarkComparison?.rows.find((row) => row.id === "cmp_price");
    expect(unchangedComparison?.nature).toBe("ASSUMPTION");
    expect(unchangedComparison?.note?.startsWith(SOURCE_COMPARISON_NOTE_PREFIX)).toBe(true);

    const changedComparison = await saveProductBrief({
      context,
      taskId,
      expectedRevision: trustedComparison.brief.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        benchmarkComparison: { rows: [{ ...sourceComparison!, ours: "8.00 USD", nature: "FACT", note: "伪造来源" }] },
      },
    });
    const humanComparison = changedComparison.brief.benchmarkComparison?.rows.find((row) => row.id === "cmp_price");
    expect(humanComparison?.nature).toBe("ASSUMPTION");
    expect(humanComparison?.note).toBe(HUMAN_COMPARISON_NOTE);
    expect(humanComparison?.ours).toBe("8.00 USD");

    const addedComparison = await saveProductBrief({
      context,
      taskId,
      expectedRevision: changedComparison.brief.revision,
      patch: {
        status: "DRAFT",
        targetUser: null,
        benchmarkComparison: {
          rows: [
            ...(changedComparison.brief.benchmarkComparison?.rows ?? []),
            { id: "cmp_forged", label: "伪造对照", ours: "1", theirs: "2", nature: "FACT", note: `${SOURCE_COMPARISON_NOTE_PREFIX} FAKE` },
          ],
        },
      },
    });
    const forgedComparison = addedComparison.brief.benchmarkComparison?.rows.find((row) => row.id === "cmp_forged");
    expect(forgedComparison?.nature).toBe("ASSUMPTION");
    expect(forgedComparison?.note).toBe(HUMAN_COMPARISON_NOTE);

    const after = await readProductBrief({ context, taskId });
    expect(after.history.length).toBeGreaterThanOrEqual(4);
  });
});
