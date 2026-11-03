import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSellerSpriteCandidateSourceMeta,
  checkDuplicateAsin,
  computeSellerSpriteRowHash,
  confirmedIsTrue,
  isCompleteInlineImageReference,
  parseSelectedRowHashes,
  parseSellerSpriteCandidateSourceMeta,
  reconcileSellerSpritePreviewAgainstToken,
  selectedRowHashesAreSubset,
  sellerSpriteCandidateSourceMetaUtf8Bytes,
  sellerSpriteImportRowFromPreview,
  SELLERSPRITE_IMPORT_MAX_SELECTED_ROWS,
  verifySellerSpritePreviewTokenForImport,
  warningsAcceptedOk,
  type SellerSpriteImportRow,
} from "@/lib/server/sellerSpriteImportContract";

const SYNTHETIC_SECRET = "contract-test-access-password";

function makeRow(overrides: Partial<SellerSpriteImportRow> = {}): SellerSpriteImportRow {
  return {
    rowHash: computeSellerSpriteRowHash({ rowNumber: 2, asin: "B0TEST0001", title: "Test product", amazonUrl: "https://www.amazon.com/dp/B0TEST0001" }),
    rowNumber: 2,
    asin: "B0TEST0001",
    parentAsin: null,
    title: "Test product",
    amazonUrl: "https://www.amazon.com/dp/B0TEST0001",
    imageUrl: null,
    priceUsd: 19.99,
    rating: 4.5,
    reviewCount: 123,
    brand: null,
    category: null,
    searchRank: null,
    estimatedMonthlySales: null,
    estimatedMonthlyRevenueUsd: null,
    ...overrides,
  };
}

