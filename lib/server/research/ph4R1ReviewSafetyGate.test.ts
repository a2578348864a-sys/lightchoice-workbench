/**
 * PH4-R1：Amazon Review / VOC 来源安全门禁回归（纯 Fixture，确定性）
 *
 * ⚠️ 本文件**不代表 R1 真实采集通过**。本轮真实页面判定为：
 *   B00GS8VIKE 详情页只有 Customers say（Amazon AI 摘要）+ 评分直方图，
 *   0 条真人评论正文；正常可见的 5-star 筛选入口跳转 /ap/signin → LOGIN_REQUIRED。
 *   因此真实 Review Evidence 采集 = BLOCKED_LOGIN_REQUIRED。
 *
 * 本文件只锁定**已有安全门禁**在受控 Fixture 下仍然 fail-closed，
 * 防止将来为追求 PASS 而被放宽。
 */
import { describe, expect, it } from "vitest";

import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { reviewBlockForPageStatus } from "@/lib/server/reviewCollector";
import { adaptV3ReviewAttachment } from "@/lib/server/research/v3EvidenceResearchAdapter";
import { buildReviewDuplicateKey, isValidAsin } from "@/lib/server/reviewEvidence";

const SUBJECT = "amazon:US:B00GS8VIKE";
const ATTACHMENT = "att-r1-fixture";

function reviewAttachment(overrides: {
  attachmentId?: string;
  subjectKey?: string;
  status?: string;
  acquisitionMode?: string;
  identityAsin?: string | null;
  reviews?: unknown;
}): SourceEvidenceAttachment {
  const subjectKey = overrides.subjectKey ?? SUBJECT;
  return {
    attachmentId: overrides.attachmentId ?? ATTACHMENT,
    kind: "v3_review_voc_v1",
    sourceType: "amazon_dom",
    subjectKey,
    sourceUrl: "https://www.amazon.com/dp/B00GS8VIKE",
    capturedAt: "2026-10-09T13:00:00.000Z",
    contentHash: "f".repeat(64),
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "review_voc",
      subjectKey,
      marketplace: "US",
      capturedAt: "2026-10-09T13:00:00.000Z",
      provider: "Amazon",
      sourceSurface: "Amazon product page reviews",
      sourceUrl: "https://www.amazon.com/dp/B00GS8VIKE",
      providerUpdatedAt: null,
      freshness: null,
      acquisitionMode: overrides.acquisitionMode ?? "DOM_DIRECT",
      metricNature: "provider_observed",
      status: overrides.status ?? "AVAILABLE_WITH_LIMITATION",
      limitations: ["amazon_review_visibility_limited"],
      identity: {
        asin: overrides.identityAsin === undefined ? "B00GS8VIKE" : overrides.identityAsin,
        parentAsin: null,
        keyword: null,
        query: null,
        category: null,
      },
      data: { reviews: overrides.reviews ?? [] },
      evidenceOnly: true,
    },
  } as unknown as SourceEvidenceAttachment;
}

const REAL_REVIEWS = [
  { reviewId: "R1TEST0001", body: "Great gloves, fit well and durable.", rating: 5, reviewDate: "2026-09-01" },
];

