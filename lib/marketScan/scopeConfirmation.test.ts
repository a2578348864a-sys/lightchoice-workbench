/**
 * 人工研究范围确认合同（P3 持久化版）——纯函数校验测试。
 *
 * 覆盖：未确认不计入范围内、系统子类型不写人工状态、样本/研究目标变化导致过期、
 * 撤销与从未确认区分、三重版本校验（批次/样本/人工 revision）、幂等判定。
 */
import { describe, expect, it } from "vitest";
import {
  buildScopeConfirmationRows,
  scopeConfirmationStaleReason,
  summarizeScopeConfirmations,
  validateScopeConfirmationBatch,
  type ScopeConfirmationRecord,
} from "@/lib/marketScan/scopeConfirmation";

const SCAN_ID = "cmvclxeeq0000biaimg6jobrq";
const SAMPLE_HASH = "2d827872ecb421e5f4de3329c0e2d8a50ba2779c16cb8c9f8a37abd297f9c808";
const NICHE_HASH = "niche-hash-1";

const REAL_ASINS = [
  "B09ZV2TX28", "B071225BBS", "B08KXKVT4K", "B0GPSS6RQ7", "B09F32F4TR", "B0B93HTY9Y",
  "B0C57FV4JS", "B082VWSMCB", "B0DHGM5XT4", "B085ZV98JM", "B0CG5FZZCR", "B07PR9NM54",
  "B0DDT9XFRB", "B0C5C9BFXM", "B0F8HLC5KP", "B0DMVX69PW", "B0DKHZ1JLG", "B0CGXT9PGR",
  "B0FHQFBTN8", "B0GFDKH1HD", "B0CJ5DPB8D", "B0BVQ69QJD", "B09TB8WFXC", "B0CHYHTH2L",
  "B0CDXLYN2W", "B0B1DG8D3W", "B0B1DHPP98", "B0F1HXGW42", "B002BA5F52", "B07TPRTV6P",
];

function rowsFor(confirmations: ScopeConfirmationRecord[] = [], asins = REAL_ASINS) {
  return buildScopeConfirmationRows({
    scanId: SCAN_ID,
    sampleHash: SAMPLE_HASH,
    nicheHash: NICHE_HASH,
    samples: asins.map((asin) => ({
      asin,
      subjectKey: `amazon:US:${asin}`,
      title: `${asin} sample`,
      systemSubtype: null,
      currentVersion: "v-1",
    })),
    confirmations,
  });
}

function rowOf(rows: ReturnType<typeof rowsFor>, asin: string) {
  const row = rows.find((item) => item.asin === asin);
  if (!row) throw new Error(`row not found: ${asin}`);
  return row;
}

function record(asin: string, overrides: Partial<ScopeConfirmationRecord> = {}): ScopeConfirmationRecord {
  return {
    marketSampleKey: `${SCAN_ID}:${asin}`,
    status: "IN_SCOPE",
    reason: "符合 55–95qt 硬质透明带盖。",
    sampleHash: SAMPLE_HASH,
    nicheHash: NICHE_HASH,
    confirmedAt: "2026-10-20T00:00:00.000Z",
    confirmedBy: "owner:v1",
    scopeRevision: 1,
    ...overrides,
  };
}