describe("SellerSprite Import Contract", () => {
  beforeEach(() => {
    vi.stubEnv("ACCESS_PASSWORD", SYNTHETIC_SECRET);
    vi.stubEnv("APP_ACCESS_PASSWORD", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("computeSellerSpriteRowHash", () => {
    it("is deterministic and 64 lowercase hex chars", () => {
      const a = computeSellerSpriteRowHash({ rowNumber: 2, asin: "B0TEST0001", title: "T", amazonUrl: "https://a/dp/B0TEST0001" });
      const b = computeSellerSpriteRowHash({ rowNumber: 2, asin: "B0TEST0001", title: "T", amazonUrl: "https://a/dp/B0TEST0001" });
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it("differs when row identity changes", () => {
      const a = computeSellerSpriteRowHash({ rowNumber: 2, asin: "B0TEST0001", title: "T", amazonUrl: "https://a/dp/B0TEST0001" });
      const b = computeSellerSpriteRowHash({ rowNumber: 3, asin: "B0TEST0001", title: "T", amazonUrl: "https://a/dp/B0TEST0001" });
      expect(a).not.toBe(b);
    });
  });

  describe("source snapshot v1", () => {
    it("builds the frozen schema and round-trips through the parser", () => {
      const row = makeRow();
      const importedAt = "2026-07-31T09:00:00.000Z";
      const meta = buildSellerSpriteCandidateSourceMeta(row, "f".repeat(64), importedAt);
      const parsed = parseSellerSpriteCandidateSourceMeta(meta);
      expect(parsed).not.toBeNull();
      expect(parsed!.schema).toBe("sellersprite_candidate_source_v1");
      expect(parsed!.source.marketplace).toBe("Amazon US");
      expect(parsed!.source.sourceFileSha256).toBe("f".repeat(64));
      expect(parsed!.source.rowHash).toBe(row.rowHash);
      expect(parsed!.source.capturedAt).toBeNull();
      expect(parsed!.identity.asin).toBe("B0TEST0001");
      expect(parsed!.identity.productUrl).toBe(row.amazonUrl);
      expect(parsed!.estimates.disclaimer).toBe("third_party_estimate_point_in_time");
    });

    it("writes an explicit rootCategoryBsr and keeps legacy searchRank readable", () => {
      const importedAt = "2026-07-31T09:00:00.000Z";
      const withNewField = parseSellerSpriteCandidateSourceMeta(
        buildSellerSpriteCandidateSourceMeta(
          makeRow({ rootCategoryBsr: 120, searchRank: 120, subCategoryBsr: 15 }),
          "f".repeat(64),
          importedAt,
        ),
      );
      expect(withNewField?.estimates.rootCategoryBsr).toBe(120);
      expect(withNewField?.estimates.searchRank).toBe(120);
      expect(withNewField?.estimates.subCategoryBsr).toBe(15);

      // 旧数据（只有 searchRank，没有 rootCategoryBsr）必须继续可读
      const legacy = JSON.parse(
        buildSellerSpriteCandidateSourceMeta(makeRow({ searchRank: 88 }), "f".repeat(64), importedAt),
      ) as { estimates: Record<string, unknown> };
      delete legacy.estimates.rootCategoryBsr;
      const parsedLegacy = parseSellerSpriteCandidateSourceMeta(JSON.stringify(legacy));
      expect(parsedLegacy).not.toBeNull();
      expect(parsedLegacy?.estimates.searchRank).toBe(88);
      expect(parsedLegacy?.estimates.rootCategoryBsr).toBeUndefined();
    });

    it("distinguishes a complete inline image from a truncated one", () => {
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const completePng = `data:image/png;base64,${pngBytes.toString("base64")}`;
      expect(isCompleteInlineImageReference(completePng)).toBe(true);

      // 真实损坏形态：完整 JPEG 被字符串归一化截断到 1000 字符（前缀合法、字节不完整）
      const jpegBytes = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        Buffer.alloc(2_000, 0x41),
        Buffer.from([0xff, 0xd9]),
      ]);
      const completeJpeg = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`;
      expect(isCompleteInlineImageReference(completeJpeg)).toBe(true);
      expect(isCompleteInlineImageReference(completeJpeg.slice(0, 1_000))).toBe(false);
      expect(isCompleteInlineImageReference(completeJpeg.slice(0, -12))).toBe(false);

      // 前缀格式合法但不是可放行的图片
      expect(isCompleteInlineImageReference("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
      expect(isCompleteInlineImageReference("https://m.media-amazon.com/images/I/a.jpg")).toBe(false);
      expect(isCompleteInlineImageReference(null)).toBe(false);
    });

    it("stays well under the 16 KiB limit", () => {
      const meta = buildSellerSpriteCandidateSourceMeta(makeRow(), "f".repeat(64), new Date().toISOString());
      expect(sellerSpriteCandidateSourceMetaUtf8Bytes(meta)).toBeLessThanOrEqual(16 * 1024);
    });

    it("rejects a non-sellersprite source meta", () => {
      expect(parseSellerSpriteCandidateSourceMeta("{}")).toBeNull();
      expect(parseSellerSpriteCandidateSourceMeta("not json")).toBeNull();
      expect(parseSellerSpriteCandidateSourceMeta(JSON.stringify({ schema: "other" }))).toBeNull();
    });
  });

  describe("verifySellerSpritePreviewTokenForImport", () => {
    it("verifies a token bound to the matching subject scope", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      const result = verifySellerSpritePreviewTokenForImport(token, "owner");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.payload.subjectScopeHash).toBeTruthy();
    });

    it("rejects a malformed token", () => {
      const result = verifySellerSpritePreviewTokenForImport("not-a-token", "owner");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("malformed_preview_token");
    });

    it("rejects an oversized token (over 2048 UTF-8 bytes)", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      const big = token + "x".repeat(3000);
      const result = verifySellerSpritePreviewTokenForImport(big, "owner");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("malformed_preview_token");
    });

    it("rejects a token with a broken signature", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      const parts = token.split(".");
      const sig = Buffer.from(parts[2], "base64url");
      sig[0] ^= 0x01;
      const broken = `${parts[0]}.${parts[1]}.${sig.toString("base64url")}`;
      const result = verifySellerSpritePreviewTokenForImport(broken, "owner");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_preview_token_signature");
    });

    it("rejects a subject-scope mismatch", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      const result = verifySellerSpritePreviewTokenForImport(token, "visitor:demo123");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_subject_mismatch");
    });

    it("rejects an expired token", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 331_000);
      const result = verifySellerSpritePreviewTokenForImport(token, "owner");
      vi.useRealTimers();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_expired");
    });

    it("rejects a not-yet-valid token", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "sellersprite_preview_import_v1");
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() - 60_000);
      const result = verifySellerSpritePreviewTokenForImport(token, "owner");
      vi.useRealTimers();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_not_yet_valid");
    });

    it("rejects a contract mismatch", async () => {
      const { generateSellerSpritePreviewImportToken } = await import("@/lib/server/sellerSpritePreviewImportToken");
      const token = generateSellerSpritePreviewImportToken("owner", "f".repeat(64), "a".repeat(64), 1, "b".repeat(64), 0, "wrong_version");
      const result = verifySellerSpritePreviewTokenForImport(token, "owner");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_contract_mismatch");
    });
  });

  describe("parseSelectedRowHashes", () => {
    const hash = "a".repeat(64);
    it("accepts a valid single-item array", () => {
      expect(parseSelectedRowHashes(JSON.stringify([hash]))).toEqual([hash]);
    });
    it("rejects invalid JSON", () => {
      expect(parseSelectedRowHashes("not-json")).toBeNull();
    });
    it("rejects a non-array value", () => {
      expect(parseSelectedRowHashes(JSON.stringify({ a: 1 }))).toBeNull();
    });
    it("rejects an empty array", () => {
      expect(parseSelectedRowHashes(JSON.stringify([]))).toBeNull();
    });
    it("rejects more than 20 items", () => {
      expect(parseSelectedRowHashes(JSON.stringify(Array.from({ length: SELLERSPRITE_IMPORT_MAX_SELECTED_ROWS + 1 }, () => hash)))).toBeNull();
    });
    it("rejects a non-hash item", () => {
      expect(parseSelectedRowHashes(JSON.stringify(["not-a-hash"]))).toBeNull();
    });
    it("rejects duplicate hashes", () => {
      expect(parseSelectedRowHashes(JSON.stringify([hash, hash]))).toBeNull();
    });
  });

  describe("subset / confirmed / warnings / duplicate ASIN", () => {
    it("checks subset membership", () => {
      const a = "a".repeat(64);
      const b = "b".repeat(64);
      expect(selectedRowHashesAreSubset([a], [a, b])).toBe(true);
      expect(selectedRowHashesAreSubset([a, b], [a])).toBe(false);
    });
    it("requires confirmed === true string", () => {
      expect(confirmedIsTrue("true")).toBe(true);
      expect(confirmedIsTrue("false")).toBe(false);
      expect(confirmedIsTrue("1")).toBe(false);
    });
    it("requires warningsAccepted when warnings exist", () => {
      expect(warningsAcceptedOk("true", 3)).toBe(true);
      expect(warningsAcceptedOk("false", 3)).toBe(false);
      expect(warningsAcceptedOk("false", 0)).toBe(true);
      expect(warningsAcceptedOk("true", 0)).toBe(true);
    });
    it("detects duplicate ASIN in a batch", () => {
      const rowA = makeRow();
      const rowB = makeRow({ rowNumber: 3, rowHash: computeSellerSpriteRowHash({ rowNumber: 3, asin: "B0TEST0001", title: "Other", amazonUrl: "https://www.amazon.com/dp/B0TEST0001" }) });
      expect(checkDuplicateAsin([rowA])).toBeNull();
      expect(checkDuplicateAsin([rowA, rowB])).toBe("B0TEST0001");
    });
  });

  describe("reconcileSellerSpritePreviewAgainstToken", () => {
    const payload = {
      version: "sellersprite_preview_import_v1",
      subjectScopeHash: "s",
      sourceFileSha256: "f".repeat(64),
      acceptedRowsDigest: "a".repeat(64),
      acceptedRowCount: 1,
      warningDigest: "b".repeat(64),
      warningCount: 0,
      parserContractVersion: "sellersprite_preview_import_v1",
      issuedAt: 0,
      expiresAt: 0,
    } as const;

    function baseReparsed() {
      return {
        sourceFileSha256: "f".repeat(64),
        acceptedRowsDigest: "a".repeat(64),
        acceptedRowCount: 1,
        warningDigest: "b".repeat(64),
        warnings: [],
        acceptedRowHashes: ["a".repeat(64)],
      };
    }

    it("accepts a matching re-parse", () => {
      const result = reconcileSellerSpritePreviewAgainstToken(baseReparsed(), payload);
      expect(result.ok).toBe(true);
    });

    it("rejects a file hash mismatch", () => {
      const result = reconcileSellerSpritePreviewAgainstToken({ ...baseReparsed(), sourceFileSha256: "e".repeat(64) }, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_file_mismatch");
    });

    it("rejects an acceptedRowsDigest mismatch", () => {
      const result = reconcileSellerSpritePreviewAgainstToken({ ...baseReparsed(), acceptedRowsDigest: "c".repeat(64) }, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_rows_mismatch");
    });

    it("rejects an acceptedRowCount mismatch", () => {
      const result = reconcileSellerSpritePreviewAgainstToken({ ...baseReparsed(), acceptedRowCount: 2 }, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_rows_mismatch");
    });

    it("rejects a warningDigest mismatch", () => {
      const result = reconcileSellerSpritePreviewAgainstToken({ ...baseReparsed(), warningDigest: "d".repeat(64) }, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_warning_mismatch");
    });

    it("rejects a warningCount mismatch", () => {
      const result = reconcileSellerSpritePreviewAgainstToken({ ...baseReparsed(), warnings: [{ code: "duplicate_asin" }] }, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("preview_token_warning_mismatch");
    });
  });

  describe("sellerSpriteImportRowFromPreview", () => {
    it("maps a preview accepted row into the frozen import row shape", () => {
      const row = sellerSpriteImportRowFromPreview({
        rowHash: "a".repeat(64),
        rowNumber: 2,
        facts: { asin: "B0TEST0001", title: "T", amazonUrl: "https://www.amazon.com/dp/B0TEST0001", priceUsd: 9.99 },
        estimates: { searchRank: 5 },
      });
      expect(row.asin).toBe("B0TEST0001");
      expect(row.priceUsd).toBe(9.99);
      expect(row.searchRank).toBe(5);
      expect(row.imageUrl).toBeNull();
      expect(row.estimatedMonthlySales).toBeNull();
    });
  });
});