describe("PH4-R1 来源门禁：负例必须 fail-closed", () => {
  it("商品身份不匹配 → REJECT（不得进入研究）", () => {
    const att = reviewAttachment({ subjectKey: "amazon:US:B0OTHER999", identityAsin: "B0OTHER999", reviews: REAL_REVIEWS });
    expect(adaptV3ReviewAttachment(att, SUBJECT)).toBeNull();
  });

  it("identity.asin 与 subjectKey 不一致 → REJECT", () => {
    const att = reviewAttachment({ identityAsin: "B0MISMATCH1" });
    expect(adaptV3ReviewAttachment(att, SUBJECT)).toBeNull();
  });

  it("没有评论正文 → 不生成任何 Review sample", () => {
    // 空数组
    expect(adaptV3ReviewAttachment(reviewAttachment({ reviews: [] }), SUBJECT)).toBeNull();
    // 有行但无正文（不得拿商品介绍或 AI 摘要填充）
    const noBody = reviewAttachment({ reviews: [{ reviewId: "R1X", title: "Great", rating: 5 }] });
    expect(adaptV3ReviewAttachment(noBody, SUBJECT)).toBeNull();
    // 只有 Amazon AI 摘要字段 → 不得冒充真人评论
    const aiSummaryOnly = reviewAttachment({
      reviews: [{ customersSay: "Customers find these gloves good quality and comfortable." }],
    });
    expect(adaptV3ReviewAttachment(aiSummaryOnly, SUBJECT)).toBeNull();
  });

  it("评分缺失 → 保留 null，不猜评分", () => {
    const att = reviewAttachment({
      reviews: [{ reviewId: "R1NORATING", body: "Fine gloves." }],
    });
    const adapted = adaptV3ReviewAttachment(att, SUBJECT);
    expect(adapted).not.toBeNull();
    expect(adapted!.samples[0].rating).toBeNull();
    expect(adapted!.samples[0].text).toBe("Fine gloves.");
  });

  it("日期缺失 → 不编造日期", () => {
    const att = reviewAttachment({ reviews: [{ reviewId: "R1NODATE", body: "Fine.", rating: 4 }] });
    const adapted = adaptV3ReviewAttachment(att, SUBJECT);
    expect(adapted).not.toBeNull();
    expect(adapted!.samples[0].rating).toBe(4);
  });

  it("评论 ID 重复 → 不虚增计数（duplicateKey 幂等）", () => {
    const a = buildReviewDuplicateKey({ reviewId: "R1TEST0001", asin: "B00GS8VIKE", contentHash: "h1", rating: 5, reviewDate: "2026-09-01" });
    const b = buildReviewDuplicateKey({ reviewId: "R1TEST0001", asin: "B00GS8VIKE", contentHash: "h1", rating: 5, reviewDate: "2026-09-01" });
    expect(a).toBe(b);
    expect(new Set([a, b]).size).toBe(1);
  });

  it("无 reviewId 时按 asin+hash+rating+date 去重；不同内容不去重", () => {
    const base = { asin: "B00GS8VIKE", rating: 5, reviewDate: "2026-09-01" };
    const x = buildReviewDuplicateKey({ ...base, reviewId: null, contentHash: "h1" });
    const y = buildReviewDuplicateKey({ ...base, reviewId: null, contentHash: "h1" });
    const z = buildReviewDuplicateKey({ ...base, reviewId: null, contentHash: "h2" });
    expect(x).toBe(y);
    expect(x).not.toBe(z);
  });

  it("LOGIN_REQUIRED → 明确状态且不产生成功结果", () => {
    expect(reviewBlockForPageStatus("login_wall")).toMatchObject({ status: "login_required" });
  });

  it("CAPTCHA / 自动化拦截 → captcha_required 且不绕过", () => {
    expect(reviewBlockForPageStatus("captcha")).toMatchObject({ status: "captcha_required" });
    expect(reviewBlockForPageStatus("automation_blocked")).toMatchObject({ status: "captcha_required" });
  });

  it("EXTRACTION_EMPTY 不得被解释为零评论（状态与 confirmed_no_reviews 分离）", () => {
    // 采集器的两种不同状态必须保持可区分
    expect(reviewBlockForPageStatus("unknown_page")).toBeNull();
    // 正式枚举中 extraction_empty 与 confirmed_no_reviews 是不同值
    const statuses = [
      "ok", "blocked_redirect", "login_required", "captcha_required", "page_error",
      "page_unknown", "confirmed_no_reviews", "extraction_empty", "no_reviews_extracted", "error",
    ];
    expect(new Set(statuses).size).toBe(statuses.length);
    expect(statuses).toContain("extraction_empty");
    expect(statuses).toContain("confirmed_no_reviews");
  });

  it("不可验证来源（BLOCKED 状态 / 非法 ASIN）→ Fail-Closed", () => {
    expect(adaptV3ReviewAttachment(reviewAttachment({ status: "BLOCKED_WITH_EVIDENCE", reviews: REAL_REVIEWS }), SUBJECT)).toBeNull();
    expect(isValidAsin("B00GS8VIKE")).toBe(true);
    expect(isValidAsin("NOT-AN-ASIN")).toBe(false);
  });

  it("合法评论仍能通过（门禁不得把真实内容也拒掉）", () => {
    const att = reviewAttachment({ reviews: REAL_REVIEWS });
    const adapted = adaptV3ReviewAttachment(att, SUBJECT);
    expect(adapted).not.toBeNull();
    expect(adapted!.samples).toHaveLength(1);
    expect(adapted!.samples[0].text).toBe("Great gloves, fit well and durable.");
    expect(adapted!.samples[0].rating).toBe(5);
  });
});