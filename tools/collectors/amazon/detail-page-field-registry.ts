export const AMAZON_DETAIL_FIELD_REGISTRY_VERSION = "amazon-detail-field-registry.v1" as const;
export const AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION = "primary-bsr.v1" as const;
export const AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION = "sub-category-bsr.v1" as const;

export type AmazonDetailFieldNature =
  | "DIRECT_FACT"
  | "DERIVED_FACT"
  | "ESTIMATED_METRIC"
  | "CONDITIONAL_FACT"
  | "BLOCKED";

export type AmazonDetailFieldRule = {
  canonicalField: string;
  priority: "P0" | "P1" | "P2" | "BLOCKED";
  fieldNature: AmazonDetailFieldNature;
  pageRegion: string;
  labelAliases: readonly string[];
  selectorCandidates: readonly string[];
  parser: string;
  validator: string;
  missingBehavior: string;
  ambiguityBehavior: string;
  targetStorage: string | null;
  sourceTrace: string;
};

const PRODUCT_SPEC_ROWS = [
  "#productDetails_expanderTables_depthLeftSections table.a-keyvalue.prodDetTable tr",
  "#productDetails_expanderTables_depthRightSections table.a-keyvalue.prodDetTable tr",
  "#productOverview_feature_div table tr",
  "#productDetails_techSpec_section_1 tr",
  "#productDetails_techSpec_section_2 tr",
  "#productDetails_detailBullets_sections1 tr",
  "#detailBullets_feature_div li",
  "#prodDetails tr",
] as const;

const DETAIL_RANK_ROWS = [
  "#detailBullets_feature_div li",
  "#productDetails_detailBullets_sections1 tr",
  "#prodDetails tr",
  "#productDetails_techSpec_section_1 tr",
  "#productDetails_techSpec_section_2 tr",
  "#productDetails_db_sections tr",
] as const;

const defineRule = (
  rule: Omit<AmazonDetailFieldRule, "sourceTrace"> & { sourceTrace?: string },
): AmazonDetailFieldRule => ({
  ...rule,
  sourceTrace: rule.sourceTrace ?? `amazon.us.detail.${rule.canonicalField}.v1`,
});

const directRule = (
  canonicalField: string,
  priority: "P0" | "P1" | "P2",
  fieldNature: Exclude<AmazonDetailFieldNature, "BLOCKED">,
  pageRegion: string,
  selectorCandidates: readonly string[],
  parser: string,
  validator: string,
  targetStorage: string,
  options: Partial<Pick<AmazonDetailFieldRule, "labelAliases" | "missingBehavior" | "ambiguityBehavior" | "sourceTrace">> = {},
): AmazonDetailFieldRule => defineRule({
  canonicalField,
  priority,
  fieldNature,
  pageRegion,
  labelAliases: options.labelAliases ?? [],
  selectorCandidates,
  parser,
  validator,
  missingBehavior: options.missingBehavior ?? "return_null_with_selector_not_found",
  ambiguityBehavior: options.ambiguityBehavior ?? "conflicting_values_return_ambiguous",
  targetStorage,
  ...(options.sourceTrace ? { sourceTrace: options.sourceTrace } : {}),
});

const blockedRule = (canonicalField: string, reason: string): AmazonDetailFieldRule => defineRule({
  canonicalField,
  priority: "BLOCKED",
  fieldNature: "BLOCKED",
  pageRegion: "blocked_no_source_contract",
  labelAliases: [],
  selectorCandidates: [],
  parser: "never",
  validator: "always_reject",
  missingBehavior: "omit_value",
  ambiguityBehavior: "not_applicable",
  targetStorage: null,
  sourceTrace: `blocked:${reason}`,
});

export const AMAZON_DETAIL_PRODUCT_ROOT_SELECTORS = ["#dp", "#dp-container", "#ppd"] as const;

export const AMAZON_DETAIL_SPECIFICATION_ROW_SELECTORS = PRODUCT_SPEC_ROWS;

