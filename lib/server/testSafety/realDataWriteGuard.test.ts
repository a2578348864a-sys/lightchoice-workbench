import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRealDataWriteGuard,
  canonicalizePath,
  evaluateRealDataWriteGuard,
  formalDatabasePath,
  formalEvidenceStorePath,
} from "@/lib/server/testSafety/realDataWriteGuard";

const CWD = process.cwd();
const FORMAL_DB = resolve(CWD, "prisma/dev.db");
const FORMAL_EV = resolve(CWD, "data/source-layer-store");
const DERIVED_DB = "file:/tmp/lightchoice-smoke/exp-x/database.sqlite";
const DERIVED_EV = "/tmp/lightchoice-smoke/exp-x/evidence";

function source(path: string): string {
  return readFileSync(resolve(CWD, path), "utf8");
}

describe("realDataWriteGuard — fail-closed production write protection", () => {
  it("1. default environment: mutating real-data write test does not execute (no opt-in)", () => {
    const v = evaluateRealDataWriteGuard({ optInEnv: undefined, databaseUrl: undefined, evidenceStoreDir: undefined, cwd: CWD });
    expect(v.execute).toBe(false);
    expect(v.refusal).toBeNull();
    // 写测试文件必须用 runIf(verdict.execute) 收敛，默认不进入用例
    const writeTest = source("lib/server/customerVoice.realDataWrite.test.ts");
    expect(writeTest).toContain("assertRealDataWriteGuard");
    expect(writeTest).toContain("describe.runIf(verdict.execute)");
    expect(writeTest).toContain("V5_REAL_DATA_WRITE_TEST");
  });

  it("2. opt-in with DATABASE_URL = formal prisma/dev.db → REFUSE_PRODUCTION_WRITE_TEST (file: form)", () => {
    expect(() =>
      assertRealDataWriteGuard({
        optInEnv: "1",
        databaseUrl: `file:${FORMAL_DB.replaceAll("\\", "/")}`,
        evidenceStoreDir: DERIVED_EV,
        cwd: CWD,
      })
    ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
  });

  it("2b. path canonicalization is case-insensitive on Windows (REFUSE) and exact on POSIX (REFUSE exact formal path)", () => {
    if (process.platform === "win32") {
      // Windows 文件系统大小写不敏感 → 归一化后必须命中正式路径并拒绝
      const upper = FORMAL_DB.toUpperCase();
      expect(canonicalizePath(upper, CWD)).toBe(formalDatabasePath(CWD));
      expect(() =>
        assertRealDataWriteGuard({ optInEnv: "1", databaseUrl: upper, evidenceStoreDir: DERIVED_EV, cwd: CWD })
      ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
    } else {
      // POSIX 文件系统大小写敏感 → 大小写不同路径本就不同（不误伤）；
      // 但精确正式路径同样必须被拒绝
      expect(canonicalizePath(FORMAL_DB, CWD)).toBe(formalDatabasePath(CWD));
      expect(() =>
        assertRealDataWriteGuard({
          optInEnv: "1",
          databaseUrl: `file:${FORMAL_DB}`,
          evidenceStoreDir: DERIVED_EV,
          cwd: CWD,
        })
      ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
    }
  });

  it("3. opt-in with SOURCE_LAYER_STORE_DIR = formal evidence store → REFUSE", () => {
    expect(() =>
      assertRealDataWriteGuard({
        optInEnv: "1",
        databaseUrl: DERIVED_DB,
        evidenceStoreDir: FORMAL_EV,
        cwd: CWD,
      })
    ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
  });

  it("3b. opt-in with missing explicit env → REFUSE (fail-closed, never falls back to formal defaults)", () => {
    expect(() =>
      assertRealDataWriteGuard({ optInEnv: "1", databaseUrl: undefined, evidenceStoreDir: undefined, cwd: CWD })
    ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
    expect(() =>
      assertRealDataWriteGuard({ optInEnv: "1", databaseUrl: DERIVED_DB, evidenceStoreDir: null, cwd: CWD })
    ).toThrow("REFUSE_PRODUCTION_WRITE_TEST");
  });

  it("4. derived DB + derived EvidenceStore + explicit env → write test may execute", () => {
    const v = assertRealDataWriteGuard({
      optInEnv: "1",
      databaseUrl: DERIVED_DB,
      evidenceStoreDir: DERIVED_EV,
      cwd: CWD,
    });
    expect(v.execute).toBe(true);
    expect(v.refusal).toBeNull();
  });

  it("5. read-only real-data suite runs against formal data but never imports/invokes mutating services", () => {
    const readOnly = source("lib/server/customerVoice.realData.test.ts");
    expect(readOnly).toContain("listCustomerVoiceForResearchTask");
    expect(readOnly).not.toContain("analyzeVocForResearchTask");
    expect(readOnly).not.toContain("importReviews");
    expect(readOnly).not.toContain("mutateTaskResultJson");
    // 默认测试不得输出整段正式 Evidence payload（只允许 kind/id 级日志）
    expect(readOnly).not.toContain("payload }");
    expect(readOnly).not.toMatch(/console\.log\([^)]*payload/);
    // 读套件必须与写套件文件分离
    expect(readOnly).not.toContain("customerVoice.realDataWrite");
    expect(readOnly).toContain("READ_ONLY");
  });

  it("formal path definitions follow the required resolve(cwd, ...) contract", () => {
    expect(formalDatabasePath(CWD)).toBe(canonicalizePath(FORMAL_DB, CWD));
    expect(formalEvidenceStorePath(CWD)).toBe(canonicalizePath(FORMAL_EV, CWD));
  });
});
