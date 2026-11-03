import { describe, expect, it } from "vitest";
import {
  CANONICAL_DECISION_ACTIONS,
  canonicalToDbDecisionStatus,
  canonicalToLegacyChoice,
  feishuDecisionToCanonical,
  getDecisionStatusDisplay,
  toCanonicalDecisionStatus,
} from "./v5DecisionStatus";

describe("v5DecisionStatus canonical 5-state contract", () => {
  it("决定选项不把继续研究说成正式立项，也不替暂缓判断证据是否充分", () => {
    const proceed = CANONICAL_DECISION_ACTIONS.find((a) => a.status === "PROCEED");
    const pause = CANONICAL_DECISION_ACTIONS.find((a) => a.status === "PAUSE");
    expect(proceed?.description).toContain("不等于立项");
    expect(pause?.description).not.toContain("事实足够");
  });

  it("strictly asserts VALIDATE_MORE != PAUSE in semantics and action definitions", () => {
    const validateMore = CANONICAL_DECISION_ACTIONS.find((a) => a.status === "VALIDATE_MORE");
    const pause = CANONICAL_DECISION_ACTIONS.find((a) => a.status === "PAUSE");

    expect(validateMore).toBeDefined();
    expect(pause).toBeDefined();
    expect(validateMore!.status).not.toBe(pause!.status);
    expect(validateMore!.label).toBe("需补充验证");
    expect(pause!.label).toBe("暂缓观察");
    expect(validateMore!.description).not.toBe(pause!.description);
    expect(validateMore!.tone).not.toBe(pause!.tone);
  });

  it("prioritizes myChoice.canonicalStatus over hubStatus and dbStatus", () => {
    const resolved = toCanonicalDecisionStatus({
      myChoice: {
        canonicalStatus: "VALIDATE_MORE",
        hubStatus: "APPROVE",
        choice: "PROCEED",
      },
      dbStatus: "continue",
      hubStatus: "APPROVE",
    });

    expect(resolved).toBe("VALIDATE_MORE");
  });

  it("resolves structured hubStatus when canonicalStatus is missing", () => {
    const resolvedPause = toCanonicalDecisionStatus({
      myChoice: {
        canonicalStatus: null,
        hubStatus: "PAUSE",
        choice: "WATCH",
      },
      dbStatus: "need_info",
    });
    expect(resolvedPause).toBe("PAUSE");

    const resolvedValidate = toCanonicalDecisionStatus({
      myChoice: {
        canonicalStatus: null,
        hubStatus: "需补充验证",
        choice: "WATCH",
      },
      dbStatus: "need_info",
    });
    expect(resolvedValidate).toBe("VALIDATE_MORE");

    const resolvedApprove = toCanonicalDecisionStatus({
      myChoice: { choice: "PROCEED" },
      hubStatus: "通过",
      dbStatus: "continue",
    });
    expect(resolvedApprove).toBe("PROCEED");
  });

  it("MINOR-1: asserts exact precedence (canonicalStatus > hubStatus > choice)", () => {
    // Case 1: canonicalStatus = null, hubStatus = PAUSE, choice = WATCH -> resolved = PAUSE
    const case1 = toCanonicalDecisionStatus({
      myChoice: {
        canonicalStatus: null,
        hubStatus: "PAUSE",
        choice: "WATCH",
      },
    });
    expect(case1).toBe("PAUSE");

    // Case 2: canonicalStatus = VALIDATE_MORE, hubStatus = PAUSE, choice = WATCH -> resolved = VALIDATE_MORE
    const case2 = toCanonicalDecisionStatus({
      myChoice: {
        canonicalStatus: "VALIDATE_MORE",
        hubStatus: "PAUSE",
        choice: "WATCH",
      },
    });
    expect(case2).toBe("VALIDATE_MORE");
  });

  it("returns LEGACY_NEED_INFO_AMBIGUOUS for unproven need_info to prevent guessing", () => {
    const ambiguousFromDb = toCanonicalDecisionStatus({
      myChoice: null,
      dbStatus: "need_info",
    });
    expect(ambiguousFromDb).toBe("LEGACY_NEED_INFO_AMBIGUOUS");

    const ambiguousFromWatch = toCanonicalDecisionStatus({
      myChoice: { choice: "WATCH" },
      dbStatus: "need_info",
    });
    expect(ambiguousFromWatch).toBe("LEGACY_NEED_INFO_AMBIGUOUS");
  });

  it("maps DB legacy values correctly", () => {
    expect(toCanonicalDecisionStatus({ dbStatus: "continue" })).toBe("PROCEED");
    expect(toCanonicalDecisionStatus({ dbStatus: "rejected" })).toBe("DROP");
    expect(toCanonicalDecisionStatus({ dbStatus: "pending" })).toBe("PENDING");
    expect(toCanonicalDecisionStatus({ dbStatus: "" })).toBe("PENDING");
  });

  it("converts canonical status to DB status and legacy choice correctly", () => {
    expect(canonicalToDbDecisionStatus("PROCEED")).toBe("continue");
    expect(canonicalToDbDecisionStatus("VALIDATE_MORE")).toBe("need_info");
    expect(canonicalToDbDecisionStatus("PAUSE")).toBe("need_info");
    expect(canonicalToDbDecisionStatus("DROP")).toBe("rejected");
    expect(canonicalToDbDecisionStatus("PENDING")).toBe("pending");

    expect(canonicalToLegacyChoice("PROCEED")).toBe("PROCEED");
    expect(canonicalToLegacyChoice("VALIDATE_MORE")).toBe("WATCH");
    expect(canonicalToLegacyChoice("PAUSE")).toBe("WATCH");
    expect(canonicalToLegacyChoice("DROP")).toBe("DROP");
  });

  it("normalizes Feishu Chinese and English status tokens", () => {
    expect(feishuDecisionToCanonical("通过")).toBe("PROCEED");
    expect(feishuDecisionToCanonical("APPROVE")).toBe("PROCEED");
    expect(feishuDecisionToCanonical("暂缓")).toBe("PAUSE");
    expect(feishuDecisionToCanonical("暂缓观察")).toBe("PAUSE");
    expect(feishuDecisionToCanonical("PAUSE")).toBe("PAUSE");
    expect(feishuDecisionToCanonical("补证")).toBe("VALIDATE_MORE");
    expect(feishuDecisionToCanonical("需补充验证")).toBe("VALIDATE_MORE");
    expect(feishuDecisionToCanonical("VALIDATE_MORE")).toBe("VALIDATE_MORE");
    expect(feishuDecisionToCanonical("放弃")).toBe("DROP");
    expect(feishuDecisionToCanonical("DROP")).toBe("DROP");
    expect(feishuDecisionToCanonical("未审核")).toBe("PENDING");
    expect(feishuDecisionToCanonical("PENDING")).toBe("PENDING");
    expect(feishuDecisionToCanonical("UNKNOWN")).toBeNull();
  });

  it("provides display metadata for all resolved statuses", () => {
    expect(getDecisionStatusDisplay("PROCEED").label).toBe("继续推进");
    expect(getDecisionStatusDisplay("VALIDATE_MORE").label).toBe("需补充验证");
    expect(getDecisionStatusDisplay("PAUSE").label).toBe("暂缓观察");
    expect(getDecisionStatusDisplay("DROP").label).toBe("放弃");
    expect(getDecisionStatusDisplay("PENDING").label).toBe("待审核");
    expect(getDecisionStatusDisplay("LEGACY_NEED_INFO_AMBIGUOUS").label).toBe("待明确语义");
  });
});
