import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchClaimAuditCard } from "./ResearchClaimAuditCard";
import { auditResearchClaims, makeUnavailableClaimAudit } from "@/lib/research/evidenceAudit";

const BLOCKED = auditResearchClaims({
  summary: "页面快照显示售价24.99美元、评分4.4、评论数502，近月购买量约600件。",
  opportunities: ["近月购买量约600件，说明已有稳定的成交基础，可作为现成需求验证。"],
  risks: ["月销量/收入估算、FBA费用等字段均缺失，无法核算毛利。"],
  painPoints: [{ text: "有买家指出产品非常薄（约 2-3 毫米）。", evidenceRefs: ["attachment:att-1"] }],
  salesGrade: "NOT_AVAILABLE",
  reviewBase: 502,
});

describe("ResearchClaimAuditCard", () => {
  const html = renderToStaticMarkup(createElement(ResearchClaimAuditCard, { audit: BLOCKED }));

  it("展示判定、销量口径与评论基数", () => {
    expect(html).toContain("research-claim-audit-card");
    expect(html).toContain("存在越级结论");
    expect(html).toContain("市场层无可用销量数据");
    expect(html).toContain("502");
    expect(html).toContain("未知（研报未写明）");
  });

  it("逐条列出原文、判定依据与建议表述（不改原文）", () => {
    expect(html).toContain("近月购买量约600件");
    expect(html).toContain("不能作为结论");
    expect(html).toContain("建议表述：");
    expect(html).toContain("服务端限制采信与下游输出");
  });

  it("无越级结论时给出明确空态", () => {
    const clean = auditResearchClaims({
      summary: "仅基于 2 条公开评论做有限研判。",
      opportunities: [],
      risks: [],
      painPoints: [],
      salesGrade: "NOT_AVAILABLE",
      reviewBase: 2,
    });
    const cleanHtml = renderToStaticMarkup(createElement(ResearchClaimAuditCard, { audit: clean }));
    expect(cleanHtml).toContain("research-claim-audit-empty");
    expect(cleanHtml).toContain("未发现结论强度超过证据");
  });
});


it("审查不可用且零 flags 时不能显示已通过或未发现越级", () => {
  const html = renderToStaticMarkup(createElement(ResearchClaimAuditCard, { audit: makeUnavailableClaimAudit() }));
  expect(html).toContain("审查不可用");
  expect(html).toContain("不能视为审查通过");
  expect(html).not.toContain("未发现结论强度超过证据的表述");
});
