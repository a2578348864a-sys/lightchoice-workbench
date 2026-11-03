import { describe, expect, it } from "vitest";
import { assertRealDataWriteGuard } from "@/lib/server/testSafety/realDataWriteGuard";

/**
 * WRITE_ACCEPTANCE_TEST —— VOC 持久化真实数据写验收（与只读套件彻底分离）。
 *
 * 默认 `npm test`：opt-in 未设置 → 不执行任何写（describe.runIf 收敛）。
 * 显式 V5_REAL_DATA_WRITE_TEST=1：必须同时给出派生 DATABASE_URL / SOURCE_LAYER_STORE_DIR；
 * 任一指向正式路径或缺失 → assertRealDataWriteGuard 硬抛 REFUSE_PRODUCTION_WRITE_TEST。
 *
 * 运行方式（派生副本，见 docs/reports/V5_PRODUCT_EXPERIENCE_TEST_SAFETY_CLOSEOUT_2026-10-05.md）：
 *   V5_REAL_DATA_WRITE_TEST=1
 *   DATABASE_URL=file:<derived>/database.sqlite
 *   SOURCE_LAYER_STORE_DIR=<derived>/evidence
 *   npx vitest run lib/server/customerVoice.realDataWrite.test.ts
 */
const verdict = assertRealDataWriteGuard({
  optInEnv: process.env.V5_REAL_DATA_WRITE_TEST,
  databaseUrl: process.env.DATABASE_URL,
  evidenceStoreDir: process.env.SOURCE_LAYER_STORE_DIR,
  cwd: process.cwd(),
});

const context = { mode: "owner", token: "" } as const;
const REAL_TASK_ID = "cmuax1zja000312l7iffedd33";

describe.runIf(verdict.execute)("CustomerVoice Real Data WRITE Acceptance (derived copy only)", () => {
  it("analyzeVocForResearchTask persists voc-analysis.v1 into the derived task with non-empty citation refs", async () => {
    const { analyzeVocForResearchTask } = await import("@/lib/server/customerVoiceService");
    const { getVocAnalysis } = await import("@/lib/server/vocAnalysis");

    const vocResult = await analyzeVocForResearchTask({
      context,
      taskId: REAL_TASK_ID,
    });
    expect(vocResult.analysis).toBeDefined();
    expect(vocResult.analysis.schema).toBe("voc-analysis.v1");
    expect(vocResult.gateResult).toBe("pass");

    const persisted = await getVocAnalysis(context, REAL_TASK_ID);
    expect(persisted).toBeDefined();
    expect(persisted?.schema).toBe("voc-analysis.v1");
    expect((persisted?.themes.positiveThemes.length ?? 0) + (persisted?.themes.painPointThemes.length ?? 0)).toBeGreaterThan(0);

    // citation refs（evidenceRefs）非空 —— voc-analysis 必须携带真实证据引用
    const refs: string[] = [];
    const walk = (node: unknown, depth: number): void => {
      if (depth > 8 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      const record = node as Record<string, unknown>;
      const list = record.evidenceRefs;
      if (Array.isArray(list)) {
        for (const ref of list) {
          if (typeof ref === "string" && ref) refs.push(ref);
          else if (ref && typeof ref === "object" && typeof (ref as { refId?: unknown }).refId === "string") {
            refs.push((ref as { refId: string }).refId);
          }
        }
      }
      for (const value of Object.values(record)) walk(value, depth + 1);
    };
    walk(persisted, 0);
    expect(new Set(refs).size).toBeGreaterThan(0);
  });
});

describe.runIf(!verdict.execute && !verdict.refusal)("CustomerVoice Real Data WRITE Acceptance (opt-in not set)", () => {
  it("does not execute: set V5_REAL_DATA_WRITE_TEST=1 with derived DATABASE_URL and SOURCE_LAYER_STORE_DIR to run", () => {
    expect(verdict.execute).toBe(false);
  });
});
