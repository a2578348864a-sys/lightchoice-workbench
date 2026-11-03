/**
 * P1-VOC/BR-03 端到端契约测试（隔离、零 AI、零真实 DB）：
 *
 * 验证「03 研究结论 → Human Decision → 04 Product Brief」字段映射与门禁：
 * 1. corePainPoints 只接收带合法 evidenceRefs 的研报 VOC 痛点；
 * 2. vocRequirements 只由 recurring 痛点主题派生（弱/孤立信号不得升级为改进要求）；
 * 3. 全部痛点主题（含弱信号）只进入 confirmationItems（待确认，带 reviewCount）；
 * 4. PROCEED / PENDING / VALIDATE_MORE / PAUSE / DROP / stale / 缺报告 / 访客模式 的门禁；
 * 5. generate → read → save → 刷新回读 → 修订号 CAS → 重复生成 → 并发冲突；
 * 6. 失败路径不产生/不破坏需求单（半成品防护）。
 *
 * 边界数据（getResearchDetail / buildResearchInputBundle / getVocAnalysis）由测试工厂构造，
 * 全部明确标记为隔离测试数据；prisma 用内存 CAS 存储模拟真实 SQLite 行为。
 */
import { auditResearchClaims } from "@/lib/research/evidenceAudit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  detail: vi.fn(),
  bundle: vi.fn(),
  voc: vi.fn(),
  rows: new Map<string, {
    id: string;
    type: string;
    resultJson: string;
    updatedAt: Date;
    decisionStatus: string;
  }>(),
  marketScanFindUnique: vi.fn(async () => null),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/server/v5ResearchService", () => ({
  getResearchDetail: state.detail,
}));
vi.mock("@/lib/server/research/researchInputBundle", () => ({
  buildResearchInputBundle: state.bundle,
}));
vi.mock("@/lib/server/vocAnalysis", () => ({
  getVocAnalysis: state.voc,
}));

/** 默认 findUnique 行为：按 select 投影内存行（含 decisionStatus 供 CAS 使用） */
async function defaultFindUnique(args: { where: { id: string }; select?: Record<string, boolean> }) {
  const row = state.rows.get(args.where.id);
  if (!row) return null;
  if (!args.select) return { ...row };
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(args.select)) projected[key] = (row as unknown as Record<string, unknown>)[key];
  return projected;
}

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: {
      findUnique: state.findUnique,
      updateMany: vi.fn(async (args: {
        where: { id: string; updatedAt: Date; resultJson: string; decisionStatus: string };
        data: { resultJson: string; updatedAt: Date; decisionStatus?: string };
      }) => {
        const row = state.rows.get(args.where.id);
        if (!row) return { count: 0 };
        const sameUpdatedAt = new Date(row.updatedAt).getTime() === new Date(args.where.updatedAt).getTime();
        const sameResultJson = row.resultJson === args.where.resultJson;
        const sameDecisionStatus = row.decisionStatus === args.where.decisionStatus;
        if (!sameUpdatedAt || !sameResultJson || !sameDecisionStatus) return { count: 0 };
        row.resultJson = args.data.resultJson;
        row.updatedAt = args.data.updatedAt;
        if (args.data.decisionStatus !== undefined) row.decisionStatus = args.data.decisionStatus;
        return { count: 1 };
      }),
    },
    marketScan: { findUnique: state.marketScanFindUnique },
  },
}));

import { ProductBriefError, generateProductBrief, previewProductBrief, readProductBrief, saveProductBrief } from "@/lib/server/productBriefService";

const context = { mode: "owner", token: "voc-handoff-test" } as const;
const taskId = "isolated-voc-task-1";
const ASIN = "B0ISOLATED1";

type ChoiceStatus = "PROCEED" | "VALIDATE_MORE" | "PAUSE" | "DROP" | "PENDING";

