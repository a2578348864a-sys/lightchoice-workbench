import { describe, expect, it } from "vitest";
import {
  classifyAmazonCapturePageTitle,
  describeAmazonEnvironmentFailure,
  evaluateAmazonEnvironment,
  type AmazonEnvironmentSignals,
} from "./environment-gate";

const valid = {
  pageStatus: "ok" as const,
  pageUrl: "https://www.amazon.com/",
  amazonBrandMarkerPresent: true,
  deliveryRegion: "Delivering to New York 10001",
  language: "en-us",
  currencyPreference: "USD",
  pageErrorCode: null,
};

describe("Amazon environment gate", () => {
  it("passes only explicit Amazon US delivery, en-us, and the selected USD preference", () => {
    expect(evaluateAmazonEnvironment(valid)).toEqual({
      status: "passed",
      failedStage: null,
      errorCodes: [],
      canSearch: true,
      observed: {
        marketplace: "amazon.com",
        market: "US",
        deliveryRegion: "Delivering to New York 10001",
        language: "en-us",
        currency: "USD",
      },
      observedEvidence: {
        marketplace: { value: "amazon.com", evidenceSource: "final_url_and_amazon_brand_marker", confidence: "high", satisfiesFieldGate: true },
        market: { value: "US", evidenceSource: "marketplace_and_delivery_region", confidence: "high", satisfiesFieldGate: true },
        deliveryRegion: { value: "Delivering to New York 10001", evidenceSource: "delivery_entry_text", confidence: "high", satisfiesFieldGate: true },
        language: { value: "en-us", evidenceSource: "document_language", confidence: "high", satisfiesFieldGate: true },
        currency: { value: "USD", evidenceSource: "explicit_currency_observation", confidence: "high", satisfiesFieldGate: true },
      },
    });
  });

  it("preserves reliable marketplace and delivery observations when a privacy gate fails", () => {
    const result = evaluateAmazonEnvironment({
      ...valid,
      pageStatus: "unknown_page",
      pageErrorCode: "privacy_prompt_visible",
      language: null,
      currencyPreference: null,
    });

    expect(result.errorCodes).toEqual(["privacy_prompt_visible"]);
    expect(result.observed).toEqual({
      marketplace: "amazon.com",
      market: "US",
      deliveryRegion: "Delivering to New York 10001",
      language: null,
      currency: null,
    });
    expect(result.observedEvidence.marketplace).toMatchObject({ confidence: "high", satisfiesFieldGate: true });
    expect(result.observedEvidence.deliveryRegion).toMatchObject({ confidence: "high", satisfiesFieldGate: true });
    expect(result.canSearch).toBe(false);
  });

  it("passes with postal code only (V3R relaxation: ZIP alone is a US delivery signal)", () => {
    const result = evaluateAmazonEnvironment({
      ...valid,
      deliveryRegion: "Deliver to 10001",
    });
    expect(result.status).toBe("passed");
    expect(result.canSearch).toBe(true);
    expect(result.observed.market).toBe("US");
  });

  it("passes with a different explicitly observed US ZIP from the browser profile", () => {
    const result = evaluateAmazonEnvironment({
      ...valid,
      deliveryRegion: "Delivering to Los Angeles 90017",
    });
    expect(result.status).toBe("passed");
    expect(result.canSearch).toBe(true);
    expect(result.observed.market).toBe("US");
  });

  it("passes with English US region marker only, without ZIP (V3R relaxation)", () => {
    const result = evaluateAmazonEnvironment({
      ...valid,
      deliveryRegion: "Delivering to United States",
    });
    expect(result.status).toBe("passed");
    expect(result.canSearch).toBe(true);
    expect(result.observed.market).toBe("US");
  });

  it.each([
    ["Japan delivery", { deliveryRegion: "Deliver to Japan" }, "delivery_verification", "delivery_region_not_us"],
    ["Canada delivery", { deliveryRegion: "Deliver to Toronto" }, "delivery_verification", "delivery_region_not_us"],
    ["currency unknown", { currencyPreference: null }, "currency_verification", "currency_not_usd"],
    ["language drift", { language: "ja-jp" }, "language_verification", "language_not_en_us"],
    ["brand missing", { amazonBrandMarkerPresent: false }, "marketplace_verification", "marketplace_unconfirmed"],
    ["captcha", { pageStatus: "captcha" as const }, "page_status", "captcha"],
  ])("fails closed before search for %s", (_label, mutation, failedStage, errorCode) => {
    const result = evaluateAmazonEnvironment({ ...valid, ...mutation });
    expect(result.status).toBe("failed");
    expect(result.canSearch).toBe(false);
    expect(result.failedStage).toBe(failedStage);
    expect(result.errorCodes).toContain(errorCode);
  });
});

