/**
 * Amazon 页面「计数」文本 → 整数（评分条数 / 累计评价数 / 购买次数等）。
 *
 * 真实失败案例（2026-10-13 采集，证据可查）：
 * 同一 ASIN 的商品页读到 `27,477`，而搜索卡片表达式读成 `27`；
 * 同类还有 `123,796 → 123`、`3,354 → 3`、`1,074 → 1`、`5,268 → 5`、`2,394 → 2`、
 * `1,411 → 1`、`1,578 → 1`、`7,467 → 7`。以上全部是「千分位后第一段数字」。
 *
 * 根因类别（不依赖具体 DOM 版本）：计数被拆成多个文本节点（如 `27` + `,477`），
 * 或节点间存在空白／不换行空格，旧解析器只取第一段数字，于是把 `27,477` 读成 `27`
 * 并当成已确认事实。任何情况下"前缀截断"都不应被当成观测值。
 *
 * 规则（fail-closed）：
 * - 先去掉所有空白、不换行空格、窄不换行空格，再匹配数字；
 * - 支持千分位逗号与 K/M/B 后缀；
 * - 数字组以逗号结尾、或匹配段后仍紧跟逗号/数字 → 视为截断，返回 null；
 * - 不带后缀的小数（如 `4.8 out of 5`）在计数语境不可解析，返回 null。
 */
const SPACE_LIKE = /[\s\u00a0\u202f\u2009]/g;
const COUNT_PATTERN = /(\d[\d,]*)(?:\.(\d+))?([KMB])?/i;
const MULTIPLIERS: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };

export function parseObservedCountText(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = value.replace(SPACE_LIKE, "");
  if (!text) return null;
  const match = COUNT_PATTERN.exec(text);
  if (!match) return null;
  const [, integerPart, fraction, suffix] = match;
  if (!integerPart || integerPart.endsWith(",")) return null;
  const end = match.index + match[0].length;
  const nextCharacter = text.slice(end, end + 1);
  if (nextCharacter === "," || /^\d$/.test(nextCharacter)) return null;
  if (fraction && !suffix) return null;
  const base = Number(`${integerPart.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`);
  if (!Number.isFinite(base) || base < 0) return null;
  const multiplier = suffix ? (MULTIPLIERS[suffix.toUpperCase()] ?? 1) : 1;
  const parsed = Math.round(base * multiplier);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
