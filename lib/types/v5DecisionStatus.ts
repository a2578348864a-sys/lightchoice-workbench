/**
 * Canonical Human Decision 5-State Contract
 *
 * Strict separation:
 * VALIDATE_MORE != PAUSE
 *
 * VALIDATE_MORE: Current facts/evidence insufficient, need more evidence before judging.
 * PAUSE: Current facts sufficient, but commercially suspended/on watch (e.g. wait for season, price stabilization).
 *
 * Priority of resolution:
 * 1. myChoice.canonicalStatus (explicit canonical record)
 * 2. authoritative structured hubStatus / Feishu payload
 * 3. legacy local myChoice.choice
 * 4. legacy DB decisionStatus (need_info without proof -> LEGACY_NEED_INFO_AMBIGUOUS)
 */

export type CanonicalDecisionStatus =
  | "PENDING"
  | "PROCEED"
  | "VALIDATE_MORE"
  | "PAUSE"
  | "DROP";

export type ResolvedDecisionStatus =
  | CanonicalDecisionStatus
  | "LEGACY_NEED_INFO_AMBIGUOUS";

export type LegacyDbDecisionStatus = "pending" | "continue" | "need_info" | "rejected";
export type LegacyChoice = "PROCEED" | "WATCH" | "DROP";

export interface CanonicalDecisionActionMeta {
  readonly status: CanonicalDecisionStatus;
  readonly label: string;
  readonly shortBadge: string;
  readonly description: string;
  readonly tone: "emerald" | "amber" | "indigo" | "rose" | "slate";
}

export const CANONICAL_DECISION_ACTIONS: readonly CanonicalDecisionActionMeta[] = [
  {
    status: "PROCEED",
    label: "继续推进",
    shortBadge: "已推进",
    description: "继续推进研究与开发需求讨论，不等于立项或量产批准",
    tone: "emerald",
  },
  {
    status: "VALIDATE_MORE",
    label: "需补充验证",
    shortBadge: "需补充验证",
    description: "当前事实/证据不足，待补充关键证据后重新判断",
    tone: "amber",
  },
  {
    status: "PAUSE",
    label: "暂缓观察",
    shortBadge: "暂缓观察",
    description: "暂缓推进，后续视信息和时机再判断",
    tone: "indigo",
  },
  {
    status: "DROP",
    label: "放弃",
    shortBadge: "已放弃",
    description: "风险过高或不符合选品标准，正式淘汰",
    tone: "rose",
  },
] as const;

/**
 * Maps a canonical status to the SQLite DB `decisionStatus` column.
 * Zero Prisma schema changes required.
 */
export function canonicalToDbDecisionStatus(status: CanonicalDecisionStatus): LegacyDbDecisionStatus {
  switch (status) {
    case "PROCEED":
      return "continue";
    case "VALIDATE_MORE":
    case "PAUSE":
      return "need_info";
    case "DROP":
      return "rejected";
    case "PENDING":
    default:
      return "pending";
  }
}

/**
 * Maps a canonical status to the legacy 3-choice model (`PROCEED` | `WATCH` | `DROP`).
 */
export function canonicalToLegacyChoice(status: CanonicalDecisionStatus): LegacyChoice {
  switch (status) {
    case "PROCEED":
      return "PROCEED";
    case "VALIDATE_MORE":
    case "PAUSE":
      return "WATCH";
    case "DROP":
      return "DROP";
    case "PENDING":
    default:
      return "WATCH";
  }
}

/**
 * Normalizes Feishu / Hub decision status string to canonical status.
 */
export function feishuDecisionToCanonical(rawStatus: string | null | undefined): CanonicalDecisionStatus | null {
  if (!rawStatus) return null;
  const normalized = rawStatus.trim().toUpperCase();
  if (normalized === "APPROVE" || normalized === "PROCEED" || normalized === "通过") return "PROCEED";
  if (normalized === "DROP" || normalized === "REJECT" || normalized === "REJECTED" || normalized === "放弃" || normalized === "拒绝") return "DROP";
  if (normalized === "PAUSE" || normalized === "PAUSED" || normalized === "暂缓" || normalized === "暂缓观察") return "PAUSE";
  if (normalized === "VALIDATE_MORE" || normalized === "补证" || normalized === "补充验证" || normalized === "需补充验证") return "VALIDATE_MORE";
  if (normalized === "PENDING" || normalized === "待审核" || normalized === "未审核") return "PENDING";
  return null;
}

