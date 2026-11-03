import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatTeamRecommendationPullFeedback } from "@/lib/client/feishuTeamRecommendation";
// Service bucket accounting is exercised against real Prisma + migrations in p7DecisionFeishu.acceptance.test.ts.
describe("production Pull feedback uses actual recommendation semantics", () => {
  it("states that pending recommendations do not change final decisions", () => {
    const feedback = formatTeamRecommendationPullFeedback({ scannedRecords: 14, recommendationsReceived: 4, unchanged: 2, pendingReview: 7, failedOrSkipped: 1 });
    expect(feedback.type).toBe("warning"); expect(feedback.message).toContain("接收待终审建议 4 条"); expect(feedback.message).toContain("最终决策保持不变"); expect(feedback.message).not.toContain("更新本地");
    for (const path of ["components/research/ResearchDetailClient.tsx", "components/research/ResearchListClient.tsx"]) expect(readFileSync(path, "utf8")).toContain("formatTeamRecommendationPullFeedback(data)");
  });
  it("mismatched or unavailable data cannot display unconditional success", () => {
    expect(formatTeamRecommendationPullFeedback({ scannedRecords: 1, recommendationsReceived: 0 }).type).toBe("warning");
    expect(formatTeamRecommendationPullFeedback({ scannedRecords: 0, conceptStatus: "UNAVAILABLE" }).type).toBe("warning");
    expect(formatTeamRecommendationPullFeedback({ scannedRecords: 11, recommendationsReceived: 0, unchanged: 0, pendingReview: 11, failedOrSkipped: 0 }).type).toBe("success");
  });
});