describe("Amazon 环境门禁失败诊断（真实使用阶段取证）", () => {
  const failure = (mutation: Partial<AmazonEnvironmentSignals>) => {
    const gate = evaluateAmazonEnvironment({ ...valid, ...mutation });
    expect(gate.status).toBe("failed");
    return gate;
  };

  it("被导向 amazon.co.jp 时，如实报出真实主机并要求 US 站点（不谎称页面在美国站）", () => {
    const gate = failure({ pageUrl: "https://www.amazon.co.jp/s?k=closet+organizer" });
    const message = describeAmazonEnvironmentFailure(gate, "https://www.amazon.co.jp/s?k=closet+organizer");
    expect(gate.failedStage).toBe("marketplace_verification");
    expect(message).toContain("amazon.co.jp");
    expect(message).toContain("www.amazon.com");
    expect(message).toContain("不是美国站环境");
    expect(message).not.toContain("页面确实在 amazon.com");
  });

  it("hostname 已是 amazon.com 时，不得把失败归因成 VPN / 代理（必须指向真正的失败条件）", () => {
    const gate = failure({ amazonBrandMarkerPresent: false });
    const message = describeAmazonEnvironmentFailure(gate, "https://www.amazon.com/s?k=closet+organizer");
    expect(gate.failedStage).toBe("marketplace_verification");
    expect(message).toContain("未检测到 Amazon 品牌标记");
    expect(message).toContain("www.amazon.com");
    // 关键：不能误导用户去切换 VPN。
    expect(message).not.toContain("VPN");
    expect(message).not.toContain("代理");
    expect(message).not.toContain("不是美国站环境");
  });

  it("配送地区非美国时，报出实测地区并说明出口和会话偏好都可能影响", () => {
    const gate = failure({ deliveryRegion: "配送至: 日本" });
    const message = describeAmazonEnvironmentFailure(gate, "https://www.amazon.com/s?k=closet+organizer");
    expect(gate.failedStage).toBe("delivery_verification");
    expect(message).toContain("配送地区不是美国");
    expect(message).toContain("配送至: 日本");
    expect(message).toContain("网络出口");
    expect(message).toContain("浏览器会话中的配送偏好");
    expect(message).toContain("一次正常的美国配送地区校准");
  });

  it("页面语言非 en-US 时，报出实测语言", () => {
    const gate = failure({ language: "zh-cn" });
    const message = describeAmazonEnvironmentFailure(gate, "https://www.amazon.com/s?k=closet+organizer");
    expect(gate.failedStage).toBe("language_verification");
    expect(message).toContain("zh-cn");
    expect(message).toContain("locale=en-US");
  });

  it("币种非 USD 时，报出实测币种", () => {
    const gate = failure({ currencyPreference: "JPY" });
    const message = describeAmazonEnvironmentFailure(gate, "https://www.amazon.com/s?k=closet+organizer");
    expect(gate.failedStage).toBe("currency_verification");
    expect(message).toContain("JPY");
    expect(message).toContain("USD");
  });

  it("人机校验与登录墙明确声明「不会自动绕过」", () => {
    const captcha = describeAmazonEnvironmentFailure(failure({ pageStatus: "captcha" }), valid.pageUrl);
    expect(captcha).toContain("人机校验");
    expect(captcha).toContain("不会自动绕过");
    const login = describeAmazonEnvironmentFailure(failure({ pageStatus: "login_wall" }), valid.pageUrl);
    expect(login).toContain("登录");
    expect(login).toContain("不会自动登录");
  });

  it("任何诊断文案都不包含 Cookie / Token / Secret / 认证头等敏感内容", () => {
    const gates = [
      failure({ pageUrl: "https://www.amazon.co.jp/s?k=x" }),
      failure({ amazonBrandMarkerPresent: false }),
      failure({ deliveryRegion: "Deliver to Japan" }),
      failure({ language: "ja-jp" }),
      failure({ currencyPreference: "JPY" }),
      failure({ pageStatus: "captcha" }),
      failure({ pageStatus: "login_wall" }),
    ];
    for (const gate of gates) {
      const message = describeAmazonEnvironmentFailure(gate, gate.observed.marketplace === "amazon.com" ? valid.pageUrl : "https://www.amazon.co.jp/s?k=x");
      expect(message).not.toMatch(/cookie|token|secret|authorization|session-id/i);
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("通过的门禁结果不会给出失败诊断（避免文案被误用）", () => {
    expect(describeAmazonEnvironmentFailure(evaluateAmazonEnvironment(valid), valid.pageUrl)).toContain("没有通过");
  });

  // 站点自身错误页（真实取证：同一会话首次搜索正常、随后被 "Sorry! Something went wrong!" 持续拒绝）
  it("识别 Amazon 站点错误页标题，且只在已知错误页时归类", () => {
    expect(classifyAmazonCapturePageTitle("Sorry! Something went wrong!")).toBe("site_error_page");
    expect(classifyAmazonCapturePageTitle("sorry!  Something went wrong!")).toBe("site_error_page");
    expect(classifyAmazonCapturePageTitle("Amazon.com : closet organizer")).toBeNull();
    expect(classifyAmazonCapturePageTitle("John's Account - Amazon.com")).toBeNull();
    expect(classifyAmazonCapturePageTitle("")).toBeNull();
    expect(classifyAmazonCapturePageTitle(null)).toBeNull();
    expect(classifyAmazonCapturePageTitle(undefined)).toBeNull();
  });

  it("站点错误页的诊断说清「与环境/账号无关」并禁止自动重试与绕过", () => {
    const message = describeAmazonEnvironmentFailure(
      failure({ pageStatus: "error_page" }),
      valid.pageUrl,
      "Sorry! Something went wrong!",
    );
    expect(message).toContain("Sorry! Something went wrong!");
    expect(message).toContain("不是美国环境问题");
    expect(message).toContain("不会自动重试");
    expect(message).toContain("不会轮换会话");
    expect(message).toContain("不会绕过站点校验");
    expect(message).toContain("www.amazon.com");
  });

  it("没有站点错误页标题时退化为通用文案，且不透出任意页面标题", () => {
    const generic = describeAmazonEnvironmentFailure(failure({ pageStatus: "error_page" }), valid.pageUrl);
    expect(generic).toContain("不是可解析的搜索结果页");
    expect(generic).not.toContain("Sorry! Something went wrong!");
    // 任意标题（可能含账号信息）不得进入诊断
    const withAccountTitle = describeAmazonEnvironmentFailure(
      failure({ pageStatus: "error_page" }),
      valid.pageUrl,
      "John's Account - Amazon.com",
    );
    expect(withAccountTitle).not.toContain("John's Account");
    expect(withAccountTitle).toContain("不是可解析的搜索结果页");
  });

  it("人机校验/登录墙的判定优先于站点错误页标题", () => {
    const captcha = describeAmazonEnvironmentFailure(
      failure({ pageStatus: "captcha" }),
      valid.pageUrl,
      "Sorry! Something went wrong!",
    );
    expect(captcha).toContain("不会自动绕过");
    expect(captcha).not.toContain("Sorry! Something went wrong!");
  });
});
