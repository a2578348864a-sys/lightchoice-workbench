/**
 * V5 Feishu Intelligence Hub Explicit Configuration Layer
 *
 * Enforces explicit configuration in normal runtime (development, production, CI build)
 * and fail-closed security: missing configuration will NEVER silently fall back to test fixtures.
 *
 * Test fixtures are ONLY permitted when NODE_ENV === "test" or V5_HUB_EXPLICIT_TEST_FIXTURE_MODE === "true".
 * CI=true alone does NOT permit test fixtures.
 */

export const V5_HUB_AUTHORIZED_TEST_BASE_ID = "RXOabDkG0abBevsno43cSkTFnWb" as const;

export const V5_HUB_TEST_BASE_TABLE_IDS = {
  T01: "tblMpuan1b4UV7EX",
  T02: "tbl4sSoOUPACDgTS",
  T03: "tblO8Psto90jtUdk",
  T04: "tblImv8dqTsMrSMR",
  T05: "tblZlzYACY8PMzhA",
  T06: "tbledw8jcmUSWEnQ",
} as const;

export type V5HubTableKey = "T01" | "T02" | "T03" | "T04" | "T05" | "T06";

export const V5_HUB_CONFIG_ENV_KEYS = {
  BASE_ID: "V5_HUB_BASE_ID",
  TABLE_T01: "V5_HUB_TABLE_T01",
  TABLE_T02: "V5_HUB_TABLE_T02",
  TABLE_T03: "V5_HUB_TABLE_T03",
  TABLE_T04: "V5_HUB_TABLE_T04",
  TABLE_T05: "V5_HUB_TABLE_T05",
  TABLE_T06: "V5_HUB_TABLE_T06",
} as const;

export type V5HubResolvedConfig = {
  readonly baseId: string;
  readonly tables: Readonly<Record<V5HubTableKey, string>>;
  readonly isTestFixture: boolean;
};

export class V5HubConfigError extends Error {
  constructor(
    public readonly code: "V5_HUB_CONFIG_MISSING" | "V5_HUB_CONFIG_INVALID",
    message: string,
    public readonly missingKeys: readonly string[] = [],
  ) {
    super(message);
    this.name = "V5HubConfigError";
  }
}

/**
 * Determines whether test fixture fallback is authorized in the current environment.
 * Strict rule: CI=true alone does NOT authorize test fixtures.
 */
export function isV5HubTestFixtureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return true;
  if (env.V5_HUB_EXPLICIT_TEST_FIXTURE_MODE === "true") return true;
  return false;
}

/**
 * Resolves V5 Hub configuration with strict fail-closed validation.
 */
export function getV5HubConfig(env: NodeJS.ProcessEnv = process.env): V5HubResolvedConfig {
  const explicitBaseId = env.V5_HUB_BASE_ID?.trim();
  const explicitT01 = env.V5_HUB_TABLE_T01?.trim();
  const explicitT02 = env.V5_HUB_TABLE_T02?.trim();
  const explicitT03 = env.V5_HUB_TABLE_T03?.trim();
  const explicitT04 = env.V5_HUB_TABLE_T04?.trim();
  const explicitT05 = env.V5_HUB_TABLE_T05?.trim();
  const explicitT06 = env.V5_HUB_TABLE_T06?.trim();

  const missingKeys: string[] = [];
  if (!explicitBaseId) missingKeys.push("V5_HUB_BASE_ID");
  if (!explicitT01) missingKeys.push("V5_HUB_TABLE_T01");
  if (!explicitT02) missingKeys.push("V5_HUB_TABLE_T02");
  if (!explicitT03) missingKeys.push("V5_HUB_TABLE_T03");
  if (!explicitT04) missingKeys.push("V5_HUB_TABLE_T04");
  if (!explicitT05) missingKeys.push("V5_HUB_TABLE_T05");
  if (!explicitT06) missingKeys.push("V5_HUB_TABLE_T06");

  // All 7 keys are explicitly provided
  if (missingKeys.length === 0) {
    return {
      baseId: explicitBaseId!,
      tables: {
        T01: explicitT01!,
        T02: explicitT02!,
        T03: explicitT03!,
        T04: explicitT04!,
        T05: explicitT05!,
        T06: explicitT06!,
      },
      isTestFixture: explicitBaseId === V5_HUB_AUTHORIZED_TEST_BASE_ID,
    };
  }

  // Missing some or all keys: check if test fixture fallback is authorized
  if (isV5HubTestFixtureAllowed(env)) {
    return {
      baseId: explicitBaseId || V5_HUB_AUTHORIZED_TEST_BASE_ID,
      tables: {
        T01: explicitT01 || V5_HUB_TEST_BASE_TABLE_IDS.T01,
        T02: explicitT02 || V5_HUB_TEST_BASE_TABLE_IDS.T02,
        T03: explicitT03 || V5_HUB_TEST_BASE_TABLE_IDS.T03,
        T04: explicitT04 || V5_HUB_TEST_BASE_TABLE_IDS.T04,
        T05: explicitT05 || V5_HUB_TEST_BASE_TABLE_IDS.T05,
        T06: explicitT06 || V5_HUB_TEST_BASE_TABLE_IDS.T06,
      },
      isTestFixture: true,
    };
  }

  // Normal runtime with missing keys -> FAIL CLOSED
  throw new V5HubConfigError(
    "V5_HUB_CONFIG_MISSING",
    `V5 Feishu Intelligence Hub 显式配置缺失: ${missingKeys.join(", ")}。正常运行时必须提供全部 7 个环境变量，严禁静默回退。`,
    missingKeys,
  );
}
