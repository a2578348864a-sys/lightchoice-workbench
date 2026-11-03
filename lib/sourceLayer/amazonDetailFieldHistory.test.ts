import { describe, expect, it } from "vitest";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { captureContentHashOf } from "@/lib/sourceLayer/sourceAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { attachAmazonDetailFieldHistory, projectAmazonDetailFieldHistory } from "@/lib/sourceLayer/amazonDetailFieldHistory";

const NOW = "2026-10-01T00:00:00.000Z";
const ASIN = "B0HISTORY1";
const SUBJECT = `amazon:US:${ASIN}`;
const URL = `https://www.amazon.com/dp/${ASIN}`;
const REGISTRY = "amazon-detail-field-registry.v1";

function evidence(options: {
  id: string;
  version: number;
  capturedAt: string;
  title?: string | null;
  price?: number | null;
  asin?: string;
  marketplace?: string;
  expectedMarketplace?: string;
  urlMarketplace?: string;
  titleStatus?: string;
  priceStatus?: string;
  titleNature?: string;
  priceNature?: string;
  titleOrigin?: string;
  priceOrigin?: string;
  titleTraceStatus?: string;
  priceTraceStatus?: string;
  priceContext?: string;
  sourceUrl?: string;
  selected?: boolean | null;
  validation?: { verdict: "passed" | "blocked"; readyForResearch: boolean };
  bound?: boolean;
}): CaptureEvidenceRecord {
  const asin = options.asin ?? ASIN;
  const marketplace = options.marketplace ?? "US";
  const sourceUrl = options.sourceUrl ?? URL;
  const title = options.title === undefined ? "Fixture historical title" : options.title;
  const price = options.price === undefined ? 21.5 : options.price;
  const field = (canonicalField: "title" | "price", value: unknown, status: string, fieldNature: string, semanticRole?: string, purchaseContext?: string) => ({
    canonicalField,
    priority: "P0" as const,
    fieldNature,
    status,
    value,
    reason: null,
    sourceTrace: {
      ruleId: canonicalField,
      registryVersion: REGISTRY,
      region: canonicalField === "title" ? "primary_product_title" : "primary_buy_box",
      selector: canonicalField === "title" ? "#productTitle" : "#corePrice_feature_div .apex-pricetopay-value .a-offscreen",
      label: null,
      ruleVersion: null,
      ...(semanticRole ? { semanticRole } : {}),
      ...(purchaseContext ? { purchaseContext } : {}),
      ...(canonicalField === "price" ? { selected: options.selected ?? true } : {}),
    },
  });
  const candidate = {
    schemaVersion: "amazon-detail-registered-fields.v1",
    extractorVersion: "amazon-detail-extractor.v2",
    fieldRegistryVersion: REGISTRY,
    primaryBsrProjectionVersion: "primary-bsr.v1",
    registeredFields: {
      title: field("title", title, options.titleTraceStatus ?? "observed", "DIRECT_FACT"),
      price: field("price", price === null ? null : { amount: price, currency: "USD" }, options.priceTraceStatus ?? "observed", "DIRECT_FACT", "current_pay_now", options.priceContext ?? "one_time"),
      fbaFee: { canonicalField: "fbaFee", priority: "BLOCKED", fieldNature: "BLOCKED", status: "blocked", value: null, reason: null, sourceTrace: { ruleId: "fbaFee", registryVersion: REGISTRY, region: "blocked", selector: null, label: null, ruleVersion: null } },
      estimatedMonthlySales: { canonicalField: "estimatedMonthlySales", priority: "BLOCKED", fieldNature: "BLOCKED", status: "blocked", value: null, reason: null, sourceTrace: { ruleId: "estimatedMonthlySales", registryVersion: REGISTRY, region: "blocked", selector: null, label: null, ruleVersion: null } },
      estimatedMonthlyRevenue: { canonicalField: "estimatedMonthlyRevenue", priority: "BLOCKED", fieldNature: "BLOCKED", status: "blocked", value: null, reason: null, sourceTrace: { ruleId: "estimatedMonthlyRevenue", registryVersion: REGISTRY, region: "blocked", selector: null, label: null, ruleVersion: null } },
    },
  };
  const binding = {
    bound: options.bound ?? true,
    expectedAsin: ASIN,
    observedAsin: asin,
    expectedMarketplace: options.expectedMarketplace ?? "US",
    observedMarketplace: options.urlMarketplace ?? "US",
    urlAsin: asin,
    urlMarketplace: options.urlMarketplace ?? "US",
  };
  const titleState = options.titleStatus ?? "confirmed";
  const priceState = options.priceStatus ?? "confirmed";
  const state = (status: string, valueOrigin: string, sourceRef: string) => ({ status, metricNature: "snapshot", valueOrigin, confidence: 1, sourceRef });
  const pkg = {
      schemaVersion: "source-capture-package.v1",
      captureId: `capture-${options.id}`,
      subjectKey: SUBJECT,
      version: options.version,
      marketplace,
      fields: { asin, title, price: price === null ? null : { amount: price, currency: "USD" } },
      fieldStates: {
        title: state(titleState, options.titleOrigin ?? "page_measured", "amazon_dom.#productTitle"),
        price: state(priceState, options.priceOrigin ?? "page_measured", "amazon_dom.#corePrice"),
      },
      extensions: { amazonDetail: candidate },
      sourceProof: { sourceType: "amazon_dom", capturedAt: options.capturedAt, sourceUrl, entityBinding: binding },
  };
  const record = {
    schemaVersion: "source-evidence-record.v1",
    factAuthority: "evidence_only",
    evidenceId: options.id,
    captureId: `capture-${options.id}`,
    subjectKey: SUBJECT,
    version: options.version,
    sourceType: "amazon_dom",
    sourceUrl,
    capturedAt: options.capturedAt,
    contentHash: captureContentHashOf(pkg as never),
    pkg,
    validation: options.validation ?? { verdict: "passed", readyForResearch: true },
  };
  return record as unknown as CaptureEvidenceRecord;
}

