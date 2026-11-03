import { describe, expect, it } from "vitest";
import { materialCell, matchesMaterialFilter, matrixSubjectScope, sharedMaterialReferences, type MatrixItem, type MatrixReading } from "./materialMatrixPresentation";
import type { ProvenanceItemModule } from "../source-provenance/sourceProvenanceModel";

const entry = (patch: Partial<ProvenanceItemModule> = {}): ProvenanceItemModule => ({ module: "review_voc", label: "评论资料", status: "COMPLETE", evidenceId: "attachment-a", contentHash: "hash", capturedAt: "2026-10-21T00:00:00Z", limitations: [], errorCode: null, retryable: null, latestAttempt: null, ...patch });
const product = (e?: ProvenanceItemModule): MatrixItem => ({ id: "item-a", asin: "B000000001", marketplace: "US", usageStatus: "needs_review", moduleCoverage: e ? [e] : undefined });
const allowed = ["amazon_detail", "variation", "review_voc"];
const read = (patch: Partial<MatrixReading> = {}): MatrixReading => ({ state: "ready", data: { subjects: [], totals: { failures: [] } }, ...patch });

describe("matrix status and authorization truth", () => {
  it("keeps a blocked attachment distinct from completeness", () => {
    const cell = materialCell(product(entry({ status: "BLOCKED_WITH_EVIDENCE", limitations: ["local_environment_required"] })), "review_voc", allowed);
    expect(cell.state).toBe("blocked"); expect(cell.hasEvidence).toBe(true); expect(cell.reason).toContain("本机采集环境");
  });
  it("does not manufacture complete state from a receipt", () => {
    expect(materialCell(product(entry({ evidenceId: null })), "review_voc", allowed).state).toBe("unknown");
  });
  it("distinguishes unauthorized in this run from not collected", () => {
    const item = product(entry({ module: "reverse_asin", status: "NOT_COLLECTED", evidenceId: null }));
    expect(materialCell(item, "reverse_asin", allowed).state).toBe("not_in_scope");
    expect(materialCell(item, "reverse_asin", [...allowed, "reverse_asin"]).state).toBe("missing");
    expect(materialCell(item, "reverse_asin", null).reason).toContain("尚未确认");
  });
  it("retains historical attachments outside this run", () => {
    const cell = materialCell(product(entry({ module: "reverse_asin" })), "reverse_asin", allowed);
    expect(cell.state).toBe("complete"); expect(cell.inScope).toBe(false); expect(cell.hasEvidence).toBe(true);
  });
  it("does not mark missing module fields as no data", () => {
    expect(materialCell(product(), "review_voc", allowed).state).toBe("unknown");
  });
  it("keeps source restriction, partial and manual conditions distinct", () => {
    expect(materialCell(product(entry({ status: "AVAILABLE_WITH_LIMITATION" })), "review_voc", allowed).state).toBe("limited");
    expect(materialCell(product(entry({ status: "CAPTURED_PARTIAL" })), "review_voc", allowed).state).toBe("partial");
    expect(materialCell(product(entry({ status: "HUMAN_ACTION_REQUIRED", limitations: ["captcha_requires_human"] })), "review_voc", allowed).reason).toContain("验证码");
  });
  it("shows newer failed attempts without deleting historical evidence", () => {
    const item = product(entry({ latestAttempt: { status: "failed_retryable", errorCode: "CAPTURE_ATTEMPT_FAILED", message: "failed", attemptedAt: "2026-10-22T00:00:00Z" } }));
    expect(materialCell(item, "review_voc", allowed).state).toBe("failed");
    expect(materialCell(item, "review_voc", allowed).hasEvidence).toBe(true);
  });
  it("does not let an older failed attempt override newer complete evidence", () => {
    const item = product(entry({ latestAttempt: { status: "failed_retryable", errorCode: null, message: "failed", attemptedAt: "2026-10-20T00:00:00Z" } }));
    expect(materialCell(item, "review_voc", allowed).state).toBe("complete");
  });
  it("shows newer human gates alongside historical attachments", () => {
    const item = product(entry({ latestAttempt: { status: "failed_human", errorCode: "CAPTCHA_REQUIRES_HUMAN", message: "captcha", attemptedAt: "2026-10-22T00:00:00Z" } }));
    expect(materialCell(item, "review_voc", allowed).state).toBe("human");
    expect(materialCell(item, "review_voc", allowed).hasEvidence).toBe(true);
  });
});

describe("matrix scope, failure and shared references", () => {
  it("never multiplies query evidence into per-product attachments", () => {
    const item = product(entry({ module: "keyword_mining_trend" }));
    const cell = materialCell(item, "keyword_mining_trend", ["keyword_mining_trend"], read({ data: { subjects: [{ subjectKey: "sellersprite:US:query", module: "keyword_mining_trend", attachmentCount: 3, latestCapturedAt: null }], totals: { failures: [] } } }));
    expect(cell.state).toBe("query"); expect(cell.hasEvidence).toBe(false); expect(cell.reason).toContain("3 条附件"); expect(cell.reason).toContain("不能算作本商品独立");
  });
  it("marks search as an association and history as file evidence", () => {
    expect(matrixSubjectScope("amazon_search_market")).toBe("search_association");
    expect(matrixSubjectScope("historical_trend")).toBe("file");
  });
  it("keeps external read failure separate from unauthorized/missing and from basic records", () => {
    expect(materialCell(product(), "reverse_asin", allowed, { state: "error" }).state).toBe("read_error");
    expect(materialCell(product(entry()), "review_voc", allowed, { state: "error" }).state).toBe("complete");
  });
  it("honors per-subject failed reads without affecting other products", () => {
    const reading = read({ data: { subjects: [], totals: { failures: [{ subjectKey: "amazon:US:B000000001", module: null, message: "read failed" }] } } });
    expect(materialCell(product(), "reverse_asin", allowed, reading).state).toBe("read_error");
    expect(materialCell({ ...product(), asin: "B000000002" }, "reverse_asin", allowed, reading).state).toBe("not_in_scope");
  });
  it("does not hide a newly found file attachment behind a stale missing projection", () => {
    const reading = read({ data: { subjects: [{ subjectKey: "amazon:US:B000000001", module: "historical_trend", attachmentCount: 1, latestCapturedAt: null }], totals: { failures: [] } } });
    expect(materialCell(product(), "historical_trend", allowed, reading).label).toBe("附件待核对");
  });
  it("counts linked products once each, not the same attachment twice on a product", () => {
    const a = product(entry()); a.moduleCoverage!.push(entry({ module: "variation" }));
    expect(sharedMaterialReferences([a, { ...product(entry()), id: "item-b" }], "attachment-a")).toBe(2);
    expect(sharedMaterialReferences([a], null)).toBe(0);
  });
  it("filters the chosen module and group without changing source items", () => {
    const item = product(entry({ status: "HUMAN_ACTION_REQUIRED" }));
    expect(matchesMaterialFilter(item, { group: "basic", module: "review_voc", issue: "human" }, allowed)).toBe(true);
    expect(matchesMaterialFilter(item, { group: "basic", module: "amazon_detail", issue: "human" }, allowed)).toBe(false);
    expect(item.usageStatus).toBe("needs_review");
  });
});
