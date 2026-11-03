import { describe, expect, it } from "vitest";
import { AmazonConsoleErrorCollector, classifyAmazonConsoleError } from "./console-error-diagnostics";

describe("Amazon console error diagnostics", () => {
  it("redacts URL paths and raw messages while classifying source, category, and un-attributed impact", () => {
    const diagnostic = classifyAmazonConsoleError({
      type: "error",
      text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT user-token=must-not-be-retained",
      sourceUrl: "https://m.media-amazon.com/assets/runtime.js?token=must-not-be-retained",
    });

    expect(diagnostic).toMatchObject({
      type: "error",
      sourceDomain: "m.media-amazon.com",
      sourceKind: "amazon_first_party",
      messageCategory: "blocked_resource",
      affectsExtractor: null,
      affectsPageStatus: null,
      impactAssessment: "not_attributable_from_console_message",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("runtime.js");
    expect(JSON.stringify(diagnostic)).not.toContain("must-not-be-retained");
  });

  it("keeps a bounded summary and counts omitted errors without retaining their text", () => {
    const collector = new AmazonConsoleErrorCollector(3);
    for (let index = 0; index < 5; index += 1) {
      collector.record({ type: "error", text: `Uncaught TypeError: private-${index}`, sourceUrl: "https://www.amazon.com/app.js?x=1" });
    }
    collector.record({ type: "warning", text: "ignored warning", sourceUrl: "https://www.amazon.com/app.js" });

    const summary = collector.snapshot();
    expect(summary).toMatchObject({ totalErrors: 5, recordedErrors: 3, truncatedErrors: 2 });
    expect(summary.items).toHaveLength(3);
    expect(summary.items.every((item) => item.messageCategory === "script_exception")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("private-");
    expect(JSON.stringify(summary)).not.toContain("app.js");
  });
});