describe("buildScopeConfirmationRows / summarizeScopeConfirmations", () => {
  it("真实收纳箱 30 件：未确认时全部 UNREVIEWED，且不计入范围内", () => {
    const rows = rowsFor();
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.reviewStatus === "UNREVIEWED")).toBe(true);
    expect(summarizeScopeConfirmations(rows)).toEqual({
      total: 30, inScope: 0, outOfScope: 0, unreviewed: 30, revoked: 0, stale: 0,
    });
  });

  it("系统子类型不写入人工状态", () => {
    const rows = buildScopeConfirmationRows({
      scanId: SCAN_ID,
      sampleHash: SAMPLE_HASH,
      nicheHash: NICHE_HASH,
      samples: [{
        asin: "B07PR9NM54",
        subjectKey: "amazon:US:B07PR9NM54",
        title: "Rubbermaid 95 Qt",
        systemSubtype: { id: "hard_plastic_bin", label: "硬质塑料收纳箱" },
        currentVersion: "v-1",
      }],
    });
    expect(rows[0].reviewStatus).toBe("UNREVIEWED");
    expect(rows[0].systemSubtype?.id).toBe("hard_plastic_bin");
  });

  it("有效人工确认独立统计（1 进 1 出 28 未确认）", () => {
    const rows = rowsFor([record("B07PR9NM54"), record("B085ZV98JM", { status: "OUT_OF_SCOPE", reason: "收纳袋，非硬质箱。" })]);
    expect(summarizeScopeConfirmations(rows)).toEqual({
      total: 30, inScope: 1, outOfScope: 1, unreviewed: 28, revoked: 0, stale: 0,
    });
  });

  it("样本快照变化：旧确认保留但过期，且不计入有效范围内/外", () => {
    const rows = rowsFor([record("B07PR9NM54", { sampleHash: "old-hash" })]);
    const target = rowOf(rows, "B07PR9NM54");
    expect(target.reviewStatus).toBe("UNREVIEWED");
    expect(target.reviewStale).toBe(true);
    expect(target.staleReason).toBe("SAMPLE_SNAPSHOT_CHANGED");
    const summary = summarizeScopeConfirmations(rows);
    expect(summary.inScope).toBe(0);
    expect(summary.stale).toBe(1);
    expect(summary.unreviewed).toBe(29);
    expect(summary.total).toBe(summary.inScope + summary.outOfScope + summary.unreviewed + summary.stale);
  });

  it("研究目标变化同样使旧确认失效（不只看商品快照）", () => {
    expect(scopeConfirmationStaleReason({
      record: record("B07PR9NM54"),
      currentSampleHash: SAMPLE_HASH,
      currentNicheHash: "niche-hash-2",
    })).toBe("RESEARCH_SCOPE_CHANGED");
    const rows = rowsFor([record("B07PR9NM54", { nicheHash: "niche-hash-0" })]);
    const target = rowOf(rows, "B07PR9NM54");
    expect(target.reviewStale).toBe(true);
    expect(target.staleReason).toBe("RESEARCH_SCOPE_CHANGED");
  });

  it("撤销后的统计守恒：1 进 1 出 → 撤销 1 → 0/1/29（revoked 为 unreviewed 子集）", () => {
    const confirmed = rowsFor([
      record("B07PR9NM54"),
      record("B085ZV98JM", { status: "OUT_OF_SCOPE", reason: "收纳袋，非硬质箱。" }),
    ]);
    expect(summarizeScopeConfirmations(confirmed)).toEqual({
      total: 30, inScope: 1, outOfScope: 1, unreviewed: 28, revoked: 0, stale: 0,
    });

    const revoked = rowsFor([
      record("B07PR9NM54", { status: "REVOKED", reason: null, scopeRevision: 2 }),
      record("B085ZV98JM", { status: "OUT_OF_SCOPE", reason: "收纳袋，非硬质箱。" }),
    ]);
    const summary = summarizeScopeConfirmations(revoked);
    expect(summary).toEqual({
      total: 30, inScope: 0, outOfScope: 1, unreviewed: 29, revoked: 1, stale: 0,
    });
    // 守恒：revoked 不额外参与求和
    expect(summary.total).toBe(summary.inScope + summary.outOfScope + summary.unreviewed + summary.stale);
    expect(summary.revoked).toBeLessThanOrEqual(summary.unreviewed);
  });

  it("已撤销的记录不参与过期判定（撤销不是确认）", () => {
    const rows = rowsFor([record("B07PR9NM54", { status: "REVOKED", reason: null, sampleHash: "old-hash", nicheHash: "old-niche" })]);
    const target = rowOf(rows, "B07PR9NM54");
    expect(target.reviewStale).toBe(false);
    expect(target.staleReason).toBeNull();
    expect(target.revoked).toBe(true);
    expect(summarizeScopeConfirmations(rows).stale).toBe(0);
  });

  it("撤销与从未确认可区分：revoked 计入 unreviewed 子集", () => {
    const rows = rowsFor([record("B07PR9NM54", { status: "REVOKED", reason: null })]);
    const target = rowOf(rows, "B07PR9NM54");
    expect(target.reviewStatus).toBe("UNREVIEWED");
    expect(target.revoked).toBe(true);
    expect(summarizeScopeConfirmations(rows)).toEqual({
      total: 30, inScope: 0, outOfScope: 0, unreviewed: 30, revoked: 1, stale: 0,
    });
  });
});

