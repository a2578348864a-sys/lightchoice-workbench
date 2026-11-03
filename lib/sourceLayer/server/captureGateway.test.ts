import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import {
  captureEvidenceAttachmentThroughGateway,
  captureThroughGateway,
} from "@/lib/sourceLayer/server/captureGateway";
import {
  extractAmazonDetailPageV2,
  type AmazonDetailDomCandidate,
  type AmazonDetailPageDomSnapshot,
} from "@/tools/collectors/amazon/detail-page-extract-v2";
import { planAmazonDetailCapture } from "@/tools/collectors/recipes/amazon";

const NOW = new Date("2026-09-19T08:00:00.000Z");
const OWNER_CONTEXT: AccessContext = { mode: "owner", token: "" };

const payload = {
  asin: "B0GATEWAY1",
  title: "Gateway structural mapping fixture",
  productUrl: "https://www.amazon.com/dp/B0GATEWAY1",
  images: ["https://m.media-amazon.com/images/I/gateway.jpg"],
  brand: "Gateway Brand",
  price: 24.99,
  currency: "USD",
  rating: 4.7,
  reviewCount: 321,
  bsrRank: 88,
  bsrCategory: "Home & Kitchen",
  estimatedMonthlySales: 600,
  estimatedMonthlyRevenueUsd: 14994,
  bulletPoints: ["A captured bullet point"],
  launchedDate: "2025-01-02",
};

