import { describe, expect, it, vi } from "vitest";
import { uploadKeepaCsv } from "./keepaUpload";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("uploadKeepaCsv", () => {
  it("sends one user-provided CSV to the canonical Keepa import route and returns explicit counts", async () => {
    const file = new File(["ASIN,Title\nB085DTZQNZ,Example"], "keepa.csv", { type: "text/csv" });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({
      ok: true,
      data: {
        importedCount: 1,
        failedCount: 0,
        quarantinedCount: 0,
        omittedByBudgetCount: 0,
        sourceFileSha256: "a".repeat(64),
        imported: [{ asin: "B085DTZQNZ", subjectKey: "amazon:US:B085DTZQNZ" }],
        failed: [],
      },
    }));

    await expect(uploadKeepaCsv(file, request)).resolves.toMatchObject({ importedCount: 1, failedCount: 0, omittedByBudgetCount: 0, sourceFileSha256: "a".repeat(64) });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/source-layer/acquire/keepa");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({});
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
    expect((init?.body as FormData).get("marketplace")).toBe("US");
  });

  it("surfaces fail-closed server validation without treating it as a successful import", async () => {
    const file = new File(["invalid"], "keepa.csv", { type: "text/csv" });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({
      ok: false,
      error: { code: "keepa_export_invalid", message: "Keepa 导表解析失败。" },
    }, 400));

    await expect(uploadKeepaCsv(file, request)).rejects.toThrow("Keepa 导表解析失败。");
  });

  it("rejects successful-looking responses without a valid source hash or budget count", async () => {
    const file = new File(["ASIN,Title\nB085DTZQNZ,Example"], "keepa.csv", { type: "text/csv" });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({
      ok: true,
      data: {
        importedCount: 1,
        failedCount: 0,
        quarantinedCount: 0,
        omittedByBudgetCount: 0,
        sourceFileSha256: "invalid-hash",
        imported: [{ asin: "B085DTZQNZ", subjectKey: "amazon:US:B085DTZQNZ" }],
        failed: [],
      },
    }));
    await expect(uploadKeepaCsv(file, request)).rejects.toThrow("响应不符合当前计数与行明细契约");
  });

  it("rejects unsupported files and oversized uploads before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(uploadKeepaCsv(new File(["data"], "keepa.xlsx"), request)).rejects.toThrow("仅支持");
    await expect(uploadKeepaCsv(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.csv"), request)).rejects.toThrow("5 MB");
    expect(request).not.toHaveBeenCalled();
  });
});
