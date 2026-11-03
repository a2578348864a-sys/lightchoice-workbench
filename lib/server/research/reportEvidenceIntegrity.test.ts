import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BLOCK_SUPPRESSED_NOTICE,
  EVIDENCE_SUMMARY_SUPPRESSED_NOTICE,
  assessReportEvidenceIntegrity,
  sanitizeReportForConsumption,
} from "@/lib/server/research/reportEvidenceIntegrity";

/**
 * P0 证据可信度｜读侧安全投影回归
 *
 * 这些用例锁定的**唯一核心不变量**：
 * 引用证据白名单之外来源、且支撑范围不可知的**已持久化**陈述，
 * 不得继续作为有效研究结论输出；而独立合法字段必须原样保留。
 *
 * 夹具取材自 2026-10-15 Koolstuffs（B0CFTP6JR4 / 任务 cmv807ra30002gzsmq7al1vke）
 * 首次真实 DeepSeek 研报 rev 1 的真实持久化形态（report/verify 证据留档）。
 */

const ILLEGAL_REF = "attachment:att-61e7709290c34556c5cf7892";
const LEGAL_EVIDENCE = "evidence:ev-cap-889ba1d3-d179-48ff-991d-761bb2778f49-f9e14a2e69c2a32f";
const LEGAL_VOICE = "attachment:att-7f10031b63264e228d26a2ec";

const CONTAMINATED_SUMMARY =
  "Koolstuffs 硅胶烘焙垫（ASIN B0CFTP6JR4）页面显示售价 9.99 USD、评分 4.7。"
  + "该 ASIN 属于以 B0D34DNMCL 为父体的多变体家族，同系列还提供黑/橙/红等颜色及 4 张、6 张、椭圆+圆形等规格。";

/** 真实历史研报（rev 1）的审计文本，逐字来自持久化的 unverifiedAssumptions。 */
const KOONSTUFFS_AUDIT = [
  "缺失商品字段事实: 扩展事实·父ASIN",
  `未核实引用来源 [${ILLEGAL_REF}]: "2 Half Sheets & 1 Quarter Sheet"`,
  `summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
  `opportunities[3] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
  "opportunities[3] 缺少合法 citation 绑定，已移入未验证假设: 该 ASIN 隶属以 B0D34DNMCL 为父体的多变体家族。",
];

function koolstuffsLegacyReport() {
  return {
    schema: "research-report.v5",
    summary: CONTAMINATED_SUMMARY,
    opportunities: ["价格锚点清晰（9.99 USD / 3 张）", "替代烘焙纸的省钱减废叙事已被买家接受", "一垫多用场景扩展"],
    risks: ["关键商业字段大面积缺失", "评论基数极小（3 条）", "清洗打滑与二次清洗", "初始偏滑的预期落差", "样本仅公开置顶评论"],
    vocAnalysis: {
      painPoints: [{ text: "清洗困难：垫子过于柔软光滑", evidenceRefs: [LEGAL_VOICE] }],
      positiveSignals: [{ text: "不粘表现获认可", evidenceRefs: [LEGAL_VOICE] }],
      failureModes: [], useCases: [{ text: "每日制作酸面包", evidenceRefs: [LEGAL_VOICE] }],
      replacementSignals: [], switchReasons: [], ownershipClaims: [],
    },
    citations: [{ quote: "9.99", source: LEGAL_EVIDENCE, refId: LEGAL_EVIDENCE }],
    unverifiedAssumptions: KOONSTUFFS_AUDIT,
    narrativeBindings: [
      { field: "summary", text: CONTAMINATED_SUMMARY, evidenceRefs: [LEGAL_EVIDENCE, LEGAL_VOICE] },
      { field: "opportunities[0]", text: "价格锚点清晰（9.99 USD / 3 张）", evidenceRefs: [LEGAL_EVIDENCE] },
    ],
    allowedEvidenceRefs: [LEGAL_EVIDENCE, LEGAL_VOICE],
  };
}

