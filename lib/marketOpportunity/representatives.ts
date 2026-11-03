import type { MarketScanSampleItemV1 } from "@/lib/marketScan/types";

export const MARKET_OPPORTUNITY_REPRESENTATIVES_SCHEMA = "market-opportunity-representatives.v1" as const;

export const REPRESENTATIVE_ROLE_TAGS = [
  "SALES_LEADER",
  "BRAND_LEADER",
  "LOW_PRICE",
  "PREMIUM_PRICE",
  "HIGH_RATING",
  "REVIEW_BARRIER",
  "NEW_ENTRANT",
  "DIFFERENTIATED",
] as const;

export type RepresentativeRoleTag = (typeof REPRESENTATIVE_ROLE_TAGS)[number];

export type RepresentativeSelection = {
  readonly productFactSubjectKey: string;
  readonly candidateId: string | null;
  readonly asin: string;
  readonly roleTags: readonly RepresentativeRoleTag[];
  readonly selectedBy: string;
  readonly selectedAt: string;
  readonly note: string | null;
};

export type RepresentativeSelectionSet = {
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_REPRESENTATIVES_SCHEMA;
  readonly revision: number;
  readonly items: readonly RepresentativeSelection[];
};

export class RepresentativeContractError extends Error {
  constructor(public readonly code: "invalid" | "duplicate" | "identity_mismatch", message: string) {
    super(message);
    this.name = "RepresentativeContractError";
  }
}

const SUBJECT_KEY = /^[A-Za-z0-9:._|@%-]{1,200}$/u;
const ASIN = /^[A-Z0-9]{10}$/u;
const ID = /^[A-Za-z0-9_-]{1,160}$/u;
const ROLE_TAG_SET = new Set<string>(REPRESENTATIVE_ROLE_TAGS);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number, nullable = false): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new RepresentativeContractError("invalid", `${label} 必须是文本。`);
  }
  if (typeof value !== "string") throw new RepresentativeContractError("invalid", `${label} 必须是文本。`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized && nullable) return null;
  if (!normalized || normalized.length > max) {
    throw new RepresentativeContractError("invalid", `${label} 长度不合法。`);
  }
  return normalized;
}

function iso(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!parsed || Number.isNaN(Date.parse(parsed))) {
    throw new RepresentativeContractError("invalid", `${label} 必须是合法时间。`);
  }
  return new Date(parsed).toISOString();
}

export function parseRepresentativeSelection(value: unknown, label = "代表商品"): RepresentativeSelection {
  if (!record(value)) throw new RepresentativeContractError("invalid", `${label} 必须是对象。`);
  const subjectKey = text(value.productFactSubjectKey, `${label}.productFactSubjectKey`, 200);
  const asin = text(value.asin, `${label}.asin`, 10);
  if (!subjectKey || !SUBJECT_KEY.test(subjectKey)) throw new RepresentativeContractError("invalid", `${label}.productFactSubjectKey 不合法。`);
  if (!asin || !ASIN.test(asin)) throw new RepresentativeContractError("invalid", `${label}.asin 不合法。`);
  const rawTags = value.roleTags;
  if (!Array.isArray(rawTags) || rawTags.length > REPRESENTATIVE_ROLE_TAGS.length) {
    throw new RepresentativeContractError("invalid", `${label}.roleTags 不合法。`);
  }
  const roleTags: RepresentativeRoleTag[] = [];
  for (const rawTag of rawTags) {
    if (typeof rawTag !== "string" || !ROLE_TAG_SET.has(rawTag)) {
      throw new RepresentativeContractError("invalid", `${label}.roleTags 含不支持的标签。`);
    }
    if (!roleTags.includes(rawTag as RepresentativeRoleTag)) roleTags.push(rawTag as RepresentativeRoleTag);
  }
  const candidateId = value.candidateId === null || value.candidateId === undefined
    ? null : text(value.candidateId, `${label}.candidateId`, 160);
  if (candidateId !== null && !ID.test(candidateId)) {
    throw new RepresentativeContractError("invalid", `${label}.candidateId 不合法。`);
  }
  return {
    productFactSubjectKey: subjectKey,
    candidateId,
    asin,
    roleTags,
    selectedBy: text(value.selectedBy, `${label}.selectedBy`, 120) as string,
    selectedAt: iso(value.selectedAt, `${label}.selectedAt`),
    note: text(value.note, `${label}.note`, 1_000, true),
  };
}

export function parseRepresentativeSelectionSet(value: unknown): RepresentativeSelectionSet {
  if (!record(value)) throw new RepresentativeContractError("invalid", "代表商品集合必须是对象。");
  if (value.schemaVersion !== MARKET_OPPORTUNITY_REPRESENTATIVES_SCHEMA) {
    throw new RepresentativeContractError("invalid", "代表商品集合版本不受支持。");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new RepresentativeContractError("invalid", "代表商品集合 revision 不合法。");
  }
  if (!Array.isArray(value.items) || value.items.length > 500) {
    throw new RepresentativeContractError("invalid", "代表商品集合 items 不合法。");
  }
  const items = value.items.map((item, index) => parseRepresentativeSelection(item, `代表商品[${index}]`));
  const identities = new Set<string>();
  for (const item of items) {
    const key = `${item.productFactSubjectKey}|${item.asin}`;
    if (identities.has(key)) throw new RepresentativeContractError("duplicate", "代表商品不得重复选择。 ");
    identities.add(key);
  }
  return {
    schemaVersion: MARKET_OPPORTUNITY_REPRESENTATIVES_SCHEMA,
    revision: value.revision as number,
    items,
  };
}

export function buildInitialRepresentativeSelectionSet(): RepresentativeSelectionSet {
  return {
    schemaVersion: MARKET_OPPORTUNITY_REPRESENTATIVES_SCHEMA,
    revision: 0,
    items: [],
  };
}

export function suggestedRoleTags(item: Pick<MarketScanSampleItemV1, "factValues">): RepresentativeRoleTag[] {
  const tags: RepresentativeRoleTag[] = [];
  const sales = item.factValues.monthlySalesEstimate;
  const price = item.factValues.price;
  const rating = item.factValues.rating;
  const reviews = item.factValues.reviewCount;
  if (sales.presence === "present" && sales.value >= 0) tags.push("SALES_LEADER");
  if (price.presence === "present" && price.value.amount <= 10) tags.push("LOW_PRICE");
  if (price.presence === "present" && price.value.amount >= 30) tags.push("PREMIUM_PRICE");
  if (rating.presence === "present" && rating.value >= 4.7) tags.push("HIGH_RATING");
  if (reviews.presence === "present" && reviews.value >= 100_000) tags.push("REVIEW_BARRIER");
  return tags;
}
