import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { createSellerSpritePreviewWorkbook } from "@/lib/upstream/sellersprite/previewTestFixtures";
import { amazonDomAdapter } from "@/lib/sourceLayer/adapters/amazonDomAdapter";
import { sellerSpriteAdapter } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import type { AuditLogEntry } from "@/lib/sourceLayer/auditLog";
import { buildCapturePackage, type CapturePackageDraft } from "@/lib/sourceLayer/capturePackage";
import {
  EvidenceStoreError,
  assertSafeOperatorDir,
  assertSafeSubjectKey,
  createEvidenceStore,
  toSafePathSegment,
} from "@/lib/sourceLayer/server/evidenceStore";
import {
  createSourceAdapter,
  type CaptureEvidenceRecord,
} from "@/lib/sourceLayer/sourceAdapter";
import { buildSourceEvidenceAttachment, sourceEvidenceAttachmentIdFor } from "@/lib/sourceLayer/evidenceAttachment";
import { buildSourceRawArtifact } from "@/lib/sourceLayer/rawArtifact";
import { validateCapturePackage, validationAuditEntries } from "@/lib/sourceLayer/validator";
import { buildTrendObservation } from "@/lib/sourceLayer/v2/contracts";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";
const NOW = new Date("2026-02-01T01:00:00.000Z");
const SUBJECT_KEY = "amazon:US:B0FH1ZXTN1";

const recordingAdapter = createSourceAdapter({
  sourceType: "manual_entry",
  label: "test adapter",
  adapterVersion: "test.v1",
  capture: () => ({ drafts: [], errorCodes: [], quarantinedCount: 0, pageDigest: "test" }),
});

function draft(overrides: { title?: string; asin?: string } = {}): CapturePackageDraft {
  return {
    subjectKey: `amazon:US:${overrides.asin ?? "B0FH1ZXTN1"}`,
    marketplace: "US",
    fields: {
      asin: { value: overrides.asin ?? "B0FH1ZXTN1", valueOrigin: "human_manual", sourceRef: "f.asin" },
      title: {
        value: overrides.title ?? "Owala FreeSip Insulated Stainless Steel Water Bottle, 24 oz",
        valueOrigin: "human_manual",
        sourceRef: "f.title",
      },
      images: {
        value: ["https://m.media-amazon.com/images/I/a.jpg", "https://m.media-amazon.com/images/I/b.jpg"],
        valueOrigin: "human_manual",
        sourceRef: "f.images",
      },
      price: { value: { amount: 29.99, currency: "USD" }, valueOrigin: "human_manual", sourceRef: "f.price" },
      rating: { value: 4.6, valueOrigin: "human_manual", sourceRef: "f.rating" },
      reviewCount: { value: 2948, valueOrigin: "human_manual", sourceRef: "f.reviews" },
      bsr: { value: { rank: 120, category: "Sports & Outdoors" }, valueOrigin: "human_manual", sourceRef: "f.bsr" },
      keywords: { value: ["water bottle"], valueOrigin: "human_manual", sourceRef: "f.keywords" },
    },
    sourceProof: {
      sourceType: "manual_entry",
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: CAPTURED_AT,
      captureMethod: "manual_form",
      operator: "owner:v1",
      sourceFingerprint: null,
      sourceRecordRef: null,
    },
    replay: { url: null, capturedAt: CAPTURED_AT, pageDigest: "manual_entry", warnings: [] },
  };
}

function evidence(input: {
  captureId: string;
  version: number;
  title?: string;
  asin?: string;
}): { evidence: CaptureEvidenceRecord; auditEntries: AuditLogEntry[] } {
  const pkg = buildCapturePackage({
    captureId: input.captureId,
    version: input.version,
    draft: draft({ title: input.title, asin: input.asin }),
  });
  const report = validateCapturePackage(pkg, { now: NOW });
  return {
    evidence: recordingAdapter.createEvidence({ pkg, report }),
    auditEntries: validationAuditEntries({
      report,
      operator: "owner:v1",
      captureId: pkg.captureId,
      subjectKey: pkg.subjectKey,
    }),
  };
}

