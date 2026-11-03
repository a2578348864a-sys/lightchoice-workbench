import { describe, expect, it } from "vitest";

import { canonicalJson, hashJson } from "./v5CanonicalHash";

describe("V5 canonical hash compatibility", () => {
  it("preserves sorted-key JSON and the existing SHA-256 digest contract", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashJson({ b: 2, a: 1 })).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });

  it("preserves array order and null-normalizes unsupported JSON values", () => {
    expect(canonicalJson([2, undefined, Number.NaN])).toBe("[2,null,null]");
    expect(canonicalJson({ missing: undefined, infinity: Number.POSITIVE_INFINITY })).toBe('{"infinity":null,"missing":null}');
  });
});
