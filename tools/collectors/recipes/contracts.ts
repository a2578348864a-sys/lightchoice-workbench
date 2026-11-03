/**
 * V5 Capture Recipe 执行契约。
 *
 * Recipe 只描述「可判定的步骤」；浏览器驱动由外部注入。这样离线 dry-run
 * 不需要联网，也不会把 fixture 结果伪装成真实采集；正式浏览器路径只接受
 * Playwright 驱动，原生 CDP 仍由 Amazon 专项模块独立承担。
 */

export const RECIPE_IDS = [
  "product_detail",
  "market_search",
  "reverse_asin_keywords",
  "keyword_mining",
  "review_voc",
  "history_trend",
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export const RECIPE_RUN_MODES = ["A", "B", "C", "D"] as const;
export type RecipeRunMode = (typeof RECIPE_RUN_MODES)[number];

export type RecipeStep = {
  stepId: string;
  /** 人工可读的固定动作，不接受自由脚本。 */
  action: string;
  /** 必须是可判定条件，禁止用 sleep 作为等待条件。 */
  waitFor: string;
  /** 该步失败时的稳定错误码。 */
  failureCode: string;
  /** 是否需要人工接管；程序不得自动绕过。 */
  humanTakeover: boolean;
};

export type RecipeDefinition = {
  schemaVersion: "capture-recipe.v1";
  recipeId: RecipeId;
  name: string;
  targetSite: "amazon" | "sellersprite";
  targetMarketplace: "US";
  runMode: RecipeRunMode;
  steps: readonly RecipeStep[];
  selectorsRevision: string;
  failureMappings: Readonly<Record<string, { retryable: boolean; humanRequired: boolean }>>;
};

export type RecipeStepOutcome = {
  stepId: string;
  status: "completed" | "failed" | "human_required";
  errorCode: string | null;
  pageClass: string | null;
  elapsedMs: number;
};

export type RecipeRunTrace = {
  schemaVersion: "capture-recipe-run.v1";
  recipeId: RecipeId;
  executionKind: "dry_run_fixture" | "playwright";
  status: "completed" | "failed" | "human_required" | "blocked";
  startedAt: string;
  finishedAt: string;
  stepOutcomes: RecipeStepOutcome[];
  errorCode: string | null;
  humanTakeoverRequired: boolean;
  sourceOfResult: "fixture" | "browser" | "none";
  /** 与 Source Layer AuditLog 对齐的端到端链路 ID；旧 fixture 可缺省。 */
  traceId?: string;
};

export type PlaywrightRecipeDriver = {
  /** 明确标记：该驱动必须来自 Playwright，不允许静默换成 CDP。 */
  kind: "playwright";
  runStep(input: {
    recipe: RecipeDefinition;
    step: RecipeStep;
  }): Promise<Omit<RecipeStepOutcome, "stepId">>;
};
