import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-03 跨主体证据隔离 — 真实上游契约级端到端测试（PH4_F03_CROSS_SUBJECT_GUARD）
 *
 * 与 f03DualPathRepair.test.ts 的区别：
 *   该文件用 **mock** 模拟 EvidenceStore；本文件**不 mock EvidenceStore**，
 *   而是使用**真实 EvidenceStore**（真实落盘 + 真实 getSubject），端到端驱动
 *   正式 Research Engine（buildResearchEngineInput）与正式 Bundle
 *   （buildResearchInputBundle），证明「异主体评论绝不进入当前商品 Research 消费结果」。
 *
 * 这样可严格区分：
 *   - EvidenceStore 的真实主体隔离（本文件：真实 store）
 *   - Engine / Bundle 的实际消费输出（本文件：真实消费路径）
 *   - mock 模拟的异常数据（f03DualPathRepair.test.ts：仅用于定位下游行为边界）
 *
 * 仅 mock Prisma（任务/候选读取），因为这两个对象不属于 EvidenceStore 契约范围。
 */

const mocks = vi.hoisted(() => ({
  prismaFindTask: vi.fn(),
  prismaFindCandidate: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: { findUnique: mocks.prismaFindTask },
    opportunityCandidate: { findUnique: mocks.prismaFindCandidate },
  },
}));

import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import { buildSourceEvidenceAttachment, sourceEvidenceAttachmentIdFor } from "@/lib/sourceLayer/evidenceAttachment";

const CURRENT_ASIN = "B0F03CUR01";
const CURRENT_SUBJECT = `amazon:US:${CURRENT_ASIN}`;
const FOREIGN_ASIN = "B0F03FOR02";
const FOREIGN_SUBJECT = `amazon:US:${FOREIGN_ASIN}`;
const CAPTURED_AT = "2026-09-26T08:20:00.000Z";
const FACT_CAPTURED_AT = "2026-09-20T00:00:00.000Z";
const OPERATOR = "owner:v1";

/** 构造一个可通过门禁的真实证据载体（manual_entry），并返回其 ProductFact 与 evidence。 */
function realEvidenceFor(asin: string, captureId: string) {
  const captured = manualEntryAdapter.capture({
    payload: {
      asin,
      title: `Product ${asin}`,
      productUrl: `https://www.amazon.com/dp/${asin}`,
      images: ["https://images.example.test/p.jpg"],
      brand: "EcoWood",
      price: 29.99,
      rating: 4.8,
      reviewCount: 120,
      bsrRank: 1200,
      bsrCategory: "Kitchen",
    },
    capturedAt: FACT_CAPTURED_AT,
    operator: OPERATOR,
  });
  const pkg = manualEntryAdapter.normalize({ draft: captured.drafts[0], captureId, version: 1 });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: FACT_CAPTURED_AT } });
  const evidence = manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
  return { evidence, productFact: adaptEvidenceToProductFact({ evidence }) };
}

/** 构造 legacy review_evidence 附件（走真实 buildSourceEvidenceAttachment）。 */
function legacyReviewAttachment(input: {
  readonly subjectKey: string;
  readonly asin: string;
  readonly fingerprint: string;
  readonly rows: readonly Record<string, unknown>[];
}) {
  const draft = buildSourceEvidenceAttachment({
    attachmentId: "pending",
    subjectKey: input.subjectKey,
    kind: "review_evidence",
    sourceType: "manual_entry",
    capturedAt: CAPTURED_AT,
    sourceFingerprint: input.fingerprint,
    payload: { schema: "review-evidence.v1", asin: input.asin, reviews: input.rows },
  });
  return buildSourceEvidenceAttachment({
    ...draft,
    attachmentId: sourceEvidenceAttachmentIdFor(draft.contentHash),
  });
}