describe("evidence store", () => {
  beforeEach(() => {
    process.env.SOURCE_LAYER_STORE_DIR = mkdtempSync(join(tmpdir(), "source-layer-store-"));
  });

  it("starts empty and lists nothing", async () => {
    const store = createEvidenceStore("owner:v1");
    expect(await store.listSubjects()).toEqual([]);
    expect(await store.getSubject(SUBJECT_KEY)).toBeNull();
  });

  it("appends versions without ever overwriting history", async () => {
    const store = createEvidenceStore("owner:v1");
    const firstPayload = evidence({ captureId: "cap-1", version: 1 });
    const first = await store.appendEvidence({
      evidence: firstPayload.evidence,
      auditEntries: firstPayload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    expect(first.version).toBe(1);
    expect(first.created).toBe(true);
    expect(first.duplicate).toBe(false);

    const secondPayload = evidence({
      captureId: "cap-2",
      version: 2,
      title: "A completely updated product title for the same ASIN",
    });
    const second = await store.appendEvidence({
      evidence: secondPayload.evidence,
      auditEntries: secondPayload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    expect(second.version).toBe(2);

    const subject = await store.getSubject(SUBJECT_KEY);
    expect(subject?.versions.map((item) => item.version)).toEqual([1, 2]);
    expect(subject?.versions[0].pkg.fields.title).toContain("Owala");
    expect(subject?.versions[1].pkg.fields.title).toContain("completely updated");
  });

  it("stores SellerSprite and Amazon Evidence independently for one subject", async () => {
    const subjectKey = "amazon:US:B07G4VTV2F";
    const sellerCapture = sellerSpriteAdapter.capture({
      payload: createSellerSpritePreviewWorkbook({
        headers: ["ASIN", "商品标题", "商品详情页链接", "商品主图", "价格($)", "评分", "评分数", "品牌", "类目路径", "月销量"],
        rows: [["B07G4VTV2F", "SellerSprite export title", "https://www.amazon.com/dp/B07G4VTV2F", "https://images.example.test/sellersprite.jpg", "$24.99", "4.6", "1044", "Example Brand", "Home & Kitchen", "321"]],
      }),
      capturedAt: CAPTURED_AT,
      operator: "owner:v1",
    });
    const sellerPkg = sellerSpriteAdapter.normalize({ draft: sellerCapture.drafts[0], captureId: "cap-multi-provider-sellersprite", version: 1 });
    const sellerValidated = sellerSpriteAdapter.validate({ pkg: sellerPkg, context: { now: NOW } });
    expect(sellerValidated.report.verdict).toBe("passed");
    expect(sellerValidated.pkg.fieldStates.estimatedMonthlySales).toMatchObject({ status: "estimated", metricNature: "estimate" });

    const store = createEvidenceStore("owner:v1");
    await store.appendEvidence({ evidence: sellerSpriteAdapter.createEvidence({ pkg: sellerValidated.pkg, report: sellerValidated.report }), auditEntries: [], operator: "owner:v1", now: NOW });

    const amazonCapture = amazonDomAdapter.capture({
      payload: {
        asin: "B07G4VTV2F", title: "Current Amazon title", productUrl: "https://www.amazon.com/dp/B07G4VTV2F",
        images: ["https://m.media-amazon.com/images/I/amazon-current.jpg"], brand: "Example Brand", price: 24.99,
        currency: "USD", rating: 4.6, reviewCount: 1046, bsrRank: 412, bsrCategory: "Home & Kitchen",
      },
      capturedAt: "2026-02-01T00:30:00.000Z",
      operator: "owner:v1",
    });
    const prior = await store.getSubject(subjectKey);
    const amazonPkg = amazonDomAdapter.normalize({ draft: amazonCapture.drafts[0], captureId: "cap-multi-provider-amazon", version: 2 });
    const amazonValidated = amazonDomAdapter.validate({ pkg: amazonPkg, context: { now: NOW, previousPackages: prior?.versions.map((record) => record.pkg) ?? [] } });
    expect(amazonValidated.report.verdict).toBe("passed");
    await store.appendEvidence({ evidence: amazonDomAdapter.createEvidence({ pkg: amazonValidated.pkg, report: amazonValidated.report }), auditEntries: [], operator: "owner:v1", now: NOW });

    const stored = await store.getSubject(subjectKey);
    expect(stored?.versions.map((record) => record.sourceType)).toEqual(["sellersprite_xlsx", "amazon_dom"]);
    expect(stored?.versions.map((record) => record.subjectKey)).toEqual([subjectKey, subjectKey]);
    expect(stored?.versions.map((record) => record.factAuthority)).toEqual(["evidence_only", "evidence_only"]);
    expect(new Set(stored?.versions.map((record) => record.contentHash)).size).toBe(2);
    expect(stored?.versions[0].pkg.fieldStates.estimatedMonthlySales.status).toBe("estimated");
    expect(stored?.versions[1].pkg.fieldStates.images.status).toBe("confirmed");
    expect(stored?.versions[1].pkg.fieldStates.title.valueOrigin).toBe("page_measured");
    expect(stored?.versions[1].pkg.fieldStates.title.sourceRef).toMatch(/^amazon_dom\./);
  });

  it("detects a duplicate submission by content hash instead of creating v3", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-1", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const again = await store.appendEvidence({
      evidence: { ...payload.evidence, captureId: "cap-1-retry" },
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    expect(again.created).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.version).toBe(1);
    const subject = await store.getSubject(SUBJECT_KEY);
    expect(subject?.versions).toHaveLength(1);
  });

  it("stores keyword/review attachments in the same EvidenceStore without creating a product version", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-attachment-base", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const draftAttachment = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: SUBJECT_KEY,
      kind: "keyword_evidence",
      sourceType: "sellersprite_xlsx",
      capturedAt: CAPTURED_AT,
      sourceFingerprint: "seller-sprite-manual-export",
      payload: {
        schema: "seller-sprite-keyword-attachment.v1",
        evidence: { rows: [{ keyword: "water bottle" }] },
      },
    });
    const attachment = buildSourceEvidenceAttachment({
      ...draftAttachment,
      attachmentId: sourceEvidenceAttachmentIdFor(draftAttachment.contentHash),
    });
    const stored = await store.appendAttachment?.({
      attachment,
      operator: "owner:v1",
      now: NOW,
    });
    expect(stored?.created).toBe(true);
    const duplicate = await store.appendAttachment?.({
      attachment: { ...attachment, attachmentId: "att-retry" },
      operator: "owner:v1",
      now: NOW,
    });
    expect(duplicate?.duplicate).toBe(true);
    const subject = await store.getSubject(SUBJECT_KEY);
    expect(subject?.versions).toHaveLength(1);
    expect(subject?.attachments).toHaveLength(1);
    expect((await store.getAudit(SUBJECT_KEY)).some((entry) => entry.eventKind === "evidence_attachment_persisted")).toBe(true);
  });

  it("retains a raw export in the same EvidenceStore and deduplicates by SHA-256", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-raw-base", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const artifact = buildSourceRawArtifact({
      subjectKey: SUBJECT_KEY,
      sourceType: "sellersprite_xlsx",
      kind: "market_export",
      capturedAt: CAPTURED_AT,
      fileName: "market.xlsx",
      bytes,
      provenance: {
        provider: "SellerSprite",
        sourceSurface: "search-results-export",
        sourceUrl: "https://www.sellersprite.com/",
        sourceRecordRef: "sheet=US;row=2",
        providerUpdatedAt: null,
        acquisitionMode: "file_upload",
        parserVersion: "sellersprite-adapter.v1",
      },
    });
    const first = await store.appendRawArtifact?.({ artifact, bytes, operator: "owner:v1", now: NOW });
    const duplicate = await store.appendRawArtifact?.({ artifact, bytes, operator: "owner:v1", now: NOW });
    expect(first?.created).toBe(true);
    expect(duplicate?.duplicate).toBe(true);
    expect((await store.getSubject(SUBJECT_KEY))?.rawArtifacts).toEqual([artifact]);
    expect((await store.getAudit(SUBJECT_KEY)).some((entry) => entry.eventType === "raw_artifact_persisted")).toBe(true);
  });

  it("stores trend observations append-only in the same EvidenceStore with daily dedupe", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-trend-base", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const observation = buildTrendObservation({
      observationId: "trend-1",
      subjectKey: SUBJECT_KEY,
      field: "bsr",
      value: 12,
      valueKind: "observed",
      sourceType: "manual_entry",
      capturedAt: CAPTURED_AT,
      evidenceRefs: [payload.evidence.evidenceId],
    });
    const first = await store.appendTrendObservation?.({ observation, operator: "owner:v1", now: NOW });
    const duplicate = await store.appendTrendObservation?.({
      observation: { ...observation, observationId: "trend-retry" },
      operator: "owner:v1",
      now: NOW,
    });
    expect(first?.created).toBe(true);
    expect(duplicate?.duplicate).toBe(true);
    expect((await store.listTrendObservations?.(SUBJECT_KEY))?.length).toBe(1);
    expect((await store.getSubject(SUBJECT_KEY))?.versions).toHaveLength(1);
  });

  it("keeps an append-only audit timeline per subject", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-1", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const audit = await store.getAudit(SUBJECT_KEY);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((entry) => entry.eventKind === "evidence_persisted")).toBe(true);
    expect(audit.some((entry) => entry.eventKind === "validation_result")).toBe(true);
  });

  it("keeps blocking errors traceable in the audit timeline", async () => {
    const store = createEvidenceStore("owner:v1");
    const base = draft();
    const pkg = buildCapturePackage({
      captureId: "cap-blocked",
      version: 1,
      draft: {
        ...base,
        fields: {
          ...base.fields,
          title: { value: null, valueOrigin: "human_manual", sourceRef: "f.title" },
        },
      },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    await store.appendEvidence({
      evidence: recordingAdapter.createEvidence({ pkg, report }),
      auditEntries: validationAuditEntries({
        report,
        operator: "owner:v1",
        captureId: pkg.captureId,
        subjectKey: pkg.subjectKey,
      }),
      operator: "owner:v1",
      now: NOW,
    });
    const audit = await store.getAudit(SUBJECT_KEY);
    expect(audit.some((entry) => entry.errorCode === "FIELD_MISSING")).toBe(true);
    const stored = await store.getSubject(SUBJECT_KEY);
    expect(stored?.versions[0].validation.verdict).toBe("blocked");
    expect(stored?.versions[0].validation.readyForResearch).toBe(false);
  });

  it("isolates subjects by access subject (owner never writes into a visitor directory)", async () => {
    const ownerStore = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-1", version: 1 });
    await ownerStore.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const visitorStore = createEvidenceStore("visitor:abc123");
    expect(await visitorStore.listSubjects()).toEqual([]);
    expect(await visitorStore.getSubject(SUBJECT_KEY)).toBeNull();
  });

  // ── F-03 跨主体证据隔离：上游契约级证明（PH4_F03_CROSS_SUBJECT_GUARD） ──────
  // 该测试不依赖任何 mock，直接走真实 EvidenceStore 落盘 / 读取路径，
  // 证明「同一 operator 下不同 subjectKey 的证据绝不会互相混入」。
  it("never returns another subject's attachments or versions from getSubject (cross-subject isolation)", async () => {
    const store = createEvidenceStore("owner:v1");
    const otherSubjectKey = "amazon:US:B000000002";
    const otherAsin = "B000000002";

    // 主体 A（SUBJECT_KEY）落一个版本 + 一个 review 附件
    const payloadA = evidence({ captureId: "cap-iso-a", version: 1 });
    await store.appendEvidence({ ...payloadA, operator: "owner:v1", now: NOW });
    const draftA = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: SUBJECT_KEY,
      kind: "review_evidence",
      sourceType: "manual_entry",
      capturedAt: CAPTURED_AT,
      sourceFingerprint: "cross-subject-isolation-a",
      payload: { schema: "review-evidence.v1", asin: "B0FH1ZXTN1", reviews: [{ title: "A review", reviewText: "body from subject A" }] },
    });
    const attachmentA = buildSourceEvidenceAttachment({
      ...draftA,
      attachmentId: sourceEvidenceAttachmentIdFor(draftA.contentHash),
    });
    await store.appendAttachment?.({ attachment: attachmentA, operator: "owner:v1", now: NOW });

    // 主体 B（otherSubjectKey）落另一个版本 + 一个 review 附件（文本可完全相同）
    const payloadB = evidence({ captureId: "cap-iso-b", version: 1, asin: otherAsin });
    await store.appendEvidence({ ...payloadB, operator: "owner:v1", now: NOW });
    const draftB = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: otherSubjectKey,
      kind: "review_evidence",
      sourceType: "manual_entry",
      capturedAt: CAPTURED_AT,
      sourceFingerprint: "cross-subject-isolation-b",
      payload: { schema: "review-evidence.v1", asin: otherAsin, reviews: [{ title: "A review", reviewText: "body from subject A" }] },
    });
    const attachmentB = buildSourceEvidenceAttachment({
      ...draftB,
      attachmentId: sourceEvidenceAttachmentIdFor(draftB.contentHash),
    });
    await store.appendAttachment?.({ attachment: attachmentB, operator: "owner:v1", now: NOW });

    // 读取主体 A：只能看到 A 的版本与附件，绝无 B 的任何记录
    const subjectA = await store.getSubject(SUBJECT_KEY);
    expect(subjectA).not.toBeNull();
    expect(subjectA!.subjectKey).toBe(SUBJECT_KEY);
    expect(subjectA!.versions).toHaveLength(1);
    expect(subjectA!.versions.every((record) => record.subjectKey === SUBJECT_KEY)).toBe(true);
    expect(subjectA!.attachments ?? []).toHaveLength(1);
    expect((subjectA!.attachments ?? []).every((item) => item.subjectKey === SUBJECT_KEY)).toBe(true);
    expect((subjectA!.attachments ?? []).some((item) => item.subjectKey === otherSubjectKey)).toBe(false);
    // 附件级精确断言：只出现 A 的 attachmentId + contentHash，B 的绝不出现
    expect((subjectA!.attachments ?? []).map((item) => item.attachmentId)).toEqual([attachmentA.attachmentId]);
    expect((subjectA!.attachments ?? []).some((item) => item.attachmentId === attachmentB.attachmentId)).toBe(false);
    expect((subjectA!.attachments ?? []).every((item) => item.contentHash === attachmentA.contentHash)).toBe(true);

    // 反向对称：读取主体 B 只看到 B 的记录
    const subjectB = await store.getSubject(otherSubjectKey);
    expect(subjectB).not.toBeNull();
    expect(subjectB!.subjectKey).toBe(otherSubjectKey);
    expect(subjectB!.attachments).toHaveLength(1);
    expect(subjectB!.attachments!.map((item) => item.attachmentId)).toEqual([attachmentB.attachmentId]);
    expect(subjectB!.attachments!.some((item) => item.attachmentId === attachmentA.attachmentId)).toBe(false);

    // 两主体附件 contentHash 必然不同（否则落盘也会被主体隔离在各自目录）
    expect(attachmentA.contentHash).not.toBe(attachmentB.contentHash);

    // 目录结构级证明：两个主体落在各自的 subjects/<encoded> 目录
    const { resolve } = await import("node:path");
    const root = process.env.SOURCE_LAYER_STORE_DIR as string;
    const dirA = resolve(root, "owner-v1", "subjects", "amazon%3AUS%3AB0FH1ZXTN1");
    const dirB = resolve(root, "owner-v1", "subjects", "amazon%3AUS%3AB000000002");
    const filesA = readdirSync(dirA);
    const filesB = readdirSync(dirB);
    expect(filesA).toContain(`a-${attachmentA.contentHash}.json`);
    expect(filesA).not.toContain(`a-${attachmentB.contentHash}.json`);
    expect(filesB).toContain(`a-${attachmentB.contentHash}.json`);
    expect(filesB).not.toContain(`a-${attachmentA.contentHash}.json`);
  });

  it("fails closed when a subject-mismatched attachment file is planted in a subject directory", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-iso-plant", version: 1 });
    await store.appendEvidence({ ...payload, operator: "owner:v1", now: NOW });
    const draft = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: SUBJECT_KEY,
      kind: "review_evidence",
      sourceType: "manual_entry",
      capturedAt: CAPTURED_AT,
      sourceFingerprint: "cross-subject-plant",
      payload: { schema: "review-evidence.v1", asin: "B0FH1ZXTN1", reviews: [{ title: "t", reviewText: "b" }] },
    });
    const attachment = buildSourceEvidenceAttachment({
      ...draft,
      attachmentId: sourceEvidenceAttachmentIdFor(draft.contentHash),
    });
    // 直接落盘的「合法」附件属于 SUBJECT_KEY
    await store.appendAttachment?.({ attachment, operator: "owner:v1", now: NOW });

    // 恶意/错误：把同一份附件内容的 subjectKey 改成另一个主体，手工写进主体 A 的目录
    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const forgedSubjectKey = "amazon:US:B000000002";
    const forged = { ...attachment, subjectKey: forgedSubjectKey };
    const target = resolve(
      process.env.SOURCE_LAYER_STORE_DIR as string,
      "owner-v1",
      "subjects",
      "amazon%3AUS%3AB0FH1ZXTN1",
      `a-${forged.contentHash}.json`,
    );
    writeFileSync(target, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

    // 读取主体 A 必须 fail-closed：异主体附件绝不作为本主体证据返回；
    // readAttachments 将主体不匹配记为 integrityIssues 并丢弃该文件（不中断其他健康证据读取）。
    const subjectA = await store.getSubject(SUBJECT_KEY);
    expect(subjectA).not.toBeNull();
    // 关键不变量：绝无任何异主体附件被当作本主体证据返回
    expect((subjectA!.attachments ?? []).every((item) => item.subjectKey === SUBJECT_KEY)).toBe(true);
    expect((subjectA!.attachments ?? []).some((item) => item.subjectKey === forgedSubjectKey)).toBe(false);
    // 不一致被记录为可追溯的完整性事件（fail-closed 证据）
    expect(subjectA!.integrityIssues ?? []).not.toHaveLength(0);
    expect((subjectA!.integrityIssues ?? []).some((issue) => issue.code === "evidence_store_invalid")).toBe(true);
  });

  it("updates the index with latest version, verdict and title", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-1", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const subjects = await store.listSubjects();
    expect(subjects).toHaveLength(1);
    expect(subjects[0].latestVersion).toBe(1);
    expect(subjects[0].latestVerdict).toBe("passed");
    expect(subjects[0].asin).toBe("B0FH1ZXTN1");
    expect(subjects[0].displayTitle).toContain("Owala");
  });

  it("maps access subjects and identity keys to filesystem-safe names", () => {
    expect(() => assertSafeSubjectKey("../../etc/passwd")).toThrow(EvidenceStoreError);
    expect(() => assertSafeSubjectKey("a/b")).toThrow(EvidenceStoreError);
    expect(() => assertSafeSubjectKey("a\\b")).toThrow(EvidenceStoreError);
    expect(() => assertSafeSubjectKey("")).toThrow(EvidenceStoreError);
    expect(assertSafeOperatorDir("owner:v1")).toBe("owner-v1");
    expect(assertSafeOperatorDir("visitor:ABC 123")).toBe("visitor-abc-123");
    expect(() => assertSafeOperatorDir("..")).toThrow(EvidenceStoreError);
    expect(assertSafeOperatorDir("../../etc")).toBe("etc");
    expect(assertSafeOperatorDir("visitor:abc123")).not.toContain(":");
    expect(toSafePathSegment(SUBJECT_KEY)).toBe("amazon%3AUS%3AB0FH1ZXTN1");
    expect(toSafePathSegment(SUBJECT_KEY)).not.toContain(":");
    expect(toSafePathSegment("a%b")).toBe("a%25b");
    expect(toSafePathSegment(".")).toBe("%2E");
    expect(toSafePathSegment("..")).toBe("%2E%2E");
    expect(toSafePathSegment("%2E%2E")).toBe("%252E%252E");
    const escaped = toSafePathSegment(SUBJECT_KEY);
    expect(escaped).not.toContain("/");
    expect(escaped).not.toContain("\\");
    expect(escaped).not.toContain("..");
  });

  it("rejects an incoming package with a forged hash or invalid evidence ID before publishing a subject", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-forged", version: 1 });
    await expect(store.appendEvidence({ evidence: { ...payload.evidence, contentHash: "a".repeat(64) }, auditEntries: [], operator: "owner:v1", now: NOW }))
      .rejects.toMatchObject({ code: "evidence_content_hash_mismatch" });
    await expect(store.appendEvidence({ evidence: { ...payload.evidence, evidenceId: "wrong-id" }, auditEntries: [], operator: "owner:v1", now: NOW }))
      .rejects.toMatchObject({ code: "evidence_id_invalid" });
    expect(await store.listSubjects()).toEqual([]);
  });

  it("isolates valid-JSON tampering, bad attachments and raw metadata; reads retain healthy evidence without writing", async () => {
    const store = createEvidenceStore("owner:v1");
    for (const version of [1, 2]) {
      const payload = evidence({ captureId: `cap-isolation-${version}`, version, title: `Healthy product title version ${version}` });
      await store.appendEvidence({ ...payload, operator: "owner:v1", now: NOW });
    }
    const dir = join(process.env.SOURCE_LAYER_STORE_DIR!, "owner-v1", "subjects", toSafePathSegment(SUBJECT_KEY));
    const latest = JSON.parse(readFileSync(join(dir, "v0002.json"), "utf8"));
    latest.pkg.fields.title = "Valid JSON with changed content and original hash";
    writeFileSync(join(dir, "v0002.json"), JSON.stringify(latest));
    writeFileSync(join(dir, `a-${"a".repeat(64)}.json`), "{broken");
    writeFileSync(join(dir, `r-${"b".repeat(64)}.meta.json`), "{broken");
    const before = Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]));
    const subject = await store.getSubject(SUBJECT_KEY);
    expect(subject!.versions.map((version) => version.version)).toEqual([1]);
    expect(subject!.integrityIssues).toEqual(expect.arrayContaining([
      { fileName: "v0002.json", code: "evidence_content_hash_mismatch" },
      { fileName: `a-${"a".repeat(64)}.json`, code: "evidence_store_invalid" },
      { fileName: `r-${"b".repeat(64)}.meta.json`, code: "evidence_store_invalid" },
    ]));
    expect(Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]))).toEqual(before);
    const next = evidence({ captureId: "cap-isolation-3", version: 3, title: "New healthy evidence after corruption" });
    const appended = await store.appendEvidence({ ...next, operator: "owner:v1", now: NOW });
    expect(appended.version).toBe(3);
    expect(readFileSync(join(dir, "v0002.json"), "utf8")).toBe(before["v0002.json"]);
  });

  it("records pruned versions in the existing audit before enforcing the twenty-version limit", async () => {
    const store = createEvidenceStore("owner:v1");
    for (let version = 1; version <= 21; version++) {
      const payload = evidence({ captureId: `cap-prune-${version}`, version, title: `Distinct observed product title ${version}` });
      await store.appendEvidence({ ...payload, operator: "owner:v1", now: NOW });
    }
    const subject = await store.getSubject(SUBJECT_KEY);
    expect(subject!.versions.map((item) => item.version)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
    const pruning = (await store.getAudit(SUBJECT_KEY)).find((entry) => entry.eventType === "evidence_versions_pruned");
    expect(pruning).toMatchObject({ severity: "warning", detail: { prunedVersions: "1", incomingVersion: 21 } });
  });

  it("fails closed when the persisted version file is corrupted", async () => {
    const store = createEvidenceStore("owner:v1");
    const payload = evidence({ captureId: "cap-1", version: 1 });
    await store.appendEvidence({
      evidence: payload.evidence,
      auditEntries: payload.auditEntries,
      operator: "owner:v1",
      now: NOW,
    });
    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const file = resolve(
      process.env.SOURCE_LAYER_STORE_DIR as string,
      "owner-v1",
      "subjects",
      "amazon%3AUS%3AB0FH1ZXTN1",
      "v0001.json",
    );
    writeFileSync(file, "{ not json", "utf8");
    await expect(store.getSubject(SUBJECT_KEY)).rejects.toThrow(EvidenceStoreError);
  });
});
