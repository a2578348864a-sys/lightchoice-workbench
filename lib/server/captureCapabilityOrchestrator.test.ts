import { describe, expect, it, vi } from "vitest";
import { runModulesIndependently, summarizeOutcome } from "@/lib/server/captureCapabilityOrchestrator";

describe("Capture Capability Orchestrator V2", () => {
  it.each([
    ["completed", "completed"],
    ["complete", "completed"],
    ["captured_partial", "completed"],
    ["partial", "limited"],
    ["human_action_required", "limited"],
    ["not_attempted", "limited"],
    ["failed_retryable", "failed"],
  ] as const)("summarizes module state %s as %s", (status, expected) => {
    expect(summarizeOutcome(status)).toBe(expected);
  });

  it("isolates module failure and continues later selected modules in request order", async () => {
    const visited: string[] = [];
    const result = await runModulesIndependently({
      modules: ["amazon_detail", "variation", "review_voc"] as const,
      run: vi.fn(async (module) => {
        visited.push(module);
        if (module === "variation") throw new Error("variation source changed");
        return { status: "completed", module };
      }),
      onError: (module, error) => ({
        status: "failed_retryable",
        module,
        message: error instanceof Error ? error.message : "unknown failure",
      }),
    });

    expect(visited).toEqual(["amazon_detail", "variation", "review_voc"]);
    expect(result.map((entry) => entry.value.status)).toEqual(["completed", "failed_retryable", "completed"]);
    expect(result[1]?.value).toMatchObject({ module: "variation", message: "variation source changed" });
  });

  it("pauses only the shared Amazon source after a human gate and still runs unrelated modules", async () => {
    const visited: string[] = [];
    const amazonModules = new Set(["amazon_detail", "variation"]);
    const result = await runModulesIndependently({
      modules: ["amazon_detail", "variation", "sellersprite_product_market"] as const,
      run: vi.fn(async (module) => {
        visited.push(module);
        return { module, status: module === "amazon_detail" ? "human_action_required" : "completed" };
      }),
      onError: (module) => ({ module, status: "failed_retryable" }),
      sourceGate: {
        moduleIds: amazonModules,
        isGateResult: (value) => value.status === "human_action_required",
        createNotAttempted: (module) => ({ module, status: "not_attempted" }),
      },
    });

    expect(visited).toEqual(["amazon_detail", "sellersprite_product_market"]);
    expect(result.map((entry) => entry.value.status)).toEqual(["human_action_required", "not_attempted", "completed"]);
  });
});
