import { describe, expect, it } from "vitest";

import { hashJson, canonicalJson } from "@/lib/server/v5CanonicalHash";
import { DYNAMIC_DERIVED_FACT_KEYS, stableFactForHash, stableFactHash } from "@/lib/server/research/stableFactHash";

/**
 * 方案 A 隔离验证：factHash 稳定子集规范化。
 * 覆盖：
 * 1) 投影行为（剔除动态派生字段、保留业务事实字段）；
 * 2) 稳定性（含注入时刻的完整对象不稳定 vs 稳定子集恒定）；
 * 3) 敏感性（业务字段变化必须改变哈希——检测能力保留）；
 * 4) 与既有契约（canonicalJson 键排序）一致。
 */
describe("stableFactHash（方案 A 隔离修复）", () => {
  it("剔除动态派生字段，保留全部业务事实字段", () => {
    const fact = {
      schema: "product-fact.v1",
      subjectKey: "amazon:US:B0TEST0001",
      sourceProof: { evidenceId: "ev-x", contentHash: "a".repeat(64) },
      basic: { asin: { value: "B0TEST0001", status: "present" } },
      market: { bsr: { value: 1000, status: "present" } },
      profit: { fbaFee: { value: null, status: "missing" } },
      extended: { parentAsin: { value: null, status: "missing" } },
      amazonDetailHistory: { schemaVersion: "amazon-detail-field-history-projection.v1", injectedNow: "2026-10-14T00:00:00.000Z" },
    };
    const stable = stableFactForHash(fact);
    expect(Object.keys(stable)).not.toContain("amazonDetailHistory");
    for (const key of ["schema", "subjectKey", "sourceProof", "basic", "market", "profit", "extended"]) {
      expect(stable[key]).toBe(fact[key as keyof typeof fact]);
    }
    expect(DYNAMIC_DERIVED_FACT_KEYS).toContain("amazonDetailHistory");
  });

  it("含注入时刻的完整对象哈希不稳定；稳定子集恒定", () => {
    const base = {
      schema: "product-fact.v1",
      basic: { asin: { value: "B0TEST0001" } },
      amazonDetailHistory: { schemaVersion: "x.v1", injectedNow: "T1", decisionHash: "d1" },
    };
    const fullA = hashJson(base);
    const fullB = hashJson({ ...base, amazonDetailHistory: { schemaVersion: "x.v1", injectedNow: "T2", decisionHash: "d2" } });
    expect(fullA).not.toBe(fullB); // 对照：完整对象不稳定

    const stableA = stableFactHash(base);
    const stableB = stableFactHash({ ...base, amazonDetailHistory: { schemaVersion: "x.v1", injectedNow: "T2", decisionHash: "d2" } });
    expect(stableA).toBe(stableB); // 修复：稳定子集一致
  });

  it("业务字段变化必须改变哈希（stale 检测能力保留）", () => {
    const before = { schema: "product-fact.v1", basic: { price: { value: 9.99, status: "present" } }, amazonDetailHistory: { injectedNow: "T1" } };
    const afterPrice = { schema: "product-fact.v1", basic: { price: { value: 10.99, status: "present" } }, amazonDetailHistory: { injectedNow: "T2" } };
    expect(stableFactHash(before)).not.toBe(stableFactHash(afterPrice)); // 事实变化 → 哈希变化
  });

  it("数组保序（canonicalJson 契约）：同内容同序恒定、异序变化", () => {
    const a = { list: [3, 1, 2] };
    const b = { list: [3, 1, 2] };
    const c = { list: [1, 2, 3] };
    expect(stableFactHash(a)).toBe(stableFactHash(b));
    expect(stableFactHash(a)).not.toBe(stableFactHash(c));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 })); // 对象键稳定排序
  });

  it("连续 200 次计算稳定（纯函数）", () => {
    const fact = { schema: "product-fact.v1", nested: { arr: [{ z: 1 }, { a: 2 }], num: 1.5 }, amazonDetailHistory: { injectedNow: "T" } };
    const first = stableFactHash(fact);
    for (let i = 0; i < 200; i += 1) expect(stableFactHash(fact)).toBe(first);
  });
});
