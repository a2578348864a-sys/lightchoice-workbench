import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-03 双路径专项回归测试（PH4_F03_DUAL_PATH_REPAIR）
 *
 * 目标：证明 Canonical VOC / V3 Review / Legacy Review 不会在两条正式 Research 消费路径中
 * 重复计入，同时保留真正独立的合法评论。
 *
 * 路径 A：buildResearchInputBundle → customerVoiceEvidence / reviewEvidence / sourceEvidenceRefs
 * 路径 B：buildResearchEngineInput → attachReviewEvidenceRefsFromStore → reviewEvidenceSummary /
 *         sourceEvidenceRefs
 *
 * 本文件独立于 researchInputBundle.test.ts，聚焦 Engine 路径（路径 B）的重复消费复现与修复验证。
 * 复用与现有测试一致的 mock 骨架，避免触碰真实 EvidenceStore。
 */

const mocks = vi.hoisted(() => ({
  prismaFindTask: vi.fn(),
  prismaFindCandidate: vi.fn(),
  getSubject: vi.fn(),
  recordDiagnosticEvent: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: { findUnique: mocks.prismaFindTask },
    opportunityCandidate: { findUnique: mocks.prismaFindCandidate },
  },
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({ getSubject: mocks.getSubject })),
}));

vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { buildCustomerVoiceAttachmentPayload, buildCustomerVoiceObservation } from "@/lib/sourceLayer/customerVoice";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";

const SUBJECT_KEY = "amazon:US:B000000001";
const ASIN = "B000000001";
const CAPTURED_AT = "2026-09-26T08:20:00.000Z";
const FACT_CAPTURED_AT = "2026-09-20T00:00:00.000Z";

/** 与 researchInput.test.ts 同源的真实证据构造，确保通过 readVerifiedCandidateFact 门禁。 */
function fixtureEvidence() {
  const captured = manualEntryAdapter.capture({
    payload: {
      asin: ASIN,
      title: "Bamboo Cutting Board",
      productUrl: `https://www.amazon.com/dp/${ASIN}`,
      images: ["https://images.example.test/board.jpg"],
      brand: "EcoWood",
      price: 29.99,
      rating: 4.8,
      reviewCount: 120,
      bsrRank: 1200,
      bsrCategory: "Kitchen",
    },
    capturedAt: FACT_CAPTURED_AT,
    operator: "owner:v1",
  });
  const pkg = manualEntryAdapter.normalize({ draft: captured.drafts[0], captureId: "cap-1", version: 1 });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: FACT_CAPTURED_AT } });
  return manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}

