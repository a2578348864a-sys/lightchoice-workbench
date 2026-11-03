import { describe, expect, it, vi } from "vitest";

/**
 * P0 证据可信度｜写侧证据门禁回归（新研报净化）
 *
 * 锁定不变量：模型声明的引用中只要出现任意一个白名单外 ID，
 * 就无法确定该陈述的哪些部分由非法来源支撑 ⇒ **整条拒收**，
 * 既不保留原文，也**不**改用剩下的合法引用让它看起来有支撑。
 *
 * SUT 为真实 bindNarrativesWithCitations（生产 advisory 绑定阶段使用的同一函数）。
 */

vi.mock("@/lib/server/db", () => ({ prisma: {} }));

const { bindNarrativesWithCitations } = await import("@/lib/server/v5ResearchService");

const LEGAL = "evidence:good";
const LEGAL_VOICE = "attachment:voice-1";
const ILLEGAL = "attachment:att-61e7709290c34556c5cf7892"; // 白名单外（真实存在于 EvidenceStore 的变体附件）

const ALLOWED = [LEGAL, LEGAL_VOICE];

/** 模型草稿：同时声明合法与非法引用的「混合」陈述 —— 这就是原缺陷的输入形态。 */
function mixedDraft() {
  return {
    summary: {
      text: "该 ASIN 属于以 B0D34DNMCL 为父体的多变体家族，同系列提供黑/橙/红等颜色及 4 张、6 张规格。",
      evidenceRefs: [LEGAL, ILLEGAL],
    },
    opportunities: [
      { text: "价格锚点清晰：9.99 USD / 3 张。", evidenceRefs: [LEGAL] },
      { text: "可通过变体矩阵覆盖不同尺寸与颜色偏好。", evidenceRefs: [LEGAL, ILLEGAL] },
    ],
    risks: [
      { text: "关键商业字段大面积缺失，无法量化利润与排名。", evidenceRefs: [LEGAL] },
    ],
    vocAnalysis: {
      painPoints: [{ text: "清洗时在台面上滑动、难以施力。", evidenceRefs: [LEGAL_VOICE, ILLEGAL] }],
      positiveSignals: [{ text: "不粘效果好，无需抹油。", evidenceRefs: [LEGAL_VOICE] }],
      failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [],
    },
    citations: [
      { quote: "9.99", source: LEGAL },
      { quote: "slippery", source: LEGAL_VOICE },
      { quote: "2 Half Sheets & 1 Quarter Sheet", source: ILLEGAL },
    ],
  };
}

