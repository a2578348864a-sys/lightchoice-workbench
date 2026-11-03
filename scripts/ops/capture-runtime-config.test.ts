import { describe, expect, it } from "vitest";
import { buildPersonalCaptureEnv, readCaptureRuntimeConfig, resolveAmazonCaptureProfileDirectory, validatePersonalCaptureConfig } from "./capture-runtime-config.mjs";
import { resolve } from "node:path";

describe("personal capture runtime contract", () => {
  it("allows active capture without enabling background workers or paid Providers", () => {
    const env = buildPersonalCaptureEnv({ OPENAI_API_KEY: "fixture-secret", SELLERSPRITE_CDP_ENDPOINT: "http://127.0.0.1:9222", AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:8080", V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER: "1" }, resolve("fixture/amazon-us"));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AMAZON_CAPTURE_PROXY_URL).toBe("http://127.0.0.1:8080");
    expect(env.SELLERSPRITE_CDP_ENDPOINT).toBe("http://127.0.0.1:9222");
    expect(readCaptureRuntimeConfig(env)).toMatchObject({ enabled: true, detailExecution: "manual_only", sessionStatus: "not_checked" });
    expect(validatePersonalCaptureConfig(env)).toEqual([]);
  });
  it("fails before launch if an upgrade loses the capture flag or fixed profile", () => {
    expect(validatePersonalCaptureConfig({ V5_RUNTIME_PURPOSE: "personal-workbench" }).map(x => x.field))
      .toEqual(["LOCAL_ACQUISITION_ENABLED", "AMAZON_CAPTURE_PROFILE_DIR"]);
    expect(() => resolveAmazonCaptureProfileDirectory({ AMAZON_CAPTURE_PROFILE_DIR: "relative/profile" })).toThrow("AMAZON_CAPTURE_PROFILE_INVALID");
  });
  it("keeps ordinary offline test runtimes supported, with no claims about login", () => {
    expect(validatePersonalCaptureConfig({})).toEqual([]);
    expect(readCaptureRuntimeConfig({})).toMatchObject({ enabled: false, sessionStatus: "not_checked" });
    const cwd = resolve("fixture/build-copy");
    expect(resolveAmazonCaptureProfileDirectory({}, cwd)).toBe(resolve(cwd, ".playwright-profile/amazon-us"));
  });
  it("rejects accidental background activation in personal mode", () => {
    const env = buildPersonalCaptureEnv({}, resolve("fixture/amazon-us"));
    expect(validatePersonalCaptureConfig({ ...env, V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER: "1", V5_DISABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER: "0" })).toContainEqual({ field: "V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER", code: "background_scheduler_not_authorized" });
  });
});
