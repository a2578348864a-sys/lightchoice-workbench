export type HubRecordMatch = {
  readonly record_id: string;
};

export type HubMatchDecision =
  | { readonly action: "create" }
  | { readonly action: "update"; readonly recordId: string };

export class HubDuplicateKeyError extends Error {
  readonly code = "FEISHU_DUPLICATE_KEY" as const;

  constructor(matchCount: number) {
    super(`Feishu logical key matched ${matchCount} records; refusing an ambiguous update.`);
    this.name = "HubDuplicateKeyError";
  }
}

/** Feishu has no enforced unique index here; the projection layer must fail closed on 0/1/>1 matches. */
export function decideHubRecordMatch(matches: readonly HubRecordMatch[]): HubMatchDecision {
  if (matches.length === 0) return { action: "create" };
  if (matches.length > 1) throw new HubDuplicateKeyError(matches.length);

  const recordId = matches[0]?.record_id.trim();
  if (!recordId) throw new Error("Feishu matched record is missing record_id; refusing an ambiguous update.");
  return { action: "update", recordId };
}
