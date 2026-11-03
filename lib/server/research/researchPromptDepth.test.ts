import { describe, expect, it } from "vitest";
import { synthesisSystemPrompt } from "./researchEngine";

/**
 * P2-02：研究输出必须「具体、可否决」。
 * 这里锁定提示词中的硬性要求，防止后续改动把研究深度要求悄悄删掉。
 * 注意：本测试只证明「要求仍在」，不代表真实模型输出已达质量（需另获授权的模型批次）。
 */
describe("research synthesis prompt: 具体且可否决", () => {
  const prompt = synthesisSystemPrompt();

  it("要求人群/场景与具体问题，而不是泛泛总结", () => {
    expect(prompt).toContain("哪类人群/在什么场景下、观察到什么具体问题");
    expect(prompt).toContain("禁止只写「需要人工判断」「建议优化」这类空话");
  });

  it("要求竞争性原因假设并说明可能错在哪里", () => {
    expect(prompt).toContain("竞争性原因假设");
    expect(prompt).toContain("该假设可能错在哪里");
  });

  it("每条改良方向必须带差异、成本副作用与证伪/停止条件", () => {
    expect(prompt).toContain("有实质差异的改良方向");
    expect(prompt).toContain("成本或副作用");
    expect(prompt).toContain("证伪方法或停止条件");
  });

  it("证据不足时必须给出不改/缩场景/停止，而不是编造方向", () => {
    expect(prompt).toContain("不改动 / 缩小目标场景 / 停止该方向");
    expect(prompt).toContain("不得为了凑建议编造方向");
  });

  it("风险必须带停止条件与下一步验证，购买价值不得当成已证事实", () => {
    expect(prompt).toContain("何时应当停止或放弃");
    expect(prompt).toContain("购买价值假设");
    expect(prompt).toContain("不能把估算当已证事实");
  });

  it("仍然禁止伪造事实与越界引用", () => {
    expect(prompt).toContain("禁止猜销量、价格、成本、利润、供应商、VOC 内容或任何不存在的数据");
    expect(prompt).toContain("引用 allowedEvidenceRefs 之外的引用均无效");
  });
  it("把完整评论、区分力、全星级、范围与可证伪对照写入有效路径", () => {
    for (const rule of ["LC-PRQ-1", "保留同一评论相关正反语义", "不是有区分力的反证", "4/5星也可能投诉", "单商品不得推出品类共性", "同条件对照", "不能以阈值判定因果成立"]) expect(prompt).toContain(rule);
  });
});