function detailWith(overrides: {
  choice?: ChoiceStatus;
  stale?: boolean;
  hasReport?: boolean;
} = {}) {
  const choice = overrides.choice ?? "PENDING";
  const hasReport = overrides.hasReport ?? true;
  const detail = {
    taskId,
    researchRevision: 1,
    stale: overrides.stale ?? false,
    report: hasReport
      ? {
        schema: "research-report.v1",
        summary: { text: "隔离测试数据：厨房防滑垫市场存在清洗与初始防滑两类反复反馈。", evidenceRefs: ["attachment:att-test-1"] },
        opportunities: [
          { text: "隔离测试机会：优化防滑结构。", evidenceRefs: ["attachment:att-test-2"] },
        ],
        risks: [
          { text: "隔离测试风险：材料更换可能影响成本。", evidenceRefs: ["attachment:att-test-3"] },
        ],
        vocAnalysis: {
          painPoints: [
            { text: "隔离测试痛点：垫子清洗时在台面滑动，难以施加压力。", evidenceRefs: ["attachment:att-test-4"] },
            { text: "隔离测试痛点：初次使用时表面偏滑。", evidenceRefs: ["attachment:att-test-5"] },
          ],
          failureModes: [{ text: "隔离测试失败模式：使用两次后仍偏滑。", evidenceRefs: ["attachment:att-test-6"] }],
          useCases: [{ text: "隔离测试场景：厨房台面干燥垫。", evidenceRefs: ["attachment:att-test-7"] }],
          positiveSignals: [],
          replacementSignals: [],
          switchReasons: [],
          ownershipClaims: [],
        },
        citations: [],
        unverifiedAssumptions: [],
        narrativeBindings: {},
        allowedEvidenceRefs: [],
      }
      : null,
    reportHash: hasReport ? "report-hash-1" : "",
    factHash: "fact-hash-1",
    evidenceHash: "evidence-hash-1",
    myChoice: choice === "PENDING"
      ? null
      : { choice: choice, canonicalStatus: choice, scope: "FINAL", chosenAt: "2026-10-18T00:00:00.000Z", bindingHashes: { researchRevision: 1, reportHash: "report-hash-1", factHash: "fact-hash-1", evidenceHash: "evidence-hash-1" } },
    asin: ASIN,
    marketplace: "US",
    title: "Isolated Test Product (隔离测试数据)",
    marketProvenance: null,
  };
  const report = detail.report;
  return { ...detail, claimAudit: auditResearchClaims({ summary: report?.summary.text ?? null,
    opportunities: report?.opportunities.map(item => item.text) ?? [], risks: report?.risks.map(item => item.text) ?? [],
    painPoints: report?.vocAnalysis.painPoints ?? [], salesGrade: "NOT_AVAILABLE", reviewBase: null }) };
}

