/**
 * MarketScan V1 的唯一金额有效性规则。
 *
 * 金额只有在「有限正数 + 三位大写 ISO 币种」同时成立时才是事实；
 * 其它形态统一视为 missing，禁止投影层与指标 fallback 各自定义规则。
 */
export type MarketMoneyValueV1 = {
  readonly amount: number;
  readonly currency: string;
};

export function isValidMarketMoneyValue(value: unknown): value is MarketMoneyValueV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.amount === "number"
    && Number.isFinite(candidate.amount)
    && candidate.amount > 0
    && typeof candidate.currency === "string"
    && /^[A-Z]{3}$/u.test(candidate.currency);
}
