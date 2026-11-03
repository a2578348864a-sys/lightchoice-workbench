import { describe, expect, it } from "vitest";
import {
  assertExpectedVersion,
  assertExpectedVersionMatches,
  canonicalJson,
  hashJson,
  requireIdempotencyKey,
  V5CoreError,
} from "@/lib/server/v5CoreCommon";

describe("V5 core write contracts", () => {
  it("canonicalizes object key order without changing the content hash", () => {
    expect(canonicalJson({ b: 2, a: { d: false, c: 1 } })).toBe('{"a":{"c":1,"d":false},"b":2}');
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });

  it("requires an explicit CAS version and accepts the persisted date forms", () => {
    const updatedAt = new Date("2026-09-22T10:00:00.000Z");
    expect(assertExpectedVersion(updatedAt.toISOString())).toBe(updatedAt.toISOString());
    expect(assertExpectedVersion(updatedAt.getTime())).toBe(String(updatedAt.getTime()));
    expect(() => assertExpectedVersion(undefined)).toThrowError(V5CoreError);
    expect(() => assertExpectedVersionMatches("stale", updatedAt)).toThrowError(/对象已在其他页面更新/);
  });

  it("requires bounded idempotency keys", () => {
    expect(requireIdempotencyKey("  v5-create-1  ")).toBe("v5-create-1");
    expect(() => requireIdempotencyKey("")).toThrowError(/Idempotency-Key/);
    expect(() => requireIdempotencyKey("x".repeat(129))).toThrowError(/Idempotency-Key/);
  });
});
