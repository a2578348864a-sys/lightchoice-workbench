/**
 * 客户端访问辅助（本地单用户 / Local Owner）。
 *
 * 正式模型：身份由服务端隐式建立为 Local Owner，客户端**不保存 token、不发送凭据**。
 * `buildAccessHeaders()` 恒返回空对象 —— 本机请求不带任何认证头。
 *
 * 历史说明：旧实现把 access token / mode / demoAccess 快照写入 sessionStorage，
 * 并据此发送 `x-access-token` / `x-access-password`。旧登录 / 访客体系已删除。
 *
 * 兼容性：保留既有导出名以维持组件调用契约；访客相关导出已中性化（恒为 owner / 空值）。
 */

"use client";

/** 本地单用户工作台只有 Owner 身份；保留类型名以兼容既有调用方。 */
export type SessionMode = "owner" | "demo";

export interface DemoAccessInfo {
  id: string;
  label: string;
  expiresAt: string | null;
  isActive: boolean;
  quotaMetric: "product_journeys_v1";
  maxProducts: number;
  usedProducts: number;
  reservedProducts: number;
  remainingProducts: number;
  migrationStatus: "migrated";
  standaloneListingLimit?: number;
  standaloneListingUsed?: number;
  standaloneListingReserved?: number;
  standaloneListingRemaining?: number;
  standaloneImageUnitLimit?: number;
  standaloneImageUnitsUsed?: number;
  standaloneImageUnitsReserved?: number;
  standaloneImageUnitsRemaining?: number;
  maxAiCalls?: number;
  usedAiCalls?: number;
  remainingAiCalls?: number;
  maxAiJobs?: number;
  usedAiJobs?: number;
  remainingAiJobs?: number;
  credentialKind?: "password" | "anonymous";
  globalCapExhausted?: { text: boolean; image: boolean };
}

export const DEMO_ACCESS_UPDATED_EVENT = "qx:demo-access-updated";

// ── 会话写入（本地单用户：无操作）───────────────

export function saveAccessToken(
  _token: string,
  _mode: SessionMode,
  _demoAccess?: DemoAccessInfo,
): void {
  // 本地单用户：不保存任何凭据。
}

// ── 会话读取 ────────────────────────────────────

export function getAccessToken(): string {
  return "";
}

/** 唯一正式身份：Local Owner。 */
export function getAccessMode(): SessionMode | null {
  return "owner";
}

export function getDemoAccessInfo(): DemoAccessInfo | null {
  return null;
}

export function updateDemoAccessInfo(_update: Partial<DemoAccessInfo>): void {
  // 本地单用户：无访客快照。
}

export function updateDemoAccessSnapshot(_snapshot: DemoAccessInfo): void {
  // 本地单用户：无访客快照。
}

/** 访客模式已移除，恒为 false。 */
export function isGuestMode(): boolean {
  return false;
}

export function saveGuestAccess(_demoAccess: DemoAccessInfo): void {
  // 访客体系已删除。
}

/** 本地单用户：恒为 Local Owner 模式。 */
export function isNoAuthOwnerMode(): boolean {
  return true;
}

export function setNoAuthOwnerMode(): void {
  // 本地单用户：无需标记，身份恒成立。
}

/** 本地单用户：恒已认证。 */
export function isAuthenticated(): boolean {
  return true;
}

/** 本机请求不携带任何认证头（服务端隐式 Local Owner）。 */
export function buildAccessHeaders(): Record<string, string> {
  return {};
}

export function clearAccessSession(): void {
  // 本地单用户：无会话可清除。
}
