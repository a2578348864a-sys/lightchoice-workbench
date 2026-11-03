import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
import { buildMarketAiInput, buildMarketIntelligence, marketProviderReadiness, marketKeywordProjectionHash, compactMarketAiEvidence } from "./marketIntelligenceService";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import type { EvidenceStore, EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { fixtureFactValues } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { factValuesFingerprintOf } from "@/lib/marketScan/metrics";
import { validateMarketReport, type MarketIntelligence } from "@/lib/marketScan/intelligence";
import { projectSellerSpriteSupplement } from "@/lib/sourceLayer/sellerSpriteSupplementProjection";
import { projectProductFactEvidence } from "@/lib/server/research/productFactEvidenceProjection";
import { makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";

const KEY = "amazon:US:B0ITEM0001", TIME = "2026-10-22T08:00:00.000Z";
function attachment(module: "reverse_asin" | "keyword_mining_trend" | "sellersprite_product_market" | "historical_trend", options: { subjectKey?: string; data?: Record<string, unknown>; status?: string; time?: string } = {}) {
  const subjectKey = options.subjectKey ?? KEY;
  const capturedAt = options.time ?? TIME;
  return buildSourceEvidenceAttachment({ attachmentId: `${module}-${capturedAt}`, subjectKey, kind: `v3_${module}_v1`, sourceType: "sellersprite_plugin", capturedAt, sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse", payload: {
    schemaVersion: "capture-system-v3-module-evidence.v1", module, subjectKey, marketplace: "US", capturedAt,
    provider: "SellerSprite", sourceSurface: "synthetic_test_fixture", sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse",
    providerUpdatedAt: null, freshness: { cadenceKey: null }, acquisitionMode: "DOM_DIRECT", metricNature: "provider_estimate",
    status: options.status ?? "VALIDATED_AVAILABLE", limitations: options.status === "BLOCKED_WITH_EVIDENCE" ? ["fixture login wall"] : [], identity: { asin: "B0ITEM0001" }, data: options.data ?? { rows: [{ keyword: "silicone mat", monthlySearches: 1200 }] }, evidenceOnly: true,
  } });
}
function setup(attachments: ReturnType<typeof attachment>[] = []) {
  const factValues = fixtureFactValues();
  const sample = { asin: "B0ITEM0001", subjectKey: KEY, factValues, sourceProofHash: "a".repeat(64), evidenceId: "evidence-1", evidenceVersion: 1, capturedAt: TIME, sourceType: "amazon_dom", factValuesFingerprint: factValuesFingerprintOf({ subjectKey: KEY, factValues }) };
  const version = { version: 1, contentHash: sample.sourceProofHash, evidenceId: sample.evidenceId, capturedAt: TIME, pkg: { sourceProof: { sourceUrl: "https://www.amazon.com/dp/B0ITEM0001" } } } as CaptureEvidenceRecord;
  const source = { versions: [version], attachments } as EvidenceSubjectRecord;
  const store = { getSubject: vi.fn(async (key: string) => key === KEY ? source : null), listQuerySubjects: vi.fn(async () => []) } as unknown as EvidenceStore;
  return { source, store, input: { scanId: "scan-1", scanName: "fixture market", marketplace: "US", resourceVersion: TIME, sampleHash: "scan-hash", sampleSnapshot: { items: [sample] }, nicheDefinition: {}, store } };
}

describe("market intelligence evidence consumption", () => {
  it("invalidates parsed keyword input when purchases change under the same immutable evidence ID", () => {
    const evidence={id:"same-evidence",contentHash:"a".repeat(64)} as MarketIntelligence["keywords"][number]["evidence"];
    const before:MarketIntelligence["keywords"]=[{keyword:"mat",subjectKey:KEY,module:"reverse_asin",searchVolume:77947,observedAt:null,metrics:{estimatedMonthlyPurchase:{value:null,unit:"count",metricNature:"provider_estimate"}},evidence}];
    const after=before.map(k=>({...k,metrics:{...k.metrics,estimatedMonthlyPurchase:{value:4638,unit:"count",metricNature:"provider_estimate" as const}}}));
    expect(marketKeywordProjectionHash(after,new Set([KEY]))).not.toBe(marketKeywordProjectionHash(before,new Set([KEY])));
    expect(marketKeywordProjectionHash(after,new Set())).toBeNull();
    expect(before[0].evidence).toBe(after[0].evidence);
  });
  it("consumes real SellerSprite product history with true dates and rejects missing capture time", async () => {
    const series = [
      { date: "2024-10", monthlySales: 267678, monthlyRevenue: 1520411 },
      { date: "2024-11", monthlySales: 226970, monthlyRevenue: 4709628, avgPrice: 20.75 },
      { date: "2024-12", monthlySales: 15883, monthlyRevenue: 269852, avgPrice: 16.99 },
    ];
    const env = setup([attachment("historical_trend", { status: "VALIDATED_AVAILABLE", data: { browserObservedAt: TIME, series } })]);
    const result = await buildMarketIntelligence(env.input);
    const field = (name: string) => result.trends.find((trend) => trend.field === `sellersprite.traffic.${name}`);
    expect(field("monthlySales")?.points).toEqual([
      { date: "2024-10-01", value: 267678 },
      { date: "2024-11-01", value: 226970 },
      { date: "2024-12-01", value: 15883 },
    ]);
    expect(field("avgPrice")?.points).toEqual([{ date: "2024-11-01", value: 20.75 }, { date: "2024-12-01", value: 16.99 }]);
    // 缺少 browserObservedAt 的 DOM_DIRECT 附件无法追溯采集时刻 → 不得作为数值趋势消费。
    const missingTime = setup([attachment("historical_trend", { status: "VALIDATED_AVAILABLE", data: { series } })]);
    expect((await buildMarketIntelligence(missingTime.input)).trends).toHaveLength(0);
  });
  it("retains legitimate Keepa export window statistics with their provider identity and no invented daily series", async () => {    const base = attachment("historical_trend");
    const a = buildSourceEvidenceAttachment({ ...base, sourceType: "keepa_export", payload: { ...base.payload as Record<string, unknown>, provider: "keepa_product_viewer", acquisitionMode: "FILE_EXPORT", metricNature: "provider_observed", data: { timeSeries: { price90dMin: 12.5, price90dAvg: 18 } } } });
    const result = await buildMarketIntelligence(setup([a]).input);
    expect(result.trends).toHaveLength(2);
    expect(result.trends[0]).toMatchObject({ field: "keepa.window.price90dMin", points: [{ date: TIME.slice(0, 10), value: 12.5 }], evidence: { nature: "provider_observed", contentHash: a.contentHash } });
    expect(result.limitations.join(" ")).toContain("导入时间不是历史发生日期");
  });
  it("does not count excluded product identities attached to a shared review in AI theme denominators",async()=>{
    const {input}=setup();const view=await buildMarketIntelligence(input);
    view.reviews=[{id:"shared",subjectKey:KEY,subjectKeys:[KEY,"amazon:US:B0FOREIGN1"],title:null,text:"fixture",rating:2,evidence:view.samples[0].evidence}];
    const ai=buildMarketAiInput({...view,category:null,provider:{ready:false,code:"test",message:"fixture"},reports:[]},[]);
    expect(ai.reviews[0].subjectKeys).toEqual([KEY]);
  });

  it("consumes ASIN keyword rows with exact immutable citations; unknown stays null", async () => {
    const env = setup([attachment("reverse_asin"), attachment("keyword_mining_trend", { data: { rows: [{ keyword: "baking mat" }] } })]);
    const result = await buildMarketIntelligence(env.input);
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords.find((k) => k.module === "reverse_asin")).toMatchObject({ subjectKey: KEY, searchVolume: 1200, evidence: { contentHash: env.source.attachments![0].contentHash, version: null, nature: "provider_estimate" } });
    expect(result.keywords.find((k) => k.module === "keyword_mining_trend")!.searchVolume).toBeNull();
    expect(result.samples[0].price).toBe(19.99);
  });
  it("a latest blocked capture invalidates older success and changes report binding", async () => {
    const env = setup([attachment("reverse_asin")]);
    const first = await buildMarketIntelligence(env.input);
    env.source.attachments!.push(attachment("reverse_asin", { time: "2026-10-22T09:00:00.000Z", status: "BLOCKED_WITH_EVIDENCE", data: {} }));
    const next = await buildMarketIntelligence(env.input);
    expect(next.keywords).toHaveLength(0);
    expect(next.sources[0].status).toBe("blocked");
    expect(next.inputHash).not.toBe(first.inputHash);
  });
  it("never auto-binds a seed query or duplicates its rows into products", async () => {
    const env = setup();
    const key = `sellersprite:US:keyword-mining:${"b".repeat(64)}`;
    const query = attachment("keyword_mining_trend", { subjectKey: key, data: { queryContract: { queryFingerprint: "b".repeat(64) }, rows: [{ keyword: "baking mat", monthlySearches: 1000 }] } });
    env.store.listQuerySubjects = vi.fn(async () => [key]);
    env.store.getSubject = vi.fn(async (k) => k === key ? { ...env.source, versions: [], attachments: [query] } : env.source);
    const before = await buildMarketIntelligence(env.input);
    expect(before.keywords).toHaveLength(0);
    const after = await buildMarketIntelligence({ ...env.input, supplementaryState: { queryBindings: [key] } });
    expect(after.keywords).toHaveLength(1);
    expect(after.keywords[0].subjectKey).toBe(key);
    expect(after.samples).toEqual(before.samples);
    expect(after.inputHash).not.toBe(before.inputHash);
  });
  it("does not silently replace frozen facts with newer versions; missing pinned evidence fails closed", async () => {
    const env = setup();
    env.source.versions.push({ ...env.source.versions[0], version: 2, contentHash: "c".repeat(64) });
    const view = await buildMarketIntelligence(env.input);
    expect(view.samples[0].evidence.version).toBe(1);
    expect(view.evidenceChanges).toHaveLength(1);
    env.source.versions.shift();
    expect((await buildMarketIntelligence(env.input)).samples).toHaveLength(0);
  });
  it("does not consume integrity failures or a mismatched marketplace", async () => {
    const env = setup([attachment("reverse_asin")]);
    env.source.integrityIssues = [{ fileName: "broken", code: "hash_mismatch" }];
    const view = await buildMarketIntelligence(env.input);
    expect(view.samples).toEqual([]);
    expect(view.keywords).toEqual([]);
  });
});

