import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getLarkCommodityPoolConfig,
  getLarkConfig,
  isLarkConfigured,
  getRedactedLarkConfig,
} from "./config";

describe("Lark Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    delete process.env.LARK_BASE_APP_TOKEN;
    delete process.env.LARK_BASE_TABLE_ID;
    delete process.env.LARK_COMMODITY_POOL_TABLE_ID;
    delete process.env.LARK_OPEN_API_DOMAIN;
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_BASE_APP_TOKEN;
    delete process.env.FEISHU_BASE_TABLE_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("当缺少环境变量时 fail-closed 并列出缺失 key", () => {
    const result = getLarkConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingKeys).toContain("LARK_APP_ID");
      expect(result.missingKeys).toContain("LARK_APP_SECRET");
      expect(result.missingKeys).toContain("LARK_BASE_APP_TOKEN");
      expect(result.missingKeys).toContain("LARK_BASE_TABLE_ID");
    }
    expect(isLarkConfigured()).toBe(false);
  });

  it("当提供完整 LARK_* 变量时返回有效配置", () => {
    process.env.LARK_APP_ID = "cli_test_123";
    process.env.LARK_APP_SECRET = "sec_test_abc";
    process.env.LARK_BASE_APP_TOKEN = "app_test_token";
    process.env.LARK_BASE_TABLE_ID = "tbl_test_table";

    const result = getLarkConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.appId).toBe("cli_test_123");
      expect(result.config.appSecret).toBe("sec_test_abc");
      expect(result.config.appToken).toBe("app_test_token");
      expect(result.config.tableId).toBe("tbl_test_table");
      expect(result.config.openApiDomain).toBe("https://open.feishu.cn");
    }
    expect(isLarkConfigured()).toBe(true);
  });

  it("兼容 FEISHU_* 前缀回退", () => {
    process.env.FEISHU_APP_ID = "cli_feishu_123";
    process.env.FEISHU_APP_SECRET = "sec_feishu_abc";
    process.env.FEISHU_BASE_APP_TOKEN = "app_feishu_token";
    process.env.FEISHU_BASE_TABLE_ID = "tbl_feishu_table";

    const result = getLarkConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.appId).toBe("cli_feishu_123");
      expect(result.config.tableId).toBe("tbl_feishu_table");
    }
  });

  it("getRedactedLarkConfig 绝不泄漏 appSecret", () => {
    process.env.LARK_APP_ID = "cli_safe_123";
    process.env.LARK_APP_SECRET = "SUPER_SECRET_VALUE";
    process.env.LARK_BASE_APP_TOKEN = "app_safe_token";
    process.env.LARK_BASE_TABLE_ID = "tbl_safe_table";

    const redacted = getRedactedLarkConfig();
    expect(redacted.configured).toBe(true);
    expect(redacted.appId).toBe("cli_safe_123");
    expect((redacted as Record<string, unknown>).appSecret).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain("SUPER_SECRET_VALUE");
  });

  it("商品池配置缺失时不回退到旧 Research Export 表", () => {
    process.env.LARK_APP_ID = "cli_test_123";
    process.env.LARK_APP_SECRET = "sec_test_abc";
    process.env.LARK_BASE_APP_TOKEN = "app_test_token";
    process.env.LARK_BASE_TABLE_ID = "tbl_old_research_export";

    const result = getLarkCommodityPoolConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingKeys).toEqual(["LARK_COMMODITY_POOL_TABLE_ID"]);
    }
  });

  it("商品池配置使用独立 table id，同时复用同一 Base app token", () => {
    process.env.LARK_APP_ID = "cli_test_123";
    process.env.LARK_APP_SECRET = "sec_test_abc";
    process.env.LARK_BASE_APP_TOKEN = "app_test_token";
    process.env.LARK_BASE_TABLE_ID = "tbl_old_research_export";
    process.env.LARK_COMMODITY_POOL_TABLE_ID = "tbl_new_commodity_pool";

    const result = getLarkCommodityPoolConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.appToken).toBe("app_test_token");
      expect(result.config.tableId).toBe("tbl_new_commodity_pool");
    }
  });
});
