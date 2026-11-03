import type { ProductBrief } from "./contract";

export type BriefDiffKind = "source" | "manual" | "status";

export type BriefDiffRow = {
  key: string;
  label: string;
  /** 展示用短文本；null 表示该版本没有这一项。 */
  before: string | null;
  after: string | null;
  kind: BriefDiffKind;
};

function shortLine(line: { text: string; nature?: string } | null | undefined): string | null {
  if (!line) return null;
  const text = line.text?.trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function countOrNull(value: readonly unknown[] | undefined | null): string | null {
  if (!Array.isArray(value)) return null;
  return `${value.length} 项`;
}

function firstLines(lines: readonly { text: string; nature?: string }[] | undefined, max = 2): string | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const head = lines.slice(0, max).map((line) => shortLine(line)).filter(Boolean) as string[];
  if (head.length === 0) return null;
  return head.join("；") + (lines.length > max ? ` 等 ${lines.length} 项` : "");
}

function specSummary(brief: ProductBrief): string | null {
  const rows = brief.specifications;
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) return "无规格行";
  return rows.slice(0, 2).map((row) => `${row.label ?? row.id}：${row.value ?? "未知"}`).join("；") + (rows.length > 2 ? ` 等 ${rows.length} 行` : "");
}

function money(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(2);
}

/**
 * P3-02｜只读版本差异：把"旧 Brief"与"将要生成的新 Brief"逐项对比。
 *
 * 只做展示层比较：不判断哪一版更好、不写库、不改任何字段性质。
 * 人工字段（规格/确认项/对照/验证计划/定位）单独标 manual，供用户决定保留还是替换。
 */
export function diffBriefVersions(before: ProductBrief, after: ProductBrief): BriefDiffRow[] {
  const rows: BriefDiffRow[] = [];
  const push = (key: string, label: string, beforeValue: string | null, afterValue: string | null, kind: BriefDiffKind = "source") => {
    if (beforeValue === afterValue) return;
    rows.push({ key, label, before: beforeValue, after: afterValue, kind });
  };

  push(
    "binding.researchRevision",
    "来源研究版本",
    `rev.${before.sourceBinding.researchRevision}`,
    `rev.${after.sourceBinding.researchRevision}`,
    "status",
  );
  push("status", "文档状态", before.status, after.status, "status");
  push("projectOverview", "项目概述", shortLine(before.projectOverview), shortLine(after.projectOverview));
  push("targetUser", "目标用户", shortLine(before.targetUser), shortLine(after.targetUser));
  push("positioning", "产品定位", shortLine(before.positioning), shortLine(after.positioning), "manual");
  push("corePainPoints", "核心痛点", firstLines(before.corePainPoints), firstLines(after.corePainPoints));
  push("differentiation", "差异化方向", firstLines(before.differentiation), firstLines(after.differentiation));
  push("competitiveHypotheses", "竞争性原因假设", firstLines(before.competitiveHypotheses), firstLines(after.competitiveHypotheses));
  push("researchAlternatives", "备选方向", firstLines(before.researchAlternatives), firstLines(after.researchAlternatives));
  push("counterevidence", "反证", firstLines(before.counterevidence), firstLines(after.counterevidence));
  push("risks", "风险", firstLines(before.risks), firstLines(after.risks));
  push("missingValidation", "仍缺验证", countOrNull(before.missingValidation), countOrNull(after.missingValidation));
  push("economics.targetPrice", "目标售价", money(before.economics.targetPrice), money(after.economics.targetPrice));
  push("economics.targetMarginPct", "目标毛利率", money(before.economics.targetMarginPct), money(after.economics.targetMarginPct));
  push("specifications", "规格方向（人工）", specSummary(before), specSummary(after), "manual");
  push("confirmationItems", "待确认事项（人工）", countOrNull(before.confirmationItems), countOrNull(after.confirmationItems), "manual");
  push("benchmarkComparison", "竞品对照（人工）", before.benchmarkComparison ? "已有对照表" : null, after.benchmarkComparison ? "已有对照表" : null, "manual");
  push("verificationPlan", "验证计划（人工）", countOrNull(before.verificationPlan), countOrNull(after.verificationPlan), "manual");
  push("researchAssumptions", "未验证假设", countOrNull(before.researchAssumptions), countOrNull(after.researchAssumptions));

  return rows;
}

/** 只统计"会改变内容"的条目，用于提示用户是否需要逐项确认。 */
export function summarizeBriefDiff(rows: readonly BriefDiffRow[]): { total: number; manual: number; source: number } {
  return {
    total: rows.length,
    manual: rows.filter((row) => row.kind === "manual").length,
    source: rows.filter((row) => row.kind === "source" || row.kind === "status").length,
  };
}
