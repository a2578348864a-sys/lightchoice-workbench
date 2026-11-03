import type { RecipeDefinition, RecipeId } from "./contracts";
import { AMAZON_RECIPE_SELECTORS } from "./selectors/amazon";
import { SELLERSPRITE_RECIPE_SELECTORS } from "./selectors/sellerSprite";

function failureMappings(codes: Record<string, { retryable: boolean; humanRequired: boolean }>) {
  return Object.freeze(codes);
}

export const CAPTURE_RECIPE_DEFINITIONS: Readonly<Record<RecipeId, RecipeDefinition>> = Object.freeze({
  product_detail: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "product_detail",
    name: "Amazon 商品详情",
    targetSite: "amazon",
    targetMarketplace: "US",
    runMode: "B",
    selectorsRevision: AMAZON_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "navigate_detail", action: "导航到指定 ASIN 商品详情页", waitFor: "main document readyState=complete", failureCode: "TIMEOUT", humanTakeover: false },
      { stepId: "classify_page", action: "识别正常页/登录墙/验证码/错误页", waitFor: "page diagnostic classification is known", failureCode: "PAGE_CHANGED", humanTakeover: true },
      { stepId: "prove_entity_binding", action: "校验 URL ASIN、页面 ASIN、Marketplace 三元一致", waitFor: "binding proof is complete", failureCode: "ASIN_NOT_FOUND", humanTakeover: true },
      { stepId: "extract_detail_fields", action: "读取固定白名单字段", waitFor: "field extraction result is returned", failureCode: "SELECTOR_FAILED", humanTakeover: false },
      { stepId: "capture_gateway", action: "通过 Capture Gateway 写入 EvidenceStore 并适配 ProductFact", waitFor: "evidence and fact adapter result exist", failureCode: "INTERNAL_UNEXPECTED", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      CAPTCHA_DETECTED: { retryable: false, humanRequired: true },
      LOGIN_REQUIRED: { retryable: false, humanRequired: true },
      PAGE_CHANGED: { retryable: true, humanRequired: true },
      ASIN_NOT_FOUND: { retryable: false, humanRequired: true },
    }),
  },
  market_search: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "market_search",
    name: "Amazon 市场搜索",
    targetSite: "amazon",
    targetMarketplace: "US",
    runMode: "A",
    selectorsRevision: AMAZON_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "submit_keyword", action: "使用人工给定关键词打开搜索页", waitFor: "search page URL and query are visible", failureCode: "TIMEOUT", humanTakeover: false },
      { stepId: "classify_search_page", action: "识别正常搜索页与停止页", waitFor: "page diagnostic classification is known", failureCode: "PAGE_CHANGED", humanTakeover: true },
      { stepId: "extract_search_page", action: "读取最多 20 条结果并保留 Sponsored 三态", waitFor: "result card container is present or empty-result reason is known", failureCode: "SELECTOR_FAILED", humanTakeover: false },
      { stepId: "bind_observations", action: "按 appearanceKey/evidence ref 绑定候选，不使用数组下标", waitFor: "each observation has stable identity or missing reason", failureCode: "ASIN_NOT_FOUND", humanTakeover: false },
      { stepId: "capture_gateway", action: "通过 Capture Gateway 记录商品观察值", waitFor: "capture result is persisted or audited", failureCode: "INTERNAL_UNEXPECTED", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      CAPTCHA_DETECTED: { retryable: false, humanRequired: true },
      LOGIN_REQUIRED: { retryable: false, humanRequired: true },
      PAGE_CHANGED: { retryable: true, humanRequired: true },
    }),
  },
  reverse_asin_keywords: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "reverse_asin_keywords",
    name: "SellerSprite 反查 ASIN 关键词",
    targetSite: "sellersprite",
    targetMarketplace: "US",
    runMode: "C",
    selectorsRevision: SELLERSPRITE_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "confirm_panel_access", action: "确认 SellerSprite 面板由人工打开且可读取", waitFor: "panel root or official export is available", failureCode: "PLUGIN_NOT_LOADED", humanTakeover: true },
      { stepId: "read_reverse_asin_report", action: "读取官方导出或已打开面板中的 Reverse ASIN 报表", waitFor: "report type and header signature are recognized", failureCode: "DOM_CHANGED", humanTakeover: true },
      { stepId: "validate_report_headers", action: "按唯一解析器校验表头签名与列序", waitFor: "reverse_asin header signature passes", failureCode: "INVALID_FORMAT", humanTakeover: false },
      { stepId: "save_keyword_evidence", action: "保存 KeywordEvidence 并保留 evidence ref", waitFor: "task evidence namespace mutation succeeds", failureCode: "INTERNAL_UNEXPECTED", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      PLUGIN_NOT_LOADED: { retryable: true, humanRequired: true },
      PROVIDER_PERMISSION_DENIED: { retryable: false, humanRequired: true },
      PROVIDER_QUOTA_EXHAUSTED: { retryable: false, humanRequired: true },
      DOM_CHANGED: { retryable: true, humanRequired: true },
    }),
  },
  keyword_mining: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "keyword_mining",
    name: "SellerSprite 关键词挖掘",
    targetSite: "sellersprite",
    targetMarketplace: "US",
    runMode: "C",
    selectorsRevision: SELLERSPRITE_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "confirm_official_report", action: "确认 Keyword Mining 官方导出或已打开面板", waitFor: "keyword mining report is available", failureCode: "PLUGIN_NOT_LOADED", humanTakeover: true },
      { stepId: "validate_report_headers", action: "按唯一解析器校验 21 列表头签名", waitFor: "keyword_mining header signature passes", failureCode: "INVALID_FORMAT", humanTakeover: false },
      { stepId: "mark_trend_missing_if_absent", action: "没有可靠趋势来源时显式写 missing 与原因", waitFor: "trend source decision is explicit", failureCode: "NO_SOURCE_IN_REPO", humanTakeover: false },
      { stepId: "save_keyword_evidence", action: "保存 KeywordEvidence 并与其它关键词证据共存", waitFor: "task evidence namespace mutation succeeds", failureCode: "INTERNAL_UNEXPECTED", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      PROVIDER_PERMISSION_DENIED: { retryable: false, humanRequired: true },
      PROVIDER_QUOTA_EXHAUSTED: { retryable: false, humanRequired: true },
      NO_SOURCE_IN_REPO: { retryable: false, humanRequired: false },
    }),
  },
  review_voc: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "review_voc",
    name: "评论 / VOC",
    targetSite: "amazon",
    targetMarketplace: "US",
    runMode: "C",
    selectorsRevision: AMAZON_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "choose_review_source", action: "选择人工导入、官方导出或公开可见片段来源", waitFor: "source and product role are declared", failureCode: "SOURCE_MISSING", humanTakeover: true },
      { stepId: "bind_review_entity", action: "校验 ASIN 与 current_candidate/competitor 角色", waitFor: "entity binding proof is complete", failureCode: "ASIN_NOT_FOUND", humanTakeover: false },
      { stepId: "dedupe_reviews", action: "按 reviewId 或 ASIN+内容指纹去重并执行上限", waitFor: "bounded dataset result is returned", failureCode: "INVALID_FORMAT", humanTakeover: false },
      { stepId: "save_review_evidence", action: "保存 ReviewEvidence，VOC 只读取已保存证据", waitFor: "review evidence namespace mutation succeeds", failureCode: "INTERNAL_UNEXPECTED", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      LOGIN_REQUIRED: { retryable: false, humanRequired: true },
      CAPTCHA_DETECTED: { retryable: false, humanRequired: true },
      ASIN_NOT_FOUND: { retryable: false, humanRequired: true },
    }),
  },
  history_trend: {
    schemaVersion: "capture-recipe.v1",
    recipeId: "history_trend",
    name: "历史趋势",
    targetSite: "sellersprite",
    targetMarketplace: "US",
    runMode: "C",
    selectorsRevision: SELLERSPRITE_RECIPE_SELECTORS.selectorRevision,
    steps: [
      { stepId: "check_reliable_source", action: "检查官方 API/官方导出是否提供可追溯时序数据", waitFor: "source capability decision is explicit", failureCode: "NO_SOURCE_IN_REPO", humanTakeover: false },
    ],
    failureMappings: failureMappings({
      NO_SOURCE_IN_REPO: { retryable: false, humanRequired: false },
      PROVIDER_QUOTA_EXHAUSTED: { retryable: false, humanRequired: true },
    }),
  },
});

export function getRecipeDefinition(recipeId: RecipeId): RecipeDefinition {
  return CAPTURE_RECIPE_DEFINITIONS[recipeId];
}
