import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketCompetition, competitionClaim } from "./MarketCompetition";
import { buildEvidenceLookup } from "./MarketReportEvidence";
import { buildResearchStatistics } from "@/lib/marketScan/researchStatistics";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";

function fixture(): MarketIntelligence {
  const evidence = { id: "locked", subjectKey: "amazon:US:B012345678", evidenceId: "locked", contentHash: "h", version: 1, capturedAt: "2026-10-13T22:05:26.000Z", sourceUrl: null, nature: "source_observed" };
  const data: MarketIntelligence = {
    schema: "market-intelligence.v1", scanId: "fixture", scanName: "fixture", marketplace: "US", resourceVersion: "v1", sampleHash: "h", inputHash: "input", observedAt: evidence.capturedAt,
    samples: [{ asin: "B012345678", subjectKey: evidence.subjectKey, title: "Silicone Mat Set of 2", brand: null, price: 11.99, priceCurrency: "USD", rating: 4.8, reviewCount: 27, monthlySalesEstimate: null, bsr: null, valid: true, evidence,
      reviewCountCaliber: { state: "conflict", lockedValue: 27, lockedSurface: "search", productPageValue: 27477, productPageCapturedAt: "2026-10-13T20:29:06.000Z", productPageEvidenceId: "detail-v2", conflicts: [], reason: "product_page_reading_incompatible" } }],
    sources: [], keywords: [], productMarkets: [], productSignals: [], trends: [], reviews: [], variations: [], category: null, queryBindings: [], bindingCandidates: [], evidenceChanges: [], limitations: [], provider: { ready: false, code: "FIXTURE", message: "fixture" }, reports: [],
  };
  data.statistics = { ...buildResearchStatistics(data), hash: "stats" };
  return data;
}
const render = (data: MarketIntelligence) => renderToStaticMarkup(React.createElement(MarketCompetition, { data, lookup: buildEvidenceLookup(data), onCaptureHistory: () => undefined, onOpenReport: () => undefined }));

describe("02 competition evidence presentation", () => {
  it("keeps conflicting readings, times and evidence side by side, excludes them from the distribution", () => {
    const html = render(fixture());
    expect(html).toContain("冲突 1 款");
    expect(html).toContain("搜索卡片读数 27");
    expect(html).toContain("商品页读数 27,477");
    expect(html).toContain("2026-10-13 20:29 UTC");
    expect(html).toContain("detail-v2");
    expect(html).toContain("当前证据不足，不能计算此分布");
    expect(html).not.toContain("评分分布（进入质量门槛）");
    expect(html).not.toContain("评论量形成的进入门槛");
  });
  it("shows verified readings in the existing statistical distribution", () => {
    const data = fixture();
    data.samples[0].reviewCountCaliber!.state = "verified";
    data.samples[0].reviewCount = 570;
    data.samples[0].reviewCountCaliber!.lockedValue = 570;
    data.statistics = { ...buildResearchStatistics(data), hash: "verified" };
    expect(render(data)).toContain("可复核 1 款 · 冲突 0 款 · 未复核 0 款");
  });
  it("labels search-only readings as unverified", () => {
    const data = fixture();
    data.samples[0].reviewCountCaliber!.state = "unverified";
    data.samples[0].reviewCountCaliber!.productPageValue = null;
    data.statistics = { ...buildResearchStatistics(data), hash: "unverified" };
    expect(render(data)).toContain("未复核 1 款");
    expect(render(data)).toContain("未复核，未采用");
  });
  it("keeps missing prices, brand and purpose unknown without deriving groups or unit price from title", () => {
    const data = fixture();
    data.samples[0].price = null;
    data.statistics = { ...buildResearchStatistics(data), hash: "missing" };
    const html = render(data);
    expect(html).toContain("价格或币种未知");
    expect(html).toContain("用途 / 形态分组：待核实");
    expect(html).toContain("品牌格局未知");
    expect(html).not.toContain("单件价 6");
  });
  it("does not promote old unclassified review statistics to verified data", () => {
    const data = fixture();
    delete data.samples[0].reviewCountCaliber;
    data.statistics = { ...buildResearchStatistics(data), hash: "legacy" };
    expect(render(data)).toContain("旧口径含未分类读数");
  });
  it("counts every historical subject and keeps the three curves out of the default content", () => {
    const data = fixture();
    for (let index = 1; index <= 3; index++) {
      const key = `amazon:US:B01234567${index}`;
      data.samples.push({ ...data.samples[0], subjectKey: key, asin: `B01234567${index}` });
      data.trends.push({ subjectKey: key, field: "sellersprite.traffic.monthlySales", points: [{ date: "2026-01", value: 10 }, { date: "2026-02", value: 20 }], evidence: data.samples[0].evidence });
    }
    data.statistics = { ...buildResearchStatistics(data), hash: "history" };
    const html = render(data);
    expect(html).toContain("单品历史覆盖 3/4 款");
    expect(html).not.toContain("历史日期序列</");
    expect(html).toContain("查看已保存的单品历史");
  });
  it("does not mutate formal samples, statistical values or reports while rendering", () => {
    const data = fixture();
    const before = JSON.stringify(data);
    render(data);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("keeps specification field time distinct from the locked sample observation", () => {
    const data = fixture();
    data.productDetails = [{
      subjectKey: data.samples[0].subjectKey, evidence: data.samples[0].evidence,
      facts: { material: "Silicone", itemDimensions: null, bulletPoints: [], conflicts: [], fieldEvidence: { material: [{ refId: "attachment:material", source: "amazon_dom", capturedAt: "2026-10-13T20:29:06.000Z" }] } },
    }] as unknown as MarketIntelligence["productDetails"];
    const html = render(data);
    expect(html).toContain("锁定样本观察");
    expect(html).toContain("材质字段来源");
    expect(html).toContain("2026-10-13 20:29 UTC");
    expect(html).toContain("2026-10-13 22:05 UTC");
    expect(html).toContain("attachment:material");
  });
  it("never uses a conflicting material or dimension as a source claim", () => {
    const detail = { facts: { material: "silicone", conflicts: [{ field: "extended.material", candidates: [] }] } } as unknown as NonNullable<MarketIntelligence["productDetails"]>[number];
    expect(competitionClaim(detail, "material")).toBe("来源冲突，待核实");
    expect(competitionClaim(undefined, "itemDimensions")).toBe("未知");
  });
});