/** 真实契约下的可比较行（legacy 与 v3 共享同一批身份字段）。 */
function reviewRows(count = 13) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      asin: ASIN,
      rating: n === 1 ? 5 : 4,
      reviewDate: `2026-09-${String((n % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
      reviewText: `Review body number ${n} for the same physical review.`,
      title: `Review title ${n}`,
      verifiedPurchase: true,
    };
  });
}

/** legacy review_evidence 附件。 */
function legacyReviewAttachment(rows: readonly unknown[], attachmentId = "legacy-review-1") {
  return {
    attachmentId,
    kind: "review_evidence" as const,
    subjectKey: SUBJECT_KEY,
    capturedAt: CAPTURED_AT,
    contentHash: "l".repeat(64),
    sourceUrl: null,
    payload: { schema: "review-evidence.v1", asin: ASIN, reviews: rows },
  };
}

/** v3_review_voc_v1 附件（同一批行）。 */
function v3ReviewAttachment(rows: readonly unknown[], attachmentId = "v3-review-1") {
  return {
    attachmentId,
    kind: "v3_review_voc_v1" as const,
    subjectKey: SUBJECT_KEY,
    capturedAt: CAPTURED_AT,
    contentHash: "v".repeat(64),
    sourceUrl: null,
    payload: buildV3ModuleEvidence({
      module: "review_voc",
      subjectKey: SUBJECT_KEY,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "amazon",
      sourceSurface: "synthetic_test_fixture",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "source_observed",
      status: "VALIDATED_AVAILABLE",
      limitations: ["public_top_reviews_only"],
      identity: { asin: ASIN },
      data: { reviews: rows },
      evidenceOnly: true,
    }),
  };
}

/** canonical customer_voice_observation_v1 附件，provenance.sourceAttachmentId 指向给定来源附件。 */
function canonicalVoiceAttachment(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly sourceAttachmentId: string;
  readonly attachmentId?: string;
  readonly subjectKey?: string;
}) {
  const subjectKey = input.subjectKey ?? SUBJECT_KEY;
  const observations = input.rows.map((row, index) => buildCustomerVoiceObservation({
    source: "amazon_review",
    subjectKey,
    externalContentId: `cv-${index + 1}`,
    parentContentId: null,
    threadId: null,
    contentType: "review",
    authorRef: null,
    capturedAt: CAPTURED_AT,
    publishedAt: null,
    title: typeof row.title === "string" ? row.title : null,
    text: typeof row.reviewText === "string" ? row.reviewText : "review text",
    rating: typeof row.rating === "number" ? row.rating : null,
    verifiedPurchase: typeof row.verifiedPurchase === "boolean" ? row.verifiedPurchase : null,
    engagement: null,
    sourceUrl: null,
    evidenceRefs: [`attachment:${input.sourceAttachmentId}`],
    provenance: {
      provider: "amazon_dom",
      method: "capture_v3_amazon_review",
      accessBasis: "first_party_visible_page",
      sourceAttachmentId: input.sourceAttachmentId,
      rawArtifactId: null,
      providerTermsVersion: null,
    },
    retentionPolicy: null,
    deletionRequired: false,
    externalDeletedAt: null,
    identityMatch: "EXACT",
    ownerExperience: null,
  }));
  const payload = buildCustomerVoiceAttachmentPayload({ subjectKey, observations });
  return {
    attachmentId: input.attachmentId ?? "customer-voice-1",
    kind: "customer_voice_observation_v1" as const,
    subjectKey,
    capturedAt: "2026-09-26T08:21:00.000Z",
    contentHash: "c".repeat(64),
    sourceUrl: null,
    payload,
  };
}

function productFact() {
  return adaptEvidenceToProductFact({ evidence: fixtureEvidence() });
}

function wire(attachments: readonly unknown[]) {
  const evidence = fixtureEvidence();
  const fact = adaptEvidenceToProductFact({ evidence });
  mocks.prismaFindTask.mockResolvedValue({
    id: "task-f03-1",
    updatedAt: new Date(CAPTURED_AT),
    resultJson: JSON.stringify({ candidateToTask: { candidateId: "cand-f03-1" } }),
  });
  mocks.prismaFindCandidate.mockResolvedValue({
    id: "cand-f03-1",
    convertedTaskId: "task-f03-1",
    sourceMetaJson: JSON.stringify({ productFact: fact }),
  });
  mocks.getSubject.mockResolvedValue({
    subjectKey: SUBJECT_KEY,
    versions: [evidence],
    attachments,
  });
}

async function runEngine() {
  return buildResearchEngineInput({
    context: { mode: "owner", token: "test-token" },
    taskId: "task-f03-1",
  });
}

/** 统计 Engine 路径暴露的独立评论样本总数（路径 B 的重复消费载体）。 */
function engineSampleCount(input: Awaited<ReturnType<typeof runEngine>>): number {
  return (input.reviewEvidenceSummary ?? []).reduce((sum, item) => sum + item.sampleReviews.length, 0);
}

function refsOfKind(input: Awaited<ReturnType<typeof runEngine>>, attachmentId: string): number {
  return input.sourceEvidenceRefs.filter((ref) => ref.refId === `attachment:${attachmentId}`).length;
}

describe("F-03 路径 B（Research Engine）重复消费回归", () => {
  beforeEach(() => {
    mocks.prismaFindTask.mockReset();
    mocks.prismaFindCandidate.mockReset();
    mocks.getSubject.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue({ persisted: true, event: {} });
  });

  // ── Case 1：Canonical + V3 + Legacy 完全重复 ────────────────────────────────
  it("Case 1：canonical 归一 v3 附件时，同一批 legacy review 不得再进入 Engine（重复消费 = 0）", async () => {
    const rows = reviewRows(13);
    const v3 = v3ReviewAttachment(rows, "v3-review-1");
    const legacy = legacyReviewAttachment(rows, "legacy-review-1");
    const canonical = canonicalVoiceAttachment({ rows, sourceAttachmentId: "v3-review-1" });
    wire([v3, legacy, canonical]);

    const input = await runEngine();

    // canonical 来源（v3 附件）不得再作为独立 review 样本消费
    expect(engineSampleCount(input)).toBe(0);
    expect(input.reviewEvidenceSummary ?? []).toEqual([]);
    // 样本仍去重；真实 canonical 来源保留引用身份，不能连溯源一起删除。
    expect(refsOfKind(input, "v3-review-1")).toBe(1);
    expect(refsOfKind(input, "customer-voice-1")).toBe(1);
    expect(refsOfKind(input, "legacy-review-1")).toBe(0);
  });

  // ── Case 2：只有 V3 + Legacy，没有 Canonical ────────────────────────────────
  it("Case 2：无 canonical 时，保持 V3 优先、丢弃重复 legacy，且有效评论不被全部删除", async () => {
    const rows = reviewRows(13);
    const v3 = v3ReviewAttachment(rows, "v3-review-2");
    const legacy = legacyReviewAttachment(rows, "legacy-review-2");
    wire([v3, legacy]);

    const input = await runEngine();

    // 既有 V3_PRIMARY_LEGACY_COMPAT：v3 保留，legacy 副本被行级签名匹配丢弃
    expect(refsOfKind(input, "v3-review-2")).toBe(1);
    expect(refsOfKind(input, "legacy-review-2")).toBe(0);
    expect(engineSampleCount(input)).toBeGreaterThan(0);
  });

  // ── Case 3：只有 Legacy ────────────────────────────────────────────────────
  it("Case 3：只有 legacy review_evidence 时，仍可独立消费", async () => {
    const legacy = legacyReviewAttachment(reviewRows(13), "legacy-review-3");
    wire([legacy]);

    const input = await runEngine();

    expect(refsOfKind(input, "legacy-review-3")).toBe(1);
    expect(engineSampleCount(input)).toBe(13);
  });

  // ── Case 4：Canonical + 独立 Legacy ────────────────────────────────────────
  it("Case 4：canonical 归一某一 v3 时，另一个未被归一的独立 legacy 仍保留", async () => {
    const coveredRows = reviewRows(13);
    const independentRows = Array.from({ length: 5 }, (_, index) => ({
      asin: ASIN,
      rating: 3,
      reviewDate: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      reviewText: `Independent review body ${index + 1}.`,
      title: `Independent title ${index + 1}`,
      verifiedPurchase: false,
    }));
    const v3 = v3ReviewAttachment(coveredRows, "v3-review-4");
    const legacyCovered = legacyReviewAttachment(coveredRows, "legacy-covered-4");
    const legacyIndependent = legacyReviewAttachment(independentRows, "legacy-independent-4");
    const canonical = canonicalVoiceAttachment({ rows: coveredRows, sourceAttachmentId: "v3-review-4" });
    wire([v3, legacyCovered, legacyIndependent, canonical]);

    const input = await runEngine();

    // 被归一/重复的 legacy 丢弃
    expect(refsOfKind(input, "legacy-covered-4")).toBe(0);
    expect(refsOfKind(input, "v3-review-4")).toBe(1);
    // 未覆盖的独立合法 legacy 保留
    expect(refsOfKind(input, "legacy-independent-4")).toBe(1);
    expect(engineSampleCount(input)).toBe(5);
  });

  // ── Case 5：跨主体隔离的两项独立性质（mock 边界说明） ───────────────────────
  //
  // 修正说明：原 Case 5 断言「异主体 legacy 附件应保留在当前 Research 结果中」
  // （expect(refsOfKind(input, "legacy-other-5")).toBe(1)），其语义错误 —— 它把
  // 「不同商品不误去重」偷换成了「允许异主体评论进入当前商品 Research 消费结果」。
  //
  // 正确的验收标准是两项**独立**性质：
  //   性质一：不同 ASIN 的相似文本评论不得被误判为同一条评论（不误去重）；
  //   性质二：不同 ASIN 的评论不得进入当前商品的 Research 消费结果。
  //
  // 关键事实：真实 EvidenceStore 的 getSubject(subjectKey) 在**结构上**保证只返回该主体
  // 记录（per-subject 目录 + 读取侧 fail-closed 主体键校验，见 evidenceStore.ts）；
  // attachment 只在自身 subjectDir 下写入。因此「异主体附件出现在当前主体结果里」是
  // **运行期不可能输入**。
  //   - 本用例在 mock 边界内证明**性质一**（不误去重）成立；
  //   - **性质二**的真实端到端证明见 f03CrossSubjectGuard.test.ts（真实 EvidenceStore 驱动
  //     正式 Engine/Bundle）与 evidenceStore.test.ts（上游契约级隔离）。
  it("Case 5：不同 subjectKey 的相似评论（性质一）不得被误判为同一条评论", async () => {
    const rows = reviewRows(13);
    const v3 = v3ReviewAttachment(rows, "v3-review-5");
    // 当前主体另有一份**独立** legacy（不同文本），用于验证相似文本不会误伤本主体合法证据
    const independentRows = Array.from({ length: 4 }, (_, index) => ({
      asin: ASIN,
      rating: 5,
      reviewDate: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      reviewText: `Independent subject-local review ${index + 1}.`,
      title: `Subject-local title ${index + 1}`,
      verifiedPurchase: true,
    }));
    const independentLegacy = legacyReviewAttachment(independentRows, "legacy-independent-5");
    wire([v3, independentLegacy]);

    const input = await runEngine();

    // 性质一：本主体合法 v3 完整保留（不被任何相似文本误去重）
    expect(refsOfKind(input, "v3-review-5")).toBe(1);
    // 本主体未被 v3 覆盖的独立 legacy 同样保留
    expect(refsOfKind(input, "legacy-independent-5")).toBe(1);
    // 消费样本 = v3(13) + 独立 legacy(4)，无任何跨主体或重复计入
    expect(engineSampleCount(input)).toBe(17);
    // 所有消费样本的身份（asin）都归属当前主体
    expect((input.reviewEvidenceSummary ?? []).every((item) => item.asin === ASIN)).toBe(true);
    expect((input.reviewEvidenceSummary ?? []).length).toBe(2);
  });

  // ── Case 5b：说明——异主体隔离不由本 mock 断言，由真实上游契约测试证明 ────────
  // 若在 mock 中强行注入「异主体附件出现在当前主体结果」，则模拟的正是运行期不可能输入；
  // 对该输入断言「不泄漏」会得出与真实系统无关的结论。此处以真实可达语义，
  // 证明「当前主体结果中所有 attachment 引用的 subjectKey 恒等于当前主体」这一不变量。
  it("Case 5b：当前主体 Research 输出中的 attachment 引用 subjectKey 恒等于当前主体", async () => {
    const currentRows = reviewRows(3);
    const currentLegacy = legacyReviewAttachment(currentRows, "legacy-current-5b");
    wire([currentLegacy]);

    const input = await runEngine();

    const attachmentRefs = input.sourceEvidenceRefs.filter((ref) => ref.refId.startsWith("attachment:"));
    expect(attachmentRefs.length).toBeGreaterThan(0);
    // 不变量：输出引用的主体键恒等于当前主体（无身份重标、无跨主体混入）
    expect(attachmentRefs.every((ref) => ref.subjectKey === SUBJECT_KEY)).toBe(true);
    expect(attachmentRefs.map((ref) => ref.refId)).toEqual([`attachment:${currentLegacy.attachmentId}`]);
  });

  // ── Case 6：无效 / 缺失的 Canonical 来源（fail-closed） ─────────────────────
  it("Case 6：canonical 来源解析失败时，不错误删除合法评论（fail-closed 保留 v3）", async () => {
    const rows = reviewRows(13);
    const v3 = v3ReviewAttachment(rows, "v3-review-6");
    const legacy = legacyReviewAttachment(rows, "legacy-review-6");
    // 损坏的 canonical：observations 缺失 → 解析返回 null
    const brokenCanonical = {
      attachmentId: "customer-voice-broken-6",
      kind: "customer_voice_observation_v1" as const,
      subjectKey: SUBJECT_KEY,
      capturedAt: CAPTURED_AT,
      contentHash: "b".repeat(64),
      sourceUrl: null,
      payload: { schemaVersion: "customer-voice-attachment-payload.v1", subjectKey: SUBJECT_KEY, observations: [] },
    };
    wire([v3, legacy, brokenCanonical]);

    const input = await runEngine();

    // canonical 无法解析 → 未归一任何来源；v3 保留，legacy 副本按既有规则丢弃
    expect(refsOfKind(input, "v3-review-6")).toBe(1);
    expect(engineSampleCount(input)).toBeGreaterThan(0);
  });

  // ── Case 7：canonical 归一的来源是 legacy 本体（而非 v3） ──────────────────
  it("Case 7：canonical 归一的来源恰为 legacy 本体时，legacy 也必须被排除", async () => {
    const rows = reviewRows(13);
    const legacy = legacyReviewAttachment(rows, "legacy-review-7");
    const canonical = canonicalVoiceAttachment({
      rows,
      sourceAttachmentId: "legacy-review-7",
      // 若该来源含 13 行，canonical 观测也必须是 13 条
    });
    wire([legacy, canonical]);

    const input = await runEngine();

    expect(refsOfKind(input, "legacy-review-7")).toBe(0);
    expect(engineSampleCount(input)).toBe(0);
  });
});
