export type ParentVariationInput = {
  readonly id: string;
  readonly productKey: string;
  readonly ordinal: number;
  readonly asin: string | null;
  readonly parentAsin: string | null;
  readonly familyProjectionJson: string;
  readonly rankingJson?: string;
};

export type ParentVariationDecision = {
  readonly status: "APPLIED" | "NOT_AVAILABLE";
  readonly basis: "parentAsin" | "familyIdentity" | "not_available";
  readonly groupsCollapsed: number;
  readonly sourceItemCount: number;
  readonly retainedItemCount: number;
  readonly selectedItemIds: readonly string[];
  readonly notice: string;
};

function stableFamilyIdentity(item: ParentVariationInput): string | null {
  try {
    const parsed: unknown = JSON.parse(item.familyProjectionJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const family = root.family;
    if (family && typeof family === "object" && !Array.isArray(family)) {
      const identity = (family as Record<string, unknown>).familyIdentity;
      if (typeof identity === "string" && identity.trim()) return identity.trim();
    }
    const direct = root.familyIdentity;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  } catch {
    return null;
  }
  return null;
}

function normalized(value: string | null | undefined): string | null {
  const next = typeof value === "string" ? value.trim().toUpperCase() : "";
  return next || null;
}

/**
 * Parent/variation dedupe is deliberately a small, deterministic projection.
 * It only consumes authoritative ProductBatchItem fields; it never infers a
 * parent ASIN from title, image, category, or AI output.
 */
export function dedupeParentVariations(items: readonly ParentVariationInput[]): ParentVariationDecision {
  const ordered = [...items].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const hasParent = ordered.some((item) => normalized(item.parentAsin) !== null);
  const withFamily = ordered.map((item) => ({ item, family: stableFamilyIdentity(item) }));
  const hasFamily = withFamily.some((entry) => entry.family !== null);
  const basis = hasParent ? "parentAsin" : hasFamily ? "familyIdentity" : "not_available";
  if (basis === "not_available") {
    return {
      status: "NOT_AVAILABLE",
      basis,
      groupsCollapsed: 0,
      sourceItemCount: ordered.length,
      retainedItemCount: ordered.length,
      selectedItemIds: ordered.map((item) => item.id),
      notice: "父子变体合并未执行：当前来源没有可靠的父 ASIN 或同族标识，无法识别变体关系。",
    };
  }

  const seen = new Set<string>();
  const selected: ParentVariationInput[] = [];
  let collapsed = 0;
  for (const entry of withFamily) {
    const key = basis === "parentAsin"
      ? normalized(entry.item.parentAsin) ?? `asin:${normalized(entry.item.asin) ?? entry.item.productKey}`
      : entry.family ?? `asin:${normalized(entry.item.asin) ?? entry.item.productKey}`;
    if (seen.has(key)) {
      collapsed += 1;
      continue;
    }
    seen.add(key);
    selected.push(entry.item);
  }
  return {
    status: "APPLIED",
    basis,
    groupsCollapsed: collapsed,
    sourceItemCount: ordered.length,
    retainedItemCount: selected.length,
    selectedItemIds: selected.map((item) => item.id),
    notice: collapsed > 0
      ? `已按可靠 ${basis === "parentAsin" ? "parentAsin" : "familyIdentity"} 确定性保留 ${selected.length} 个代表样本，折叠 ${collapsed} 个变体。`
      : `已检查可靠 ${basis === "parentAsin" ? "parentAsin" : "familyIdentity"}，未发现需要折叠的重复变体。`,
  };
}