describe("P0 证据可信度｜读侧安全投影", () => {
  it("干净研报：不做任何屏蔽，且原样返回同一对象（保证 reportHash 语义不变）", () => {
    const clean = {
      schema: "research-report.v5",
      summary: "证据充分的研究摘要",
      opportunities: ["机会 A"],
      risks: ["风险 A"],
      vocAnalysis: { painPoints: [{ text: "痛点", evidenceRefs: [LEGAL_VOICE] }], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "q", source: LEGAL_EVIDENCE, refId: LEGAL_EVIDENCE }],
      unverifiedAssumptions: ["缺失商品字段事实: 基础事实·品牌"],
      narrativeBindings: [{ field: "summary", text: "证据充分的研究摘要", evidenceRefs: [LEGAL_EVIDENCE] }],
      allowedEvidenceRefs: [LEGAL_EVIDENCE, LEGAL_VOICE],
    };
    const { report, integrity } = sanitizeReportForConsumption(clean);
    expect(integrity.suppressed).toBe(false);
    expect(integrity.contaminated).toBe(false);
    expect(integrity.notices).toEqual([]);
    // 同一引用：下游 hashJson(report) === 持久化 reportHash
    expect(report).toBe(clean);
  });

  it("历史污染研报：summary 整块暂停展示，合法机会点/风险/VOC 全部保留", () => {
    const report = koolstuffsLegacyReport();
    const { report: safe, integrity } = sanitizeReportForConsumption(report);

    expect(integrity.suppressed).toBe(true);
    expect(integrity.suppressedSummary).toBe(true);
    expect(integrity.notices).toContain(EVIDENCE_SUMMARY_SUPPRESSED_NOTICE);

    // 关键断言：失去支撑的肯定式事实不得再出现在**已验证结论面**上
    expect(safe.summary).toBeNull();
    const verifiedSurface = JSON.stringify({
      summary: safe.summary,
      opportunities: safe.opportunities,
      risks: safe.risks,
      vocAnalysis: safe.vocAnalysis,
      narrativeBindings: safe.narrativeBindings,
      citations: safe.citations,
    });
    expect(verifiedSurface).not.toContain("B0D34DNMCL");
    expect(verifiedSurface).not.toContain("2 Half Sheets & 1 Quarter Sheet");
    // 但拒收信息必须留在未验证/审计通道，供人工追溯（不得静默丢弃）
    expect((safe.unverifiedAssumptions as string[]).join("\n")).toContain("allowlist 外证据");

    // 不得误伤独立合法字段
    expect(safe.opportunities).toHaveLength(3);
    expect(safe.risks).toHaveLength(5);
    expect(safe.vocAnalysis.painPoints).toHaveLength(1);
    expect(safe.vocAnalysis.useCases).toHaveLength(1);
    expect(safe.allowedEvidenceRefs).toEqual([LEGAL_EVIDENCE, LEGAL_VOICE]);
    expect(safe.schema).toBe("research-report.v5");

    // 被剔除条目的绑定不得残留
    expect((safe.narrativeBindings as Array<{ field: string }>).some((b) => b.field === "summary")).toBe(false);
    expect((safe.narrativeBindings as Array<{ field: string }>).some((b) => b.field === "opportunities[0]")).toBe(true);

    // 审计信息必须可追溯：字段路径 + 非法引用 ID + 处理方式
    const claims = integrity.rejectedClaims;
    const summaryClaim = claims.find((claim) => claim.field === "summary");
    expect(summaryClaim).toBeDefined();
    expect(summaryClaim?.illegalRefs).toEqual([ILLEGAL_REF]);
    expect(summaryClaim?.disposition).toBe("retained_legacy_unsupported");
    const opportunityClaim = claims.find((claim) => claim.field === "opportunities[3]");
    expect(opportunityClaim?.disposition).toBe("rejected_whole_statement");

    // 原始持久化对象不得被就地修改
    expect(report.summary).toBe(CONTAMINATED_SUMMARY);
    const integrityEnvelope = (safe as unknown as { evidenceIntegrity: { rawReportUnchanged: boolean; notices: string[] } }).evidenceIntegrity;
    expect(integrityEnvelope.rawReportUnchanged).toBe(true);
    expect(integrityEnvelope.notices).toContain(EVIDENCE_SUMMARY_SUPPRESSED_NOTICE);
  });

  it("反例｜只有「已剔除」记录、没有任何保留污染时，不得无条件屏蔽研究内容", () => {
    const report = {
      schema: "research-report.v5",
      summary: "完全由合法证据支撑的摘要",
      opportunities: ["合法机会"],
      risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      unverifiedAssumptions: [
        `summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        "summary 缺少合法 citation 绑定，已移入未验证假设: 模型草稿里的越界摘要",
        `opportunities[1] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        "opportunities[1] 缺少合法 citation 绑定，已移入未验证假设: 模型草稿里的越界机会",
      ],
      allowedEvidenceRefs: [LEGAL_EVIDENCE],
    };
    const { report: safe, integrity } = sanitizeReportForConsumption(report);
    expect(integrity.suppressed).toBe(false);
    expect(integrity.contaminated).toBe(true); // 有拒收审计，但无需屏蔽
    expect(integrity.auditSummary).toContain("整条拒收");
    expect(safe).toBe(report);
    expect(safe.summary).toBe("完全由合法证据支撑的摘要");
  });

  it("数组条目混合引用：仅暂停受影响的那一条，其余独立条目保留", () => {
    const report = {
      schema: "research-report.v5",
      summary: "合法摘要",
      opportunities: ["合法机会 0", "受污染机会 1", "合法机会 2"],
      risks: ["合法风险 0"],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      // 草稿 opportunities[1] 同时声明了合法与非法引用 → 被绑定阶段保留 → 必须暂停
      unverifiedAssumptions: [`opportunities[1] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`],
      allowedEvidenceRefs: [LEGAL_EVIDENCE],
    };
    const { report: safe, integrity } = sanitizeReportForConsumption(report);
    expect(integrity.suppressedOpportunities).toEqual([1]);
    expect(integrity.suppressedSummary).toBe(false);
    expect(safe.opportunities).toEqual(["合法机会 0", "合法机会 2"]);
    expect(safe.risks).toEqual(["合法风险 0"]);
  });

  it("屏蔽结论后同步移除对应 narrativeBindings，保留其他合法绑定", () => {
    const report = {
      schema: "research-report.v5",
      summary: "受污染摘要",
      opportunities: ["合法机会", "被屏蔽机会"],
      risks: ["被屏蔽风险", "合法风险"],
      vocAnalysis: {
        painPoints: [{ text: "被屏蔽痛点" }, { text: "合法痛点" }],
        positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [],
      },
      unverifiedAssumptions: [
        `summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        `opportunities[1] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        `risks[0] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        `vocAnalysis.painPoints[0] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
      ],
      narrativeBindings: [
        { field: "summary", text: "受污染摘要", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "opportunities[0]", text: "合法机会", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "opportunities[1]", text: "被屏蔽机会", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "risks[0]", text: "被屏蔽风险", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "risks[1]", text: "合法风险", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "vocAnalysis.painPoints[0]", text: "被屏蔽痛点", evidenceRefs: [LEGAL_EVIDENCE] },
        { field: "vocAnalysis.painPoints[1]", text: "合法痛点", evidenceRefs: [LEGAL_EVIDENCE] },
      ],
      allowedEvidenceRefs: [LEGAL_EVIDENCE],
    };

    const { report: safe, integrity } = sanitizeReportForConsumption(report);

    expect(integrity.suppressed).toBe(true);
    expect(integrity.suppressedVoc).toEqual({ painPoints: [0] });
    expect(safe.narrativeBindings).toEqual([
      { field: "opportunities[0]", text: "合法机会", evidenceRefs: [LEGAL_EVIDENCE] },
      { field: "risks[0]", text: "合法风险", evidenceRefs: [LEGAL_EVIDENCE] },
      { field: "vocAnalysis.painPoints[0]", text: "合法痛点", evidenceRefs: [LEGAL_EVIDENCE] },
    ]);
  });

  it("下标映射不确定时：整块暂停展示该字段，而不是猜测句子", () => {
    const report = {
      schema: "research-report.v5",
      summary: "合法摘要",
      opportunities: ["合法机会 0"],
      risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      // 草稿 opportunities[4] 被保留（无「缺少合法 citation」记录），但持久化数组只有 1 条
      // → 无法确定句子级映射 → 必须整块暂停展示，不得猜
      unverifiedAssumptions: [`opportunities[4] 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`],
      allowedEvidenceRefs: [LEGAL_EVIDENCE],
    };
    const { report: safe, integrity } = sanitizeReportForConsumption(report);
    expect(integrity.suppressedWholeFields).toContain("opportunities");
    expect(integrity.notices).toContain(EVIDENCE_BLOCK_SUPPRESSED_NOTICE);
    expect(safe.opportunities).toEqual([]);
    expect(safe.summary).toBe("合法摘要"); // 其他字段不受影响
  });

  it("新研报：绑定阶段已整条拒收的陈述不触发二次屏蔽（保持 hash 与下游流程不变）", () => {
    const report = {
      schema: "research-report.v5",
      summary: null, // 写入阶段即整条拒收
      opportunities: ["合法机会"],
      risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      unverifiedAssumptions: [
        `summary 引用了 allowlist 外证据 [${ILLEGAL_REF}]，已 fail-closed。`,
        "summary 因引用白名单外证据整条拒收（不保留原文、不替换为其他合法引用）: 该 ASIN 属于以 B0D34DNMCL 为父体…",
      ],
      rejectedClaims: [{
        field: "summary",
        reason: "illegal_evidence_ref",
        illegalRefs: [ILLEGAL_REF],
        declaredRefs: [LEGAL_EVIDENCE, ILLEGAL_REF],
        disposition: "rejected_whole_statement",
        textPreview: "该 ASIN 属于以 B0D34DNMCL 为父体…",
      }],
      allowedEvidenceRefs: [LEGAL_EVIDENCE],
    };
    const { report: safe, integrity } = sanitizeReportForConsumption(report);
    expect(integrity.suppressed).toBe(false);
    expect(integrity.contaminated).toBe(true);
    expect(integrity.rejectedClaims).toHaveLength(1);
    expect(integrity.auditSummary).toContain("整条拒收");
    expect(safe).toBe(report);
    expect(safe.opportunities).toEqual(["合法机会"]);
  });

  it("空/非对象输入安全降级：不抛错、不误报", () => {
    for (const value of [null, undefined, 42, "text", []]) {
      const integrity = assessReportEvidenceIntegrity(value);
      expect(integrity.suppressed).toBe(false);
      expect(integrity.contaminated).toBe(false);
      expect(sanitizeReportForConsumption(value as never).report).toBe(value);
    }
  });
});

