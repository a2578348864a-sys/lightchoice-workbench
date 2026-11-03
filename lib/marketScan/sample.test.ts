/**
 * MarketScan 样本编组 / 版本锁定 / 稳定哈希契约测试。
 */

import { describe, expect, it } from "vitest";

import {
  MarketScanSampleError,
  buildSampleSnapshot,
  computeMarketMetricsV1,
  computeSampleHash,
  factValuesFingerprintOf,
  productFactFingerprintOf,
  sampleItemHashOf,
  sha256Hex,
  stableStringify,
} from "@/lib/marketScan/metrics";
import {
  FIXTURE_CAPTURED_AT,
  FIXTURE_CONTENT_HASH,
  FIXTURE_NICHE_DEFINITION,
  FIXTURE_REFERENCE_DATE,
  FIXTURE_SAMPLE_DEFINITION,
  captureMarketScanSampleError,
  fixtureFactValues,
  makeProductFact,
  makeSampleInput,
  type ProductFactFixtureOptions,
} from "@/lib/marketScan/__fixtures__/productFactFixture";
import { parseMarketScanSampleSnapshotV1 } from "@/lib/marketScan/contract";
import type {
  MarketScanSampleInputV1,
  MarketScanSampleItemDraftV1,
  MarketScanSampleItemV1,
  MarketScanSampleSnapshotV1,
} from "@/lib/marketScan/types";

const METRICS_VERSION = "market-metrics.v1";

function snapshotOf(
  sample: readonly MarketScanSampleInputV1[],
  metricsVersion = METRICS_VERSION,
): MarketScanSampleSnapshotV1 {
  return buildSampleSnapshot({
    nicheDefinition: FIXTURE_NICHE_DEFINITION,
    sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
    sample,
    metricsVersion,
  });
}

function sampleOf(options: ProductFactFixtureOptions): MarketScanSampleInputV1 {
  return makeSampleInput(options);
}

/** 从已落库的样本条目还原 draft（去掉 dedupeOf），用于独立复算 itemHash。 */
function draftOfItem(item: MarketScanSampleItemV1): MarketScanSampleItemDraftV1 {
  const { dedupeOf: priorDedupe, ...draft } = item;
  void priorDedupe;
  return draft;
}

/**
 * 服务层回灌用法：把去重后的快照成员重建为指标输入（含已冻结的 factValues 与 sampleHash），
 * 保证 `snapshot.itemCount === metrics.sampleCount`。
 */
function metricsFromSnapshot(snapshot: MarketScanSampleSnapshotV1) {
  return computeMarketMetricsV1({
    sample: snapshot.items.map((item) => ({
      subjectKey: item.subjectKey,
      productFact: makeProductFact({ asin: item.asin }),
      factValues: item.factValues,
      evidenceVersion: item.evidenceVersion,
      evidenceId: item.evidenceId,
      capturedAt: item.capturedAt,
      candidateId: item.candidateId,
    })),
    referenceDate: FIXTURE_REFERENCE_DATE,
    metricsVersion: snapshot.metricsVersion,
    sampleHash: snapshot.sampleHash,
  });
}

describe("stableStringify", () => {
  it("对象键按字典序递归排序，且与插入顺序无关", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { b: 1, a: [{ y: 1, x: 2 }] }, a: null })).toBe(
      '{"a":null,"z":{"a":[{"x":2,"y":1}],"b":1}}',
    );
  });

  it("剔除值为 undefined 的键，但保留数组顺序（数组中的 undefined → null）", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
  });

  it("基本类型按 JSON.stringify 语义（NaN / Infinity → null）", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify("a\"b")).toBe('"a\\"b"');
    expect(stableStringify(1.5)).toBe("1.5");
    expect(stableStringify(Number.NaN)).toBe("null");
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("对 ProductFact 稳定：同内容不同键序 → 同一字符串", () => {
    const fact = makeProductFact({ asin: "B0STABLE01" });
    const reordered = {
      profit: fact.profit,
      market: fact.market,
      basic: fact.basic,
      sourceProof: fact.sourceProof,
      subjectKey: fact.subjectKey,
      schema: fact.schema,
    };
    expect(stableStringify(reordered)).toBe(stableStringify(fact));
  });
});

