import { describe, expect, it } from "vitest";

import {
  createSourceLayerError,
  isSourceLayerErrorCode,
  normalizeSourceLayerErrorCode,
  SOURCE_LAYER_ERROR_REGISTRY,
} from "./errorCodes";

/**
 * 契约测试：采集侧新增的错误码必须登记在唯一注册表内。
 *
 * 背景（真实缺陷）：AMAZON_CAPTURE_PROXY_INVALID 由采集浏览器在
 * 「出口代理配置不合法」时返回；sourceAdapter 会用 isSourceLayerErrorCode
 * 校验 capture 包里的每个错误码，未登记的错误码会导致校验失败 /
 * 被 normalizeSourceLayerErrorCode 静默降级为 INTERNAL_UNEXPECTED。
 */
describe("sourceLayer 错误码注册表契约", () => {
  it("采集出口代理配置错误码已登记且语义正确", () => {
    expect(isSourceLayerErrorCode("AMAZON_CAPTURE_PROXY_INVALID")).toBe(true);
    const definition = SOURCE_LAYER_ERROR_REGISTRY.AMAZON_CAPTURE_PROXY_INVALID;
    expect(definition.code).toBe("AMAZON_CAPTURE_PROXY_INVALID");
    expect(definition.family).toBe("capture");
    expect(definition.severity).toBe("blocking");
    // 配置错误重试同一配置不会成功，必须由操作者修配置 → 不可重试。
    expect(definition.retryable).toBe(false);
  });

  it("该错误码不会被降级为 INTERNAL_UNEXPECTED", () => {
    expect(normalizeSourceLayerErrorCode("AMAZON_CAPTURE_PROXY_INVALID")).toBe("AMAZON_CAPTURE_PROXY_INVALID");
  });

  it("构造出的错误对象不含凭据类内容，且显式声明 fail-closed", () => {
    const error = createSourceLayerError("AMAZON_CAPTURE_PROXY_INVALID");
    expect(error.message).toContain("fail-closed");
    expect(error.message).not.toMatch(/cookie|token|secret|authorization|password/i);
  });

  it("非美出口阻断错误码（AMAZON_CAPTURE_NON_US_EXIT）已登记且为阻断级", () => {
    expect(isSourceLayerErrorCode("AMAZON_CAPTURE_NON_US_EXIT")).toBe(true);
    const definition = SOURCE_LAYER_ERROR_REGISTRY.AMAZON_CAPTURE_NON_US_EXIT;
    expect(definition.code).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(definition.family).toBe("capture");
    expect(definition.severity).toBe("blocking");
    expect(definition.retryable).toBe(false);
    expect(normalizeSourceLayerErrorCode("AMAZON_CAPTURE_NON_US_EXIT")).toBe("AMAZON_CAPTURE_NON_US_EXIT");
  });

  it("预检失败错误码（AMAZON_CAPTURE_PREFLIGHT_FAILED）已登记且可重试", () => {
    expect(isSourceLayerErrorCode("AMAZON_CAPTURE_PREFLIGHT_FAILED")).toBe(true);
    const definition = SOURCE_LAYER_ERROR_REGISTRY.AMAZON_CAPTURE_PREFLIGHT_FAILED;
    expect(definition.code).toBe("AMAZON_CAPTURE_PREFLIGHT_FAILED");
    expect(definition.family).toBe("capture");
    expect(definition.severity).toBe("blocking");
    expect(definition.retryable).toBe(true);
    expect(normalizeSourceLayerErrorCode("AMAZON_CAPTURE_PREFLIGHT_FAILED")).toBe("AMAZON_CAPTURE_PREFLIGHT_FAILED");
  });

  it("Amazon 站点会话错误码（AMAZON_SITE_ERROR）与出口错误严格分离", () => {
    expect(isSourceLayerErrorCode("AMAZON_SITE_ERROR")).toBe(true);
    const definition = SOURCE_LAYER_ERROR_REGISTRY.AMAZON_SITE_ERROR;
    expect(definition.code).toBe("AMAZON_SITE_ERROR");
    expect(definition.family).toBe("capture");
    expect(definition.severity).toBe("blocking");
    expect(normalizeSourceLayerErrorCode("AMAZON_SITE_ERROR")).toBe("AMAZON_SITE_ERROR");
    expect(definition.message).toContain("Sorry! Something went wrong!");
  });
});
