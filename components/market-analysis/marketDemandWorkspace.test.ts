import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketDemandWorkspace } from "./MarketDemandWorkspace";
import { buildEvidenceLookup } from "./MarketReportEvidence";
import { buildResearchStatistics } from "@/lib/marketScan/researchStatistics";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";

function fixture(): MarketIntelligence {
  const evidence = { id: "evidence-1", subjectKey: "amazon:US:B012345678", evidenceId: "evidence-1", contentHash: "hash-1", version: 1, capturedAt: "2026-10-13T22:05:26.000Z", sourceUrl: null, nature: "source_observed" };
  const marketEvidence = { ...evidence, id: "evidence-market", evidenceId: "evidence-market", contentHash: "hash-market" };
  const trafficEvidence = { ...evidence, id: "evidence-traffic", evidenceId: "evidence-traffic", contentHash: "hash-traffic" };
  const data: MarketIntelligence = {
    schema: "market-intelligence.v1", scanId: "fixture", scanName: "fixture", marketplace: "US", resourceVersion: "v1", sampleHash: "sample-hash", inputHash: "input-hash", observedAt: evidence.capturedAt,
    samples: [{ asin: "B012345678", subjectKey: "amazon:US:B012345678", title: "Silicone Mat", brand: "Fixture", price: 11.99, priceCurrency: "USD", rating: 4.5, reviewCount: 100, monthlySalesEstimate: null, bsr: null, valid: true, evidence }],
    sources: [],
    keywords: [
      { keyword: "silicone baking mat AC 硅胶烘焙垫", subjectKey: "sellersprite:keyword-1", module: "keyword_mining_trend", searchVolume: 77947, observedAt: null, metrics: { searchVolumeGrowth: { value: 0.65, unit: "percent", metricNature: "provider_estimate" } }, evidence: marketEvidence },
      { keyword: "baking sheet", subjectKey: "amazon:US:B012345678", module: "reverse_asin", searchVolume: 142754, observedAt: null, metrics: { trafficShare: { value: 0.0712, unit: "percent", metricNature: "provider_estimate" }, estimatedTraffic: { value: 109851, unit: "count", metricNature: "provider_estimate" } }, evidence: trafficEvidence },
    ],
    productMarkets: [], productSignals: [], trends: [], reviews: [], variations: [], category: null,
    queryBindings: ["sellersprite:keyword-1"], bindingCandidates: [], evidenceChanges: [], limitations: [],
    provider: { ready: false, code: "FIXTURE", message: "fixture" },
    reports: [],
    research: { keyword: "silicone baking mat", sourceBatchId: null, captureEnabled: false },
  };
  data.statistics = { ...buildResearchStatistics(data), hash: "stats-hash" };
  return data;
}

function render(source: "market" | "competitor") {
  const data = fixture();
  return renderToStaticMarkup(
    React.createElement(MarketDemandWorkspace, {
      data,
      stats: data.statistics!,
      lookup: buildEvidenceLookup(data),
      query: "",
      onQueryChange: () => undefined,
      source,
      onSourceChange: () => undefined,
      onCapture: () => undefined,
      onOpenReport: () => undefined,
    }),
  );
}

describe("02 demand workspace: two keyword datasets stay separate", () => {
  it("shows market keyword demand without merging competitor traffic keywords", () => {
    const html = render("market");
    expect(html).toContain("市场关键词需求");
    expect(html).toContain("77,947");
    expect(html).toContain("不相加");
    expect(html).not.toContain("142,754");
    expect(html).not.toContain("竞品流量关键词数据表");
  });

  it("shows competitor traffic keywords without merging market demand", () => {
    const html = render("competitor");
    expect(html).toContain("竞品流量关键词");
    expect(html).toContain("142,754");
    expect(html).toContain("7.12%");
    expect(html).not.toContain("77,947");
    expect(html).not.toContain("市场关键词需求数据表");
  });

  it("keeps both row counts visible and never presents a combined total", () => {
    const html = render("market");
    // 两组行数与各自口径必须同时可见：表格只显示一组数据，但另一组的分母不能被隐藏。
    expect(html).toContain("市场关键词需求");
    expect(html).toContain("竞品流量关键词");
    expect(html).toContain("种子词查询");
    expect(html).toContain("ASIN 反查");
    expect(html).toContain("两组不相加、不共用分母");
    expect(html).not.toContain("合计");
  });
});
