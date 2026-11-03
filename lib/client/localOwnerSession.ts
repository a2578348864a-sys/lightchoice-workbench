/**
 * 客户端会话状态（本地单用户 / Local Owner）。
 *
 * 正式模型：身份由服务端隐式建立为 Local Owner，客户端**不保存任何凭据**，
 * 不存在密码输入、密码存储、密码过期或解锁门禁。
 *
 * 历史说明：旧实现从 sessionStorage 读取管理员密码并驱动「解锁」状态；
 * 旧登录体系已删除，本模块不再读写任何凭据，也不再有密码过期语义。
 *
 * 兼容性：保留既有导出名以维持组件调用契约；所有函数均为恒等/恒真语义。
 */
"use client";

import { useMemo } from "react";

/** 历史常量保留：本地单用户下不再使用（无 TTL 概念）。 */
export const DEFAULT_ACCESS_PASSWORD_TTL_MS = 12 * 60 * 60 * 1000;

type AccessPasswordSetter = (value: string | ((prev: string) => string)) => void;

export type UseAccessPasswordResult = [
  string,
  AccessPasswordSetter,
  boolean,
  () => void,
  boolean,
] & {
  accessPassword: string;
  setAccessPassword: AccessPasswordSetter;
  isReady: boolean;
  clearAccessPassword: () => void;
  hasAccessPassword: boolean;
  isExpired: boolean;
  expiresAt: number | null;
  noAuthOwner: boolean;
  saveAccessPassword: (value: string) => void;
  getValidAccessPassword: () => string;
};

const noopSetter: AccessPasswordSetter = () => undefined;
const noop = () => undefined;

/** 本地单用户：无密码，恒无过期时间。 */
export function getAccessPasswordExpiresAt(): number | null {
  return null;
}

/** 本地单用户：恒返回空串（不存在客户端凭据）。 */
export function getValidAccessPassword(): string {
  return "";
}

export function saveAccessPassword(_password: string, _ttlMs = DEFAULT_ACCESS_PASSWORD_TTL_MS): void {
  // 本地单用户：不保存任何凭据。
}

export function clearAccessPassword(): void {
  // 本地单用户：无凭据可清除。
}

export function isAccessPasswordExpired(): boolean {
  return false;
}

export function getStoredAccessPassword(): string {
  return "";
}

export function setStoredAccessPassword(_password: string, _ttlMs = DEFAULT_ACCESS_PASSWORD_TTL_MS): void {
  // 本地单用户：不保存任何凭据。
}

export function clearStoredAccessPassword(): void {
  // 本地单用户：无凭据可清除。
}

/** 本地单用户：恒可发起请求。 */
export function canRequestWithAccessPassword(_isReady: boolean, _password: string): boolean {
  return true;
}

/**
 * 会话 hook（本地单用户）。
 * 恒返回：无密码、已就绪、Local Owner 已认证。
 */
export function useAccessPassword(): UseAccessPasswordResult {
  return useMemo(() => {
    const result = ["", noopSetter, true, noop, true] as UseAccessPasswordResult;
    result.accessPassword = "";
    result.setAccessPassword = noopSetter;
    result.isReady = true;
    result.clearAccessPassword = noop;
    result.hasAccessPassword = false;
    result.isExpired = false;
    result.expiresAt = null;
    result.saveAccessPassword = noopSetter;
    result.getValidAccessPassword = getValidAccessPassword;
    result.noAuthOwner = true;
    return result;
  }, []);
}
