import "server-only";

import https from "node:https";
import dns from "node:dns";
import os from "node:os";

function getPhysicalLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("192.168.")) {
        return addr.address;
      }
    }
  }
  return null;
}

export function getWorkaroundDnsServers(): string[] {
  const configured = process.env.LARK_WORKAROUND_DNS?.trim();
  if (configured) {
    return configured.split(",").map((s) => s.trim()).filter(Boolean);
  }
  // Public reliable DNS servers; no hardcoded local router IP
  return ["223.5.5.5", "119.29.29.29"];
}

let cachedAgent: https.Agent | null = null;

export function resetWorkaroundAgentForTest(): void {
  cachedAgent = null;
}

export function getWorkaroundAgent(): https.Agent {
  if (cachedAgent) return cachedAgent;
  const lanIp = getPhysicalLanIp();
  const feishuDnsResolver = new dns.Resolver();
  feishuDnsResolver.setServers(getWorkaroundDnsServers());

  cachedAgent = new https.Agent({
    lookup: (hostname, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (hostname.endsWith(".feishu.cn") || hostname.endsWith(".larksuite.com")) {
        return feishuDnsResolver.resolve4(hostname, (err, addrs) => {
          if (err) return (callback as any)(err);
          if (options.all) return callback(null, addrs.map((a) => ({ address: a, family: 4 })) as any);
          return callback(null, addrs[0] as any, 4);
        });
      }
      return dns.lookup(hostname, options, callback);
    },
    ...(lanIp ? { localAddress: lanIp } : {}),
  });
  return cachedAgent;
}

/**
 * Fetch for Lark/Feishu OpenAPI endpoints.
 * By default (LARK_DIRECT_NETWORK_WORKAROUND != "1"), uses the standard global `fetch`
 * conforming to Node/Next.js environment standards and proxy configs.
 *
 * When explicitly enabled via `LARK_DIRECT_NETWORK_WORKAROUND=1`, activates a direct
 * DNS + physical LAN workaround for development environments experiencing local Fake-IP loops.
 */
export async function defaultLarkFetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const isWorkaroundEnabled = process.env.LARK_DIRECT_NETWORK_WORKAROUND === "1";
  if (!isWorkaroundEnabled) {
    return fetch(url, init);
  }

  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (typeof (init.headers as Headers).forEach === "function") {
        (init.headers as Headers).forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const agent = getWorkaroundAgent();

    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 443,
      path: parsed.pathname + parsed.search,
      method: init.method || "GET",
      headers,
      agent,
      signal: init.signal ?? undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        const response = new Response(bodyBuffer, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || "OK",
          headers: res.headers as HeadersInit,
        });
        resolve(response);
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (init.body) {
      if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
        req.write(init.body);
      } else {
        req.write(JSON.stringify(init.body));
      }
    }
    req.end();
  });
}
