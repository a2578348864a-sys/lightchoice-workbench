import {
  AMAZON_DETAIL_FIELD_REGISTRY,
  type AmazonDetailFieldRule,
} from "./detail-page-field-registry";
import type {
  AmazonDetailDomCandidate,
  AmazonDetailPageDomSnapshot,
} from "./detail-page-extract-v2";

export type AmazonDetailPagePresenceAudit = {
  schemaVersion: "amazon-detail-page-presence-audit.v1";
  scope: "registered-target-product-root";
  fields: Record<string, boolean>;
  candidateEvidence?: {
    titleCandidates: Array<{ selector: string; text: string }>;
    priceCandidates: Array<{
      selector: string;
      text: string;
      priceContext?: AmazonDetailDomCandidate["priceContext"];
    }>;
  };
};

function normalizeLabel(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[:：]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function textStartsWithAlias(text: string, alias: string): boolean {
  return text === alias || text.startsWith(`${alias} `) || text.startsWith(`${alias}:`) || text.startsWith(`${alias}：`);
}

function candidateText(candidate: AmazonDetailDomCandidate): string {
  return [candidate.text, candidate.label, candidate.value, candidate.alt, candidate.href, candidate.src]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
}

function candidatesFor(snapshot: AmazonDetailPageDomSnapshot, selectors: readonly string[]): AmazonDetailDomCandidate[] {
  return selectors.flatMap((selector) => snapshot.candidates[selector] ?? []);
}

function hasAliasRow(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): boolean {
  if (rule.labelAliases.length === 0) return false;
  const aliases = new Set(rule.labelAliases.map(normalizeLabel));
  return snapshot.specificationRows.some((row) => {
    const label = normalizeLabel(row.label);
    const text = normalizeLabel(row.text);
    return aliases.has(label) || [...aliases].some((alias) => textStartsWithAlias(text, alias));
  });
}

function hasAliasCandidate(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): boolean {
  if (rule.labelAliases.length === 0) return false;
  const aliases = rule.labelAliases.map(normalizeLabel);
  return candidatesFor(snapshot, rule.selectorCandidates).some((candidate) => {
    const label = normalizeLabel(candidate.label);
    const text = normalizeLabel(candidate.text);
    return aliases.some((alias) => label === alias || textStartsWithAlias(text, alias));
  });
}

function isSpecificationRule(rule: AmazonDetailFieldRule): boolean {
  return rule.labelAliases.length > 0 && rule.selectorCandidates.some((selector) =>
    selector.includes("productDetails_") || selector.includes("productOverview_") || selector === "#prodDetails tr"
      || selector === "#detailBullets_feature_div li",
  );
}

function hasSelectorContent(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): boolean {
  return candidatesFor(snapshot, rule.selectorCandidates).some((candidate) => candidateText(candidate).length > 0);
}

function isAmazonUsHost(pageUrl: string): boolean {
  try {
    const { hostname, protocol, username, password, port } = new URL(pageUrl);
    return protocol === "https:"
      && (hostname.toLowerCase() === "amazon.com" || hostname.toLowerCase().endsWith(".amazon.com"))
      && username === ""
      && password === ""
      && port === "";
  } catch {
    return false;
  }
}

function hasBoundAsinUrl(pageUrl: string): boolean {
  if (!isAmazonUsHost(pageUrl)) return false;
  try {
    return /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.test(new URL(pageUrl).pathname);
  } catch {
    return false;
  }
}

function pageFieldPresent(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): boolean {
  const field = rule.canonicalField;
  if (field === "marketplace") return isAmazonUsHost(snapshot.pageUrl);
  if (field === "productUrl" || field === "asin") {
    if (hasBoundAsinUrl(snapshot.pageUrl)) return true;
  }
  if (field === "primaryBsr") return pageFieldPresent(snapshot, AMAZON_DETAIL_FIELD_REGISTRY.find((item) => item.canonicalField === "bsrRanks")!);
  if (field === "fulfillment") {
    return pageFieldPresent(snapshot, AMAZON_DETAIL_FIELD_REGISTRY.find((item) => item.canonicalField === "seller")!)
      && pageFieldPresent(snapshot, AMAZON_DETAIL_FIELD_REGISTRY.find((item) => item.canonicalField === "shipsFrom")!);
  }
  if (isSpecificationRule(rule)) return hasAliasRow(snapshot, rule) || hasAliasCandidate(snapshot, rule);
  if (rule.labelAliases.length > 0 && hasAliasRow(snapshot, rule)) return true;

  const values = candidatesFor(snapshot, rule.selectorCandidates).map(candidateText);
  if (field === "price" || field === "currency") {
    return values.some((value) => /(?:US\$|[$£€¥])\s*\d|\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CAD)\b/i.test(value));
  }
  if (field === "rating" || field === "reviewCount") return values.some((value) => /\d/.test(value));
  if (field === "bsrRanks") {
    return values.some((value) => /best sellers rank|#\s*\d[\d,]*\s+in\s+/i.test(value));
  }
  if (field === "seller") {
    if (hasSelectorContent(snapshot, rule)) return true;
    return candidatesFor(snapshot, ["#tabular-buybox-container", "#desktop_buybox", "#buybox"])
      .some((candidate) => /\bsold by\b/i.test(candidateText(candidate)));
  }
  if (field === "shipsFrom") {
    return values.some((value) => /\bships\s+from\b/i.test(value));
  }
  if (field === "mainImage" || field === "galleryImages") {
    return candidatesFor(snapshot, rule.selectorCandidates).some((candidate) => Boolean(candidate.src));
  }
  return hasSelectorContent(snapshot, rule);
}

/**
 * Reports only booleans from the existing bounded target-product snapshot.
 * Presence is independent of parser success; no DOM text, image URL, or page HTML is returned.
 */
export function auditAmazonDetailPageFieldPresence(
  snapshot: AmazonDetailPageDomSnapshot,
  options: { includeCandidateEvidence?: boolean } = {},
): AmazonDetailPagePresenceAudit {
  const fields: Record<string, boolean> = {};
  for (const rule of AMAZON_DETAIL_FIELD_REGISTRY) {
    if (rule.priority !== "P0" && rule.priority !== "P1") continue;
    fields[rule.canonicalField] = pageFieldPresent(snapshot, rule);
  }
  const result: AmazonDetailPagePresenceAudit = {
    schemaVersion: "amazon-detail-page-presence-audit.v1",
    scope: "registered-target-product-root",
    fields,
  };
  if (options.includeCandidateEvidence) {
    const titleRule = AMAZON_DETAIL_FIELD_REGISTRY.find((rule) => rule.canonicalField === "title");
    const priceRule = AMAZON_DETAIL_FIELD_REGISTRY.find((rule) => rule.canonicalField === "price");
    const boundedCandidates = (rule: AmazonDetailFieldRule | undefined, includePriceContext = false) => rule
      ? candidatesFor(snapshot, rule.selectorCandidates)
        .flatMap((candidate) => {
          const text = candidate.text ?? candidate.value ?? candidate.label ?? candidate.alt;
          return typeof text === "string" && text.trim()
            ? [{
              selector: candidate.selector,
              text: text.replace(/\s+/g, " ").trim().slice(0, 240),
              ...(includePriceContext ? { priceContext: candidate.priceContext ?? null } : {}),
            }]
            : [];
        })
        .slice(0, 12)
      : [];
    result.candidateEvidence = {
      titleCandidates: boundedCandidates(titleRule),
      priceCandidates: boundedCandidates(priceRule, true),
    };
  }
  return result;
}
