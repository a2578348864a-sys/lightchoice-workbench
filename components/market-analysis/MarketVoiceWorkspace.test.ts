import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import type { EvidenceLookup } from "./MarketReportEvidence";
import { MarketVoiceWorkspace } from "./MarketVoiceWorkspace";

describe("MarketVoiceWorkspace 评论缺失状态", () => {
  it("没有评论观察时，不声称存在可作为问题线索的原话", () => {
    const data = {
      reviews: [],
      translations: {},
      provider: { ready: false, message: "未配置" },
      aiOperations: [],
      sampleHash: "test-sample",
    } as unknown as MarketIntelligence;
    const stats = {
      subjects: [],
      reviews: { total: 0, lowStars: 0, highStars: 0, rated: 0, policy: "没有评论观察" },
      voc: [],
      sampleCount: 1,
      schema: "test",
      hash: "test",
    } as unknown as NonNullable<MarketIntelligence["statistics"]>;

    const html = renderToStaticMarkup(createElement(MarketVoiceWorkspace, {
      data,
      stats,
      lookup: {} as EvidenceLookup,
      report: undefined,
      act: async () => {},
      busy: false,
      onOpenReport: () => {},
    }));

    expect(html).toContain("尚未取得可读评论");
    expect(html).not.toContain("这些原话确实表达了对应场景下的具体问题");
    expect(html).toContain("width:0%");
  });
});
