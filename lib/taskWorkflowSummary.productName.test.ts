import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("task product-name display wiring", () => {
  it("keeps the shared display projection in the active research summary", () => {
    const summarySource = readFileSync(
      resolve(process.cwd(), "lib/taskWorkflowSummary.ts"),
      "utf8",
    );
    expect(summarySource).toContain("resolveTaskProductDisplayName");
  });
});
