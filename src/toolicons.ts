// Tool icons, for recognising tools at a glance. No request ever leaves the reader's browser:
// - built-in tools use small files bundled in public/icons/ (sources in public/icons/README.md);
// - other tools get their site's favicon, fetched once by the server (same guards as the title
//   pre-fill: https, public addresses, size caps) and stored with the tool as a data: URI;
// - without either, the UI draws a monogram (the tool name's first letter).
import type { Ctx } from "./ctx.ts";
import type { Tool } from "./types.ts";
import { safeFetch } from "./net.ts";
import { decodeEntities } from "./pagetitle.ts";

/** Bundled icons, by seed tool id (and by adapter, for instance tools without a favicon of their own). */
const BUNDLED: Record<string, { file: string; mono?: boolean }> = {
  github: { file: "github.svg", mono: true },
  gitlab: { file: "gitlab.svg" },
  metaculus: { file: "metaculus.png" },
  loomio: { file: "loomio.svg" },
  polis: { file: "polis.png" },
  opavote: { file: "opavote.png" },
  decidim: { file: "decidim.png" },
  kialo: { file: "kialo.webp" },
  consul: { file: "consul.png" },
};

/** How the UI shows a tool's icon: a URL (same origin or data:), `mono` for single-colour icons to invert in dark mode. */
export type ToolIcon = { url: string; mono?: boolean };

export function toolIcon(t: Tool): ToolIcon | undefined {
  const b = BUNDLED[t.id];
  if (b) return { url: `/assets/icons/${b.file}`, mono: b.mono };
  if (t.icon) return { url: t.icon };
  const a = t.adapter && BUNDLED[t.adapter];
  return a ? { url: `/assets/icons/${a.file}`, mono: a.mono } : undefined;
}

/** Whether a tool's icon comes from its own site (anything but the built-in tools). */
export const wantsFetchedIcon = (t: Tool) => !BUNDLED[t.id];

/** The site a tool lives on, from its first URL pattern with a plain host name (no wildcard). */
export function toolOrigin(t: Tool): string | undefined {
  for (const { pattern } of t.url_patterns) {
    try {
      const host = new URLPattern(pattern).hostname;
      if (/^[a-z0-9.-]+$/i.test(host) && host.includes(".")) return `https://${host}`;
    } catch {}
  }
  return undefined;
}

const PAGE_BYTES = 256 * 1024;
const ICON_BYTES = 64 * 1024;
const TIMEOUT_MS = 6_000;

/** Icon links declared in a page's <head>, best first: SVG, then the smallest raster at least 32px, then the rest. */
export function iconLinks(html: string, base: string): string[] {
  const found: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return r ? decodeEntities(r[1] ?? r[2] ?? r[3]).trim() : undefined;
    };
    const rel = attr("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = attr("href");
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    const svg = attr("type") === "image/svg+xml" || /\.svg(\?|$)/i.test(href);
    const size = Number(/(\d+)x\d+/.exec(attr("sizes") ?? "")?.[1]) || (rel.includes("apple-touch-icon") ? 180 : 16);
    // Lower is better. Tiny and huge rasters are kept as fallbacks.
    const score = svg ? 0 : size >= 32 && size <= 96 ? size : size > 96 ? 1000 + size : 2000 - size;
    found.push({ href: url, score });
  }
  return [...new Set(found.sort((a, b) => a.score - b.score).map((f) => f.href))];
}

/** The image type from its first bytes (the server's Content-Type is not trusted). */
export function sniffImage(b: Buffer): string | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = b.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return undefined;
}

async function fetchImage(ctx: Ctx, url: string): Promise<string | undefined> {
  try {
    const res = await safeFetch(ctx, url, {
      headers: { Accept: "image/svg+xml,image/png,image/x-icon,image/*;q=0.8", "User-Agent": "question-register (tool icon)" },
      timeoutMs: TIMEOUT_MS,
      maxBytes: ICON_BYTES,
    });
    if (res.status !== 200) {
      res.discard();
      return undefined;
    }
    const body = await res.bytes();
    const type = sniffImage(body);
    // Shown with <img> only (scripts in SVG don't run there); the CSP allows data: images.
    return type ? `data:${type};base64,${body.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

/** A site's icon as a data: URI: the icons its home page declares, then /favicon.ico. Never throws. */
export async function fetchSiteIcon(ctx: Ctx, origin: string): Promise<string | undefined> {
  let candidates: string[] = [];
  try {
    const res = await safeFetch(ctx, origin + "/", {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "question-register (tool icon)" },
      timeoutMs: TIMEOUT_MS,
      maxBytes: PAGE_BYTES,
      truncate: true,
    });
    if (res.status === 200 && (res.headers.get("content-type") ?? "text/html").includes("html")) {
      candidates = iconLinks(await res.text(), res.url);
    } else res.discard();
  } catch {}
  candidates.push(origin + "/favicon.ico");
  for (const url of [...new Set(candidates)].slice(0, 4)) {
    const icon = await fetchImage(ctx, url);
    if (icon) return icon;
  }
  return undefined;
}

/** Retry tools whose icon couldn't be fetched after this long. */
export const ICON_RETRY_MS = 7 * 24 * 3600 * 1000;

/** Fetch and store the icon of one tool (when it wants one). Never throws. */
export async function updateToolIcon(ctx: Ctx, spaceId: string, t: Tool, cache = new Map<string, string | undefined>()) {
  if (!wantsFetchedIcon(t)) return;
  const origin = toolOrigin(t);
  let icon: string | undefined;
  if (origin) {
    if (!cache.has(origin)) cache.set(origin, await fetchSiteIcon(ctx, origin));
    icon = cache.get(origin);
  }
  ctx.db.prepare("UPDATE tools SET icon = ?, icon_checked_at = ? WHERE space_id = ? AND id = ?").run(icon ?? null, ctx.now().toISOString(), spaceId, t.id);
}

/** Scheduler: fetch icons for tools that have none yet (never tried, or last tried a week ago). */
export async function fetchMissingToolIcons(ctx: Ctx, limit = 20) {
  const before = new Date(ctx.now().getTime() - ICON_RETRY_MS).toISOString();
  const rows = ctx.db
    .prepare("SELECT space_id, id, url_patterns_json, adapter FROM tools WHERE icon IS NULL AND (icon_checked_at IS NULL OR icon_checked_at < ?) ORDER BY icon_checked_at IS NOT NULL, space_id, position")
    .all(before) as { space_id: string; id: string; url_patterns_json: string; adapter: string | null }[];
  const cache = new Map<string, string | undefined>();
  let n = 0;
  for (const r of rows) {
    const t = { id: r.id, url_patterns: JSON.parse(r.url_patterns_json), adapter: r.adapter ?? undefined } as Tool;
    if (!wantsFetchedIcon(t)) continue;
    if (n++ >= limit) break;
    await updateToolIcon(ctx, r.space_id, t, cache);
  }
}