describe("market AI contract", () => {
  it("uses short transport references and restores exact immutable citations without changing facts", () => {
    const citation = { id: "attachment:source:" + "a".repeat(64), contentHash: "a".repeat(64) } as MarketIntelligence["samples"][number]["evidence"];
    const input = { evidence: [citation], samples: [{ subjectKey: KEY, evidence: citation, price: 12.99 }], text: "原文保持不变" };
    const wire = compactMarketAiEvidence(input, [citation]);
    const decoded = JSON.parse(wire.json);
    expect(decoded.samples[0]).toMatchObject({ subjectKey: KEY, price: 12.99, evidence: { id: "E1", contentHash: citation.contentHash } });
    expect(decoded.text).toBe(input.text);
    expect(input.evidence[0].id).toBe(citation.id);
    expect(wire.references.get("E1")).toBe(citation.id);
    expect(wire.references.has("E2")).toBe(false);
  });
  it("keeps absent/placeholder credentials and unapproved paid calls unavailable", () => {
    expect(marketProviderReadiness({}).code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(marketProviderReadiness({ DEEPSEEK_API_KEY: "your-api-key" }).ready).toBe(false);
    expect(marketProviderReadiness({ DEEPSEEK_API_KEY: "a-valid-shaped-key" }).code).toBe("PAID_CALL_NOT_AUTHORIZED");
  });
  it("rejects uncited conclusions and references to a different evidence version", () => {
    const point = { text: "An inference", nature: "inference", citations: ["attachment:a:hash-v1"] };
    const report = { schema: "market-intelligence-report.v1", summary: point, opportunities: [], risks: [], unknowns: [], actions: [] };
    expect(validateMarketReport(report, new Set(point.citations)).summary).toEqual(point);
    expect(() => validateMarketReport(report, new Set(["attachment:a:hash-v2"]))).toThrow("MARKET_AI_OUTPUT_INVALID");
    expect(() => validateMarketReport({ ...report, summary: { ...point, citations: [] } }, new Set())).toThrow();
    expect(validateMarketReport({ ...report, summary: { ...point, nature: "unknown", citations: [] } }, new Set()).summary.nature).toBe("unknown");
  });
  it("aliases every input review for complete low-star-first classification and states the policy", () => {
    const subjectKey = "amazon:US:B0ITEM0001";
    const citation = { id: "evidence:1:" + "a".repeat(64), subjectKey, evidenceId: "ev-1", contentHash: "a".repeat(64), version: 1, capturedAt: "2026-10-23T00:00:00Z", sourceUrl: null, nature: "source_observed" };
    const reviews = Array.from({ length: 61 }, (_, index) => ({ id: `review-${index}`, subjectKey, title: null, text: `fixture review ${index}`, rating: index === 60 ? 1 : 5, evidence: citation }));
    const view = { scanName: "fixture", marketplace: "US", inputHash: "h", statistics: { subjects: [subjectKey] }, samples: [], reviews, keywords: [], queryBindings: [], sources: [], productMarkets: [], productSignals: [], trends: [], variations: [], limitations: [] } as unknown as MarketIntelligence;
    const aiInput = buildMarketAiInput(view, []);
    expect(aiInput.reviews).toHaveLength(60);
    expect(aiInput.reviews[0]).toMatchObject({ reviewRef: "R1", rating: 1 });
    expect(new Set(aiInput.reviews.map((review) => review.reviewRef)).size).toBe(60);
    expect(aiInput.inputSampling.reviewRows).toEqual([60, 61]);
    expect(aiInput.inputSampling.policy).toContain("每条输入评论都会得到主题归属、未命中或无法判断");
  });
});

describe("SellerSprite FBA projection", () => {
  it("projects a same-ASIN structured estimate with attachment provenance into ProductFact", () => {
    const a = attachment("sellersprite_product_market", { data: { estimatedFbaFee: { amount: 4.25, currency: "USD" } } });
    expect(projectSellerSpriteSupplement(a)?.fbaFee).toEqual({ amount: 4.25, currency: "USD" });
    const fact = makeProductFact({ asin: "B0ITEM0001", subjectKey: KEY });
    const projected = projectProductFactEvidence({ ...fact, profit: { ...fact.profit, fbaFee: { ...fact.profit.fbaFee, value: null, status: "missing" } } }, [a]);
    expect(projected.profit.fbaFee).toMatchObject({ value: { amount: 4.25, currency: "USD" }, metricNature: "estimate", source: "sellersprite_plugin", evidenceRefs: [expect.objectContaining({ contentHash: a.contentHash, refId: `attachment:${a.attachmentId}` })] });
  });
  it("refuses a corrupt hash, wrong ASIN, or a query-level fee as a product fact", () => {
    const a = attachment("sellersprite_product_market", { data: { estimatedFbaFee: { amount: 4.25, currency: "USD" } } });
    expect(projectSellerSpriteSupplement({ ...a, contentHash: "f".repeat(64) })).toBeNull();
    const fact = makeProductFact({ asin: "B0OTHER001", subjectKey: "amazon:US:B0OTHER001" });
    expect(projectProductFactEvidence(fact, [a]).profit.fbaFee).toEqual(fact.profit.fbaFee);
    const key = `sellersprite:US:product-market:${"d".repeat(64)}`;
    const q = attachment("sellersprite_product_market", { subjectKey: key, data: { queryContract: { queryFingerprint: "d".repeat(64) }, estimatedFbaFee: { amount: 4.25, currency: "USD" }, visibleSnapshot: { tables: [{ headers: ["ASIN", "商品名称", "预估FBA费"], rows: [["B0ITEM0001", "fixture", "$4.25"]] }] } } });
    expect(projectSellerSpriteSupplement(q)).toMatchObject({ fbaFee: null, productRows: [{ asin: "B0ITEM0001", fbaFee: 4.25 }] });
    const base = makeProductFact({ asin: "B0ITEM0001", subjectKey: KEY });
    expect(projectProductFactEvidence(base, [q]).profit.fbaFee).toEqual(base.profit.fbaFee);
  });
});
