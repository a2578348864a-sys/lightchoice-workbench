import { describe, expect, it } from "vitest";

import { HubDuplicateKeyError, decideHubRecordMatch } from "./v5HubMatching";

describe("V5 Hub logical-key matching", () => {
  it("creates only when no remote record matches", () => {
    expect(decideHubRecordMatch([])).toEqual({ action: "create" });
  });

  it("updates the single matched record", () => {
    expect(decideHubRecordMatch([{ record_id: "rec-1" }])).toEqual({ action: "update", recordId: "rec-1" });
  });

  it("fails closed instead of selecting one duplicate", () => {
    expect(() => decideHubRecordMatch([{ record_id: "rec-1" }, { record_id: "rec-2" }]))
      .toThrowError(HubDuplicateKeyError);
    try {
      decideHubRecordMatch([{ record_id: "rec-1" }, { record_id: "rec-2" }]);
    } catch (error) {
      expect(error).toMatchObject({ code: "FEISHU_DUPLICATE_KEY" });
    }
  });

  it("fails closed when a single search result has no usable record ID", () => {
    expect(() => decideHubRecordMatch([{ record_id: " " }])).toThrow(/missing record_id/);
  });
});
