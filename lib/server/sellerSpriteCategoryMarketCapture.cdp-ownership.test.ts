import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPlaywright: vi.fn(),
  connectOverCDP: vi.fn(),
  newPage: vi.fn(),
  pageClose: vi.fn(),
  browserClose: vi.fn(),
  contextNewPage: vi.fn(),
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({
  loadPlaywright: mocks.loadPlaywright,
}));

import {
  canCloseBrowser,
  captureSellerSpriteCategoryMarketTable,
  getSellerSpriteCategoryNodes,
  releaseSellerSpriteBrowserSession,
  SellerSpriteCategoryCaptureError,
  SELLERSPRITE_CDP_OWNERSHIP,
} from "@/lib/server/sellerSpriteCategoryMarketCapture";

function buildPage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    close: mocks.pageClose.mockResolvedValue(undefined),
    evaluate: vi.fn(async () => ({
      status: 200,
      body: {
        data: [
          { id: "15684181:15684191", label: "Automotive:Interior Accessories", products: 10 },
        ],
      },
    })),
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://www.sellersprite.com/v2/market-research"),
    locator: vi.fn().mockReturnValue({
      allTextContents: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
      click: vi.fn(),
      fill: vi.fn(),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
      press: vi.fn(),
      type: vi.fn(),
      waitFor: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  };
}

function mockCdpBrowser(page: ReturnType<typeof buildPage>) {
  mocks.connectOverCDP.mockResolvedValue({
    newBrowserCDPSession: async () => ({
      send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
      detach: async () => undefined,
    }),
    close: mocks.browserClose.mockResolvedValue(undefined),
    contexts: () => [{ newPage: mocks.contextNewPage.mockResolvedValue(page) }],
  });
  mocks.loadPlaywright.mockResolvedValue({
    chromium: { connectOverCDP: mocks.connectOverCDP },
  });
}

describe("SellerSprite CDP browser ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pageClose.mockResolvedValue(undefined);
    mocks.browserClose.mockResolvedValue(undefined);
    process.env.SELLERSPRITE_CDP_ENDPOINT = "http://127.0.0.1:9222";
  });

  it("classifies connectOverCDP as EXTERNAL_CDP_ATTACHED and forbids browser.close", () => {
    expect(SELLERSPRITE_CDP_OWNERSHIP).toBe("EXTERNAL_CDP_ATTACHED");
    expect(canCloseBrowser("EXTERNAL_CDP_ATTACHED")).toBe(false);
    expect(canCloseBrowser("SELF_LAUNCHED")).toBe(true);
  });

  it("successful node lookup closes only the task page, never the external browser", async () => {
    const page = buildPage();
    mockCdpBrowser(page);

    await getSellerSpriteCategoryNodes("Automotive");

    expect(mocks.pageClose).toHaveBeenCalledTimes(1);
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("D2-1F）9222 上是外来 Chrome（Profile 不匹配）→ 拒绝且不创建任何页面", async () => {
    mocks.connectOverCDP.mockResolvedValueOnce({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=D:/other/daily-chrome"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose.mockResolvedValue(undefined),
      contexts: () => [{ newPage: mocks.contextNewPage }],
    });

    await expect(captureSellerSpriteCategoryMarketTable({
      query: "Automotive",
      categoryId: "15684181:15684191",
      amazonNodeId: "15684191",
      amazonPathEn: ["Automotive", "Interior Accessories"],
    })).rejects.toMatchObject({ code: "seller_sprite_browser_identity_mismatch" });

    expect(mocks.contextNewPage).not.toHaveBeenCalled();
    // 拒绝路径绝不关闭对方浏览器，也不动它的页面。
    expect(mocks.browserClose).not.toHaveBeenCalled();
    expect(mocks.pageClose).not.toHaveBeenCalled();
  });

  it("D2-1F）身份无法验证（如外部实例无自动化标记）→ 拒绝且不创建任何页面", async () => {
    mocks.connectOverCDP.mockResolvedValueOnce({
      newBrowserCDPSession: async () => ({
        send: async () => { throw new Error("Command line not returned because --enable-automation not set."); },
        detach: async () => undefined,
      }),
      close: mocks.browserClose.mockResolvedValue(undefined),
      contexts: () => [{ newPage: mocks.contextNewPage }],
    });

    await expect(getSellerSpriteCategoryNodes("Automotive"))
      .rejects.toMatchObject({ code: "seller_sprite_browser_identity_unverified" });

    expect(mocks.contextNewPage).not.toHaveBeenCalled();
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("failed capture does not close external CDP browser", async () => {
    const page = buildPage({
      evaluate: vi.fn(async () => ({ status: 500, body: null })),
    });
    mockCdpBrowser(page);

    await expect(captureSellerSpriteCategoryMarketTable({
      query: "Automotive",
      categoryId: "15684181:15684191",
      amazonNodeId: "15684191",
      amazonPathEn: ["Automotive", "Interior Accessories"],
    })).rejects.toBeInstanceOf(SellerSpriteCategoryCaptureError);

    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("throwing action still keeps external Chrome alive", async () => {
    const page = buildPage();
    mockCdpBrowser(page);
    mocks.contextNewPage.mockImplementation(async () => {
      // page created, then action throws after connection
      return page;
    });

    // Force action failure via invalid category path that won't be found after parse
    page.evaluate = vi.fn(async () => ({
      status: 200,
      body: { data: [{ id: "1", label: "Other", products: 1 }] },
    })) as typeof page.evaluate;

    await expect(captureSellerSpriteCategoryMarketTable({
      query: "Automotive",
      categoryId: "15684181:15684191",
      amazonNodeId: "15684191",
      amazonPathEn: ["Automotive", "Interior Accessories"],
    })).rejects.toBeInstanceOf(SellerSpriteCategoryCaptureError);

    expect(mocks.browserClose).not.toHaveBeenCalled();
    expect(mocks.pageClose).toHaveBeenCalled();
  });

  it("second consecutive capture still never closes external CDP browser", async () => {
    const page = buildPage();
    mockCdpBrowser(page);

    await getSellerSpriteCategoryNodes("Automotive");
    expect(mocks.browserClose).not.toHaveBeenCalled();

    await getSellerSpriteCategoryNodes("Electronics");
    expect(mocks.browserClose).not.toHaveBeenCalled();
    expect(mocks.pageClose).toHaveBeenCalledTimes(2);
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("release helper only closes browser for SELF_LAUNCHED", async () => {
    const page = { close: mocks.pageClose };
    const browser = { close: mocks.browserClose };

    await releaseSellerSpriteBrowserSession({
      ownership: "EXTERNAL_CDP_ATTACHED",
      page,
      browser,
    });
    expect(mocks.pageClose).toHaveBeenCalled();
    expect(mocks.browserClose).not.toHaveBeenCalled();

    await releaseSellerSpriteBrowserSession({
      ownership: "SELF_LAUNCHED",
      page: null,
      browser,
    });
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
  });

  it("connection failure path does not call browser.close", async () => {
    mocks.loadPlaywright.mockResolvedValue({
      chromium: {
        connectOverCDP: vi.fn().mockRejectedValue(new Error("CDP down")),
      },
    });

    await expect(getSellerSpriteCategoryNodes("Automotive")).rejects.toBeInstanceOf(SellerSpriteCategoryCaptureError);
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });
});
