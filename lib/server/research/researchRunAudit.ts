import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ResearchEngineInput, ResearchEvidenceRef, ResearchReport } from "@/lib/research/researchContracts";
import { PEAK_PRICE_USD_PER_MTOK } from "./batchInputBudget";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const physicalPath = (path: string) => {
  let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, resolve(path)));
};

/** Per-run audit files are not product facts. No credentials or headers enter this boundary. */
export function startResearchRunAudit(input: ResearchEngineInput, snapshot: unknown, root?: string) {
  const artifactId = sha(`${input.taskId}\n${input.runId}`);
  const directory = resolve(root ?? process.env.RESEARCH_AUDIT_DIR ?? ".local/research-run-audits", artifactId);
  let errorCode: string | null = null;
  let responseCaptured = false;
  let redacted = false;
  const hashes: Record<string, string> = {};
  const serialize = (value: unknown) => JSON.stringify(value, (key, item) => {
    if (/^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token)$/iu.test(key)) { redacted = true; return "[REDACTED]"; }
    if (typeof item === "string") return item.replace(/\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/giu, () => { redacted = true; return "[REDACTED]"; });
    return item;
  }, 2);
  const write = (name: string, value: unknown) => {
    if (errorCode) return;
    try {
      const text = serialize(value);
      writeFileSync(resolve(directory, `${name}.json`), text, { encoding: "utf8", flag: "wx" });
      hashes[name] = sha(text);
    } catch { errorCode = "AUDIT_WRITE_FAILED"; }
  };
  try {
    const factRoot = physicalPath(process.env.SOURCE_LAYER_STORE_DIR ?? "data/source-layer-store");
    const rel = relative(factRoot, physicalPath(directory));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("NOT_AUDIT_STORAGE");
    mkdirSync(directory, { recursive: false });
  } catch {
    // Parent is allowed to be created, but existing run directories must never be overwritten.
    try {
      const parent = resolve(directory, "..");
      const factRoot = physicalPath(process.env.SOURCE_LAYER_STORE_DIR ?? "data/source-layer-store");
      const rel = relative(factRoot, physicalPath(directory));
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("NOT_AUDIT_STORAGE");
      mkdirSync(parent, { recursive: true });
      mkdirSync(directory);
    } catch { errorCode = "AUDIT_STORAGE_UNAVAILABLE"; }
  }
  const inputText = serialize(snapshot);
  const inputHash = sha(inputText);
  write("input", { schema: "research-run-input.v1", taskId: input.taskId, candidateId: input.candidateId,
    runId: input.runId, subjectKey: input.productFact.subjectKey, inputHash, snapshot });
  return {
    ready: () => errorCode === null,
    captureProvider(response: unknown) {
      responseCaptured = true;
      const content = record(record((record(response).choices as unknown[] | undefined)?.[0]).message).content;
      let rawDraft: unknown = null;
      let draftParseCode = "RAW_TEXT_NOT_JSON";
      if (typeof content === "string") {
        try { rawDraft = JSON.parse(content); draftParseCode = "RAW_JSON_PARSED"; } catch { /* text retained verbatim */ }
      }
      write("provider", { schema: "research-provider-response.v1", representation: "provider_sdk_json_body",
        responseId: record(response).id ?? null, response, rawText: content ?? null, rawDraft, draftParseCode });
    },
    write,
    finish(report: ResearchReport, providerCallStarted: boolean, hashReport: (report: ResearchReport) => string) {
      if (providerCallStarted && !responseCaptured && !errorCode) errorCode = "PROVIDER_RESPONSE_NOT_CAPTURED";
      const summary = () => ({ status: errorCode ? "incomplete" as const : "complete" as const,
        artifactId, inputHash, errorCode, redacted });
      let audited: ResearchReport = { ...report, audit: summary() };
      const reportHash = hashReport(audited);
      write("report", { reportHash, report: audited });
      write("manifest", { schema: "research-run-audit.v1", taskId: input.taskId, candidateId: input.candidateId,
        runId: input.runId, subjectKey: input.productFact.subjectKey, reportHash, hashes: { ...hashes }, ...summary() });
      // Failures do not discard analysis or report success as fully auditable.
      if (errorCode) audited = { ...report, audit: summary() };
      return audited;
    },
  };
}

/** Uses the engine's actual resolved-ref registry, not a second whitelist. */
/**
 * 「确实有内容」判定：用于区分「模型没给」和「模型给了但形状不认识」。
 * 前者是正常缺失，后者必须留下可追踪的诊断，不能静默丢弃。
 */
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * 数组元素级支持判定：与 `researchEngine` 的 `strings()` 归一化规则保持一致。
 *
 * `UNRECOGNIZED_SHAPE_DROPPED` 只能发现「整字段被清空」；如果模型给的是
 * `["A", {"text":"B"}, {"steps":["C"]}]`，解析器保留 A、B、丢掉 C，最终数组非空，
 * 旧审计看不出任何异常。这里逐项识别不支持的非空元素，避免**部分**静默丢失。
 */
