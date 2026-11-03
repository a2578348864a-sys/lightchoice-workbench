import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mjs)$/.test(entry)) files.push(path);
  }
  return files;
}

const SOURCE_FILE_SNAPSHOTS = [join(process.cwd(), "app"), join(process.cwd(), "lib"), join(process.cwd(), "scripts")]
  .flatMap(sourceFiles)
  .map((absolutePath) => ({
    path: relative(process.cwd(), absolutePath).replaceAll("\\", "/"),
    absolutePath,
  }))
  .filter(({ path }) => path !== "lib/server/mutationBoundary.test.ts")
  .map(({ path, absolutePath }) => ({ path, source: readFileSync(absolutePath, "utf8") }));

function importers(fragment: string) {
  return SOURCE_FILE_SNAPSHOTS
    .filter(({ source }) => source.includes(fragment))
    .map(({ path }) => path)
    .sort();
}

describe("task and Visitor Store internal mutation boundaries", () => {
  it("keeps the Visitor Store I/O owner behind the two approved adapters", () => {
    expect(importers("@/lib/server/demoSandboxStore.internal")).toEqual([
      "lib/auth/demo/demoProductJourneyQuota.ts",
      "lib/auth/sandbox/demoSandbox.ts",
      "lib/auth/sandbox/demoSandboxTaskMutation.internal.ts",
    ]);
    expect(importers("@/lib/server/demoSandboxTaskMutation.internal").filter((path) => !path.includes(".test."))).toEqual([
      "lib/server/taskResultJsonMutation.ts",
    ]);
  });

  it("keeps Owner low-level CAS and test support out of production callers", () => {
    expect(importers("@/lib/server/taskResultJsonMutation.owner.internal")).toEqual([
      "lib/server/taskResultJsonMutation.testSupport.ts",
      "lib/server/taskResultJsonMutation.ts",
    ]);
    // PR2-2 Final-Fix (P1-2): 并发 e2e 经公开 test-support 适配器访问 CAS（不再直接 import owner.internal）
    expect(importers("@/lib/server/taskResultJsonMutation.testSupport")).toEqual([
      "lib/server/taskResultJsonMutation.sqlite.test.ts",
    ]);
    const publicModule = readFileSync(join(process.cwd(), "lib/server/taskResultJsonMutation.ts"), "utf8");
    expect(publicModule).not.toContain("export async function loadOwnerTaskResultJsonSnapshot");
    expect(publicModule).not.toContain("export async function commitOwnerTaskResultJsonMutation");
    expect(publicModule).not.toContain("mutateOwnerTaskResultJsonForTest");
  });
});
