import { describe, expect, it } from "vitest";
import { projectWorkspaceCounts } from "@/lib/client/workflowCounts";
describe("active home decision counter", () => {
 it("does not confuse pending candidate ingress with awaiting human decision", () => {
   expect(projectWorkspaceCounts({ research: { pendingCandidateCount: 99 }, counts: { researchNeedsChoice: 2 } }).researchNeedsDecision).toBe(2);
   expect(projectWorkspaceCounts({ research: { pendingCandidateCount: 99 } }).researchNeedsDecision).toBe(0);
 });
});
