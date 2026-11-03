import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";

const mocks = vi.hoisted(() => {
  let records: Array<Record<string, unknown>> = [];
  return {
    reset: () => { records = []; },
    records: () => records,
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        opportunityCandidate: {
          findMany: vi.fn(async () => records.map((record) => ({ ...record }))),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const record = {
              id: `candidate-${records.length + 1}`,
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            records.push(record);
            return { ...record };
          }),
        },
      };
      return fn(tx);
    }),
  };
});

vi.mock("@/lib/server/db", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import {
  SourceLayerServiceError,
  getSourceEvidenceDetail,
  handoffCapturesToResearch,
  ingestSourceCapture,
  listSourceEvidence,
  retrySourceCapture,
  sourceLayerOperator,
} from "@/lib/sourceLayer/server/sourceLayerService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { buildCandidateAnalysisContext } from "@/lib/server/candidateAnalysisContext";
import { parseSellerSpriteCandidateSourceMeta } from "@/lib/server/sellerSpriteImportContract";
import { createSellerSpritePreviewWorkbook } from "@/lib/upstream/sellersprite/previewTestFixtures";

const ownerContext: AccessContext = { mode: "owner", token: "" };
const visitorContext: AccessContext = {
  mode: "demo",
  token: "",
  demoAccessId: "visitor-source-layer",
  isActive: true,
  isExpired: false,
  remainingAiCalls: 50,
};

const validPayload = {
  asin: "B0FH1ZXTN1",
  title: "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
  productUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
  images: ["https://m.media-amazon.com/images/I/main.jpg", "https://m.media-amazon.com/images/I/alt.jpg"],
  brand: "Owala",
  price: 29.99,
  currency: "USD",
  rating: 4.6,
  reviewCount: 2948,
  bsrRank: 120,
  bsrCategory: "Sports & Outdoors",
  subCategoryBsr: 15,
  estimatedMonthlySales: 3500,
  estimatedMonthlyRevenueUsd: 104965,
  keywords: ["water bottle"],
};

const brokenPayload = {
  asin: "BAD-ASIN",
  title: "Ok",
  productUrl: "http://localhost/blocked",
  images: [],
  rating: 9.9,
  reviewCount: -5,
  bsrRank: 0,
};

let tempRoot = "";

beforeEach(() => {
  mocks.reset();
  vi.clearAllMocks();
  tempRoot = mkdtempSync(join(tmpdir(), "source-layer-service-"));
  process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  process.env.DEMO_SANDBOX_STORE_PATH = join(tempRoot, "demo-sandbox.json");
  process.env.DEMO_ACCESS_STORE_PATH = join(tempRoot, "demo-access.json");
});

afterEach(() => {
  delete process.env.SOURCE_LAYER_STORE_DIR;
  delete process.env.DEMO_SANDBOX_STORE_PATH;
  delete process.env.DEMO_ACCESS_STORE_PATH;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe("ingestSourceCapture", () => {
  it("records quarantined XLSX observations in the same EvidenceStore audit without publishing them as facts", async () => {
    const payload = createSellerSpritePreviewWorkbook({ headers: ["ASIN", "商品标题", "商品详情页链接", "商品主图", "价格($)", "评分", "评分数", "品牌", "类目路径", "月销量"],
      rows: [["B07G4VTV2F", "Valid observed title", "https://www.amazon.com/dp/B07G4VTV2F", "https://images.example.test/fixture.jpg", "$24.99", "4.6", "1044", "Example", "Home & Kitchen", "321"],
        ["BAD-ASIN", "Invalid identity", "", "", "$24.99", "4.6", "100", "Example", "Home & Kitchen", "321"]] });
    const result = await ingestSourceCapture({ context: ownerContext, sourceType: "sellersprite_xlsx", payload, traceId: "p3-quarantine" });
    expect(result.quarantinedCount).toBe(1);
    expect(result.items).toHaveLength(1);
    const audit = await createEvidenceStore("owner:v1").getAudit("quarantine:p3-quarantine");
    expect(audit.find((entry) => entry.eventType === "observations_quarantined")).toMatchObject({ severity: "warning", statusAfter: "blocked" });
  });
  it("runs the whole chain and reaches READY_FOR_RESEARCH for clean data", async () => {
    const result = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: validPayload,
    });
    expect(result.items[0]?.issues).toEqual([]);
    expect(result.readyCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    const [item] = result.items;
    expect(item.state).toBe("READY_FOR_RESEARCH");
    expect(item.readyForResearch).toBe(true);
    expect(item.verdict).toBe("passed");
    expect(item.version).toBe(1);
    expect(item.created).toBe(true);
    expect(item.asin).toBe("B0FH1ZXTN1");
    // 状态机走完全部主链
    const transitions = item.auditTail.map((entry) => entry.nextState).filter(Boolean);
    expect(transitions).toContain("SOURCE_CHECKING");
    expect(transitions).toContain("CAPTURE_RUNNING");
    expect(transitions).toContain("NORMALIZING");
    expect(transitions).toContain("EVIDENCE_VALIDATING");
    expect(transitions).toContain("READY_FOR_RESEARCH");
    // 每个跃迁都带 from/to/reason/timestamp
    for (const entry of item.auditTail) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    }
  });

  it("blocks bad data and never marks it ready for research", async () => {
    const result = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: brokenPayload,
    });
    expect(result.blockedCount).toBe(1);
    expect(result.readyCount).toBe(0);
    const [item] = result.items;
    expect(item.readyForResearch).toBe(false);
    expect(["HUMAN_REQUIRED", "RETRYABLE", "BLOCKED"]).toContain(item.state);
    const codes = item.issues.map((issue) => issue.code);
    expect(codes).toContain("INVALID_FORMAT");
    expect(codes).toContain("FIELD_MISSING");
    // 值没有被自动补全
    expect(item.title).toBe("Ok");
    expect(item.price).toBeNull();
    expect(item.rating).toBeNull();
    expect(item.reviewCount).toBeNull();
    expect(item.bsr).toBeNull();
  });

  it("still persists blocked evidence so the failure is auditable later", async () => {
    await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: brokenPayload,
    });
    const ledger = await listSourceEvidence(ownerContext);
    expect(ledger.subjects).toHaveLength(1);
    expect(ledger.subjects[0].latestVerdict).toBe("blocked");
    expect(ledger.subjects[0].latestVersion).toBe(1);
  });

  it("assigns strictly increasing versions on re-capture", async () => {
    const first = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: validPayload,
    });
    expect(first.items[0].version).toBe(1);
    const second = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { ...validPayload, price: 27.5 },
    });
    expect(second.items[0].version).toBe(2);
    const ledger = await listSourceEvidence(ownerContext);
    expect(ledger.subjects[0].versions).toEqual([1, 2]);
  });

  it("treats an exact retry of the same capture as a duplicate at the store level", async () => {
    const first = await ingestSourceCapture({ context: ownerContext, sourceType: "manual_entry", payload: validPayload });
    // 事件时间不是内容版本：同一份采集内容再次提交只增加采集事件，
    // 不应因为 capturedAt 不同而无限制造语义版本。
    const second = await ingestSourceCapture({ context: ownerContext, sourceType: "manual_entry", payload: validPayload });
    expect(second.items[0].version).toBe(1);
    expect(second.items[0].duplicate).toBe(true);
    const firstHash = first.items[0].contentHash;
    const secondHash = second.items[0].contentHash;
    expect(secondHash).toBe(firstHash);

    const store = createEvidenceStore("owner:v1");
    const after = await store.getSubject(first.items[0].subjectKey);
    expect(after?.versions).toHaveLength(1);
    const audit = await store.getAudit(first.items[0].subjectKey);
    expect(audit.filter((entry) => entry.eventKind === "capture_event")).toHaveLength(2);
  });

  it("persists a zero-field HUMAN_REQUIRED record for a blocked page", async () => {
    const result = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "amazon_dom",
      payload: validPayload,
      sourceUrl: validPayload.productUrl,
      subjectKey: "amazon:US:B0FH1ZXTN1",
      marketplace: "US",
      pageContext: {
        pageClass: "login_wall",
        allowFields: false,
        errorCode: "LOGIN_REQUIRED",
        reason: "页面要求人工登录",
        subjectKey: "amazon:US:B0FH1ZXTN1",
        marketplace: "US",
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].state).toBe("HUMAN_REQUIRED");
    expect(result.items[0].readyForResearch).toBe(false);
    expect(result.items[0].title).toBeNull();
    expect(result.items[0].asin).toBeNull();
    expect(result.items[0].imageCount).toBe(0);
    expect(result.captureErrorCodes).toContain("LOGIN_REQUIRED");

    const detail = await getSourceEvidenceDetail(
      ownerContext,
      "amazon:US:B0FH1ZXTN1",
    );
    expect(detail.subject?.versions[0].validation.captureState).toBe("HUMAN_REQUIRED");
    expect(detail.subject?.versions[0].validation.captureErrorCodes).toContain("LOGIN_REQUIRED");
    expect(detail.subject?.versions[0].pkg.fields.title).toBeNull();
    expect(detail.audit.some((entry) => entry.errorCode === "LOGIN_REQUIRED")).toBe(true);
  });

  it("requires an explicit retry and allows a human-resolved capture to recover", async () => {
    const blocked = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "amazon_dom",
      payload: validPayload,
      sourceUrl: validPayload.productUrl,
      pageContext: {
        pageClass: "login_wall",
        allowFields: false,
        errorCode: "LOGIN_REQUIRED",
        subjectKey: "amazon:US:B0FH1ZXTN1",
        marketplace: "US",
      },
    });
    const subjectKey = blocked.items[0].subjectKey;
    await expect(retrySourceCapture({
      context: ownerContext,
      subjectKey,
      sourceType: "manual_entry",
      payload: validPayload,
    })).rejects.toMatchObject({ code: "source_retry_not_allowed" });

    const recovered = await retrySourceCapture({
      context: ownerContext,
      subjectKey,
      sourceType: "amazon_dom",
      payload: validPayload,
      sourceUrl: validPayload.productUrl,
    });
    expect(recovered.items[0].state).toBe("READY_FOR_RESEARCH");
    expect(recovered.items[0].readyForResearch).toBe(true);
    expect(recovered.items[0].version).toBe(2);
  });

  it("keeps visitor evidence isolated from owner evidence", async () => {
    await ingestSourceCapture({ context: ownerContext, sourceType: "manual_entry", payload: validPayload });
    const visitorLedger = await listSourceEvidence(visitorContext);
    expect(visitorLedger.subjects).toEqual([]);
    expect(sourceLayerOperator(visitorContext)).toBe("visitor:visitor-source-layer");
    expect(sourceLayerOperator(ownerContext)).toBe("owner:v1");
  });

  it("rejects unknown source types and empty payloads explicitly", async () => {
    await expect(ingestSourceCapture({
      context: ownerContext,
      sourceType: "browser_agent",
      payload: validPayload,
    })).rejects.toBeInstanceOf(SourceLayerServiceError);
    await expect(ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: null,
    })).rejects.toBeInstanceOf(SourceLayerServiceError);
  });

  it("fails closed when the payload has no usable identity", async () => {
    await expect(ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { price: 12 },
    })).rejects.toMatchObject({ code: "no_capturable_records" });
  });

  it("never persists an anonymous subject when the identity is unusable", async () => {
    await expect(ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { asin: "BAD-ASIN", title: "", rating: 9.9 },
    })).rejects.toMatchObject({ code: "no_capturable_records" });
    const ledger = await listSourceEvidence(ownerContext);
    expect(ledger.subjects).toEqual([]);
  });

  it("falls back to a title subject key only when the ASIN is unusable", async () => {
    const result = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { asin: "BAD-ASIN", title: "Manual entry without a usable ASIN value" },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].subjectKey.startsWith("manual:")).toBe(true);
    expect(result.items[0].readyForResearch).toBe(false);
    expect(result.items[0].issues.map((issue) => issue.code)).toContain("FIELD_MISSING");
  });
});

