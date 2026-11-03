import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifySavedP5Evidence } from "./verify-saved-evidence";

it("checks saved identity/usage/draft and refuses corruption without upgrading semantic status", () => {
  const dir = mkdtempSync(join(tmpdir(), "p5-manifest-"));
  const put = (name: string, value: unknown) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  const draft = { competitionInsight: { counterevidence: [] } };
  put("draft", draft); put("synthesis-result", { data: draft });
  put("provider-response", { body: JSON.stringify({ model: "deepseek-flash", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    choices: [{ message: { content: JSON.stringify(draft) } }] }) });
  const binding = { taskId: "task", candidateId: "candidate", subjectKey: "subject" };
  put("request-body", { messages: [{ content: "system" }, { content: JSON.stringify({ ...binding, allowedEvidenceRefs: ["evidence:1"] }) }] });
  put("report", { ...binding, ai: { model: "deepseek-flash", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } } });
  put("legal-evidence", { allowedEvidenceRefs: ["evidence:1"] });
  put("gate", { requests: 1, state: { requests: 1, unsettled: 0, records: [{ settled: true }] } });
  for (const name of ["preflight", "quality", "semantic-review", "citation-validation"]) put(name, {});
  put("citation-validation", []);
  const before = readFileSync(join(dir, "draft.json"), "utf8");
  expect(verifySavedP5Evidence(dir).semanticQuality).toBe("PARTIAL_OR_NOT_VERIFIED");
  expect(readFileSync(join(dir, "draft.json"), "utf8")).toBe(before);
  put("draft", { modified: true });
  expect(() => verifySavedP5Evidence(dir)).toThrow("RAW_DRAFT_MISMATCH");
});
