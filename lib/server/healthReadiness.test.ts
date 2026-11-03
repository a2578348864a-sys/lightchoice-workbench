import { describe, expect, it } from "vitest";
import { evaluateReadiness, readinessErrorCode } from "@/lib/server/healthReadiness";

const okDb = async () => ({ ok: 1 });
const okStore = () => undefined;

describe("readiness", () => {
  it("all probes healthy -> ok with both checks ok", async () => {
    const result = await evaluateReadiness({ database: okDb, evidenceStore: okStore });
    expect(result).toEqual({ ok: true, checks: { database: "ok", evidenceStore: "ok" } });
    expect(readinessErrorCode(result)).toBe("NOT_READY");
  });

  it("database failure -> not ready, DATABASE_UNAVAILABLE", async () => {
    const result = await evaluateReadiness({
      database: async () => { throw new Error("db down"); },
      evidenceStore: okStore,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.database).toBe("unavailable");
    expect(readinessErrorCode(result)).toBe("DATABASE_UNAVAILABLE");
  });

  it("evidence store failure -> not ready, EVIDENCE_STORE_UNAVAILABLE", async () => {
    const result = await evaluateReadiness({
      database: okDb,
      evidenceStore: () => { throw new Error("store missing"); },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.evidenceStore).toBe("unavailable");
    expect(readinessErrorCode(result)).toBe("EVIDENCE_STORE_UNAVAILABLE");
  });

  it("slow database probe times out instead of hanging the health endpoint", async () => {
    const result = await evaluateReadiness({
      database: () => new Promise((resolve) => setTimeout(resolve, 50)),
      evidenceStore: okStore,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.database).toBe("timeout");
    expect(readinessErrorCode(result)).toBe("DATABASE_TIMEOUT");
  });

  it("slow evidence probe times out with its own code", async () => {
    const result = await evaluateReadiness({
      database: okDb,
      evidenceStore: () => new Promise((resolve) => setTimeout(resolve, 50)),
      timeoutMs: 5,
    });
    expect(result.checks.evidenceStore).toBe("timeout");
    expect(readinessErrorCode(result)).toBe("EVIDENCE_STORE_TIMEOUT");
  });
});
