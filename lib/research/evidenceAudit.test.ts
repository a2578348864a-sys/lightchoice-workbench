import { describe, expect, it } from "vitest";
import { auditResearchClaims, salesAvailabilityFromMetrics, makeUnavailableClaimAudit } from "./evidenceAudit";

const salesDistribution = { mean: 300, median: 310, p25: 250, p75: 360, min: 100, max: 600, sampleSize: 34, missingCount: 0 };
const validSales = { status: "PRESENT", value: { total: 10200, ...salesDistribution, distribution: salesDistribution }, sampleSize: 34, missingCount: 0 };

const PAIN_SINGLE = [{ text: "有买家反馈产品非常薄（约 2-3 毫米）。", evidenceRefs: ["attachment:att-1"] }];
const PAIN_SHARED = [
  { text: "有买家反馈收到的产品实测为 47 英寸，短于宣传的 48 英寸。", evidenceRefs: ["attachment:att-1"] },
  { text: "有买家指出产品非常薄（约 2-3 毫米）。", evidenceRefs: ["attachment:att-1"] },
  { text: "有买家提醒该垫为柔软弹性材质，使用刀具可能损坏。", evidenceRefs: ["attachment:att-1"] },
];

describe("auditResearchClaims（结论强度审查）", () => {
  it("销量不可用时，用页面购买量推导『动销/现成需求』判为 BLOCKING", () => {
    const audit = auditResearchClaims({
      summary: "页面快照显示售价24.99美元、评分4.4、评论数502，近月购买量约600件。",
      opportunities: ["页面快照显示近月购买量约600件，说明已有稳定的成交与口碑基础，可作为切入细分市场的现成需求验证。"],
      risks: ["月销量/收入估算、FBA费用等字段均缺失，无法核算毛利与竞争位次。"],
      painPoints: PAIN_SHARED,
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 502,
    });
    expect(audit.verdict).toBe("BLOCKED");
    expect(audit.flags.some((flag) => flag.code === "ESTIMATE_AS_CONFIRMED" && flag.severity === "BLOCKING")).toBe(true);
    expect(audit.marketData.salesGrade).toBe("NOT_AVAILABLE");
    expect(audit.marketData.reviewBase).toBe(502);
    expect(audit.marketData.reviewRead).toBeNull(); // 该摘要没写读取条数
  });

  it("销量可用（CONFIRMED）时不误报成交类措辞", () => {
    const audit = auditResearchClaims({
      summary: "样本 34 款，销量字段可用。",
      opportunities: ["页面显示近月购买量约600件，说明该价位有稳定成交。"],
      risks: [],
      painPoints: [],
      salesGrade: "CONFIRMED",
      reviewBase: 502,
    });
    expect(audit.flags.filter((flag) => flag.code === "ESTIMATE_AS_CONFIRMED")).toHaveLength(0);
  });

  it("多条痛点共用同一引用时，报告『多条评论』判为 WARNING 并给出共享引用计数", () => {
    const audit = auditResearchClaims({
      summary: "该商品评论数502，公开可见的8条首页评论集中反馈厚度与尺寸问题。",
      opportunities: [],
      risks: ["多条评论指出产品非常薄，厚度预期落差可能带来负面评价。"],
      painPoints: PAIN_SHARED,
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 502,
    });
    expect(audit.marketData.reviewRead).toBe(8);
    expect(audit.marketData.painReferences).toEqual({ total: 3, unique: 1 });
    const flag = audit.flags.find((item) => item.code === "SINGLE_SOURCE_AS_MULTIPLE");
    expect(flag?.severity).toBe("WARNING");
    expect(flag?.suggested).toContain("8");
  });

  it("读取条数未知时使用总体性表述，判为 SAMPLE_AS_POPULATION", () => {
    const audit = auditResearchClaims({
      summary: "买家反馈集中在不粘、易清洁。",
      opportunities: [],
      risks: ["该类问题具有普遍性，代表多数买家体验。"],
      painPoints: PAIN_SINGLE,
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 975,
    });
    expect(audit.marketData.reviewReadSource).toBe("UNKNOWN");
    expect(audit.flags.some((flag) => flag.code === "SAMPLE_AS_POPULATION")).toBe(true);
  });

  it("少量评论中的局部抱怨被写成买家痛点时，不升级为普遍痛点", () => {
    const audit = auditResearchClaims({
      summary: "该商品累计1046条评价，当前报告基于少量可见评论。",
      opportunities: [],
      risks: ["买家反馈存在清洁与容量痛点，需在材质与容量沟通上做针对性优化。"],
      painPoints: [],
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 1046,
    });
    expect(audit.verdict).toBe("NEEDS_DOWNGRADE");
    const flag = audit.flags.find((item) => item.code === "SAMPLE_AS_POPULATION" && item.field === "risks");
    expect(flag?.severity).toBe("WARNING");
    expect(flag?.reason).toContain("不能把单条/少量评论概括为买家痛点");
  });

  it("明确写成单条/样本内观察时不误报为普遍痛点", () => {
    const audit = auditResearchClaims({
      summary: "读取的4条评论中有1条提到白色款饮水口染色，不能代表整体。",
      opportunities: [],
      risks: ["读取的4条评论中有1条提到白色款饮水口易染色，不能代表整体口碑。"],
      painPoints: [],
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 1046,
    });
    expect(audit.flags.some((flag) => flag.code === "SAMPLE_AS_POPULATION")).toBe(false);
  });

  it("属性描述（薄/软/尺寸）被写成用户问题时判为 PROPERTY_AS_DEFECT（WARNING，不阻断）", () => {
    const audit = auditResearchClaims({
      summary: "公开可见的8条评论。",
      opportunities: [],
      risks: [],
      painPoints: PAIN_SHARED,
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 502,
    });
    expect(audit.verdict).toBe("NEEDS_DOWNGRADE");
    // 「实测 47 英寸短于宣传 48 英寸」属缺陷主张（未达规格），不报属性误判；另两条是属性观察
    expect(audit.flags.filter((flag) => flag.code === "PROPERTY_AS_DEFECT")).toHaveLength(2);
    expect(audit.blockingCount).toBe(0);
  });

  it("没有越级表述时判 CONSISTENT", () => {
    const audit = auditResearchClaims({
      summary: "仅基于 2 条公开评论做有限研判。",
      opportunities: ["页面展示月购买量约300件，属页面估算，未经核实，仅作调查线索。"],
      risks: ["样本仅 2 条，不能代表真实口碑。"],
      painPoints: [{ text: "首次按压角落卡扣需要较大力度。", evidenceRefs: ["attachment:att-1"] }],
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 2,
    });
    expect(audit.verdict).toBe("CONSISTENT");
    expect(audit.flags).toHaveLength(0);
  });

  it("摘要里的读取条数会被解析为 REPORT_TEXT 来源，而不是当成独立事实", () => {
    const audit = auditResearchClaims({
      summary: "公开可见的8条首页评论集中反馈其防滑、耐热。",
      opportunities: [],
      risks: [],
      painPoints: [],
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 502,
    });
    expect(audit.marketData.reviewRead).toBe(8);
    expect(audit.marketData.reviewReadSource).toBe("REPORT_TEXT");
  });
});

