import type { NextRequest } from "next/server";

/** Only the local listener or an explicitly configured public origin is trusted. */
export function hasTrustedRequestHost(request: NextRequest): boolean {
  const host = request.headers?.get("host")?.trim() ?? "";
  if (!host || /[\s/@#?\\]/u.test(host)) return false;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/iu.exec(host);
  if (local) return !local[2] || (Number(local[2]) > 0 && Number(local[2]) <= 65535);
  try {
    const configured = new URL((process.env.QX_PUBLIC_ORIGIN ?? "").trim());
    return ["http:", "https:"].includes(configured.protocol)
      && !configured.username && !configured.password
      && configured.pathname === "/" && !configured.search && !configured.hash
      && host.toLowerCase() === configured.host.toLowerCase();
  } catch {
    return false;
  }
}
