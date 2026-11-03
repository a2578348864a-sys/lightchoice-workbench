import { describe, expect, it } from "vitest";
import type { ResearchEngineInput } from "@/lib/research/researchContracts";
import { authoritativeCommentStats, extractStarClaims, reviewStarClaims } from "./researchFactConsistency";

/**
 * 权威口径固定为「本次实际读到的评论凭据」：#5 = 9 条（7 条 5 星 + 2 条 4 星）。
 * 下面用的摘要句、voc 句都是 #5 真实报告里的原句，不是编的样例。
 */

type Obs = { id?: string | null; rating: number | null; source?: string; contentHash?: string };

function bundleWith(attachments: Obs[][]): ResearchEngineInput {
  return {
    researchInputBundle: {
      customerVoiceEvidence: attachments.map((observations, attachmentIndex) => ({
        attachmentId: `att-${attachmentIndex}`,
        contentHash: `${attachmentIndex}`.padEnd(64, "0"),
        omittedCount: 0,
        observations: observations.map((observation, index) => ({
          externalContentId: observation.id === undefined ? `amazon-content:c${attachmentIndex}-${index}` : observation.id,
          rating: observation.rating,
          source: observation.source ?? "amazon_dom",
          contentHash: observation.contentHash ?? `${attachmentIndex}${index}`.padEnd(64, "0"),
          text: `comment ${attachmentIndex}-${index}`,
          limitations: ["public_top_reviews_only"],
        })),
      })),
    },
  } as unknown as ResearchEngineInput;
}

const CASE5 = bundleWith([[
  { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 },
  { rating: 4 }, { rating: 4 },
]]);

const SUMMARY_TEXT = "评论白名单仅 9 条公开置顶评论（8 条 5 星、1 条 4 星、1 条 4 星，omittedCount=0），样本极小且为置顶筛选，不能代表全体买家。";
const VOC_TEXT = "当前白名单评论凭据仅 1 个附件、9 条公开置顶评论，omittedCount=0，来源限制为 public_top_reviews_only：其中 7 条 5 星、2 条 4 星，无 1–3 星样本。";

describe("评论星级统计：身份与去重", () => {
  it("权威统计：#5 = 9 条（7×5 星 + 2×4 星），无重复、无冲突", () => {
    const stats = authoritativeCommentStats(CASE5);
    expect(stats.total).toBe(9);
    expect(stats.byRating).toEqual({ "1": 0, "2": 0, "3": 0, "4": 2, "5": 7, unknown: 0 });
    expect(stats.duplicatesMerged).toBe(0);
    expect(stats.unidentifiedCount).toBe(0);
    expect(stats.conflicts).toEqual([]);
    expect(stats.reliable).toBe(true);
    expect(stats.limitations).toContain("public_top_reviews_only");
  });

  it("同一条评论出现在两个附件：只计一次，并记录合并数", () => {
    const stats = authoritativeCommentStats(bundleWith([
      [{ id: "amazon-content:x1", rating: 5, contentHash: "a".repeat(64) }, { id: "amazon-content:x2", rating: 4 }],
      [{ id: "amazon-content:x1", rating: 5, contentHash: "a".repeat(64) }],
    ]));
    expect(stats.total).toBe(2);
    expect(stats.byRating["5"]).toBe(1);
    expect(stats.byRating["4"]).toBe(1);
    expect(stats.duplicatesMerged).toBe(1);
    expect(stats.reliable).toBe(true);
  });

  it("同 ID 不同来源视为不同评论（身份键含 source）", () => {
    const stats = authoritativeCommentStats(bundleWith([[
      { id: "same-id", rating: 5, source: "amazon_dom" },
      { id: "same-id", rating: 5, source: "reddit" },
    ]]));
    expect(stats.total).toBe(2);
    expect(stats.duplicatesMerged).toBe(0);
  });

  it("同 ID 不同星级：记为冲突且统计不可作为权威依据", () => {
    const stats = authoritativeCommentStats(bundleWith([
      [{ id: "amazon-content:dup", rating: 5 }],
      [{ id: "amazon-content:dup", rating: 3 }],
    ]));
    expect(stats.reliable).toBe(false);
    expect(stats.conflicts.map((item) => item.code)).toContain("DUPLICATE_CONFLICTING_RATING");
    expect(stats.duplicateExternalIds).toContain("amazon_dom|amazon-content:dup");
  });

  it("缺失评论身份：计入未识别，不伪造身份，统计不可作为权威依据", () => {
    const stats = authoritativeCommentStats(bundleWith([[
      { id: null, rating: 5 }, { id: "", rating: 4 },
    ]]));
    expect(stats.total).toBe(0);
    expect(stats.unidentifiedCount).toBe(2);
    expect(stats.reliable).toBe(false);
    expect(stats.conflicts.every((item) => item.code === "MISSING_IDENTITY")).toBe(true);
  });

  it("没有任何评论证据：0 条、可靠（不是错误）", () => {
    const stats = authoritativeCommentStats(bundleWith([]));
    expect(stats.total).toBe(0);
    expect(stats.reliable).toBe(true);
    expect(reviewStarClaims("本次样本没有评论。", stats)).toBeNull();
  });
});