describe("salesAvailabilityFromMetrics（销量输入合同）", () => {
  it("PRESENT + 分布对象 → ESTIMATED（不能当确认，也不能当不可用）", () => {
    const result = salesAvailabilityFromMetrics({
      sales: validSales,
    });
    expect(result.grade).toBe("ESTIMATED");
    expect(result.sampleSize).toBe(34);
    expect(result.note).toContain("monthlySalesEstimate");
  });

  it("PRESENT + 数字 → 仍是 ESTIMATED（来源是估算字段）", () => {
    expect(salesAvailabilityFromMetrics({ sales: { status: "present", value: 300, sampleSize: 3 } }).grade).toBe("ESTIMATED");
  });

  it("NOT_AVAILABLE / 空对象 / 异常结构 → NOT_AVAILABLE，且不当成 0", () => {
    expect(salesAvailabilityFromMetrics({ sales: { status: "NOT_AVAILABLE", value: null, sampleSize: 0, missingCount: 34 } }).grade).toBe("NOT_AVAILABLE");
    expect(salesAvailabilityFromMetrics({ sales: {} }).grade).toBe("NOT_AVAILABLE");
    expect(salesAvailabilityFromMetrics(null).grade).toBe("NOT_AVAILABLE");
    expect(salesAvailabilityFromMetrics({ sales: { status: "PRESENT", value: null } }).grade).toBe("NOT_AVAILABLE");
  });

  it("估算销量仍会阻断『估算→动销』结论，但不会误判为无数据", () => {
    const audit = auditResearchClaims({
      summary: "样本 34 款。",
      opportunities: ["页面显示近月购买量约300件，说明已有稳定成交，可作为现成需求验证。"],
      risks: [],
      painPoints: [],
      salesGrade: salesAvailabilityFromMetrics({ sales: validSales }).grade,
      reviewBase: 2,
    });
    expect(audit.verdict).toBe("BLOCKED");
    expect(audit.flags[0]?.reason).toContain("估算");
    expect(audit.marketData.salesGrade).toBe("ESTIMATED");
  });
});


