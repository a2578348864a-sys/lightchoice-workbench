import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import type { GateStatus, Role } from "./data";

/** Read-only presentation contracts. No inferred product facts or gate decisions. */
export type ScanReadModel = {
  id: string; scanName: string; marketplace: string; sampleCount: number;
  sampleHash: string; resourceVersion: string; createdAt: string; archivedAt?: string | null;
  sampleItems: Array<{ asin: string; subjectKey: string; title: string | null; imageUrl: string | null;
    price: number | null; priceCurrency?: string | null; rating: number | null; reviewCount: number | null;
    marketScope?: { status: string; reason: string }; scopeReview?: { reviewStatus: string; reviewStale: boolean } }>;
  marketGate?: { status: GateStatus; effectiveStatus: GateStatus; stale: boolean; staleReason?: string | null;
    reason: string | null; missingDataAcknowledged: boolean };
  marketWorkflow?: { stale: boolean; effectiveGateStatus: GateStatus; metadata?: { researchQuestion?: string } };
  decisionReadiness?: { status: string; blockers: Array<{ code: string; label: string; detail: string }>;
    acknowledgeableMissing: Array<{ code: string; label: string; detail: string }> };
  representatives?: { items: Array<{ asin: string; subjectKey: string; role: Role; note: string | null }> };
  /** 服务端交接可用性；缺失时按不可交接处理。 */
  handoffEligible?: boolean;
};
export type RecentResearch = { id: string; name: string; site: string; count: number;
  image: string | null; asin: string | null; gate: GateStatus; stale: boolean };
export type ResearchReadData = { scan: ScanReadModel | null; intelligence: MarketIntelligence | null;
  recent: RecentResearch[]; error: string | null; intelligenceError: string | null };
export const emptyResearchData: ResearchReadData = { scan: null, intelligence: null, recent: [], error: null, intelligenceError: null };

export function effectiveGate(scan: ScanReadModel | null): GateStatus {
  if (!scan || scan.marketGate?.stale || scan.marketWorkflow?.stale) return "PENDING";
  return scan.marketGate?.effectiveStatus ?? scan.marketWorkflow?.effectiveGateStatus ?? "PENDING";
}
export function gateSaveBlocked(scan: ScanReadModel | null, choice: GateStatus | null, reason: string, ack: boolean): string | null {
  if (!scan) return "研究对象尚未加载，无法保存。";
  if (scan.archivedAt) return "研究已归档，不能修改判断。";
  if (!scan.sampleHash || !scan.resourceVersion) return "缺少当前样本与版本信息，请刷新后重试。";
  if (!choice || choice === "PENDING") return "请选择一种人工决定；PENDING 不是已作出的决定。";
  if (reason.trim().length < 4) return "请填写至少 4 个字的判断理由。";
  if (!ack) return "请先阅读并确认风险与缺失项。";
  if (choice === "PROCEED" && !scan.decisionReadiness) return "就绪条件尚未读取，不能确认继续。";
  if (choice === "PROCEED" && scan.decisionReadiness?.blockers.length) return "仍有硬阻塞，请先解决或选择补充证据。";
  return null;
}
export function comparisonKind(left: unknown, right: unknown): "unknown" | "same" | "diff" {
  if (left == null || right == null || left === "" || right === "") return "unknown";
  return JSON.stringify(left) === JSON.stringify(right) ? "same" : "diff";
}
export function uniqueReviewProducts(data: MarketIntelligence | null): number {
  const samples = new Set(data?.samples.map(s => s.subjectKey) ?? []);
  return new Set((data?.reviews.flatMap(r => r.subjectKeys?.length ? r.subjectKeys : [r.subjectKey]) ?? []).filter(s => samples.has(s))).size;
}
export function subjectReviews(data: MarketIntelligence | null, subjectKey: string) {
  return data?.reviews.filter(r => r.subjectKey === subjectKey || r.subjectKeys?.includes(subjectKey)) ?? [];
}
export function latestVoiceReport(data: MarketIntelligence | null) {
  return data?.reports.filter(r => r.voiceThemes?.length).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0] ?? null;
}
export function linkedThemeReviews(data: MarketIntelligence, ids: string[]) {
  const wanted = new Set(ids);
  return data.reviews.filter(r => r.id && wanted.has(r.id));
}
