import {
  AMAZON_DETAIL_PRODUCT_ROOT_SELECTORS,
  AMAZON_DETAIL_SPECIFICATION_ROW_SELECTORS,
  listAmazonDetailSnapshotSelectors,
} from "./detail-page-field-registry";
import type { AmazonDetailPageDomSnapshot } from "./detail-page-extract-v2";

const SNAPSHOT_CONFIG = {
  productRootSelectors: AMAZON_DETAIL_PRODUCT_ROOT_SELECTORS,
  fieldSelectors: listAmazonDetailSnapshotSelectors(),
  specificationRowSelectors: AMAZON_DETAIL_SPECIFICATION_ROW_SELECTORS,
} as const;

export const AMAZON_DETAIL_PAGE_SNAPSHOT_EXPRESSION_SOURCE = `(() => {
  const config = __SNAPSHOT_CONFIG__;
  const clean = (value, maxLength = 1200) => {
    if (typeof value !== 'string') return null;
    const normalized = value
      .replace(/[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\uFEFF\\u202A-\\u202E]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  };
  const productRootSelector = config.productRootSelectors.find((selector) => document.querySelector(selector)) || null;
  const root = productRootSelector ? document.querySelector(productRootSelector) : null;
  const candidates = {};
  let totalCandidates = 0;
  const perSelectorLimit = 40;
  const totalLimit = 400;
  const readCandidate = (selector, node) => {
    const cells = typeof node.querySelectorAll === 'function' ? Array.from(node.querySelectorAll('th, td')) : [];
    const label = cells.length >= 2 ? clean(cells[0].textContent, 120) : null;
    const value = cells.length >= 2 ? clean(cells[cells.length - 1].textContent, 1200) : null;
    const oldHires = typeof node.getAttribute === 'function' ? node.getAttribute('data-old-hires') : null;
    const src = oldHires || (typeof node.getAttribute === 'function' ? node.getAttribute('src') : null);
    const href = typeof node.getAttribute === 'function' ? node.getAttribute('href') : null;
    const attributeValue = typeof node.value === 'string'
      ? node.value
      : (typeof node.getAttribute === 'function' ? node.getAttribute('value') : null);
    const ariaChecked = typeof node.getAttribute === 'function' ? node.getAttribute('aria-checked') : null;
    const selected = typeof node.selected === 'boolean'
      ? node.selected
      : ariaChecked === 'true'
        ? true
        : ariaChecked === 'false'
          ? false
          : null;
    const priceNodeCandidate = typeof node.closest === 'function' ? node.closest('.a-price') : null;
    const priceNode = priceNodeCandidate && (!root.contains || root.contains(priceNodeCandidate)) ? priceNodeCandidate : null;
    const primaryPriceRegionCandidate = typeof node.closest === 'function'
      ? node.closest('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #corePriceDisplay_mobile_feature_div, #desktop_buybox, #buybox')
      : null;
    const primaryPriceRegion = primaryPriceRegionCandidate && (!root.contains || root.contains(primaryPriceRegionCandidate))
      ? primaryPriceRegionCandidate
      : null;
    const priceClasses = [
      selector,
      typeof node.getAttribute === 'function' ? node.getAttribute('class') : null,
      priceNode && typeof priceNode.getAttribute === 'function' ? priceNode.getAttribute('class') : null,
      priceNode && typeof priceNode.getAttribute === 'function' ? priceNode.getAttribute('id') : null,
    ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
    const priceMetadataNode = priceNode || node;
    const priceAttribute = (name) => priceMetadataNode && typeof priceMetadataNode.getAttribute === 'function'
      ? priceMetadataNode.getAttribute(name)
      : null;
    const dataAColor = priceMetadataNode && typeof priceMetadataNode.getAttribute === 'function'
      ? clean(priceAttribute('data-a-color'), 80)
      : null;
    let semanticRole = 'unknown';
    if (/priceperunit|price-per-unit|apex-priceperunit/.test(priceClasses)) semanticRole = 'unit_price';
    else if (/basisprice|basis-price|apex-basisprice/.test(priceClasses)) semanticRole = 'basis_price';
    else if (/coupon/.test(priceClasses)) semanticRole = 'coupon';
    else if (/member/.test(priceClasses)) semanticRole = 'member_price';
    else if (/other.?offer|offer-listing|\\bolp\\b/.test(priceClasses)) semanticRole = 'other_offer';
    else if (/subscribe/.test(priceClasses)) semanticRole = 'subscribe_price';
    else if (/a-text-price|listprice|list-price/.test(priceClasses) || dataAColor === 'secondary') semanticRole = 'list_price';
    else if (/apex-pricetopay-value|priceblock_(our|deal)price/.test(priceClasses) || dataAColor === 'price') semanticRole = 'current_pay_now';
    let purchaseContext = 'not_applicable';
    let purchaseSelected = null;
    let purchaseOptionControlSeen = false;
    let ancestor = node;
    for (let depth = 0; ancestor && ancestor !== root && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
      const radios = typeof ancestor.querySelectorAll === 'function'
        ? Array.from(ancestor.querySelectorAll('input[type="radio"], [role="radio"]'))
        : [];
      if (radios.length > 0) purchaseOptionControlSeen = true;
      if (radios.length !== 1) continue;
      const optionText = clean(ancestor.innerText || ancestor.textContent, 500) || '';
      if (/subscribe\\s*(?:&|and)\\s*save|auto[\\s-]?deliver|recurring/i.test(optionText)) purchaseContext = 'subscribe_save';
      else if (/one[\\s-]?time|buy\\s+once|single\\s+purchase/i.test(optionText)) purchaseContext = 'one_time';
      else purchaseContext = 'unknown';
      const radio = radios[0];
      const radioAriaChecked = typeof radio.getAttribute === 'function' ? radio.getAttribute('aria-checked') : null;
      purchaseSelected = typeof radio.checked === 'boolean'
        ? radio.checked
        : radioAriaChecked === 'true'
          ? true
          : radioAriaChecked === 'false'
            ? false
            : null;
      break;
    }
    if (purchaseContext === 'not_applicable' && !purchaseOptionControlSeen && primaryPriceRegion
      && typeof primaryPriceRegion.querySelectorAll === 'function'
      && primaryPriceRegion.querySelectorAll('input[type="radio"], [role="radio"]').length > 0) {
      purchaseContext = 'unknown';
    } else if (purchaseContext === 'not_applicable' && purchaseOptionControlSeen) {
      purchaseContext = 'unknown';
    }
    if (purchaseContext === 'subscribe_save' && semanticRole === 'current_pay_now') semanticRole = 'subscribe_price';
    const isPriceSelector = /price|a-offscreen/i.test(selector);
    const priceContext = priceNode || isPriceSelector ? {
      id: clean(priceAttribute('id'), 120),
      className: clean(priceAttribute('class'), 200),
      dataAColor,
      dataASize: clean(priceAttribute('data-a-size'), 80),
      semanticRole,
      purchaseContext,
      selected: purchaseSelected,
      inPrimaryBuyBox: Boolean(primaryPriceRegion),
    } : null;
    return {
      selector,
      text: clean(node.innerText || node.textContent, selector === '#productDescription' ? 1200 : 500),
      label,
      value: clean(attributeValue, 1200),
      href: clean(href, 2048),
      src: clean(src, 2048),
      alt: clean(typeof node.getAttribute === 'function' ? node.getAttribute('alt') : null, 240),
      selected,
      priceContext,
    };
  };
  if (root) {
    for (const selector of config.fieldSelectors) {
      if (totalCandidates >= totalLimit) break;
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch (error) {
        nodes = [];
      }
      const bounded = nodes.slice(0, Math.min(perSelectorLimit, totalLimit - totalCandidates));
      if (bounded.length > 0) {
        candidates[selector] = bounded.map((node) => readCandidate(selector, node));
        totalCandidates += bounded.length;
      }
    }
  }
  const specificationRows = [];
  if (root) {
    for (const selector of config.specificationRowSelectors) {
      if (specificationRows.length >= 120) break;
      let rows = [];
      try {
        rows = Array.from(root.querySelectorAll(selector));
      } catch (error) {
        rows = [];
      }
      const region = /productDetails_expanderTables|productOverview_feature_div|productDetails_techSpec|productDetails_detailBullets_sections|prodDetails/i.test(selector)
        ? 'productSpecifications'
        : 'productDetailAttributes';
      for (const row of rows.slice(0, 60)) {
        if (specificationRows.length >= 120) break;
        const cells = typeof row.querySelectorAll === 'function' ? Array.from(row.querySelectorAll('th, td')) : [];
        const label = cells.length >= 2 ? clean(cells[0].textContent, 120) : null;
        const value = cells.length >= 2 ? clean(cells[cells.length - 1].textContent, 300) : null;
        const text = clean(row.innerText || row.textContent, 500);
        if (!label && !text) continue;
        specificationRows.push({ region, selector, label, value, text });
      }
    }
  }
  const bodyText = typeof document.body?.innerText === 'string' ? document.body.innerText.slice(0, 4000) : '';
  const hasProductTitle = Boolean(root && root.querySelector('#productTitle'));
  let pageStatus = 'unknown_page';
  if (/captcha|robot check|enter the characters you see|type the characters you see|验证码|机器人/i.test(bodyText)) pageStatus = 'captcha';
  else if (!hasProductTitle && (document.querySelector("form[action*='validateCaptcha']") || /click the button below to continue shopping|continue shopping/i.test(bodyText))) pageStatus = 'automation_blocked';
  else if (!hasProductTitle && /sign in to continue|login to continue|please sign in|登录后继续/i.test(bodyText)) pageStatus = 'login_wall';
  else if (/sorry[, ]+something went wrong|service unavailable|internal server error|页面出错/i.test(bodyText)) pageStatus = 'error_page';
  else if (hasProductTitle) pageStatus = 'ok';
  return {
    schemaVersion: 'amazon-detail-page-dom-snapshot.v1',
    pageUrl: location.href,
    pageStatus,
    productRootSelector,
    candidates,
    specificationRows,
  };
})()`;

export function buildAmazonDetailPageSnapshotExpression(): string {
  return AMAZON_DETAIL_PAGE_SNAPSHOT_EXPRESSION_SOURCE.replace("__SNAPSHOT_CONFIG__", JSON.stringify(SNAPSHOT_CONFIG));
}

export function isAmazonDetailPageDomSnapshot(value: unknown): value is AmazonDetailPageDomSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AmazonDetailPageDomSnapshot>;
  return record.schemaVersion === "amazon-detail-page-dom-snapshot.v1"
    && typeof record.pageUrl === "string"
    && typeof record.pageStatus === "string"
    && (record.productRootSelector === null || typeof record.productRootSelector === "string")
    && Boolean(record.candidates && typeof record.candidates === "object")
    && Array.isArray(record.specificationRows);
}
