// Title pre-fill for links from tools without an adapter: read the page's og:title / <title>.
// Guarded: https only, public addresses only (checked at every redirect hop), small reads, short timeout.
// Pages rendered in the browser or behind a login (Kialo, Polis' own pages) give generic titles,
// which are discarded.
import type { Ctx } from "./ctx.ts";
import { safeFetch } from "./net.ts";

const MAX_BYTES = 512 * 1024;
const GENERIC = /^(just a moment|attention required|access denied|log ?in|sign ?in|loading|home|untitled|404|not found|error)\b/i;

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
    const res = await safeFetch(ctx, url, {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "groupmatters (title preview)" },
      timeoutMs: 8_000,
      maxBytes: MAX_BYTES,
      truncate: true,
    });
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "text/html").includes("html")) {
      res.discard();
      return undefined;
    }
    const title = extractTitle(await res.text());
    if (!title || isGenericTitle(title, url, toolName)) return undefined;
    return title.length > 300 ? title.slice(0, 299) + "…" : title;
  } catch {
    // network errors, timeouts, refused redirects or addresses: no title
  }
  return undefined;
}
