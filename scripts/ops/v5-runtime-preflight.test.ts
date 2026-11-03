import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
// @ts-expect-error Plain Node runtime module.
import { validateV5RuntimeConfig, assertV5RuntimeConfig } from "./v5-runtime-preflight.mjs";
// @ts-expect-error Plain Node runtime module.
import { runLocalNext } from "../dev/local-next-runtime.mjs";

function config() {
  return { DATABASE_URL: "file:" + resolve("fixture/test.db").replaceAll("\\", "/"),
    SOURCE_LAYER_STORE_DIR: resolve("fixture/evidence"), DEMO_ACCESS_STORE_PATH: resolve("fixture/access.json") };
}
describe("V5 environment fail-fast without I/O", () => {
  it.each(["DATABASE_URL", "SOURCE_LAYER_STORE_DIR", "DEMO_ACCESS_STORE_PATH"])(
    "fails before startup when %s is missing", (field) => {
      const env = { ...config(), [field]: "" };
      expect(validateV5RuntimeConfig(env).ok).toBe(false);
      expect(() => assertV5RuntimeConfig(env)).toThrow(field);
    });
  it("rejects cwd-relative paths and incomplete Feishu configuration", () => {
    expect(validateV5RuntimeConfig({ ...config(), SOURCE_LAYER_STORE_DIR: "data/evidence" }).ok).toBe(false);
    const env = { ...config(), FEISHU_APP_ID: "fixture-app" };
    expect(validateV5RuntimeConfig(env).issues).toContainEqual({
      code: "incomplete_feishu_config", field: "FEISHU_APP_SECRET" });
  });
  it("allows core offline operation but reports Feishu as unconfigured", () => {
    expect(validateV5RuntimeConfig(config())).toMatchObject({
      ok: true, issues: [], summary: { feishu: "disabled_unconfigured" } });
  });
  it("blocks startup before port probing, database access or spawning when configuration is incomplete", async () => {
    const probe = vi.fn();
    const spawnProcess = vi.fn();
    const assertPortAvailable = vi.fn();
    await expect(runLocalNext({ cwd: resolve("fixture"), parentEnv: { FEISHU_APP_ID: "fixture-app" },
      probe, spawnProcess, assertPortAvailable })).rejects.toThrow("v5_runtime_preflight_failed");
    expect(probe).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(assertPortAvailable).not.toHaveBeenCalled();
  });
});
