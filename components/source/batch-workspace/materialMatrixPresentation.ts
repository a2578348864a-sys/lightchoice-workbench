import type { GalleryItem } from "./presentation";
import type { ProvenanceItemModule } from "../source-provenance/sourceProvenanceModel";
import { PROVENANCE_BASIC_MODULES, PROVENANCE_SUPPLEMENTARY_MODULES, PROVENANCE_MODULE_LABELS } from "../source-provenance/sourceProvenanceModel";
import { MODULE_LIMITATION_LABELS } from "./modulePresentation";

export const MATRIX_GROUPS = { basic: PROVENANCE_BASIC_MODULES, supplementary: PROVENANCE_SUPPLEMENTARY_MODULES };
export type MatrixIssue = "all" | "human" | "partial" | "blocked" | "failed" | "missing" | "not_in_scope";
export type MatrixFilter = { group: "basic" | "supplementary"; module: string; issue: MatrixIssue };
export const DEFAULT_MATRIX_FILTER: MatrixFilter = { group: "basic", module: "all", issue: "all" };
export type MatrixItem = GalleryItem & { moduleCoverage?: ProvenanceItemModule[] };
export type MatrixLocation = { itemId: string; module: string; token: number };
export type ExternalMatrixEvidence = { subjects: { subjectKey: string; module: string; attachmentCount: number; latestCapturedAt: string | null }[]; totals: { failures: { subjectKey: string; module: string | null; message: string }[] } };
export type MatrixReading = { state: "idle" | "loading" | "ready" | "error"; data?: ExternalMatrixEvidence; error?: string };
export type MatrixCell = { state: "complete" | "partial" | "limited" | "human" | "blocked" | "failed" | "missing" | "not_in_scope" | "unknown" | "read_error" | "query"; label: string; reason: string; hasEvidence: boolean; evidenceId: string | null; query: boolean; inScope: boolean | null };

/** Scope comes from the existing capture-plan/external-evidence contracts, not a guess from labels. */
export function matrixSubjectScope(module: string): "product" | "search_association" | "batch_query" | "file" {
  if (module === "amazon_search_market") return "search_association";
  if (["sellersprite_product_market", "keyword_mining_trend"].includes(module)) return "batch_query";
  if (module === "historical_trend") return "file";
  return "product";
}

function readableReason(code: string): string {
  const normalized = code.toLowerCase();
  if (normalized === "captcha_detected") return "需要人工处理验证码；矩阵不会自动重试或绕过。";
  if (normalized === "local_environment_required") return "需要本机采集环境，请到运行详情核对浏览器与启动配置。";
  return MODULE_LIMITATION_LABELS[normalized] ?? "存在来源限制，具体原始原因可在对应证据或运行详情核对。";
}

