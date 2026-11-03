import type { ProductBriefBenchmarkComparison, ProductBriefComparisonRow } from "./contract";

/**
 * 竞品-本品对照没有逐字段 evidenceRefs，无法证明人工填写的本品/对照基准值。
 * 因此：
 * - 所有对照行在 Brief 中都只能作为待确认假设，不能标为 FACT；
 * - 只有服务端已存的来源备注可以保留为「来源对照记录（待确认）」；
 * - 人工新增或改动内容时替换为人工假设说明，不继承来源身份。
 * 历史版本不被改写；页面与 Markdown 只做只读投影。
 */

export const SOURCE_COMPARISON_NOTE_PREFIX = "对照资料来自研究来源商品";
export const HUMAN_COMPARISON_NOTE = "人工新增或修改的对照内容；不是来源确认事实，待核实。";

type ComparisonContent = Pick<ProductBriefComparisonRow, "label" | "ours" | "theirs">;

export function isSourceComparisonNote(note: string | null | undefined): boolean {
  return typeof note === "string" && note.trim().startsWith(SOURCE_COMPARISON_NOTE_PREFIX);
}

export function comparisonOriginLabel(row: Pick<ProductBriefComparisonRow, "note">): string {
  return isSourceComparisonNote(row.note) ? "来源对照记录（待确认）" : "待确认假设";
}

export function comparisonContentChanged(previous: ComparisonContent, next: ComparisonContent): boolean {
  return previous.label !== next.label
    || (previous.ours ?? null) !== (next.ours ?? null)
    || (previous.theirs ?? null) !== (next.theirs ?? null);
}

/** 只接受维度、本品、对照基准三类内容修改；性质、备注与 ID 由服务端决定。 */
export function applyComparisonContentPatch(row: ProductBriefComparisonRow, patch: Partial<ProductBriefComparisonRow>): ProductBriefComparisonRow {
  const content = {
    label: patch.label ?? row.label,
    ours: patch.ours !== undefined ? patch.ours : row.ours,
    theirs: patch.theirs !== undefined ? patch.theirs : row.theirs,
  };
  const next = { ...row, ...content };
  if (!comparisonContentChanged(row, next)) return { ...row, nature: "ASSUMPTION" };
  return { ...row, ...content, nature: "ASSUMPTION", note: HUMAN_COMPARISON_NOTE };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function incomingContent(value: unknown): ComparisonContent & { id: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.label !== "string") return null;
  return { id: record.id, label: record.label, ours: textOrNull(record.ours), theirs: textOrNull(record.theirs) };
}

/**
 * 服务端保存前使用：与当前已存对照行逐行比较。
 * - 新增行：假设 + 人工说明，不接受客户端自报来源备注；
 * - 内容未变：沿用服务端已存备注（可为来源记录），但性质固定为假设；
 * - 内容变化：假设 + 人工说明，不再保留来源记录身份；
 * - 重复 ID 被丢弃，不制造第二份对照身份。
 */
export function sanitizeIncomingBenchmarkComparison(
  incoming: unknown,
  previous: ProductBriefBenchmarkComparison | undefined,
): unknown {
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) return incoming;
  const rows = (incoming as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return incoming;
  const previousById = new Map((previous?.rows ?? []).map((row) => [row.id, row]));
  const seen = new Set<string>();
  const sanitized: unknown[] = [];
  for (const raw of rows) {
    const parsed = incomingContent(raw);
    if (!parsed) {
      sanitized.push(raw);
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    const before = previousById.get(parsed.id);
    if (!before) {
      sanitized.push({ ...parsed, nature: "ASSUMPTION", note: HUMAN_COMPARISON_NOTE });
      continue;
    }
    if (comparisonContentChanged(before, parsed)) {
      sanitized.push({ id: before.id, label: parsed.label, ours: parsed.ours, theirs: parsed.theirs, nature: "ASSUMPTION", note: HUMAN_COMPARISON_NOTE });
      continue;
    }
    sanitized.push({ ...before, nature: "ASSUMPTION" });
  }
  return { rows: sanitized };
}
