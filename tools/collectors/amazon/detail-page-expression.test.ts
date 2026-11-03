/**
 * V3 Final Operability Correction — P1-A：表达式工件同步与 minify 安全测试
 *
 * 1. 同步校验：browser-runtime 字符串工件（detail-page-expression-source.ts）在
 *    fake DOM 上的执行结果，必须与 Node 侧 TS 函数版（detail-page-extract.ts）
 *    完全一致（防双份漂移）。
 * 2. Minify 安全：表达式必须自包含——IIFE 内声明的标识符必须覆盖全部引用
 *    （未声明标识符扫描），且可在独立 Function 作用域执行无 ReferenceError。
 */
import { describe, expect, it } from "vitest";
import {
  buildAmazonDetailPageExtractionExpression,
  buildAmazonProductInfoExtractionExpression,
  DETAIL_PAGE_EXTRACTOR_SOURCE,
  PRODUCT_INFO_EXTRACTOR_SOURCE,
} from "@/tools/collectors/amazon/detail-page-expression-source";
import {
  buildAmazonDetailPageSnapshotExpression,
  isAmazonDetailPageDomSnapshot,
} from "@/tools/collectors/amazon/detail-page-snapshot-expression";
import { extractAmazonDetailPageV2 } from "@/tools/collectors/amazon/detail-page-extract-v2";
import {
  extractAmazonDetailPage,
  extractAmazonProductInfo,
  type AmazonDetailPageExtractionOptions,
} from "@/tools/collectors/amazon/detail-page-extract";

/* ── fake DOM（覆盖查询选择器/子节点/文本读取的最小实现） ── */

function fakeDom(nodes: Record<string, { textContent?: string | null; innerText?: string; rows?: Array<{ textContent: string }>; value?: string | null } | null>) {
  const querySelector = (selector: string) => {
    const node = nodes[selector];
    if (!node) return null;
    return {
      textContent: node.textContent ?? null,
      querySelectorAll: (childSelector: string) => {
        if (childSelector === "tr, li" && node.rows) {
          return node.rows.map((row) => ({ textContent: row.textContent }));
        }
        return [] as unknown[];
      },
      value: node.value ?? null,
      getAttribute: (name: string) => name === "value" ? node.value ?? null : null,
    } as unknown;
  };
  return {
    querySelector,
    querySelectorAll: () => [] as unknown[],
    body: { innerText: nodes["#body"]?.innerText ?? null },
  } as unknown;
}

function options(overrides: Partial<AmazonDetailPageExtractionOptions> = {}): AmazonDetailPageExtractionOptions {
  return {
    expectedAsin: "B0TEST0001",
    capturedAt: "2026-08-16T00:00:00.000Z",
    collectorVersion: "amazon-detail-page-extractor.v1",
    ...overrides,
  };
}

function runExpression(dom: unknown, opts: AmazonDetailPageExtractionOptions, url = "https://www.amazon.com/dp/B0TEST0001") {
  const expression = buildAmazonDetailPageExtractionExpression(opts);
  const runner = Function("document", "location", `return ${expression}`) as (
    doc: unknown,
    loc: { href: string },
  ) => unknown;
  return runner(dom, { href: url });
}