describe("P0 证据可信度｜写侧证据门禁", () => {
  it("用例 1：全部引用合法 → summary / opportunities / risks / VOC 正常保留", () => {
    const bound = bindNarrativesWithCitations({
      summary: { text: "合法摘要", evidenceRefs: [LEGAL] },
      opportunities: [{ text: "合法机会", evidenceRefs: [LEGAL] }],
      risks: [{ text: "合法风险", evidenceRefs: [LEGAL] }],
      vocAnalysis: {
        painPoints: [{ text: "合法痛点", evidenceRefs: [LEGAL_VOICE] }],
        positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [],
      },
      citations: [{ quote: "q", source: LEGAL }, { quote: "v", source: LEGAL_VOICE }],
    }, ALLOWED);

    expect(bound.summary).toBe("合法摘要");
    expect(bound.opportunities).toEqual(["合法机会"]);
    expect(bound.risks).toEqual(["合法风险"]);
    expect(bound.vocAnalysis.painPoints).toHaveLength(1);
    expect(bound.rejectedClaims).toEqual([]);
    expect(bound.citations.map((c) => c.source).sort()).toEqual([LEGAL, LEGAL_VOICE].sort());
  });

  it("用例 2：机会点混合引用 → 整条拒收，不得只删引用，其他合法条目保留", () => {
    const bound = bindNarrativesWithCitations(mixedDraft() as never, ALLOWED);

    // 受影响条目完整消失（不是「删引用留正文」）
    expect(bound.opportunities).toEqual(["价格锚点清晰：9.99 USD / 3 张。"]);
    expect(bound.opportunities.some((text) => text.includes("变体矩阵"))).toBe(false);

    // 独立合法条目不受影响
    expect(bound.risks).toHaveLength(1);
    expect(bound.vocAnalysis.positiveSignals).toHaveLength(1);

    // 拒收可追溯：字段路径 / 非法引用 / 处理方式 / 原文预览
    const claim = bound.rejectedClaims.find((item) => item.field === "opportunities[1]");
    expect(claim).toBeDefined();
    expect(claim?.illegalRefs).toEqual([ILLEGAL]);
    expect(claim?.declaredRefs).toEqual([LEGAL, ILLEGAL]);
    expect(claim?.disposition).toBe("rejected_whole_statement");
    expect(claim?.textPreview).toContain("变体矩阵");
    expect(bound.unverifiedAssumptions.some((line) => line.includes("整条拒收"))).toBe(true);
  });

  it("用例 3：摘要混合引用（父 ASIN / 变体规格）→ 整块拒收，绝不留原句挂合法引用", () => {
    const bound = bindNarrativesWithCitations(mixedDraft() as never, ALLOWED);

    expect(bound.summary).toBeNull();
    // 不得出现在任何正式 narrative 绑定里，也不得挂上剩下的合法引用
    expect(bound.narrativeBindings.some((binding) => binding.field === "summary")).toBe(false);
    expect(JSON.stringify(bound.narrativeBindings)).not.toContain("B0D34DNMCL");

    const claim = bound.rejectedClaims.find((item) => item.field === "summary");
    expect(claim?.illegalRefs).toEqual([ILLEGAL]);
    expect(claim?.disposition).toBe("rejected_whole_statement");
    expect(claim?.textPreview).toContain("B0D34DNMCL");
    expect(bound.unverifiedAssumptions.some((line) => line.includes("summary 因引用白名单外证据整条拒收"))).toBe(true);
  });

  it("用例 5：VOC 条目混合引用 → 保守拒收该条目，同类别其他合法条目保留", () => {
    const bound = bindNarrativesWithCitations(mixedDraft() as never, ALLOWED);
    expect(bound.vocAnalysis.painPoints).toEqual([]);
    expect(bound.vocAnalysis.positiveSignals.map((item) => item.text)).toEqual(["不粘效果好，无需抹油。"]);
    expect(bound.rejectedClaims.some((item) => item.field === "vocAnalysis.painPoints[0]")).toBe(true);
  });

  it("非法引用本身不得进入正式 citations；合法引用仍可用", () => {
    const bound = bindNarrativesWithCitations(mixedDraft() as never, ALLOWED);
    expect(bound.citations.map((c) => c.source)).not.toContain(ILLEGAL);
    expect(bound.citations.map((c) => c.source)).toContain(LEGAL);
    expect(bound.unverifiedAssumptions.some((line) => line.includes(`未核实引用来源 [${ILLEGAL}]`))).toBe(true);
  });

  it("完全无引用的陈述仍按原契约进入未验证假设（不得静默丢弃）", () => {
    const bound = bindNarrativesWithCitations({
      summary: { text: "无引用摘要", evidenceRefs: [] },
      opportunities: [{ text: "无引用机会", evidenceRefs: [] }],
      risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "q", source: LEGAL }],
    } as never, ALLOWED);
    expect(bound.summary).toBeNull();
    expect(bound.opportunities).toEqual([]);
    expect(bound.rejectedClaims).toEqual([]); // 与「非法引用拒收」语义不同，必须区分
    expect(bound.unverifiedAssumptions.filter((line) => line.includes("缺少合法 citation 绑定"))).toHaveLength(2);
  });

  it("价格带结论中的金额未出现在引用原文时，整条移入未验证假设", () => {
    const bound = bindNarrativesWithCitations({
      summary: { text: "合法摘要", evidenceRefs: [LEGAL] },
      opportunities: [],
      risks: [{ text: "该商品售价 $44.90，显著高于同类主流价格带 $24.99。", evidenceRefs: [LEGAL] }],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "该商品售价 $44.90。", source: LEGAL }],
    } as never, ALLOWED);
    expect(bound.risks).toEqual([]);
    expect(bound.unverifiedAssumptions.some((line) => line.includes("价格带结论含引用原文未出现的金额"))).toBe(true);
  });

  it("引用原文同时包含价格带金额时，价格带结论可保留", () => {
    const bound = bindNarrativesWithCitations({
      summary: { text: "合法摘要", evidenceRefs: [LEGAL] },
      opportunities: [],
      risks: [{ text: "该商品售价 $44.90，显著高于同类主流价格带 $24.99。", evidenceRefs: [LEGAL] }],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "售价 $44.90；同类主流价格带 $24.99。", source: LEGAL }],
    } as never, ALLOWED);
    expect(bound.risks).toHaveLength(1);
  });
});
