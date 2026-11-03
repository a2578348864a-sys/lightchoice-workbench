/**
 * 探索台 → 02 市场竞争的价格带筛选交接。
 * 只传递「本次点击的价格带闭区间」，由 02 页在挂载时读取一次；
 * 不写回样本、不改变选择角色或人工决定。
 */
export type CompetitionBandHandoff = {
  label: string;
  min: number;
  max: number;
  count: number;
};

let pending: CompetitionBandHandoff | null = null;

export function setCompetitionBandHandoff(value: CompetitionBandHandoff): void {
  pending = value;
}

export function peekCompetitionBandHandoff(): CompetitionBandHandoff | null {
  return pending;
}

export function clearCompetitionBandHandoff(): void {
  pending = null;
}
