import { RECIPE_IDS, type PlaywrightRecipeDriver, type RecipeDefinition, type RecipeId, type RecipeRunTrace, type RecipeStep, type RecipeStepOutcome } from "./contracts";
import { getRecipeDefinition } from "./definitions";
import { buildRecipeDryRunFixture } from "./fixtures";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";

export function validateRecipeDefinition(recipe: RecipeDefinition): void {
  if (recipe.schemaVersion !== "capture-recipe.v1") throw new Error("RECIPE_SCHEMA_INVALID");
  if (!RECIPE_IDS.includes(recipe.recipeId)) throw new Error("RECIPE_ID_INVALID");
  if (recipe.steps.length === 0) throw new Error("RECIPE_STEPS_EMPTY");
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (!step.stepId || ids.has(step.stepId)) throw new Error("RECIPE_STEP_ID_INVALID");
    ids.add(step.stepId);
    if (!step.action || !step.waitFor || /\bsleep\b|setTimeout/i.test(step.waitFor)) {
      throw new Error(`RECIPE_WAIT_CONDITION_INVALID:${step.stepId}`);
    }
    if (!step.failureCode) throw new Error(`RECIPE_FAILURE_CODE_MISSING:${step.stepId}`);
  }
  for (const [code, mapping] of Object.entries(recipe.failureMappings)) {
    if (!code || typeof mapping.retryable !== "boolean" || typeof mapping.humanRequired !== "boolean") {
      throw new Error("RECIPE_FAILURE_MAPPING_INVALID");
    }
  }
}

export function validateAllRecipeDefinitions(): void {
  for (const recipeId of RECIPE_IDS) validateRecipeDefinition(getRecipeDefinition(recipeId));
}

function traceFromDriver(input: {
  recipe: RecipeDefinition;
  outcomes: RecipeStepOutcome[];
  startedAt: string;
  finishedAt: string;
  traceId: string;
}): RecipeRunTrace {
  const failed = input.outcomes.find((outcome) => outcome.status !== "completed");
  const humanRequired = input.outcomes.some((outcome) => outcome.status === "human_required");
  return {
    schemaVersion: "capture-recipe-run.v1",
    recipeId: input.recipe.recipeId,
    executionKind: "playwright",
    status: humanRequired ? "human_required" : failed ? "failed" : "completed",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stepOutcomes: input.outcomes,
    errorCode: failed?.errorCode ?? null,
    humanTakeoverRequired: humanRequired,
    sourceOfResult: failed ? "none" : "browser",
    traceId: input.traceId,
  };
}

/**
 * 正式执行器只接受 Playwright driver。这里不自动回退到原生 CDP，避免把
 * 两套浏览器控制实现混成不可审计的隐式链路；Amazon CDP 仅由专项模块调用。
 */
export async function executeRecipeWithPlaywright(input: {
  recipeId: RecipeId;
  driver: PlaywrightRecipeDriver;
  now?: Date;
  traceId?: string;
}): Promise<RecipeRunTrace> {
  if (input.driver.kind !== "playwright") throw new Error("PLAYWRIGHT_DRIVER_REQUIRED");
  const recipe = getRecipeDefinition(input.recipeId);
  validateRecipeDefinition(recipe);
  const started = input.now ?? new Date();
  const outcomes: RecipeStepOutcome[] = [];
  for (const step of recipe.steps) {
    const outcome = await input.driver.runStep({ recipe, step });
    outcomes.push({ stepId: step.stepId, ...outcome });
    if (outcome.status !== "completed") break;
  }
  return traceFromDriver({
    recipe,
    outcomes,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    traceId: input.traceId ?? newTraceId(),
  });
}

export function runRecipeDryRun(recipeId: RecipeId): RecipeRunTrace {
  validateRecipeDefinition(getRecipeDefinition(recipeId));
  return buildRecipeDryRunFixture(recipeId);
}
