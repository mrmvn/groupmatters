// Title pre-fill for links from tools without an adapter: read the page's og:title / <title>.
// Guarded: https only, public addresses only (checked at every redirect hop), small reads, short timeout.
// Pages rendered in the browser or behind a login (Kialo, Polis' own pages) give generic titles,
// which are discarded.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Ctx } from "./ctx.ts";
import { isHttpsUrl } from "./util.ts";

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const GENERIC = /^(just a moment|attention required|access denied|log ?in|sign ?in|loading|home|untitled|404|not found|error)\b/i;

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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Extract a page title from HTML: og:title, then twitter:title, then <title>. */
export function extractTitle(html: string): string | undefined {
  const meta = (prop: string) => {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (key?.toLowerCase() !== prop) continue;
      const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
      const v = content?.[1] ?? content?.[2];
      if (v?.trim()) return v;
    }
    return undefined;
  };
  const raw = meta("og:title") ?? meta("twitter:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!raw) return undefined;
  const t = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return t || undefined;
}

/** True when a title says nothing about the item (site name, login wall, bot challenge). */
export function isGenericTitle(title: string, url: string, toolName?: string): boolean {
  const t = title.trim().toLowerCase();
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  if (t.length < 4 || GENERIC.test(t)) return true;
  if (t === host || t === host.split(".")[0] || t === host.replace(/\./g, "")) return true;
  if (toolName && (t === toolName.toLowerCase() || t.startsWith(`${toolName.toLowerCase()} - `) || t.startsWith(`${toolName.toLowerCase()} | `))) return true;
  return false;
}

/** Fetch a page and return its title, or undefined. Never throws. */
export async function fetchPageTitle(ctx: Ctx, url: string, toolName?: string): Promise<string | undefined> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isHttpsUrl(current)) return undefined;
      const u = new URL(current);
      if (u.port && u.port !== "443") return undefined;
      if (!(await hostIsPublic(ctx, u.hostname))) return undefined;
      const res = await ctx.fetch(current, {
        redirect: "manual",
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "question-register (title preview)" },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return undefined;
        current = new URL(loc, current).toString();
        continue;
      }
      if (res.status !== 200) return undefined;
      if (!(res.headers.get("content-type") ?? "text/html").includes("html")) return undefined;
      const html = await readCapped(res, MAX_BYTES);
      const title = extractTitle(html);
      if (!title || isGenericTitle(title, url, toolName)) return undefined;
      return title.length > 300 ? title.slice(0, 299) + "…" : title;
    }
  } catch {
    // network errors, timeouts, bad redirects: no title
  }
  return undefined;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}
