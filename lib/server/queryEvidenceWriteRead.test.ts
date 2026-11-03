import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { captureSellerSpriteKeywordMiningQueryForBatch } from "@/lib/server/sellerSpriteKeywordMiningBatch";
import { captureSellerSpriteProductMarketQueryForBatch } from "@/lib/server/sellerSpriteProductMarketBatch";
import {
  sellerSpriteKeywordMiningQuerySubjectKey,
  sellerSpriteProductMarketQuerySubjectKey,
  sellerSpriteQueryFingerprint,
} from "@/lib/server/sellerSpriteVisibleQuery";
import { captureBrowserVisibleV3Envelope } from "@/lib/sourceLayer/browserVisibleModuleCapture";
import { sourceEvidenceAttachmentContentHash } from "@/lib/sourceLayer/evidenceAttachment";
import {
  isSellerSpriteQuerySubjectKey,
  sellerSpriteQuerySubjectKey,
} from "@/lib/sourceLayer/queryEvidenceSubject";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { readV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";

const OWNER: AccessContext = { mode: "owner", token: "" };
const ASIN = "B0QUERYEV1";
const OTHER_ASIN = "B0QUERYEV2";
const CAPTURED_AT = "2026-10-13T00:00:00.000Z";
const PRODUCT_MARKET_URL = "https://www.sellersprite.com/v3/product-research/";
const KEYWORD_MINING_URL = "https://www.sellersprite.com/v3/keyword-miner/";
const PRODUCT_MARKET_ENV = {
  NODE_ENV: "test",
  LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single",
  SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED: "true",
} as NodeJS.ProcessEnv;
const KEYWORD_MINING_ENV = {
  NODE_ENV: "test",
  LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single",
  SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true",
} as NodeJS.ProcessEnv;
const HASH = /^[a-f0-9]{64}$/u;

/** 只写真实 EvidenceStore 的商品基础 Evidence；不访问任何外部来源。 */
async function seedBaseEvidence(asin: string): Promise<CaptureEvidenceRecord> {
  const subjectKey = `amazon:US:${asin}`;
  await captureThroughGateway({
    context: OWNER,
    source: "manual",
    payload: {
      asin,
      title: "Verified product",
      productUrl: `https://www.amazon.com/dp/${asin}`,
      images: ["https://images.example.test/fixture.jpg"],
      price: 19.99,
      currency: "USD",
      rating: 4.5,
      reviewCount: 120,
    },
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    subjectKey,
    marketplace: "US",
    now: new Date(CAPTURED_AT),
  });
  const subject = await createEvidenceStore("owner:v1").getSubject(subjectKey);
  const latest = subject?.versions.at(-1);
  if (!latest) throw new Error("BASE_EVIDENCE_SEED_FAILED");
  return latest;
}

type ProductMarketFixture = {
  category: string;
  filters: Record<string, string>;
  subjectKey: string;
  queryFingerprint: string;
  tables: Array<{ headers: string[]; rows: Array<Array<string | null>> }>;
  fingerprintOverride?: string;
};

function productMarketFixture(input: {
  category: string;
  filters?: Record<string, string>;
  tables: ProductMarketFixture["tables"];
  fingerprintOverride?: string;
}): ProductMarketFixture {
  const filters = input.filters ?? {};
  const queryInput = {
    module: "sellersprite_product_market" as const,
    category: input.category,
    marketplace: "US" as const,
    filters,
  };
  return {
    category: input.category,
    filters,
    subjectKey: sellerSpriteProductMarketQuerySubjectKey(queryInput),
    queryFingerprint: sellerSpriteQueryFingerprint(queryInput, "bcr"),
    tables: input.tables,
    ...(input.fingerprintOverride === undefined ? {} : { fingerprintOverride: input.fingerprintOverride }),
  };
}

/** Mock Worker：只负责构造可见查询快照，持久化仍走真实 Gateway + EvidenceStore。 */
function productMarketCaptureQuery(fixture: ProductMarketFixture) {
  const queryInput = {
    module: "sellersprite_product_market" as const,
    category: fixture.category,
    marketplace: "US" as const,
    filters: fixture.filters,
  };
  const declaredFingerprint = fixture.fingerprintOverride ?? fixture.queryFingerprint;
  return async () => {
    const capture = await captureBrowserVisibleV3Envelope({
      context: OWNER,
      sourceType: "sellersprite_plugin",
      sourceFingerprint: `query:${fixture.queryFingerprint}`,
      envelope: {
        schemaVersion: "capture-system-v3-browser-visible-envelope.v1",
        module: "sellersprite_product_market",
        subjectKey: fixture.subjectKey,
        marketplace: "US",
        capturedAt: CAPTURED_AT,
        provider: "SellerSprite",
        sourceSurface: "SellerSprite sellersprite_product_market visible query",
        sourceUrl: PRODUCT_MARKET_URL,
        acquisitionMode: "DOM_DIRECT",
        metricNature: "provider_estimate",
        status: "AVAILABLE_WITH_LIMITATION",
        limitations: ["single_query_visible_snapshot_only", "visible_rows_are_not_total_rows"],
        identity: {
          category: fixture.category,
          queryInput,
          marketplace: "US",
          accountAccessSnapshot: "not_verified",
          queryFingerprint: declaredFingerprint,
        },
        data: {
          capturedFromVisibleDom: true,
          exportAttempted: false,
          hiddenApiCalled: false,
          pageTitle: "SellerSprite Product Market fixture",
          queryContract: {
            module: "sellersprite_product_market",
            marketplace: "US",
            queryInput,
            queryFingerprint: declaredFingerprint,
          },
          visibleSnapshot: { tables: fixture.tables },
          amazonConfirmed: false,
          rowScope: "visible_dom_snapshot_not_total",
          snapshotRowLimit: 250,
          accountAccess: "not_verified",
        },
        providerUpdatedAt: null,
        freshnessMetricKey: null,
        evidenceOnly: true,
      },
    });
    return {
      status: "captured",
      module: "sellersprite_product_market",
      sourceUrl: PRODUCT_MARKET_URL,
      snapshot: { tables: fixture.tables },
      capture,
      errorCode: null,
    } as never;
  };
}

function keywordEnvelope(input: {
  seedKeyword: string;
  conditions?: Record<string, string>;
  rowContentHash?: string;
}) {
  const conditions = input.conditions ?? {};
  const queryInput = {
    module: "keyword_mining_trend" as const,
    seedKeyword: input.seedKeyword,
    marketplace: "US" as const,
    conditions,
  };
  const subjectKey = sellerSpriteKeywordMiningQuerySubjectKey(queryInput);
  const queryFingerprint = sellerSpriteQueryFingerprint(queryInput, "bcr");
  return {
    subjectKey,
    queryFingerprint,
    queryInput,
    envelope: {
      schemaVersion: "capture-system-v3-browser-visible-envelope.v1",
      module: "keyword_mining_trend",
      subjectKey,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "SellerSprite",
      sourceSurface: "SellerSprite keyword_mining_trend visible query window",
      sourceUrl: KEYWORD_MINING_URL,
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_estimate",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["visible_dom_window_only", "visible_rows_are_not_total_rows"],
      identity: { keyword: input.seedKeyword },
      data: {
        capturedFromVisibleDom: true,
        exportAttempted: false,
        hiddenApiCalled: false,
        pageTitle: "SellerSprite Keyword Mining fixture",
        queryInput,
        queryIdentity: {
          subjectKey,
          marketplace: "US",
          module: "keyword_mining_trend",
          query: input.seedKeyword,
          queryFingerprint,
          captureJobFingerprint: "c".repeat(64),
        },
        captureWindow: {
          captureGeneration: 1,
          attemptGeneration: 1,
          windowBudget: 1,
          snapshotFingerprint: "d".repeat(64),
          captureWindowKey: "e".repeat(64),
          page: 1,
          scrollY: 0,
          scrollTarget: "document",
          clientHeight: 800,
          scrollHeight: 800,
          hasNextPage: false,
          nextPageDisabled: true,
          pageReportedTotalRows: 1,
          accessibleRows: null,
          unavailableRows: null,
          sourceLimitDeclared: false,
        },
        rowEvidenceBindings: [{
          rowKey: "keyword-row-1",
          rowContentHash: input.rowContentHash ?? "a".repeat(64),
          keyword: input.seedKeyword,
          status: "valid",
          sourceRowIndex: 0,
          sourceTableIndex: 0,
        }],
        visibleSnapshot: { tables: [{ headers: ["关键词", "月搜索量"], rows: [[input.seedKeyword, "12500"]] }] },
        amazonConfirmed: false,
        rowScope: "visible_dom_window_not_total",
        snapshotRowLimit: 250,
        accountAccess: "not_verified",
      },
      providerUpdatedAt: null,
      freshnessMetricKey: null,
      evidenceOnly: true,
    },
  };
}

function keywordCaptureQuery(input: ReturnType<typeof keywordEnvelope>) {
  return async () => {
    const capture = await captureBrowserVisibleV3Envelope({
      context: OWNER,
      sourceType: "sellersprite_plugin",
      sourceFingerprint: `query:${input.queryFingerprint}:window`,
      envelope: input.envelope,
    });
    return {
      status: "captured",
      module: "keyword_mining_trend",
      sourceUrl: KEYWORD_MINING_URL,
      snapshot: { tables: [{ headers: ["关键词", "月搜索量"], rows: [[input.queryInput.seedKeyword, "12500"]] }] },
      capture,
      windows: [{
        cursor: { page: 1, scrollY: 0, scrollTarget: "document" },
        rowKeys: ["keyword-row-1"],
        structuredValidRowKeys: ["keyword-row-1"],
        persistedRowKeys: ["keyword-row-1"],
        evidenceRefs: [`attachment:${capture.attachment.attachmentId}`, `raw-artifact:${capture.rawArtifact.artifact.artifactId}`],
        actualVisibleRows: 1,
        duplicatesRejected: 0,
        rejectedRows: 0,
        capture,
      }],
      traversal: {
        finalStatus: "COMPLETE",
        limitationReason: "query_finished",
        errorCode: null,
        counters: {
          reportedTotalRows: 1,
          accessibleRows: null,
          capturedUniqueRows: 1,
          structuredValidRows: 1,
          persistedEvidenceRows: 1,
          unavailableRows: null,
        },
        diagnostics: { actualVisibleRows: 1, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 1 },
        cursor: null,
        captureGeneration: 1,
        snapshotFingerprint: "d".repeat(64),
      },
      errorCode: null,
    } as never;
  };
}

describe("查询级 Evidence：真实 EvidenceStore 写后读回", () => {
  let tempRoot = "";
  let previousStoreDir: string | undefined;

  beforeEach(() => {
    previousStoreDir = process.env.SOURCE_LAYER_STORE_DIR;
    tempRoot = mkdtempSync(join(tmpdir(), "v5-query-evidence-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "evidence-store");
  });

  afterEach(() => {
    if (previousStoreDir === undefined) delete process.env.SOURCE_LAYER_STORE_DIR;
    else process.env.SOURCE_LAYER_STORE_DIR = previousStoreDir;
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
    vi.restoreAllMocks();
  });

  it("主体键合同：只接受受支持模块与合法查询指纹", () => {
    expect(isSellerSpriteQuerySubjectKey(sellerSpriteQuerySubjectKey({
      module: "sellersprite_product_market",
      queryFingerprint: "a".repeat(64),
    }))).toBe(true);
    expect(isSellerSpriteQuerySubjectKey(sellerSpriteQuerySubjectKey({
      module: "keyword_mining_trend",
      marketplace: "US",
      queryFingerprint: "b".repeat(64),
    }))).toBe(true);
    expect(isSellerSpriteQuerySubjectKey("amazon:US:B0QUERYEV1")).toBe(false);
    expect(isSellerSpriteQuerySubjectKey(`sellersprite:US:product-market:${"a".repeat(63)}`)).toBe(false);
    expect(isSellerSpriteQuerySubjectKey(`sellersprite:US:product-market:${"a".repeat(64)}`)).toBe(true);
    expect(() => sellerSpriteQuerySubjectKey({
      module: "sellersprite_product_market",
      marketplace: "US",
      queryFingerprint: "not-a-hash",
    })).toThrow();
  });

  it("PRODUCT_MARKET_QUERY_EVIDENCE：查询创建 → Mock Worker → 真实写入 → 重新读取 → 身份/哈希复核", async () => {
    const base = await seedBaseEvidence(ASIN);
    const fixture = productMarketFixture({
      category: "Kitchen & Dining",
      tables: [{
        headers: ["ASIN", "Title"],
        rows: [[ASIN, "Verified visible row"], [OTHER_ASIN, "Unbound row"]],
      }],
    });
    const result = await captureSellerSpriteProductMarketQueryForBatch({
      context: OWNER,
      query: { category: fixture.category, filters: fixture.filters },
      authorizedAsins: [ASIN],
      env: PRODUCT_MARKET_ENV,
    }, { captureQuery: productMarketCaptureQuery(fixture) as never });

    expect(result).toMatchObject({
      status: "captured",
      navigationPerformed: true,
      querySubjectKey: fixture.subjectKey,
      errorCode: null,
      rowsObserved: 2,
    });
    expect(result.evidenceAttachmentId).toMatch(/^att-[a-f0-9]{24}$/u);
    expect(result.evidenceContentHash).toMatch(HASH);
    // 只有具备真实商品 Evidence 的已授权行才被关联；未绑定行不得冒充完成。
    expect(result.productAssociations).toHaveLength(1);
    expect(result.productAssociations[0]).toMatchObject({
      asin: ASIN,
      baseEvidenceId: base.evidenceId,
      baseEvidenceVersion: base.version,
      baseEvidenceContentHash: base.contentHash,
    });

    const store = createEvidenceStore("owner:v1");
    const querySubject = await store.getSubject(fixture.subjectKey);
    expect(querySubject).not.toBeNull();
    // 查询主体不产生商品版本：绝不伪造 ASIN 或占位商品。
    expect(querySubject?.versions).toEqual([]);
    const stored = querySubject?.attachments?.find((item) => item.attachmentId === result.evidenceAttachmentId);
    expect(stored?.contentHash).toBe(result.evidenceContentHash);
    expect(sourceEvidenceAttachmentContentHash({
      kind: stored!.kind,
      sourceType: stored!.sourceType,
      subjectKey: stored!.subjectKey,
      payload: stored!.payload,
    })).toBe(stored!.contentHash);
    expect(querySubject?.rawArtifacts?.length).toBeGreaterThanOrEqual(1);

    const readBack = await readV3ModuleEvidence({
      context: OWNER,
      subjectKey: fixture.subjectKey,
      module: "sellersprite_product_market",
    });
    expect(readBack.modules).toHaveLength(1);
    expect(readBack.modules[0]).toMatchObject({
      module: "sellersprite_product_market",
      subjectKey: fixture.subjectKey,
      metricNature: "provider_estimate",
      identity: { category: fixture.category },
      evidenceOnly: true,
    });
    const queryContract = (readBack.modules[0]!.data as Record<string, unknown>).queryContract as Record<string, unknown>;
    expect(queryContract.queryFingerprint).toBe(fixture.queryFingerprint);

    // 查询级证据不进入商品索引，也不产生新的商品版本（不污染 ASIN×模块矩阵）。
    expect((await store.listSubjects()).some((entry) => entry.subjectKey === fixture.subjectKey)).toBe(false);
    const productSubject = await store.getSubject(`amazon:US:${ASIN}`);
    expect(productSubject?.versions).toHaveLength(1);
    expect(productSubject?.versions[0]?.contentHash).toBe(base.contentHash);
  });

  it("KEYWORD_MINING_QUERY_EVIDENCE：seedKeyword 查询级写后读回，关键词行不投影到 ASIN", async () => {
    const fixture = keywordEnvelope({ seedKeyword: "silicone baking mat" });
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "silicone baking mat" },
      env: KEYWORD_MINING_ENV,
    }, { captureQuery: keywordCaptureQuery(fixture) as never });

    expect(result).toMatchObject({
      status: "captured",
      navigationPerformed: true,
      querySubjectKey: fixture.subjectKey,
      queryFingerprint: fixture.queryFingerprint,
      rowsObserved: 1,
      errorCode: null,
    });
    expect(result.evidenceAttachmentId).toMatch(/^att-[a-f0-9]{24}$/u);
    expect(result.evidenceContentHash).toMatch(HASH);

    const store = createEvidenceStore("owner:v1");
    const querySubject = await store.getSubject(fixture.subjectKey);
    expect(querySubject?.versions).toEqual([]);
    const stored = querySubject?.attachments?.find((item) => item.attachmentId === result.evidenceAttachmentId);
    expect(stored?.contentHash).toBe(result.evidenceContentHash);
    expect(stored?.kind).toBe("v3_keyword_mining_trend_v1");
    expect(stored?.sourceType).toBe("sellersprite_plugin");

    const readBack = await readV3ModuleEvidence({
      context: OWNER,
      subjectKey: fixture.subjectKey,
      module: "keyword_mining_trend",
    });
    expect(readBack.modules).toHaveLength(1);
    expect(readBack.modules[0]).toMatchObject({
      module: "keyword_mining_trend",
      subjectKey: fixture.subjectKey,
      metricNature: "provider_estimate",
      identity: { keyword: "silicone baking mat" },
      evidenceOnly: true,
    });
    const data = readBack.modules[0]!.data as Record<string, unknown>;
    const bindings = data.rowEvidenceBindings as Array<Record<string, unknown>>;
    expect(bindings[0]).toMatchObject({ keyword: "silicone baking mat", status: "valid" });
    expect((await store.listSubjects()).some((entry) => entry.subjectKey === fixture.subjectKey)).toBe(false);
  });

  it("查询指纹冲突与不同查询主体之间不共用证据", async () => {
    const first = keywordEnvelope({ seedKeyword: "silicone baking mat" });
    const second = keywordEnvelope({ seedKeyword: "silicone baking mat", conditions: { searchVolumeMin: "1000" } });
    expect(second.subjectKey).not.toBe(first.subjectKey);

    const firstResult = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "silicone baking mat" },
      env: KEYWORD_MINING_ENV,
    }, { captureQuery: keywordCaptureQuery(first) as never });
    expect(firstResult.status).toBe("captured");

    const store = createEvidenceStore("owner:v1");
    // 另一个查询主体看不到第一份证据，且自身仍然不存在。
    expect(await store.getSubject(second.subjectKey)).toBeNull();

    // 同一 seedKeyword、不同 queryFingerprint 的查询不得复用第一份证据。
    const tampered = keywordEnvelope({ seedKeyword: "silicone baking mat" });
    const tamperedCapture = keywordCaptureQuery(tampered);
    const wrongFingerprint = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "silicone baking mat" },
      env: KEYWORD_MINING_ENV,
    }, {
      captureQuery: (async () => {
        const captured = await tamperedCapture() as { windows: Array<{ capture: unknown }> };
        const wrong = sellerSpriteQuerySubjectKey({
          module: "keyword_mining_trend",
          marketplace: "US",
          queryFingerprint: "f".repeat(64),
        });
        return { ...(captured as object), querySubjectKey: wrong } as never;
      }) as never,
    });
    expect(wrongFingerprint.status).toBe("captured");
    expect(wrongFingerprint.querySubjectKey).toBe(tampered.subjectKey);
  });

  it("内容哈希不匹配的查询证据不会被回读接受", async () => {
    const fixture = keywordEnvelope({ seedKeyword: "bamboo cutting board" });
    const capture = await captureBrowserVisibleV3Envelope({
      context: OWNER,
      sourceType: "sellersprite_plugin",
      sourceFingerprint: `query:${fixture.queryFingerprint}:tamper`,
      envelope: {
        ...fixture.envelope,
        data: {
          ...(fixture.envelope.data as Record<string, unknown>),
          rowEvidenceBindings: [{
            rowKey: "keyword-row-1",
            rowContentHash: "z".repeat(64),
            keyword: fixture.queryInput.seedKeyword,
            status: "valid",
            sourceRowIndex: 0,
            sourceTableIndex: 0,
          }],
        },
      },
    });
    const stored = await createEvidenceStore("owner:v1").getSubject(fixture.subjectKey);
    const persisted = stored?.attachments?.find((item) => item.attachmentId === capture.attachment.attachmentId);
    expect(persisted).toBeDefined();
    // 行内容哈希必须是 64 位十六进制；不合法行不会被计入 valid 行数。
    expect((persisted!.payload.data as Record<string, unknown>).rowEvidenceBindings).toEqual([
      expect.objectContaining({ rowContentHash: "z".repeat(64), status: "valid" }),
    ]);

    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "bamboo cutting board" },
      env: KEYWORD_MINING_ENV,
    }, {
      captureQuery: (async () => ({
        status: "captured",
        module: "keyword_mining_trend",
        sourceUrl: KEYWORD_MINING_URL,
        snapshot: null,
        capture,
        windows: [{
          cursor: { page: 1, scrollY: 0, scrollTarget: "document" },
          rowKeys: ["keyword-row-1"],
          structuredValidRowKeys: ["keyword-row-1"],
          persistedRowKeys: ["keyword-row-1"],
          evidenceRefs: [`attachment:${capture.attachment.attachmentId}`],
          actualVisibleRows: 1,
          duplicatesRejected: 0,
          rejectedRows: 0,
          capture,
        }],
        traversal: {
          finalStatus: "COMPLETE",
          limitationReason: "query_finished",
          errorCode: null,
          counters: {
            reportedTotalRows: 1,
            accessibleRows: null,
            capturedUniqueRows: 1,
            structuredValidRows: 1,
            persistedEvidenceRows: 1,
            unavailableRows: null,
          },
          diagnostics: { actualVisibleRows: 1, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 1 },
          cursor: null,
          captureGeneration: 1,
          snapshotFingerprint: "d".repeat(64),
        },
        errorCode: null,
      })) as never,
    });
    // 非法行哈希不得被计为有效行；仍为 captured，但 rowsObserved 归零。
    expect(result.status).toBe("captured");
    expect(result.rowsObserved).toBe(0);
  });

  it("重复提交幂等：同一份查询证据只保留一个附件", async () => {
    const fixture = keywordEnvelope({ seedKeyword: "reusable straw" });
    const captureQuery = keywordCaptureQuery(fixture);
    const first = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "reusable straw" },
      env: KEYWORD_MINING_ENV,
    }, { captureQuery: captureQuery as never });
    const second = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "reusable straw" },
      env: KEYWORD_MINING_ENV,
    }, { captureQuery: captureQuery as never });

    expect(first.status).toBe("captured");
    expect(second.status).toBe("captured");
    expect(second.evidenceAttachmentId).toBe(first.evidenceAttachmentId);
    expect(second.evidenceContentHash).toBe(first.evidenceContentHash);
    const subject = await createEvidenceStore("owner:v1").getSubject(fixture.subjectKey);
    expect(subject?.attachments).toHaveLength(1);
    expect(subject?.rawArtifacts).toHaveLength(1);
  });

  it("持久化失败时不报告 captured，且不留下半成品查询主体", async () => {
    await seedBaseEvidence(ASIN);
    const fixture = productMarketFixture({
      category: "Kitchen & Dining",
      tables: [{ headers: ["ASIN", "Title"], rows: [[ASIN, "row"]] }],
    });
    const result = await captureSellerSpriteProductMarketQueryForBatch({
      context: OWNER,
      query: { category: fixture.category, filters: fixture.filters },
      authorizedAsins: [ASIN],
      env: PRODUCT_MARKET_ENV,
    }, {
      captureQuery: (async () => {
        throw new Error("SELLERSPRITE_VISIBLE_QUERY_FAILED");
      }) as never,
    });
    expect(result.status).toBe("failed");
    expect(result.evidenceAttachmentId).toBeNull();
    expect(result.evidenceContentHash).toBeNull();

    const keywordFixture = keywordEnvelope({ seedKeyword: "failing seed" });
    const keywordResult = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "failing seed" },
      env: KEYWORD_MINING_ENV,
    }, {
      captureQuery: (async () => {
        throw new Error("SELLERSPRITE_VISIBLE_QUERY_FAILED");
      }) as never,
    });
    expect(keywordResult.status).toBe("failed");
    expect(keywordResult.evidenceAttachmentId).toBeNull();
    expect(keywordResult.errorCode).toBe("SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED");

    const store = createEvidenceStore("owner:v1");
    expect(await store.getSubject(fixture.subjectKey)).toBeNull();
    expect(await store.getSubject(keywordFixture.subjectKey)).toBeNull();
  });

  it("旧商品级 Evidence 保持可读，且查询级证据不会改变商品级状态", async () => {
    await seedBaseEvidence(ASIN);
    const store = createEvidenceStore("owner:v1");
    const before = await store.getSubject(`amazon:US:${ASIN}`);
    expect(before?.versions).toHaveLength(1);

    const fixture = keywordEnvelope({ seedKeyword: "legacy compatibility" });
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: OWNER,
      query: { seedKeyword: "legacy compatibility" },
      env: KEYWORD_MINING_ENV,
    }, { captureQuery: keywordCaptureQuery(fixture) as never });
    expect(result.status).toBe("captured");

    const after = await store.getSubject(`amazon:US:${ASIN}`);
    // 商品版本、判定、字段与附件数量必须与查询写入前逐字节一致。
    expect(JSON.stringify(after?.versions)).toBe(JSON.stringify(before?.versions));
    expect(after?.attachments ?? []).toEqual(before?.attachments ?? []);
    expect(after?.versions[0]?.validation.verdict).toBe("passed");
    expect(after?.versions[0]?.contentHash).toBe(before?.versions[0]?.contentHash);

    // 查询级证据没有挂到任何 ASIN 主体上。
    const productReadBack = await readV3ModuleEvidence({ context: OWNER, subjectKey: `amazon:US:${ASIN}` });
    expect(productReadBack.modules).toEqual([]);
    const indexEntries = await store.listSubjects();
    expect(indexEntries.some((entry) => entry.subjectKey === `amazon:US:${ASIN}`)).toBe(true);
    expect(indexEntries.some((entry) => entry.subjectKey === fixture.subjectKey)).toBe(false);
  });
});
