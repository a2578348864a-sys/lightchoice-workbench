import { describe, expect, it } from "vitest";

import {
  buildSemanticAssistCandidate,
  validateSemanticAssistCandidate,
} from "@/lib/sourceLayer/jev/semanticAssist";

const base = {
  targetField: "title",
  candidateValue: "Observed title",
  normalizedValue: "Observed title",
  evidenceRefs: ["ev-1"],
  confidence: 0.72,
  reason: "多个标题节点中存在同一候选值。",
  triggerCode: "FIELD_AMBIGUOUS" as const,
  decision: "needs_review" as const,
  modelVersion: null,
  promptVersion: null,
  recipeVersion: "amazon-detail.v2",
  pageTemplateHash: "page-hash",
  evidenceHash: "evidence-hash",
};

describe("semantic assist", () => {
  it("accepts only evidence-backed non-confirmed candidates", () => {
    const result = buildSemanticAssistCandidate(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.jevRole).toBe("semantic_assist");
  });

  it("rejects candidates without evidence and confirmed output", () => {
    expect(buildSemanticAssistCandidate({ ...base, evidenceRefs: [] }).ok).toBe(false);
    expect(validateSemanticAssistCandidate({
      ...base,
      jevRole: "semantic_assist",
      decision: "confirmed",
    }).ok).toBe(false);
  });

  it("does not accept login, captcha or plan-limit as a semantic trigger", () => {
    expect(buildSemanticAssistCandidate({ ...base, triggerCode: "CAPTCHA_DETECTED" as never }).ok).toBe(false);
    expect(buildSemanticAssistCandidate({ ...base, triggerCode: "PLAN_LIMIT" as never }).ok).toBe(false);
    expect(buildSemanticAssistCandidate({ ...base, triggerCode: "NO_VISIBLE_SOURCE" as never }).ok).toBe(false);
    expect(buildSemanticAssistCandidate({ ...base, triggerCode: "LOGIN_REQUIRED" as never }).ok).toBe(false);
  });
});