describe("Capture Gateway", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "source-layer-gateway-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  });

  afterEach(() => {
    delete process.env.SOURCE_LAYER_STORE_DIR;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists Evidence before returning a structural ProductFact projection", async () => {
    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "manual",
      payload,
      now: NOW,
    });

    expect(result.schemaVersion).toBe("capture-gateway-result.v1");
    expect(result.source).toBe("manual");
    expect(result.capture.readyCount).toBe(1);
    expect(result.capture.items[0]?.state).toBe("READY_FOR_RESEARCH");
    expect(result.qualityGate).toEqual({
      enabled: false,
      status: "disabled",
      gateId: null,
      issues: [],
    });

    const fact = result.productFacts[0];
    expect(fact).toBeDefined();
    expect(fact?.sourceProof.source).toBe("manual");
    expect(fact?.sourceProof.sourceMethod).toBe("manual");
    expect(fact?.sourceProof.evidenceId).toBeTruthy();
    expect(fact?.basic.title.value).toBe(payload.title);
    expect(fact?.basic.image.value).toBe(payload.images[0]);
    expect(fact?.basic.bulletPoints.value).toEqual(payload.bulletPoints);
    expect(fact?.market.launchedDate.value).toBe(payload.launchedDate);
    expect(fact?.profit.fbaFee.status).toBe("missing");

    const evidence = await createEvidenceStore("owner:v1")
      .getSubject("amazon:US:B0GATEWAY1");
    expect(evidence?.versions).toHaveLength(1);
    expect(evidence?.versions[0]?.factAuthority).toBe("evidence_only");
    expect(evidence?.versions[0]?.sourceType).toBe("manual_entry");
  });

  it("keeps detail-page extensions in the same Evidence before adapting ProductFact", async () => {
    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        ...payload,
        asin: "B0GATEWAY2",
        title: "Amazon detail extension fixture with observed package data",
        productUrl: "https://www.amazon.com/dp/B0GATEWAY2",
        bulletPoints: ["Observed detail bullet"],
        packageWeight: { value: 1.2, unit: "lb" },
        packageDimensions: { length: 10, width: 5, height: 2, unit: "in" },
      },
      now: NOW,
      sourceUrl: "https://www.amazon.com/dp/B0GATEWAY2",
      subjectKey: "amazon:US:B0GATEWAY2",
      marketplace: "US",
      pageContext: { pageClass: "amazon_normal", allowFields: true, errorCode: "SELECTOR_MISS" },
    });
    const fact = result.productFacts[0];
    expect(fact?.basic.bulletPoints.value).toEqual(["Observed detail bullet"]);
    expect(fact?.profit.packageWeight.value).toEqual({ value: 1.2, unit: "lb" });
    expect(fact?.profit.packageDimensions.value).toEqual({ length: 10, width: 5, height: 2, unit: "in" });
    const evidence = await createEvidenceStore("owner:v1").getSubject("amazon:US:B0GATEWAY2");
    expect(evidence?.versions[0]?.pkg.extensions).toMatchObject({ packageWeight: { value: 1.2, unit: "lb" } });
    const audit = await createEvidenceStore("owner:v1").getAudit("amazon:US:B0GATEWAY2");
    expect(audit.some((entry) => entry.module === "JEV_SEMANTIC_ASSIST" && entry.jevRole === "semantic_assist")).toBe(true);
    expect(audit.some((entry) => entry.module === "JEV_SHADOW_AUDITOR" && entry.jevRole === "shadow_auditor")).toBe(true);
  });

  it("round-trips registered Amazon detail fields without promoting estimates or blocked metrics", async () => {
    const estimate = {
      rawText: "1K+ bought in past month",
      lowerBound: 1000,
      upperBound: null,
      qualifier: "at_least",
      metricNature: "estimate",
    } as const;
    const amazonDetail = {
      schemaVersion: "amazon-detail-registered-fields.v1",
      extractorVersion: "amazon-detail-extractor.v2",
      fieldRegistryVersion: "amazon-detail-field-registry.v1",
      primaryBsrProjectionVersion: "primary-bsr.v1",
      registeredFields: {
        boughtPastMonth: {
          canonicalField: "boughtPastMonth",
          priority: "P2",
          fieldNature: "ESTIMATED_METRIC",
          status: "observed",
          value: estimate,
          reason: null,
          sourceTrace: {
            ruleId: "boughtPastMonth",
            registryVersion: "amazon-detail-field-registry.v1",
            region: "primary_product_social_proof",
            selector: "#social-proofing-faceout",
            label: null,
            ruleVersion: null,
          },
        },
        fbaFee: {
          canonicalField: "fbaFee",
          priority: "BLOCKED",
          fieldNature: "BLOCKED",
          status: "blocked",
          value: null,
          reason: "field_contract_blocked",
          sourceTrace: {
            ruleId: "fbaFee",
            registryVersion: "amazon-detail-field-registry.v1",
            region: "blocked_no_source_contract",
            selector: null,
            label: null,
            ruleVersion: null,
          },
        },
        estimatedMonthlySales: {
          canonicalField: "estimatedMonthlySales",
          priority: "BLOCKED",
          fieldNature: "BLOCKED",
          status: "blocked",
          value: null,
          reason: "field_contract_blocked",
          sourceTrace: {
            ruleId: "estimatedMonthlySales",
            registryVersion: "amazon-detail-field-registry.v1",
            region: "blocked_no_source_contract",
            selector: null,
            label: null,
            ruleVersion: null,
          },
        },
        estimatedMonthlyRevenue: {
          canonicalField: "estimatedMonthlyRevenue",
          priority: "BLOCKED",
          fieldNature: "BLOCKED",
          status: "blocked",
          value: null,
          reason: "field_contract_blocked",
          sourceTrace: {
            ruleId: "estimatedMonthlyRevenue",
            registryVersion: "amazon-detail-field-registry.v1",
            region: "blocked_no_source_contract",
            selector: null,
            label: null,
            ruleVersion: null,
          },
        },
      },
    };
    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        ...payload,
        asin: "B0GATEWAY4",
        title: "Amazon detail V2 evidence fixture",
        productUrl: "https://www.amazon.com/dp/B0GATEWAY4",
        bsrRanks: [{ rank: 88, category: "Home & Kitchen" }, { rank: 320, category: "Sports & Outdoors" }],
        packageDimensions: { length: 10, width: 5, height: 2, unit: "in" },
        itemDimensions: { length: 9, width: 4, height: 1, unit: "in" },
        packageWeight: { value: 1.2, unit: "lb" },
        itemWeight: { value: 1.0, unit: "lb" },
        boughtPastMonth: estimate,
        amazonDetail,
        fbaFee: { amount: 4.5, currency: "USD" },
        estimatedMonthlySales: 1000,
        estimatedMonthlyRevenueUsd: 24990,
      },
      now: NOW,
      sourceUrl: "https://www.amazon.com/dp/B0GATEWAY4",
      subjectKey: "amazon:US:B0GATEWAY4",
      marketplace: "US",
      pageContext: { pageClass: "amazon_normal", allowFields: true },
    });

    const fact = result.productFacts[0];
    expect(fact?.market.monthlySalesEstimate.value).toBeNull();
    expect(fact?.market.monthlyRevenueEstimate.value).toBeNull();
    expect(fact?.profit.fbaFee.status).toBe("missing");
    expect(fact?.extended?.boughtPastMonth.value).toEqual(estimate);
    expect(fact?.extended?.boughtPastMonth.metricNature).toBe("estimate");
    expect(fact?.extended?.bsrRanks?.value).toEqual([
      { rank: 88, category: "Home & Kitchen" },
      { rank: 320, category: "Sports & Outdoors" },
    ]);
    expect(fact?.extended?.itemDimensions?.value).toEqual({ length: 9, width: 4, height: 1, unit: "in" });
    expect(fact?.extended?.itemWeight?.value).toEqual({ value: 1, unit: "lb" });
    expect(fact?.extended?.amazonDetail?.value?.registeredFields).toEqual(amazonDetail.registeredFields);

    const evidence = await createEvidenceStore("owner:v1").getSubject("amazon:US:B0GATEWAY4");
    const pkg = evidence?.versions[0]?.pkg;
    expect(pkg?.fields.estimatedMonthlySales).toBeNull();
    expect(pkg?.fields.estimatedMonthlyRevenueUsd).toBeNull();
    expect(pkg?.extensions).not.toHaveProperty("fbaFee");
    expect(pkg?.extensions?.amazonDetail?.registeredFields).toEqual(amazonDetail.registeredFields);
  });

  it("carries an actual V2 extraction through planner, EvidenceStore, and ProductFact", async () => {
    const asin = "B0GATEWAY5";
    const candidate = (selector: string, values: Partial<AmazonDetailDomCandidate>) => [{
      selector,
      text: values.text ?? null,
      label: values.label ?? null,
      value: values.value ?? null,
      href: values.href ?? null,
      src: values.src ?? null,
      alt: values.alt ?? null,
      selected: values.selected ?? null,
      priceContext: values.priceContext ?? null,
    }];
    const snapshot: AmazonDetailPageDomSnapshot = {
      schemaVersion: "amazon-detail-page-dom-snapshot.v1",
      pageUrl: `https://www.amazon.com/dp/${asin}`,
      pageStatus: "ok",
      productRootSelector: "#dp",
      candidates: {
        "input#ASIN": candidate("input#ASIN", { value: asin }),
        "#productTitle": candidate("#productTitle", { text: "Integrated V2 evidence product" }),
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": candidate("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen", {
          text: "$31.99",
          priceContext: {
            id: null,
            className: "a-price aok-align-center",
            dataAColor: "price",
            dataASize: "l",
            semanticRole: "current_pay_now",
            purchaseContext: "not_applicable",
            selected: null,
            inPrimaryBuyBox: true,
          },
        }),
        "#acrPopover .a-icon-alt": candidate("rating", { text: "4.5 out of 5 stars" }),
        "#acrCustomerReviewText": candidate("reviews", { text: "456 ratings" }),
        "#detailBullets_feature_div li": candidate("bsr", { text: "Best Sellers Rank: #88 in Home & Kitchen #320 in Sports & Outdoors" }),
        "#feature-bullets li .a-list-item": candidate("bullet", { text: "Observed V2 bullet" }),
        "#social-proofing-faceout": candidate("bought", { text: "1K+ bought in past month" }),
        "#landingImage": candidate("image", { src: "https://m.media-amazon.com/images/I/integrated.jpg" }),
      },
      specificationRows: [
        { region: "productSpecifications", selector: "#prodDetails tr", label: "Item Dimensions", value: "9 x 4 x 1 inches", text: "Item Dimensions 9 x 4 x 1 inches" },
        { region: "productSpecifications", selector: "#prodDetails tr", label: "Package Dimensions", value: "10 x 5 x 2 inches", text: "Package Dimensions 10 x 5 x 2 inches" },
        { region: "productSpecifications", selector: "#prodDetails tr", label: "Item Weight", value: "12 ounces", text: "Item Weight 12 ounces" },
        { region: "productSpecifications", selector: "#prodDetails tr", label: "Shipping Weight", value: "1 pound", text: "Shipping Weight 1 pound" },
      ],
    };
    const extraction = extractAmazonDetailPageV2(snapshot, {
      expectedAsin: asin,
      capturedAt: NOW.toISOString(),
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });
    const plan = planAmazonDetailCapture({ extraction, pageUrl: snapshot.pageUrl });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: plan.payload,
      now: NOW,
      sourceUrl: plan.sourceUrl,
      subjectKey: plan.subjectKey,
      marketplace: "US",
      pageContext: plan.pageContext,
    });
    const fact = result.productFacts[0];
    expect(result.capture.readyCount).toBeGreaterThan(0);
    expect(result.capture.items[0]?.subjectKey).toBe(`amazon:US:${asin}`);
    expect(fact?.basic.asin.value).toBe(asin);
    expect(fact?.basic.title.value).toBe("Integrated V2 evidence product");
    expect(fact?.market.bsr.value).toBe(88);
    expect(fact?.extended?.bsrRanks?.value).toEqual([
      { rank: 88, category: "Home & Kitchen" },
      { rank: 320, category: "Sports & Outdoors" },
    ]);
    expect(fact?.extended?.itemDimensions?.value).toEqual({ length: 9, width: 4, height: 1, unit: "in" });
    expect(fact?.extended?.itemWeight?.value).toEqual({ value: 12, unit: "oz" });
    expect(fact?.extended?.boughtPastMonth?.value).toMatchObject({ rawText: "1K+ bought in past month", lowerBound: 1000, qualifier: "at_least", metricNature: "estimate" });
    expect(fact?.market.monthlySalesEstimate.value).toBeNull();
    expect(fact?.market.monthlyRevenueEstimate.value).toBeNull();
    expect(fact?.profit.fbaFee.status).toBe("missing");
    expect(fact?.extended?.amazonDetail?.value?.registeredFields).toEqual(extraction.registeredFields);

    const stored = await createEvidenceStore("owner:v1").getSubject(`amazon:US:${asin}`);
    const evidence = stored?.versions[0];
    expect(evidence?.factAuthority).toBe("evidence_only");
    expect(evidence?.pkg.extensions?.amazonDetail?.registeredFields).toEqual(extraction.registeredFields);
    expect(evidence?.pkg.fields.estimatedMonthlySales).toBeNull();
    expect(evidence?.pkg.fields.estimatedMonthlyRevenueUsd).toBeNull();
    expect(evidence?.pkg.extensions).not.toHaveProperty("fbaFee");
  });

  it("does not treat an ordinary missing field as a Semantic Assist trigger", async () => {
    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        ...payload,
        asin: "B0GATEWAY3",
        productUrl: "https://www.amazon.com/dp/B0GATEWAY3",
      },
      now: NOW,
      sourceUrl: "https://www.amazon.com/dp/B0GATEWAY3",
      subjectKey: "amazon:US:B0GATEWAY3",
      marketplace: "US",
      pageContext: { pageClass: "amazon_normal", allowFields: true },
    });
    expect(result.productFacts[0]?.profit.fbaFee.status).toBe("missing");
    expect(result.semanticAssist).toEqual([]);
  });

  it("writes Shadow Auditor output as a diagnostic sidecar without mutating ProductFact", async () => {
    const result = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "manual",
      payload,
      now: NOW,
      shadowAudit: { enabled: true, pageTemplateHash: "template-v1" },
    });

    expect(result.shadowAudit).toHaveLength(1);
    expect(result.shadowAudit[0]?.jevRole).toBe("shadow_auditor");
    expect(result.productFacts[0]?.basic.title.value).toBe(payload.title);

    const audit = await createEvidenceStore("owner:v1").getAudit("amazon:US:B0GATEWAY1");
    expect(audit.some((entry) => entry.eventType === "shadow_audit_finished")).toBe(true);
    expect(audit.find((entry) => entry.eventType === "shadow_audit_finished")?.jevRole).toBe("shadow_auditor");
    expect(audit.find((entry) => entry.eventType === "shadow_audit_finished")?.module).toBe("JEV_SHADOW_AUDITOR");
  });

  it("keeps auxiliary evidence on the same Gateway trace and EvidenceStore", async () => {
    const captured = await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "manual",
      payload,
      now: NOW,
    });
    const attachment = await captureEvidenceAttachmentThroughGateway({
      context: OWNER_CONTEXT,
      subjectKey: "amazon:US:B0GATEWAY1",
      source: "manual",
      kind: "review_evidence",
      sourceFingerprint: "review-fixture",
      payload: { schema: "review-source-fixture.v1", reviewText: "Observed review" },
      traceId: captured.traceId,
      capturedAt: NOW,
    });
    expect(attachment.traceId).toBe(captured.traceId);
    expect(attachment.sourceEvidenceRef?.subjectKey).toBe("amazon:US:B0GATEWAY1");
    const audit = await createEvidenceStore("owner:v1").getAudit("amazon:US:B0GATEWAY1");
    expect(audit.some((entry) => entry.traceId === captured.traceId && entry.eventType === "attachment_persisted")).toBe(true);
  });
});