function unsupportedListElements(original: unknown): { index: number; value: unknown }[] {
  if (!Array.isArray(original)) return [];
  const dropped: { index: number; value: unknown }[] = [];
  original.forEach((item, index) => {
    const supported = typeof item === "string"
      || (item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string");
    if (!supported) dropped.push({ index, value: item });
  });
  return dropped;
}

export function auditResearchParsing(input: ResearchEngineInput, draft: unknown, report: ResearchReport,
  registry: ReadonlyMap<string, ResearchEvidenceRef>, causes: readonly { rawIndex: number; finalIndex: number | null }[]) {
  const citations: { path: string; ref: unknown; accepted: boolean; code: string; canonicalRef?: string }[] = [];
  const known = input.researchInputBundle?.sourceEvidenceRefs ?? [];
  const currentVersion = known.find((r) => r.kind === "product_evidence" && r.evidenceId === input.productFact.sourceProof.evidenceId)?.version;
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`)); return; }
    for (const [key, item] of Object.entries(record(value))) {
      if (key === "evidenceRefs" && Array.isArray(item)) {
        for (const ref of item) {
          const resolved = typeof ref === "string" ? registry.get(ref) : undefined;
          const candidate = known.find((r) => r.refId === ref);
          const code = resolved ? "REF_ACCEPTED" : typeof ref !== "string" ? "REF_FORMAT_INVALID"
            : candidate?.subjectKey && candidate.subjectKey !== input.productFact.subjectKey ? "REF_SUBJECT_MISMATCH"
              : candidate && currentVersion !== undefined && candidate.version !== currentVersion ? "REF_VERSION_MISMATCH"
                : candidate ? "REF_NOT_ALLOWED" : "REF_UNKNOWN";
          citations.push({ path, ref, accepted: Boolean(resolved), code, ...(resolved ? { canonicalRef: resolved.refId } : {}) });
        }
      } else visit(item, `${path}.${key}`);
    }
  };
  visit(draft, "draft");
  const rawCauses = record(record(draft).competitionInsight).causalInvestigations;
  return { schema: "research-parsing-audit.v1", citations,
    causes: causes.map(({ rawIndex, finalIndex }) => {
      const raw = Array.isArray(rawCauses) ? rawCauses[rawIndex] : null;
      const final = finalIndex === null ? null : report.competitionInsight.causalInvestigations?.[finalIndex] ?? null;
      const fields = ["hypothesis", "rationale", "supportingEvidence", "counterevidence", "unknowns", "verification"].map((field) => {
        const original = record(raw)[field] ?? null;
        const retained = record(final)[field] ?? null;
        const isListField = field === "unknowns" || field === "verification";
        const droppedElements = isListField ? unsupportedListElements(original) : [];
        const code = typeof original === "string" && isListField ? "STRING_NORMALIZED_TO_LIST"
          : final === null ? "CAUSE_EMPTY_OR_UNBOUND"
            // 2026-10-29：模型确实给了内容、但形状不在已支持范围内（例如 verification 用了
            // 既非 string/string[] 也非 {text}/{text}[] 的结构）时，解析器会丢弃它。
            // 丢弃本身可以接受，**静默**丢弃不行——这里留下可追踪的异常码。
            : isListField && hasContent(original) && Array.isArray(retained) && retained.length === 0
              ? "UNRECOGNIZED_SHAPE_DROPPED"
              // 部分元素丢失：数组非空，但其中有解析器不支持的项被丢掉。
              : droppedElements.length > 0 ? "PARTIAL_ELEMENTS_DROPPED"
                : field === "hypothesis" && record(retained).text ? "CAUSAL_CLAIM_IS_HYPOTHESIS"
                  : field === "hypothesis" && original && !record(retained).text ? "NO_LEGAL_CITATION"
                    : "RAW_AND_FINAL_RECORDED";
        return { field, original, retained, code, ...(droppedElements.length > 0 ? { droppedElements } : {}) };
      });
      return { rawIndex, finalIndex, raw, final, fields, codes: [
        ...(final === null ? ["CAUSE_EMPTY_OR_UNBOUND"] : ["CAUSAL_CLAIM_IS_HYPOTHESIS"]),
        ...(final && final.supportingEvidence.length === 0 ? ["NO_LEGAL_SUPPORT"] : []),
        ...(typeof record(raw).verification === "string" || typeof record(raw).unknowns === "string" ? ["STRING_NORMALIZED_TO_LIST"] : []),
        ...(fields.some((field) => field.code === "UNRECOGNIZED_SHAPE_DROPPED") ? ["UNRECOGNIZED_SHAPE_DROPPED"] : []),
        ...(fields.some((field) => field.code === "PARTIAL_ELEMENTS_DROPPED") ? ["PARTIAL_ELEMENTS_DROPPED"] : []),
        ...(final?.hypothesis.semanticReview ? ["SEMANTIC_REVIEW_REQUIRED"] : []),
      ] };
    }),
  };
}

export function researchUsageCost(report: ResearchReport) {
  const model = report.ai.model;
  const tariff = model && Object.prototype.hasOwnProperty.call(PEAK_PRICE_USD_PER_MTOK, model)
    ? PEAK_PRICE_USD_PER_MTOK[model as keyof typeof PEAK_PRICE_USD_PER_MTOK] : null;
  const usage = report.ai.usage;
  const calculable = tariff && typeof usage?.promptTokens === "number" && typeof usage.completionTokens === "number";
  return { actualBilledCny: null,
    conservativePeakCostUsd: calculable ? (usage.promptTokens! * tariff.input + usage.completionTokens! * tariff.output) / 1_000_000 : null,
    priceSource: "https://api-docs.deepseek.com/quick_start/pricing/", tariff: tariff ?? null,
    note: "Peak/cache-miss estimate from captured usage, not an account bill. Missing usage is unknown, never zero." };
}
