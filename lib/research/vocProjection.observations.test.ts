import { describe, expect, it } from "vitest";
import { buildVocProjection } from "@/lib/research/vocProjection";

/**
 * canonical 买家声音（customer_voice_observation_v1）作为 VOC 来源的回归用例。
 *
 * 真实背景：Amazon 评论被归一到 canonical customer voice 后，bundle 的 reviewEvidence 会为空，
 * 若只读附件，页面上会显示「0 条评论」，而库里其实有 9–13 条真实评论。
 */

const subjectKey = "amazon:US:B0CFTP6JR4";

function group(observations: Array<{ id: string; text: string; rating?: number | null; date?: string | null; source?: string }>) {
  return {
    attachmentId: "cv-att-1",
    contentHash: "hash-1",
    subjectKey,
    capturedAt: "2026-10-17T06:19:03.856Z",
    source: "amazon_review",
    observations: observations.map((item) => ({
      externalContentId: item.id,
      contentHash: `h-${item.id}`,
      source: item.source ?? "amazon_review",
      text: item.text,
      title: null,
      rating: item.rating ?? null,
      publishedAt: item.date ?? null,
      verifiedPurchase: true,
      contentType: "review",
      provenance: { sourceAttachmentId: "v3-att-1" },
    })),
  };
}

describe("canonical 买家声音进入 VOC 投影", () => {
  it("从 canonical observations 读出真实评论（不再显示 0 条）", () => {
    const voc = buildVocProjection({
      attachments: [],
      observations: [group([
        { id: "R1", text: "Surface is slippery when wet and hard to keep flat.", rating: 2, date: "2026-10-01" },
        { id: "R2", text: "Easy to clean and love the size.", rating: 5, date: "2026-10-02" },
      ])],
    });
    expect(voc.reviewsRead).toBe(2);
    expect(voc.attachmentsRead).toBe(1);
    expect(voc.asins).toEqual(["B0CFTP6JR4"]);
    const slippery = voc.themes.find((theme) => theme.id === "slip_resistance" && theme.polarity === "negative");
    expect(slippery).toBeTruthy();
    expect(slippery?.independentReviewCount).toBe(1);
    expect(slippery?.sampleDenominator).toBe(2);
    expect(slippery?.quotes[0].asin).toBe("B0CFTP6JR4");
    expect(slippery?.quotes[0].rating).toBe(2);
  });

  it("同一评论 id 在 canonical 与附件两条路都出现时只计一次", () => {
    const voc = buildVocProjection({
      attachments: [{
        attachmentId: "v3-att-1",
        contentHash: "hash-v3",
        capturedAt: "2026-10-17T06:00:00.000Z",
        kind: "v3_review_voc_v1",
        subjectKey,
        sourceType: "amazon_dom",
        sourceUrl: null,
        schemaVersion: "capture-system-v3-module-evidence.v1",
        payload: {
          module: "review_voc",
          subjectKey,
          status: "VALIDATED_AVAILABLE",
          identity: { asin: "B0CFTP6JR4" },
          data: { reviews: [{ asin: "B0CFTP6JR4", rating: 2, reviewText: "Surface is slippery when wet and hard to keep flat.", reviewDate: "October 1, 2026" }] },
        },
      } as never],
      observations: [group([{ id: "R1", text: "Surface is slippery when wet and hard to keep flat.", rating: 2, date: "2026-10-01" }])],
    });
    // 两条来源指向同一条评论（同 ASIN/同文本/同星级）→ 去重后只剩 1 条
    expect(voc.reviewsRead).toBe(1);
    expect(voc.duplicateReviewsSuppressed).toBe(1);
  });

  it("非 Amazon 来源（帖子/评论）不混入商品级 VOC", () => {
    const voc = buildVocProjection({
      attachments: [],
      observations: [group([
        { id: "P1", text: "The mat is too slippery and thin.", rating: null, source: "reddit_post" },
      ])],
    });
    expect(voc.reviewsRead).toBe(0);
    expect(voc.rejectedAttachments[0]?.reason).toContain("没有可用的 Amazon 评论");
  });
});