describe("评论星级统计：声明解析与判错", () => {
  it("#5 摘要原句仍被识别（8 条 5 星 ≠ 7；1 条 4 星 ≠ 2）", () => {
    const review = reviewStarClaims(SUMMARY_TEXT, authoritativeCommentStats(CASE5));
    expect(review).not.toBeNull();
    expect(review!.codes).toContain("STAR_DISTRIBUTION_MISMATCH");
    // 总数 9 是对的，不得因分项写重而误报总数不一致。
    expect(review!.codes).not.toContain("STAR_TOTAL_MISMATCH");
    expect(review!.reasons.join()).toContain("声称 5 星 8 条，权威证据为 7 条");
    expect(review!.reasons.join()).toContain("声称 4 星 1 条，权威证据为 2 条");
  });

  it("#5 vocAnalysis 原句是对的，不得误判", () => {
    expect(reviewStarClaims(VOC_TEXT, authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("不完整分布不是错误：「共 9 条，其中 7 条五星」", () => {
    expect(reviewStarClaims("本次样本共 9 条评论，其中 7 条五星。", authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("同一事实重复表述不累加：「7 条五星……这 7 条五星」", () => {
    const text = "本次样本 9 条评论中有 7 条五星。进一步看，这 7 条五星评论主要提到替代烘焙纸。";
    expect(reviewStarClaims(text, authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("不完整分布里的单个星级数量仍要判错：「共 9 条，其中 8 条五星」", () => {
    const review = reviewStarClaims("本次样本共 9 条评论，其中 8 条五星。", authoritativeCommentStats(CASE5));
    expect(review).not.toBeNull();
    expect(review!.codes).toContain("STAR_DISTRIBUTION_MISMATCH");
  });

  it("商品累计评价数不是样本数：「该商品累计 502 条评论」不得判错", () => {
    expect(reviewStarClaims("该商品累计 502 条评论，评分 4.7。", authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("样本总数写错时才报总数不一致", () => {
    const review = reviewStarClaims("本次白名单样本共 12 条评论，其中 7 条 5 星、2 条 4 星。", authoritativeCommentStats(CASE5));
    expect(review).not.toBeNull();
    expect(review!.codes).toContain("STAR_TOTAL_MISMATCH");
    expect(review!.codes).not.toContain("STAR_DISTRIBUTION_MISMATCH");
  });

  it("单条引用不是分布声明：「5 星评论称……」不得判错", () => {
    expect(reviewStarClaims("5 星评论称「If you are still buying parchment paper you really need these!」。", authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("统计不可靠时只提示人工核对，不宣布报告写错", () => {
    const unreliable = authoritativeCommentStats(bundleWith([
      [{ id: "amazon-content:dup", rating: 5 }],
      [{ id: "amazon-content:dup", rating: 3 }],
    ]));
    const review = reviewStarClaims(SUMMARY_TEXT, unreliable);
    expect(review).not.toBeNull();
    expect(review!.codes).toEqual(["STAR_STATISTICS_UNRELIABLE"]);
    expect(review!.reasons.join()).toContain("需人工核对");
  });

  it("中文数字与两种语序都能解析", () => {
    const chinese = extractStarClaims("共 9 条评论，其中两条四星、七条五星");
    expect(chinese.total).toBe(9);
    expect(chinese.claims.map((claim) => [claim.star, claim.count])).toEqual([[4, 2], [5, 7]]);
    const reverse = extractStarClaims("5 星 7 条，4 星 2 条");
    expect(reverse.claims.map((claim) => [claim.star, claim.count])).toEqual([[5, 7], [4, 2]]);
  });

  // 2026-10-29：子样本统计不能与全样本比较。
  // 「讨论清洁问题的 3 条中有 2 条五星」不是「全样本只有 2 条五星」。
  it("子样本正确统计：不与全样本比较", () => {
    const text = "本次研究共有 9 条评论。其中 3 条讨论清洁问题，这 3 条中有 2 条五星。";
    expect(reviewStarClaims(text, authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("子样本星级数小于全样本：不误判", () => {
    const text = "本次样本 9 条评论。其中 2 条提到尺寸问题，这 2 条均为 5 星。";
    expect(reviewStarClaims(text, authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("子样本内部自相矛盾：只提示人工复核，不当成全样本事实错误", () => {
    const text = "本次样本 9 条评论。其中 3 条讨论清洁问题，这 3 条中有 2 条五星、2 条四星。";
    const review = reviewStarClaims(text, authoritativeCommentStats(CASE5));
    expect(review).not.toBeNull();
    expect(review!.codes).toEqual(["STAR_SUBSAMPLE_INCONSISTENT"]);
    expect(review!.reasons.join()).toContain("子样本内部自相矛盾");
  });

  it("指代不明（裸「其中有 2 条五星」）：不做确定性判错", () => {
    expect(reviewStarClaims("其中有 2 条五星。", authoritativeCommentStats(CASE5))).toBeNull();
  });

  it("「这 9 条评论中 8 条五星」仍是全样本声明，必须判错", () => {
    const review = reviewStarClaims("这 9 条评论中，8 条五星。", authoritativeCommentStats(CASE5));
    expect(review).not.toBeNull();
    expect(review!.codes).toContain("STAR_DISTRIBUTION_MISMATCH");
  });

  it("没有可核实声明时返回 null（不判错，也不假装通过）", () => {
    expect(reviewStarClaims("样本极小，不能代表全体买家。", authoritativeCommentStats(CASE5))).toBeNull();
    expect(reviewStarClaims("无 1–3 星样本", authoritativeCommentStats(CASE5))).toBeNull();
  });
});
