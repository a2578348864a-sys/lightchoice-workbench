import { describe, expect, it } from "vitest";
import {
  getV5HubConfig,
  isV5HubTestFixtureAllowed,
  V5_HUB_AUTHORIZED_TEST_BASE_ID,
  V5_HUB_CONFIG_ENV_KEYS,
  V5_HUB_TEST_BASE_TABLE_IDS,
  V5HubConfigError,
} from "./v5HubConfig";

describe("v5HubConfig explicit configuration layer", () => {
  const fullMockEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    V5_HUB_BASE_ID: "appExplicitBase123",
    V5_HUB_TABLE_T01: "tblExplicit01",
    V5_HUB_TABLE_T02: "tblExplicit02",
    V5_HUB_TABLE_T03: "tblExplicit03",
    V5_HUB_TABLE_T04: "tblExplicit04",
    V5_HUB_TABLE_T05: "tblExplicit05",
    V5_HUB_TABLE_T06: "tblExplicit06",
  };

  it("resolves full explicit configuration in production runtime", () => {
    const config = getV5HubConfig(fullMockEnv);
    expect(config.baseId).toBe("appExplicitBase123");
    expect(config.tables.T01).toBe("tblExplicit01");
    expect(config.tables.T02).toBe("tblExplicit02");
    expect(config.tables.T03).toBe("tblExplicit03");
    expect(config.tables.T04).toBe("tblExplicit04");
    expect(config.tables.T05).toBe("tblExplicit05");
    expect(config.tables.T06).toBe("tblExplicit06");
    expect(config.isTestFixture).toBe(false);
  });

  it("fails closed when any config is missing in production runtime", () => {
    const partialEnv: NodeJS.ProcessEnv = {
      ...fullMockEnv,
      V5_HUB_TABLE_T03: undefined,
      V5_HUB_TABLE_T06: "",
    };

    expect(() => getV5HubConfig(partialEnv)).toThrowError(V5HubConfigError);
    try {
      getV5HubConfig(partialEnv);
    } catch (err) {
      const configErr = err as V5HubConfigError;
      expect(configErr.code).toBe("V5_HUB_CONFIG_MISSING");
      expect(configErr.missingKeys).toContain("V5_HUB_TABLE_T03");
      expect(configErr.missingKeys).toContain("V5_HUB_TABLE_T06");
    }
  });

  it("rejects test fixture fallback when only CI=true in production/build", () => {
    const ciEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      CI: "true",
      // missing V5_HUB_* keys
    };

    expect(isV5HubTestFixtureAllowed(ciEnv)).toBe(false);
    expect(() => getV5HubConfig(ciEnv)).toThrowError(V5HubConfigError);
  });

  it("allows test fixture fallback when NODE_ENV === 'test'", () => {
    const testEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
    };

    expect(isV5HubTestFixtureAllowed(testEnv)).toBe(true);
    const config = getV5HubConfig(testEnv);
    expect(config.baseId).toBe(V5_HUB_AUTHORIZED_TEST_BASE_ID);
    expect(config.tables.T01).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T01);
    expect(config.tables.T02).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T02);
    expect(config.tables.T03).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T03);
    expect(config.tables.T04).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T04);
    expect(config.tables.T05).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T05);
    expect(config.tables.T06).toBe(V5_HUB_TEST_BASE_TABLE_IDS.T06);
    expect(config.isTestFixture).toBe(true);
  });

  it("allows test fixture fallback when V5_HUB_EXPLICIT_TEST_FIXTURE_MODE === 'true'", () => {
    const explicitFixtureEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      V5_HUB_EXPLICIT_TEST_FIXTURE_MODE: "true",
    };

    expect(isV5HubTestFixtureAllowed(explicitFixtureEnv)).toBe(true);
    const config = getV5HubConfig(explicitFixtureEnv);
    expect(config.baseId).toBe(V5_HUB_AUTHORIZED_TEST_BASE_ID);
    expect(config.isTestFixture).toBe(true);
  });
});