describe("handoffCapturesToResearch", () => {
  it("creates a research candidate through the existing SellerSprite contract", async () => {
    const ingest = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: validPayload,
    });
    const subjectKey = ingest.items[0].subjectKey;
    const result = await handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: [subjectKey],
    });
    expect(result.summary.created).toHaveLength(1);
    expect(result.summary.conflicts).toEqual([]);
    expect(result.evidenceOnlyNote).toContain("人工确认");
    expect(result.evidenceOnlyNote.length).toBeGreaterThan(0);

    const created = mocks.records()[0];
    expect(created.name).toBe(validPayload.title);
    expect(created.link).toBe("https://www.amazon.com/dp/B0FH1ZXTN1");
    expect(created.status).toBe("pending");

    // 既有研究链路可识别的来源契约
    const meta = parseSellerSpriteCandidateSourceMeta(String(created.sourceMetaJson));
    expect(meta).not.toBeNull();
    expect(meta?.schema).toBe("sellersprite_candidate_source_v1");
    expect(meta?.identity.asin).toBe("B0FH1ZXTN1");
    expect(meta?.snapshot.title).toBe(validPayload.title);
    expect(meta?.snapshot.brand).toBe("Owala");
    expect(meta?.snapshot.priceUsd).toBe(29.99);
    expect(meta?.source.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);
    // 来源层证据引用：只能作为证据，不能作为事实
    expect(meta?.sourceLayerCapture?.factAuthority).toBe("evidence_only");
    expect(meta?.sourceLayerCapture?.captureId).toBe(ingest.items[0].captureId);
    expect(meta?.sourceLayerCapture?.version).toBe(1);
    expect(meta?.estimates.rootCategoryBsr).toBe(120);
    expect(meta?.estimates.searchRank).toBe(120);
    expect(meta?.estimates.subCategoryBsr).toBe(15);
    expect(meta?.estimates.estimatedMonthlySales).toBe(3500);
    expect(meta?.estimates.estimatedMonthlyRevenueUsd).toBe(104965);
    expect(meta?.sourceLayerCapture?.keywords).toEqual(["water bottle"]);
    expect(meta?.productFact?.schema).toBe("product-fact.v3");
    expect(meta?.productFact?.sourceProof.source).toBe("manual");
    expect(meta?.productFact?.sourceProof.evidenceId).toMatch(/^ev-/);
    expect(meta?.productFact?.sourceProof.subjectKey).toBe(subjectKey);
    expect(meta?.productFact?.basic.price.value).toEqual({ amount: 29.99, currency: "USD" });
    expect(meta?.productFact?.market.monthlySalesEstimate.value).toBe(3500);
    expect(meta?.productFact?.market.monthlySalesEstimate.metricNature).toBe("estimate");
    expect(created.keyword).toBe("water bottle");
  });

  it("does not manufacture an Amazon URL when no URL was observed", async () => {
    const ingest = await ingestSourceCapture({ context: ownerContext, sourceType: "manual_entry", payload: { ...validPayload, productUrl: null } });
    await expect(handoffCapturesToResearch({ context: ownerContext, subjectKeys: [ingest.items[0].subjectKey] }))
      .rejects.toMatchObject({ code: "candidate_not_ready" });
    expect(mocks.records()).toHaveLength(0);
  });

  it("handoff 显式写入 rootCategoryBsr，并且候选分析上下文优先读新字段", async () => {
    const ingest = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: validPayload,
    });
    await handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: [ingest.items[0].subjectKey],
    });
    const created = mocks.records()[0];
    const context = buildCandidateAnalysisContext({
      sourceMetaJson: String(created.sourceMetaJson),
      analysisJson: "{}",
    });
    expect(context.integrity).toBe("verified_seller_sprite");
    if (context.integrity !== "verified_seller_sprite") return;
    expect(context.facts.rootCategoryBsr).toBe(120);
    expect(context.facts.searchRank).toBe(120);

    // 旧数据（没有 rootCategoryBsr）仍可通过 searchRank 读到同一个大类 BSR
    const legacyMeta = JSON.parse(String(created.sourceMetaJson)) as {
      estimates: Record<string, unknown>;
    };
    delete legacyMeta.estimates.rootCategoryBsr;
    const legacyContext = buildCandidateAnalysisContext({
      sourceMetaJson: JSON.stringify(legacyMeta),
      analysisJson: "{}",
    });
    expect(legacyContext.integrity).toBe("verified_seller_sprite");
    if (legacyContext.integrity !== "verified_seller_sprite") return;
    expect(legacyContext.facts.rootCategoryBsr).toBe(120);
  });

  it("handoff 允许已校验的内嵌图片进入候选主图，其它协议仍然被丢弃", async () => {
    const inlineImage =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const ingest = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { ...validPayload, images: [inlineImage] },
    });
    expect(ingest.items[0].readyForResearch).toBe(true);
    await handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: [ingest.items[0].subjectKey],
    });
    const meta = parseSellerSpriteCandidateSourceMeta(String(mocks.records()[0].sourceMetaJson));
    expect(meta?.snapshot.imageUrl).toBe(inlineImage);

    // 不可信协议 / 其它 MIME 仍然进不来：先被 Validator 拦下，不会成为 READY_FOR_RESEARCH
    mocks.reset();
    const blocked = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { ...validPayload, images: ["http://insecure.example.com/a.jpg"] },
    });
    expect(blocked.items[0].readyForResearch).toBe(false);
    expect(mocks.records()).toHaveLength(0);
  });

  it("handoff 丢弃被截断/损坏的内嵌图片，不让坏图进候选主图", async () => {
    // 真实损坏形态：完整 JPEG 的 data URL 被上游长度上限截断到 1000 字符，
    // 前缀仍然合法（能过 Validator 的格式检查），但字节不完整、浏览器无法解码。
    const jpegBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(2_000, 0x41),
      Buffer.from([0xff, 0xd9]),
    ]);
    const truncated = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`.slice(0, 1_000);
    const ingest = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: { ...validPayload, images: [truncated] },
    });
    expect(ingest.items[0].readyForResearch).toBe(true);
    await handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: [ingest.items[0].subjectKey],
    });
    const meta = parseSellerSpriteCandidateSourceMeta(String(mocks.records()[0].sourceMetaJson));
    expect(meta?.snapshot.imageUrl).toBeNull();
  });

  it("refuses to hand off anything that did not pass validation", async () => {
    const ingest = await ingestSourceCapture({
      context: ownerContext,
      sourceType: "manual_entry",
      payload: brokenPayload,
    });
    await expect(handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: [ingest.items[0].subjectKey],
    })).rejects.toMatchObject({ code: "candidate_not_ready" });
    expect(mocks.records()).toHaveLength(0);
  });

  it("refuses an empty selection and unknown subjects", async () => {
    await expect(handoffCapturesToResearch({ context: ownerContext, subjectKeys: [] }))
      .rejects.toMatchObject({ code: "candidate_selection_empty" });
    await expect(handoffCapturesToResearch({
      context: ownerContext,
      subjectKeys: ["amazon:US:B0NOTFOUND1"],
    })).rejects.toMatchObject({ code: "candidate_not_ready" });
  });

  it("routes visitor handoff into the visitor sandbox, not owner production data", async () => {
    const ingest = await ingestSourceCapture({
      context: visitorContext,
      sourceType: "manual_entry",
      payload: validPayload,
    });
    const result = await handoffCapturesToResearch({
      context: visitorContext,
      subjectKeys: [ingest.items[0].subjectKey],
    });
    expect(result.summary.created).toHaveLength(1);
    expect(mocks.records()).toHaveLength(0);
  });
});
