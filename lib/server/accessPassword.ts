/**
 * 本地单用户访问解析（Local Owner）。
 *
 * 正式部署模型 = 本地单用户工作台：服务只绑定回环（127.0.0.1 / localhost）。
 * 身份由**服务端隐式建立**为 Local Owner，不存在账号 / 密码 / 访客 / 登录会话：
 *   - 不读取 `ACCESS_PASSWORD` / `APP_ACCESS_PASSWORD`；
 *   - 不解析 cookie / header / body 凭据；
 *   - 缺少任何环境变量都不会回退到密码或登录体系。
 *
 * 本模块只决定**身份（Authentication）**，不决定**授权（Authorization）**：
 * 对象级授权（subject / owner / resource binding）、Research / Decision / Evidence 门禁、
 * Provider 校验、proof signing、fail-closed 语义均由各自模块独立执行，本模块不参与、不放宽。
 *
 * 保留的安全能力：
 *   - CSRF 基础（契约 09-4 / §28）：变更方法（POST/PATCH/PUT/DELETE）携带的 Origin
 *     与本站不同源 → 直接拒绝（403 origin_mismatch），跨站伪造不可通过。
 *
 * 历史说明：旧实现包含 token 来源矩阵、raw password 比较、访客 cookie 身份与
 * public_showcase 公开访客模式，均已随旧登录体系删除。
 */

import type { NextRequest } from "next/server";
import { hasTrustedRequestHost } from "@/lib/server/trustedRequestHost";

// ── Access context ──────────────────────────────

export interface OwnerAccessContext {
  mode: "owner";
  token: string;
}

/**
 * 历史遗留类型：访客 / 演示身份已随旧登录体系删除，运行时不再产生该身份。
 * 仅保留类型以兼容既有类型分支（`context.mode === "demo"` 永不成立）。
 */
export interface DemoAccessContext {
  mode: "demo";
  token: string;
  demoAccessId: string;
  isActive: boolean;
  isExpired: boolean;
  remainingAiCalls: number;
  credentialKind?: "password" | "anonymous";
}

export type AccessContext = OwnerAccessContext | DemoAccessContext;

/** 仅剩同源失败一种拒绝原因；unauthenticated / conflict 已随登录体系移除。 */
export type AccessDenialReason = "unauthenticated" | "conflict" | "origin";

export type AccessResolution =
  | { ok: true; context: AccessContext }
  | { ok: false; reason: AccessDenialReason };

/** 服务端隐式 Local Owner principal —— 本地单用户工作台的唯一正式身份。 */
export const LOCAL_OWNER_PRINCIPAL: OwnerAccessContext = Object.freeze({ mode: "owner", token: "" });

// ── CSRF / Origin ───────────────────────────────

/**
 * Origin 同源判定（契约 09-4 / §28）。
 * 精确比较优先；回环主机归一化兜底（本定制 Next 会把 127.0.0.1 规范化为 localhost，
 * 本地/回环部署下浏览器 Origin 可能是 127.0.0.1 而 nextUrl.origin 是 localhost）。
 * 跨站伪造 Origin 不可能通过（浏览器自动设置 Origin，JS 无法伪造）。
 */
export function isSameOriginRequest(origin: string, request: NextRequest): boolean {
  if (!hasTrustedRequestHost(request)) return false;
  const self = (request as { nextUrl?: { origin?: string } }).nextUrl?.origin;
  if (!self) return false;
  if (origin === self) return true;
  const publicOrigin = (process.env.QX_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (publicOrigin && origin === publicOrigin) return true;
  try {
    const a = new URL(origin);
    const b = new URL(self);
    const norm = (host: string) => {
      const h = host.toLowerCase();
      return h === "127.0.0.1" || h === "[::1]" || h === "::1" ? "localhost" : h;
    };
    const portA = a.port || (a.protocol === "https:" ? "443" : "80");
    const portB = b.port || (b.protocol === "https:" ? "443" : "80");
    return a.protocol === b.protocol && norm(a.hostname) === norm(b.hostname) && portA === portB;
  } catch {
    return false;
  }
}

// ── Unified access resolver ─────────────────────

/** A trusted Host is required even for same-origin scripts without an Origin header. */
export function isTrustedWriteRequest(request: NextRequest): boolean {
  if (!hasTrustedRequestHost(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  if (referer) {
    try { return isSameOriginRequest(new URL(referer).origin, request); } catch { return false; }
  }
  return true;
}

/**
 * 统一入口：本地单用户恒为 Local Owner，仅保留同源（CSRF）门禁。
 * `body` 参数保留以兼容既有调用方签名，不再承载任何凭据。
 */
export function resolveAccessContext(
  request: NextRequest,
  _body?: Record<string, unknown>,
): AccessResolution {
  if (!hasTrustedRequestHost(request)) return { ok: false, reason: "origin" };
  const mutating = (() => {
    const method = (request.method || "GET").toUpperCase();
    return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
  })();
  if (mutating) {
    if (!isTrustedWriteRequest(request)) return { ok: false, reason: "origin" };
  }
  return { ok: true, context: LOCAL_OWNER_PRINCIPAL };
}

/** Backward-compatible wrapper（既有调用方：失败统一返回 null）。 */
export function getAccessContext(
  request: NextRequest,
  body?: Record<string, unknown>,
): AccessContext | null {
  const resolved = resolveAccessContext(request, body);
  return resolved.ok ? resolved.context : null;
}

/**
 * 兼容包装：授权通过返回 null，仅同源失败返回结构化错误。
 * 名称保留以兼容既有调用方；语义为「本地单用户身份门禁」。
 */
export function checkAccessPassword(
  request: NextRequest,
  body?: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } | null {
  const resolved = resolveAccessContext(request, body);
  if (resolved.ok) return null;
  return { status: 403, body: { error: "请求来源校验失败。" } };
}