/**
 * Pure canonical resolution function implementing the 4-tier precedence:
 *
 * 1. myChoice.canonicalStatus
 * 2. authoritative structured hubStatus
 * 3. myChoice.choice
 * 4. DB decisionStatus
 *
 * If DB status is `need_info` and no higher authority distinguishes between
 * VALIDATE_MORE and PAUSE, it returns `LEGACY_NEED_INFO_AMBIGUOUS` (no guessing!).
 */
export function toCanonicalDecisionStatus(
  input:
    | string
    | null
    | undefined
    | {
        readonly myChoice?: {
          readonly canonicalStatus?: string | null;
          readonly hubStatus?: string | null;
          readonly choice?: string | null;
        } | null;
        readonly dbStatus?: string | null;
        readonly hubStatus?: string | null;
      },
): ResolvedDecisionStatus {
  if (typeof input === "string") {
    const s = input.trim().toUpperCase();
    if (
      s === "PROCEED" ||
      s === "VALIDATE_MORE" ||
      s === "PAUSE" ||
      s === "DROP" ||
      s === "PENDING"
    ) {
      return s as CanonicalDecisionStatus;
    }
    const fromFeishu = feishuDecisionToCanonical(input);
    if (fromFeishu) return fromFeishu;
    if (s === "WATCH" || s === "NEED_INFO") return "LEGACY_NEED_INFO_AMBIGUOUS";
    return "PENDING";
  }

  if (!input) return "PENDING";

  const choice = input.myChoice;

  // 1. Highest priority: explicit canonicalStatus
  if (choice?.canonicalStatus) {
    const candidate = choice.canonicalStatus.trim().toUpperCase();
    if (
      candidate === "PROCEED" ||
      candidate === "VALIDATE_MORE" ||
      candidate === "PAUSE" ||
      candidate === "DROP" ||
      candidate === "PENDING"
    ) {
      return candidate as CanonicalDecisionStatus;
    }
  }

  // 2. Second priority: authoritative structured hubStatus
  const effectiveHubStatus = choice?.hubStatus ?? input.hubStatus;
  if (effectiveHubStatus) {
    const fromHub = feishuDecisionToCanonical(effectiveHubStatus);
    if (fromHub) return fromHub;
  }

  // 3. Third priority: local myChoice.choice
  if (choice?.choice) {
    const c = choice.choice.trim().toUpperCase();
    if (c === "PROCEED") return "PROCEED";
    if (c === "DROP") return "DROP";
    // If choice is "WATCH", without higher-tier differentiation, check DB status or return ambiguous
    if (c === "WATCH") {
      return "LEGACY_NEED_INFO_AMBIGUOUS";
    }
  }

  // 4. Fourth priority: DB decisionStatus
  const db = (input.dbStatus ?? "").trim().toLowerCase();
  if (db === "continue") return "PROCEED";
  if (db === "rejected") return "DROP";
  if (db === "pending" || db === "") return "PENDING";
  if (db === "need_info") {
    // Cannot prove whether need_info was VALIDATE_MORE or PAUSE without evidence:
    // Fail-closed to avoid guessing user business intention.
    return "LEGACY_NEED_INFO_AMBIGUOUS";
  }

  return "PENDING";
}

/**
 * Returns human-friendly Chinese display metadata for any resolved status.
 */
export function getDecisionStatusDisplay(status: ResolvedDecisionStatus): {
  label: string;
  badgeText: string;
  tone: "emerald" | "amber" | "indigo" | "rose" | "slate";
} {
  switch (status) {
    case "PROCEED":
      return { label: "继续推进", badgeText: "已推进", tone: "emerald" };
    case "VALIDATE_MORE":
      return { label: "需补充验证", badgeText: "需补充验证", tone: "amber" };
    case "PAUSE":
      return { label: "暂缓观察", badgeText: "暂缓观察", tone: "indigo" };
    case "DROP":
      return { label: "放弃", badgeText: "已放弃", tone: "rose" };
    case "LEGACY_NEED_INFO_AMBIGUOUS":
      return { label: "待明确语义", badgeText: "待明确（历史需补充）", tone: "amber" };
    case "PENDING":
    default:
      return { label: "待审核", badgeText: "待审核", tone: "slate" };
  }
}


export type TeamRecommendationStatus = "RECOMMEND_PROCEED" | "RECOMMEND_VALIDATE_MORE" | "RECOMMEND_PAUSE" | "RECOMMEND_DROP";
export function teamRecommendationToCanonical(status: unknown): Exclude<CanonicalDecisionStatus, "PENDING"> | null {
  switch (status) {
    case "RECOMMEND_PROCEED": return "PROCEED";
    case "RECOMMEND_VALIDATE_MORE": return "VALIDATE_MORE";
    case "RECOMMEND_PAUSE": return "PAUSE";
    case "RECOMMEND_DROP": return "DROP";
    default: return null;
  }
}
