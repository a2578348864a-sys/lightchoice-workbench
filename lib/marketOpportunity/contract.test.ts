import { describe, expect, it } from "vitest";

import {
  buildInitialHumanDecision,
  buildInitialLarkSync,
  buildMarketOpportunityNicheDefinition,
  parseMarketOpportunityAiInterpretation,
  parseMarketOpportunityLarkSync,
} from "@/lib/marketOpportunity/contract";
import { FIXTURE_NICHE_DEFINITION } from "@/lib/marketScan/__fixtures__/productFactFixture";

describe("market opportunity contracts", () => {
  it("wraps the Phase 1 niche definition without changing its meaning", () => {
    const parsed = buildMarketOpportunityNicheDefinition(FIXTURE_NICHE_DEFINITION);
    expect(parsed.schemaVersion).toBe("market-opportunity-niche.v1");
    expect(parsed.kind).toBe(FIXTURE_NICHE_DEFINITION.kind);
    expect(parsed.parameters).toEqual(FIXTURE_NICHE_DEFINITION.parameters);
  });

  it("keeps human, AI and Lark initial states separate", () => {
    expect(buildInitialHumanDecision()).toMatchObject({ status: "UNREVIEWED", revision: 0 });
    expect(buildInitialLarkSync()).toMatchObject({ status: "NOT_SYNCED", exportContractVersion: "opportunity-export.v1" });
    expect(parseMarketOpportunityAiInterpretation({
      schemaVersion: "market-opportunity-ai.v1",
      status: "FAILED",
      summary: null,
      observations: [],
      risks: [],
      missingEvidence: [],
      questionsToValidate: [],
      suggestedNextStep: null,
      factRefs: [],
      generatedAt: "2026-09-20T00:00:00.000Z",
      model: null,
      errorCode: "AI_PROVIDER_NOT_CONFIGURED",
    }).status).toBe("FAILED");
  });

  it("accepts the legacy migration default for Lark state only after the adapter adds its version", () => {
    expect(parseMarketOpportunityLarkSync({
      ...buildInitialLarkSync(),
      status: "NOT_SYNCED",
    }).status).toBe("NOT_SYNCED");
  });
});
