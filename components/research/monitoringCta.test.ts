import { describe, expect, it } from "vitest";
import { shouldShowMonitoringCta } from "./monitoringCta";

describe("monitoring CTA gate", () => {
  it("only exposes monitoring after the canonical PROCEED decision", () => {
    expect(shouldShowMonitoringCta("PROCEED")).toBe(true);
    expect(shouldShowMonitoringCta("VALIDATE_MORE")).toBe(false);
    expect(shouldShowMonitoringCta("PAUSE")).toBe(false);
    expect(shouldShowMonitoringCta("DROP")).toBe(false);
    expect(shouldShowMonitoringCta(null)).toBe(false);
  });
});