describe("sha256Hex", () => {
  it("匹配已知 SHA-256 向量（64 位小写十六进制）", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("productFactFingerprintOf", () => {
  it("只覆盖事实内容：与编组元数据无关", () => {
    const fact = makeProductFact({ asin: "B0FACT0001" });
    const first = productFactFingerprintOf({ productFact: fact, subjectKey: "subject-a" });
    const second = productFactFingerprintOf({ productFact: fact, subjectKey: "subject-b" });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);

    // 同一份事实挂在不同编组（evidenceVersion / evidenceId / candidateId）下，指纹不变。
    const sampleA = makeSampleInput({ asin: "B0FACT0001", evidenceVersion: 1 });
    const sampleB = makeSampleInput({ asin: "B0FACT0001", evidenceVersion: 9, candidateId: "c-1" });
    expect(productFactFingerprintOf(sampleB)).toBe(productFactFingerprintOf(sampleA));
  });

  it("固定包装为 { productFact }，事实内容变化则指纹变化", () => {
    const fact = makeProductFact({ asin: "B0FACT0002", price: 10 });
    const other = makeProductFact({ asin: "B0FACT0002", price: 11 });

    expect(productFactFingerprintOf({ productFact: fact, subjectKey: "s" })).toBe(
      sha256Hex(stableStringify({ productFact: fact })),
    );
    expect(productFactFingerprintOf({ productFact: other, subjectKey: "s" })).not.toBe(
      productFactFingerprintOf({ productFact: fact, subjectKey: "s" }),
    );
  });
});

describe("sampleItemHashOf", () => {
  const draft: MarketScanSampleItemDraftV1 = {
    asin: "B0ITEM0001",
    subjectKey: "subject-1",
    candidateId: null,
    productFactFingerprint: "f".repeat(64),
    factValuesFingerprint: "e".repeat(64),
    sourceProofHash: FIXTURE_CONTENT_HASH,
    evidenceId: "evidence-1",
    evidenceVersion: 1,
    capturedAt: FIXTURE_CAPTURED_AT,
    sourceType: "sellersprite_xlsx",
    factValues: fixtureFactValues(),
  };

  it("覆盖版本锁定字段（evidenceVersion / sourceProofHash / 事实值）", () => {
    const base = sampleItemHashOf(draft);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(sampleItemHashOf({ ...draft, evidenceVersion: 2 })).not.toBe(base);
    expect(sampleItemHashOf({ ...draft, sourceProofHash: "a".repeat(64) })).not.toBe(base);
    expect(sampleItemHashOf({ ...draft })).toBe(base);

    // 冻结的事实值变化必须改变条目 hash（否则就不是版本锁定）。
    const changedFacts = {
      ...draft,
      factValues: {
        ...draft.factValues,
        price: { presence: "present" as const, value: { amount: 99, currency: "USD" }, valueSource: "FACT" as const },
      },
    };
    expect(sampleItemHashOf(changedFacts)).not.toBe(base);
  });
});

describe("MarketScan imageRef", () => {
  const ONE_PIXEL_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("stores a source-evidence locator for inline images without copying Base64 into the snapshot", () => {
    const snapshot = snapshotOf([sampleOf({
      asin: "B0IMG00001",
      image: ONE_PIXEL_DATA_URL,
      evidenceId: "ev-fixture-img-1",
    })]);
    const item = snapshot.items[0];

    expect(item.imageRef).toEqual({
      schemaVersion: "market-scan-image-ref.v1",
      kind: "source_evidence",
      subjectKey: item.subjectKey,
      evidenceId: "ev-fixture-img-1",
      evidenceVersion: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("data:image/png;base64");

    const reread = parseMarketScanSampleSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
    expect(reread.items[0].imageRef).toEqual(item.imageRef);
  });

  it("keeps historical market-scan-sample.v1 snapshots without imageRef readable", () => {
    const snapshot = snapshotOf([sampleOf({ asin: "B0NOIMG001", image: null })]);
    const legacy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const items = legacy.items as Array<Record<string, unknown>>;
    delete items[0].imageRef;

    const reread = parseMarketScanSampleSnapshotV1(legacy);
    expect(reread.items[0].imageRef).toBeUndefined();
    expect(reread.sampleHash).toBe(snapshot.sampleHash);
  });
});

describe("factValuesFingerprintOf", () => {
  it("确定性且只依赖 subjectKey + factValues（可只凭快照重算）", () => {
    const factValues = fixtureFactValues();
    const first = factValuesFingerprintOf({ subjectKey: "subject-1", factValues });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(factValuesFingerprintOf({ subjectKey: "subject-1", factValues })).toBe(first);
    expect(first).toBe(sha256Hex(stableStringify({ subjectKey: "subject-1", factValues })));

    // subjectKey 或任一事实值变化都必须改变指纹。
    expect(factValuesFingerprintOf({ subjectKey: "subject-2", factValues })).not.toBe(first);
    expect(
      factValuesFingerprintOf({
        subjectKey: "subject-1",
        factValues: { ...factValues, brand: { presence: "missing" } },
      }),
    ).not.toBe(first);
  });

  it("落入快照：item.factValuesFingerprint 可由 item 自身重算", () => {
    const snapshot = snapshotOf([makeSampleInput({ asin: "B0SELFPRO1" })]);

    for (const item of snapshot.items) {
      expect(item.factValuesFingerprint).toBe(
        factValuesFingerprintOf({ subjectKey: item.subjectKey, factValues: item.factValues }),
      );
    }
  });
});

describe("computeSampleHash", () => {
  const items = [
    {
      asin: "B0HASH0002",
      subjectKey: "s-2",
      candidateId: null,
      productFactFingerprint: "b".repeat(64),
      factValuesFingerprint: "d".repeat(64),
      sourceProofHash: FIXTURE_CONTENT_HASH,
      evidenceId: "e-2",
      evidenceVersion: 1,
      capturedAt: FIXTURE_CAPTURED_AT,
      sourceType: "sellersprite_xlsx" as const,
      dedupeOf: null,
      factValues: fixtureFactValues(),
    },
    {
      asin: "B0HASH0001",
      subjectKey: "s-1",
      candidateId: null,
      productFactFingerprint: "a".repeat(64),
      factValuesFingerprint: "c".repeat(64),
      sourceProofHash: FIXTURE_CONTENT_HASH,
      evidenceId: "e-1",
      evidenceVersion: 1,
      capturedAt: FIXTURE_CAPTURED_AT,
      sourceType: "sellersprite_xlsx" as const,
      dedupeOf: null,
      factValues: fixtureFactValues(),
    },
  ];

  function hashOf(
    overrides: Partial<Parameters<typeof computeSampleHash>[0]> = {},
    list: typeof items = items,
  ): string {
    return computeSampleHash({
      nicheDefinition: FIXTURE_NICHE_DEFINITION,
      sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
      items: list,
      metricsVersion: METRICS_VERSION,
      ...overrides,
    });
  }

  it("确定性 + 输入顺序无关（内部按 asin / fingerprint 排序）", () => {
    expect(hashOf()).toBe(hashOf());
    expect(hashOf({}, [items[1], items[0]])).toBe(hashOf());
    expect(hashOf()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("nicheDefinition / sampleDefinition / metricsVersion 任一变化都会改变 hash", () => {
    expect(
      hashOf({ metricsVersion: "market-metrics.v2" }),
    ).not.toBe(hashOf());
    expect(
      hashOf({ nicheDefinition: { ...FIXTURE_NICHE_DEFINITION, label: "Other" } }),
    ).not.toBe(hashOf());
    expect(
      hashOf({ sampleDefinition: { ...FIXTURE_SAMPLE_DEFINITION, marketplace: "DE" } }),
    ).not.toBe(hashOf());
    // 版本锁定字段变化也必须改变 hash
    expect(
      hashOf({}, [{ ...items[1], evidenceVersion: 3 }, items[0]]),
    ).not.toBe(hashOf());
  });
});

describe("buildSampleSnapshot — 输入合法性（FAIL CLOSED）", () => {
  it("空输入 → sample_empty", () => {
    const error = captureMarketScanSampleError(() => snapshotOf([]));
    expect(error).toBeInstanceOf(MarketScanSampleError);
    expect(error.code).toBe("sample_empty");
  });

  it("缺失 ASIN → sample_invalid", () => {
    const error = captureMarketScanSampleError(() =>
      snapshotOf([sampleOf({ asin: null })]),
    );
    expect(error.code).toBe("sample_invalid");
  });

  it("ASIN 只有空白 → sample_invalid", () => {
    const error = captureMarketScanSampleError(() =>
      snapshotOf([sampleOf({ asin: "   " })]),
    );
    expect(error.code).toBe("sample_invalid");
  });

  it("subjectKey 为空 → sample_invalid", () => {
    const error = captureMarketScanSampleError(() =>
      snapshotOf([sampleOf({ asin: "B0VALID0001", subjectKey: "  " })]),
    );
    expect(error.code).toBe("sample_invalid");
  });

  it("contentHash 不是 64 位小写十六进制 → sample_invalid", () => {
    for (const contentHash of ["", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
      const error = captureMarketScanSampleError(() =>
        snapshotOf([sampleOf({ asin: "B0VALID0002", contentHash })]),
      );
      expect(error.code).toBe("sample_invalid");
    }
  });

  it("同一 subjectKey 映射到不同 ASIN → sample_subject_conflict", () => {
    const error = captureMarketScanSampleError(() =>
      snapshotOf([
        makeSampleInput({ asin: "B0SUBJ0001", subjectKey: "shared-subject" }),
        makeSampleInput({ asin: "B0SUBJ0002", subjectKey: "shared-subject" }),
      ]),
    );
    expect(error.code).toBe("sample_subject_conflict");
  });

  it("同一 ASIN、不同 fingerprint → sample_asin_conflict（绝不静默选一版）", () => {
    const first = makeSampleInput({ asin: "B0CONFL001", price: 10 });
    const second = makeSampleInput({ asin: "B0CONFL001", price: 20 });
    expect(productFactFingerprintOf(second)).not.toBe(productFactFingerprintOf(first));

    const error = captureMarketScanSampleError(() => snapshotOf([first, second]));
    expect(error.code).toBe("sample_asin_conflict");
    expect(error.message).toContain("B0CONFL001");
  });
});

describe("buildSampleSnapshot — 版本锁定与确定性去重", () => {
  it("同 ASIN + 同 fingerprint：保留 evidenceVersion 最小者，dedupeOf 写被丢弃条目的 itemHash", () => {
    const fact = makeProductFact({ asin: "B0DEDUP001" });
    const fingerprint = productFactFingerprintOf({
      productFact: fact,
      subjectKey: "subject-B0DEDUP001",
    });

    const keptInput = makeSampleInput({ asin: "B0DEDUP001", evidenceVersion: 2 });
    const droppedInput = makeSampleInput({ asin: "B0DEDUP001", evidenceVersion: 3 });
    // 同一份事实重复编组：编组元数据（evidenceVersion）不同，事实指纹必须相同。
    expect(productFactFingerprintOf(droppedInput)).toBe(productFactFingerprintOf(keptInput));

    const snapshot = snapshotOf([droppedInput, keptInput]);

    expect(snapshot.itemCount).toBe(1);
    const [item] = snapshot.items;
    expect(item.evidenceVersion).toBe(2);
    expect(item.evidenceId).toBe("evidence-B0DEDUP001");
    expect(item.sourceProofHash).toBe(FIXTURE_CONTENT_HASH);
    expect(item.productFactFingerprint).toBe(fingerprint);
    expect(item.sourceType).toBe("sellersprite_xlsx");
    expect(item.candidateId).toBeNull();
    expect(item.capturedAt).toBe(FIXTURE_CAPTURED_AT);

    const discardedHash = sampleItemHashOf(
      // 唯一差别是编组元数据 evidenceVersion（事实内容完全相同）。
      { ...draftOfItem(item), evidenceVersion: 3 },
    );
    expect(item.dedupeOf).toBe(discardedHash);
    expect(item.dedupeOf).not.toBe(sampleItemHashOf(draftOfItem(item)));
    expect(item.dedupeOf).not.toBe(item.productFactFingerprint);
    // 快照自带的事实值自证指纹可由条目自身重算。
    expect(item.factValuesFingerprint).toBe(
      factValuesFingerprintOf({ subjectKey: item.subjectKey, factValues: item.factValues }),
    );
    expect(item.factValues.asin).toBe("B0DEDUP001");
    expect(item.factValues.monthlySalesEstimate.valueSource).toBe("PROVIDER_ESTIMATE");
    expect(item.factValues.price).toEqual({
      presence: "present",
      value: { amount: 19.99, currency: "USD" },
      valueSource: "FACT",
    });
  });

  it("evidenceVersion 并列 → 取 evidenceId 字典序更小者（入参 evidenceId 属于条目元数据）", () => {
    const snapshot = snapshotOf([
      makeSampleInput({ asin: "B0DEDUP003", evidenceIdOverride: "evidence-z" }),
      makeSampleInput({ asin: "B0DEDUP003", evidenceIdOverride: "evidence-a" }),
    ]);

    expect(snapshot.itemCount).toBe(1);
    expect(snapshot.items[0].evidenceId).toBe("evidence-a");
    expect(snapshot.items[0].dedupeOf).not.toBeNull();
  });

  it("同一 ASIN 的两次采集（sourceProofHash / evidenceId 不同）→ 事实指纹不同，按 asin_conflict FAIL CLOSED", () => {
    // sourceProof 属于事实内容，因此「同 ASIN、来源证据不同」不会被静默去重，必须由调用方选版本。
    const error = captureMarketScanSampleError(() =>
      snapshotOf([
        makeSampleInput({ asin: "B0DEDUP006", contentHash: "b".repeat(64) }),
        makeSampleInput({ asin: "B0DEDUP006", contentHash: "a".repeat(64) }),
      ]),
    );
    expect(error.code).toBe("sample_asin_conflict");
  });

  it("一次丢弃多条时 dedupeOf 取被丢弃 hash 的字典序最小者（确定性）", () => {
    const snapshot = snapshotOf([
      makeSampleInput({ asin: "B0DEDUP004", evidenceVersion: 3 }),
      makeSampleInput({ asin: "B0DEDUP004", evidenceVersion: 2 }),
      makeSampleInput({ asin: "B0DEDUP004", evidenceVersion: 1 }),
    ]);

    expect(snapshot.itemCount).toBe(1);
    const [item] = snapshot.items;
    expect(item.evidenceVersion).toBe(1);

    const discardedHashes = [
      sampleItemHashOf({ ...draftOfItem(item), evidenceVersion: 2 }),
      sampleItemHashOf({ ...draftOfItem(item), evidenceVersion: 3 }),
    ].sort();
    expect(item.dedupeOf).toBe(discardedHashes[0]);
  });

  it("ASIN 去空格并大写", () => {
    const snapshot = snapshotOf([makeSampleInput({ asin: "  b0dedup005  " })]);

    expect(snapshot.items[0].asin).toBe("B0DEDUP005");
  });

  it("入参 evidenceId / capturedAt 优先于 ProductFact 自身的来源记录", () => {
    const snapshot = snapshotOf([
      makeSampleInput({
        asin: "B0OVERR001",
        evidenceIdOverride: "evidence-from-ledger",
        capturedAtOverride: "2025-03-04T05:06:07.000Z",
        candidateId: "candidate-9",
      }),
    ]);

    const [item] = snapshot.items;
    expect(item.evidenceId).toBe("evidence-from-ledger");
    expect(item.capturedAt).toBe("2025-03-04T05:06:07.000Z");
    expect(item.candidateId).toBe("candidate-9");
  });

  it("无版本信息时 evidenceVersion 回落到 1", () => {
    const snapshot = snapshotOf([
      makeSampleInput({ asin: "B0VERSN001", evidenceVersion: null }),
    ]);
    expect(snapshot.items[0].evidenceVersion).toBe(1);
  });
});

describe("buildSampleSnapshot — 排序、itemCount 与 sampleHash", () => {
  it("按 asin 升序排序（与输入顺序无关），itemCount 为去重后条目数", () => {
    const sample = [
      makeSampleInput({ asin: "B0SORT0003", evidenceId: "e-3" }),
      makeSampleInput({ asin: "B0SORT0001", evidenceIdOverride: "e-1" }),
      makeSampleInput({ asin: "B0SORT0002", evidenceId: "e-2" }),
      makeSampleInput({ asin: "B0SORT0001", evidenceIdOverride: "e-1b" }),
    ];

    const first = snapshotOf(sample);
    const second = snapshotOf([...sample].reverse());

    expect(first.items.map((item) => item.asin)).toEqual([
      "B0SORT0001",
      "B0SORT0002",
      "B0SORT0003",
    ]);
    expect(first.itemCount).toBe(first.items.length);
    expect(second.itemCount).toBe(first.itemCount);
    expect(second.sampleHash).toBe(first.sampleHash);
    expect(first.schemaVersion).toBe("market-scan-sample.v1");
    expect(first.metricsVersion).toBe(METRICS_VERSION);
  });

  it("sampleHash 与契约定义一致（{nicheDefinition, sampleDefinition, items, metricsVersion}）", () => {
    const snapshot = snapshotOf([makeSampleInput({ asin: "B0SAMPLE01" })]);
    const expected = sha256Hex(
      stableStringify({
        nicheDefinition: FIXTURE_NICHE_DEFINITION,
        sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
        items: snapshot.items,
        metricsVersion: METRICS_VERSION,
      }),
    );

    expect(snapshot.sampleHash).toBe(expected);
    expect(snapshot.sampleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("metricsVersion 变化 → sampleHash 变化，且快照透传该版本", () => {
    const sample = [makeSampleInput({ asin: "B0SAMPLE02" })];
    const base = snapshotOf(sample, "market-metrics.v1");
    const other = snapshotOf(sample, "market-metrics.v2");

    expect(other.metricsVersion).toBe("market-metrics.v2");
    expect(other.sampleHash).not.toBe(base.sampleHash);
  });

  it("调用方提供 factValues 时原样冻结（不现场重投影）", () => {
    const frozen = fixtureFactValues({
      asin: "B0FROZEN01",
      price: { presence: "present", value: { amount: 777, currency: "USD" }, valueSource: "FACT" },
    });
    const snapshot = snapshotOf([
      makeSampleInput({ asin: "B0FROZEN01", price: 19.99, factValues: frozen }),
    ]);

    expect(snapshot.items[0].factValues).toEqual(frozen);
    expect(snapshot.items[0].asin).toBe("B0FROZEN01");
  });

  it("冻结的事实值变化 → 快照 hash 变化（版本锁定覆盖 factValues）", () => {
    const base = snapshotOf([makeSampleInput({ asin: "B0LOCKED01" })]);
    const mutated = snapshotOf([
      makeSampleInput({
        asin: "B0LOCKED01",
        factValues: fixtureFactValues({
          asin: "B0LOCKED01",
          price: {
            presence: "present",
            value: { amount: 1, currency: "USD" },
            valueSource: "FACT",
          },
        }),
      }),
    ]);

    expect(mutated.sampleHash).not.toBe(base.sampleHash);
    expect(mutated.items[0].factValuesFingerprint).not.toBe(
      base.items[0].factValuesFingerprint,
    );
    // 只改 subjectKey 也必须改变自证指纹。
    expect(
      factValuesFingerprintOf({
        subjectKey: "other-subject",
        factValues: base.items[0].factValues,
      }),
    ).not.toBe(base.items[0].factValuesFingerprint);
  });

  it("服务层回灌快照成员时 itemCount === metrics.sampleCount（含去重场景）", () => {
    const snapshot = snapshotOf([
      makeSampleInput({ asin: "B0REPLAY01", evidenceVersion: 2 }),
      makeSampleInput({ asin: "B0REPLAY01", evidenceVersion: 1 }),
      makeSampleInput({ asin: "B0REPLAY02" }),
    ]);

    const metrics = metricsFromSnapshot(snapshot);
    expect(snapshot.itemCount).toBe(2); // 同 ASIN 同事实去重
    expect(metrics.sampleCount).toBe(snapshot.itemCount);
    expect(metrics.sampleHash).toBe(snapshot.sampleHash);
    expect(metrics.metricsVersion).toBe(snapshot.metricsVersion);
    expect(metrics.validSampleCount).toBe(2);
    expect(metrics.price.status).toBe("PRESENT");
    expect(metrics.price.value?.min).toBe(19.99);
    expect(metrics.notes.some((note) => note.includes("sampleHash"))).toBe(false);
  });

  it("调用方未提供 sampleHash 时不臆造：返回空串并写入 notes", () => {
    const metrics = computeMarketMetricsV1({
      sample: [makeSampleInput({ asin: "B0NOHASH01" })],
      referenceDate: FIXTURE_REFERENCE_DATE,
    });

    expect(metrics.sampleHash).toBe("");
    expect(metrics.notes.some((note) => note.includes("sampleHash"))).toBe(true);
  });
});
