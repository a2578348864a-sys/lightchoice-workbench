/**
 * SellerSprite 选择器登记表。
 * 面板是否可见、是否由 extension webcontents 承载必须先人工发现；这里不
 * 放置 navs[1]、自动点校验弹窗或其它猜测性兜底。
 */
export const SELLERSPRITE_RECIPE_SELECTORS = Object.freeze({
  panelRoot: "#main-sellersprite-extension",
  keywordReportTable: "[data-report-type] table",
  reportHeaderRow: "thead tr",
  reportRows: "tbody tr",
  verifiedAt: "needs_manual_discovery",
  selectorRevision: "sellersprite.recipe.selectors.v1",
} as const);
