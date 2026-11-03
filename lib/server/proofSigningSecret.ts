import "server-only";

import { createHmac } from "crypto";

/**
 * 本地单用户开发环境的证明签名密钥。
 * 生产环境必须显式配置 `PROOF_SIGNING_SECRET`，否则不签名（fail-closed，返回 null）。
 * 历史实现曾在非生产环境回退到 ACCESS_PASSWORD；旧登录体系已删除，不再读取该变量。
 */
const LOCAL_OWNER_DEV_PROOF_SECRET = "lightchoice-local-owner-dev-proof-secret.v1";

export function getProofSigningKey(purpose: string): Buffer | null {
  const configured = (process.env.PROOF_SIGNING_SECRET || "").trim();
  const secret = configured || (process.env.NODE_ENV === "production" ? "" : LOCAL_OWNER_DEV_PROOF_SECRET);
  if (!secret) return null;
  return createHmac("sha256", secret).update(purpose).digest();
}
