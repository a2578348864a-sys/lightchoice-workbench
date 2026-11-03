import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessContext } from "@/lib/server/accessPassword";
import { generateProductBrief, previewProductBrief, readProductBrief, saveProductBrief } from "./productBriefService";

const state = vi.hoisted(() => {
  const detail = vi.fn();
  const resolveDetail = detail.mockResolvedValue.bind(detail);
  // 真实 getResearchDetail 始终包含 claimAudit；旧测试替身需补上一致审查结果，
  // 否则会被生产 P5 采信门禁正确拦截。
  detail.mockResolvedValue = ((value: unknown) => resolveDetail({
    claimAudit: { schema: "research-claim-audit.v1", verdict: "CONSISTENT" },
    ...(value as Record<string, unknown>),
  })) as typeof detail.mockResolvedValue;
  return {
    rows: new Map<string, {
      id: string;
      type: string;
      resultJson: string;
      updatedAt: Date;
      decisionStatus: string;
    }>(),
    detail,
    bundle: vi.fn(),
    voc: vi.fn(),
    marketScanFindUnique: vi.fn(async () => null),
    findUnique: vi.fn(),
  };
});

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
        row.resultJson = args.data.resultJson;
        row.updatedAt = args.data.updatedAt;
        if (args.data.decisionStatus !== undefined) row.decisionStatus = args.data.decisionStatus;
        return { count: 1 };
      }),
    },
    marketScan: { findUnique: state.marketScanFindUnique },
  },
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

