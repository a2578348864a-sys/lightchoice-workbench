import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  adaptV3ReviewAttachment,
  adaptV3KeywordAttachment,
  adaptV3HistoricalTrendAttachment,
  summarizeTrendObservations,
  deduplicateReviewEvidence,
  deduplicateKeywordEvidence,
  deduplicateTrendObservations,
} from "./v3EvidenceResearchAdapter";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { withKeywordEvidence } from "@/lib/sourceLayer/fact/productFactAdapter";
import { buildTrendObservation, type TrendObservation } from "@/lib/sourceLayer/v2/contracts";
import {
  syntheticHistoricalTrendAttachment,
  syntheticKeywordMiningAttachment,
  syntheticReviewAttachment,
  syntheticReverseAsinAttachment,
} from "./v3EvidenceTestFixtures";

function loadSyntheticAttachment(name: "review" | "blocked-review" | "reverse-asin" | "keyword-mining" | "historical-trend"): SourceEvidenceAttachment {
  if (name === "review") return syntheticReviewAttachment();
  if (name === "blocked-review") return syntheticReviewAttachment("BLOCKED_WITH_EVIDENCE");
  if (name === "reverse-asin") return syntheticReverseAsinAttachment();
  if (name === "keyword-mining") return syntheticKeywordMiningAttachment();
  return syntheticHistoricalTrendAttachment();
}

function buildEquivalentReviewAttachments(includeLegacyOnlyRow = false): {
  legacy: SourceEvidenceAttachment;
  v3: SourceEvidenceAttachment;
} {
  const sharedRows = [
    {
      asin: "B07G4VTV2F",
      rating: 5,
      reviewDate: "2026-09-01",
      title: "Synthetic shared review one",
      reviewText: "Synthetic review body one.",
      verifiedPurchase: true,
    },
    {
      asin: "B07G4VTV2F",
      rating: 4,
      reviewDate: "2026-09-02",
      title: "Synthetic shared review two",
      reviewText: "Synthetic review body two.",
      verifiedPurchase: false,
    },
  ];
  const legacyOnlyRow = {
    asin: "B07G4VTV2F",
    rating: 3,
    reviewDate: "2026-09-03",
    title: "Synthetic legacy only review",
    reviewText: "Synthetic review body unique to legacy.",
    verifiedPurchase: true,
  };
  const legacyRows = includeLegacyOnlyRow ? [...sharedRows, legacyOnlyRow] : sharedRows;
  const baseV3 = syntheticReviewAttachment();

  return {
    legacy: buildSourceEvidenceAttachment({
      attachmentId: includeLegacyOnlyRow ? "legacy-with-unique-row" : "legacy-duplicate-rows",
      subjectKey: "amazon:US:B07G4VTV2F",
      kind: "review_evidence",
      sourceType: "amazon_dom",
      capturedAt: "2026-09-26T08:20:00.000Z",
      payload: { reviews: legacyRows.map((row) => ({ ...row, reviewTitle: row.title })) },
    }),
    v3: {
      ...baseV3,
      attachmentId: "v3-shared-rows",
      contentHash: "a".repeat(64),
      payload: {
        ...baseV3.payload,
        data: {
          reviews: sharedRows.map(({ reviewText, ...row }) => ({ ...row, body: reviewText })),
        },
      },
    },
  };
}