describe("claim审查边界与失败保护", () => {
  const base = { summary: null, opportunities: [], risks: [], painPoints: [], salesGrade: "ESTIMATED" as const, reviewBase: null };
  it.each(["summary", "opportunities", "risks", "painPoints"] as const)("所有声明字段 %s 均拒绝估算升级", (field) => {
    const text = "页面月购买量约600件，说明已有稳定成交，值得开发。";
    const input = { ...base, [field]: field === "summary" ? text : field === "painPoints" ? [{ text, evidenceRefs: [] }] : [text] };
    const audit = auditResearchClaims(input);
    expect(audit.verdict).toBe("BLOCKED");
    expect(audit.flags.some((f) => f.field === field && f.code === "ESTIMATE_AS_CONFIRMED")).toBe(true);
  });
  it("风险否定语不应豁免摘要里的肯定结论", () => {
    const audit = auditResearchClaims({ ...base, summary: "销量足以证实稳定需求。", risks: ["销量缺失，不能确认需求。"] });
    expect(audit.verdict).toBe("BLOCKED");
    expect(audit.flags.some((f) => f.field === "summary")).toBe(true);
  });
  it("同段否定一句不能豁免后面独立肯定句", () => {
    expect(auditResearchClaims({ ...base, summary: "月销量未知。该商品已有稳定成交，值得开发。" }).verdict).toBe("BLOCKED");
  });
  it.each(["销量缺失，无法判断稳定需求。", "销量估算300，仅作线索，不能作为需求验证。", "是否已形成稳定成交还需要核实。", "尚未证实需求稳定，不建议据此立项。"])("否定/未知正常限定不误伤：%s", (summary) => {
    expect(auditResearchClaims({ ...base, summary }).verdict).toBe("CONSISTENT");
  });
  it("小样本总体主张在摘要同样为待复核，属性观察不硬阻断", () => {
    const audit = auditResearchClaims({ ...base, summary: "仅读取2条评论，该问题代表多数买家体验。", painPoints: PAIN_SINGLE });
    expect(audit.verdict).toBe("NEEDS_DOWNGRADE");
    expect(audit.blockingCount).toBe(0);
    expect(audit.flags.some((f) => f.field === "summary" && f.code === "SAMPLE_AS_POPULATION")).toBe(true);
  });
  it("审查失败明确UNAVAILABLE，不返回一致", () => {
    const unavailable = makeUnavailableClaimAudit("来源读取失败，不能继续采信");
    expect(unavailable.verdict).toBe("UNAVAILABLE");
    expect(unavailable.headline).toContain("读取失败");
    expect(unavailable.marketData.reviewRead).toBeNull();
  });
  it.each([NaN, Infinity, -1, {}, [], "300", { mean: 300 }, { ...validSales.value, distribution: {} }, { ...validSales.value, total: NaN }])("无效销量 %j 不当可用或补0", (value) => {
    expect(salesAvailabilityFromMetrics({ sales: { ...validSales, value } }).grade).toBe("NOT_AVAILABLE");
  });
  it("真实分布可用但始终ESTIMATED，合法旧零/数字也保留估算", () => {
    expect(salesAvailabilityFromMetrics({ sales: validSales }).grade).toBe("ESTIMATED");
    expect(salesAvailabilityFromMetrics({ sales: { status: "PRESENT", value: 0 } }).grade).toBe("ESTIMATED");
    expect(salesAvailabilityFromMetrics({ sales: { status: "PRESENT", value: 300 } }).grade).toBe("ESTIMATED");
    expect(salesAvailabilityFromMetrics({ sales: { ...validSales, sampleSize: -1 } }).sampleSize).toBeNull();
  });
});
