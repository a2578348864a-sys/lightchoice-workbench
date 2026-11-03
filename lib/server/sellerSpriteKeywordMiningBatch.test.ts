import { describe, expect, it, vi } from "vitest";

import { isSellerSpriteKeywordMiningBcrEnabled, captureSellerSpriteKeywordMiningQueryForBatch } from "./sellerSpriteKeywordMiningBatch";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner = { mode: "owner" as const, token: "" };
const enabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true" } as NodeJS.ProcessEnv;
const disabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "false" } as NodeJS.ProcessEnv;

describe("SellerSprite Keyword Mining BCR query contract", () => {
  it("requires both local acquisition and its dedicated real-source flag", () => {
    expect(isSellerSpriteKeywordMiningBcrEnabled(disabledEnv)).toBe(false);
    expect(isSellerSpriteKeywordMiningBcrEnabled({ NODE_ENV: "test", SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSellerSpriteKeywordMiningBcrEnabled(enabledEnv)).toBe(true);
  });

  it("keeps keyword query identity separate from any ASIN subject", async () => {
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "silicone baking mat" },
      env: enabledEnv,
      shouldStop: async () => true,
    });
    expect(result).toMatchObject({
      status: "blocked",
      navigationPerformed: false,
      querySubjectKey: expect.stringMatching(/^sellersprite:US:keyword-mining:[a-f0-9]{64}$/u),
      queryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidenceAttachmentId: null,
      evidenceContentHash: null,
      rowsObserved: 0,
    });
  });

  it("keeps real-source execution disabled unless the dedicated flag is explicitly true", async () => {
    const captureQuery = vi.fn();
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "silicone baking mat" },
      env: disabledEnv,
    }, { captureQuery: captureQuery as never });
    expect(result).toMatchObject({ status: "blocked", navigationPerformed: false, errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED" });
    expect(captureQuery).not.toHaveBeenCalled();
  });

  it("honors a pending pause before returning any source result", async () => {
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "silicone baking mat" },
      env: enabledEnv,
      shouldStop: async () => true,
    });
    expect(result).toMatchObject({ status: "blocked", navigationPerformed: false, stopped: true, errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" });
  });

  it("rejects an empty seedKeyword without creating a query subject", async () => {
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "  " },
      env: enabledEnv,
    });
    expect(result).toMatchObject({ status: "failed", navigationPerformed: false, querySubjectKey: null, errorCode: "SELLERSPRITE_KEYWORD_QUERY_INVALID" });
  });

  it("never reports captured when the query worker itself fails", async () => {
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "silicone baking mat" },
      env: enabledEnv,
    }, {
      captureQuery: (async () => { throw new Error("SELLERSPRITE_VISIBLE_QUERY_FAILED"); }) as never,
    });
    expect(result).toMatchObject({
      status: "failed",
      navigationPerformed: true,
      evidenceAttachmentId: null,
      evidenceContentHash: null,
      rowsObserved: 0,
      errorCode: "SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED",
    });
  });

  it("maps a login gate to human_required instead of a silent failure", async () => {
    const result = await captureSellerSpriteKeywordMiningQueryForBatch({
      context: owner,
      query: { seedKeyword: "silicone baking mat" },
      env: enabledEnv,
    }, {
      captureQuery: (async () => ({
        status: "human_required",
        module: "keyword_mining_trend",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-miner/",
        snapshot: null,
        capture: null,
        errorCode: "SELLERSPRITE_LOGIN_REQUIRED",
      })) as never,
    });
    expect(result).toMatchObject({ status: "human_required", errorCode: "SELLERSPRITE_LOGIN_REQUIRED" });
  });
});
