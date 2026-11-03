import { describe, expect, it } from "vitest";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { adaptV3KeywordAttachment } from "@/lib/server/research/v3EvidenceResearchAdapter";
import { syntheticReverseAsinAttachment } from "@/lib/server/research/v3EvidenceTestFixtures";

function withTables(tables: unknown[]): SourceEvidenceAttachment {
  const original = syntheticReverseAsinAttachment();
  const payload = original.payload as Record<string, unknown>;
  return {
    ...original,
    payload: { ...payload, data: { tables } },
  };
}

describe("V3 keyword adapter named-column contract", () => {
  it("does not turn the second or longest column into a keyword without a keyword header", () => {
    const attachment = withTables([{
      headers: ["#", "Description", "Search Volume"],
      rows: [["1", "this unusually long cell is not a keyword", "2,500"]],
    }]);
    expect(adaptV3KeywordAttachment(attachment)).toBeNull();
  });

  it("keeps named SellerSprite estimates and raw values attached to their module", () => {
    const attachment = withTables([{
      headers: ["Keyword", "Traffic Share", "Estimated Traffic", "Organic Rank", "Ad Rank"],
      rows: [["kitchen organizer", "38.37%", "81,070", "515", null]],
    }]);
    const adapted = adaptV3KeywordAttachment(attachment, "amazon:US:B07G4VTV2F");
    expect(adapted).not.toBeNull();
    expect(adapted?.module).toBe("reverse_asin");
    expect(adapted?.typedRows).toHaveLength(1);
    expect(adapted?.typedRows[0]).toMatchObject({
      keyword: "kitchen organizer",
      metrics: {
        trafficShare: { value: 0.3837, metricNature: "provider_estimate" },
        estimatedTraffic: { value: 81070, metricNature: "provider_estimate" },
        organicRank: { value: 515, metricNature: "provider_estimate" },
      },
    });
    expect(adapted?.rows[0].monthlySearches).toBeNull();
    expect(adapted?.evidenceRef).toBe(`attachment:${attachment.attachmentId}`);
  });

  it("consumes the visibleSnapshot.tables shape persisted by the SellerSprite browser adapter", () => {
    const original = syntheticReverseAsinAttachment();
    const payload = original.payload as Record<string, unknown>;
    const attachment: SourceEvidenceAttachment = {
      ...original,
      payload: { ...payload, data: { visibleSnapshot: { tables: [{
        headers: ["Keyword", "Search Volume"], rows: [["garden hose", "2,400"]],
      }] } } },
    };
    const adapted = adaptV3KeywordAttachment(attachment, "amazon:US:B07G4VTV2F");
    expect(adapted?.typedRows).toHaveLength(1);
    expect(adapted?.typedRows[0]).toMatchObject({ keyword: "garden hose", metrics: { searchVolume: { value: 2400 } } });
  });

  it("does not treat traversal checkpoint rows as new Research facts", () => {
    const original = syntheticReverseAsinAttachment();
    const payload = original.payload as Record<string, unknown>;
    const attachment: SourceEvidenceAttachment = {
      ...original,
      payload: { ...payload, data: {
        rowScope: "traversal_checkpoint_only",
        visibleSnapshot: { tables: [{
          headers: ["Keyword", "Search Volume"], rows: [["garden hose", "2,400"]],
        }] },
      } },
    };
    expect(adaptV3KeywordAttachment(attachment, "amazon:US:B07G4VTV2F")).toBeNull();
  });

  it("consumes the visibleDom.tables shape persisted by the SellerSprite visible browser capture", () => {
    const original = syntheticReverseAsinAttachment();
    const payload = original.payload as Record<string, unknown>;
    const attachment: SourceEvidenceAttachment = {
      ...original,
      payload: { ...payload, data: {
        capturedFromVisibleDom: true,
        visibleDom: {
          tables: [{
            selector: "table:nth-of-type(2)",
            headers: ["#", "关键词 数据解释", "内测版流量占比", "自然排名"],
            rows: [["1", "christmas tree", "38.44%", "58"]],
            headerSource: "paired_table",
            headerStatus: "HEADER_OK",
            columnCount: 4,
          }],
        },
      } },
    };
    const adapted = adaptV3KeywordAttachment(attachment, "amazon:US:B07G4VTV2F");
    expect(adapted?.typedRows).toHaveLength(1);
    expect(adapted?.typedRows[0]).toMatchObject({ keyword: "christmas tree" });
    expect(adapted?.typedRows[0].metrics.trafficShare?.value).toBeCloseTo(0.3844, 4);
    expect(adapted?.typedRows[0].metrics.organicRank?.value).toBe(58);
  });

  it("真实表头形状：徽标/提示词与复合列都能正确落到 provider_estimate", () => {
    const original = syntheticReverseAsinAttachment();
    const payload = original.payload as Record<string, unknown>;
    const attachment: SourceEvidenceAttachment = {
      ...original,
      payload: { ...payload, data: { tables: [{
        headers: ["关键词 数据解释", "内测版流量占比", "月搜索量增长率", "SPR"],
        rows: [["christmas tree AC 圣诞树", "38.44% 80,590", "135,693 14.42%", "12"]],
      }] } },
    };
    const adapted = adaptV3KeywordAttachment(attachment, "amazon:US:B07G4VTV2F");
    const metrics = adapted?.typedRows[0].metrics;
    expect(metrics?.spr?.value).toBe(12);
    expect(metrics?.trafficShare?.value).toBeCloseTo(0.3844, 4);
    expect(metrics?.searchVolumeGrowth?.value).toBeCloseTo(0.1442, 4);
    for (const metric of Object.values(metrics ?? {})) {
      expect(metric?.metricNature).toBe("provider_estimate");
    }
  });
});
