import { describe, expect, it, vi } from "vitest";

// 内存版 V5OperationReceipt 存储：让真实 withV5Receipt 语义（成功重放 /
// retryable 失败重执行 / 非 retryable 锁键）在单测中可运行，不触碰任何真实数据库。
vi.mock("@/lib/server/db", () => {
  type ReceiptRow = {
    id: string;
    actorScope: string;
    operation: string;
    resourceKey: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    responseJson: string | null;
    errorCode: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  const rows: ReceiptRow[] = [];
  const keyOf = (value: {
    actorScope: string;
    operation: string;
    resourceKey: string;
    idempotencyKey: string;
  }) => `${value.actorScope}|${value.operation}|${value.resourceKey}|${value.idempotencyKey}`;
  return {
    prisma: {
      v5OperationReceipt: {
        async findUnique({ where }: { where: Record<string, unknown> }) {
          if ("id" in where) {
            return rows.find((row) => row.id === where.id) ?? null;
          }
          const key = keyOf(where as Parameters<typeof keyOf>[0]);
          return rows.find((row) => keyOf(row) === key) ?? null;
        },
        async create({ data }: { data: Partial<ReceiptRow> }) {
          const row: ReceiptRow = {
            status: "processing",
            responseJson: null,
            errorCode: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            id: "",
            actorScope: "",
            operation: "",
            resourceKey: "",
            idempotencyKey: "",
            requestHash: "",
            ...data,
          };
          rows.push(row);
          return row;
        },
        async update({ where, data }: { where: { id: string }; data: Partial<ReceiptRow> }) {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error("record not found");
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; status: string; updatedAt: Date };
          data: Partial<ReceiptRow>;
        }) {
          const row = rows.find(
            (candidate) =>
              candidate.id === where.id
              && candidate.status === where.status
              && candidate.updatedAt.getTime() === where.updatedAt.getTime(),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data, { updatedAt: new Date() });
          return { count: 1 };
        },
      },
    },
  };
});

import {
  buildEnrichedReferenceJson,
  enrichBatchWithAmazonDetail,
  resolveDetailEvidence,
  readBatchDetailFieldProvenance,
  FIELD_PROVENANCE_SCHEMA,
  type BatchDetailEnrichmentDeps,
  type BatchDetailEnrichmentItemResult,
} from "@/lib/server/batchDetailEnrichmentService";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";

const OWNER = { mode: "owner", token: "" } as AccessContext;