describe("sanitizeReportForConsumption · 结论强度越级（P5-v6）", () => {
  const REPORT = {
    summary: "该商品售价 24.99 美元。",
    opportunities: [
      "页面快照显示近月购买量约600件，说明已有稳定的成交与口碑基础，可作为现成需求验证。",
      "评论中反复出现可自行裁剪，说明尺寸矩阵是差异化方向。",
    ],
    risks: ["月销量/收入估算缺失，无法核算毛利。"],
    vocAnalysis: { painPoints: [] },
    narrativeBindings: [],
  };

  it("传入阻断句后，该句从消费投影中移除，其余内容保留", () => {
    const { report, integrity } = sanitizeReportForConsumption(REPORT, {
      strengthBlockedTexts: [REPORT.opportunities[0]],
    });
    expect(report.opportunities).toEqual([REPORT.opportunities[1]]);
    expect(integrity.suppressed).toBe(true);
    expect(integrity.strengthSuppressed?.opportunities).toEqual([0]);
    expect(integrity.notices.join()).toContain("结论的强度超过其证据");
  });

  it("没有阻断句时原样返回同一对象（不改变 reportHash 语义）", () => {
    const { report, integrity } = sanitizeReportForConsumption(REPORT, { strengthBlockedTexts: [] });
    expect(report).toBe(REPORT);
    expect(integrity.suppressed).toBe(false);
  });

  it("空白归一化后仍能匹配（模型输出的换行/多空格不影响阻断）", () => {
    const { report } = sanitizeReportForConsumption(REPORT, {
      strengthBlockedTexts: [REPORT.opportunities[0].replace("，", "，\n  ")],
    });
    expect(report.opportunities).toHaveLength(1);
  });
});


describe("P5 final claim consumption", () => {
  it("does not persist changes while suppressing summary and structured pain claims", () => {
    const report = { summary: "月销量600件证明需求已经验证", opportunities: [], risks: [],
      vocAnalysis: { painPoints: [{ text: "产品偏薄", evidenceRefs: [LEGAL_EVIDENCE] }] },
      narrativeBindings: [{ field: "summary", text: "月销量600件证明需求已经验证", evidenceRefs: [LEGAL_EVIDENCE] }] };
    const original = JSON.stringify(report);
    const safe = sanitizeReportForConsumption(report, { strengthBlockedTexts: [report.summary, "产品偏薄"] });
    expect(safe.report.summary).toBeNull();
    expect(safe.report.vocAnalysis.painPoints).toEqual([]);
    expect(safe.report.narrativeBindings).toEqual([]);
    expect(safe.integrity.suppressed).toBe(true);
    expect(JSON.stringify(report)).toBe(original);
  });
});
