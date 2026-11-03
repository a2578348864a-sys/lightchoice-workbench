import { describe, expect, it } from "vitest";

import { FIXTURE_CONTENT_HASH, FIXTURE_CAPTURED_AT, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { buildSourceEvidenceAttachment, type SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildCustomerVoiceAttachmentPayload, buildCustomerVoiceObservation } from "@/lib/sourceLayer/customerVoice";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import type { MonitoringRunRecord } from "@/lib/server/continuousMonitoringRepository";
import type { ProductConceptSnapshot, ProductConceptSourceBinding } from "@/lib/marketOpportunity/concept";
import { buildV5ResearchPacket } from "@/lib/server/research/researchPacketBuilder";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import {
  mapProductFactToV5HubFields,
  mapMonitoringRunToV5HubRow,
  mapProductConceptToV5HubFields,
  mapResearchPacketToV5HubFields,
  mapV3KeywordAttachmentsToV5HubRows,
  mapCustomerVoiceAttachmentsToV5HubRows,
} from "./v5HubProjection";
import { V5_HUB_TABLES } from "./v5HubSchema";

function setup() {
  const productFact = makeProductFact({ source: "sellersprite_xlsx", contentHash: FIXTURE_CONTENT_HASH, capturedAt: FIXTURE_CAPTURED_AT });
  const proof = productFact.sourceProof;
  const ref = {
    refId: `evidence:${proof.evidenceId}`,
    kind: "product_evidence" as const,
    subjectKey: productFact.subjectKey,
    evidenceId: proof.evidenceId,
    captureId: proof.captureId,
    version: 1,
    contentHash: proof.contentHash,
    capturedAt: proof.capturedAt,
  };
  const bundle: ResearchInputBundle = {
    schemaVersion: "research-input-bundle.v1", taskId: "task-projection-test", candidateId: "candidate-test",
    subjectKey: productFact.subjectKey, productFact, sourceEvidenceRefs: [ref], keywordEvidence: [], reviewEvidence: [],
    customerVoiceEvidence: [], trendObservations: [], missingFields: [], conflicts: [],
    freshness: { latestCapturedAt: proof.capturedAt, ageDays: 0 }, traceId: "trace-projection-test",
  };
  const factField = <T,>(value: T | null) => ({
    value, status: value === null ? "missing" as const : "present" as const,
    source: "sellersprite_xlsx" as const, confidence: value === null ? 0 : 0.9,
    capturedAt: proof.capturedAt, rawProofHash: proof.contentHash, evidenceRefs: [],
  });
  const facts = {
    basic: {
      asin: factField(productFact.basic.asin.value), title: factField(productFact.basic.title.value),
      image: factField(productFact.basic.image.value), brand: factField(productFact.basic.brand.value),
      category: factField(productFact.basic.category.value), price: factField(productFact.basic.price.value),
      rating: factField(4.5), reviewCount: factField(120), bulletPoints: factField(["fixture"]),
    },
    market: {
      bsr: factField(1500), monthlySalesEstimate: factField(300),
      monthlyRevenueEstimate: factField({ amount: 5997, currency: "USD" }), launchedDate: factField("2024-06-01"),
      subCategoryBsr: factField(null), dateFirstAvailable: factField(null), buyboxSeller: factField(null),
      fulfillmentType: factField(null), estimatedGrossMargin: factField(null), listingQualityScore: factField(null),
    },
    profit: {
      packageWeight: factField({ value: 0.5, unit: "kg" as const }),
      packageDimensions: factField({ length: 10, width: 8, height: 4, unit: "cm" as const }),
      fbaFee: factField(productFact.profit.fbaFee.value), itemWeight: factField(null), itemDimensions: factField(null),
    },
    keywordEvidence: { topKeywords: factField([]) },
  } as Parameters<typeof buildV5ResearchPacket>[0]["facts"];
  const packet = buildV5ResearchPacket({
    productFact, facts, researchInputBundle: bundle, taskId: bundle.taskId, revision: 1,
    marketplace: "US", generatedAt: "2026-09-28T00:00:00.000Z",
  });
  return { productFact, packet };
}

describe("V5 Hub projection mapping", () => {
  it("projects count-only VOC aggregates with deterministic Chinese labels and no raw content", () => {
    const subjectKey = "amazon:US:B07G4VTV2F";
    const review = (id: string, attachmentId: string, text: string, capturedAt: string) => buildCustomerVoiceObservation({
      source: "amazon_review",
      subjectKey,
      externalContentId: id,
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt,
      publishedAt: "2026-09-20T00:00:00.000Z",
      title: `private title ${id}`,
      text,
      rating: 4,
      verifiedPurchase: true,
      engagement: null,
      sourceUrl: "https://www.amazon.com/dp/B07G4VTV2F",
      evidenceRefs: [`attachment:${attachmentId}`],
      provenance: {
        provider: "amazon_dom",
        method: "capture_v3_amazon_review",
        accessBasis: "first_party_visible_page",
        sourceAttachmentId: attachmentId,
        rawArtifactId: null,
        providerTermsVersion: null,
      },
      retentionPolicy: "source_evidence_default",
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "EXACT",
      ownerExperience: null,
    });
    const attachment = (attachmentId: string, observation: ReturnType<typeof review>) => buildSourceEvidenceAttachment({
      attachmentId,
      subjectKey,
      kind: "customer_voice_observation_v1",
      sourceType: "amazon_dom",
      capturedAt: observation.capturedAt,
      payload: buildCustomerVoiceAttachmentPayload({ subjectKey, observations: [observation] }) as unknown as Record<string, unknown>,
    });
    const first = review("review-opaque-1", "source-review-1", "private review body one", "2026-09-27T00:00:00.000Z");
    const second = review("review-opaque-2", "source-review-2", "private review body two", "2026-09-28T00:00:00.000Z");
    const attachments = [
      attachment("voice-a", first),
      attachment("voice-b", first), // duplicate content is counted once
      attachment("voice-c", second),
    ];
    const rows = mapCustomerVoiceAttachmentsToV5HubRows({ subjectKey, attachments });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields).toMatchObject({
      "主体键": subjectKey,
      "聚合键": "亚马逊商品评论·精确匹配",
      "销售站点": "US",
      "来源类型": "亚马逊商品评论",
      "问题类型": null,
      "痛点标签": null,
      "出现频次": null,
      "样本数量": 2,
      "覆盖状态": "仅统计，未分类",
      "代表性原文": null,
      "统计开始时间": Date.parse("2026-09-20T00:00:00.000Z"),
      "统计结束时间": Date.parse("2026-09-20T00:00:00.000Z"),
      "聚合时间": Date.parse("2026-09-28T00:00:00.000Z"),
    });
    expect(rows[0]?.fields["聚合版本"]).toMatch(/^仅统计未分类-v1-[a-f0-9]{16}$/u);
    expect(rows[0]?.fields["内容哈希"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(rows[0]?.logicalKey).toContain("亚马逊商品评论·精确匹配");
    expect(JSON.stringify(rows)).not.toContain("private review body");
    expect(JSON.stringify(rows)).not.toContain("private title");
    expect(JSON.stringify(rows)).not.toContain("review-opaque");
    expect(mapCustomerVoiceAttachmentsToV5HubRows({ subjectKey, attachments: [...attachments].reverse() })).toEqual(rows);
  });

  it("fails closed for mismatched or malformed Customer Voice attachments", () => {
    const subjectKey = "amazon:US:B07G4VTV2F";
    const attachment = {
      schemaVersion: "source-evidence-attachment.v1",
      attachmentId: "voice-valid",
      subjectKey,
      kind: "customer_voice_observation_v1",
      sourceType: "amazon_dom",
      capturedAt: "2026-09-27T00:00:00.000Z",
      sourceUrl: null,
      sourceFingerprint: null,
      contentHash: "a".repeat(64),
      payload: { invalid: true },
    } as SourceEvidenceAttachment;
    expect(() => mapCustomerVoiceAttachmentsToV5HubRows({ subjectKey, attachments: [attachment] }))
      .toThrow("V5_HUB_VOC_ATTACHMENT_INVALID");
    expect(() => mapCustomerVoiceAttachmentsToV5HubRows({
      subjectKey,
      attachments: [{ ...attachment, subjectKey: "amazon:US:B000000000" }],
    })).toThrow("V5_HUB_VOC_ATTACHMENT_SUBJECT_MISMATCH");
  });

  it("maps English keys to exact Chinese T01/T02 field allowlists", () => {
    const { productFact, packet } = setup();
    const t01 = mapProductFactToV5HubFields({ productFact, packet, projectedAt: "2026-09-28T00:00:00.000Z" });
    const t02 = mapResearchPacketToV5HubFields(packet);
    const t01Names = V5_HUB_TABLES[0].fields.filter((field) => field.writableBy === "projection").map((field) => field.displayName);
    const t02Names = V5_HUB_TABLES[1].fields.filter((field) => field.writableBy === "projection").map((field) => field.displayName);
    expect(Object.keys(t01).sort()).toEqual(t01Names.sort());
    expect(Object.keys(t02).sort()).toEqual(t02Names.sort());
    expect(t01["ASIN"]).toBe(packet.asin);
    expect(t02["研究包哈希"]).toBe(packet.packetHash);
    expect(typeof t02["风险覆盖情况"]).toBe("string");
    expect(t02).not.toHaveProperty("AI 解读");
  });

  it("rejects cross-subject ProductFact/Packet combinations", () => {
    const { productFact, packet } = setup();
    expect(() => mapProductFactToV5HubFields({
      productFact: { ...productFact, subjectKey: "other" }, packet, projectedAt: "2026-09-28T00:00:00.000Z",
    })).toThrow("V5_HUB_PRODUCT_IDENTITY_MISMATCH");
  });

  it("projects only a current Research-bound T05 concept and keeps decision inputs out of projection", () => {
    const binding: ProductConceptSourceBinding = {
      sourceType: "research_v5",
      subjectKey: "amazon:US:B0GATEWAY1",
      researchTaskId: "task-concept-test",
      researchRevision: 3,
      reportHash: "a".repeat(64),
      factHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      generatedAt: "2026-09-27T00:00:00.000Z",
    };
    const concept: ProductConceptSnapshot = {
      schemaVersion: "product-concept.v1",
      status: "READY",
      conceptId: "pcv5_test",
      opportunityId: null,
      sourceBinding: binding,
      revision: 2,
      generatedAt: "2026-09-27T00:00:00.000Z",
      targetCustomer: "户外露营用户",
      useCases: ["露营照明"],
      primaryPainPoints: ["亮度不足"],
      recommendedSpecs: ["可调亮度"],
      differentiation: ["便携设计"],
      targetPriceRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
      targetCostRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
      marginAssumptions: null,
      packagingDirection: [],
      supplierFeasibility: null,
      complianceRequirements: [],
      risks: ["缺少供应商验证"],
      missingValidation: ["需获取成本证据"],
      factRefs: [],
      researchRefs: [],
      assumptions: [],
      confirmedFacts: ["当前标题有来源绑定"],
      derived: [],
      missing: ["成本"],
      aiSummary: "需进一步验证",
      model: "local-research-v5-adapter-v1",
      humanDecision: { status: "UNREVIEWED", reason: null, decidedAt: null, revision: 0 },
      traceableItems: [{
        id: "pci_test",
        kind: "research_summary",
        text: "有证据的研究摘要",
        nature: "derived",
        evidenceRefs: ["attachment:att-concept"],
        validationRequired: true,
      }],
    };
    const fields = mapProductConceptToV5HubFields({
      concept,
      taskId: binding.researchTaskId,
      currentBinding: binding,
      expectedPacketHash: "d".repeat(64),
      projectedAt: "2026-09-28T00:00:00.000Z",
    });
    expect(fields).toMatchObject({
      "主体键": binding.subjectKey,
      "任务 ID": binding.researchTaskId,
      "修订版本": 2,
      "报告哈希": binding.reportHash,
      "事实哈希": binding.factHash,
      "证据哈希": binding.evidenceHash,
      "预期研究包哈希": "d".repeat(64),
      "证据引用": JSON.stringify(["attachment:att-concept"]),
    });
    expect(fields["人工决策状态"]).toBe("未审核");
    expect(fields).not.toHaveProperty("决策备注");
    const visibleDecisionLabels = [
      ["APPROVE", "通过"],
      ["VALIDATE_MORE", "需补充验证"],
      ["PAUSE", "暂缓"],
      ["DROP", "放弃"],
    ] as const;
    for (const [status, label] of visibleDecisionLabels) {
      const localizedFields = mapProductConceptToV5HubFields({
        concept: { ...concept, humanDecision: { status, reason: null, decidedAt: null, revision: 0 } },
        taskId: binding.researchTaskId,
        currentBinding: binding,
        expectedPacketHash: "d".repeat(64),
        projectedAt: "2026-09-28T00:00:00.000Z",
      });
      expect(localizedFields["人工决策状态"]).toBe(label);
    }
    expect(() => mapProductConceptToV5HubFields({
      concept,
      taskId: binding.researchTaskId,
      currentBinding: { ...binding, reportHash: "e".repeat(64) },
      expectedPacketHash: "d".repeat(64),
      projectedAt: "2026-09-28T00:00:00.000Z",
    })).toThrow("V5_HUB_CONCEPT_SOURCE_BINDING_INVALID");
  });

  it("projects only valid V3 keyword evidence and preserves estimate provenance and stable identity", () => {
    const subjectKey = "amazon:US:B0GATEWAY1";
    const makeAttachment = (input: {
      readonly id: string;
      readonly status: "VALIDATED_AVAILABLE" | "PLAN_LIMITATION";
      readonly subjectKey?: string;
      readonly keyword: string;
      readonly volume: number;
      readonly capturedAt?: string;
    }) => {
      const evidence = buildV3ModuleEvidence({
        module: "reverse_asin",
        subjectKey: input.subjectKey ?? subjectKey,
        capturedAt: input.capturedAt ?? "2026-09-26T08:00:00.000Z",
        provider: "SellerSprite",
        sourceSurface: "visible keyword table",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
        acquisitionMode: "DOM_DIRECT",
        metricNature: "provider_observed",
        status: input.status,
        limitations: input.status === "PLAN_LIMITATION" ? ["export:PLAN_LIMITATION"] : [],
        identity: { asin: input.subjectKey?.split(":")[2] ?? "B0GATEWAY1" },
        data: { rows: [{ keyword: input.keyword, monthlySearches: input.volume, rank: 1 }] },
      });
      return buildSourceEvidenceAttachment({
        attachmentId: input.id,
        subjectKey: evidence.subjectKey,
        kind: "v3_reverse_asin_v1",
        sourceType: "sellersprite_plugin",
        capturedAt: evidence.capturedAt,
        sourceUrl: evidence.sourceUrl,
        payload: evidence as unknown as Record<string, unknown>,
      });
    };
    const older = makeAttachment({
      id: "att-older", status: "VALIDATED_AVAILABLE", keyword: "real visible keyword", volume: 900,
      capturedAt: "2026-09-25T08:00:00.000Z",
    });
    const priorMonth = makeAttachment({
      id: "att-prior-month", status: "VALIDATED_AVAILABLE", keyword: "real visible keyword", volume: 777,
      capturedAt: "2026-08-31T23:30:00.000Z",
    });
    const valid = makeAttachment({ id: "att-valid", status: "VALIDATED_AVAILABLE", keyword: "real visible keyword", volume: 1234 });
    const blocked = makeAttachment({ id: "att-blocked", status: "PLAN_LIMITATION", keyword: "must not project", volume: 99 });
    const mismatched = makeAttachment({
      id: "att-mismatch", status: "VALIDATED_AVAILABLE", subjectKey: "amazon:US:B0OTHER000",
      keyword: "wrong subject", volume: 88,
    });

    const rows = mapV3KeywordAttachmentsToV5HubRows({ subjectKey, attachments: [blocked, mismatched, older, priorMonth, valid] });
    expect(rows).toHaveLength(2);
    const currentMonth = rows.find((item) => item.fields["统计周期"] === "月度（2026-09）");
    const previousMonth = rows.find((item) => item.fields["统计周期"] === "月度（2026-08）");
    expect(currentMonth?.fields).toMatchObject({
      "主体键": subjectKey,
      "关键词": "real visible keyword",
      "搜索量": 1234,
      "指标性质": "provider_estimate",
      "统计周期": "月度（2026-09）",
      "来源证据引用": JSON.stringify(["attachment:att-valid"]),
    });
    expect(previousMonth?.fields["搜索量"]).toBe(777);
    expect(currentMonth?.fields["观测时间"]).toBe(Date.parse("2026-09-26T08:00:00.000Z"));
    expect(currentMonth?.logicalKey).toContain("real visible keyword");
    expect(currentMonth?.fields["关键词数据哈希"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(rows)).not.toContain("must not project");
    expect(JSON.stringify(rows)).not.toContain("wrong subject");

    const reordered = mapV3KeywordAttachmentsToV5HubRows({ subjectKey, attachments: [priorMonth, valid, older] });
    expect(reordered).toEqual(rows);
  });

  it("fails closed when the same keyword window and capture time have conflicting source evidence", () => {
    const subjectKey = "amazon:US:B0GATEWAY1";
    const makeAttachment = (id: string, volume: number) => {
      const evidence = buildV3ModuleEvidence({
        module: "reverse_asin",
        subjectKey,
        capturedAt: "2026-09-26T08:00:00.000Z",
        provider: "SellerSprite",
        sourceSurface: "visible keyword table",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
        acquisitionMode: "DOM_DIRECT",
        metricNature: "provider_observed",
        status: "VALIDATED_AVAILABLE",
        limitations: [],
        identity: { asin: "B0GATEWAY1" },
        data: { rows: [{ keyword: "same keyword", monthlySearches: volume, rank: 1 }] },
      });
      return buildSourceEvidenceAttachment({
        attachmentId: id,
        subjectKey,
        kind: "v3_reverse_asin_v1",
        sourceType: "sellersprite_plugin",
        capturedAt: evidence.capturedAt,
        sourceUrl: evidence.sourceUrl,
        payload: evidence as unknown as Record<string, unknown>,
      });
    };
    expect(() => mapV3KeywordAttachmentsToV5HubRows({
      subjectKey,
      attachments: [makeAttachment("att-a", 100), makeAttachment("att-b", 200)],
    })).toThrow("V5_HUB_KEYWORD_SAME_WINDOW_CONFLICT");
  });

  it("projects only finalized monitoring runs with stable provenance and no AI explanation", () => {
    const subjectKey = "amazon:US:B0GATEWAY1";
    const evidenceRef = {
      subjectKey,
      module: "amazon_detail" as const,
      attachmentId: "att-monitoring-1",
      contentHash: "a".repeat(64),
      capturedAt: "2026-09-26T08:00:00.000Z",
      sourceType: "amazon_dom" as const,
      provider: "Amazon",
      acquisitionMode: "DOM_DIRECT" as const,
      metricNature: "source_observed" as const,
      rawArtifactId: "raw-monitoring-1",
      rawArtifactHash: "b".repeat(64),
    };
    const run: MonitoringRunRecord = {
      id: "run-1",
      watchTargetId: "watch-1",
      triggerType: "MANUAL",
      status: "SUCCEEDED",
      outcome: "CHANGE_DETECTED",
      startedAt: "2026-09-26T08:01:00.000Z",
      finishedAt: "2026-09-26T08:02:00.000Z",
      previousEvidenceRef: evidenceRef,
      currentEvidenceRef: { ...evidenceRef, attachmentId: "att-monitoring-2", rawArtifactId: "raw-monitoring-2" },
      changeSummary: { comparisonStatus: "CHANGE_DETECTED", diffs: [{ field: "price", before: 20, after: 18 }] },
      errorCode: null,
      errorMessage: null,
      aiExplanation: { status: "AVAILABLE", explanation: "advisory only" },
    };
    const input = { subjectKey, watchTargetId: "watch-1", run };
    const row = mapMonitoringRunToV5HubRow(input);
    expect(row).not.toBeNull();
    expect(row?.fields).toMatchObject({
      "监控目标 ID": "watch-1",
      "监控运行 ID": "run-1",
      "事件键": "CHANGE_DETECTED",
      "主体键": subjectKey,
      "运行时间": Date.parse(run.startedAt),
      "事件状态": "CHANGE_DETECTED",
      "研究包哈希": null,
      "投影时间": Date.parse(run.finishedAt!),
    });
    expect(row?.fields["证据引用"]).toContain("att-monitoring-1");
    expect(JSON.stringify(row)).not.toContain("advisory only");
    expect(mapMonitoringRunToV5HubRow(input)).toEqual(row);
    expect(mapMonitoringRunToV5HubRow({ ...input, run: { ...run, status: "RUNNING", finishedAt: null } })).toBeNull();
    expect(() => mapMonitoringRunToV5HubRow({
      ...input,
      run: { ...run, currentEvidenceRef: { ...evidenceRef, subjectKey: "amazon:US:B0OTHER000" } },
    })).toThrow("V5_HUB_MONITORING_EVIDENCE_REFERENCE_INVALID");
  });
});
