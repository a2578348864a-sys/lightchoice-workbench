import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teamRecommendationToCanonical, feishuDecisionToCanonical } from "@/lib/types/v5DecisionStatus";
function productionSources(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? productionSources(join(root, entry.name)) : /\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [join(root, entry.name)] : []); }
describe("P7 minimal A07 / A11 production contract", () => {
  it("production components and hooks cannot call legacy feishu-sync APIs", () => {
    const callers = ["components", "hooks"].flatMap(productionSources).filter(path => /\/api\/feishu-sync|\/feishu-sync(?:[`"']|\?)/.test(readFileSync(path, "utf8")));
    expect(callers).toEqual([]);
  });
  it.each([["RECOMMEND_PROCEED", "PROCEED"], ["RECOMMEND_VALIDATE_MORE", "VALIDATE_MORE"], ["RECOMMEND_PAUSE", "PAUSE"], ["RECOMMEND_DROP", "DROP"]])("%s maps to exact %s", (remote, final) => expect(teamRecommendationToCanonical(remote)).toBe(final));
  it("ambiguous need_info is never a same-name Feishu recommendation", () => {
    expect(feishuDecisionToCanonical("need_info")).toBeNull(); expect(teamRecommendationToCanonical("NEED_INFO")).toBeNull(); expect(teamRecommendationToCanonical("PENDING")).toBeNull();
  });
});