describe("detail-page expression source（P1-A）", () => {
  it("expressions are self-contained: every identifier is declared inside the IIFE", () => {
    const source = DETAIL_PAGE_EXTRACTOR_SOURCE;
    // 固定名 helper 全部显式声明
    for (const name of [
      "sanitizeDetailText", "normalizeAsin", "parseAsinFromDetailUrl",
      "parseDetailPrice", "detectDetailPriceCurrency", "parseDetailRating",
      "parseDetailReviewCount", "parseDetailBsr", "detectDetailPageStatus",
      "readDetailPageAsinAnchor", "readDetailPageBsrText", "unknownField",
      "correctField", "readFirstText", "extractAmazonDetailPage",
    ]) {
      expect(source).toContain(`function ${name}(`);
    }
    // 不依赖任何模块级/闭包标识符（只有浏览器全局 document/location/URL/Number/RegExp 等）
    expect(source).not.toMatch(/functionSource/);
    expect(source).not.toMatch(/import\s/);
    expect(source).not.toMatch(/require\(/);
  });

  it("executes in an isolated Function scope without ReferenceError (minify-safe)", () => {
    const dom = fakeDom({ "#productTitle": { textContent: "Test Bottle" } });
    expect(() => runExpression(dom, options())).not.toThrow();
  });

  it("matches the Node-side TS extractor on a valid detail page", () => {
    const dom = fakeDom({
      "#body": { innerText: "Test Bottle product page" },
      "#productTitle": { textContent: "Test Bottle" },
      "#detailBullets_feature_div": { rows: [{ textContent: "ASIN: B0TEST0001" }] },
      "#corePrice_feature_div .a-offscreen": { textContent: "$24.99" },
      "#acrPopover .a-icon-alt": { textContent: "4.6 out of 5 stars" },
      "#acrCustomerReviewText": { textContent: "1,234 ratings" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(true);
    expect(fromExpression.fields.price.value).toBe(24.99);
    expect(fromExpression.fields.reviews.value).toBe(1234);
  });

  it("matches on AirPods Pro B0BDHWDR12 layout with Unicode LRM mark in techSpec table", () => {
    const dom = fakeDom({
      "#body": { innerText: "Apple AirPods Pro product page" },
      "#productTitle": { textContent: "Apple AirPods Pro (2nd Gen)" },
      "#productDetails_techSpec_section_1": {
        rows: [{ textContent: "ASIN \u200EB0BDHWDR12" }],
      },
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": { textContent: "$199.00" },
      "#acrPopover .a-icon-alt": { textContent: "4.7 out of 5 stars" },
      "#acrCustomerReviewText": { textContent: "57,930 ratings" },
    });
    const opts = options({ expectedAsin: "B0BDHWDR12" });
    const fromExpression = runExpression(dom, opts, "https://www.amazon.com/dp/B0BDHWDR12") as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0BDHWDR12", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(true);
    expect(fromExpression.expectedAsin).toBe("B0BDHWDR12");
    expect(fromExpression.pageAsin).toBe("B0BDHWDR12");
    expect(fromExpression.fields.asin.value).toBe("B0BDHWDR12");
    expect(fromExpression.fields.price.value).toBe(199.0);
    expect(fromExpression.fields.rating.value).toBe(4.7);
    expect(fromExpression.fields.reviews.value).toBe(57930);
  });

  it("uses the current product-scoped hidden ASIN input when detail tables omit the ASIN row", () => {
    const dom = fakeDom({
      "#body": { innerText: "Amazon Echo Dot product page" },
      "#productTitle": { textContent: "Amazon Echo Dot (3rd Gen)" },
      "#dp input#ASIN": { value: "B0TEST0001" },
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": { textContent: "$29.99" },
      "#acrPopover .a-icon-alt": { textContent: "4.7 out of 5 stars" },
      "#acrCustomerReviewText": { textContent: "1,037 ratings" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageAsin).toBe("B0TEST0001");
    expect(fromExpression.entityBound).toBe(true);
  });

  it("matches on new buybox price container (V3R)", () => {
    const dom = fakeDom({
      "#body": { innerText: "Test Bottle product page" },
      "#productTitle": { textContent: "Test Bottle" },
      "#detailBullets_feature_div": { rows: [{ textContent: "ASIN: B0TEST0001" }] },
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": { textContent: "$39.99" },
      "#acrPopover .a-icon-alt": { textContent: "4.6 out of 5 stars" },
      "#acrCustomerReviewText": { textContent: "1,234 ratings" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.fields.price.value).toBe(39.99);
  });

  it("skips a whitespace-only priority price node and reads the next visible price", () => {
    const dom = fakeDom({
      "#body": { innerText: "Test Bottle product page" },
      "#productTitle": { textContent: "Test Bottle" },
      "#detailBullets_feature_div": { rows: [{ textContent: "ASIN: B0TEST0001" }] },
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": { textContent: " " },
      "#corePrice_feature_div .a-offscreen": { textContent: "$48.95" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.fields.price).toMatchObject({ status: "correct", value: 48.95 });
  });

  it("matches on ASIN mismatch (entity not bound, all fields unknown)", () => {
    const dom = fakeDom({
      "#body": { innerText: "Test Bottle product page" },
      "#productTitle": { textContent: "Test Bottle" },
      "#detailBullets_feature_div": { rows: [{ textContent: "ASIN: B0OTHER0001" }] },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(false);
    expect(fromExpression.bindingProof.pageAnchorMatchesExpected).toBe(false);
    expect(fromExpression.fields.title.reason).toBe("page_asin_anchor_mismatch");
  });

  it("matches on login wall page status", () => {
    const dom = fakeDom({
      "#body": { innerText: "Please sign in to continue" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageStatus).toBe("login_wall");
  });

  it.each([
    "Click the button below to continue shopping",
    "Continue shopping",
  ])("classifies Amazon %s interstitial as automation_blocked (not a login wall)", (bodyText) => {
    const dom = fakeDom({ "#body": { innerText: bodyText } });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageStatus).toBe("automation_blocked");
    expect(fromExpression.pageStatus).not.toBe("login_wall");
    expect(fromExpression.entityBound).toBe(false);
  });

  it("classifies the /errors_page/validateCaptcha gateway as automation_blocked from the form action alone", () => {
    const dom = fakeDom({
      "#body": { innerText: "Amazon.com Conditions of Use Privacy Policy" },
      "form[action*='validateCaptcha']": { textContent: "Continue shopping" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageStatus).toBe("automation_blocked");
    expect(fromExpression.pageStatus).not.toBe("login_wall");
  });

  it("keeps a real sign-in wall as login_wall", () => {
    const dom = fakeDom({ "#body": { innerText: "Please sign in to continue" } });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageStatus).toBe("login_wall");
  });

  it("matches on captcha page status", () => {
    const dom = fakeDom({
      "#body": { innerText: "Enter the characters you see below" },
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.pageStatus).toBe("captcha");
  });

  it("matches when required fields are missing (unknown + reason)", () => {
    const dom = fakeDom({
      "#body": { innerText: "Test Bottle product page" },
      "#productTitle": { textContent: "Test Bottle" },
      "#detailBullets_feature_div": { rows: [{ textContent: "ASIN: B0TEST0001" }] },
      // 无价格/评分/评论节点 → selector_not_found
    });
    const opts = options();
    const fromExpression = runExpression(dom, opts) as ReturnType<typeof extractAmazonDetailPage>;
    const fromNode = extractAmazonDetailPage(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(true);
    expect(fromExpression.fields.price.reason).toBe("selector_not_found");
    expect(fromExpression.fields.rating.reason).toBe("selector_not_found");
  });

  it("serializes options via placeholder without template interpolation issues", () => {
    const expression = buildAmazonDetailPageExtractionExpression(options({ capturedAt: "2026-08-16T00:00:00.000Z" }));
    expect(expression).not.toContain("__OPTIONS__");
    expect(expression).toContain('"capturedAt":"2026-08-16T00:00:00.000Z"');
    expect(expression).toContain('"expectedAsin":"B0TEST0001"');
  });
});

// ── V3 Final PHASE 1 — Product Info 表达式工件（自包含 + Node 侧 parity） ──

describe("product-info expression source (PHASE 1)", () => {
  function productInfoDom(rows: Array<[string, string]>) {
    const trNodes = rows.map(([label, value]) => ({
      textContent: null,
      querySelectorAll: (selector: string) => {
        if (selector === "td, th") return [{ textContent: label }, { textContent: value }];
        return [];
      },
    }));
    const container = {
      textContent: null,
      querySelectorAll: (selector: string) => {
        if (selector === "table.a-keyvalue.prodDetTable tr") return trNodes;
        return [];
      },
    };
    const detailBullets = {
      textContent: null,
      querySelectorAll: (selector: string) => {
        if (selector === "tr, li") return [{ textContent: "ASIN: B0TEST0001" }];
        return [];
      },
    };
    return {
      querySelector: (selector: string) => {
        switch (selector) {
          case "#productTitle": return { textContent: "Test Bottle" };
          case "#productDetails_expanderTables_depthLeftSections": return container;
          case "#productDetails_expanderTables_depthRightSections": return null;
          case "#productOverview_feature_div": return null;
          case "#detailBullets_feature_div": return detailBullets;
          default: return null;
        }
      },
      querySelectorAll: (selector: string) => {
        if (selector === "#productDetails_expanderTables_depthLeftSections") return [container];
        return [];
      },
      body: { innerText: "Test Bottle product page" },
    };
  }

  function runProductInfoExpression(dom: unknown, opts: AmazonDetailPageExtractionOptions) {
    const expression = buildAmazonProductInfoExtractionExpression(opts);
    const runner = Function("document", "location", `return ${expression}`) as (
      doc: unknown,
      loc: { href: string },
    ) => unknown;
    return runner(dom, { href: "https://www.amazon.com/dp/B0TEST0001" });
  }

  it("is self-contained: helpers declared inside IIFE, no module identifiers", () => {
    expect(PRODUCT_INFO_EXTRACTOR_SOURCE).toContain("function readProductInfoRows(");
    expect(PRODUCT_INFO_EXTRACTOR_SOURCE).toContain("function mapProductInfoToCanonical(");
    expect(PRODUCT_INFO_EXTRACTOR_SOURCE).toContain("function extractAmazonProductInfo(");
    expect(PRODUCT_INFO_EXTRACTOR_SOURCE).not.toMatch(/import\s|require\(/);
  });

  it("matches the Node-side TS extractor on a spec-table page", () => {
    const dom = productInfoDom([
      ["Material Type", "Stainless Steel"],
      ["Item Weight", "0.22 kg"],
      ["FBA Fee", "$5.12"],
    ]);
    const opts = options();
    const fromExpression = runProductInfoExpression(dom, opts) as ReturnType<typeof extractAmazonProductInfo>;
    const fromNode = extractAmazonProductInfo(dom as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(true);
    expect(fromExpression.canonicalFacts.material).toBe("Stainless Steel");
    expect(fromExpression.canonicalFacts.item_weight).toBe("0.22 kg");
    expect(fromExpression.canonicalFacts.fba_fee).toBeUndefined();
    expect(fromExpression.rows).toHaveLength(2);
  });

  it("fails closed on ASIN mismatch (no rows, no canonicalFacts)", () => {
    const dom = productInfoDom([["Material Type", "Stainless Steel"]]);
    // 修改 ASIN 锚点为不匹配值
    const mismatched = {
      ...dom,
      querySelector: (selector: string) => {
        if (selector === "#detailBullets_feature_div") {
          return { textContent: null, querySelectorAll: () => [{ textContent: "ASIN: B0OTHER0001" }] };
        }
        return dom.querySelector(selector);
      },
    };
    const opts = options();
    const fromExpression = runProductInfoExpression(mismatched, opts) as ReturnType<typeof extractAmazonProductInfo>;
    const fromNode = extractAmazonProductInfo(mismatched as never, "https://www.amazon.com/dp/B0TEST0001", opts);
    expect(fromExpression).toEqual(fromNode);
    expect(fromExpression.entityBound).toBe(false);
    expect(fromExpression.rows).toEqual([]);
    expect(fromExpression.canonicalFacts).toEqual({});
  });
});

describe("Amazon detail V2 snapshot expression", () => {
  it("fails closed when a hidden title node exposes conflicting textContent beside the main title", () => {
    // Synthetic DOM only: this proves a possible parser path, not what any strict5 page contained.
    const makeTitleNode = (textContent: string, innerText: string) => ({
      textContent,
      innerText,
      value: undefined,
      selected: undefined,
      getAttribute() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
    });
    const mainTitle = makeTitleNode("Main product title", "Main product title");
    const hiddenTitle = makeTitleNode("Hidden stale variant title", "");
    const asinAnchor = {
      textContent: null,
      innerText: "",
      value: "B0TEST0001",
      selected: undefined,
      getAttribute(name: string) { return name === "value" ? "B0TEST0001" : null; },
      querySelectorAll() { return []; },
      closest() { return null; },
    };
    const nodesBySelector: Record<string, unknown[]> = {
      "#productTitle": [mainTitle, hiddenTitle],
      "input#ASIN": [asinAnchor],
    };
    const productRoot = {
      contains() { return true; },
      querySelector(selector: string) { return nodesBySelector[selector]?.[0] ?? null; },
      querySelectorAll(selector: string) { return nodesBySelector[selector] ?? []; },
    };
    const document = {
      body: { innerText: "Amazon product page" },
      querySelector(selector: string) { return selector === "#dp" ? productRoot : null; },
      querySelectorAll() { return []; },
    };
    const expression = buildAmazonDetailPageSnapshotExpression();
    const runner = Function("document", "location", `return ${expression}`) as (
      doc: unknown,
      location: { href: string },
    ) => unknown;
    const snapshot = runner(document, { href: "https://www.amazon.com/dp/B0TEST0001" });

    expect(isAmazonDetailPageDomSnapshot(snapshot)).toBe(true);
    const typedSnapshot = snapshot as { candidates: Record<string, Array<{ text: string | null }>> };
    expect(typedSnapshot.candidates["#productTitle"]?.map((candidate) => candidate.text)).toEqual([
      "Main product title",
      "Hidden stale variant title",
    ]);
    const result = extractAmazonDetailPageV2(snapshot as never, {
      expectedAsin: "B0TEST0001",
      capturedAt: "2026-10-13T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });

    expect(result.entityBound).toBe(true);
    expect(result.registeredFields.title).toMatchObject({
      status: "ambiguous",
      value: null,
      reason: "conflicting_candidates",
    });
  });

  it("collects only bounded target-root evidence and feeds the shared Node field registry parser", () => {
    const makeNode = (input: {
      text?: string | null;
      value?: string | null;
      attributes?: Record<string, string>;
      children?: Record<string, unknown[]>;
      closest?: Record<string, unknown | null>;
      checked?: boolean;
    }) => ({
      textContent: input.text ?? null,
      innerText: input.text ?? null,
      value: input.value ?? undefined,
      checked: input.checked,
      selected: undefined,
      parentElement: undefined as unknown,
      getAttribute(name: string) { return input.attributes?.[name] ?? null; },
      closest(selector: string) { return input.closest?.[selector] ?? null; },
      querySelector() { return null; },
      querySelectorAll(selector: string) { return input.children?.[selector] ?? []; },
    });
    const cell = (text: string) => makeNode({ text });
    const rows = [
      makeNode({ text: "Brand Example Brand", children: { "th, td": [cell("Brand"), cell("Example Brand")] } }),
      makeNode({ text: "Item Dimensions 7 x 3 x 2 inches", children: { "th, td": [cell("Item Dimensions"), cell("7 x 3 x 2 inches")] } }),
    ];
    const selectorRows = "#productDetails_expanderTables_depthLeftSections table.a-keyvalue.prodDetTable tr";
    const primaryBuyBox = makeNode({});
    const optionRadio = makeNode({ checked: true, attributes: { type: "radio" } });
    const subscribeRadio = makeNode({ checked: false, attributes: { type: "radio" } });
    const purchaseOption = makeNode({
      text: "One-Time Purchase $19.99",
      children: { 'input[type="radio"], [role="radio"]': [optionRadio] },
    });
    const subscribeOption = makeNode({
      text: "Subscribe & Save $17.99",
      children: { 'input[type="radio"], [role="radio"]': [subscribeRadio] },
    });
    const makePriceCandidate = (text: string, className: string, color: string) => {
      const priceNode = makeNode({
        attributes: { class: className, "data-a-color": color, "data-a-size": "l" },
      });
      const candidateNode = makeNode({
        text,
        closest: {
          ".a-price": priceNode,
          "#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #corePriceDisplay_mobile_feature_div, #desktop_buybox, #buybox": primaryBuyBox,
        },
      });
      return { priceNode, candidateNode };
    };
    const current = makePriceCandidate("$19.99", "a-price aok-align-center", "price");
    const list = makePriceCandidate("$29.99", "a-price a-text-price", "secondary");
    const unit = makePriceCandidate("$1.30", "a-price apex-priceperunit-value", "price");
    const basis = makePriceCandidate("$87.99", "a-price apex-basisprice-value", "secondary");
    const subscribe = makePriceCandidate("$17.99", "a-price aok-align-center", "price");
    current.candidateNode.parentElement = purchaseOption;
    subscribe.candidateNode.parentElement = subscribeOption;
    const targetElements: Record<string, ReturnType<typeof makeNode> | Array<ReturnType<typeof makeNode>>> = {
      "input#ASIN": makeNode({ value: "B0TEST0001", attributes: { value: "B0TEST0001" } }),
      "#productTitle": makeNode({ text: "Target product title" }),
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": [current.candidateNode, list.candidateNode, unit.candidateNode, basis.candidateNode, subscribe.candidateNode],
    };
    const containedNodes = [primaryBuyBox, current, list, unit, basis, subscribe].flatMap((entry) =>
      "candidateNode" in entry ? [entry.candidateNode, entry.priceNode] : [entry],
    );
    const productRoot = {
      contains(node: unknown) { return containedNodes.includes(node as ReturnType<typeof makeNode>); },
      querySelector(selector: string) {
        const value = targetElements[selector];
        return Array.isArray(value) ? value[0] ?? null : value ?? null;
      },
      querySelectorAll(selector: string) {
        if (selector === selectorRows) return rows;
        const value = targetElements[selector];
        if (Array.isArray(value)) return value;
        return value ? [value] : [];
      },
    };
    const document = {
      body: { innerText: "Target product page" },
      querySelector(selector: string) { return selector === "#dp" ? productRoot : null; },
      querySelectorAll() { return []; },
    };
    const expression = buildAmazonDetailPageSnapshotExpression();
    const runner = Function("document", "location", `return ${expression}`) as (doc: unknown, location: { href: string }) => unknown;
    const snapshot = runner(document, { href: "https://www.amazon.com/dp/B0TEST0001" });

    expect(isAmazonDetailPageDomSnapshot(snapshot)).toBe(true);
    const result = extractAmazonDetailPageV2(snapshot as never, {
      expectedAsin: "B0TEST0001",
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    expect(result.entityBound).toBe(true);
    expect(result.registeredFields.brand?.value).toBe("Example Brand");
    expect(result.registeredFields.itemDimensions?.value).toMatchObject({ rawText: "7 x 3 x 2 inches" });
    expect(result.registeredFields.packageDimensions?.value).toBeNull();
    expect(result.fields.price.value).toBe(19.99);
    const priceCandidates = (snapshot as { candidates: Record<string, Array<{ priceContext?: unknown }>> }).candidates["#corePriceDisplay_desktop_feature_div .a-price .a-offscreen"];
    expect(priceCandidates[0]?.priceContext)
      .toMatchObject({ semanticRole: "current_pay_now", purchaseContext: "one_time", selected: true, inPrimaryBuyBox: true });
    expect(priceCandidates[4]?.priceContext)
      .toMatchObject({ purchaseContext: "subscribe_save", selected: false, inPrimaryBuyBox: true });
    expect(priceCandidates.map((candidate) => (candidate.priceContext as { semanticRole?: string } | null)?.semanticRole))
      .toEqual(["current_pay_now", "list_price", "unit_price", "basis_price", "subscribe_price"]);
    expect(priceCandidates[0]?.priceContext).not.toHaveProperty("optionText");
  });
});