describe("P3-01-A / P3-02 / P3-03: 研报生产形状兼容与人工编辑保留", () => {
  const context: AccessContext = { mode: "owner", token: "test-token" };
  const taskId = "task-p301a-test";

  beforeEach(() => {
    state.rows.clear();
    state.findUnique.mockImplementation(defaultFindUnique);
    state.rows.set(taskId, {
      id: taskId,
      type: "workflow",
      resultJson: JSON.stringify({}),
      updatedAt: new Date("2026-10-28T00:00:00.000Z"),
      decisionStatus: "PROCEED",
    });

    state.bundle.mockResolvedValue({
      productFact: {
        sourceProof: { evidenceId: "ev-101" },
        basic: {
          title: { status: "present", value: "硅胶烘焙垫" },
          price: { status: "present", value: { amount: 19.99, currency: "USD" } },
        },
        profit: {},
        extended: {},
      },
    });

    state.voc.mockResolvedValue(null);
  });

  it("竞品事实售价不自动变成开发目标售价", async () => {
    state.detail.mockResolvedValue({ taskId, researchRevision: 1, stale: false, asin: "B0TESTSAMPLE", marketplace: "US", myChoice: { canonicalStatus: "PROCEED" }, reportHash: "report", factHash: "fact", evidenceHash: "evidence", unitEconomics: { sellingPrice: { amountUsd: 19.99, nature: "CONFIRMED_REFERENCE", source: "amazon" }, costLines: [{ key: "commission", amountUsd: 3 }] }, report: { summary: "研究摘要", opportunities: [], risks: [], vocAnalysis: { painPoints: [], failureModes: [], useCases: [] } } });
    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.economics.targetPrice).toBeNull();
    expect(result.brief.economics.referralFee).toBeNull();
    expect(result.brief.economics.provenance?.targetPrice?.origin).toBe("MISSING");
    expect(result.brief.missingValidation.some((item) => item.includes("竞品售价仅供参考"))).toBe(true);
    expect(result.brief.benchmarkComparison?.rows.find((row) => row.id === "cmp_price")).toMatchObject({ ours: null, theirs: "19.99 USD", nature: "ASSUMPTION" });
    expect(result.brief.benchmarkComparison?.rows.find((row) => row.id === "cmp_price")?.note).toContain("B0TESTSAMPLE");
  });

  it("P3-01-A: 生产研报为字符串数组加 narrativeBindings 时，summary/opportunities/risks 均被正确映射", async () => {
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-string-producer",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      unitEconomics: {
        schema: "unit-economics-view.v1",
        status: "available",
        currency: "USD",
        computedAt: "2026-10-28T00:00:00.000Z",
        isPartialCostBasis: true,
        excludedCosts: [],
        conditionalExcludedCosts: [],
        alwaysExcludedCosts: [],
        commissionIncluded: true,
        freightBasis: "per_unit",
        chargeableWeightKg: 0.5,
        sellingPrice: { key: "selling_price", label: "销售价格", amountUsd: 22.99, nature: "USER_INPUT", source: "user", effectiveDate: null, state: "available", note: null },
        costLines: [
          { key: "referral_fee", label: "平台佣金", amountUsd: 3.45, nature: "CONFIRMED_REFERENCE", source: "amazon", effectiveDate: null, state: "available", note: null },
          { key: "first_leg_freight", label: "头程物流", amountUsd: 1.20, nature: "USER_INPUT", source: "user", effectiveDate: null, state: "available", note: null },
        ],
        totalUnitCostUsd: 4.65,
        metrics: [],
        inputProvenance: [],
        reasons: [],
        formulaNotes: [],
      },
      report: {
        schema: "research-report.v5",
        summary: "真实生产研报：本款硅胶垫受热均匀，但边缘防滑需要改进。",
        opportunities: [
          "增加边缘凸起阻水结构",
          "升级耐温边界到260度",
        ],
        risks: [
          "耐温材料变更可能增加模具成本",
        ],
        vocAnalysis: {
          painPoints: [
            { text: "清洗时容易从大理石台面滑脱", evidenceRefs: ["evidence:review-1", "evidence:review-2"] },
          ],
          failureModes: [],
          useCases: [],
        },
        narrativeBindings: [
          { field: "summary", text: "真实生产研报：本款硅胶垫受热均匀，但边缘防滑需要改进。", evidenceRefs: ["evidence:sum-1"] },
          { field: "opportunities[0]", text: "增加边缘凸起阻水结构", evidenceRefs: ["evidence:opp-1"] },
          { field: "opportunities[1]", text: "升级耐温边界到260度", evidenceRefs: ["evidence:opp-2"] },
          { field: "risks[0]", text: "耐温材料变更可能增加模具成本", evidenceRefs: ["evidence:risk-1"] },
        ],
      },
    });

    const result = await generateProductBrief({ context, taskId });
    const brief = result.brief;

    // 1. 验证 summary 映射
    expect(brief.projectOverview).not.toBeNull();
    expect(brief.projectOverview?.text).toBe("真实生产研报：本款硅胶垫受热均匀，但边缘防滑需要改进。");
    expect(brief.projectOverview?.nature).toBe("EVIDENCE_DERIVED");
    expect(brief.projectOverview?.evidenceRefs).toContain("evidence:sum-1");

    // 2. 验证 opportunities 映射
    expect(brief.differentiation).toHaveLength(2);
    expect(brief.differentiation[0]?.text).toBe("增加边缘凸起阻水结构");
    expect(brief.differentiation[0]?.evidenceRefs).toContain("evidence:opp-1");
    expect(brief.differentiation[1]?.text).toBe("升级耐温边界到260度");

    // 3. 验证 risks 映射
    expect(brief.risks).toHaveLength(1);
    expect(brief.risks[0]?.text).toBe("耐温材料变更可能增加模具成本");
    expect(brief.risks[0]?.evidenceRefs).toContain("evidence:risk-1");

    // 4. 验证 rationale 由 summary 和前三条 opportunities 形成，非空
    expect(brief.rationale.length).toBeGreaterThanOrEqual(2);
    expect(brief.rationale[0]?.text).toContain("真实生产研报");

    // 5. P3-03 验证：03 的 unitEconomics 被顺利继承
    expect(brief.economics.targetPrice).toBe(22.99);
    expect(brief.economics.referralFee).toBe(3.45);
    expect(brief.economics.logistics).toBe(1.20);
    expect(brief.economics.provenance?.targetPrice).toMatchObject({ origin: "USER_INPUT", source: "user" });
    expect(brief.economics.provenance?.referralFee).toMatchObject({ origin: "PRODUCT_FACT", source: "amazon" });
    expect(brief.economics.provenance?.logistics).toMatchObject({ origin: "USER_INPUT", source: "user" });
    expect(brief.economics.provenance?.targetMarginPct?.origin).toBe("MISSING");
  });

  it("P3-01-A: 安全投影过滤/重排后只按唯一文本回退，重复文本无法确认时整条拒收", async () => {
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-filtered",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: "摘要",
        // 这是安全投影过滤掉原始 index=0 后的数组；绑定仍保留原始路径。
        opportunities: ["保留B", "保留A", "重复主张", "重复主张"],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [
          { field: "summary", text: "摘要", evidenceRefs: ["evidence:sum"] },
          { field: "opportunities[1]", text: "保留A", evidenceRefs: ["evidence:a"] },
          { field: "opportunities[2]", text: "保留B", evidenceRefs: ["evidence:b"] },
          // 两个当前同文项不能把同一条 binding 借给其中任意一项。
          { field: "opportunities[99]", text: "重复主张", evidenceRefs: ["evidence:ambiguous"] },
        ],
      },
    });

    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.differentiation.map((line) => line.text)).toEqual(["保留B", "保留A"]);
    expect(result.brief.differentiation.map((line) => line.evidenceRefs[0])).toEqual(["evidence:b", "evidence:a"]);
    expect(result.brief.differentiation.some((line) => line.text === "重复主张")).toBe(false);
  });

  it("P3-03: 真实单位经济性生产 key=commission 时仍继承到 Product Brief referralFee", async () => {
    state.rows.get(taskId)!.resultJson = JSON.stringify({ candidateAnalysisContext: { commercialInputs: { targetSellingPrice: { value: 41.99, currency: "USD" }, commissionRate: 0.15 } } });
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-production-commission-key",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      unitEconomics: {
        schema: "unit-economics-view.v1",
        status: "available",
        currency: "USD",
        computedAt: "2026-10-28T00:00:00.000Z",
        isPartialCostBasis: true,
        excludedCosts: [],
        conditionalExcludedCosts: [],
        alwaysExcludedCosts: [],
        commissionIncluded: true,
        freightBasis: "per_unit",
        chargeableWeightKg: null,
        sellingPrice: { key: "sellingPrice", label: "商品售价", amountUsd: 41.99, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
        costLines: [
          { key: "commission", label: "平台佣金", amountUsd: 6.2985, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
          { key: "shipping", label: "包装与头程成本", amountUsd: 2.5, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
        ],
        totalUnitCostUsd: 8.7985,
        metrics: [],
        inputProvenance: [],
        reasons: [],
        formulaNotes: [],
      },
      report: {
        schema: "research-report.v5",
        summary: "生产单位经济性佣金 key 兼容测试。",
        opportunities: [],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "生产单位经济性佣金 key 兼容测试。", evidenceRefs: ["evidence:summary"] }],
      },
    });

    const result = await generateProductBrief({ context, taskId });

    expect(result.brief.economics.targetPrice).toBe(41.99);
    expect(result.brief.economics.referralFee).toBe(6.2985);
    expect(result.brief.economics.logistics).toBe(2.5);
    expect(result.brief.economics.provenance?.referralFee).toMatchObject({ origin: "USER_INPUT", source: "candidateAnalysisContext.commercialInputs.commissionRate" });
    const revised = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: { targetPrice: 35, status: "READY", targetUser: null } });
    expect(revised.brief.economics.referralFee).toBeNull();
  });

  it("P3-03: 目标售价填写后重新生成，验证计划不再声称它缺失；仍缺失项与人工条目保留", async () => {
    const baseDetail = {
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-plan-v1",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        schema: "research-report.v5",
        summary: "验证计划清理测试。",
        opportunities: [],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "验证计划清理测试。", evidenceRefs: ["evidence:summary"] }],
      },
    };
    state.rows.get(taskId)!.resultJson = JSON.stringify({ candidateAnalysisContext: { commercialInputs: {} } });
    state.detail.mockResolvedValue(baseDetail);
    const first = await generateProductBrief({ context, taskId });
    const firstPlan = first.brief.verificationPlan ?? [];
    // 首次生成：目标售价与毛利率都缺失 → 两条自动待办
    expect(firstPlan.some((item) => item.item.includes("目标售价尚未由人工填写"))).toBe(true);
    expect(firstPlan.some((item) => item.item.includes("目标毛利率尚未由人工填写"))).toBe(true);

    // 人工只填目标售价，并额外加一条自有验证条目
    const manualItem = { id: "m_owner_1", item: "供应商打样对比", method: "Owner 已安排", timing: "样品阶段", status: "in_progress" as const };
    const saved = await saveProductBrief({
      context, taskId, expectedRevision: first.brief.revision,
      patch: {
        targetPrice: 29.99, targetMarginPct: null, status: "DRAFT", targetUser: null,
        verificationPlan: [...firstPlan, manualItem],
      },
    });
    expect(saved.brief.economics.targetPrice).toBe(29.99);

    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({
      context, taskId,
      previewRevision: preview.current?.revision ?? saved.brief.revision,
      previewSourceBinding: preview.next.sourceBinding,
    });
    const plan = regenerated.brief.verificationPlan ?? [];
    // 已填写的条件不再出现在验证计划里（否则文档自相矛盾）
    expect(plan.some((item) => item.item.includes("目标售价尚未由人工填写"))).toBe(false);
    // 仍然缺失的条件保留
    expect(plan.some((item) => item.item.includes("目标毛利率尚未由人工填写"))).toBe(true);
    // 人工新增条目原样保留
    expect(plan.some((item) => item.id === "m_owner_1" && item.method === "Owner 已安排")).toBe(true);
  });

  it("P3-03: 商业输入变化后重新生成，派生经济性值按当前来源重算，不沿用旧金额", async () => {
    const ueView = (price: number, rate: number, shipping: number) => ({
      schema: "unit-economics-view.v1",
      status: "available",
      currency: "USD",
      computedAt: "2026-10-28T00:00:00.000Z",
      isPartialCostBasis: true,
      excludedCosts: [],
      conditionalExcludedCosts: [],
      alwaysExcludedCosts: [],
      commissionIncluded: true,
      freightBasis: "per_unit",
      chargeableWeightKg: null,
      sellingPrice: { key: "sellingPrice", label: "商品售价", amountUsd: price, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
      costLines: [
        { key: "commission", label: "平台佣金", amountUsd: price * rate, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
        { key: "shipping", label: "包装与头程成本", amountUsd: shipping, nature: "USER_INPUT", source: "commercial-inputs", effectiveDate: null, state: "available", note: null },
      ],
      totalUnitCostUsd: price * rate + shipping,
      metrics: [],
      inputProvenance: [],
      reasons: [],
      formulaNotes: [],
    });
    const baseDetail = {
      taskId,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        schema: "research-report.v5",
        summary: "商业输入版本一致性测试。",
        opportunities: [],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "商业输入版本一致性测试。", evidenceRefs: ["evidence:summary"] }],
      },
    };

    // 第一版：售价 41.99 / 佣金率 0.15 / 物流 2.5
    state.rows.get(taskId)!.resultJson = JSON.stringify({
      candidateAnalysisContext: { commercialInputs: { targetSellingPrice: { value: 41.99, currency: "USD" }, commissionRate: 0.15, logisticsCost: { value: 2.5, currency: "USD" } } },
    });
    state.detail.mockResolvedValue({ ...baseDetail, researchRevision: 1, stale: false, reportHash: "rep-p303-v1", unitEconomics: ueView(41.99, 0.15, 2.5) });
    const first = await generateProductBrief({ context, taskId });
    expect(first.brief.economics.targetPrice).toBe(41.99);
    expect(first.brief.economics.referralFee).toBeCloseTo(6.2985, 4);
    expect(first.brief.economics.logistics).toBe(2.5);

    // 人工填一项（毛利率）——跨重新生成必须保留
    const manual = await saveProductBrief({ context, taskId, expectedRevision: first.brief.revision, patch: { targetMarginPct: 30, status: "DRAFT", targetUser: null } });
    expect(manual.brief.economics.targetMarginPct).toBe(30);

    // 第二版：商业输入整体变化（售价 50 / 佣金率 0.30 / 物流 3.2），研究已重新确认
    state.rows.get(taskId)!.resultJson = JSON.stringify({
      ...JSON.parse(state.rows.get(taskId)!.resultJson),
      candidateAnalysisContext: { commercialInputs: { targetSellingPrice: { value: 50, currency: "USD" }, commissionRate: 0.3, logisticsCost: { value: 3.2, currency: "USD" } } },
    });
    state.detail.mockResolvedValue({ ...baseDetail, researchRevision: 2, stale: false, reportHash: "rep-p303-v2", unitEconomics: ueView(50, 0.3, 3.2) });
    // P3-02 合同：已有需求单的重新生成必须先预览再携带版本与来源绑定确认
    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({
      context, taskId,
      previewRevision: preview.current?.revision ?? manual.brief.revision,
      previewSourceBinding: preview.next.sourceBinding,
    });

    // 派生值必须按当前输入重算，不能沿用上一版的 41.99 / 6.30 / 2.5
    expect(regenerated.brief.economics.targetPrice).toBe(50);
    expect(regenerated.brief.economics.referralFee).toBeCloseTo(15, 4);
    expect(regenerated.brief.economics.logistics).toBe(3.2);
    // 人工值保留
    expect(regenerated.brief.economics.targetMarginPct).toBe(30);
    // 来源标注必须仍指向当前来源，且不是「人工填写」
    expect(regenerated.brief.economics.provenance?.referralFee).toMatchObject({ origin: "USER_INPUT", source: "candidateAnalysisContext.commercialInputs.commissionRate" });
    expect(regenerated.brief.economics.provenance?.targetPrice?.origin).toBe("USER_INPUT");
    expect(regenerated.brief.economics.provenance?.targetMarginPct).toMatchObject({ source: "product-brief-owner" });
  });

  it("P3-03: 单位经济性成本行不完整时，从同任务商业输入安全兜底佣金与物流", async () => {
    state.rows.get(taskId)!.resultJson = JSON.stringify({
      candidateAnalysisContext: {
        commercialInputs: {
          targetSellingPrice: { value: 41.99, currency: "USD" },
          commissionRate: 0.15,
          logisticsCost: { value: 2.5, currency: "USD" },
        },
      },
    });
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-commercial-fallback",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      unitEconomics: {
        schema: "unit-economics-view.v1",
        status: "not_computable",
        currency: "USD",
        sellingPrice: { key: "sellingPrice", label: "商品售价", amountUsd: 41.99, nature: "USER_INPUT", source: "user_input", effectiveDate: null, state: "available", note: null },
        costLines: [],
      },
      report: {
        schema: "research-report.v5",
        summary: "商业输入成本行不完整兜底测试。",
        opportunities: [],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "商业输入成本行不完整兜底测试。", evidenceRefs: ["evidence:summary"] }],
      },
    });

    const result = await generateProductBrief({ context, taskId });

    expect(result.brief.economics.targetPrice).toBe(41.99);
    expect(result.brief.economics.referralFee).toBe(6.3);
    expect(result.brief.economics.logistics).toBe(2.5);
    expect(result.brief.economics.provenance?.referralFee).toMatchObject({
      origin: "USER_INPUT",
      source: "candidateAnalysisContext.commercialInputs.commissionRate",
    });
    expect(result.brief.economics.provenance?.logistics).toMatchObject({
      origin: "USER_INPUT",
      source: "candidateAnalysisContext.commercialInputs.logisticsCost",
    });
    const changed = await saveProductBrief({ context, taskId, expectedRevision: 1, patch: { targetPrice: 39.99, status: "READY", targetUser: null } });
    expect(changed.brief.economics.referralFee).toBeNull();
    expect(changed.brief.economics.provenance?.referralFee).toMatchObject({ origin: "MISSING", source: "product-brief-derived-price-changed" });
    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding });
    expect(regenerated.brief.economics.targetPrice).toBe(39.99);
    expect(regenerated.brief.economics.referralFee).toBeNull();
    const manual = await saveProductBrief({ context, taskId, expectedRevision: regenerated.brief.revision, patch: { targetPrice: 35, referralFee: 5, status: "READY", targetUser: null } });
    expect(manual.brief.economics.referralFee).toBe(5);
    expect(manual.brief.economics.provenance?.referralFee?.source).toBe("product-brief-owner");
  });

  it("P3-01-A: 合法历史对象可读；当前主体之外的对象引用不会被带入 Brief", async () => {
    state.bundle.mockResolvedValueOnce({
      productFact: {
        sourceProof: { evidenceId: "ev-101" },
        basic: {
          title: { status: "present", value: "硅胶烘焙垫" },
          price: { status: "present", value: { amount: 19.99, currency: "USD" } },
        },
        profit: {},
        extended: {},
      },
      sourceEvidenceRefs: [{ refId: "evidence:allowed" }],
    });
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-legacy-object",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: { text: "历史对象摘要", evidenceRefs: ["evidence:allowed"] },
        opportunities: [{ text: "历史对象机会", evidenceRefs: ["evidence:allowed"] }],
        risks: [{ text: "污染风险", evidenceRefs: ["evidence:allowed", "evidence:foreign"] }],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
      },
    });

    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.projectOverview?.text).toBe("历史对象摘要");
    expect(result.brief.differentiation[0]?.evidenceRefs).toEqual(["evidence:allowed"]);
    expect(result.brief.risks).toEqual([]);
  });

  it("P3-02: 用户明确清空的可编辑数组在来源更新后仍保持为空，不被自动补回", async () => {
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-empty-1",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: "初版研报",
        opportunities: ["方向A"],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "初版研报", evidenceRefs: ["ev:1"] }],
      },
    });
    const first = await generateProductBrief({ context, taskId });
    await saveProductBrief({
      context,
      taskId,
      expectedRevision: first.brief.revision,
      patch: {
        status: "READY",
        targetUser: null,
        specifications: [],
        confirmationItems: [],
        benchmarkComparison: { rows: [] },
        verificationPlan: [],
      },
    });

    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 2,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-empty-2",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: "更新研报",
        opportunities: ["方向B"],
        risks: [],
        vocAnalysis: { painPoints: [], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "更新研报", evidenceRefs: ["ev:1"] }],
      },
    });
    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding });
    expect(regenerated.brief.specifications).toEqual([]);
    expect(regenerated.brief.confirmationItems).toEqual([]);
    expect(regenerated.brief.benchmarkComparison).toEqual({ rows: [] });
    expect(regenerated.brief.verificationPlan).toEqual([]);
  });

  it("P3-02: 重新生成 Brief 时，用户先前填写的规格方向与确认项被保留，不被清空", async () => {
    // 第一次生成
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 1,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-1",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: "初版研报",
        opportunities: ["方向A"],
        risks: [],
        vocAnalysis: { painPoints: [{ text: "痛点1", evidenceRefs: ["ev:1"] }], failureModes: [], useCases: [] },
        narrativeBindings: [{ field: "summary", text: "初版研报", evidenceRefs: ["ev:1"] }],
      },
    });

    const first = await generateProductBrief({ context, taskId });
    expect(first.brief.revision).toBe(1);

    // 用户编辑并保存了需求单
    await saveProductBrief({
      context,
      taskId,
      expectedRevision: 1,
      patch: {
        status: "READY",
        targetUser: { text: "家庭烘焙进阶爱好者", nature: "ASSUMPTION", evidenceRefs: [] },
        targetMarginPct: 30,
        specifications: [
          { id: "custom_spec_1", label: "加厚边缘厚度", value: "1.2", unit: "mm", nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] },
        ],
        confirmationItems: [
          { id: "custom_cfq_1", item: "询问工厂食品级认证 FDA/LFGB", status: "待确认", reason: "出口合规必要" },
        ],
      },
    });

    // 来源更新（例如研报升级为 revision 2）
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 2,
      stale: false,
      asin: "B0TESTSAMPLE",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportHash: "rep-hash-2",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: {
        summary: "更新版研报：发现了耐磨问题",
        opportunities: ["方向A", "方向B"],
        risks: [],
        vocAnalysis: { painPoints: [{ text: "痛点1", evidenceRefs: ["ev:1"] }], failureModes: [], useCases: [] },
        narrativeBindings: [
          { field: "summary", text: "更新版研报：发现了耐磨问题", evidenceRefs: ["ev:1"] },
          { field: "opportunities[0]", text: "方向A", evidenceRefs: ["ev:1"] },
          { field: "opportunities[1]", text: "方向B", evidenceRefs: ["ev:1"] },
        ],
      },
    });

    // 重新生成 Brief
    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding });
    expect(regenerated.brief.revision).toBe(3); // 1 -> 2 (save) -> 3 (regenerate)

    // 验证用户人工填写的内容完整保留
    expect(regenerated.brief.targetUser?.text).toBe("家庭烘焙进阶爱好者");
    expect(regenerated.brief.specifications?.some((s) => s.id === "custom_spec_1")).toBe(true);
    expect(regenerated.brief.confirmationItems?.some((c) => c.id === "custom_cfq_1")).toBe(true);
    expect(regenerated.brief.economics.targetMarginPct).toBe(30);
    expect(regenerated.brief.economics.provenance?.targetMarginPct).toMatchObject({ origin: "USER_INPUT", source: "product-brief-owner" });

    // 验证研报更新的新内容也成功并入
    expect(regenerated.brief.projectOverview?.text).toBe("更新版研报：发现了耐磨问题");
    expect(regenerated.brief.differentiation).toHaveLength(2);
  });

  it.each(["CONFIRMED_SOURCE_MISATTRIBUTION", "SELECTIVE_REVIEW_INTERPRETATION", "NON_DISCRIMINATING_COUNTEREVIDENCE"])("P3-01-B：Brief 保留研究结构，审查意见 %s 不升级为事实", async (reviewCode) => {
    state.bundle.mockResolvedValue({
      productFact: {
        sourceProof: { evidenceId: "ev-101" },
        basic: {
          title: { status: "present", value: "硅胶烘焙垫" },
          price: { status: "present", value: { amount: 19.99, currency: "USD" } },
        },
        profit: {},
        extended: {},
      },
      sourceEvidenceRefs: [
        { refId: "evidence:v1-summary" },
        { refId: "evidence:v1-voc" },
        { refId: "evidence:v1-comp" },
        { refId: "evidence:v1-risk" },
      ],
    });
    const ref = (refId: string) => ({ refId });
    state.rows.get(taskId)!.resultJson = JSON.stringify({
      // P2-04 权威指针：该任务两份报告并存，但本轮明确 V1 才是当前正式报告（D 情形）。
      researchCurrentReport: { source: "v1", reportHash: "v1-report-hash", generatedAt: "2026-10-28T00:00:00.000Z", researchRevision: null },
      researchReport: {
        reportJson: {
          schema: "research-report.v1",
          taskId,
          candidateId: "candidate-p301b",
          runId: "run-p301b",
          subjectKey: "subject:p301b",
          generatedAt: "2026-10-28T00:00:00.000Z",
          generationStatus: "completed",
          node: "synthesize_research",
          executiveSummary: { analysis: { text: "V1 研究摘要", evidenceRefs: [ref("evidence:v1-summary")] }, keyPoints: [] },
          marketOpportunity: { facts: {}, analysis: { text: "购买价值需要验证", evidenceRefs: [ref("evidence:v1-summary")] } },
          competitionInsight: {
            analysis: { text: "竞品因包装限制没有解决边缘防滑", evidenceRefs: [ref("evidence:v1-comp")] },
            differentiationSuggestions: [{ text: "增加边缘凸起结构", evidenceRefs: [ref("evidence:v1-comp")], semanticReview: { status: "hypothesis", reasons: ["方案成本未验证"] } }],
            causalHypotheses: [{ text: "竞品受包装体积约束而没有改良", evidenceRefs: [ref("evidence:v1-comp")] }],
            causalInvestigations: [{ hypothesis: { text: "可能是结构问题", evidenceRefs: [ref("evidence:v1-comp")] }, supportingEvidence: [{ text: "支持线索", evidenceRefs: [ref("evidence:v1-voc")] }], counterevidence: [{ text: "反证线索", evidenceRefs: [ref("evidence:v1-comp")] }], unknowns: ["原因未知"], confidence: "low", verification: ["对照测试"] }],
            alternatives: [{ text: "保留现状作为对照组", evidenceRefs: [ref("evidence:v1-comp")] }],
            supportingEvidence: [{ text: "多条评论提到边缘滑脱", evidenceRefs: [ref("evidence:v1-voc")] }],
            counterevidence: [{ text: "高温下改良可能失效", evidenceRefs: [ref("evidence:v1-comp")] }],
            verificationItems: [{ text: "做两周对照测试，滑脱率不降则停止", evidenceRefs: [ref("evidence:v1-comp")] }],
          },
          vocAnalysis: {
            analysis: { text: "买家在台面操作时遇到滑脱", evidenceRefs: [ref("evidence:v1-voc")] },
            painPoints: [{ text: "台面操作时容易滑脱", evidenceRefs: [ref("evidence:v1-voc")] }],
          },
          unitEconomics: { facts: {}, deterministic: {}, analysis: { text: null, evidenceRefs: [] } },
          supplyChain: { facts: {}, analysis: { text: null, evidenceRefs: [] } },
          riskAssessment: {
            analysis: { text: "改良会增加包装体积", evidenceRefs: [ref("evidence:v1-risk")] },
            risks: [{ text: "物流成本可能上升", evidenceRefs: [ref("evidence:v1-risk")] }],
            verificationItems: [{ text: "核对包装体积和物流费，超上限则暂停", evidenceRefs: [ref("evidence:v1-risk")] }],
          },
          citationIndex: [],
          unverifiedAssumptions: [{ text: "尚未验证用户是否愿意为改良支付更高价格", evidenceRefs: [] }],
          ai: { provider: "deepseek", status: "completed", errorCode: null },
          decisionSummary: {},
        },
        reportHash: "v1-report-hash",
        generatedAt: "2026-10-28T00:00:00.000Z",
      },
    });
    const reviewedRoot = JSON.parse(state.rows.get(taskId)!.resultJson);
    const reviewedReport = reviewedRoot.researchReport.reportJson;
    const reviewedCounter = reviewedReport.competitionInsight.causalInvestigations[0].counterevidence[0];
    reviewedCounter.evidenceRefs[0].contentHash = "c".repeat(64);
    reviewedRoot.researchReport.reviewFindings = [{ code: reviewCode, reportHash: "v1-report-hash",
      taskId, subjectKey: reviewedReport.subjectKey, runId: reviewedReport.runId,
      fieldPath: "competitionInsight.causalInvestigations[0].counterevidence[0]", originalText: reviewedCounter.text,
      message: "隔离夹具：评论解释或归属需复核", auditArtifactHash: "b".repeat(64),
      evidenceBindings: [{ refId: "evidence:v1-comp", contentHash: "c".repeat(64) }] }];
    state.rows.get(taskId)!.resultJson = JSON.stringify(reviewedRoot);
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 7,
      stale: false,
      asin: "B0TESTSAMPLE",
      title: "硅胶烘焙垫",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      // 旧 v5 报告仍存在；但权威指针声明 V1 是当前报告，因此 Brief 必须消费 V1。
      reportResolution: {
        status: "current", source: "v1", reportHash: "v1-report-hash", generatedAt: "2026-10-28T00:00:00.000Z",
        researchRevision: null, otherPresent: true, reason: "pointer_match", candidates: [],
      },
      reportHash: "legacy-report-hash",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: { summary: "旧摘要", opportunities: ["旧方向"], risks: [], vocAnalysis: { painPoints: [], failureModes: [], useCases: [] } },
    });

    const result = await generateProductBrief({ context, taskId });
    expect(result.brief.sourceBinding.reportHash).toBe("v1-report-hash");
    expect(result.brief.projectOverview?.text).toBe("V1 研究摘要");
    expect(result.brief.corePainPoints[0]?.text).toBe("台面操作时容易滑脱");
    expect(result.brief.differentiation[0]!.nature).toBe("ASSUMPTION");
    expect(result.brief.differentiation[0]!.text).toContain("待验证假设");
    expect(result.brief.competitiveHypotheses?.[0]?.text).toContain("包装体积约束");
    expect(result.brief.researchAlternatives?.[0]?.text).toContain("保留现状");
    expect(result.brief.supportingEvidence?.[0]?.evidenceRefs).toEqual(["evidence:v1-voc"]);
    expect(result.brief.counterevidence?.[0]?.text).toContain("高温");
    expect(result.brief.causalInvestigations?.[0]).toMatchObject({ hypothesis: { nature: "ASSUMPTION" }, supportingEvidence: [{ text: "支持线索" }], counterevidence: [{ nature: "ASSUMPTION" }], unknowns: ["原因未知"], confidence: "low", verification: ["对照测试"] });
    expect(result.brief.causalInvestigations?.[0]?.hypothesis.text).toContain("可能是结构问题");
    expect(result.brief.causalInvestigations?.[0]?.counterevidence[0]?.text).toContain(reviewCode);
    expect(result.brief.risks[0]?.text).toBe("物流成本可能上升");
    expect(result.brief.researchAssumptions?.[0]?.nature).toBe("ASSUMPTION");
    expect(result.brief.verificationPlan?.some((item) => item.item.includes("两周对照测试"))).toBe(true);
    expect(result.brief.verificationPlan?.some((item) => item.item.includes("包装体积和物流费"))).toBe(true);
    expect(result.brief.missingValidation.some((item) => item.includes("用户是否愿意"))).toBe(true);

    await saveProductBrief({
      context,
      taskId,
      expectedRevision: result.brief.revision,
      patch: {
        status: "READY",
        targetUser: { text: "家庭烘焙进阶爱好者", nature: "ASSUMPTION", evidenceRefs: [] },
        specifications: [{ id: "custom-spec", label: "边缘厚度", value: "1.2", unit: "mm", nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] }],
      },
    });
    const nextRoot = JSON.parse(state.rows.get(taskId)!.resultJson) as Record<string, any>;
    nextRoot.researchReport.reportHash = "v1-report-hash-2";
    // 重新生成后权威指针同步指向新的 V1 报告。
    nextRoot.researchCurrentReport = { source: "v1", reportHash: "v1-report-hash-2", generatedAt: "2026-10-28T01:00:00.000Z", researchRevision: null };
    nextRoot.researchReport.reportJson.competitionInsight.alternatives = [{ text: "缩小到高频场景", evidenceRefs: [ref("evidence:v1-comp")] }];
    nextRoot.researchReport.reportJson.competitionInsight.verificationItems = [{ text: "先测高频场景，失败即停止", evidenceRefs: [ref("evidence:v1-comp")] }];
    state.rows.get(taskId)!.resultJson = JSON.stringify(nextRoot);
    state.detail.mockResolvedValue({
      taskId,
      researchRevision: 8,
      stale: false,
      asin: "B0TESTSAMPLE",
      title: "硅胶烘焙垫",
      marketplace: "US",
      myChoice: { canonicalStatus: "PROCEED" },
      reportResolution: {
        status: "current", source: "v1", reportHash: "v1-report-hash-2", generatedAt: "2026-10-28T01:00:00.000Z",
        researchRevision: null, otherPresent: true, reason: "pointer_match", candidates: [],
      },
      reportHash: "legacy-report-hash-2",
      factHash: "fact-hash-1",
      evidenceHash: "ev-hash-1",
      report: { summary: "旧摘要 2", opportunities: ["旧方向 2"], risks: [], vocAnalysis: { painPoints: [], failureModes: [], useCases: [] } },
    });
    const preview = await previewProductBrief({ context, taskId });
    const regenerated = await generateProductBrief({ context, taskId, previewRevision: preview.current!.revision, previewSourceBinding: preview.next.sourceBinding });
    expect(regenerated.brief.revision).toBe(3);
    expect(regenerated.brief.sourceBinding.reportHash).toBe("v1-report-hash-2");
    expect(regenerated.brief.targetUser?.text).toBe("家庭烘焙进阶爱好者");
    expect(regenerated.brief.specifications?.some((item) => item.id === "custom-spec")).toBe(true);
    expect(regenerated.brief.researchAlternatives?.[0]?.text).toBe("缩小到高频场景");
  });
});
