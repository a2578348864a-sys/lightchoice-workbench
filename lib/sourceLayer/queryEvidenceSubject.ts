/**
 * 查询级 Evidence 主体键（SellerSprite 类目查询 / seedKeyword 查询）。
 *
 * 背景：商品级 Evidence 必须绑定到已存在的商品版本；但
 *   - Product Market 查询的主体是「marketplace + category + filters」，
 *   - Keyword Mining 查询的主体是「marketplace + seedKeyword + conditions」，
 * 两者都没有、也不应该伪造商品版本。
 *
 * 为避免「伪造 ASIN / 伪造商品版本」绕过附件合同，这里定义与商品主体并列的
 * 查询主体键，并沿用 EvidenceStore 已有的「非商品主体」先例
 * （`market:US:category:<nodeId>` 类目市场快照）。查询主体：
 *   - 仍然写入同一个 EvidenceStore、同一主体目录、同一审计日志；
 *   - 不产生商品版本、不进入商品索引、不参与 ASIN×模块矩阵；
 *   - 因此不会把查询结果伪装成某个 ASIN 的完成结果。
 *
 * 本模块零依赖，供 EvidenceStore、Capture Gateway 与 SellerSprite 查询层共用，
 * 保证「谁算查询主体」只有一个事实来源。
 */

export const SELLERSPRITE_QUERY_SUBJECT_MODULES = [
  "sellersprite_product_market",
  "keyword_mining_trend",
] as const;

export type SellerSpriteQuerySubjectModule = (typeof SELLERSPRITE_QUERY_SUBJECT_MODULES)[number];

const MODULE_SEGMENT: Readonly<Record<SellerSpriteQuerySubjectModule, string>> = Object.freeze({
  sellersprite_product_market: "product-market",
  keyword_mining_trend: "keyword-mining",
});

const QUERY_SUBJECT_PATTERN = /^sellersprite:([A-Z]{2}):(product-market|keyword-mining):([a-f0-9]{64})$/u;

export type SellerSpriteQuerySubjectIdentity = {
  marketplace: string;
  module: SellerSpriteQuerySubjectModule;
  queryFingerprint: string;
};

export function sellerSpriteQuerySubjectKey(input: {
  module: SellerSpriteQuerySubjectModule;
  marketplace?: string | null;
  queryFingerprint: string;
}): string {
  const marketplace = (input.marketplace ?? "US").toUpperCase();
  if (!/^[A-Z]{2}$/u.test(marketplace)) throw new Error("SELLERSPRITE_QUERY_SUBJECT_MARKETPLACE_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(input.queryFingerprint)) {
    throw new Error("SELLERSPRITE_QUERY_SUBJECT_FINGERPRINT_INVALID");
  }
  return `sellersprite:${marketplace}:${MODULE_SEGMENT[input.module]}:${input.queryFingerprint}`;
}

export function parseSellerSpriteQuerySubjectKey(value: string): SellerSpriteQuerySubjectIdentity | null {
  const match = QUERY_SUBJECT_PATTERN.exec(value);
  if (!match) return null;
  const entry = (Object.entries(MODULE_SEGMENT) as Array<[SellerSpriteQuerySubjectModule, string]>)
    .find(([, segment]) => segment === match[2]);
  if (!entry) return null;
  return { marketplace: match[1], module: entry[0], queryFingerprint: match[3] };
}

export function isSellerSpriteQuerySubjectKey(value: string): boolean {
  return parseSellerSpriteQuerySubjectKey(value) !== null;
}
