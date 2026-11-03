#!/usr/bin/env node
/**
 * 从**被截断的** provider 原始文本中只读提取研究内容，供 P5 质量对照使用。
 *
 * 为什么需要它：V1 的 `maxTokens` 上限是 4000，真实调用在 #3 上会命中
 * `finish_reason=length`，整段 JSON 不闭合 → 解析器报 `RAW_TEXT_NOT_JSON`，
 * 拿不到 ResearchReport。但 `competitionInsight` / `causalInvestigations`
 * 等主体字段在截断点之前就已输出完毕，可以对**原文**做受控比较。
 *
 * 纪律：
 *  - 绝不修改原始文本，只读；
 *  - 只提取「结构完整」的对象（花括号闭合），不猜测被切断的半条；
 *  - 输出标注 `source: truncated-raw-text`，不得当成可用报告或验收结论。
 *
 * 用法：node tools/p5/extract-p5-raw-output.mjs <provider.json> [--json]
 */
import { readFileSync } from "node:fs";

/** 从 `start` 处的 `[` 起，按字符串/转义状态切出顶层对象，末尾被截断的对象丢弃。 */
function sliceTopLevelObjects(text, openIndex) {
  const objects = [];
  let index = openIndex + 1;
  while (index < text.length) {
    while (index < text.length && /[\s,]/u.test(text[index])) index += 1;
    if (index >= text.length || text[index] !== "{") break;
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { index += 1; break; }
      }
    }
    if (depth !== 0) break;
    const slice = text.slice(start, index);
    try { objects.push(JSON.parse(slice)); } catch { break; }
  }
  return objects;
}

/** 找 `"key":[` 之后的对象数组。 */
function arrayAfter(text, key) {
  const marker = `"${key}"`;
  const at = text.indexOf(marker);
  if (at < 0) return { found: false, objects: [] };
  const open = text.indexOf("[", at + marker.length);
  if (open < 0) return { found: false, objects: [] };
  return { found: true, objects: sliceTopLevelObjects(text, open) };
}

/** 找 `"key":"..."` 或 `"key":{"text":"..."}` 里的正文。 */
function textAfter(text, key) {
  const marker = `"${key}"`;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const brace = text.indexOf("{", at + marker.length);
  const quote = text.indexOf('"', at + marker.length);
  if (brace >= 0 && (quote < 0 || brace < quote)) {
    const body = text.indexOf('"text"', brace);
    if (body < 0) return null;
    return stringAfter(text, body + 6);
  }
  return stringAfter(text, at + marker.length);
}

function stringAfter(text, index) {
  let cursor = index;
  while (cursor < text.length && text[cursor] !== '"') cursor += 1;
  if (cursor >= text.length) return null;
  cursor += 1;
  let out = "";
  let escaped = false;
  for (; cursor < text.length; cursor += 1) {
    const ch = text[cursor];
    if (escaped) {
      out += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') return out;
    out += ch;
  }
  return null; // 被截断，不返回半句
}

const narrativeText = (value) => (typeof value === "string" ? value
  : (value && typeof value === "object" && typeof value.text === "string" ? value.text : null));

const narrativeRefs = (value) => (value && typeof value === "object" && Array.isArray(value.evidenceRefs)
  ? value.evidenceRefs : []);

function summarize(file) {
  const provider = JSON.parse(readFileSync(file, "utf8"));
  const raw = String(provider.rawText ?? "");
  const causes = arrayAfter(raw, "causalInvestigations").objects;
  const suggestions = arrayAfter(raw, "differentiationSuggestions").objects;
  return {
    source: "truncated-raw-text",
    file,
    rawChars: raw.length,
    parseCode: provider.draftParseCode ?? null,
    finished: provider.draftParseCode === null,
    competitionAnalysis: textAfter(raw, "competitionInsight"),
    causes: causes.map((cause) => ({
      hypothesis: narrativeText(cause.hypothesis),
      hypothesisRefs: narrativeRefs(cause.hypothesis).length,
      rationale: narrativeText(cause.rationale),
      supporting: (Array.isArray(cause.supportingEvidence) ? cause.supportingEvidence : []).map(narrativeText),
      counter: (Array.isArray(cause.counterevidence) ? cause.counterevidence : []).map(narrativeText),
      unknowns: Array.isArray(cause.unknowns) ? cause.unknowns : [],
      verification: Array.isArray(cause.verification) ? cause.verification : (typeof cause.verification === "string" ? [cause.verification] : []),
      confidence: cause.confidence ?? null,
    })),
    suggestions: suggestions.map((item) => ({ text: narrativeText(item), refs: narrativeRefs(item).length })),
  };
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/p5/extract-p5-raw-output.mjs <provider.json> [--json]");
  process.exit(2);
}
const summary = summarize(file);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`== ${file}`);
  console.log(`rawChars=${summary.rawChars} parseCode=${summary.parseCode}`);
  summary.causes.forEach((cause, index) => {
    console.log(`-- cause ${index + 1} confidence=${cause.confidence} hypothesisRefs=${cause.hypothesisRefs}`);
    console.log(`   hypothesis: ${cause.hypothesis ?? "(null)"}`);
    console.log(`   support=${cause.supporting.length} counter=${cause.counter.length} unknowns=${cause.unknowns.length} verification=${cause.verification.length}`);
    cause.counter.forEach((item) => console.log(`   counter: ${item}`));
    cause.verification.forEach((item) => console.log(`   verify: ${item}`));
  });
  console.log(`-- suggestions=${summary.suggestions.length}`);
}