export function materialCell(item: MatrixItem, module: string, allowed: readonly string[] | null, reading?: MatrixReading): MatrixCell {
  const entry = item.moduleCoverage?.find(e => e.module === module);
  const evidenceId = entry?.evidenceId ?? null;
  const query = matrixSubjectScope(module) === "batch_query";
  const inScope = allowed === null ? null : module === "amazon_search_market" ? null : allowed.includes(module);
  const base = { evidenceId, hasEvidence: Boolean(evidenceId) && !query, query, inScope };
  const supplementary = (PROVENANCE_SUPPLEMENTARY_MODULES as readonly string[]).includes(module);
  const subjectKey = `amazon:${(item.marketplace || "US").toUpperCase()}:${item.asin}`;
  const failure = reading?.data?.totals.failures.find(f => (query ? f.module === module : f.subjectKey === subjectKey && (!f.module || f.module === module)));
  if (supplementary && (reading?.state === "error" || failure)) return { ...base, state: "read_error", label: "读取失败", reason: "补充资料读取失败，不代表没有证据；请重新读取。" };
  if (query) {
    const queries = reading?.data?.subjects.filter(s => s.module === module && !s.subjectKey.startsWith("amazon:")) ?? [];
    const references = queries.reduce((sum, q) => sum + q.attachmentCount, 0);
    return { ...base, hasEvidence: false, state: inScope === false ? "not_in_scope" : "query", label: inScope === false ? "本轮未授权" : "批次共用", reason: `${PROVENANCE_MODULE_LABELS[module]}属于批次或关键词查询，不能算作本商品独立取得的资料。${reading?.state === "ready" ? `已读取 ${queries.length} 个查询主体、${references} 条附件记录。` : "查询附件情况尚未确认。"}${inScope === false ? "未纳入本轮授权范围，不代表账号套餐无权限。" : ""}` };
  }
  const externalSubject = reading?.data?.subjects.find(subject => subject.subjectKey === subjectKey && subject.module === module);
  if (!base.hasEvidence && externalSubject && externalSubject.attachmentCount > 0) return { ...base, state: "unknown", label: "附件待核对", reason: `来源已读到 ${externalSubject.attachmentCount} 条附件，但当前商品投影缺少对应引用；请重新读取商品，不推断资料完整。` };
  // Keep historical evidence visible even when the module is not authorized in the current run.
  if (!base.hasEvidence && inScope === false) return { ...base, state: "not_in_scope", label: "本轮未授权", reason: "该资料未纳入本轮采集授权；不会因查看矩阵而自动执行。已有历史证据仍按其真实状态展示。" };
  if (!entry) return { ...base, state: "unknown", label: "状态未读取", reason: "当前返回缺少此模块的商品状态，不能推断为未采集或完整。" };
  const failedAttempt = entry.latestAttempt && /^failed_(retryable|permanent)$/i.test(entry.latestAttempt.status);
  const attemptNewer = entry.latestAttempt && Number.isFinite(Date.parse(entry.latestAttempt.attemptedAt)) && entry.capturedAt && Date.parse(entry.latestAttempt.attemptedAt) > Date.parse(entry.capturedAt);
  const humanAttempt = entry.latestAttempt && ["failed_human", "human_action_required", "login_required", "extension_required"].includes(entry.latestAttempt.status.toLowerCase());
  if (humanAttempt && (!base.hasEvidence || attemptNewer)) return { ...base, state: "human", label: "需人工", reason: `${base.hasEvidence ? "最新尝试需要人工处理，历史附件仍保留。" : "当前尝试需要人工处理。"}${readableReason(entry.latestAttempt!.errorCode ?? "captcha_requires_human")}` };
  if (failedAttempt && (!base.hasEvidence || attemptNewer)) return { ...base, state: "failed", label: "尝试失败", reason: `${base.hasEvidence ? "最新尝试失败，历史附件仍保留。" : "采集尝试失败，未取得证据。"}${readableReason(entry.latestAttempt!.errorCode ?? "capture_attempt_failed")}` };
  const reason = entry.limitations.length ? entry.limitations.map(readableReason).join("；") : entry.errorCode ? readableReason(entry.errorCode) : null;
  switch (entry.status) {
    case "COMPLETE": return base.hasEvidence ? { ...base, state: "complete", label: "完整", reason: "已有商品资料附件，完整状态来自已保存投影；不表示已经人工确认或取得研究资格。" } : { ...base, state: "unknown", label: "状态待核对", reason: "记录标记完成，但当前缺少证据引用，不能认定资料完整。" };
    case "CAPTURED_PARTIAL": return { ...base, state: "partial", label: "部分完成", reason: reason ?? "已取得部分资料，仍有字段或来源缺口；可查看对应证据。" };
    case "NO_DATA_WITH_EVIDENCE": return { ...base, state: "partial", label: "无有效数据", reason: reason ?? "有证据附件，但没有取得有效资料；不能当作资料完整。" };
    case "AVAILABLE_WITH_LIMITATION": case "PLAN_LIMITED": return { ...base, state: "limited", label: entry.status === "PLAN_LIMITED" ? "套餐受限" : "来源受限", reason: reason ?? "存在来源或套餐限制，不能由矩阵绕过。" };
    case "HUMAN_ACTION_REQUIRED": case "FAILED_HUMAN": case "LOGIN_REQUIRED": case "EXTENSION_REQUIRED": return { ...base, state: "human", label: entry.status === "LOGIN_REQUIRED" ? "需要登录" : entry.status === "EXTENSION_REQUIRED" ? "需要插件" : "需人工", reason: reason ?? "需要人工处理来源页面；不会自动登录、绕过验证码或修改浏览器设置。" };
    case "BLOCKED_WITH_EVIDENCE": return { ...base, state: "blocked", label: "受阻", reason: reason ?? "本资料目前受阻。已存附件不代表取得了完整数据。" };
    case "NOT_COLLECTED": return { ...base, state: "missing", label: "未采集", reason: inScope === null ? "尚无采集资料，本轮授权范围也尚未确认。" : "尚无采集资料；不会通过点击矩阵自动发起采集。" };
    default: return { ...base, state: "unknown", label: "状态待核对", reason: "当前状态无法确认，请核对原始记录。" };
  }
}

export function matchesMaterialFilter(item: MatrixItem, filter: MatrixFilter, allowed: readonly string[] | null): boolean {
  if (filter.issue === "all") return true;
  const modules = filter.module === "all" ? MATRIX_GROUPS[filter.group] : [filter.module];
  return modules.some(module => {
    const cell = materialCell(item, module, allowed);
    return filter.issue === "blocked" ? cell.state === "blocked" || cell.state === "limited" : filter.issue === cell.state;
  });
}

/** These are reference counts, not independent source counts. */
export function sharedMaterialReferences(items: readonly MatrixItem[], evidenceId: string | null): number {
  if (!evidenceId) return 0;
  return items.filter(item => item.moduleCoverage?.some(e => e.evidenceId === evidenceId)).length;
}