function reviewRows(asin: string, count: number, label: string) {
  return Array.from({ length: count }, (_, index) => ({
    asin,
    rating: 4,
    reviewDate: `2026-09-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    reviewText: `Review body ${label}-${index + 1}.`,
    title: `Review title ${label}-${index + 1}`,
    verifiedPurchase: true,
  }));
}

function wireTaskWith(fact: unknown, taskId: string, candidateId: string) {
  mocks.prismaFindTask.mockResolvedValue({
    id: taskId,
    updatedAt: new Date(CAPTURED_AT),
    resultJson: JSON.stringify({ candidateToTask: { candidateId } }),
  });
  mocks.prismaFindCandidate.mockResolvedValue({
    id: candidateId,
    convertedTaskId: taskId,
    sourceMetaJson: JSON.stringify({ productFact: fact }),
  });
}

describe("F-03 跨主体证据隔离（真实 EvidenceStore 端到端）", () => {
  beforeEach(() => {
    process.env.SOURCE_LAYER_STORE_DIR = mkdtempSync(join(tmpdir(), "f03-cross-subject-"));
    mocks.prismaFindTask.mockReset();
    mocks.prismaFindCandidate.mockReset();
  });

  it("当前主体的合法 legacy 与另一主体的相似 legacy 并存时，当前 Research 只消费当前主体评论", async () => {
    const store = createEvidenceStore(OPERATOR);

    // 当前主体：真实证据 + 真实 legacy review 附件（3 条）
    const current = realEvidenceFor(CURRENT_ASIN, "cap-current");
    await store.appendEvidence({ evidence: current.evidence, auditEntries: [], operator: OPERATOR, now: new Date(CAPTURED_AT) });
    const currentRows = reviewRows(CURRENT_ASIN, 3, "current");
    const currentAttachment = legacyReviewAttachment({
      subjectKey: CURRENT_SUBJECT,
      asin: CURRENT_ASIN,
      fingerprint: "f03-cross-current",
      rows: currentRows,
    });
    await store.appendAttachment?.({ attachment: currentAttachment, operator: OPERATOR, now: new Date(CAPTURED_AT) });

    // 另一主体：真实证据 + 真实 legacy review 附件（文本刻意与当前主体相似/相同）
    const foreign = realEvidenceFor(FOREIGN_ASIN, "cap-foreign");
    await store.appendEvidence({ evidence: foreign.evidence, auditEntries: [], operator: OPERATOR, now: new Date(CAPTURED_AT) });
    const foreignRows = currentRows.map((row) => ({ ...row, asin: FOREIGN_ASIN }));
    const foreignAttachment = legacyReviewAttachment({
      subjectKey: FOREIGN_SUBJECT,
      asin: FOREIGN_ASIN,
      fingerprint: "f03-cross-foreign",
      rows: foreignRows,
    });
    await store.appendAttachment?.({ attachment: foreignAttachment, operator: OPERATOR, now: new Date(CAPTURED_AT) });

    // 通过真实 getSubject 复核：两主体各自只拿到自己的附件
    const currentSubject = await store.getSubject(CURRENT_SUBJECT);
    const foreignSubject = await store.getSubject(FOREIGN_SUBJECT);
    expect(currentSubject?.attachments?.map((item) => item.attachmentId)).toEqual([currentAttachment.attachmentId]);
    expect(foreignSubject?.attachments?.map((item) => item.attachmentId)).toEqual([foreignAttachment.attachmentId]);
    expect(currentSubject?.attachments?.some((item) => item.subjectKey === FOREIGN_SUBJECT)).toBe(false);

    // 端到端：以当前主体作为 Research 对象
    wireTaskWith(current.productFact, "task-cross", "cand-cross");
    const engineInput = await buildResearchEngineInput({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-cross",
    });

    // 当前主体的合法 legacy 必须被消费
    const consumedCurrent = engineInput.sourceEvidenceRefs.filter(
      (ref) => ref.refId === `attachment:${currentAttachment.attachmentId}`,
    );
    expect(consumedCurrent).toHaveLength(1);
    expect(consumedCurrent.every((ref) => ref.subjectKey === CURRENT_SUBJECT)).toBe(true);

    // 异主体附件：绝不消费、绝不引用、绝不重标
    const consumedForeign = engineInput.sourceEvidenceRefs.filter(
      (ref) => ref.refId === `attachment:${foreignAttachment.attachmentId}`,
    );
    expect(consumedForeign).toHaveLength(0);
    expect(
      (engineInput.reviewEvidenceSummary ?? []).some(
        (item) => item.refId === `attachment:${foreignAttachment.attachmentId}`,
      ),
    ).toBe(false);
    expect(
      engineInput.sourceEvidenceRefs.some(
        (ref) => ref.refId === `attachment:${foreignAttachment.attachmentId}` && ref.subjectKey === CURRENT_SUBJECT,
      ),
    ).toBe(false);

    // 当前主体消费样本总数 == 当前主体附件行数（异主体 3 条不得混入）
    const sampleCount = (engineInput.reviewEvidenceSummary ?? []).reduce(
      (sum, item) => sum + item.sampleReviews.length,
      0,
    );
    expect(sampleCount).toBe(3);
  });

  it("Bundle 路径同样不消费异主体附件（当前主体 allowedEvidenceRefs 只含本主体附件）", async () => {
    const store = createEvidenceStore(OPERATOR);
    const current = realEvidenceFor(CURRENT_ASIN, "cap-current-b");
    await store.appendEvidence({ evidence: current.evidence, auditEntries: [], operator: OPERATOR, now: new Date(CAPTURED_AT) });
    const currentAttachment = legacyReviewAttachment({
      subjectKey: CURRENT_SUBJECT,
      asin: CURRENT_ASIN,
      fingerprint: "f03-cross-current-b",
      rows: reviewRows(CURRENT_ASIN, 2, "currentb"),
    });
    await store.appendAttachment?.({ attachment: currentAttachment, operator: OPERATOR, now: new Date(CAPTURED_AT) });

    const foreign = realEvidenceFor(FOREIGN_ASIN, "cap-foreign-b");
    await store.appendEvidence({ evidence: foreign.evidence, auditEntries: [], operator: OPERATOR, now: new Date(CAPTURED_AT) });
    const foreignAttachment = legacyReviewAttachment({
      subjectKey: FOREIGN_SUBJECT,
      asin: FOREIGN_ASIN,
      fingerprint: "f03-cross-foreign-b",
      rows: reviewRows(FOREIGN_ASIN, 5, "foreignb"),
    });
    await store.appendAttachment?.({ attachment: foreignAttachment, operator: OPERATOR, now: new Date(CAPTURED_AT) });

    wireTaskWith(current.productFact, "task-cross-b", "cand-cross-b");
    const bundle = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-cross-b",
    });

    // Bundle 的 reviewEvidence 只应含当前主体附件
    expect(bundle.reviewEvidence.map((item) => item.attachmentId)).toEqual([currentAttachment.attachmentId]);
    expect(bundle.reviewEvidence.some((item) => item.attachmentId === foreignAttachment.attachmentId)).toBe(false);

    // allowlist refs 中不得出现异主体附件
    const foreignRefs = bundle.sourceEvidenceRefs.filter(
      (ref) => ref.refId === `attachment:${foreignAttachment.attachmentId}`,
    );
    expect(foreignRefs).toHaveLength(0);
    // 所有 attachment 类 ref 的 subjectKey 恒为当前主体
    expect(
      bundle.sourceEvidenceRefs
        .filter((ref) => ref.refId.startsWith("attachment:"))
        .every((ref) => ref.subjectKey === CURRENT_SUBJECT),
    ).toBe(true);
  });
});