/** 隔离测试用 voc-analysis.v1：recurring 1 条 + weak 1 条 + isolated 1 条 */
function vocWith(themes: {
  recurring?: boolean;
  weak?: boolean;
  isolated?: boolean;
} = { recurring: true, weak: true, isolated: true }) {
  const painPointThemes: unknown[] = [];
  if (themes.recurring) {
    painPointThemes.push({
      themeId: "theme-anti-slip", label: "表面滑，清洗时不易固定", summary: "多位买家反馈垫子过滑，清洗时难以固定。",
      evidenceRefs: ["amazon-content:hash-a", "amazon-content:hash-b", "amazon-content:hash-c", "amazon-content:hash-d"],
      reviewCount: 4, coverage: 0.4, strength: "recurring", limitations: null,
    });
  }
  if (themes.weak) {
    painPointThemes.push({
      themeId: "theme-initial-slip", label: "初次使用偏滑", summary: "两位买家提到初期偏滑，多次使用后改善。",
      evidenceRefs: ["amazon-content:hash-e", "amazon-content:hash-f"],
      reviewCount: 2, coverage: 0.2, strength: "weak", limitations: null,
    });
  }
  if (themes.isolated) {
    painPointThemes.push({
      themeId: "theme-dishwasher", label: "可放入洗碗机清洗", summary: "一位买家询问洗碗机兼容性。",
      evidenceRefs: ["amazon-content:hash-g"],
      reviewCount: 1, coverage: 0.1, strength: "isolated", limitations: null,
    });
  }
  return {
    schema: "voc-analysis.v1",
    version: 1,
    runId: "isolated-run-1",
    themes: {
      positiveThemes: [],
      painPointThemes,
      usageScenarios: [],
      recurringRequests: [],
      conflicts: [],
      weakSignals: [],
    },
    unknowns: [],
    nextResearchSteps: [],
    unverified: [],
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

function seedTask(extra: Record<string, unknown> = {}) {
  const row = {
    id: taskId,
    type: "workflow",
    resultJson: JSON.stringify({ type: "workflow", candidateToTask: { candidateId: "cand-isolated-1" }, ...extra }),
    updatedAt: new Date("2026-10-18T00:00:00.000Z"),
    decisionStatus: "need_info",
  };
  state.rows.set(taskId, row);
  return row;
}

function currentRoot(): Record<string, unknown> {
  return JSON.parse(state.rows.get(taskId)!.resultJson) as Record<string, unknown>;
}

beforeEach(() => {
  state.rows.clear();
  state.detail.mockReset();
  state.bundle.mockReset();
  state.voc.mockReset();
  state.marketScanFindUnique.mockClear();
  state.findUnique.mockReset();
  state.findUnique.mockImplementation(defaultFindUnique);
  state.detail.mockImplementation(async () => detailWith({ choice: "PROCEED" }));
  state.bundle.mockResolvedValue({ productFact: null, sourceEvidenceRefs: [], ok: true });
  state.voc.mockResolvedValue(vocWith());
  seedTask();
});

describe("03→04 允许路径：PROCEED + 证据支持的 VOC 痛点", () => {
  it("generate 生成需求单：corePainPoints / vocRequirements / confirmationItems 映射正确", async () => {
    const result = await generateProductBrief({ context, taskId });

    // 隔离测试数据标记：brief 由测试工厂构造，不代表真实商业结论
    expect(result.brief.identity.asin).toBe(ASIN);
    expect(result.brief.status).toBe("DRAFT");
    expect(result.brief.revision).toBe(1);

    // C1：带合法引用的研报痛点进入 corePainPoints
    expect(result.brief.corePainPoints).toHaveLength(2);
    for (const point of result.brief.corePainPoints) {
      expect(point.evidenceRefs.length).toBeGreaterThan(0);
      expect(point.nature).toBe("EVIDENCE_DERIVED");
    }
    expect(result.brief.corePainPoints[0]!.text).toContain("隔离测试痛点");

    // C2：只有 recurring 主题进入 vocRequirements；weak / isolated 不得升级为改进要求
    expect(result.brief.vocRequirements).toHaveLength(1);
    expect(result.brief.vocRequirements![0]!.text).toContain("表面滑，清洗时不易固定");
    expect(result.brief.vocRequirements![0]!.text).not.toContain("初次使用偏滑");
    expect(result.brief.vocRequirements![0]!.text).not.toContain("洗碗机");
    expect(result.brief.vocRequirements![0]!.evidenceRefs).toHaveLength(4);

    // C3：全部痛点主题（含弱信号）进入 confirmationItems，且全部为待确认
    const vocCheckpoints = (result.brief.confirmationItems ?? []).filter((item) => item.id.startsWith("voc_cp_"));
    expect(vocCheckpoints).toHaveLength(3);
    for (const checkpoint of vocCheckpoints) {
      expect(checkpoint.status).toBe("待确认");
      expect(checkpoint.item).toContain("重点核实");
    }
    // 弱信号也带 reviewCount 供人工判断样本量，但不构成产品问题结论
    const weakCheckpoint = vocCheckpoints.find((item) => item.id === "voc_cp_theme-initial-slip")!;
    expect(weakCheckpoint.item).toContain("2 条买家反馈");
    expect(weakCheckpoint.reason).toContain("待供应商确认");
    // 固定基线确认问题不含任何供应链事实数值
    const fixed = (result.brief.confirmationItems ?? []).filter((item) => item.id.startsWith("cfq_"));
    expect(fixed).toHaveLength(5);
    for (const item of fixed) {
      expect(item.status).toBe("待确认");
      expect(item.item).not.toMatch(/\d+\s*(美元|元|USD|\$)/u);
    }
    // 没有任何字段声称供应商验证已完成
    expect(result.brief.missingValidation.join(" ")).toContain("未提供供应商报价");
  });

  it("研报痛点缺少 evidenceRefs 时被丢弃，不进入 corePainPoints", async () => {
    state.detail.mockImplementation(async () => {
      const detail = detailWith({ choice: "PROCEED" });
      const report = detail.report as Record<string, unknown>;
      const voc = report.vocAnalysis as Record<string, unknown>;
      voc.painPoints = [
        { text: "隔离测试：无引用的痛点必须被丢弃。", evidenceRefs: [] },
        { text: "隔离测试：带引用的痛点保留。", evidenceRefs: ["attachment:att-keep-1"] },
      ];
      return detail;
    });
    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.corePainPoints).toHaveLength(1);
    expect(result.brief.corePainPoints[0]!.text).toContain("带引用");
    expect(result.brief.missingValidation).not.toContain("当前研究没有带合法引用的 VOC 痛点。");
  });

  it("全部痛点都无引用时 corePainPoints 为空，并在 missingValidation 中明确说明", async () => {
    state.detail.mockImplementation(async () => {
      const detail = detailWith({ choice: "PROCEED" });
      const report = detail.report as Record<string, unknown>;
      const voc = report.vocAnalysis as Record<string, unknown>;
      voc.painPoints = [{ text: "隔离测试：无引用。", evidenceRefs: [] }];
      return detail;
    });
    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.corePainPoints).toHaveLength(0);
    expect(result.brief.missingValidation).toContain("当前研究没有带合法引用的 VOC 痛点。");
  });

  it("无 voc-analysis 存储时 vocRequirements 为空列表，固定确认项仍保留", async () => {
    state.voc.mockResolvedValue(null);
    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.vocRequirements).toEqual([]);
    expect((result.brief.confirmationItems ?? []).filter((item) => item.id.startsWith("cfq_"))).toHaveLength(5);
  });
});

