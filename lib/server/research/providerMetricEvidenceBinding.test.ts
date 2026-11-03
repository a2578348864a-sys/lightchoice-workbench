import { describe, expect, it } from "vitest";
import {
  PROVIDER_METRIC_EVIDENCE_SCHEMA,
  type ResearchInputBundleEvidenceRef,
} from "@/lib/sourceLayer/v2/contracts";
import { bindProviderMetricEvidence } from "@/lib/server/research/providerMetricEvidenceBinding";
import type { AdaptedV3Keyword } from "@/lib/server/research/v3EvidenceResearchAdapter";
import type { SellerSpriteTypedKeywordRow } from "@/lib/sourceLayer/sellerSpriteKeywordTable";

// ─────────────────────────────────────────────────────────────────────────────
// PH3：SellerSprite typed provider 字段 → ResearchInputBundle 绑定层
//
// 被测对象是纯函数 `bindProviderMetricEvidence`（只读、无副作用、fail-closed）。
// 全部用例都在真实契约形状上构造：AdaptedV3Keyword 与 ResearchInputBundleEvidenceRef。
// ─────────────────────────────────────────────────────────────────────────────

const SUBJECT = "amazon:US:B07G4VTV2F";
const CAPTURED = "2026-09-26T08:20:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function typedRow(
  rowKey: string,
  keyword: string,
  metrics: SellerSpriteTypedKeywordRow["metrics"],
  status: SellerSpriteTypedKeywordRow["status"] = "valid",
): SellerSpriteTypedKeywordRow {
  return { rowKey, sourceRowIndex: 0, keyword, rawCells: {}, metrics, status };
}

type TypedUnit = "count" | "ratio" | "percent" | "currency" | "unknown";

function estimate(value: number | null, unit: TypedUnit = "count") {
  return {
    raw: value === null ? null : String(value),
    value,
    unit,
    metricNature: "provider_estimate" as const,
    status: value === null ? ("unknown" as const) : ("parsed" as const),
  };
}

function adapted(overrides: Partial<AdaptedV3Keyword> = {}): AdaptedV3Keyword {
  const attachmentId = overrides.attachmentId ?? "att-ss-1";
  return {
    attachmentId,
    evidenceRef: `attachment:${attachmentId}`,
    capturedAt: CAPTURED,
    contentHash: HASH_A,
    metricNature: "provider_estimate",
    provider: "sellersprite",
    sourceUrl: "https://www.sellersprite.com/v3/product-research",
    module: "reverse_asin",
    subjectKey: SUBJECT,
    marketplace: "US",
    sourceType: "sellersprite_plugin",
    sourceSurface: "reverse_asin_table",
    observedAt: null,
    limitations: [],
    rows: [{ keyword: "kitchen organizer", monthlySearches: 2400, rowNumber: null }],
    typedRows: [
      typedRow("row-1", "kitchen organizer", { trafficShare: estimate(0.3837, "ratio") }),
    ],
    keywordInput: {
      rows: [{ keyword: "kitchen organizer", monthlySearches: 2400, rowNumber: null }],
      evidenceRef: `attachment:${attachmentId}`,
      capturedAt: CAPTURED,
      sourceMethod: "sellersprite",
    },
    ...overrides,
  };
}

function attachmentRef(overrides: Partial<ResearchInputBundleEvidenceRef> = {}): ResearchInputBundleEvidenceRef {
  const attachmentId = overrides.attachmentId ?? "att-ss-1";
  return {
    refId: `attachment:${attachmentId}`,
    kind: "attachment",
    subjectKey: SUBJECT,
    evidenceId: "ev-ss-1",
    captureId: "cap-ss-1",
    version: 1,
    contentHash: HASH_A,
    capturedAt: CAPTURED,
    attachmentId,
    ...overrides,
  };
}

