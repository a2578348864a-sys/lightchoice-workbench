/**
 * VOC strength and product-improvement thresholds shared by server analysis and UI.
 * These are project display/decision rules, not universal market research standards.
 */
export const VOC_STRENGTH_THRESHOLDS = {
  weakMin: 2,
  recurringMin: 4,
} as const;

/** 主题证据强度（deterministic，由 reviewCount 推导，服务端与展示层共用同一规则） */
export type VocThemeStrength = "isolated" | "weak" | "recurring";

/**
 * 唯一权威强度推导函数。服务端分析与展示层必须共用，禁止各自实现。
 * 1 条 = isolated（孤立提及）；2–3 条 = weak（弱信号）；≥4 条 = recurring（达系统复现门槛）。
 */
export function computeThemeStrength(reviewCount: number): VocThemeStrength {
  if (!Number.isFinite(reviewCount) || reviewCount < VOC_STRENGTH_THRESHOLDS.weakMin) return "isolated";
  if (reviewCount < VOC_STRENGTH_THRESHOLDS.recurringMin) return "weak";
  return "recurring";
}

export const VOC_STRENGTH_LABELS: Record<VocThemeStrength, string> = {
  isolated: "孤立提及",
  weak: "弱信号",
  recurring: "已达复现门槛",
};

export type VocStrengthDescription = {
  readonly strength: VocThemeStrength;
  /** 短标签（徽标用） */
  readonly label: string;
  /** 用户可见的完整证据强度描述（禁止「高频」「普遍」「多数用户」等无据强度词） */
  readonly evidencePhrase: string;
  /** 必须随强度一并展示的限定声明；无则 null */
  readonly caveat: string | null;
};

/**
 * 把主题计数翻译为「可对外表述」的证据强度描述。
 * 展示层与 Markdown 导出必须共用本函数，避免同一份证据出现两种强度措辞。
 */
export function describeVocThemeStrength(reviewCount: number): VocStrengthDescription {
  const strength = computeThemeStrength(reviewCount);
  const count = Number.isFinite(reviewCount) && reviewCount > 0 ? Math.floor(reviewCount) : 0;
  if (strength === "isolated") {
    return {
      strength,
      label: VOC_STRENGTH_LABELS.isolated,
      evidencePhrase: count > 0
        ? `单条用户反馈（${count} 条），当前尚未复现`
        : "单条用户反馈，当前尚未复现",
      caveat: "单条反馈不代表普遍问题，需扩大独立评论样本确认是否复现。",
    };
  }
  if (strength === "weak") {
    return {
      strength,
      label: VOC_STRENGTH_LABELS.weak,
      evidencePhrase: `弱信号（${count} 条独立评论提及），尚未达到系统复现门槛（≥ ${VOC_STRENGTH_THRESHOLDS.recurringMin} 条）`,
      caveat: "弱信号不足以支撑开发投入，需扩大样本确认。",
    };
  }
  return {
    strength,
    label: VOC_STRENGTH_LABELS.recurring,
    evidencePhrase: `已达系统复现门槛（${count} 条独立评论提及）`,
    caveat: "达到复现门槛仅表示该反馈在样本中重复出现，不等于已证明市场普遍需求。",
  };
}

/**
 * 强度一致性校验：当记录声明的 strength 与按计数重算的结果不一致时返回 true。
 * 仅对规范词表（isolated/weak/recurring）做比较；历史遗留词表（high/medium/low）不参与比较。
 */
export function isVocStrengthConflict(reviewCount: number, declaredStrength: string | null | undefined): boolean {
  if (declaredStrength !== "isolated" && declaredStrength !== "weak" && declaredStrength !== "recurring") return false;
  return declaredStrength !== computeThemeStrength(reviewCount);
}
