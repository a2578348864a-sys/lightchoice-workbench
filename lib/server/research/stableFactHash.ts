import { hashJson } from "@/lib/server/v5CanonicalHash";

/**
 * 事实身份哈希的稳定子集（2026-10-14 隔离修复验证，方案 A）。
 *
 * 背景（P0 缺陷，实证）：`loadCanonicalResearchBoundary().bundle.productFact` 含
 * 动态派生的 `amazonDetailHistory` 投影，其 `injectedNow` 字段在每次构建时注入
 * **当前时刻**（并连带派生 `decisionHash`）——导致整个 productFact 的 canonical hash
 * 每次调用都不同：
 *   - advisory 写入 state.factHash = 某次调用的瞬时值；
 *   - 决策（choice）时 stale 检查重算 → 必然不等 → `RESEARCH_EVIDENCE_STALE` 永久拦截。
 *
 * 修复语义（不改变门禁语义，不删除 stale 检查）：
 *   factHash 只对**稳定业务事实**计算——即完整 productFact **剔除动态派生字段**。
 *   stale 检查两侧（写入/校验）使用同一投影，因此"证据真变化 → 哈希变化"的
 *   检测能力完整保留；仅剔除"每次注入当前时刻"的非事实派生投影。
 *
 * 保留：schema / subjectKey / sourceProof / basic / market / profit / extended
 *       （全部为版本锁定的业务事实，canonicalJson 已做对象键稳定排序、数组保序）。
 * 排除：`amazonDetailHistory`（动态派生；其内部含 injectedNow 时刻注入）。
 */

/** 不参与事实身份哈希的动态派生字段（出现即剔除；未来同类字段在此登记）。 */
export const DYNAMIC_DERIVED_FACT_KEYS = ["amazonDetailHistory"] as const;

/**
 * 生成用于 factHash 的稳定投影：浅层剔除动态派生字段，其余字段原样保留。
 * 不深拷贝（事实字段在 canonicalJson 序列化时已是确定性读取，不修改原对象）。
 */
export function stableFactForHash(productFact: unknown): Record<string, unknown> {
  if (!productFact || typeof productFact !== "object" || Array.isArray(productFact)) return {};
  const record = productFact as Record<string, unknown>;
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if ((DYNAMIC_DERIVED_FACT_KEYS as readonly string[]).includes(key)) continue;
    stable[key] = record[key];
  }
  return stable;
}

/** factHash 唯一计算入口：稳定业务事实子集的 canonical sha256。 */
export function stableFactHash(productFact: unknown): string {
  return hashJson(stableFactForHash(productFact));
}
