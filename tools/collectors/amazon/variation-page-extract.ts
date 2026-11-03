export const AMAZON_VARIATION_PAGE_EXTRACTOR_VERSION = "amazon-variation-page-extractor.v1";

const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;

export type AmazonVariationOption = {
  dimensionKey: string;
  label: string | null;
  value: string;
};

export type AmazonVariationVariant = {
  asin: string;
  options: AmazonVariationOption[];
};

export type AmazonVariationCaptureStatus =
  | "COMPLETE"
  | "CAPTURED_PARTIAL"
  | "NO_VARIATION_WITH_EVIDENCE"
  | "EXTRACTION_EMPTY_RETRYABLE"
  | "PAGE_CHANGED"
  | "HUMAN_REQUIRED"
  | "NOT_ATTEMPTED";

export type AmazonVariationPageCapture = {
  status: AmazonVariationCaptureStatus;
  parentAsin: string | null;
  currentAsin: string;
  dimensions: Array<{ key: string; label: string | null; options: string[] }>;
  variantAsins: string[];
  variants: AmazonVariationVariant[];
  sourceUrl: string;
  capturedAt: string;
  identityProof: {
    urlAsin: string | null;
    pageAsin: string | null;
    productContainerFound: boolean;
    bound: boolean;
  };
  diagnostics: {
    variationRootFound: boolean;
    jsonStateFound: boolean;
    mappedVariantCount: number;
    labeledDimensionCount: number;
    domDimensionCount: number;
    /** 页面自己声明的维度顺序是否被采到并用于绑定（权威来源）。 */
    authoritativeDimensionOrder: boolean;
    authoritativeDimensionOrderSource: string | null;
    jsonScriptsMatched: number;
    jsonFieldsParsed: string[];
    everyMappedVariantHasDimensions: boolean;
    currentVariantMapped: boolean;
    asinMapKeys: string[];
    valueMapKeys: string[];
    valueMapLengths: Record<string, number>;
  };
};

type RawDomVariationGroup = {
  key: string;
  label: string | null;
  options: Array<{ value: string; asin: string | null }>;
};

export type RawVariationPage = {
  parentAsin?: unknown;
  dimensionToAsinMap?: unknown;
  dimensionValuesDisplayData?: unknown;
  variationDisplayLabels?: unknown;
  /**
   * 页面**自己声明**的维度顺序（如 ["size_name","color_name"]）。
   * 与 `variation_values` / `dimToAsinMap` 共同构成权威映射：
   * `dimToAsinMap` 的键是「各维度在该维度值列表中的索引」按下划线拼接。
   * 三者齐备时可**严格**还原「ASIN → 维度名 → 维度值」，无需依赖 DOM 选项。
   */
  dimensions?: unknown;
  /** 各维度的完整可选值列表（键为维度名）。 */
  variationValues?: unknown;
  /** 维度顺序的权威来源标识（twisterJSInitData）。 */
  dimensionOrderSource?: unknown;
  domGroups?: unknown;
  variationRootFound?: unknown;
  explicitNoVariation?: unknown;
  jsonStateFound?: unknown;
  jsonStateDiagnostics?: unknown;
};

