import { describe, expect, it } from "vitest";

import { parseV5HubDecisionRecord } from "./v5HubDecisionPull";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const hash = "a".repeat(64);

function record(overrides: Record<string, unknown> = {}) {
  return {
    record_id: "rec_decision_1",
    fields: {
      "概念 ID": "pcv5_123",
      "主体键": "subject_123",
      "任务 ID": "task_123",
      "修订版本": 2,
      "报告哈希": hash,
      "事实哈希": "b".repeat(64),
      "证据哈希": "c".repeat(64),
      "人工决策": "通过",
      "决策备注": "已核实当前证据与方案。",
      "审核人身份": "ou_reviewer_1",
      "审核时间": now,
      "预期研究包哈希": "d".repeat(64),
      ...overrides,
    },
    last_modified_by: { id: "ou_reviewer_1" },
    last_modified_time: now,
  };
}

describe("parseV5HubDecisionRecord", () => {
  it("parses an explicitly reviewed record and binds reviewer/time to Feishu metadata", () => {
    expect(parseV5HubDecisionRecord(record())).toEqual({
      recordId: "rec_decision_1",
      conceptId: "pcv5_123",
      subjectKey: "subject_123",
      taskId: "task_123",
      conceptRevision: 2,
      reportHash: hash,
      factHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      packetHash: "d".repeat(64),
      status: "APPROVE",
      reason: "已核实当前证据与方案。",
      personalReview: null,
      reviewerIdentity: "ou_reviewer_1",
      reviewedAt: "2026-09-28T12:00:00.000Z",
      lastModifiedTime: now,
    });
  });

  it("ignores records without a human decision", () => {
    expect(parseV5HubDecisionRecord(record({ "人工决策": "" }))).toBeNull();
  });

  it.each([
    ["unsupported decision", { "人工决策": "AUTO_APPROVE" }],
    ["missing packet hash", { "预期研究包哈希": "" }],
    ["malformed packet hash", { "预期研究包哈希": "not-a-hash" }],
    ["missing reason", { "决策备注": "  " }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseV5HubDecisionRecord(record(overrides))).toThrow();
  });

  it("uses platform actor and timestamp instead of user-editable reviewer/time cells", () => {
    const parsed = parseV5HubDecisionRecord(record({ "审核人身份": "张三", "审核时间": now - 5_000 }));
    expect(parsed?.reviewerIdentity).toBe("ou_reviewer_1");
    expect(parsed?.reviewedAt).toBe("2026-09-28T12:00:00.000Z");
  });

  it("rejects an old manually entered review time after later record edits", () => {
    expect(() => parseV5HubDecisionRecord(record({ "审核时间": now - 10 * 60_000 }))).toThrow();
  });

  it("rejects missing or invalid platform modification metadata", () => {
    expect(() => parseV5HubDecisionRecord({ ...record(), last_modified_by: undefined })).toThrow();
    expect(() => parseV5HubDecisionRecord({ ...record(), last_modified_time: 0 })).toThrow();
  });
});
