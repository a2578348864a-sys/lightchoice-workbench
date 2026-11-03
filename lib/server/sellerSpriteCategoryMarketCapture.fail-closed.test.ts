import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPlaywright: vi.fn(),
  connectOverCDP: vi.fn(),
  browserClose: vi.fn(),
  pageClose: vi.fn(),
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({
  loadPlaywright: mocks.loadPlaywright,
}));

import {
  captureSellerSpriteCategoryMarketTable,
  SellerSpriteCategoryCaptureError,
} from "@/lib/server/sellerSpriteCategoryMarketCapture";

describe("captureSellerSpriteCategoryMarketTable service-level fail-closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPlaywright.mockResolvedValue({
      chromium: {
        connectOverCDP: mocks.connectOverCDP.mockResolvedValue({
          newBrowserCDPSession: async () => ({
            send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
            detach: async () => undefined,
          }),
          close: mocks.browserClose.mockResolvedValue(undefined),
          contexts: () => [{ newPage: vi.fn() }],
        }),
      },
    });
    process.env.SELLERSPRITE_CDP_ENDPOINT = "http://127.0.0.1:9222";
  });

  it("rejects when amazonNodeId is missing before any CDP connection", async () => {
    await expect(captureSellerSpriteCategoryMarketTable({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "",
      amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"],
    } as never)).rejects.toMatchObject({ code: "category_match_unconfirmed" });
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
  });

  it("rejects when amazonPathEn is empty before any CDP connection", async () => {
    await expect(captureSellerSpriteCategoryMarketTable({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "284507",
      amazonPathEn: [],
    })).rejects.toMatchObject({ code: "category_match_unconfirmed" });
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
  });

  it("rejects when Amazon context fields are omitted entirely", async () => {
    await expect(captureSellerSpriteCategoryMarketTable({
      query: "kitchen",
      categoryId: "1055398:284507",
    } as never)).rejects.toBeInstanceOf(SellerSpriteCategoryCaptureError);
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("rejects invalid amazonNodeId format", async () => {
    await expect(captureSellerSpriteCategoryMarketTable({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "javascript:1",
      amazonPathEn: ["Home & Kitchen"],
    })).rejects.toMatchObject({ code: "category_match_unconfirmed" });
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
  });
});