describe("validateScopeConfirmationBatch", () => {
  const rows = rowsFor();
  const base = {
    marketSampleKey: `${SCAN_ID}:B07PR9NM54`,
    asin: "B07PR9NM54",
    subjectKey: "amazon:US:B07PR9NM54",
    status: "IN_SCOPE" as const,
    reason: "95qt 硬质透明带盖，符合 55–95qt。",
    expectedVersion: "v-1",
    expectedScopeRevision: 0,
  };

  const run = (items: unknown[]) => validateScopeConfirmationBatch({
    scanId: SCAN_ID, sampleHash: SAMPLE_HASH, expectedScanHash: SAMPLE_HASH, rows, items: items as never,
  });

  it("合法批次通过并规范化 ASIN", () => {
    const result = run([{ ...base, asin: "b07pr9nm54" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized[0].asin).toBe("B07PR9NM54");
      expect(result.idempotent).toBe(false);
    }
  });

  it("批次哈希不一致 / 空批次被拒绝", () => {
    const stale = validateScopeConfirmationBatch({
      scanId: SCAN_ID, sampleHash: SAMPLE_HASH, expectedScanHash: "other", rows, items: [base],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errors[0].code).toBe("MARKET_SNAPSHOT_STALE");

    const empty = run([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0].code).toBe("BATCH_EMPTY");
  });

  it("错误 key / 跨 ASIN / 跨主体被拒绝", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ marketSampleKey: `${SCAN_ID}:B0NOTEXIST` }, "SAMPLE_NOT_IN_SCAN"],
      [{ asin: "B082VWSMCB" }, "SAMPLE_ASIN_MISMATCH"],
      [{ subjectKey: "amazon:US:B082VWSMCB" }, "SAMPLE_SUBJECT_MISMATCH"],
    ];
    for (const [patch, code] of cases) {
      const result = run([{ ...base, ...patch }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].code).toBe(code);
    }
  });

  it("三重版本：样本版本冲突与 scopeRevision 冲突分别拒绝", () => {
    const version = run([{ ...base, expectedVersion: "v-0" }]);
    expect(version.ok).toBe(false);
    if (!version.ok) expect(version.errors[0].code).toBe("SAMPLE_VERSION_CONFLICT");

    const revision = run([{ ...base, expectedScopeRevision: 3 }]);
    expect(revision.ok).toBe(false);
    if (!revision.ok) expect(revision.errors[0].code).toBe("SCOPE_REVISION_CONFLICT");
  });

  it("非法状态 / 缺理由 / 重复样本被拒绝", () => {
    const badStatus = run([{ ...base, status: "MAYBE" }]);
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.errors[0].code).toBe("SCOPE_STATUS_INVALID");

    const noReason = run([{ ...base, reason: "  " }]);
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.errors[0].code).toBe("SCOPE_REASON_REQUIRED");

    const dup = run([base, { ...base }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors[0].code).toBe("DUPLICATE_SAMPLE_IN_BATCH");
  });

  it("撤销（UNREVIEWED）不需要理由，但仍需版本一致", () => {
    const ok = run([{ ...base, status: "UNREVIEWED", reason: "" }]);
    expect(ok.ok).toBe(true);
    const stale = run([{ ...base, status: "UNREVIEWED", expectedScopeRevision: 9 }]);
    expect(stale.ok).toBe(false);
  });

  it("重复提交相同内容标记幂等", () => {
    const stored = rowsFor([record("B07PR9NM54", { reason: base.reason, scopeRevision: 1 })]);
    const result = validateScopeConfirmationBatch({
      scanId: SCAN_ID, sampleHash: SAMPLE_HASH, expectedScanHash: SAMPLE_HASH, rows: stored,
      items: [{ ...base, expectedScopeRevision: 1 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idempotent).toBe(true);
  });
});
