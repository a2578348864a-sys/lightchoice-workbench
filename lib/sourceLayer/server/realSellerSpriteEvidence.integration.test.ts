import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sellerSpriteAdapter } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";

const realWorkbookPath = process.env.V5_2_REAL_SELLERSPRITE_XLSX;
const operator = "owner:v1";
const subjectKey = "amazon:US:B07G4VTV2F";
const capturedAt = "2026-09-25T00:00:00.000Z";

let previousStoreDir: string | undefined;
let isolatedStoreDir: string | null = null;

afterEach(() => {
  if (previousStoreDir === undefined) delete process.env.SOURCE_LAYER_STORE_DIR;
  else process.env.SOURCE_LAYER_STORE_DIR = previousStoreDir;
  previousStoreDir = undefined;
  if (isolatedStoreDir && existsSync(isolatedStoreDir)) rmSync(isolatedStoreDir, { recursive: true, force: true });
  isolatedStoreDir = null;
});

describe("real SellerSprite workbook EvidenceStore acceptance", () => {
  it.skipIf(!realWorkbookPath)("validates the real B07G4VTV2F XLSX and appends only to an isolated EvidenceStore", async () => {
    if (!realWorkbookPath) return;
    previousStoreDir = process.env.SOURCE_LAYER_STORE_DIR;
    isolatedStoreDir = mkdtempSync(join(tmpdir(), "lightchoice-v5-2-real-xlsx-"));
    process.env.SOURCE_LAYER_STORE_DIR = isolatedStoreDir;

    const bytes = new Uint8Array(readFileSync(realWorkbookPath));
    const captured = sellerSpriteAdapter.capture({ payload: bytes, capturedAt, operator });
    expect(captured.errorCodes).not.toContain("SELECTOR_FAILED");
    expect(captured.drafts.map((draft) => draft.subjectKey)).toContain(subjectKey);

    const draft = captured.drafts.find((candidate) => candidate.subjectKey === subjectKey);
    expect(draft).toBeDefined();
    if (!draft) return;
    const pkg = sellerSpriteAdapter.normalize({ draft, captureId: "cap-real-sellersprite-b07g4vtv2f", version: 1 });
    const outcome = sellerSpriteAdapter.validate({ pkg, context: { now: capturedAt } });
    expect(outcome.report.verdict).toBe("passed");
    expect(outcome.report.issues.map((issue) => issue.error.code)).not.toContain("LOW_CONFIDENCE");
    expect(outcome.pkg.fieldStates.estimatedMonthlySales.status).toBe("estimated");
    expect(outcome.pkg.fieldStates.estimatedMonthlySales.confidence).toBeLessThan(1);

    const evidence = sellerSpriteAdapter.createEvidence({ pkg, report: outcome.report });
    const store = createEvidenceStore(operator);
    const append = await store.appendEvidence({ evidence, auditEntries: [], operator, now: new Date(capturedAt) });
    const stored = await store.getSubject(subjectKey);

    expect(append.created).toBe(true);
    expect(stored?.versions).toHaveLength(1);
    expect(stored?.versions[0]).toMatchObject({ subjectKey, sourceType: "sellersprite_xlsx", version: 1, factAuthority: "evidence_only", validation: { verdict: "passed", readyForResearch: true } });
    expect(stored?.versions[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
