import type { RowSelectionState } from "@tanstack/react-table";

/**
 * D0-001：批量操作对象身份必须是稳定业务 ID（scanId/taskId），禁止用行号。
 *
 * 约定（两个列表统一策略）：
 * - 选中集合的 key 一律是业务 ID（DataTable 需要传入 getRowId）；
 * - 解析选中对象时在「完整数据集」上按 ID 过滤，而不是在筛选后的数组按下标反查，
 *   因此搜索/排序/翻页不会改变已确认的选中对象；
 * - 刷新后的数据集中已不存在的 ID（被删除、跨视角消失）统一清除，
 *   避免向服务端提交已失效对象的过期版本。
 */
export function resolveSelectedItems<T>(
  selection: RowSelectionState,
  items: readonly T[],
  getItemId: (item: T) => string,
): T[] {
  const selectedIds = new Set(Object.keys(selection).filter((key) => selection[key] === true));
  if (selectedIds.size === 0) return [];
  return items.filter((item) => selectedIds.has(getItemId(item)));
}

/** 返回清理后的选中集合；无失效 ID 时返回原对象（避免无谓重渲染）。 */
export function pruneSelection<T>(
  selection: RowSelectionState,
  items: readonly T[],
  getItemId: (item: T) => string,
): RowSelectionState {
  const validIds = new Set(items.map(getItemId));
  const entries = Object.entries(selection);
  let changed = false;
  const next: RowSelectionState = {};
  for (const [id, selected] of entries) {
    if (selected !== true) {
      if (selected !== false) changed = true;
      continue;
    }
    if (validIds.has(id)) {
      next[id] = true;
    } else {
      changed = true;
    }
  }
  return changed ? next : selection;
}