function batchItem(overrides: Partial<ProductBatchItemView> = {}): ProductBatchItemView {
  const reference = {
    schemaVersion: "amazon-search-product-reference.v1",
    marketplace: "US",
    asin: "B0C9S5PMSD",
    title: "Test Gloves",
    image: "https://m.media-amazon.com/images/I/x.jpg",
    imageUrl: "https://m.media-amazon.com/images/I/x.jpg",
    imageAvailability: "AUTHORITATIVE_IMAGE_AVAILABLE",
    brand: null,
    category: null,
    bsr: null,
    comparisonFacts: {
      price: { value: { amount: 8.98, currency: "USD" }, status: "confirmed" },
      rating: { value: 4.8, status: "confirmed" },
      reviewCount: { value: 30, status: "confirmed" },
    },
  };
  return {
    id: "item-1",
    batchId: "batch-000001",
    productKey: "amazon:US:B0C9S5PMSD",
    ordinal: 0,
    asin: "B0C9S5PMSD",
    parentAsin: null,
    itemIdentityHash: "1".repeat(64),
    itemHash: "2".repeat(64),
    evidenceHash: "3".repeat(64),
    normalizedProductJson: JSON.stringify(reference),
    occurrenceProjectionJson: "{}",
    familyProjectionJson: "{}",
    rankingJson: "{}",
    provisionalDisposition: "insufficient_required_signals",
    researchPriority: "unranked_insufficient_evidence",
    evidenceStatus: "limited_evidence",
    promotionEligible: false,
    imageSnapshotJson: JSON.stringify({ status: "not_cached" }),
    archivedAt: null,
    createdAt: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

function fact(overrides: {
  brand?: string | null;
  category?: string | null;
  bsr?: number | null;
} = {}): ProductFact {
  return {
    basic: {
      brand: { value: overrides.brand !== undefined ? overrides.brand : "Supmedic" },
      category: { value: overrides.category !== undefined ? overrides.category : "Medical" },
    },
    market: {
      bsr: { value: overrides.bsr !== undefined ? overrides.bsr : 3560 },
    },
  } as unknown as ProductFact;
}

const DETAIL_EVIDENCE = {
  evidenceId: "ev-cap-detail-1",
  captureId: "cap-detail-1",
  version: 2,
  subjectKey: "amazon:US:B0C9S5PMSD",
  sourceType: "amazon_dom",
  capturedAt: "2026-10-07T02:00:00.000Z",
  contentHash: "a".repeat(64),
  pkg: {
    subjectKey: "amazon:US:B0C9S5PMSD",
    marketplace: "US",
    fields: { asin: "B0C9S5PMSD" },
    sourceProof: {
      sourceType: "amazon_dom",
      entityBinding: {
        bound: true,
        expectedAsin: "B0C9S5PMSD",
        observedAsin: "B0C9S5PMSD",
        urlAsin: "B0C9S5PMSD",
        expectedMarketplace: "US",
        observedMarketplace: "US",
        urlMarketplace: "US",
      },
    },
  },
} as unknown as CaptureEvidenceRecord;

function detailSubject(): EvidenceSubjectRecord {
  return {
    subjectKey: "amazon:US:B0C9S5PMSD",
    versions: [DETAIL_EVIDENCE],
    attachments: [
      {
        schemaVersion: "source-evidence-attachment.v1",
        attachmentId: "att-1",
        subjectKey: "amazon:US:B0C9S5PMSD",
        kind: "v3_amazon_detail_v1",
        sourceType: "amazon_dom",
        capturedAt: "2026-10-07T02:00:00.000Z",
        sourceUrl: null,
        sourceFingerprint: null,
        contentHash: "b".repeat(64),
        payload: {
          schemaVersion: "capture-system-v3-module-evidence.v1",
          module: "amazon_detail",
          subjectKey: "amazon:US:B0C9S5PMSD",
          marketplace: "US",
          capturedAt: "2026-10-07T02:00:00.000Z",
          identity: { asin: "B0C9S5PMSD" },
        },
      },
    ],
  } as unknown as EvidenceSubjectRecord;
}

/** 模拟「本轮刚采集完成」：证据版本 capturedAt = Gateway capturedAt，无附件（走 fallback 关联）。 */
function capturedSubject(capturedAt: string, asin = "B0C9S5PMSD"): EvidenceSubjectRecord {
  const binding = {
    bound: true,
    expectedAsin: asin,
    observedAsin: asin,
    urlAsin: asin,
    expectedMarketplace: "US",
    observedMarketplace: "US",
    urlMarketplace: "US",
  };
  return {
    subjectKey: `amazon:US:${asin}`,
    versions: [{
      ...DETAIL_EVIDENCE,
      subjectKey: `amazon:US:${asin}`,
      capturedAt,
      pkg: {
        ...DETAIL_EVIDENCE.pkg,
        subjectKey: `amazon:US:${asin}`,
        fields: { ...DETAIL_EVIDENCE.pkg.fields, asin },
        sourceProof: { ...DETAIL_EVIDENCE.pkg.sourceProof, entityBinding: binding },
      },
    }],
    attachments: [],
  } as unknown as EvidenceSubjectRecord;
}

/** 与 deps.captureAsin 返回类型对齐的假结果（单点 cast，避免字面量拓宽）。 */
type CaptureResult = Awaited<ReturnType<BatchDetailEnrichmentDeps["captureAsin"]>>;

function capturedResult(overrides: Record<string, unknown> = {}): CaptureResult {
  return {
    status: "captured",
    trace: null,
    extraction: null,
    capture: { capturedAt: "2026-10-07T03:00:00.000Z" },
    errorCode: null,
    errorMessage: null,
    consoleErrors: 0,
    pageErrors: 0,
    browser: null,
    ...overrides,
  } as CaptureResult;
}

function makeDeps(options: {
  items: ProductBatchItemView[];
  batch?: { id: string; batchStatus: string } | null;
  subjects?: Record<string, EvidenceSubjectRecord | null>;
  captureResults?: Array<Record<string, unknown>>;
  facts?: ProductFact;
  now?: () => Date;
}) {
  const updatedJson: string[] = [];
  const captureCalls: string[] = [];
  const store = {
    async getBatch(batchId: string) {
      return options.batch === null
        ? null
        : { id: batchId, batchStatus: options.batch?.batchStatus ?? "ready" };
    },
    async getBatchItems(batchId: string) {
      void batchId;
      return options.items;
    },
    async updateBatchItemEnrichment(
      _batchId: string,
      _itemId: string,
      input: { normalizedProductJson: string },
    ) {
      updatedJson.push(input.normalizedProductJson);
      return { updated: true };
    },
  } as unknown as ProductBatchStore;
  const deps: BatchDetailEnrichmentDeps = {
    getStore: () => store,
    captureAsin: (input) => {
      captureCalls.push(input.asin);
      const next = options.captureResults?.shift();
      return Promise.resolve(capturedResult(next ?? {}));
    },
    getSubject: (subjectKey) => Promise.resolve(options.subjects?.[subjectKey] ?? null),
    factFromEvidence: () => options.facts ?? fact(),
    logEvent: () => Promise.resolve(),
    // Fixture captures are timestamped at 2026-10-07; keep the default test clock
    // deterministic and inside the detail evidence freshness window.
    now: options.now ?? (() => new Date("2026-10-07T04:00:00.000Z")),
  };
  return { deps, updatedJson, captureCalls };
}

describe("resolveDetailEvidence（详情证据判别）", () => {
  it("amazon_search_market 附件不算详情证据", async () => {
    const subject = {
      versions: [{ ...DETAIL_EVIDENCE }],
      attachments: [{
        payload: { module: "amazon_search_market", capturedAt: "2026-10-07T02:00:00.000Z" },
      }],
    } as unknown as EvidenceSubjectRecord;
    const resolved = await resolveDetailEvidence(async () => subject, "B0C9S5PMSD");
    expect(resolved).toBeNull();
  });

  it("amazon_detail 附件按 capturedAt 精确关联版本", async () => {
    const resolved = await resolveDetailEvidence(
      async () => detailSubject(),
      "B0C9S5PMSD",
      undefined,
      new Date("2026-10-07T03:00:00.000Z"),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.evidenceId).toBe("ev-cap-detail-1");
  });

  it("身份绑定不匹配或详情证据超过当前新鲜度周期时拒绝复用", async () => {
    const wrongBinding = {
      ...detailSubject(),
      versions: [{
        ...DETAIL_EVIDENCE,
        pkg: {
          ...DETAIL_EVIDENCE.pkg,
          sourceProof: {
            ...DETAIL_EVIDENCE.pkg.sourceProof,
            entityBinding: { ...DETAIL_EVIDENCE.pkg.sourceProof.entityBinding, observedAsin: "B08D7457XZ" },
          },
        },
      }],
    } as unknown as EvidenceSubjectRecord;
    expect(await resolveDetailEvidence(
      async () => wrongBinding,
      "B0C9S5PMSD",
      undefined,
      new Date("2026-10-08T00:00:00.000Z"),
    )).toBeNull();

    expect(await resolveDetailEvidence(
      async () => detailSubject(),
      "B0C9S5PMSD",
      undefined,
      new Date("2026-10-15T02:00:01.000Z"),
    )).toBeNull();
  });

  it("关联失败返回 null（fail-safe 走重新采集）", async () => {
    const subject = {
      versions: [{ ...DETAIL_EVIDENCE }],
      attachments: [{
        payload: { module: "amazon_detail", capturedAt: "2099-01-01T00:00:00.000Z" },
      }],
    } as unknown as EvidenceSubjectRecord;
    expect(await resolveDetailEvidence(async () => subject, "B0C9S5PMSD")).toBeNull();
  });

  it("无附件时可用 Gateway capturedAt 兜底关联（本轮刚采集）", async () => {
    const resolved = await resolveDetailEvidence(
      async () => capturedSubject("2026-10-07T03:00:00.000Z"),
      "B0C9S5PMSD",
      "2026-10-07T03:00:00.000Z",
      new Date("2026-10-07T04:00:00.000Z"),
    );
    expect(resolved?.evidenceId).toBe("ev-cap-detail-1");
  });
});

describe("buildEnrichedReferenceJson（additive 回写）", () => {
  it("只填 null 字段并新增 enrichment 块，comparisonFacts 逐字节保留", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    const before = JSON.stringify(reference.comparisonFacts);
    const result = buildEnrichedReferenceJson({
      reference,
      fact: fact(),
      evidence: { evidenceId: "ev-1", version: 2, contentHash: "a".repeat(64), capturedAt: "2026-10-07T02:00:00.000Z" },
      now: new Date("2026-10-07T03:00:00.000Z"),
    });
    expect(result.status).toBe("enriched");
    expect(result.fields).toEqual(["brand", "category", "bsr"]);
    const after = JSON.parse(result.json) as Record<string, unknown>;
    expect(JSON.stringify(after.comparisonFacts)).toBe(before);
    expect(after.image).toBe("https://m.media-amazon.com/images/I/x.jpg");
    expect(after.brand).toBe("Supmedic");
    expect((after.bsr as { rank: number }).rank).toBe(3560);
    const enrichment = after.enrichment as Record<string, unknown>;
    expect(enrichment.schemaVersion).toBe("amazon-batch-detail-enrichment.v1");
    expect(enrichment.evidenceId).toBe("ev-1");
    expect(enrichment.fields).toEqual(["brand", "category", "bsr"]);
  });

  it("页面真实缺字段：缺的保持 null，状态为 captured_partial，不虚构", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    const result = buildEnrichedReferenceJson({
      reference,
      fact: fact({ brand: null, category: null, bsr: null }),
      evidence: { evidenceId: "ev-1", version: 2, contentHash: "a".repeat(64), capturedAt: "2026-10-07T02:00:00.000Z" },
      now: new Date(),
    });
    expect(result.status).toBe("captured_partial");
    expect(result.fields).toEqual([]);
    const after = JSON.parse(result.json) as Record<string, unknown>;
    expect(after.brand).toBeNull();
    expect(after.category).toBeNull();
    expect(after.bsr).toBeNull();
    expect((after.enrichment as Record<string, unknown>).status).toBe("captured_partial");
  });

  it("已有非 null 值不被覆盖", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    reference.brand = "Existing";
    const result = buildEnrichedReferenceJson({
      reference,
      fact: fact(),
      evidence: { evidenceId: "ev-1", version: 2, contentHash: "a".repeat(64), capturedAt: "2026-10-07T02:00:00.000Z" },
      now: new Date(),
    });
    const after = JSON.parse(result.json) as Record<string, unknown>;
    expect(after.brand).toBe("Existing");
    expect(result.fields).toEqual(["category", "bsr"]);
  });
});

