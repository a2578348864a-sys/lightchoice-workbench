import { describe, expect, it } from "vitest";

import { parseV5HubPacketDecisionRecord } from "./v5HubPacketDecisionPull";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const factHash = "a".repeat(64);
const evidenceHash = "b".repeat(64);
const packetHash = "c".repeat(64);

function packetRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_id: "rec_t02_decision_1",
    fields: {
      "主体键": "amazon:US:B07G4VTV2F",
      "任务 ID": "task-b07g4vtv2f-prod",
      "ASIN": "B07G4VTV2F",
      "销售站点": "US",
      "修订版本": 1,
      "研究包哈希": packetHash,
      "事实哈希": factHash,
      "证据哈希": evidenceHash,
      "人工决策": "通过",
      "决策备注": "供应链成熟，核心痛点已在真实证据中确认，准予立项推进。",
      ...overrides,
    },
    last_modified_by: { id: "ou_reviewer_999" },
    last_modified_time: now,
  };
}

describe("parseV5HubPacketDecisionRecord", () => {
  it("parses an explicitly reviewed T02 packet record and binds reviewer/time to platform metadata", () => {
    expect(parseV5HubPacketDecisionRecord(packetRecord())).toEqual({
      recordId: "rec_t02_decision_1",
      subjectKey: "amazon:US:B07G4VTV2F",
      taskId: "task-b07g4vtv2f-prod",
      asin: "B07G4VTV2F",
      marketplace: "US",
      revision: 1,
      packetHash,
      factHash,
      evidenceHash,
      status: "APPROVE",
      reason: "供应链成熟，核心痛点已在真实证据中确认，准予立项推进。",
      reviewerIdentity: "ou_reviewer_999",
      reviewedAt: "2026-09-28T12:00:00.000Z",
      lastModifiedTime: now,
    });
  });

  it.each([
    ["通过", "APPROVE"],
    ["需补充验证", "VALIDATE_MORE"],
    ["暂缓", "PAUSE"],
    ["放弃", "DROP"],
  ] as const)("maps explicit decision %s to %s", (label, expectedStatus) => {
    const parsed = parseV5HubPacketDecisionRecord(packetRecord({ "人工决策": label }));
    expect(parsed?.status).toBe(expectedStatus);
  });

  it("returns null for unreviewed or empty decisions", () => {
    expect(parseV5HubPacketDecisionRecord(packetRecord({ "人工决策": "" }))).toBeNull();
    expect(parseV5HubPacketDecisionRecord(packetRecord({ "人工决策": "未审核" }))).toBeNull();
    expect(parseV5HubPacketDecisionRecord(packetRecord({ "人工决策": undefined }))).toBeNull();
  });

  it.each([
    ["unsupported decision status", { "人工决策": "AUTO_APPROVE" }, "DECISION_STATUS_INVALID"],
    ["missing packet hash", { "研究包哈希": "" }, "DECISION_FIELD_REQUIRED:研究包哈希"],
    ["malformed packet hash", { "研究包哈希": "not-a-sha256" }, "DECISION_HASH_INVALID:研究包哈希"],
    ["missing fact hash", { "事实哈希": "" }, "DECISION_FIELD_REQUIRED:事实哈希"],
    ["missing evidence hash", { "证据哈希": "" }, "DECISION_FIELD_REQUIRED:证据哈希"],
    ["missing task ID", { "任务 ID": "" }, "DECISION_FIELD_REQUIRED:任务 ID"],
    ["missing subject key", { "主体键": "" }, "DECISION_FIELD_REQUIRED:主体键"],
    ["missing reason", { "决策备注": "   " }, "DECISION_FIELD_REQUIRED:决策备注"],
    ["too long reason", { "决策备注": "x".repeat(4001) }, "DECISION_REASON_TOO_LONG"],
    ["invalid revision zero", { "修订版本": 0 }, "DECISION_REVISION_INVALID"],
    ["invalid revision negative", { "修订版本": -1 }, "DECISION_REVISION_INVALID"],
  ])("rejects %s with %s", (_label, overrides, expectedCode) => {
    expect(() => parseV5HubPacketDecisionRecord(packetRecord(overrides))).toThrow(expectedCode);
  });

  it("rejects missing platform actor and invalid last_modified_time metadata", () => {
    expect(() => parseV5HubPacketDecisionRecord({ ...packetRecord(), last_modified_by: undefined }))
      .toThrow("DECISION_REVIEWER_UNVERIFIED");
    expect(() => parseV5HubPacketDecisionRecord({ ...packetRecord(), last_modified_by: { id: "" } }))
      .toThrow("DECISION_REVIEWER_UNVERIFIED");
    expect(() => parseV5HubPacketDecisionRecord({ ...packetRecord(), last_modified_time: 0 }))
      .toThrow("DECISION_REVIEW_TIME_UNVERIFIED");
    expect(() => parseV5HubPacketDecisionRecord({ ...packetRecord(), last_modified_time: -500 }))
      .toThrow("DECISION_REVIEW_TIME_UNVERIFIED");
  });
});
