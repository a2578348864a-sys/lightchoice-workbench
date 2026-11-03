import { describe, expect, it } from "vitest";

import { getLegacyV5GenerationState, shouldShowProductFactRecovery } from "@/components/research/legacyV5Generation";

const eligible = {
  isLegacy: true,
  hasLegacyReport: true,
  reportHash: null,
  hasHumanDecision: false,
  boundaryAvailable: true,
  busy: false,
};

describe("legacy V5 generation CTA", () => {
  it("shows and enables first V5 generation for an eligible legacy report", () => {
    expect(getLegacyV5GenerationState(eligible)).toEqual({ visible: true, enabled: true, blockReason: null });
  });

  it("does not treat an empty legacy task as having a generation CTA", () => {
    expect(getLegacyV5GenerationState({ ...eligible, hasLegacyReport: false })).toMatchObject({ visible: false, enabled: false });
  });

  it("blocks generation when a formal Human Decision exists", () => {
    expect(getLegacyV5GenerationState({ ...eligible, hasHumanDecision: true })).toMatchObject({
      visible: true,
      enabled: false,
      blockReason: "已有正式人工决断，不能直接生成 V5 研报。",
    });
  });

  it("fails closed before click when the canonical Research boundary is unavailable", () => {
    expect(getLegacyV5GenerationState({ ...eligible, boundaryAvailable: false, boundaryBlockReason: "ProductFact is missing." })).toMatchObject({
      visible: true,
      enabled: false,
      blockReason: "ProductFact is missing.",
    });
  });

  it("disables while pending and after the canonical boundary is known to be unavailable", () => {
    expect(getLegacyV5GenerationState({ ...eligible, busy: true }).enabled).toBe(false);
    expect(getLegacyV5GenerationState({ ...eligible, boundaryBlockedMessage: "正式研究边界不可用。" })).toMatchObject({
      visible: true,
      enabled: false,
      blockReason: "正式研究边界不可用。",
    });
  });

  it("does not show first-generation CTA once a V5 report exists", () => {
    expect(getLegacyV5GenerationState({ ...eligible, isLegacy: false, reportHash: "v5-report-hash" })).toMatchObject({
      visible: false,
      enabled: false,
    });
  });

  it("shows ProductFact recovery for an empty legacy task when its Candidate still has an ASIN", () => {
    expect(shouldShowProductFactRecovery({
      isLegacy: true,
      hasProductFact: false,
      asin: "B0D2P1HSCV",
      hasHumanDecision: false,
    })).toBe(true);
  });

  it("does not offer ProductFact recovery without an ASIN or after a human decision", () => {
    expect(shouldShowProductFactRecovery({
      isLegacy: true,
      hasProductFact: false,
      asin: "",
      hasHumanDecision: false,
    })).toBe(false);
    expect(shouldShowProductFactRecovery({
      isLegacy: true,
      hasProductFact: false,
      asin: "B0D2P1HSCV",
      hasHumanDecision: true,
    })).toBe(false);
  });
});
