import { teamRecommendationToCanonical, getDecisionStatusDisplay } from "@/lib/types/v5DecisionStatus";

export type TeamRecommendationView = {
  id: string; status: string; recommendationStatus: string; reason?: string; reviewerIdentity?: string;
  reviewedAt?: string; stale?: boolean;
};
export function teamRecommendationLabel(value: unknown): string {
  const status = teamRecommendationToCanonical(value);
  return status ? getDecisionStatusDisplay(status).label : "建议值无法识别";
}
export function formatTeamRecommendationPullFeedback(data: Record<string, unknown>) {
  const count = (key: string) => typeof data[key] === "number" && Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 ? Number(data[key]) : 0;
  const scanned = count("scannedRecords"), received = count("recommendationsReceived"), unchanged = count("unchanged");
  const pending = count("pendingReview"), failed = count("failedOrSkipped");
  const mismatch = scanned !== received + unchanged + pending + failed;
  const unavailable = data.conceptStatus === "UNAVAILABLE";
  return { type: failed > 0 || mismatch || unavailable ? "warning" as const : "success" as const,
    message: `飞书端建议检查完成：扫描 ${scanned} 条，接收待终审建议 ${received} 条，内容无变化 ${unchanged} 条，飞书尚未审核 ${pending} 条，失败或跳过 ${failed} 条。最终决策保持不变，请在 Workbench 明确确认或自行选择。${unavailable ? "可选概念表暂不可用。" : ""}${mismatch ? "扫描统计未对账，请检查诊断记录。" : ""}` };
}