describe("PH3 typed provider → ResearchInputBundle 绑定层", () => {
  it("[1] 合法 typed rows 被绑定，且保留 provider/metricNature/unit/来源三元组", () => {
    const out = bindProviderMetricEvidence({ adapted: [adapted()], refs: [attachmentRef()], subjectKey: SUBJECT });
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry.schemaVersion).toBe(PROVIDER_METRIC_EVIDENCE_SCHEMA);
    expect(entry.provider).toBe("sellersprite");
    expect(entry.module).toBe("reverse_asin");
    expect(entry.subjectKey).toBe(SUBJECT);
    expect(entry.queryIdentity).toEqual({ subjectKey: SUBJECT, marketplace: "US", asin: "B07G4VTV2F" });
    expect(entry.sourceType).toBe("sellersprite_plugin");
    expect(entry.sourceSurface).toBe("reverse_asin_table");
    // 来源 = 附件三元组；**没有** evidenceId/evidenceVersion（不借用当前 Evidence 身份）
    expect(entry.evidenceRefId).toBe("attachment:att-ss-1");
    expect(entry.attachmentId).toBe("att-ss-1");
    expect(entry.contentHash).toBe(HASH_A);
    expect(entry.capturedAt).toBe(CAPTURED);
    expect(entry.metricNature).toBe("provider_estimate");
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0].metrics[0]).toMatchObject({
      metric: "trafficShare",
      value: 0.3837,
      unit: "ratio",
      metricNature: "provider_estimate",
      status: "parsed",
    });
    expect(entry as Record<string, unknown>).not.toHaveProperty("evidenceId");
    expect(entry as Record<string, unknown>).not.toHaveProperty("evidenceVersion");
  });

  it("[2] 缺少对应附件引用（无 evidenceId 归属）→ 整条丢弃", () => {
    // refs 里只有别的附件 → 该 Provider 证据没有合法来源 → 丢弃
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ attachmentId: "att-orphan" })],
      refs: [attachmentRef({ attachmentId: "att-other" })],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[3] 引用存在但不是 attachment 种类（版本/实体不存在）→ 整条丢弃", () => {
    const out = bindProviderMetricEvidence({
      adapted: [adapted()],
      refs: [attachmentRef({ kind: "product_evidence" })],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[4] contentHash 与附件引用不一致 → 整条丢弃（不得用当前证据包装旧字段）", () => {
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ contentHash: HASH_B })],
      refs: [attachmentRef({ contentHash: HASH_A })],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[4b] capturedAt 与附件引用不一致 → 整条丢弃", () => {
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ capturedAt: "2026-09-27T00:00:00.000Z" })],
      refs: [attachmentRef({ capturedAt: CAPTURED })],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[5] 跨 subject（错误 ASIN）→ 整条丢弃，不跨主体混用", () => {
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ subjectKey: "amazon:US:B0XXXXXXXX" })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[6] 未知 metricPeriod 与 observedAt 保持 null，绝不推断", () => {
    const entry = bindProviderMetricEvidence({ adapted: [adapted()], refs: [attachmentRef()], subjectKey: SUBJECT })[0];
    expect(entry.metricPeriod).toBeNull();
    expect(entry.observedAt).toBeNull();
  });

  it("[6b] 证据自带非法 observedAt 时同样回落为 null", () => {
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ observedAt: "not-a-timestamp" })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.observedAt).toBeNull();
  });

  it("[6c] 证据自带合法 observedAt 时原样保留", () => {
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ observedAt: "2026-09-25T00:00:00.000Z" })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.observedAt).toBe("2026-09-25T00:00:00.000Z");
  });

  it("[7] metricNature 不是 provider_* → 该指标被丢弃；全部非法则整行丢弃", () => {
    const row = typedRow("row-x", "kinto tumbler", {
      trafficShare: { raw: "1", value: 1, unit: "count", metricNature: "source_observed" as never, status: "parsed" },
    });
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    });
    // 行内无合法指标 → 行被丢弃 → 无 rows → 整条证据丢弃
    expect(out).toEqual([]);
  });

  it("[7b] 同一行内混入非法指标：只剔除非法项，保留合法项", () => {
    const row = typedRow("row-mix", "garden hose", {
      searchVolume: estimate(2400, "count"),
      organicRank: { raw: "5", value: 5, unit: "count", metricNature: "amazon_confirmed" as never, status: "parsed" },
    });
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    });
    expect(out[0].rows).toHaveLength(1);
    expect(out[0].rows[0].metrics.map((metric) => metric.metric)).toEqual(["searchVolume"]);
  });

  it("[8] 字段类型错误（数值非 number）→ value 回落 null，不猜测", () => {
    const row = typedRow("row-bad", "bottle", {
      searchVolume: { raw: "N/A", value: "not-a-number" as never, unit: "count", metricNature: "provider_estimate", status: "unknown" },
    });
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.rows[0].metrics[0]).toMatchObject({ value: null, status: "unknown", raw: "N/A" });
  });

  it("[8b] 单位越界统一回落 unknown，不与 Amazon 单位混用", () => {
    const row = typedRow("row-unit", "mug", {
      searchVolume: { raw: "10", value: 10, unit: "widgets" as never, metricNature: "provider_estimate", status: "parsed" },
    });
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.rows[0].metrics[0].unit).toBe("unknown");
  });

  it("[9] 重复关键词记录按 rowKey 去重，只保留首条", () => {
    const first = typedRow("dup", "kitchen organizer", { searchVolume: estimate(2400, "count") });
    const second = typedRow("dup", "kitchen organizer alternate", { searchVolume: estimate(9999, "count") });
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [first, second] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0].keyword).toBe("kitchen organizer");
    expect(entry.rows[0].metrics[0].value).toBe(2400);
  });

  it("[10] 多 Provider/多附件同名指标互不覆盖，按 attachmentId 稳定排序", () => {
    const refs = [
      attachmentRef({ attachmentId: "att-z", contentHash: HASH_B }),
      attachmentRef({ attachmentId: "att-a", contentHash: HASH_A }),
    ];
    const out = bindProviderMetricEvidence({
      adapted: [
        adapted({ attachmentId: "att-z", contentHash: HASH_B, module: "keyword_mining_trend" }),
        adapted({ attachmentId: "att-a", contentHash: HASH_A }),
      ],
      refs,
      subjectKey: SUBJECT,
    });
    expect(out.map((entry) => entry.attachmentId)).toEqual(["att-a", "att-z"]);
    // 两条独立存在，各自带自己的 contentHash（不存在覆盖）
    expect(out.map((entry) => entry.contentHash)).toEqual([HASH_A, HASH_B]);
  });

  it("[11] 空 keyword / 无指标的行被丢弃；全部丢弃则整条证据不出现在 bundle", () => {
    const rows = [
      typedRow("empty-keyword", "   ", { searchVolume: estimate(1, "count") }),
      typedRow("no-metrics", "valid keyword", {}),
    ];
    const out = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: rows })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    });
    expect(out).toEqual([]);
  });

  it("[11b] 缺失数值保持 null，不转成 0", () => {
    const row = typedRow("null-value", "insulated cup", { searchVolume: estimate(null, "count") });
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.rows[0].metrics[0].value).toBeNull();
    expect(entry.rows[0].metrics[0].value).not.toBe(0);
  });

  it("[13] 证据更新（contentHash 变化）后绑定结果随之变化——快照变更可检测", () => {
    const before = bindProviderMetricEvidence({ adapted: [adapted()], refs: [attachmentRef()], subjectKey: SUBJECT });
    const after = bindProviderMetricEvidence({
      adapted: [adapted({ contentHash: HASH_B })],
      refs: [attachmentRef({ contentHash: HASH_B })],
      subjectKey: SUBJECT,
    });
    expect(before[0].contentHash).toBe(HASH_A);
    expect(after[0].contentHash).toBe(HASH_B);
    // 旧引用配新内容 → 快照变化会 fail-closed 丢弃（不是静默沿用旧值）
    const mismatch = bindProviderMetricEvidence({
      adapted: [adapted({ contentHash: HASH_B })],
      refs: [attachmentRef({ contentHash: HASH_A })],
      subjectKey: SUBJECT,
    });
    expect(mismatch).toEqual([]);
  });

  it("[14] 输出稳定可复现：同输入多次调用结果一致", () => {
    const run = () => JSON.stringify(bindProviderMetricEvidence({ adapted: [adapted()], refs: [attachmentRef()], subjectKey: SUBJECT }));
    expect(run()).toBe(run());
  });

  it("[15] 行内指标按名称稳定排序，保证哈希稳定", () => {
    const row = typedRow("row-sort", "travel tumbler", {
      trafficShare: estimate(0.1, "ratio"),
      estimatedTraffic: estimate(1000, "count"),
      organicRank: estimate(3, "count"),
    });
    const entry = bindProviderMetricEvidence({
      adapted: [adapted({ typedRows: [row] })],
      refs: [attachmentRef()],
      subjectKey: SUBJECT,
    })[0];
    expect(entry.rows[0].metrics.map((metric) => metric.metric))
      .toEqual(["estimatedTraffic", "organicRank", "trafficShare"]);
  });
});
