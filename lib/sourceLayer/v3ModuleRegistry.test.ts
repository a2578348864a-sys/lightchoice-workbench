import { describe, expect, it } from "vitest";

import {
  V3_MODULE_REGISTRY,
  evaluateV3ModuleOnline,
  getV3ModuleRegistryEntry,
} from "@/lib/sourceLayer/v3ModuleRegistry";

describe("V3 module registry", () => {
  it("defines exactly the eight frozen modules with a legal Browser Visible entry", () => {
    expect(V3_MODULE_REGISTRY).toHaveLength(8);
    expect(new Set(V3_MODULE_REGISTRY.map((item) => item.id)).size).toBe(8);
    for (const entry of V3_MODULE_REGISTRY) {
      expect(entry.productionEntrypoints).toContain("POST /api/source-layer/acquire/browser-visible");
      expect(entry.preferredAcquisitionModes.length).toBeGreaterThan(0);
      expect(entry.minimumIdentity.length).toBeGreaterThan(0);
    }
    expect(getV3ModuleRegistryEntry("variation").evidenceKind).toBe("v3_variation_v1");
  });

  it("does not call parser-only or fixture-only work ONLINE", () => {
    const result = evaluateV3ModuleOnline({
      realProductionEntry: true,
      realDataValidated: false,
      evidencePersisted: true,
      provenanceComplete: true,
      downstreamReadable: true,
      limitationExplicit: true,
      testsPass: true,
      final3010Pass: false,
    });
    expect(result.online).toBe(false);
    expect(result.blockers).toEqual(["REAL_DATA_VALIDATED", "FINAL_3010"]);
  });
});
