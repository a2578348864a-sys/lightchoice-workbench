/** Amazon 选择器登记表。改版只更新这里，不把选择器散落到 Recipe 步骤。 */
export const AMAZON_RECIPE_SELECTORS = Object.freeze({
  productDetail: {
    productContainer: "#dp-container",
    asinAnchor: "#detailBullets_feature_div, #productDetails_detailBullets_sections1",
    title: "#productTitle",
    price: "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
  },
  search: {
    resultCard: '[data-component-type="s-search-result"]',
    title: "h2 a span, h2 span",
    asin: '[data-asin]',
    sponsored: '[aria-label^="Sponsored"], .puis-sponsored-label-text, [data-component-type="s-sponsored-label-marker"]',
  },
  reviews: {
    reviewContainer: '[data-hook="review"]',
    title: '[data-hook="review-title"]',
  },
  verifiedAt: "code-baseline-2026-09-21",
  selectorRevision: "amazon.recipe.selectors.v1",
} as const);
