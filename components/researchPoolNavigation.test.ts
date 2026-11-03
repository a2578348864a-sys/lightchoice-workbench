import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("research-pool navigation convergence", () => {
  const resolver = source("lib/workflow/workflowResolver.ts");

  it("routes the sidebar Product Research entry to the persistent pool", () => {
    const sidebar = source("components/WorkspaceSidebar.tsx");
    expect(sidebar).toContain("WORKFLOW_STAGE_META.PRODUCT_RESEARCH.href");
    expect(resolver).toContain('href: "/research"');
  });

  it("loads authenticated home counts from the summary API and keeps the pool in the sidebar", () => {
    const home = source("components/home/WorkbenchOverviewClient.tsx");
    const sidebar = source("components/WorkspaceSidebar.tsx");
    expect(home).toContain('fetch("/api/home/summary"');
    expect(home).toContain("buildAccessHeaders()");
    expect(home).toContain("setData(json.data)");
    expect(home).toContain('aria-label="核心业务推进管道"');
    expect(sidebar).toContain("WORKFLOW_STAGE_META.PRODUCT_RESEARCH.href");
    expect(resolver).toContain('href: "/research"');
    expect(home).not.toContain("readCandidatePool");
    expect(home).not.toContain("setCandidateItems");
  });
});
