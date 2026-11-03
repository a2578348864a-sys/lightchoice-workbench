import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** P5-04 reusable read-only evidence check. Never loads keys, DB or providers. */
export function verifySavedP5Evidence(directory: string) {
  const files = ["request-body", "provider-response", "draft", "synthesis-result", "legal-evidence",
    "citation-validation", "report", "quality", "semantic-review", "preflight", "gate"];
  const hashes: Record<string, string> = {};
  const data: Record<string, Record<string, unknown>> = {};
  for (const name of files) {
    const raw = readFileSync(resolve(directory, `${name}.json`), "utf8");
    if (/\bsk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|"(?:authorization|cookie|api_key|access_token)"\s*:/iu.test(raw)) {
      throw new Error(`SENSITIVE_EVIDENCE:${name}`);
    }
    hashes[name] = createHash("sha256").update(raw).digest("hex");
    data[name] = JSON.parse(raw);
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const provider = JSON.parse(String(data["provider-response"]!.body));
  if (canonical(JSON.parse(provider.choices[0].message.content)) !== canonical(data.draft)) throw new Error("RAW_DRAFT_MISMATCH");
  if (canonical(data["synthesis-result"]!.data) !== canonical(data.draft)) throw new Error("SYNTHESIS_DRAFT_MISMATCH");
  const usage = provider.usage;
  const ai = data.report!.ai as { model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } };
  if (ai.model !== provider.model || ai.usage.promptTokens !== usage.prompt_tokens
    || ai.usage.completionTokens !== usage.completion_tokens || ai.usage.totalTokens !== usage.total_tokens
    || usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) throw new Error("MODEL_USAGE_MISMATCH");
  const request = data["request-body"]! as { messages: { content: string }[] };
  const payload = JSON.parse(request.messages[1]!.content);
  const report = data.report!;
  if (payload.taskId !== report.taskId || payload.candidateId !== report.candidateId || payload.subjectKey !== report.subjectKey) {
    throw new Error("SUBJECT_BINDING_MISMATCH");
  }
  if (canonical(payload.allowedEvidenceRefs) !== canonical(data["legal-evidence"]!.allowedEvidenceRefs)) throw new Error("REGISTRY_MISMATCH");
  const allowed = new Set(payload.allowedEvidenceRefs as string[]);
  const citations: { path: string; ref: string; allowed: boolean }[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "evidenceRefs" && Array.isArray(item)) {
        for (const ref of item) if (typeof ref === "string") citations.push({ path, ref, allowed: allowed.has(ref) });
      } else visit(item, `${path}.${key}`);
    }
  };
  visit(data.draft, "draft");
  if (canonical(citations) !== canonical(data["citation-validation"])) throw new Error("CITATION_AUDIT_MISMATCH");
  const gate = data.gate! as { requests: number; state: { requests: number; unsettled: number; records: { settled: boolean }[] } };
  if (gate.requests !== 1 || gate.state.requests !== 1 || gate.state.unsettled !== 0
    || gate.state.records.length !== 1 || !gate.state.records[0]!.settled) throw new Error("GATE_RECONCILIATION_FAILED");
  return { schema: "p5-saved-evidence-check.v1", completeness: "PASS", binding: "PASS", hashes,
    requests: gate.requests, model: ai.model, usage: ai.usage,
    semanticQuality: data["semantic-review"]!.fullQualityPass === true ? "RECORDED_PASS_NOT_REJUDGED" : "PARTIAL_OR_NOT_VERIFIED",
    note: "Evidence integrity only. Does not re-judge semantics, authorize calls, verify current Build or close P5." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: npx tsx tools/p5/verify-saved-evidence.ts <isolated-evidence-directory>");
  console.log(JSON.stringify(verifySavedP5Evidence(process.argv[2]), null, 2));
}
