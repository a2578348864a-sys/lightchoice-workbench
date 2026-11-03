import { describe, expect, it } from "vitest";

import {
  describeAmazonDetailBatchStatus,
  deriveCaptureStatusBadges,
  summarizeCaptureCompleteness,
} from "@/components/source/captureStatusPresentation";

describe("deriveCaptureStatusBadges（采集状态派生）", () => {
  it("Amazon 搜索批次（sourceType=amazon_search_capture）：Amazon 搜索 ✓，其余全 ok", () => {
    const badges = deriveCaptureStatusBadges({
      searchCaptured: true,
      brand: "Supmedic",
      bsr: { rank: 1 },
      enrichmentStatus: "enriched",
    });
    expect(badges).toEqual([
      { key: "search", label: "Amazon 搜索 ✓", tone: "ok" },
      { key: "detail", label: "当前批次详情 ✓", tone: "ok" },
      { key: "brand", label: "品牌 ✓", tone: "ok" },
      { key: "bsr", label: "BSR ✓", tone: "ok" },
    ]);
  });

  it("卖家精灵批次（sellersprite_xlsx）条目带 ASIN：Amazon 搜索 未采集（不得按 ASIN 误判）", () => {
    const badges = deriveCaptureStatusBadges({
      searchCaptured: false,
      brand: "导入品牌",
      bsr: { rank: 3 },
      enrichmentStatus: null,
    });
    const search = badges.find((badge) => badge.key === "search");
    expect(search).toEqual({ key: "search", label: "Amazon 搜索 未采集", tone: "missing" });
  });

  it("legacy/证据提档批次（evidence_store_reference）条目带 ASIN：不得显示 Amazon 搜索 ✓", () => {
    const badges = deriveCaptureStatusBadges({
      searchCaptured: false,
      brand: "提档品牌",
      bsr: null,
      enrichmentStatus: null,
    });
    const search = badges.find((badge) => badge.key === "search");
    expect(search?.label).not.toContain("✓");
    expect(search).toEqual({ key: "search", label: "Amazon 搜索 未采集", tone: "missing" });
  });

  it("captured_partial 必须显示为部分完成，不是失败也不是完整", () => {
    const badges = deriveCaptureStatusBadges({
      searchCaptured: true,
      brand: null,
      bsr: { rank: 12 },
      enrichmentStatus: "captured_partial",
    });
    const detail = badges.find((badge) => badge.key === "detail");
    expect(detail).toEqual({ key: "detail", label: "当前批次详情 部分完成", tone: "partial" });
    const brand = badges.find((badge) => badge.key === "brand");
    expect(brand).toEqual({ key: "brand", label: "品牌 缺失", tone: "missing" });
  });

  it("无 enrichment 块 = 未采集（不得从 brand/bsr 反推）", () => {
    const badges = deriveCaptureStatusBadges({
      searchCaptured: true,
      brand: "导入的品牌",
      bsr: { rank: 5 },
      enrichmentStatus: null,
    });
    const detail = badges.find((badge) => badge.key === "detail");
    expect(detail).toEqual({ key: "detail", label: "当前批次详情 待补齐", tone: "missing" });
  });
});

describe("describeAmazonDetailBatchStatus（历史证据与当前批次分离）", () => {
  it("subject 历史 COMPLETE 只说明存在历史证据，不会将当前批次标成完成", () => {
    expect(describeAmazonDetailBatchStatus({
      currentBatchStatus: null,
      hasUnlinkedDetailEvidence: true,
      evidenceCapturedAt: "2026-10-01T00:00:00.000Z",
      batchCreatedAt: "2026-10-08T00:00:00.000Z",
    })).toEqual({
      evidenceLabel: "已有历史详情证据",
      batchLabel: "待补齐",
    });
  });

  it("只有当前 ProductBatchItem 的 enrichment 才能显示当前批次已补齐", () => {
    expect(describeAmazonDetailBatchStatus({
      currentBatchStatus: "enriched",
      captureOrigin: "REUSED_VALID_EVIDENCE",
      hasUnlinkedDetailEvidence: true,
      evidenceCapturedAt: "2026-10-01T00:00:00.000Z",
      batchCreatedAt: "2026-10-08T00:00:00.000Z",
    })).toEqual({
      evidenceLabel: "复用有效证据并关联",
      batchLabel: "已补齐",
    });
  });
});

describe("summarizeCaptureCompleteness（画廊级完整度）", () => {
  it("统计 60 商品口径：detail/brand/bsr 计数", () => {
    const items = [
      ...Array.from({ length: 59 }, (_, index) => ({
        searchCaptured: true,
        brand: `B${index}`,
        bsr: { rank: index + 1 },
        enrichmentStatus: "enriched",
      })),
      {
        searchCaptured: true,
        brand: null,
        bsr: { rank: 61 },
        enrichmentStatus: "captured_partial",
      },
    ];
    const summary = summarizeCaptureCompleteness(items);
    expect(summary).toEqual({
      total: 60,
      detailEnriched: 59,
      detailPartial: 1,
      detailPending: 0,
      brandHit: 59,
      bsrHit: 60,
    });
  });
});