describe("Downstream Consumption Adapter Spike: V3 Evidence -> Research", () => {
  // --------------------------------------------------------------------------
  // 1. 合成 V3 评论单元测试 (真实样本由独立 REAL_E2E 验收)
  // --------------------------------------------------------------------------
  describe("① 评论适配 (v3_review_voc_v1)", () => {
    it("能正确解析合成 V3 评论 fixture 并提取四条样本", () => {
      const realReviewAtt = loadSyntheticAttachment("review");
      expect(realReviewAtt.kind).toBe("v3_review_voc_v1");

      const adapted = adaptV3ReviewAttachment(realReviewAtt, "amazon:US:B07G4VTV2F");
      expect(adapted).not.toBeNull();
      if (!adapted) return;

      expect(adapted.samples).toHaveLength(4);
      expect(adapted.asin).toBe("B07G4VTV2F");
      expect(adapted.evidenceRef).toBe(`attachment:${realReviewAtt.attachmentId}`);

      // Fixture 内容明确为合成文本，不冒充真实买家原声。
      const first = adapted.samples[0];
      expect(first.rating).toBe(5);
      expect(first.title).toBe("Synthetic sample title");
      expect(first.text).toContain("Synthetic fixture review text");
      expect(first.verifiedPurchase).toBe(true);

      // 验证 summaryItem 结构
      expect(adapted.summaryItem.refId).toBe(`attachment:${realReviewAtt.attachmentId}`);
      expect(adapted.summaryItem.asin).toBe("B07G4VTV2F");
      expect(adapted.summaryItem.sampleReviews.length).toBeGreaterThanOrEqual(4);

      // 验证 evidenceRefRecord
      expect(adapted.evidenceRefRecord.refId).toBe(`attachment:${realReviewAtt.attachmentId}`);
      expect(adapted.evidenceRefRecord.subjectKey).toBe("amazon:US:B07G4VTV2F");
      expect(adapted.evidenceRefRecord.contentHash).toBe(realReviewAtt.contentHash);
    });

    it("铁律守卫：评论仅作为 observation 存在，绝不侵入 ProductFact", () => {
      const realReviewAtt = loadSyntheticAttachment("review");
      const adapted = adaptV3ReviewAttachment(realReviewAtt);
      expect(adapted).not.toBeNull();

      // adapted 对象只返回 samples / summaryItem / evidenceRefRecord，无 ProductFact 投影
      expect((adapted as any).productFact).toBeUndefined();
    });

    it("对抗检查：BLOCKED_WITH_EVIDENCE 评论 fixture 必须 fail-closed 返回 null", () => {
      const blockedAtt = loadSyntheticAttachment("blocked-review");
      expect((blockedAtt.payload as any).status).toBe("BLOCKED_WITH_EVIDENCE");

      const adapted = adaptV3ReviewAttachment(blockedAtt);
      expect(adapted).toBeNull();
    });

    it("对抗检查：subjectKey 不匹配时必须 fail-closed 返回 null", () => {
      const realReviewAtt = loadSyntheticAttachment("review");
      const adapted = adaptV3ReviewAttachment(realReviewAtt, "amazon:US:B000000000");
      expect(adapted).toBeNull();
    });

    it("对抗检查：非 review 种类附件传入时必须返回 null", () => {
      const fakeAtt = {
        attachmentId: "att-1",
        kind: "keyword_evidence" as const,
        capturedAt: "2026-09-26T00:00:00.000Z",
        contentHash: "hash-1",
        payload: {},
      };
      expect(adaptV3ReviewAttachment(fakeAtt as any)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 2. 合成 V3 关键词单元测试 (真实样本由独立 REAL_E2E 验收)
  // --------------------------------------------------------------------------
  describe("② 关键词适配 (v3_reverse_asin_v1 / v3_keyword_mining_trend_v1)", () => {
    it("能正确解析合成 V3 关键词反查 fixture 并提取 12 条关键词", () => {
      const realKwAtt = loadSyntheticAttachment("reverse-asin");
      expect(realKwAtt.kind).toBe("v3_reverse_asin_v1");

      const adapted = adaptV3KeywordAttachment(realKwAtt, "amazon:US:B07G4VTV2F");
      expect(adapted).not.toBeNull();
      if (!adapted) return;

      expect(adapted.rows).toHaveLength(12);
      expect(adapted.rows[0].keyword).toBe("kinto water bottle");
      expect(adapted.rows[1].keyword).toBe("kinto travel tumbler");
      expect(adapted.rows[2].keyword).toBe("kinto tumbler");

      // 验证性质保持：第三方数据严格保持 provider_observed，绝不升格为 confirmed
      expect(adapted.metricNature).toBe("provider_observed");

      // 验证 keywordInput 结构与 sourceMethod
      expect(adapted.keywordInput.evidenceRef).toBe(`attachment:${realKwAtt.attachmentId}`);
      expect(adapted.keywordInput.sourceMethod).toBe("sellersprite");
    });

    it("能与既有 withKeywordEvidence 无缝对接，把 Top 关键词投影到 ProductFact", () => {
      const realKwAtt = loadSyntheticAttachment("reverse-asin");
      const adapted = adaptV3KeywordAttachment(realKwAtt);
      expect(adapted).not.toBeNull();
      if (!adapted) return;

      const baseFact: ProductFact = {
        schema: "product-fact.v3",
        subjectKey: "amazon:US:B07G4VTV2F",
        sourceProof: {
          source: "amazon_dom",
          captureId: "cap-test",
          evidenceId: "ev-test",
          subjectKey: "amazon:US:B07G4VTV2F",
          capturedAt: "2026-09-26T00:00:00.000Z",
          contentHash: "hash-test",
          sourceUrl: null,
          operator: "owner:v1",
        },
        basic: {
          asin: { value: "B07G4VTV2F", status: "present", source: "amazon_dom", confidence: 1, capturedAt: "2026-09-26T00:00:00.000Z", rawProofHash: "h" },
          title: { value: "KINTO Day-off Tumbler Water Bottle", status: "present", source: "amazon_dom", confidence: 1, capturedAt: "2026-09-26T00:00:00.000Z", rawProofHash: "h" },
          brand: { value: "KINTO", status: "present", source: "amazon_dom", confidence: 1, capturedAt: "2026-09-26T00:00:00.000Z", rawProofHash: "h" },
        },
        market: {},
        profit: {},
      } as any;

      const factWithKw = withKeywordEvidence(baseFact, adapted.keywordInput);
      expect(factWithKw.keywordEvidence).toBeDefined();
      expect(factWithKw.keywordEvidence?.topKeywords.status).toBe("present");
      expect(factWithKw.keywordEvidence?.topKeywords.value?.length).toBeGreaterThan(0);

      // 验证 Top 关键词打分匹配 "kinto" 和 "water bottle"
      const topWords = factWithKw.keywordEvidence?.topKeywords.value?.map((k) => k.keyword);
      expect(topWords).toContain("kinto water bottle");

      // 验证性质严格为 estimate
      for (const kw of factWithKw.keywordEvidence?.topKeywords.value ?? []) {
        expect(kw.metricNature).toBe("estimate");
        expect(kw.evidenceRef).toBe(`attachment:${realKwAtt.attachmentId}`);
      }
    });

    it("能正确解析带月搜索量的合成 V3 关键词挖掘 fixture", () => {
      const realMiningAtt = loadSyntheticAttachment("keyword-mining");
      expect(realMiningAtt.kind).toBe("v3_keyword_mining_trend_v1");

      const adapted = adaptV3KeywordAttachment(realMiningAtt, "amazon:US:B07G4VTV2F");
      expect(adapted).not.toBeNull();
      if (!adapted) return;

      expect(adapted.rows.length).toBeGreaterThanOrEqual(5);
      expect(adapted.rows[0].keyword).toBe("synthetic tumbler keyword");
      expect(adapted.rows[0].monthlySearches).toBe(3040);
    });

    it("对抗检查：空表格或非法结构必须 fail-closed 返回 null", () => {
      const fakeAtt = {
        attachmentId: "att-kw-fake",
        kind: "v3_reverse_asin_v1" as const,
        capturedAt: "2026-09-26T00:00:00.000Z",
        contentHash: "hash-fake",
        payload: {
          schemaVersion: "capture-system-v3-module-evidence.v1",
          module: "reverse_asin",
          subjectKey: "amazon:US:B07G4VTV2F",
          marketplace: "US",
          capturedAt: "2026-09-26T00:00:00.000Z",
          provider: "sellersprite",
          sourceSurface: "web",
          sourceUrl: null,
          providerUpdatedAt: null,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "provider_observed",
          status: "VALIDATED_AVAILABLE",
          limitations: [],
          identity: { asin: "B07G4VTV2F" },
          data: { tables: [] }, // 无数据
          evidenceOnly: true,
        },
      };
      expect(adaptV3KeywordAttachment(fakeAtt as any)).toBeNull();
    });

    it("对抗检查：status 为 BLOCKED_WITH_EVIDENCE 的关键词附件必须 fail-closed 返回 null", () => {
      const blockedKwAtt = {
        attachmentId: "att-kw-blocked",
        kind: "v3_reverse_asin_v1" as const,
        capturedAt: "2026-09-26T00:00:00.000Z",
        contentHash: "hash-blocked-kw",
        payload: {
          schemaVersion: "capture-system-v3-module-evidence.v1",
          module: "reverse_asin",
          subjectKey: "amazon:US:B07G4VTV2F",
          marketplace: "US",
          capturedAt: "2026-09-26T00:00:00.000Z",
          provider: "sellersprite",
          sourceSurface: "web",
          sourceUrl: null,
          providerUpdatedAt: null,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "provider_observed",
          status: "BLOCKED_WITH_EVIDENCE",
          limitations: ["captcha blocked"],
          identity: { asin: "B07G4VTV2F" },
          data: { accessGate: { blocked: true } },
          evidenceOnly: true,
        },
      };
      expect(adaptV3KeywordAttachment(blockedKwAtt as any)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. 合成 V3 历史趋势单元测试 (真实样本由独立 REAL_E2E 验收)
  // --------------------------------------------------------------------------
  describe("③ 历史趋势适配 (v3_historical_trend_v1)", () => {
    it.each(["VALIDATED_AVAILABLE", "AVAILABLE_WITH_LIMITATION"] as const)(
      "截图附件即使标记为 %s 并夹带数值也不能成为时序事实",
      (status) => {
        const structured = loadSyntheticAttachment("historical-trend");
        const screenshot = buildSourceEvidenceAttachment({
          ...structured,
          payload: { ...structured.payload, acquisitionMode: "SCREENSHOT_EVIDENCE", status },
        });

        expect(adaptV3HistoricalTrendAttachment(screenshot, structured.subjectKey)).toEqual([]);
        expect(screenshot.payload.data).toEqual(structured.payload.data);
      },
    );

    it("能正确解析合成 V3 历史趋势 fixture 并转换为内存 TrendObservation 列表", () => {
      const realHistAtt = loadSyntheticAttachment("historical-trend");
      expect(realHistAtt.kind).toBe("v3_historical_trend_v1");

      const observations = adaptV3HistoricalTrendAttachment(realHistAtt, "amazon:US:B07G4VTV2F");
      expect(observations).toHaveLength(6);

      const first = observations[0];
      expect(first.schemaVersion).toBe("trend-observation.v1");
      expect(first.subjectKey).toBe("amazon:US:B07G4VTV2F");
      expect(first.valueKind).toBe("estimated");
      expect(first.sourceType).toBe("sellersprite_plugin");
      expect(first.evidenceRefs).toEqual([`attachment:${realHistAtt.attachmentId}`]);
      expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.dedupeKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it("趋势转换是纯内存操作，不修改传入附件", () => {
      const realHistAtt = loadSyntheticAttachment("historical-trend");
      const attachmentBefore = JSON.stringify(realHistAtt);
      const observations = adaptV3HistoricalTrendAttachment(realHistAtt);
      expect(observations.length).toBeGreaterThan(0);

      expect(JSON.stringify(realHistAtt)).toBe(attachmentBefore);
    });

    it("对抗检查：非法日期或损坏数据点自动跳过，不猜测", () => {
      const corruptedAtt = {
        attachmentId: "att-hist-bad",
        kind: "v3_historical_trend_v1" as const,
        capturedAt: "2026-09-26T00:00:00.000Z",
        contentHash: "hash-bad",
        payload: {
          schemaVersion: "capture-system-v3-module-evidence.v1",
          module: "historical_trend",
          subjectKey: "amazon:US:B07G4VTV2F",
          marketplace: "US",
          capturedAt: "2026-09-26T00:00:00.000Z",
          provider: "sellersprite",
          sourceSurface: "web",
          sourceUrl: null,
          providerUpdatedAt: null,
          acquisitionMode: "VISIBLE_CHART",
          metricNature: "provider_estimate",
          status: "AVAILABLE_WITH_LIMITATION",
          limitations: ["tooltip visible only"],
          identity: { asin: "B07G4VTV2F" },
          data: {
            series: [
              { date: "invalid-date", organicTraffic: 10 }, // 非法日期，应跳过
              { date: "2025-05", organicTraffic: 5 },       // 合法点
            ],
          },
          evidenceOnly: true,
        },
      };

      const res = adaptV3HistoricalTrendAttachment(corruptedAtt as any);
      expect(res.length).toBe(1);
      expect(res[0].capturedDate).toBe("2025-05-01");
      expect(res[0].value).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // 4. 去重逻辑测试 (Deduplication)
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // 4. 去重逻辑测试 (Deduplication: V3_PRIMARY_LEGACY_COMPAT)
  // --------------------------------------------------------------------------
  describe("④ 去重逻辑 (V3_PRIMARY_LEGACY_COMPAT: 保留 V3，丢弃 Legacy)", () => {
    it("Review 去重：内容完全相同的附件优先保留 V3，丢弃旧版 Legacy", () => {
      const legacyAtt = { attachmentId: "legacy-1", contentHash: "hash-same", kind: "review_evidence" } as any;
      const v3AttSame = { attachmentId: "v3-1", contentHash: "hash-same", kind: "v3_review_voc_v1" } as any;
      const v3AttDiff = { attachmentId: "v3-2", contentHash: "hash-diff", kind: "v3_review_voc_v1" } as any;

      const result = deduplicateReviewEvidence([legacyAtt], [v3AttSame, v3AttDiff]);
      expect(result).toHaveLength(2);
      // 必须保留 v3-1 和 v3-2，丢弃 legacy-1！
      expect(result.map((x) => x.attachmentId)).toEqual(["v3-1", "v3-2"]);
    });

    it("Review 去重：跨格式同一批评论即使附件哈希不同也只保留 V3", () => {
      const { legacy, v3 } = buildEquivalentReviewAttachments();

      const result = deduplicateReviewEvidence([legacy], [v3]);

      expect(legacy.contentHash).not.toBe(v3.contentHash);
      expect(result.map((item) => item.attachmentId)).toEqual(["v3-shared-rows"]);
    });

    it("Review 去重：Legacy 含一条 V3 未覆盖的评论时完整保留该附件", () => {
      const { legacy, v3 } = buildEquivalentReviewAttachments(true);

      const result = deduplicateReviewEvidence([legacy], [v3]);

      expect(result.map((item) => item.attachmentId)).toEqual([
        "v3-shared-rows",
        "legacy-with-unique-row",
      ]);
    });

    it("Keyword 去重：内容完全相同的附件优先保留 V3，丢弃旧版 Legacy", () => {
      const legacyAtt = { attachmentId: "legacy-kw-1", contentHash: "hash-kw-same", kind: "keyword_evidence" } as any;
      const v3AttSame = { attachmentId: "v3-kw-1", contentHash: "hash-kw-same", kind: "v3_reverse_asin_v1" } as any;
      const legacyAttUnique = { attachmentId: "legacy-kw-2", contentHash: "hash-kw-unique", kind: "keyword_evidence" } as any;

      const result = deduplicateKeywordEvidence([legacyAtt, legacyAttUnique], [v3AttSame]);
      expect(result).toHaveLength(2);
      // v3-kw-1 优先，去重后的 legacy-kw-2 兜底，重复的 legacy-kw-1 丢弃
      expect(result.map((x) => x.attachmentId)).toEqual(["v3-kw-1", "legacy-kw-2"]);
    });

    it("Trend 去重：基于 dedupeKey 去重，V3 优先", () => {
      const tLegacy = buildTrendObservation({
        observationId: "t-legacy",
        subjectKey: "amazon:US:B07G4VTV2F",
        field: "price",
        value: 29.99,
        valueKind: "observed",
        sourceType: "amazon_dom",
        capturedAt: "2026-09-26T00:00:00.000Z",
        evidenceRefs: ["e1"],
      });
      const tV3 = buildTrendObservation({
        observationId: "t-v3",
        subjectKey: "amazon:US:B07G4VTV2F",
        field: "price",
        value: 29.99,
        valueKind: "observed",
        sourceType: "amazon_dom",
        capturedAt: "2026-09-26T00:00:00.000Z",
        evidenceRefs: ["e1"],
      });
      // tLegacy 与 tV3 dedupeKey 相同，优先保留 tV3
      const result = deduplicateTrendObservations([tLegacy], [tV3]);
      expect(result).toHaveLength(1);
      expect(result[0].observationId).toBe("t-v3");
    });
  });

  // --------------------------------------------------------------------------
  // 5. 趋势摘要提取纯函数测试 (summarizeTrendObservations)
  // --------------------------------------------------------------------------
  describe("⑤ 趋势摘要纯函数 (summarizeTrendObservations)", () => {
    it("空序列安全返回 null", () => {
      expect(summarizeTrendObservations([])).toBeNull();
    });

    it("正确汇总时序跨度、极值、走势方向与引用", () => {
      const realHistAtt = loadSyntheticAttachment("historical-trend");
      const observations = adaptV3HistoricalTrendAttachment(realHistAtt);
      expect(observations.length).toBeGreaterThan(0);

      const summary = summarizeTrendObservations(observations);
      expect(summary).not.toBeNull();
      expect(summary!.pointsCount).toBe(observations.length);
      expect(summary!.timeWindow).toBe("2025-04-01 ~ 2025-10-01");
      expect(summary!.evidenceRefs).toEqual([`attachment:${realHistAtt.attachmentId}`]);

      // 验证指标提取 (organicTraffic 从 1 降到 0 又回升到 1)
      expect(summary!.metrics.organicTraffic).toBeDefined();
      expect(summary!.metrics.organicTraffic.startValue).toBe(1);
      expect(summary!.metrics.organicTraffic.endValue).toBe(1);
      expect(summary!.metrics.organicTraffic.minValue).toBe(0);
      expect(summary!.metrics.organicTraffic.maxValue).toBe(1);
      expect(summary!.metrics.organicTraffic.direction).toBe("fluctuating");
    });
  });
});