function project(candidates: CaptureEvidenceRecord[], extra: Partial<Parameters<typeof projectAmazonDetailFieldHistory>[0]> = {}) {
  return projectAmazonDetailFieldHistory({
    subjectKey: SUBJECT,
    marketplace: "US",
    asin: ASIN,
    now: NOW,
    priceContext: "one_time",
    candidates,
    ...extra,
  });
}

describe("Amazon detail field history projection", () => {
  it("accepts a normal Amazon product URL with a product slug before /dp/{asin}", () => {
    const sourceUrl = `https://www.amazon.com/a-factual-product-slug/dp/${ASIN}/ref=sr_1_1?keywords=sample`;
    const record = evidence({ id: "slugged-product-url", version: 1, capturedAt: "2026-09-30T12:00:00.000Z", sourceUrl });

    expect(project([record]).fields.price).toMatchObject({
      status: "restored",
      value: { amount: 21.5, currency: "USD" },
      origin: { evidenceId: "slugged-product-url", asin: ASIN, sourceUrl },
    });
  });

  it("restores fields independently and preserves the original evidence reference", () => {
    const old = evidence({ id: "e-old", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    const emptyCurrent = evidence({ id: "e-current", version: 2, capturedAt: "2026-10-01T00:00:00.000Z", title: null, price: null });
    const result = project([old, emptyCurrent], { currentEvidenceId: "e-current" });

    expect(result.fields.title).toMatchObject({ status: "restored", value: "Fixture historical title", origin: { evidenceId: "e-old", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" } });
    expect(result.fields.price).toMatchObject({ status: "restored", value: { amount: 21.5, currency: "USD" }, origin: { evidenceId: "e-old", version: 1, priceContext: "one_time" } });
    expect(result.fields.title.origin?.contentHash).toBe(old.contentHash);
  });

  it("prefers a fresh confirmed current value, but never lets a current conflict be overwritten", () => {
    const old = evidence({ id: "e-old", version: 1, capturedAt: "2026-09-30T00:00:00.000Z", title: "Old" });
    const fresh = evidence({ id: "e-fresh", version: 2, capturedAt: "2026-09-30T12:00:00.000Z", title: "Fresh" });
    expect(project([old, fresh], { currentEvidenceId: "e-fresh" }).fields.title).toMatchObject({ status: "current", value: "Fresh", origin: { evidenceId: "e-fresh" } });
    const conflicted = evidence({ id: "e-conflict", version: 3, capturedAt: "2026-09-30T18:00:00.000Z", title: "Conflict", titleStatus: "conflict" });
    expect(project([old, conflicted], { currentEvidenceId: "e-conflict" }).fields.title).toMatchObject({ status: "conflict", origin: null, reason: "current_field_conflict_or_ambiguous" });
  });

  it("rejects cross-identity, estimated, invalid, unbound, future, and context-mismatched candidates", () => {
    const candidates = [
      evidence({ id: "wrong-market", version: 1, capturedAt: "2026-09-30T00:00:00.000Z", marketplace: "CA" }),
      evidence({ id: "estimated", version: 2, capturedAt: "2026-09-30T00:00:00.000Z", titleStatus: "estimated", titleOrigin: "model_estimated" }),
      evidence({ id: "ambiguous", version: 3, capturedAt: "2026-09-30T00:00:00.000Z", titleTraceStatus: "ambiguous" }),
      evidence({ id: "future", version: 4, capturedAt: "2026-10-02T00:00:00.000Z" }),
      evidence({ id: "bad-price-context", version: 5, capturedAt: "2026-09-30T00:00:00.000Z", priceContext: "subscribe_save" }),
      evidence({ id: "unbound", version: 6, capturedAt: "2026-09-30T00:00:00.000Z", bound: false }),
    ];
    const result = project(candidates);
    expect(result.fields.title).toMatchObject({ status: "restored", origin: { evidenceId: "bad-price-context" } });
    expect(result.fields.title.rejected.map(({ reason }) => reason)).toEqual(expect.arrayContaining([
      "marketplace_mismatch", "field_not_confirmed_snapshot", "field_conflict_or_ambiguous", "captured_at_future",
    ]));
    expect(result.fields.price.rejected.map(({ reason }) => reason)).toContain("price_purchase_context_unproven");
  });

  it("fails closed on same-time different values and uses capture time over inverted version order", () => {
    const a = evidence({ id: "e-a", version: 9, capturedAt: "2026-09-30T12:00:00.000Z", title: "A" });
    const b = evidence({ id: "e-b", version: 10, capturedAt: "2026-09-30T12:00:00.000Z", title: "B" });
    expect(project([a, b]).fields.title).toMatchObject({ status: "conflict", reason: "same_time_different_values" });
    const newerTimeOlderVersion = evidence({ id: "e-time-new", version: 3, capturedAt: "2026-09-30T18:00:00.000Z", title: "By time" });
    const olderTimeNewerVersion = evidence({ id: "e-version-new", version: 4, capturedAt: "2026-09-30T17:00:00.000Z", title: "By version" });
    expect(project([olderTimeNewerVersion, newerTimeOlderVersion]).fields.title).toMatchObject({ status: "restored", value: "By time", reason: "selected_by_captured_at_version_order_disagrees" });
  });

  it("uses deterministic hashes regardless of input array order and enforces exact TTL boundaries", () => {
    const a = evidence({ id: "e-a", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    const b = evidence({ id: "e-b", version: 2, capturedAt: "2026-09-29T00:00:00.000Z" });
    expect(project([a, b]).decisionHash).toBe(project([b, a]).decisionHash);
    const titleAtBoundary = evidence({ id: "title-boundary", version: 1, capturedAt: "2026-09-01T00:00:00.000Z" });
    const priceAtBoundary = evidence({ id: "price-boundary", version: 1, capturedAt: "2026-09-29T00:00:00.000Z" });
    expect(project([titleAtBoundary, priceAtBoundary]).fields.title.status).toBe("restored");
    expect(project([titleAtBoundary, priceAtBoundary]).fields.price.status).toBe("restored");
    const titleExpired = evidence({ id: "title-expired", version: 1, capturedAt: "2026-08-31T23:59:59.999Z" });
    const priceExpired = evidence({ id: "price-expired", version: 1, capturedAt: "2026-08-31T23:59:59.999Z" });
    expect(project([titleExpired, priceExpired]).fields.title).toMatchObject({ status: "historical_only", value: "Fixture historical title", reason: "title_expired" });
    expect(project([titleExpired, priceExpired]).fields.price).toMatchObject({ status: "missing", value: null, reason: "price_expired" });

    const emptyCurrent = evidence({ id: "current-empty", version: 2, capturedAt: NOW, title: null, price: null });
    const history = project([titleExpired, emptyCurrent], { currentEvidenceId: emptyCurrent.evidenceId });
    const emptyFact = {
      schema: "product-fact.v3",
      subjectKey: SUBJECT,
      sourceProof: {
        source: "amazon_dom",
        captureId: emptyCurrent.captureId,
        evidenceId: emptyCurrent.evidenceId,
        subjectKey: SUBJECT,
        capturedAt: emptyCurrent.capturedAt,
        contentHash: emptyCurrent.contentHash,
        sourceUrl: URL,
        operator: "owner:v1",
        entityBinding: {
          bound: true,
          expectedAsin: ASIN,
          observedAsin: ASIN,
          expectedMarketplace: "US",
          observedMarketplace: "US",
          urlAsin: ASIN,
          urlMarketplace: "US",
        },
      },
      basic: {
        asin: { value: ASIN },
        title: { value: null, status: "missing", source: "amazon_dom", confidence: 0, capturedAt: NOW, rawProofHash: emptyCurrent.contentHash },
        price: { value: null, status: "missing", source: "amazon_dom", confidence: 0, capturedAt: NOW, rawProofHash: emptyCurrent.contentHash },
      },
    } as unknown as ProductFact;
    const attached = attachAmazonDetailFieldHistory(emptyFact, history);
    expect(attached.basic.title.value).toBeNull();
    expect(attached.amazonDetailHistory?.fields.title.status).toBe("historical_only");
  });

  it("does not allow an invalid or future current record to gain priority via the TTL helper", () => {
    const future = evidence({ id: "e-future-current", version: 2, capturedAt: "2026-10-01T00:00:00.001Z" });
    const old = evidence({ id: "e-old-current", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    expect(project([future, old], { currentEvidenceId: future.evidenceId }).fields.title).toMatchObject({ status: "invalid", origin: null, reason: "current_captured_at_future" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PH1 历史恢复：TTL 精确边界、身份/证据完整性门禁、注入时间校验
// ─────────────────────────────────────────────────────────────────────────────
describe("Amazon detail field history — TTL 与门禁边界", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const nowMs = Date.parse(NOW);

  it("Title TTL = 30 天：29d23h59m 有效 / 30d 精确有效 / 30d+1ms 过期", () => {
    const valid = evidence({ id: "t-valid", version: 1, capturedAt: new Date(nowMs - (30 * DAY - 60_000)).toISOString() });
    expect(project([valid]).fields.title).toMatchObject({ status: "restored", origin: { evidenceId: "t-valid" } });

    const exact = evidence({ id: "t-exact", version: 1, capturedAt: new Date(nowMs - 30 * DAY).toISOString() });
    expect(project([exact]).fields.title).toMatchObject({ status: "restored", origin: { evidenceId: "t-exact" } });

    const plusOneMs = evidence({ id: "t-plus-1ms", version: 1, capturedAt: new Date(nowMs - 30 * DAY - 1).toISOString() });
    expect(project([plusOneMs]).fields.title).toMatchObject({ status: "historical_only", reason: "title_expired" });
  });

  it("Price TTL = 48 小时：47h59m 有效 / 48h 精确有效 / 48h+1ms 过期", () => {
    const valid = evidence({ id: "p-valid", version: 1, capturedAt: new Date(nowMs - (48 * HOUR - 60_000)).toISOString() });
    expect(project([valid]).fields.price).toMatchObject({ status: "restored", origin: { evidenceId: "p-valid", priceContext: "one_time" } });

    const exact = evidence({ id: "p-exact", version: 1, capturedAt: new Date(nowMs - 48 * HOUR).toISOString() });
    expect(project([exact]).fields.price).toMatchObject({ status: "restored", origin: { evidenceId: "p-exact" } });

    const plusOneMs = evidence({ id: "p-plus-1ms", version: 1, capturedAt: new Date(nowMs - 48 * HOUR - 1).toISOString() });
    expect(project([plusOneMs]).fields.price).toMatchObject({ status: "missing", reason: "price_expired" });
  });

  it("未来 capturedAt（+1ms / +5min）一律拒绝，不能作为历史候选", () => {
    const plus1ms = evidence({ id: "f-1ms", version: 1, capturedAt: new Date(nowMs + 1).toISOString() });
    const plus5min = evidence({ id: "f-5min", version: 2, capturedAt: new Date(nowMs + 5 * 60_000).toISOString() });
    const result = project([plus1ms, plus5min]);
    expect(result.fields.title.status).toBe("missing");
    expect(result.fields.title.rejected.filter(({ reason }) => reason === "captured_at_future")).toHaveLength(2);
  });

  it("非法 capturedAt 字符串被拒为 captured_at_invalid，不抛异常", () => {
    const broken = evidence({ id: "bad-time", version: 1, capturedAt: "not-a-timestamp" });
    const result = project([broken]);
    expect(result.fields.title.status).toBe("missing");
    expect(result.fields.title.rejected.map(({ reason }) => reason)).toEqual(["captured_at_invalid"]);
  });

  it("非法 injectedNow 直接 fail-closed 抛错，不静默放行", () => {
    const ok = evidence({ id: "ok", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    expect(() => project([ok], { now: "bogus" })).toThrow("AMAZON_DETAIL_HISTORY_INPUT_INVALID");
  });

  it("跨 ASIN 与跨 marketplace 均按身份不匹配拒绝", () => {
    const crossAsin = evidence({ id: "cross-asin", version: 1, capturedAt: "2026-09-30T00:00:00.000Z", asin: "B0OTHER123" });
    expect(project([crossAsin]).fields.title.rejected.map(({ reason }) => reason)).toContain("entity_binding_mismatch");

    const crossMarket = evidence({ id: "cross-market", version: 2, capturedAt: "2026-09-30T00:00:00.000Z", marketplace: "CA", urlMarketplace: "CA" });
    expect(project([crossMarket]).fields.title.rejected.map(({ reason }) => reason)).toContain("marketplace_mismatch");
  });

  it("证据指纹与内容不一致时拒绝（evidence_proof_incomplete）", () => {
    const tampered = evidence({ id: "tampered-hash", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    (tampered as { contentHash: string }).contentHash = "d".repeat(64);
    const result = project([tampered]);
    expect(result.fields.title.status).toBe("missing");
    expect(result.fields.title.rejected.map(({ reason }) => reason)).toContain("evidence_proof_incomplete");
  });

  it("官方 Validator 未通过的证据不得参与恢复", () => {
    const blocked = evidence({
      id: "blocked-evidence",
      version: 1,
      capturedAt: "2026-09-30T00:00:00.000Z",
      validation: { verdict: "blocked", readyForResearch: false },
    });
    expect(project([blocked]).fields.title.rejected.map(({ reason }) => reason)).toContain("evidence_not_research_ready");
  });

  it("注册字段值与 canonical 值不一致时拒绝（field_value_not_bound_to_canonical_value）", () => {
    const unbound = evidence({ id: "unbound-value", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    const pkg = unbound.pkg as unknown as {
      extensions: { amazonDetail: { registeredFields: { title: { value: unknown } } } };
    };
    pkg.extensions.amazonDetail.registeredFields.title.value = "Different title than canonical";
    // 保持证据指纹自洽：重算 contentHash，避免落到 evidence_proof_incomplete
    (unbound as { contentHash: string }).contentHash = captureContentHashOf(unbound.pkg as never);
    expect(project([unbound]).fields.title.rejected.map(({ reason }) => reason)).toContain("field_value_not_bound_to_canonical_value");
  });

  it("缺少 purchaseContext 时 Price 不可恢复（price_purchase_context_unproven）", () => {
    const priced = evidence({ id: "no-context", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    expect(project([priced], { priceContext: null }).fields.price).toMatchObject({
      status: "missing",
      reason: "no_eligible_confirmed_candidate",
    });
    expect(project([priced], { priceContext: null }).fields.price.rejected.map(({ reason }) => reason))
      .toContain("price_purchase_context_unproven");
  });

  it("当前字段 ambiguous 时保留冲突态，不被历史值覆盖", () => {
    const old = evidence({ id: "c-old", version: 1, capturedAt: "2026-09-30T00:00:00.000Z", title: "Old" });
    const currentAmbiguous = evidence({
      id: "c-ambiguous",
      version: 2,
      capturedAt: "2026-09-30T12:00:00.000Z",
      title: "Ambiguous",
      titleTraceStatus: "ambiguous",
    });
    const result = project([old, currentAmbiguous], { currentEvidenceId: currentAmbiguous.evidenceId });
    expect(result.fields.title).toMatchObject({ status: "conflict", origin: null, reason: "current_field_conflict_or_ambiguous" });
  });

  it("相同输入与相同 now 得到稳定 decisionHash（与数组顺序无关）", () => {
    const a = evidence({ id: "d-a", version: 1, capturedAt: "2026-09-28T00:00:00.000Z" });
    const b = evidence({ id: "d-b", version: 2, capturedAt: "2026-09-29T00:00:00.000Z" });
    const c = evidence({ id: "d-c", version: 3, capturedAt: "2026-09-30T00:00:00.000Z" });
    const h1 = project([a, b, c]).decisionHash;
    expect(project([c, a, b]).decisionHash).toBe(h1);
    expect(project([b, c, a]).decisionHash).toBe(h1);
    expect(project([a, b, c], { now: new Date(nowMs + 1_000).toISOString() }).decisionHash).not.toBe(h1);
  });
});
