import { describe, expect, it } from "vitest";

import {
  CAPTURE_RECIPE_DEFINITIONS,
  RECIPE_IDS,
  getRecipeDefinition,
  runRecipeDryRun,
  validateAllRecipeDefinitions,
  validateRecipeDefinition,
} from "./index";

describe("capture recipe foundation", () => {
  it("declares all six recipes with deterministic wait conditions", () => {
    validateAllRecipeDefinitions();
    expect(Object.keys(CAPTURE_RECIPE_DEFINITIONS).sort()).toEqual([...RECIPE_IDS].sort());
    for (const recipeId of RECIPE_IDS) {
      const recipe = getRecipeDefinition(recipeId);
      expect(recipe.steps.length).toBeGreaterThan(0);
      expect(recipe.steps.every((step) => !/sleep|setTimeout/i.test(step.waitFor))).toBe(true);
    }
  });

  it("fails closed when a recipe waits on sleep instead of a condition", () => {
    const recipe = getRecipeDefinition("product_detail");
    expect(() => validateRecipeDefinition({
      ...recipe,
      steps: [{ ...recipe.steps[0], waitFor: "sleep(1000)" }],
    })).toThrow("RECIPE_WAIT_CONDITION_INVALID");
  });

  it("runs every recipe offline without claiming browser success", () => {
    for (const recipeId of RECIPE_IDS) {
      const trace = runRecipeDryRun(recipeId);
      expect(trace.executionKind).toBe("dry_run_fixture");
      expect(trace.sourceOfResult).not.toBe("browser");
      expect(trace.stepOutcomes.length).toBe(getRecipeDefinition(recipeId).steps.length);
    }
    expect(runRecipeDryRun("history_trend")).toMatchObject({
      status: "blocked",
      errorCode: "NO_SOURCE_IN_REPO",
      sourceOfResult: "none",
    });
  });

  it("does not silently substitute CDP for the formal Playwright driver", async () => {
    const trace = await import("./runner").then(({ executeRecipeWithPlaywright }) => executeRecipeWithPlaywright({
      recipeId: "history_trend",
      driver: {
        kind: "playwright",
        runStep: async ({ step }) => ({
          status: "failed" as const,
          errorCode: step.failureCode,
          pageClass: null,
          elapsedMs: 0,
        }),
      },
    }));
    expect(trace.executionKind).toBe("playwright");
    expect(trace.status).toBe("failed");
    expect(trace.sourceOfResult).toBe("none");
  });
});
