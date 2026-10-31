// The one outbound HTTP path (S1–S3): adapters and title pre-fill both go through `safeFetch`.
// Redirects are followed by hand so every hop is checked (host, scheme, port, public address)
// *before* the request is made; response bodies are read with a size cap.
// Not yet closed: DNS rebinding between the address check and the connection (see DECISIONS).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Ctx } from "./ctx.ts";

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

/** True when every address the host resolves to is public (not loopback, private, link-local…). */
export async function hostIsPublic(ctx: Ctx, host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h)) return !isPrivateAddress(h);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  try {
    const addrs = ctx.lookup ? await ctx.lookup(h) : (await dnsLookup(h, { all: true })).map((a) => a.address);
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

/** A request `safeFetch` refused to make or to finish (bad redirect, private address, too large…). */
export class FetchRefused extends Error {}

export type SafeFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Every hop must stay on this host. Without it, any host that passes the other checks. */
  allowedHost?: string;
  /** Check that the host resolves to public addresses at every hop. Default: true. */
  requirePublic?: boolean;
  /** Only port 443 (or none). Default: true. */
  standardPortOnly?: boolean;
  maxRedirects?: number;
  /** Total time for all hops, body included. */
  timeoutMs?: number;
  maxBytes: number;
  /** Over `maxBytes`: cut the body (fine for HTML titles) or refuse (default; JSON). */
  truncate?: boolean;
};

export type SafeResponse = {
  status: number;
  headers: Headers;
  /** The URL of the final hop. */
  url: string;
  /** The body as text, read with the size cap. */
  text(): Promise<string>;
  /** The raw body, read with the size cap. */
  bytes(): Promise<Buffer>;
  /** Release the connection without reading the body. */
  discard(): void;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(ctx: Ctx, url: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const { allowedHost, requirePublic = true, standardPortOnly = true, maxRedirects = 3, timeoutMs = 15_000 } = opts;
  const signal = AbortSignal.timeout(timeoutMs);
  let method = opts.method ?? "GET";
  let body = opts.body;
  let current = url;
  for (let hop = 0; ; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new FetchRefused("Invalid address");
    }
    if (u.protocol !== "https:") throw new FetchRefused("Only https addresses are fetched");
    if (u.username || u.password) throw new FetchRefused("Addresses with credentials aren't fetched");
    if (standardPortOnly && u.port && u.port !== "443") throw new FetchRefused("Only the standard https port is fetched");
    if (allowedHost && u.hostname !== allowedHost) throw new FetchRefused(hop ? "Unexpected redirect to another host" : "Unexpected host");
    if (requirePublic && !(await hostIsPublic(ctx, u.hostname))) throw new FetchRefused("This address isn't reachable from the register");

    const res = await ctx.fetch(current, { method, headers: opts.headers, body, redirect: "manual", signal });
    if (REDIRECTS.has(res.status)) {
      res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc) throw new FetchRefused(`Redirect without a location (HTTP ${res.status})`);
      if (hop >= maxRedirects) throw new FetchRefused("Too many redirects");
      current = new URL(loc, current).toString();
      // As browsers do: 303, and 301/302 after a POST, become a GET without a body.
      if (res.status === 303 || (method === "POST" && (res.status === 301 || res.status === 302))) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return {
      status: res.status,
      headers: res.headers,
      url: current,
      text: () => readCapped(res, opts.maxBytes, !!opts.truncate),
      bytes: () => readCappedBytes(res, opts.maxBytes, !!opts.truncate),
      discard: () => void res.body?.cancel().catch(() => {}),
    };
  }
}

/** Read a body as text, stopping at `max` bytes: truncate, or throw `FetchRefused`. */
export async function readCapped(res: Response, max: number, truncate = false): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(res, max, truncate));
}

/** Read a body, stopping at `max` bytes: truncate, or throw `FetchRefused`. */
export async function readCappedBytes(res: Response, max: number, truncate = false): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > max) {
    res.body?.cancel().catch(() => {});
    throw new FetchRefused("Response too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (size > max && !truncate) throw new FetchRefused("Response too large");
  return Buffer.concat(chunks).subarray(0, max);
}
