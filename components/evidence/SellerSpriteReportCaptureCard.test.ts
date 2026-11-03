import { describe, expect, it } from "vitest";
import {
  parseSellerSpriteClipboardTable,
} from "./SellerSpriteReportCaptureCard";

describe("SellerSpriteReportCaptureCard", () => {
  it("parses an official tab-separated header and preserves missing cells as null", () => {
    const result = parseSellerSpriteClipboardTable(
      "Keyword\tMonthly Searches\tABA Rank\nwood board\t1200\t\ncutting board\t900\t42",
    );
    expect(result).toEqual({
      ok: true,
      table: {
        headers: ["Keyword", "Monthly Searches", "ABA Rank"],
        rows: [
          ["wood board", "1200", null],
          ["cutting board", "900", "42"],
        ],
      },
    });
  });

  it("fails closed when the pasted data is not tab-separated", () => {
    const result = parseSellerSpriteClipboardTable("Keyword,Monthly Searches\nwood board,1200");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Tab");
  });

  it("fails closed when a row has an unexpected extra column", () => {
    const result = parseSellerSpriteClipboardTable("Keyword\tMonthly Searches\nwood board\t1200\textra");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("列数");
  });
});