export const AMAZON_DETAIL_FIELD_REGISTRY: readonly AmazonDetailFieldRule[] = [
  directRule("asin", "P0", "DIRECT_FACT", "primary_product_identity", ["input#ASIN", "input[name='ASIN']"], "asin_anchor", "asin_matches_expected_and_url", "basic.asin", { labelAliases: ["ASIN"] }),
  directRule("title", "P0", "DIRECT_FACT", "primary_product_title", ["#productTitle"], "text", "non_empty_bounded_text", "basic.title", { ambiguityBehavior: "prefix_superset_takes_fullest_else_conflicting" }),
  directRule("brand", "P0", "DIRECT_FACT", "primary_product_identity_or_specifications", ["#bylineInfo", "#brand"], "brand", "non_empty_bounded_text", "basic.brand", { labelAliases: ["Brand", "Brand Name"], ambiguityBehavior: "normalize_ui_prefix_then_reject_conflict" }),
  directRule("productUrl", "P0", "DIRECT_FACT", "bound_current_page_url", [], "canonical_product_url", "https_amazon_us_url_matches_asin", "basic.productUrl"),
  directRule("marketplace", "P0", "DIRECT_FACT", "validated_capture_context", [], "validated_marketplace", "us_preflight_and_amazon_com_host_required", "provenance.marketplace"),
  directRule("price", "P0", "DIRECT_FACT", "primary_buy_box", [
    "#corePrice_feature_div .apex-pricetopay-value .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    ".priceToPay .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
  ], "usd_price", "single_positive_amount_and_currency", "basic.price"),
  directRule("currency", "P0", "DIRECT_FACT", "same_primary_buy_box_price_node", [
    "#corePrice_feature_div .apex-pricetopay-value .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    ".priceToPay .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
  ], "price_currency", "must_share_price_source_and_be_usd", "basic.price.currency"),
  directRule("rating", "P0", "DIRECT_FACT", "primary_product_rating_summary", ["#acrPopover .a-icon-alt"], "rating", "number_between_zero_and_five", "basic.rating"),
  directRule("reviewCount", "P0", "DIRECT_FACT", "primary_product_rating_summary", ["#acrCustomerReviewText"], "integer_count", "non_negative_integer", "basic.reviewCount"),
  directRule("bsrRanks", "P0", "DIRECT_FACT", "primary_product_rank_rows", DETAIL_RANK_ROWS, "bsr_ranks", "positive_rank_and_non_empty_category", "extended.bsrRanks", { labelAliases: ["Best Sellers Rank"], missingBehavior: "empty_array_with_selector_not_found", ambiguityBehavior: "dedupe_exact_rank_category_and_preserve_dom_order" }),
  directRule("primaryBsr", "P0", "DERIVED_FACT", "derived_from_bsr_ranks", [], "first_valid_bsr_rank", "first_rank_in_page_order_with_rule_version", "market.bsr_and_provenance", { missingBehavior: "null_when_no_valid_ranks", ambiguityBehavior: "fixed_primary_bsr_v1_projection" }),
  directRule("subCategoryBsr", "P2", "DERIVED_FACT", "derived_from_bsr_ranks", [], "first_sub_category_bsr_rank", "first_rank_in_a_different_category_with_rule_version", "market.subCategoryBsr", { missingBehavior: "null_when_no_sub_category_rank", ambiguityBehavior: "fixed_sub_category_bsr_v1_projection" }),
  directRule("categoryPath", "P0", "DIRECT_FACT", "primary_product_breadcrumbs", ["#wayfinding-breadcrumbs_feature_div a", "#wayfinding-breadcrumbs_container a"], "ordered_text_list", "non_empty_unique_bounded_items", "extended.categoryPath", { missingBehavior: "empty_array_with_selector_not_found", ambiguityBehavior: "preserve_order_and_dedupe" }),
  directRule("dateFirstAvailable", "P0", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "date_with_raw_text", "preserve_raw_and_normalize_supported_date_only", "market.dateFirstAvailable_and_extended" , { labelAliases: ["Date First Available", "Date First Listed"] }),
  directRule("bulletPoints", "P0", "DIRECT_FACT", "primary_product_feature_bullets", ["#feature-bullets li .a-list-item", "#feature-bullets li span.a-list-item"], "ordered_text_list", "non_empty_bounded_items", "basic.features_and_extended.bulletPoints", { missingBehavior: "empty_array_with_selector_not_found", ambiguityBehavior: "preserve_dom_order_and_dedupe" }),
  directRule("mainImage", "P0", "DIRECT_FACT", "primary_product_main_image", ["#landingImage", "#imgTagWrapperId img"], "image_url", "https_https_url", "basic.images[0]"),
  directRule("material", "P1", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "specification_text", "non_empty_bounded_text", "extended.material", { labelAliases: ["Material", "Material Type"] }),
  directRule("packageDimensions", "P1", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "package_dimensions", "explicit_package_label_and_valid_measurement", "extended.packageDimensions", { labelAliases: ["Package Dimensions", "Shipping Dimensions"] }),
  directRule("packageWeight", "P1", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "package_weight", "explicit_package_or_shipping_label_and_valid_weight", "extended.packageWeight", { labelAliases: ["Package Weight", "Shipping Weight"] }),
  directRule("itemDimensions", "P1", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "item_dimensions", "explicit_item_or_product_label_and_valid_measurement", "extended.itemDimensions", { labelAliases: ["Item Dimensions", "Product Dimensions", "Item Dimensions L x W x H", "Item Dimensions W x H"] }),
  directRule("itemWeight", "P1", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "item_weight", "explicit_item_weight_label_and_valid_weight", "extended.itemWeight", { labelAliases: ["Item Weight"] }),
  directRule("seller", "P1", "DIRECT_FACT", "primary_buy_box_seller", ["#tabular-buybox-container #sellerProfileTriggerId", "#desktop_buybox #sellerProfileTriggerId", "#sellerProfileTriggerId", "#merchant-info a"], "buy_box_seller", "bound_to_primary_buy_box", "extended.seller"),
  directRule("shipsFrom", "P1", "DIRECT_FACT", "primary_buy_box_fulfillment_rows", ["#tabular-buybox-container", "#desktop_buybox", "#buybox"], "ships_from", "bound_to_primary_buy_box", "extended.shipsFrom", { labelAliases: ["Ships from"] }),
  directRule("fulfillment", "P1", "DERIVED_FACT", "derived_from_primary_buy_box_seller_and_ships_from", [], "fulfillment_from_seller_and_shipper", "source_fields_and_rule_version_required", "extended.fulfillment", { missingBehavior: "unknown_without_both_source_fields", ambiguityBehavior: "fixed_fulfillment_v1_rule" }),
  directRule("galleryImages", "P1", "DIRECT_FACT", "primary_product_image_gallery", ["#altImages img", "#imageBlock img"], "image_url_list", "https_https_unique_bounded_urls", "extended.images", { missingBehavior: "empty_array_with_selector_not_found", ambiguityBehavior: "dedupe_and_preserve_dom_order" }),
  directRule("ratingDistribution", "P1", "ESTIMATED_METRIC", "primary_product_rating_distribution", ["#histogramTable tr", "#reviewsMedley .a-histogram-row"], "rating_distribution", "stars_one_to_five_and_percent_zero_to_hundred", "extended.ratingDistribution", { missingBehavior: "empty_object_with_selector_not_found", ambiguityBehavior: "conflicting_star_values_are_ambiguous" }),
  directRule("variations", "P2", "CONDITIONAL_FACT", "primary_product_variation_selector", ["#twister option", "#twister .a-button-text", "#variation_size_name option", "#variation_color_name option", "#variation_pattern_name option"], "variation_options", "bounded_and_scoped_to_target_product", "extended.variations", { missingBehavior: "empty_array_with_selector_not_found", ambiguityBehavior: "dedupe_exact_options_and_preserve_dom_order" }),
  directRule("parentAsin", "P2", "CONDITIONAL_FACT", "primary_product_parent_child_relation", ["#variation_parent"], "parent_asin", "valid_distinct_asin_with_explicit_parent_label", "extended.parentAsin", { labelAliases: ["Parent ASIN"], missingBehavior: "null_without_explicit_relation", ambiguityBehavior: "conflicting_parent_ids_are_ambiguous" }),
  directRule("listPrice", "P2", "CONDITIONAL_FACT", "primary_buy_box_list_price", [".basisPrice .a-offscreen", ".a-text-price .a-offscreen", "#listPrice"], "usd_price", "same_currency_as_current_primary_price", "extended.listPrice"),
  directRule("coupon", "P2", "CONDITIONAL_FACT", "primary_buy_box_coupon", [".couponBadge", "#couponText", ".s-coupon-unclipped", "[data-cy='coupon']"], "coupon", "bounded_and_currency_checked", "extended.coupon"),
  directRule("boughtPastMonth", "P2", "ESTIMATED_METRIC", "primary_product_social_proof", ["#social-proofing-faceout", "[data-cy='social-proofing-faceout']"], "bought_past_month_estimate", "raw_text_and_estimate_qualifier_required", "extended.boughtPastMonth", { missingBehavior: "null_when_not_observed", ambiguityBehavior: "conflicting_counts_are_ambiguous" }),
  directRule("rawSpecifications", "P2", "DIRECT_FACT", "primary_product_specifications", PRODUCT_SPEC_ROWS, "bounded_specifications", "row_count_key_value_and_total_payload_limits", "extended.rawSpecifications", { missingBehavior: "empty_array_when_absent", ambiguityBehavior: "dedupe_exact_label_value_preserve_region_order" }),
  directRule("productDescription", "P2", "DIRECT_FACT", "primary_product_description_not_aplus", ["#productDescription"], "bounded_description", "non_empty_and_maximum_length", "extended.productDescription"),
  directRule("aPlusPresence", "P2", "DIRECT_FACT", "primary_product_aplus_module", ["#aplus .aplus-v2", "#aplus_feature_div .aplus-v2", "#dpx-aplus-container .aplus-v2"], "presence_boolean", "presence_requires_non_empty_target_module", "extended.aPlusPresence"),
  blockedRule("fbaFee", "no_direct_detail_fact_contract"),
  blockedRule("estimatedMonthlySales", "not_derivable_from_detail_social_proof"),
  blockedRule("estimatedMonthlyRevenue", "not_derivable_from_detail_social_proof"),
];

export function getAmazonDetailFieldRule(canonicalField: string): AmazonDetailFieldRule | null {
  return AMAZON_DETAIL_FIELD_REGISTRY.find((rule) => rule.canonicalField === canonicalField) ?? null;
}

export function listAmazonDetailSnapshotSelectors(): string[] {
  return [...new Set(AMAZON_DETAIL_FIELD_REGISTRY.flatMap((rule) => rule.selectorCandidates))];
}