export function buildAmazonVariationPageExtractionExpression(): string {
  return `(async () => {
    const clean = (value, max = 180) => typeof value === 'string'
      ? value.replace(/[\\u0000-\\u001F\\u007F]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max) || null
      : null;
    const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
    const keys = ['dimensionToAsinMap', 'dimensionValuesDisplayData', 'variationDisplayLabels'];
    const candidates = [];
    const visit = (value, depth = 0, budget = { nodes: 0 }) => {
      budget.nodes += 1;
      if (!isRecord(value) || depth > 8 || budget.nodes > 2500) return;
      if (keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) candidates.push(value);
      for (const child of Object.values(value)) visit(child, depth + 1, budget);
    };
    const parseJson = (source) => {
      try { visit(JSON.parse(source)); } catch (_) { }
    };
    const readLiteral = (source, offset) => {
      let cursor = offset;
      let nodes = 0;
      const skipSpace = () => { while (/\\s/.test(source[cursor] || '')) cursor += 1; };
      const parseString = () => {
        const quote = source[cursor++];
        let value = '';
        while (cursor < source.length && cursor < offset + 200000) {
          const character = source[cursor++];
          if (character === quote) return value;
          if (character !== '\\\\') { value += character; continue; }
          const escaped = source[cursor++];
          if (escaped === 'n') value += '\\n';
          else if (escaped === 'r') value += '\\r';
          else if (escaped === 't') value += '\\t';
          else if (escaped === 'b') value += '\\b';
          else if (escaped === 'f') value += '\\f';
          else if (escaped === 'u') {
            const code = source.slice(cursor, cursor + 4);
            if (!/^[0-9a-f]{4}$/i.test(code)) return null;
            value += String.fromCharCode(parseInt(code, 16));
            cursor += 4;
          } else value += escaped || '';
        }
        return null;
      };
      const parseValue = (depth = 0) => {
        nodes += 1;
        if (depth > 12 || nodes > 5000) return null;
        skipSpace();
        const first = source[cursor];
        if (first === '"' || first === "'") return parseString();
        if (first === '{') {
          cursor += 1;
          const result = {};
          while (cursor < source.length && cursor < offset + 200000) {
            skipSpace();
            if (source[cursor] === '}') { cursor += 1; return result; }
            let key;
            if (source[cursor] === '"' || source[cursor] === "'") key = parseString();
            else {
              const keyStart = cursor;
              while (cursor < source.length && !/[\\s:]/.test(source[cursor])) cursor += 1;
              key = source.slice(keyStart, cursor);
            }
            skipSpace();
            if (typeof key !== 'string' || !key || source[cursor] !== ':') return null;
            cursor += 1;
            const value = parseValue(depth + 1);
            if (value === null && source[cursor - 1] !== 'l') return null;
            result[key] = value;
            skipSpace();
            if (source[cursor] === ',') { cursor += 1; continue; }
            if (source[cursor] === '}') { cursor += 1; return result; }
            return null;
          }
          return null;
        }
        if (first === '[') {
          cursor += 1;
          const result = [];
          while (cursor < source.length && cursor < offset + 200000) {
            skipSpace();
            if (source[cursor] === ']') { cursor += 1; return result; }
            const value = parseValue(depth + 1);
            result.push(value);
            skipSpace();
            if (source[cursor] === ',') { cursor += 1; continue; }
            if (source[cursor] === ']') { cursor += 1; return result; }
            return null;
          }
          return null;
        }
        const tokenStart = cursor;
        while (cursor < source.length && !/[\\s,}\\]]/.test(source[cursor])) cursor += 1;
        const token = source.slice(tokenStart, cursor);
        if (token === 'true') return true;
        if (token === 'false') return false;
        if (token === 'null') return null;
        if (/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/u.test(token)) return Number(token);
        return null;
      };
      return parseValue();
    };
    const readField = (source, key) => {
      const pattern = new RegExp('"?' + key + '"?\\\\s*:', 'g');
      let match;
      while ((match = pattern.exec(source))) {
        const parsed = readLiteral(source, pattern.lastIndex);
        if (parsed !== null) return parsed;
      }
      return null;
    };
    const scripts = Array.from(document.querySelectorAll('script')).slice(0, 800);
    const jsonStateDiagnostics = { scriptsScanned: scripts.length, scriptsMatched: 0, parsedFields: [] };
    for (const script of scripts) {
      const source = typeof script.textContent === 'string' ? script.textContent : '';
      if (source.length > 500000 || !/dimensionToAsinMap|dimensionValuesDisplayData|variationDisplayLabels/i.test(source)) continue;
      jsonStateDiagnostics.scriptsMatched += 1;
      parseJson(source);
      const extracted = {};
      for (const key of keys) {
        const value = readField(source, key);
        if (value !== null) { extracted[key] = value; jsonStateDiagnostics.parsedFields.push(key); }
      }
      const parentAsin = readField(source, 'parentAsin');
      if (typeof parentAsin === 'string') extracted.parentAsin = parentAsin;
      if (keys.some((key) => Object.prototype.hasOwnProperty.call(extracted, key))) candidates.push(extracted);
    }
    const globalState = window && (window.twisterData || window.variationData || window.asinVariationValues || window.twisterJsInitData);
    if (globalState) visit(globalState);
    const state = candidates[0] || {};

    // ── 权威维度顺序与值表 ──────────────────────────────────────────────
    // twisterController.twisterJSInitData 是页面自己声明的变体初始化数据：
    //   dimensions        = ['size_name','color_name']（维度顺序，权威）
    //   variation_values  = { size_name: [...], color_name: [...] }（各维度完整值表）
    //   dimToAsinMapData  = { '0_18': 'B0CLY1KWLB', ... }（按下划线拼接的各维度索引）
    // 三者齐备时可在**不依赖 DOM 选项**的前提下严格还原 ASIN→维度名→维度值。
    const authoritative = {};
    // twisterController.twisterJSInitData 由页面异步注入，可能在本次求值时尚未就绪。
    // 这里做**有限**等待（有上限，读到即止）；等不到就如实留空，由归一化层降级为
    // CAPTURED_PARTIAL —— 绝不因为等不到就伪造维度映射。
    const readTwisterInit = () => (window && window.twisterController && window.twisterController.twisterJSInitData) || null;
    let twisterInit = readTwisterInit();
    if (!twisterInit || !isRecord(twisterInit.dimensions)) {
      for (let i = 0; i < 40 && (!twisterInit || !isRecord(twisterInit.dimensions)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        twisterInit = readTwisterInit();
      }
    }
    if (isRecord(twisterInit)) {
      const declaredDims = Array.isArray(twisterInit.dimensions)
        ? twisterInit.dimensions.map((item) => clean(item, 80)).filter(Boolean)
        : [];
      const variationValues = isRecord(twisterInit.variation_values) ? twisterInit.variation_values : null;
      const dimToAsin = isRecord(twisterInit.dimToAsinMapData) ? twisterInit.dimToAsinMapData : null;
      if (declaredDims.length > 0 && variationValues && dimToAsin) {
        const perDimValues = {};
        for (const key of declaredDims) {
          const list = variationValues[key];
          if (Array.isArray(list)) perDimValues[key] = list.map((item) => clean(item, 120)).filter(Boolean);
        }
        // 每个维度都必须有非空值表，否则顺序证明不完整
        const complete = declaredDims.every((key) => Array.isArray(perDimValues[key]) && perDimValues[key].length > 0);
        if (complete) {
          authoritative.dimensions = declaredDims;
          authoritative.variationValues = perDimValues;
          authoritative.dimensionOrderSource = 'twister_js_init_data';
        }
      }
    }
    const variationRoot = document.querySelector('#twister, #variation_feature_div, #twister-plus-inline-twister, [id^="variation_"], [id^="inline-twister-expander-content-"]');
    const parentNode = document.querySelector('#variation_parent, [data-parent-asin]');
    const parentText = clean(parentNode && (parentNode.getAttribute('data-parent-asin') || parentNode.getAttribute('data-asin') || parentNode.textContent), 300) || '';
    const parentMatch = /(?:parent(?:\\s+asin)?|asin)\\D*([A-Z0-9]{10})/i.exec(parentText);
    const parentAsin = clean(state.parentAsin, 10) || (parentMatch ? parentMatch[1].toUpperCase() : null);
    const groupsByKey = new Map();
    for (const group of Array.from(document.querySelectorAll('[id^="variation_"], [id^="inline-twister-expander-content-"]')).slice(0, 20)) {
      const rawId = clean(group.id, 120) || '';
      const key = rawId.startsWith('inline-twister-expander-content-')
        ? rawId.slice('inline-twister-expander-content-'.length)
        : rawId.startsWith('variation_') ? rawId.slice('variation_'.length) : '';
      if (!key) continue;
      const labelNode = document.querySelector('#inline-twister-expander-header-' + key)
        || group.querySelector('.a-form-label, label, legend, [data-a-popover]');
      const label = clean(state.variationDisplayLabels && state.variationDisplayLabels[key], 80)
        || clean(labelNode && (labelNode.innerText || labelNode.getAttribute('aria-label') || labelNode.textContent), 80);
      const nodes = Array.from(group.querySelectorAll('option, li[data-asin], li[data-defaultasin], li [data-asin], li [data-defaultasin], [role="option"]')).slice(0, 100);
      const optionsByIdentity = new Map();
      for (const node of nodes) {
        if (node.closest && node.closest('[hidden], [aria-hidden="true"], .aok-hidden')) continue;
        const style = window && window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
        if (node.getClientRects && node.getClientRects().length === 0) continue;
        const image = node.querySelector && node.querySelector('img');
        const value = clean(image && image.alt, 120)
          || clean(node.innerText, 120)
          || clean(node.getAttribute('aria-label'), 120)
          || clean(node.getAttribute('title'), 120)
          || clean(node.getAttribute('data-value'), 120)
          || clean(node.textContent, 120);
        const candidate = clean(node.getAttribute('data-asin') || node.getAttribute('data-defaultasin'), 10);
        const asin = candidate && /^[A-Z0-9]{10}$/i.test(candidate) ? candidate.toUpperCase() : null;
        if (!value || !asin) continue;
        optionsByIdentity.set(asin + '\\u0000' + value, { value, asin });
      }
      const options = Array.from(optionsByIdentity.values());
      if (options.length > 0) {
        const existing = groupsByKey.get(key);
        const mergedOptions = new Map((existing ? existing.options : []).map((option) => [option.asin + '\\u0000' + option.value, option]));
        for (const option of options) mergedOptions.set(option.asin + '\\u0000' + option.value, option);
        groupsByKey.set(key, { key, label: label || existing?.label || null, options: Array.from(mergedOptions.values()) });
      }
    }
    const domGroups = Array.from(groupsByKey.values());
    const variationText = clean(variationRoot && variationRoot.textContent, 1600) || '';
    const explicitNoVariation = Boolean(variationRoot && /no (?:other )?(?:variations|options) available|no variations? for this product/i.test(variationText));
    const cleanMap = (value, kind) => {
      if (!isRecord(value)) return {};
      const entries = Object.entries(value).slice(0, 100).flatMap(([key, item]) => {
        if (kind === 'asin') {
          const asin = clean(item, 10)?.toUpperCase();
          return asin && /^[A-Z0-9]{10}$/.test(asin) ? [[key, asin]] : [];
        }
        if (kind === 'label') {
          const label = clean(item, 80);
          return label ? [[key, label]] : [];
        }
        const values = Array.isArray(item) ? item : typeof item === 'string' ? [item] : [];
        const normalized = values.slice(0, 20).map((entry) => clean(entry, 120));
        return normalized.length > 0 && normalized.every(Boolean) ? [[key, normalized]] : [];
      });
      return Object.fromEntries(entries);
    };
    return {
      parentAsin,
      dimensionToAsinMap: cleanMap(state.dimensionToAsinMap, 'asin'),
      dimensionValuesDisplayData: cleanMap(state.dimensionValuesDisplayData, 'values'),
      variationDisplayLabels: cleanMap(state.variationDisplayLabels, 'label'),
      // 权威维度顺序与值表（来自 twisterController.twisterJSInitData）。
      // 三者（dimensions / variationValues / dimensionToAsinMap）齐备时，
      // 可严格还原 ASIN → 维度名 → 维度值，无需依赖 DOM 选项顺序。
      dimensions: authoritative.dimensions,
      variationValues: authoritative.variationValues,
      dimensionOrderSource: authoritative.dimensionOrderSource,
      domGroups,
      variationRootFound: Boolean(variationRoot),
      explicitNoVariation,
      jsonStateFound: candidates.length > 0,
      jsonStateDiagnostics: {
        scriptsScanned: jsonStateDiagnostics.scriptsScanned,
        scriptsMatched: jsonStateDiagnostics.scriptsMatched,
        parsedFields: Array.from(new Set(jsonStateDiagnostics.parsedFields)),
      },
    };
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAsin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return ASIN_PATTERN.test(normalized) ? normalized : null;
}

function safeText(value: unknown, maxLength = 120): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function stringArray(value: unknown): Array<string | null> {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  // ⚠️ 这里的截断上限必须覆盖真实页面的维度值数量：实测某商品颜色维度有 27 个值，
  // 早期 20 的上限会静默截断并使靠后的索引越界，从而让权威维度绑定整体失败。
  return values.slice(0, 100).map((item) => safeText(item));
}

export function normalizeAmazonVariationPageCapture(input: {
  expectedAsin: string;
  sourceUrl: string;
  capturedAt: string;
  raw: RawVariationPage;
  identity: { urlAsin: string | null; pageAsin: string | null; productContainerFound: boolean; pageStatus: string };
  humanRequired?: boolean;
  fallbackParentAsin?: string | null;
}): AmazonVariationPageCapture {
  const currentAsin = input.expectedAsin.trim().toUpperCase();
  const urlAsin = validAsin(input.identity.urlAsin);
  const pageAsin = validAsin(input.identity.pageAsin);
  const bound = ASIN_PATTERN.test(currentAsin)
    && input.identity.pageStatus === "ok"
    && urlAsin === currentAsin
    && pageAsin === currentAsin
    && input.identity.productContainerFound;
  const parentAsin = validAsin(input.raw.parentAsin) ?? validAsin(input.fallbackParentAsin);
  const asinMap = isRecord(input.raw.dimensionToAsinMap) ? input.raw.dimensionToAsinMap : {};
  const valuesMap = isRecord(input.raw.dimensionValuesDisplayData) ? input.raw.dimensionValuesDisplayData : {};
  const labelMap = isRecord(input.raw.variationDisplayLabels) ? input.raw.variationDisplayLabels : {};
  const labels = Object.entries(labelMap)
    .map(([key, value]) => ({ key: safeText(key, 80) ?? "", label: safeText(value, 80) }))
    .filter((item) => item.key && item.label)
    .slice(0, 20);
  const domGroups = Array.isArray(input.raw.domGroups)
    ? input.raw.domGroups.filter(isRecord).slice(0, 20).flatMap((rawGroup) => {
      const key = safeText(rawGroup.key, 80);
      if (!key || !Array.isArray(rawGroup.options)) return [];
      const options = rawGroup.options.filter(isRecord).slice(0, 100).flatMap((rawOption) => {
        const value = safeText(rawOption.value);
        if (!value) return [];
        return [{ value, asin: validAsin(rawOption.asin) }];
      });
      return options.length > 0 ? [{ key, label: safeText(rawGroup.label, 80), options }] : [];
    }) as RawDomVariationGroup[]
    : [];
  const mappedVariants = Object.entries(asinMap)
    .map(([key, value]) => ({ key, asin: validAsin(value) }))
    .filter((item): item is { key: string; asin: string } => Boolean(item.asin))
    .slice(0, 100);
  const valuesForMapped = (mapped: { key: string; asin: string }) => (
    Object.prototype.hasOwnProperty.call(valuesMap, mapped.asin)
      ? stringArray(valuesMap[mapped.asin])
      : stringArray(valuesMap[mapped.key])
  );
  const labelKeysAreUnique = new Set(labels.map((item) => item.key)).size === labels.length;
  const dimensionIndexes = new Map<string, number>();

  // ── 优先路径：页面自己声明的权威维度顺序 ────────────────────────────
  // `dimensions`（顺序）+ `variationValues`（各维度完整值表）+ `dimToAsinMap`（按下划线
  // 拼接的各维度索引）三者齐备时，可**严格**还原 ASIN→维度名→维度值：
  // 组合键的第 i 段就是该 ASIN 在第 i 个维度值表中的下标。
  // 这不依赖任何 DOM 选项顺序，也不依赖 `dimensionValuesDisplayData` 的数组位置假设。
  const authoritativeOrder = Array.isArray(input.raw.dimensions)
    ? (input.raw.dimensions as unknown[]).map((item) => safeText(item as string, 80)).filter((v): v is string => Boolean(v)).slice(0, 12)
    : [];
  const authoritativeValues = isRecord(input.raw.variationValues) ? input.raw.variationValues : {};
  const authoritativeValueLists = authoritativeOrder
    .map((key) => ({ key, list: stringArray((authoritativeValues as Record<string, unknown>)[key]).filter((v): v is string => Boolean(v)) }))
    .filter((item) => item.list.length > 0);
  const authoritativeComplete = authoritativeValueLists.length === authoritativeOrder.length
    && authoritativeOrder.length > 0
    && authoritativeValueLists.every((item) => new Set(item.list).size === item.list.length);

  const authoritativeBindings = new Map<string, Array<{ dimensionKey: string; label: string | null; value: string }>>();
  if (authoritativeComplete) {
    const labelByKey = new Map(labels.map((item) => [item.key, item.label]));
    for (const mapped of mappedVariants) {
      const parts = mapped.key.split("_");
      if (parts.length !== authoritativeOrder.length) continue;
      const options: Array<{ dimensionKey: string; label: string | null; value: string }> = [];
      let usable = true;
      for (let i = 0; i < authoritativeOrder.length; i += 1) {
        const idx = Number.parseInt(parts[i] ?? "", 10);
        const list = authoritativeValueLists[i]?.list ?? [];
        if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) { usable = false; break; }
        const key = authoritativeOrder[i];
        options.push({ dimensionKey: key, label: labelByKey.get(key) ?? null, value: list[idx] as string });
      }
      if (usable && options.length > 0) authoritativeBindings.set(mapped.asin, options);
    }
  }
  const authoritativeResolved = authoritativeComplete
    && authoritativeBindings.size === mappedVariants.length
    && authoritativeBindings.size > 0;

  let dimensionBindingsConsistent = authoritativeResolved || (labelKeysAreUnique && labels.length > 0);
  if (authoritativeResolved) {
    for (let i = 0; i < authoritativeOrder.length; i += 1) dimensionIndexes.set(authoritativeOrder[i], i);
  } else if (labels.length === 1 && labelKeysAreUnique) {
    dimensionIndexes.set(labels[0].key, 0);
  } else if (labels.length > 1 && labelKeysAreUnique) {
    for (const label of labels) {
      const groups = domGroups.filter((group) => group.key === label.key);
      let resolvedIndex: number | null = null;
      let hasUsableObservation = false;
      for (const group of groups) {
        for (const option of group.options) {
          const mapped = mappedVariants.find((item) => item.asin === option.asin);
          if (!mapped) { dimensionBindingsConsistent = false; continue; }
          const values = valuesForMapped(mapped);
          const matches = values.flatMap((value, index) => value === option.value ? [index] : []);
          if (matches.length !== 1) { dimensionBindingsConsistent = false; continue; }
          hasUsableObservation = true;
          if (resolvedIndex !== null && resolvedIndex !== matches[0]) dimensionBindingsConsistent = false;
          resolvedIndex = matches[0];
        }
      }
      if (!hasUsableObservation || resolvedIndex === null) dimensionBindingsConsistent = false;
      else dimensionIndexes.set(label.key, resolvedIndex);
    }
    if (new Set(dimensionIndexes.values()).size !== labels.length) dimensionBindingsConsistent = false;
  }
  const allDimensionsResolved = dimensionBindingsConsistent && dimensionIndexes.size === (authoritativeResolved ? authoritativeOrder.length : labels.length);

  const variantsByAsin = new Map<string, AmazonVariationVariant>();
  for (const mapped of mappedVariants) {
    // 权威绑定优先：直接使用页面声明的「维度名 → 维度值」，不经过数组位置推断。
    const authoritativeOptions = authoritativeBindings.get(mapped.asin);
    if (authoritativeResolved && authoritativeOptions) {
      variantsByAsin.set(mapped.asin, { asin: mapped.asin, options: authoritativeOptions });
      continue;
    }
    const values = valuesForMapped(mapped);
    const options = values.flatMap((value, index) => {
      if (!value) return [];
      const resolvedLabel = allDimensionsResolved ? labels.find((label) => dimensionIndexes.get(label.key) === index) : null;
      return [{
        dimensionKey: resolvedLabel?.key ?? `dimension_${index + 1}`,
        label: resolvedLabel?.label ?? null,
        value,
      }];
    });
    variantsByAsin.set(mapped.asin, { asin: mapped.asin, options });
  }

  const domOnlyAsins = domGroups.flatMap((group) => group.options.map((option) => option.asin).filter((asin): asin is string => Boolean(asin)));
  const variantAsins = [...new Set([...variantsByAsin.keys(), ...domOnlyAsins, currentAsin])].filter((asin) => ASIN_PATTERN.test(asin)).slice(0, 100);
  const variants = variantAsins.map((asin) => variantsByAsin.get(asin) ?? { asin, options: [] });
  const dimensionsByKey = new Map<string, { key: string; label: string | null; options: Set<string> }>();
  const labelByKey = new Map(labels.map((item) => [item.key, item.label]));
  if (authoritativeResolved) {
    // 权威来源：直接使用页面声明的各维度值表（顺序与dimensions 一致）
    for (const { key, list } of authoritativeValueLists) {
      dimensionsByKey.set(key, {
        key,
        label: labelByKey.get(key) ?? null,
        options: new Set(list),
      });
    }
  } else {
    for (const label of labels) {
      const options = new Set<string>();
      if (allDimensionsResolved) {
        const index = dimensionIndexes.get(label.key);
        if (index !== undefined) {
          for (const mapped of mappedVariants) {
            const option = valuesForMapped(mapped)[index];
            if (option) options.add(option);
          }
        }
      } else if (labels.length === 1) {
        for (const mapped of mappedVariants) {
          const option = valuesForMapped(mapped)[0];
          if (option) options.add(option);
        }
      }
      dimensionsByKey.set(label.key, { key: label.key, label: label.label, options });
    }
  }
  // DOM 组仅作为**补充**证据来源（权威路径下不得覆盖已证明的值表）
  if (!authoritativeResolved && (labels.length === 0 || allDimensionsResolved || labels.length === 1)) {
    for (const group of domGroups) {
      const label = labels.find((item) => item.key === group.key);
      const dimension = dimensionsByKey.get(group.key) ?? { key: group.key, label: label?.label ?? group.label, options: new Set<string>() };
      for (const option of group.options) dimension.options.add(option.value);
      dimensionsByKey.set(group.key, dimension);
    }
  }
  const dimensions = [...dimensionsByKey.values()].map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    options: [...dimension.options].slice(0, 100),
  }));
  const everyMappedVariantHasDimensions = mappedVariants.length > 0
    && (
      // 权威路径：每个 ASIN 都必须由页面声明的组合键解析出**全部维度**，缺一即不完整。
      authoritativeResolved
        ? authoritativeBindings.size === mappedVariants.length
          && [...authoritativeBindings.values()].every(
            (options) => options.length === authoritativeOrder.length && options.every((o) => Boolean(o.value)),
          )
        // 兼容路径：沿用dimensionValuesDisplayData 的数组长度判据。
        : mappedVariants.every((item) => valuesForMapped(item).length === labels.length
          && labels.length > 0
          && valuesForMapped(item).every(Boolean))
    );
  const currentVariantMapped = mappedVariants.some((item) => item.asin === currentAsin);
  const complete = bound && parentAsin !== null && mappedVariants.length > 1 && allDimensionsResolved
    && everyMappedVariantHasDimensions && currentVariantMapped;
  const hasVariationSignal = mappedVariants.length > 0 || labels.length > 0 || domGroups.length > 0;
  const explicitNoVariation = input.raw.variationRootFound === true && input.raw.explicitNoVariation === true && !hasVariationSignal;
  const status: AmazonVariationCaptureStatus = input.humanRequired
    ? "HUMAN_REQUIRED"
    : !bound
      ? "PAGE_CHANGED"
      : complete
        ? "COMPLETE"
        : hasVariationSignal
          ? "CAPTURED_PARTIAL"
          : explicitNoVariation
            ? "NO_VARIATION_WITH_EVIDENCE"
            : "EXTRACTION_EMPTY_RETRYABLE";

  return {
    status,
    parentAsin,
    currentAsin,
    dimensions,
    variantAsins,
    variants,
    sourceUrl: input.sourceUrl,
    capturedAt: input.capturedAt,
    identityProof: {
      urlAsin,
      pageAsin,
      productContainerFound: input.identity.productContainerFound,
      bound,
    },
    diagnostics: {
      variationRootFound: input.raw.variationRootFound === true,
      jsonStateFound: input.raw.jsonStateFound === true,
      mappedVariantCount: mappedVariants.length,
      labeledDimensionCount: labels.length,
      domDimensionCount: domGroups.length,
      authoritativeDimensionOrder: authoritativeResolved,
      authoritativeDimensionOrderSource: authoritativeResolved ? 'twister_js_init_data' : null,
      jsonScriptsMatched: isRecord(input.raw.jsonStateDiagnostics) && typeof input.raw.jsonStateDiagnostics.scriptsMatched === "number"
        ? input.raw.jsonStateDiagnostics.scriptsMatched
        : 0,
      jsonFieldsParsed: isRecord(input.raw.jsonStateDiagnostics) && Array.isArray(input.raw.jsonStateDiagnostics.parsedFields)
        ? input.raw.jsonStateDiagnostics.parsedFields.filter((value): value is string => typeof value === "string").slice(0, 8)
        : [],
      everyMappedVariantHasDimensions,
      currentVariantMapped,
      asinMapKeys: Object.keys(asinMap).slice(0, 20),
      valueMapKeys: Object.keys(valuesMap).slice(0, 20),
      valueMapLengths: Object.fromEntries(Object.entries(valuesMap).slice(0, 20).map(([key, value]) => [key, stringArray(value).length])),
    },
  };
}