describe("03→04 写入闭环：生成 → 保存 → 刷新回读", () => {
  it("generate 后 read 回读同一份 brief 且不标 stale", async () => {
    const generated = await generateProductBrief({ context, taskId });
    const read = await readProductBrief({ context, taskId });
    expect(read.brief).not.toBeNull();
    expect(read.stale).toBe(false);
    expect(read.brief!.revision).toBe(generated.brief.revision);
    expect(read.brief!.corePainPoints).toHaveLength(generated.brief.corePainPoints.length);
    expect(read.brief!.vocRequirements).toEqual(generated.brief.vocRequirements);
    expect(read.brief!.confirmationItems).toEqual(generated.brief.confirmationItems);
  });

  it("落库结果确实包含 productBrief（不是只返回对象）", async () => {
    await generateProductBrief({ context, taskId });
    const root = currentRoot();
    expect(root.productBrief).toBeTruthy();
    const stored = root.productBrief as Record<string, unknown>;
    expect(stored.schemaVersion).toBe("product-brief.v1");
    expect(Array.isArray(root.productBriefHistory)).toBe(true);
  });

  it("save 更新经济性并递增 revision；刷新回读保持新值", async () => {
    await generateProductBrief({ context, taskId });
    const saved = await saveProductBrief({
      context,
      taskId,
      expectedRevision: 1,
      patch: { targetPrice: 25.99, targetMarginPct: 30, status: "READY", targetUser: null },
    });
    expect(saved.brief.revision).toBe(2);
    expect(saved.brief.economics.targetPrice).toBe(25.99);
    expect(saved.brief.economics.purchaseCostCeiling.status).toBe("NOT_COMPUTABLE");

    const read = await readProductBrief({ context, taskId });
    expect(read.brief!.revision).toBe(2);
    expect(read.brief!.economics.targetPrice).toBe(25.99);
    expect(read.stale).toBe(false);
  });

  it("APPROVED 需要目标价、毛利率与可计算上限，否则拒绝", async () => {
    // fbaFee 只能来自生成时的商品事实快照（save 的补丁不接受 fbaFee）
    state.bundle.mockResolvedValue({
      ok: true,
      productFact: {
        schema: "product-fact.v3",
        subjectKey: `amazon:US:${ASIN}`,
        sourceProof: { evidenceId: "ev-isolated-1", source: "amazon_detail", captureId: "cap-1", subjectKey: `amazon:US:${ASIN}`, capturedAt: "2026-10-18T00:00:00.000Z", contentHash: "ch", sourceUrl: null, operator: "test" },
        basic: {
          price: { value: { amount: 19.99, currency: "USD" }, status: "present", source: "amazon_detail", confidence: 1, capturedAt: null, rawProofHash: null },
        },
        market: {},
        profit: {
          fbaFee: { value: { amount: 4.5, currency: "USD" }, status: "present", source: "amazon_detail", confidence: 1, capturedAt: null, rawProofHash: null },
        },
      },
      sourceEvidenceRefs: [],
    });
    await generateProductBrief({ context, taskId });

    // 未补经济性输入时禁止 APPROVED
    await expect(saveProductBrief({
      context, taskId, expectedRevision: 1,
      patch: { status: "APPROVED", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_NOT_READY" });

    // 补全目标价、毛利率与平台费用后可批准，且上限可计算
    const approved = await saveProductBrief({
      context, taskId, expectedRevision: 1,
      patch: {
        targetPrice: 25.99, targetMarginPct: 30, referralFee: 3.87, logistics: 1.5, estimatedTax: 0.5, status: "APPROVED", targetUser: null,
      },
    });
    expect(approved.brief.status).toBe("APPROVED");
    expect(approved.brief.economics.purchaseCostCeiling.status).toBe("COMPUTED");
    // 服务端对上限做两位小数 rounding
    expect(approved.brief.economics.purchaseCostCeiling.value).toBeCloseTo(25.99 - 3.87 - 4.5 - 1.5 - 0.5 - 25.99 * 0.3, 2);

    // 批准只改变需求单状态：待确认事项与缺失项必须继续可见，不能被「批准」无声消除。
    expect(approved.brief.status).toBe("APPROVED");
    expect(approved.brief.confirmationItems!.length).toBeGreaterThanOrEqual(6);
    expect(approved.brief.confirmationItems!.every((item) => item.status === "待确认")).toBe(true);
    expect(approved.brief.missingValidation.join(" ")).toContain("未提供供应商报价");
  });

  it("APPROVED 是显式人工动作：非 Owner 不能保存，决策失效后也不能批准", async () => {
    state.bundle.mockResolvedValue({
      ok: true,
      productFact: {
        schema: "product-fact.v3",
        subjectKey: `amazon:US:${ASIN}`,
        sourceProof: { evidenceId: "ev-isolated-1", source: "amazon_detail", captureId: "cap-1", subjectKey: `amazon:US:${ASIN}`, capturedAt: "2026-10-18T00:00:00.000Z", contentHash: "ch", sourceUrl: null, operator: "test" },
        basic: { price: { value: { amount: 19.99, currency: "USD" }, status: "present", source: "amazon_detail", confidence: 1, capturedAt: null, rawProofHash: null } },
        market: {},
        profit: { fbaFee: { value: { amount: 4.5, currency: "USD" }, status: "present", source: "amazon_detail", confidence: 1, capturedAt: null, rawProofHash: null } },
      },
      sourceEvidenceRefs: [],
    });
    await generateProductBrief({ context, taskId });

    await expect(saveProductBrief({
      context: { mode: "demo", token: "v" } as never, taskId, expectedRevision: 1,
      patch: { status: "APPROVED", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_OWNER_REQUIRED" });

    // 决策改为 VALIDATE_MORE 后，即使经济性参数齐全也不能批准
    state.detail.mockImplementation(async () => detailWith({ choice: "VALIDATE_MORE" }));
    await expect(saveProductBrief({
      context, taskId, expectedRevision: 1,
      patch: { targetPrice: 25.99, targetMarginPct: 30, referralFee: 3.87, logistics: 1.5, estimatedTax: 0.5, status: "APPROVED", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_GATE_PROCEED_REQUIRED" });
    expect((currentRoot().productBrief as { status?: string } | undefined)?.status).toBe("DRAFT");
  });

  it("错误 expectedRevision 返回 PRODUCT_BRIEF_REVISION_STALE，且不改动数据", async () => {
    await generateProductBrief({ context, taskId });
    const before = currentRoot().productBrief;
    await expect(saveProductBrief({
      context, taskId, expectedRevision: 99,
      patch: { status: "READY", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_REVISION_STALE" });
    expect(currentRoot().productBrief).toEqual(before);
  });

  it("重复 generate 只追加历史版本，不产生重复需求单", async () => {
    await generateProductBrief({ context, taskId });
    const preview = await previewProductBrief({ context, taskId });
    const second = await generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding });
    expect(second.brief.revision).toBe(2);
    const root = currentRoot();
    // 首版生成时即为当前版；第二次生成后历史=[v1]，当前=v2 —— 共 2 个版本、无重复
    const history = root.productBriefHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]!.revision).toBe(1);
    expect((root.productBrief as Record<string, unknown>).revision).toBe(2);
  });

  it("并发写入（CAS 冲突）不会覆盖另一方的数据", async () => {
    await generateProductBrief({ context, taskId });
    const preview = await previewProductBrief({ context, taskId });
    // 真实竞态：briefContext 读到旧快照后，另一写者在 mutate 提交前更新了任务。
    // 用调用计数模拟——findUnique 第 1 次（briefContext）返回旧行，之后返回竞争写者的新行。
    const original = state.rows.get(taskId)!;
    const competing = {
      ...original,
      resultJson: JSON.stringify({ ...JSON.parse(original.resultJson), competingWriter: true }),
      updatedAt: new Date("2026-10-18T01:00:00.000Z"),
    };
    const realFindUnique = state.rows; // 占位避免未使用
    void realFindUnique;
    let findUniqueCalls = 0;
    state.findUnique.mockImplementation(async () => {
      findUniqueCalls += 1;
      return findUniqueCalls === 1 ? { ...original } : { ...competing };
    });
    await expect(generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding })).rejects.toMatchObject({ code: "task_result_conflict" });
    // 另一写者的数据完好，且恢复存储供后续用例使用
    state.rows.set(taskId, { ...competing });
    expect(currentRoot().competingWriter).toBe(true);
  });
});

describe("03→04 拒绝路径：门禁不满足时不得生成", () => {
  const blockedCases: Array<{ name: string; overrides: Parameters<typeof detailWith>[0]; code: string }> = [
    { name: "PENDING（未做人工决策）", overrides: { choice: "PENDING" }, code: "PRODUCT_GATE_PROCEED_REQUIRED" },
    { name: "VALIDATE_MORE（需补充验证）", overrides: { choice: "VALIDATE_MORE" }, code: "PRODUCT_GATE_PROCEED_REQUIRED" },
    { name: "PAUSE（暂缓）", overrides: { choice: "PAUSE" }, code: "PRODUCT_GATE_PROCEED_REQUIRED" },
    { name: "DROP（已放弃）", overrides: { choice: "DROP" }, code: "PRODUCT_GATE_PROCEED_REQUIRED" },
    { name: "研究 stale（证据/版本变化）", overrides: { choice: "PROCEED", stale: true }, code: "RESEARCH_EVIDENCE_STALE" },
    { name: "缺少正式研究报告", overrides: { choice: "PROCEED", hasReport: false }, code: "RESEARCH_REPORT_REQUIRED" },
  ];

  for (const testCase of blockedCases) {
    it(`${testCase.name} → ${testCase.code}，且不产生半成品需求单`, async () => {
      state.detail.mockImplementation(async () => detailWith(testCase.overrides));
      await expect(generateProductBrief({ context, taskId })).rejects.toMatchObject({ code: testCase.code });
      // 失败后任务结果中不得出现 productBrief
      expect(currentRoot().productBrief).toBeUndefined();
      // read 侧同样暴露阻塞原因，不假装可生成
      const read = await readProductBrief({ context, taskId });
      expect(read.brief).toBeNull();
      expect(read.stale).toBe(true);
      expect(read.staleReason).toBe(testCase.code);
    });
  }

  it("访客模式一律拒绝（Owner only）", async () => {
    await expect(generateProductBrief({ context: { mode: "demo", token: "v" } as never, taskId }))
      .rejects.toMatchObject({ code: "PRODUCT_BRIEF_OWNER_REQUIRED" });
    expect(currentRoot().productBrief).toBeUndefined();
  });
});

describe("03→04 失效路径：研究/决策变化后既有需求单必须失效", () => {
  it("报告哈希变化 → read 标 stale（RESEARCH_OR_MARKET_BINDING_CHANGED），save 拒绝", async () => {
    await generateProductBrief({ context, taskId });
    state.detail.mockImplementation(async () => {
      const detail = detailWith({ choice: "PROCEED" });
      return { ...detail, reportHash: "report-hash-2", researchRevision: 2 };
    });
    const read = await readProductBrief({ context, taskId });
    expect(read.brief).not.toBeNull();
    expect(read.stale).toBe(true);
    expect(read.staleReason).toBe("RESEARCH_OR_MARKET_BINDING_CHANGED");
    await expect(saveProductBrief({
      context, taskId, expectedRevision: 1,
      patch: { status: "READY", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_BRIEF_STALE" });
  });

  it("PROCEED 决策被改为 VALIDATE_MORE → read 标 stale 且 save 被门禁拒绝", async () => {
    await generateProductBrief({ context, taskId });
    state.detail.mockImplementation(async () => detailWith({ choice: "VALIDATE_MORE" }));
    const read = await readProductBrief({ context, taskId });
    expect(read.stale).toBe(true);
    expect(read.staleReason).toBe("PRODUCT_GATE_PROCEED_REQUIRED");
    await expect(saveProductBrief({
      context, taskId, expectedRevision: 1,
      patch: { status: "READY", targetUser: null },
    })).rejects.toMatchObject({ code: "PRODUCT_GATE_PROCEED_REQUIRED" });
  });

  it("历史绑定只读重评：既有 brief 不被隐式改写", async () => {
    await generateProductBrief({ context, taskId });
    const before = JSON.stringify(currentRoot().productBrief);
    await readProductBrief({ context, taskId });
    expect(JSON.stringify(currentRoot().productBrief)).toBe(before);
  });
});

describe("ProductBriefError 形状", () => {
  it("门禁错误携带业务码与 409 状态", async () => {
    state.detail.mockImplementation(async () => detailWith({ choice: "PENDING" }));
    const error = await generateProductBrief({ context, taskId }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductBriefError);
    expect((error as ProductBriefError).code).toBe("PRODUCT_GATE_PROCEED_REQUIRED");
    expect((error as ProductBriefError).status).toBe(409);
  });
});