describe("enrichBatchWithAmazonDetail（run 级行为）", () => {
  it("PENDING → 采集 → 补齐：更新条目且 captured=true", async () => {
    const { deps, updatedJson, captureCalls } = makeDeps({
      items: [batchItem()],
      subjects: { "amazon:US:B0C9S5PMSD": capturedSubject("2026-10-07T03:00:00.000Z") },
      captureResults: [{}],
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-1",
      deps,
    });
    expect(result.value.summary).toMatchObject({ total: 1, captured: 1, enriched: 1 });
    expect(captureCalls).toEqual(["B0C9S5PMSD"]);
    expect(updatedJson).toHaveLength(1);
    const written = JSON.parse(updatedJson[0]) as Record<string, unknown>;
    expect(written.enrichment).toBeTruthy();
  });

  it("已有详情证据（FRESH）→ 跳过采集仅补齐投影", async () => {
    const { deps, updatedJson, captureCalls } = makeDeps({
      items: [batchItem()],
      subjects: { "amazon:US:B0C9S5PMSD": detailSubject() },
      now: () => new Date("2026-10-07T03:00:00.000Z"),
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-2",
      deps,
    });
    expect(captureCalls).toEqual([]);
    expect(result.value.summary.captured).toBe(0);
    expect(result.value.summary.enriched).toBe(1);
    expect(updatedJson).toHaveLength(1);
  });

  it("显式单 ASIN 重采会忽略终态投影并且不触碰同批次其它 ASIN", async () => {
    const selected = batchItem();
    const reference = JSON.parse(selected.normalizedProductJson) as Record<string, unknown>;
    reference.enrichment = {
      schemaVersion: "amazon-batch-detail-enrichment.v1", module: "amazon_detail", status: "enriched",
      evidenceId: "old-evidence", evidenceVersion: 1, contentHash: "d".repeat(64),
      capturedAt: "2026-10-06T00:00:00.000Z", fields: ["brand"],
    };
    selected.normalizedProductJson = JSON.stringify(reference);
    const other = batchItem({ id: "item-2", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ", ordinal: 1 });
    const { deps, captureCalls, updatedJson } = makeDeps({
      items: [selected, other],
      subjects: { "amazon:US:B0C9S5PMSD": capturedSubject("2026-10-07T03:00:00.000Z") },
      captureResults: [{}],
    });

    const result = await enrichBatchWithAmazonDetail({
      context: OWNER, batchId: "batch-000001", limit: 1, targetAsin: "b0c9s5pmsd", forceRecapture: true,
      idempotencyKey: "test-force-recollect-detail", deps,
    });

    expect(captureCalls).toEqual(["B0C9S5PMSD"]);
    expect(result.value.items.map((entry) => entry.asin)).toEqual(["B0C9S5PMSD"]);
    expect(result.value.items[0]?.captured).toBe(true);
    expect(updatedJson).toHaveLength(1);
  });

  it("完整补齐条目 enriched 跳过且保留原始状态和证据", async () => {
    const enrichedItem = batchItem();
    const reference = JSON.parse(enrichedItem.normalizedProductJson) as Record<string, unknown>;
    reference.enrichment = {
      schemaVersion: "amazon-batch-detail-enrichment.v1", status: "enriched", module: "amazon_detail",
      evidenceId: "ev-existing", evidenceVersion: 2, contentHash: "a".repeat(64), capturedAt: "2026-10-07T02:00:00.000Z",
      captureOrigin: "CAPTURED_NOW",
    };
    enrichedItem.normalizedProductJson = JSON.stringify(reference);
    const { deps, captureCalls } = makeDeps({
      items: [enrichedItem, batchItem({ id: "item-2", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ", ordinal: 1 })],
      subjects: { "amazon:US:B08D7457XZ": capturedSubject("2026-10-07T03:00:00.000Z", "B08D7457XZ") },
      captureResults: [{}],
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 1,
      idempotencyKey: "test-key-3",
      deps,
    });
    expect(captureCalls).toEqual(["B08D7457XZ"]);
    expect(result.value.summary.total).toBe(1);
    expect(result.value.summary.skippedEnriched).toBe(1);
    expect(result.value.items[0]).toMatchObject({
      status: "skipped_enriched", existingEnrichmentStatus: "enriched",
      evidenceId: "ev-existing", evidenceVersion: 2, captureOrigin: "CAPTURED_NOW",
    });
  });

  it("captured_partial 不得直接跳过：真实补采缺失字段，已有字段不被覆盖", async () => {
    /**
     * 根因回归：7 个 captured_partial 商品详情曾被当成「已补齐」永久跳过。
     * 现在 partial 必须补采：只填 null 字段，已有 brand 与其字段级来源保持原样。
     */
    const partialItem = batchItem();
    const reference = JSON.parse(partialItem.normalizedProductJson) as Record<string, unknown>;
    reference.brand = "Existing Brand";
    reference.category = null;
    reference.bsr = null;
    reference.enrichment = {
      schemaVersion: "amazon-batch-detail-enrichment.v1", status: "captured_partial", module: "amazon_detail",
      evidenceId: "ev-existing", evidenceVersion: 2, contentHash: "a".repeat(64), capturedAt: "2026-10-07T02:00:00.000Z",
      captureOrigin: "CAPTURED_NOW",
    };
    partialItem.normalizedProductJson = JSON.stringify(reference);
    const { deps, captureCalls, updatedJson } = makeDeps({
      items: [partialItem],
      subjects: { "amazon:US:B0C9S5PMSD": capturedSubject("2026-10-07T03:00:00.000Z") },
      captureResults: [{}],
    });

    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-partial-supplement",
      deps,
    });

    // 必须真正发起采集（不是 skipped_enriched）
    expect(captureCalls).toEqual(["B0C9S5PMSD"]);
    expect(result.value.summary.skippedEnriched).toBe(0);
    expect(result.value.items[0]).toMatchObject({ asin: "B0C9S5PMSD", captured: true });
    expect(result.value.items[0]?.status).toBe("enriched");

    const written = JSON.parse(updatedJson[0] ?? "{}") as Record<string, unknown>;
    // 已有字段保持原值；只补缺失字段
    expect(written.brand).toBe("Existing Brand");
    expect(written.category).toBe("Medical");
    expect(written.bsr).toEqual({ rank: 3560, category: "Medical" });
    expect((written.enrichment as Record<string, unknown>).status).toBe("enriched");
  });

  it("FAILED_PERMANENT 不影响后续条目（失败隔离）", async () => {
    const { deps } = makeDeps({
      items: [
        batchItem({ id: "item-1", asin: "B0ZZZZZZZZ", productKey: "amazon:US:B0ZZZZZZZZ" }),
        batchItem({ id: "item-2", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ", ordinal: 1 }),
      ],
      subjects: { "amazon:US:B08D7457XZ": capturedSubject("2026-10-07T03:00:00.000Z", "B08D7457XZ") },
      captureResults: [{ status: "failed", errorCode: "ASIN_NOT_FOUND" }, {}],
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-4",
      deps,
    });
    expect(result.value.summary.failedPermanent).toBe(1);
    expect(result.value.summary.enriched).toBe(1);
    const statuses = result.value.items.map((item: BatchDetailEnrichmentItemResult) => item.status);
    expect(statuses).toEqual(["failed_permanent", "enriched"]);
  });

  it("FAILED_HUMAN 熔断整轮：后续条目不再处理", async () => {
    const { deps } = makeDeps({
      items: [
        batchItem({ id: "item-1", asin: "B0CAPTCHA01", productKey: "amazon:US:B0CAPTCHA01" }),
        batchItem({ id: "item-2", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ", ordinal: 1 }),
      ],
      subjects: {},
      captureResults: [{ status: "human_required", errorCode: "CAPTCHA_DETECTED" }, {}],
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-5",
      deps,
    });
    expect(result.value.summary.failedHuman).toBe(1);
    expect(result.value.summary.humanAborted).toBe(true);
    expect(result.value.items).toHaveLength(1);
  });

  it("human_required 携带非真人错误码（如不存在 ASIN 的 PAGE_CHANGED）→ 按错误码分类且不熔断", async () => {
    const { deps } = makeDeps({
      items: [
        batchItem({ id: "item-1", asin: "B0ZZZZZZZZ", productKey: "amazon:US:B0ZZZZZZZZ" }),
        batchItem({ id: "item-2", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ", ordinal: 1 }),
      ],
      subjects: { "amazon:US:B08D7457XZ": capturedSubject("2026-10-07T03:00:00.000Z", "B08D7457XZ") },
      captureResults: [{ status: "human_required", errorCode: "PAGE_CHANGED" }, {}],
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-5b",
      deps,
    });
    expect(result.value.summary.humanAborted).toBe(false);
    expect(result.value.summary.failedHuman).toBe(0);
    expect(result.value.summary.failedRetryable).toBe(1);
    expect(result.value.summary.enriched).toBe(1);
  });

  it("环境门失败抛 ENV_BLOCKED 且 retryable=true（不锁幂等键）", async () => {
    const { deps } = makeDeps({
      items: [batchItem()],
      subjects: {},
      captureResults: [{ status: "failed", errorCode: "LOCALE_MISMATCH" }],
    });
    await expect(enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-6",
      deps,
    })).rejects.toMatchObject({ code: "ENV_BLOCKED", retryable: true });
  });

  it("limit 等于新上限 30 接受", async () => {
    const { deps } = makeDeps({ items: [], subjects: {} });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 30,
      idempotencyKey: "test-key-30",
      deps,
    });
    expect(result.value.summary.total).toBe(0);
  });

  it("limit 31+ 拒绝", async () => {
    const { deps } = makeDeps({ items: [], subjects: {} });
    await expect(enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 31,
      idempotencyKey: "test-key-31",
      deps,
    })).rejects.toMatchObject({ code: "ENRICHMENT_LIMIT_INVALID" });
    await expect(enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 60,
      idempotencyKey: "test-key-60",
      deps,
    })).rejects.toMatchObject({ code: "ENRICHMENT_LIMIT_INVALID" });
  });

  it("timings 输出平均耗时/P95/失败率（受控时钟）", async () => {
    let tick = 0;
    const { deps } = makeDeps({
      items: [
        batchItem({ id: "item-1", asin: "B08D7457XZ", productKey: "amazon:US:B08D7457XZ" }),
        batchItem({ id: "item-2", asin: "B0ZZZZZZZZ", productKey: "amazon:US:B0ZZZZZZZZ", ordinal: 1 }),
      ],
      subjects: { "amazon:US:B08D7457XZ": capturedSubject("2026-10-07T03:00:00.000Z", "B08D7457XZ") },
      captureResults: [{}, { status: "failed", errorCode: "ASIN_NOT_FOUND" }],
      // 每次调用推进 250ms：条目1 startedAt=t0、结束=t3 → 750ms；条目2 立即失败 → 750ms/2 步。
      now: () => new Date(Date.parse("2026-10-07T04:00:00.000Z") + (tick++) * 250),
    });
    const result = await enrichBatchWithAmazonDetail({
      context: OWNER,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-8",
      deps,
    });
    expect(result.value.timings.avgMs).toBeGreaterThan(0);
    expect(result.value.timings.p95Ms).toBeGreaterThanOrEqual(result.value.timings.avgMs);
    expect(result.value.timings.failureRate).toBeCloseTo(0.5, 2);
  });

  it("demo 主体拒绝（owner-only）", async () => {
    const { deps } = makeDeps({ items: [], subjects: {} });
    await expect(enrichBatchWithAmazonDetail({
      context: { mode: "demo", demoAccessId: "demo_x" } as unknown as AccessContext,
      batchId: "batch-000001",
      limit: 5,
      idempotencyKey: "test-key-9",
      deps,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-03：字段级来源（跨多次补齐运行累积）
//
// 背景：`enrichment.evidenceId/evidenceVersion/contentHash` 描述的是**最近一次**补齐
// 运行所使用的证据。修复前，第二轮补齐会把它整块覆盖，使历史字段（例如由更早版本填充
// 的 brand/bsr）被错误地归因到后来的证据上 —— 这正是 B0DKNN9WCX 在 60-ASIN 报告里
// 「投影含 v0011 的 bsr，却只引用 v0010」的成因。
// 断言：每个字段必须继续指向**真正供给它**的那份证据，且不完整来源必须被丢弃而非回退。
// ─────────────────────────────────────────────────────────────────────────────
describe("G-03：字段级来源跨补齐运行累积", () => {
  const EVIDENCE_A = {
    evidenceId: "ev-cap-a",
    version: 3,
    contentHash: "a".repeat(64),
    capturedAt: "2026-10-07T01:00:00.000Z",
  };
  const EVIDENCE_B = {
    evidenceId: "ev-cap-b",
    version: 4,
    contentHash: "b".repeat(64),
    capturedAt: "2026-10-07T22:00:00.000Z",
  };
  type Entry = { field: string; evidenceId: string; evidenceVersion: number; contentHash: string; capturedAt: string };
  const entriesOf = (json: string): Entry[] => {
    const parsed = JSON.parse(json) as { enrichment: { fieldProvenance: { entries: Entry[] } } };
    return parsed.enrichment.fieldProvenance.entries;
  };

  it("后续补齐运行不得把历史字段的来源改写成自己（锁死 B0DKNN9WCX 症状）", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    const first = buildEnrichedReferenceJson({
      reference,
      fact: fact(),
      evidence: EVIDENCE_A,
      now: new Date("2026-10-07T02:00:00.000Z"),
    });
    expect(first.fields).toEqual(["brand", "category", "bsr"]);
    const afterFirst = JSON.parse(first.json) as Record<string, unknown>;

    // 第二轮：reference 三个字段已非 null → 本轮不填充任何字段
    const second = buildEnrichedReferenceJson({
      reference: afterFirst,
      fact: fact({ brand: "Other Brand", category: "Other", bsr: 999 }),
      evidence: EVIDENCE_B,
      now: new Date("2026-10-07T23:00:00.000Z"),
    });
    expect(second.fields).toEqual([]);
    const afterSecond = JSON.parse(second.json) as Record<string, unknown>;
    expect(afterSecond.brand).toBe("Supmedic");
    expect((afterSecond.bsr as { rank: number }).rank).toBe(3560);

    const enrichment = afterSecond.enrichment as Record<string, unknown>;
    // 顶部语义未变（兼容既有消费方）：它仍是「本轮运行的证据」。
    expect(enrichment.evidenceId).toBe("ev-cap-b");
    expect(enrichment.fields).toEqual([]);

    // 关键断言：字段来源仍指向真正供给它们的 ev-cap-a。
    const entries = entriesOf(second.json);
    expect(entries.map((entry) => entry.field)).toEqual(["brand", "bsr", "category"]);
    for (const entry of entries) {
      expect(entry.evidenceId).toBe("ev-cap-a");
      expect(entry.evidenceVersion).toBe(3);
      expect(entry.contentHash).toBe("a".repeat(64));
      expect(entry.capturedAt).toBe(EVIDENCE_A.capturedAt);
      expect(entry.evidenceId).not.toBe(enrichment.evidenceId);
    }
  });

  it("多来源字段各自指向真正供应该字段的版本", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    const first = buildEnrichedReferenceJson({
      reference,
      fact: fact({ bsr: null }),
      evidence: EVIDENCE_A,
      now: new Date("2026-10-07T02:00:00.000Z"),
    });
    expect(first.fields).toEqual(["brand", "category"]);

    const second = buildEnrichedReferenceJson({
      reference: JSON.parse(first.json) as Record<string, unknown>,
      fact: fact(),
      evidence: EVIDENCE_B,
      now: new Date("2026-10-07T23:00:00.000Z"),
    });
    expect(second.fields).toEqual(["bsr"]);

    const byField = new Map(entriesOf(second.json).map((entry) => [entry.field, entry]));
    expect(byField.get("brand")?.evidenceId).toBe("ev-cap-a");
    expect(byField.get("category")?.evidenceId).toBe("ev-cap-a");
    expect(byField.get("bsr")?.evidenceId).toBe("ev-cap-b");
    expect(byField.get("bsr")?.evidenceVersion).toBe(4);
  });

  it("损坏的历史来源被丢弃，且不得回退成用当前证据包装历史字段", () => {
    const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
    reference.enrichment = {
      schemaVersion: "amazon-batch-detail-enrichment.v1",
      status: "enriched",
      module: "amazon_detail",
      evidenceId: "ev-legacy",
      evidenceVersion: 1,
      contentHash: "c".repeat(64),
      capturedAt: "2026-10-07T00:00:00.000Z",
      enrichedAt: "2026-10-07T00:00:00.000Z",
      fields: ["brand", "category", "bsr"],
      fieldProvenance: {
        schemaVersion: FIELD_PROVENANCE_SCHEMA,
        entries: [
          { field: "brand", evidenceId: "ev-legacy", evidenceVersion: 1, contentHash: "NOT_A_HASH", capturedAt: "2026-10-07T00:00:00.000Z" },
          { field: "", evidenceId: "ev-legacy", evidenceVersion: 1, contentHash: "c".repeat(64), capturedAt: "2026-10-07T00:00:00.000Z" },
        ],
      },
    };
    expect(readBatchDetailFieldProvenance(reference.enrichment)).toEqual([]);

    const result = buildEnrichedReferenceJson({
      reference,
      fact: fact({ brand: null, category: null, bsr: null }),
      evidence: EVIDENCE_B,
      now: new Date("2026-10-07T23:00:00.000Z"),
    });
    expect(result.fields).toEqual([]);
    expect(entriesOf(result.json)).toEqual([]);
  });

  it("相同输入得到逐字节相同的输出（可复现）", () => {
    const runOnce = () => {
      const reference = JSON.parse(batchItem().normalizedProductJson) as Record<string, unknown>;
      return buildEnrichedReferenceJson({
        reference,
        fact: fact(),
        evidence: EVIDENCE_A,
        now: new Date("2026-10-07T02:00:00.000Z"),
      }).json;
    };
    expect(runOnce()).toBe(runOnce());
    expect(entriesOf(runOnce()).map((entry) => entry.field)).toEqual(["brand", "bsr", "category"]);
  });
});
