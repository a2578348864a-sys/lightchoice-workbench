import { describe, expect, it } from "vitest";

import {
  projectMonitoringProductIdentity,
  trustedAmazonImageUrl,
} from "@/lib/server/monitoringProductIdentity";
import type { V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

/**
 * 监控卡商品身份投影的定向测试。
 * 核心不变量：
 * - 只用同一份证据里的字段，绝不跨商品、跨字段冒充；
 * - 图片必须过 https + Amazon 图片主机白名单；
 * - 标题字段不可用时只用主图 alt 文本，并如实标注来源；
 * - 中文名只能是展示层推导，绝不冒充 Amazon 确认事实。
 */

const REGISTRY_VERSION = "amazon-detail-field-registry.v1";

function registeredField(overrides: Record<string, unknown>) {
  return {
    canonicalField: "title",
    priority: "P0",
    fieldNature: "DIRECT_FACT",
    status: "observed",
    reason: null,
    value: null,
    sourceTrace: {
      selector: "#productTitle",
      region: "primary_product_title",
      ruleId: "title",
      registryVersion: REGISTRY_VERSION,
      ruleVersion: null,
      label: null,
    },
    ...overrides,
  };
}

function evidenceWith(fields: Record<string, unknown>): V3ModuleEvidence {
  return {
    schemaVersion: "capture-system-v3-module-evidence.v1",
    module: "amazon_detail",
    subjectKey: "amazon:US:B0DKNN9WCX",
    marketplace: "US",
    capturedAt: "2026-11-02T07:44:26.536Z",
    provider: "Amazon",
    sourceSurface: "amazon_dom",
    sourceUrl: "https://www.amazon.com/dp/B0DKNN9WCX",
    providerUpdatedAt: null,
    freshness: { capturedAt: "2026-11-02T07:44:26.536Z", observedAt: "2026-11-02T07:44:26.536Z", ageSeconds: 0, status: "fresh" },
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: "VALIDATED_AVAILABLE",
    limitations: [],
    identity: { asin: "B0DKNN9WCX" },
    data: { registeredFields: fields },
    evidenceOnly: true,
  } as unknown as V3ModuleEvidence;
}

describe("monitoringProductIdentity", () => {
  it("标题字段可信时给出英文原标题与可信主图", () => {
    const identity = projectMonitoringProductIdentity(evidenceWith({
      title: registeredField({
        canonicalField: "title",
        value: "YITAHOME 6ft Prelit Artificial Christmas Tree",
        sourceTrace: { selector: "#productTitle", region: "primary_product_title", ruleId: "title", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
      mainImage: registeredField({
        canonicalField: "mainImage",
        value: "https://m.media-amazon.com/images/I/91tef5tyXxL._AC_SL1500_.jpg",
        sourceTrace: { selector: "#landingImage", region: "primary_product_main_image", ruleId: "mainImage", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: "alt text" },
      }),
      brand: registeredField({
        canonicalField: "brand",
        value: "YITAHOME",
        sourceTrace: { selector: "#bylineInfo", region: "primary_product_identity_or_specifications", ruleId: "brand", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
      categoryPath: registeredField({
        canonicalField: "categoryPath",
        value: ["Home & Kitchen", "Seasonal Décor", "Trees"],
        sourceTrace: { selector: "#wayfinding-breadcrumbs_feature_div a", region: "primary_product_breadcrumbs", ruleId: "categoryPath", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
    }));

    expect(identity.title).toBe("YITAHOME 6ft Prelit Artificial Christmas Tree");
    expect(identity.titleSource).toBe("evidence_title");
    expect(identity.image).toBe("https://m.media-amazon.com/images/I/91tef5tyXxL._AC_SL1500_.jpg");
    expect(identity.brand).toBe("YITAHOME");
    expect(identity.category).toBe("Home & Kitchen");
    // 展示层推导：品牌 + 中文类目 + 关键规格，不是 Amazon 确认名
    expect(identity.chineseTitleStatus).toBe("DERIVED_FROM_CATEGORY");
    expect(identity.chineseTitle).toContain("圣诞树");
    expect(identity.chineseTitleNote).toContain("不是 Amazon 确认名");
  });

  it("标题字段冲突（ambiguous）时回退到主图 alt 文本并标注来源", () => {
    const identity = projectMonitoringProductIdentity(evidenceWith({
      title: registeredField({
        canonicalField: "title",
        status: "ambiguous",
        reason: "conflicting_candidates",
        value: null,
        sourceTrace: { selector: null, region: "primary_product_title", ruleId: "title", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
      mainImage: registeredField({
        canonicalField: "mainImage",
        value: "https://m.media-amazon.com/images/I/71fKSebqrZL._AC_SL1500_.jpg",
        sourceTrace: { selector: "#landingImage", region: "primary_product_main_image", ruleId: "mainImage", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: "Benebone Wishbone Dog Chew Toy for Aggressive Chewers" },
      }),
      brand: registeredField({
        canonicalField: "brand",
        value: "Benebone",
        sourceTrace: { selector: "#bylineInfo", region: "primary_product_identity_or_specifications", ruleId: "brand", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
    }));

    expect(identity.title).toBe("Benebone Wishbone Dog Chew Toy for Aggressive Chewers");
    expect(identity.titleSource).toBe("image_alt_text");
    expect(identity.titleNote).toContain("alt 文本");
    expect(identity.image).toBe("https://m.media-amazon.com/images/I/71fKSebqrZL._AC_SL1500_.jpg");
  });

  it("非 Amazon 图片主机一律拒绝，不做图片兜底", () => {
    const identity = projectMonitoringProductIdentity(evidenceWith({
      mainImage: registeredField({
        canonicalField: "mainImage",
        value: "https://example.com/not-amazon.jpg",
        sourceTrace: { selector: "#landingImage", region: "primary_product_main_image", ruleId: "mainImage", registryVersion: REGISTRY_VERSION, ruleVersion: null, label: null },
      }),
    }));
    expect(identity.image).toBeNull();
    expect(trustedAmazonImageUrl("http://m.media-amazon.com/images/I/x.jpg")).toBeNull();
    expect(trustedAmazonImageUrl("https://evil.media-amazon.com.attacker.test/x.jpg")).toBeNull();
    expect(trustedAmazonImageUrl("https://m.media-amazon.com/images/I/x.jpg")).toContain("media-amazon.com");
  });

  it("没有任何可用字段时如实为空，不编造中文名", () => {
    const identity = projectMonitoringProductIdentity(evidenceWith({}));
    expect(identity.title).toBeNull();
    expect(identity.titleSource).toBeNull();
    expect(identity.image).toBeNull();
    expect(identity.chineseTitle).toBeNull();
    expect(identity.chineseTitleStatus).toBe("UNAVAILABLE");
  });
});
