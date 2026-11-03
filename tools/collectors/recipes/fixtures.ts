import type { RecipeId, RecipeRunTrace, RecipeStepOutcome } from "./contracts";
import { getRecipeDefinition } from "./definitions";

const COMPLETED: Record<RecipeId, readonly string[]> = {
  product_detail: ["navigate_detail", "classify_page", "prove_entity_binding", "extract_detail_fields", "capture_gateway"],
  market_search: ["submit_keyword", "classify_search_page", "extract_search_page", "bind_observations", "capture_gateway"],
  reverse_asin_keywords: ["confirm_panel_access", "read_reverse_asin_report", "validate_report_headers", "save_keyword_evidence"],
  keyword_mining: ["confirm_official_report", "validate_report_headers", "mark_trend_missing_if_absent", "save_keyword_evidence"],
  review_voc: ["choose_review_source", "bind_review_entity", "dedupe_reviews", "save_review_evidence"],
  history_trend: [],
};

export function buildRecipeDryRunFixture(recipeId: RecipeId, capturedAt = "2026-09-21T00:00:00.000Z"): RecipeRunTrace {
  const definition = getRecipeDefinition(recipeId);
  const startedAt = capturedAt;
  const completed = new Set(COMPLETED[recipeId]);
  const stepOutcomes: RecipeStepOutcome[] = definition.steps.map((step, index) => ({
    stepId: step.stepId,
    status: completed.has(step.stepId) ? "completed" : "failed",
    errorCode: completed.has(step.stepId) ? null : step.failureCode,
    pageClass: recipeId === "history_trend" ? null : "fixture_normal",
    elapsedMs: index + 1,
  }));
  const blocked = recipeId === "history_trend";
  return {
    schemaVersion: "capture-recipe-run.v1",
    recipeId,
    executionKind: "dry_run_fixture",
    status: blocked ? "blocked" : "completed",
    startedAt,
    finishedAt: capturedAt,
    stepOutcomes,
    errorCode: blocked ? "NO_SOURCE_IN_REPO" : null,
    humanTakeoverRequired: stepOutcomes.some((step) => step.status === "human_required"),
    sourceOfResult: blocked ? "none" : "fixture",
  };
}
