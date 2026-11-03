import { describe, expect, it } from "vitest";
import { isVerifiedNarrative, type ResearchEngineInput, type ResearchNarrative } from "@/lib/research/researchContracts";
import { reviewResearchNarratives } from "./researchSemanticReview";

const input = (ratings: number[]) => ({ researchInputBundle: { customerVoiceEvidence: [{ attachmentId: "voice",
  observations: ratings.map((rating, i) => ({ rating, externalContentId: `r${i}`, evidenceRefs: [] })) }] } }) as unknown as ResearchEngineInput;
const narrative = (text: string): ResearchNarrative => ({ text, evidenceRefs: [{ refId: "attachment:voice" } as never] });
describe("semantic review without changing citation validity", () => {
  it("does not treat unreferenced model text as a verified statement", () => {
    const result = reviewResearchNarratives<ResearchNarrative>({ text: "成本几乎为零", evidenceRefs: [] }, input([]));
    expect(result.semanticReview?.status).toBe("hypothesis");
    expect(isVerifiedNarrative(result)).toBe(false);
  });
  it("flags a wrong single rating and an ambiguous mixed collection, preserving counterevidence", () => {
    for (const ratings of [[4], [4, 5]]) {
      const before = narrative("5星评论称厚度合适");
      const result = reviewResearchNarratives({ counterevidence: [before] }, input(ratings));
      expect(result.counterevidence).toHaveLength(1);
      expect(result.counterevidence[0]!.semanticReview?.status).toBe("human_review_required");
      expect(result.counterevidence[0]!.evidenceRefs).toEqual(before.evidenceRefs);
      expect(isVerifiedNarrative(result.counterevidence[0])).toBe(false);
    }
  });
  it("preserves a consistently supported rating and neutral supported observations", () => {
    expect(reviewResearchNarratives(narrative("5星评论称耐用"), input([5])).semanticReview).toBeUndefined();
    expect(reviewResearchNarratives(narrative("评论称耐用"), input([4, 5])).semanticReview).toBeUndefined();
  });
  it("checks explicit comment identity rather than every rating in an attachment", () => {
    const result = reviewResearchNarratives(narrative("5星评论 r1 称耐用"), input([4, 5]));
    expect(result.semanticReview).toBeUndefined();
    expect(reviewResearchNarratives(narrative("5星评论 r0 称耐用"), input([4, 5])).semanticReview?.status).toBe("human_review_required");
    const prefixIds = { researchInputBundle: { customerVoiceEvidence: [{ attachmentId: "voice", observations: [
      { rating: 4, externalContentId: "r1", evidenceRefs: [] }, { rating: 5, externalContentId: "r10", evidenceRefs: [] },
    ] }] } } as unknown as ResearchEngineInput;
    expect(reviewResearchNarratives(narrative("5星评论 r10 称耐用"), prefixIds).semanticReview).toBeUndefined();
  });
  it("flags narrow category overreach without rewriting the original or its refs", () => {
    const before = narrative("现有硅胶垫品类存在共性短板，而非单一卖家问题。");
    const reviewed = reviewResearchNarratives(before, input([4]));
    expect(reviewed.semanticReview?.status).toBe("human_review_required");
    expect(reviewed.text).toBe(before.text);
    expect(reviewed.evidenceRefs).toEqual(before.evidenceRefs);
    for (const text of ["缺少跨商品证据，无法确认品类共性。", "提出待验证的品类共性假设。", "可能只是个别批次问题而非行业共性。", "本品一位买家报告清洗困难。"]) {
      expect(reviewResearchNarratives(narrative(text), input([4])).semanticReview).toBeUndefined();
    }
  });
  it("keeps verification text but asks review of frequency-as-cause and low-star-only plans", () => {
    const causes = { causalInvestigations: [
      { hypothesis: narrative("厚度未标注导致预期落差"), verification: ["统计关键词出现频次；若30条中出现3次，则假设成立。"] },
      { hypothesis: narrative("清洗困难与柔软有关"), verification: ["抽取全部1–3星评论做主题编码。"] },
      { hypothesis: narrative("清洗困难与柔软有关"), verification: ["检查1–3星及4/5星混合评价，并在同条件下改变支撑结构测试。"] },
    ] };
    const result = reviewResearchNarratives(causes, input([4, 5]));
    expect(result.causalInvestigations.slice(0, 2).every((c) => c.hypothesis.semanticReview?.status === "human_review_required")).toBe(true);
    expect(result.causalInvestigations[2]!.hypothesis.semanticReview).toBeUndefined();
    expect(result.causalInvestigations.map((c) => c.verification)).toEqual(causes.causalInvestigations.map((c) => c.verification));
    expect(reviewResearchNarratives(result, input([4, 5]))).toEqual(result);
  });
  it.each(["成本几乎为零", "几乎没有成本", "几乎无制造成本增加", "成本极低", "不增加制造成本", "工厂可以轻松实现", "不需要更换模具", "必然提高利润", "一定可量产"])("demotes unsupported design certainty: %s", (text) => {
    const result = reviewResearchNarratives(narrative(text), input([5]));
    expect(result.semanticReview?.status).toBe("hypothesis");
    expect(result.text).toBe(text);
    expect(result.evidenceRefs).toHaveLength(1);
    expect(isVerifiedNarrative(result)).toBe(false);
  });
  it.each(["FBA费用为5美元", "缺少证据，不能保证利润提高", "成本是否极低尚未验证", "不需要更换模具是待验证假设"])("preserves facts and explicit uncertainty: %s", (text) => {
    expect(reviewResearchNarratives(narrative(text), input([5])).semanticReview).toBeUndefined();
  });
  it("repeats stably, keeps original text, and accumulates newly detected risk", () => {
    const original = { ...narrative("5星评论称厚度合适；成本几乎为零"),
      semanticReview: { status: "hypothesis" as const, reasons: ["原有因果不确定性"] } };
    const once = reviewResearchNarratives(original, input([4, 5]));
    expect(once.text).toBe(original.text);
    expect(once.semanticReview?.reasons).toHaveLength(3);
    expect(once.semanticReview?.status).toBe("human_review_required");
    expect(reviewResearchNarratives(once, input([4, 5]))).toEqual(once);
  });
  it.each(["可能增加制造成本", "成本尚未确认", "需要供应商报价验证", "当前商品售价为19.99美元", "根据用户提供的报价计算成本"])("does not blanket-ban cost language: %s", (text) => {
    expect(reviewResearchNarratives(narrative(text), input([4])).semanticReview).toBeUndefined();
  });
});
