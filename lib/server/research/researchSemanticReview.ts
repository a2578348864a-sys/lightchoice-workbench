import type { ResearchEngineInput, ResearchNarrative } from "@/lib/research/researchContracts";
import { authoritativeCommentStats, reviewStarClaims } from "./researchFactConsistency";

/** Second layer only: never invent, remove or re-authorize an evidence ref. */
export function reviewResearchNarratives<T>(value: T, input: ResearchEngineInput): T {
  const voice = input.researchInputBundle?.customerVoiceEvidence ?? [];
  // 权威评论统计只从本次实际输入的评论凭据计算一次，供每段叙事比对。
  const commentStats = authoritativeCommentStats(input);
  const inspect = (entry: ResearchNarrative): ResearchNarrative => {
    if (!entry.text) return entry;
    const text = entry.semanticReview ? entry.text.replace(/^【(?:待验证假设|待人工复核)：[^】]*】/u, "") : entry.text;
    const reasons: string[] = [...(entry.semanticReview?.reasons ?? [])];
    let needsHuman = entry.semanticReview?.status === "human_review_required";
    const stars = [...text.matchAll(/([1-5一二三四五])\s*(?:星|[ -]?star)/giu)]
      .map((match) => Number(match[1]) || "一二三四五".indexOf(match[1]!) + 1);
    if (stars.length) {
      const ids = new Set(entry.evidenceRefs.map((ref) => ref.refId));
      const linked = voice.flatMap((v) => v.observations.filter((o) =>
        ids.has(`attachment:${v.attachmentId}`) || o.evidenceRefs.some((id) => ids.has(id))));
      const named = linked.filter((o) => o.externalContentId && new RegExp(
        `(^|[^a-zA-Z0-9_:.-])${o.externalContentId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}($|[^a-zA-Z0-9_:.-])`, "u",
      ).test(text));
      // A single claimed rating with explicit comment IDs can be checked against
      // those rows. An attachment containing mixed ratings alone is ambiguous.
      const observations = new Set(stars).size === 1 && named.length ? named : linked;
      if (!observations.length || observations.some((o) => o.rating === null || !stars.includes(o.rating))) {
        needsHuman = true;
        reasons.push(observations.length === 1
          ? "评论星级与对应结构化证据不一致或未知，需核对原文。"
          : "引用覆盖多条不同星级或星级未知的评论，缺少逐评论归属，不能确认该星级概括。请核对 externalContentId 与原文。");
      }
    }
    // Scope and modality are checked together. Listing/review citations cannot
    // prove a proposed design's supplier quote, tooling, yield or profit.
    // Known fee facts and explicit unknown/conditional statements are preserved.
    const sentences = text.split(/[。；;，,\n]/u);
    const certainty = sentences.some((sentence) => {
      if (/(?:无法|不能|尚未|未经|未有|没有[^，,]*?(?:证据|报价|数据)|缺少|不代表|不保证|待验证|待核实|需验证|需要验证|未知)/u.test(sentence)) return false;
      const scoped = /成本|制造|工厂|模具|利润|量产|供应商能力|合规/u.test(sentence);
      const asserts = /几乎(?:为零|没有|无)|极低|零成本|不增加|无需|不需要|轻松实现|必然|一定(?:可|能|会|提高)|保证|完全符合|零风险/u.test(sentence);
      return scoped && asserts;
    });
    if (certainty) reasons.push("改良成本、模具、工厂能力或利润尚无对应方案的报价、工艺或测算证据；现有商品/评论引用不能确认这些商业断言，需补证验证。");
    // Conservative review cues, never an automatic verdict on natural-language
    // causality. Explicitly bounded/unknown category hypotheses stay intact.
    const overreach = text.split(/[。；;\n]/u).some((sentence) => {
      const claim = /(?:品类|类目|行业|同类产品).{0,30}(?:共性|普遍|通病|都存在|均存在|未被解决)/u.test(sentence)
        || /(?:共性短板|品类共性|行业共性)/u.test(sentence);
      const bounded = /(?:无法|不能|不代表|并非|而非|是否|尚未|待验证|待核实).{0,30}(?:品类|类目|行业|共性)/u.test(sentence)
        || /(?:品类|类目|行业|共性).{0,16}(?:假设|尚待验证|尚未证实)/u.test(sentence);
      return claim && !bounded;
    });
    if (overreach) {
      needsHuman = true;
      reasons.push("出现品类/行业共性外推措辞；当前商品引用不能自动证明跨商品普遍性，需人工核查样本范围，未补证前只作待验证的品类假设。");
    }
    // 2026-10-29：模型会写出可核实但错误的评论星级统计（#5 摘要「9 条里 8 条 5 星、
    // 1 条 4 星、1 条 4 星」，分项合计 10 条）。这类事实可以用程序核对，不能靠
    // 另一段 AI 文字自证。原文不改写，只加待人工复核标记。
    const starReview = reviewStarClaims(text, commentStats);
    if (starReview) {
      needsHuman = true;
      reasons.push(...starReview.reasons);
    }
    if (!reasons.length) return entry;
    const status = needsHuman ? "human_review_required" : "hypothesis";
    return { ...entry, text, semanticReview: { ...entry.semanticReview, status, reasons: [...new Set(reasons)] } };
  };
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    if ("text" in node && "evidenceRefs" in node) return inspect(node as ResearchNarrative);
    const reviewed = Object.fromEntries(Object.entries(node).map(([key, item]) => [key,
      key === "causalHypotheses" && Array.isArray(item) ? item.map((cause: ResearchNarrative) => inspect({ ...cause,
        semanticReview: cause.semanticReview ?? { status: "hypothesis", reasons: ["竞争性原因是假设，引用只关联观察，尚未确认因果。"] } })) : visit(item)]));
    if ("hypothesis" in reviewed && Array.isArray(reviewed.verification)) {
      const actions = reviewed.verification.filter((action): action is string => typeof action === "string");
      const reasons: string[] = [];
      if (actions.some((action) => /(?:词频|关键词|出现频次|提及次数|评论.{0,12}[≥>]).{0,100}(?:假设成立|因果成立|证明原因|确认原因)/u.test(action))) {
        reasons.push("验证动作以评论词频/数量判定因果成立；频次只能筛选线索，需要能区分竞争解释的同条件对照与否定条件。");
      }
      const hasHighStars = voice.some((v) => v.observations.some((o) => o.rating !== null && o.rating >= 4));
      if (hasHighStars && actions.some((action) => /[1一]\s*[–—~\-至到]\s*[3三]\s*星/u.test(action)
        && !/(?:[4四5五]\s*(?:[\/、和及–—~\-]\s*[5五])?\s*星|全星级|各星级|所有星级)/u.test(action))) {
        reasons.push("验证动作仅列1–3星而输入包含4/5星；需按问题内容纳入高星混合评价与正面限制信息，人工复核抽样方案。");
      }
      const hypothesis = reviewed.hypothesis as ResearchNarrative | undefined;
      if (reasons.length && hypothesis?.text) reviewed.hypothesis = inspect({ ...hypothesis,
        semanticReview: { ...hypothesis.semanticReview, status: "human_review_required",
          reasons: [...(hypothesis.semanticReview?.reasons ?? []), ...reasons] } });
    }
    return reviewed;
  };
  return visit(value) as T;
}
