// HTTP layer: a pure `route()` function (request in, response out) plus a thin node:http wrapper.
// No framework.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../ctx.ts";
import * as repo from "../repo.ts";
import { looksLikeToken, hashToken } from "../tokens.ts";
import { validateActorName } from "../permissions.ts";
import { handleApi } from "./api.ts";
import { atomFeed } from "../feed.ts";
import { calendarFeed } from "../calendar.ts";
import { HttpError } from "../util.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const MAX_BODY = 256 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** The fixed headers, plus HSTS when the public URL is https (browsers ignore it over http anyway). */
export function securityHeaders(ctx: Ctx): Record<string, string> {
  return ctx.config.publicUrl.startsWith("https://") ? { ...SECURITY_HEADERS, "Strict-Transport-Security": "max-age=31536000" } : SECURITY_HEADERS;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export type Req = { method: string; url: string; headers: Record<string, string | undefined>; body?: Buffer };
export type Res = { status: number; headers: Record<string, string>; body: string | Buffer };

const json = (status: number, data: unknown): Res => ({
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(data),
});

const errorJson = (e: unknown): Res => {
  if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message, details: (e as any).details } });
  console.error(e);
  return json(500, { error: { code: "internal", message: "Something went wrong on the server" } });
};

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The footer shared by the static pages and the SPA shell: Group Matters · Source · Privacy · Contact (when configured). */
export function footerHtml(ctx: Ctx): string {
  const { sourceUrl, contactEmail } = ctx.config;
  const parts = [
    "Group Matters",
    `<a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener">Source</a>`,
    `<a href="/privacy">Privacy</a>`,
    contactEmail ? `<a href="mailto:${escHtml(contactEmail)}">Contact</a>` : "",
  ].filter(Boolean);
  return `<footer class="site-footer">${parts.join(" · ")}</footer>`;
}

/** An HTML page from public/ with the footer placed where it says `<!--FOOTER-->`. */
async function page(ctx: Ctx, rel: string, cache = true): Promise<Res> {
  const res = await file(rel, cache);
  const { hosting } = ctx.config;
  res.body = res.body
    .toString("utf8")
    .replace("<!--FOOTER-->", footerHtml(ctx))
    .replace("<!--HOSTING-->", () => (hosting ? `<h2>Hosting</h2>\n    <p>${escHtml(hosting)}</p>\n\n    ` : ""));
  return res;
}

async function file(rel: string, cache = true): Promise<Res> {
  const p = normalize(join(PUBLIC_DIR, rel));
  if (!p.startsWith(PUBLIC_DIR)) throw new HttpError(404, "not_found", "Not found");
  try {
    const data = await readFile(p);
    return {
      status: 200,
      headers: { "Content-Type": MIME[extname(p)] ?? "application/octet-stream", "Cache-Control": cache ? "public, max-age=300" : "no-store" },
      body: data,
    };
  } catch {
    throw new HttpError(404, "not_found", "Not found");
  }
}

function parseBody(req: Req): any {
  if (!req.body?.length) return undefined;
  if (req.body.length > MAX_BODY) throw new HttpError(413, "too_large", "Request body too large");
  if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpError(415, "unsupported", "Send JSON");
  try {
    return JSON.parse(req.body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON");
  }
}

// Per-token rate limits (sliding one-minute window), one map for writes and one for reads.
// Map order is least recently used first: past MAX_KEYS, the oldest keys are dropped (not everyone's).
const MAX_KEYS = 10_000;
const writes = new Map<string, number[]>();
const reads = new Map<string, number[]>();
export function rateLimit(map: Map<string, number[]>, key: string, perMinute: number, now: number, message: string) {
  const arr = (map.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= perMinute) throw new HttpError(429, "rate_limited", message);
  arr.push(now);
  map.delete(key);
  map.set(key, arr);
  for (const k of map.keys()) {
    if (map.size <= MAX_KEYS) break;
    map.delete(k);
  }
}

/** Same-origin check for writes. A missing Origin is allowed (non-browser clients); `null` or garbage isn't. */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // "null" (sandboxed iframes, some privacy modes) or unparseable
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "bad_request", "Malformed address");
  }
}

export const redact = (url: string) => url.replace(/\/(s|feed)\/[A-Za-z0-9_-]{20,}/, "/$1/[token]");

async function routeInner(ctx: Ctx, req: Req): Promise<Res> {
  const url = new URL(req.url, "http://localhost");
  const segs = url.pathname.split("/").filter(Boolean);
  const { method } = req;

  if (method === "GET" && segs[0] === "assets") return file(segs.slice(1).join("/"));
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return page(ctx, "home.html");
  if (method === "GET" && url.pathname === "/privacy") return page(ctx, "privacy.html");
  if (method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });

  // SPA shell, one per space link
  if (method === "GET" && segs[0] === "s" && segs.length === 2) {
    if (!looksLikeToken(segs[1]) || !repo.findSpaceByToken(ctx.db, segs[1])) throw new HttpError(404, "not_found", "Not found");
    return page(ctx, "index.html", false);
  }

  // Atom feed and ICS calendar
  const feed = method === "GET" && segs[0] === "feed" && segs.length === 2 ? /^([A-Za-z0-9_-]+)\.(atom|ics)$/.exec(segs[1]) : null;
  if (feed) {
    const [, token, ext] = feed;
    const found = looksLikeToken(token) ? repo.findSpaceByToken(ctx.db, token) : undefined;
    // View links only: feed readers and calendars are often cloud services, and entry links embed the token.
    if (!found || found.role !== "view") throw new HttpError(404, "not_found", "Not found");
    return ext === "atom"
      ? { status: 200, headers: { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "no-store" }, body: atomFeed(ctx, found.space, token) }
      : { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" }, body: calendarFeed(ctx, found.space, token) };
  }

  // JSON API
  if (segs[0] === "api" && segs[1] === "s" && segs.length >= 3) {
    try {
      const token = segs[2];
      const found = looksLikeToken(token) ? repo.findSpaceByToken(ctx.db, token) : undefined;
      if (!found) throw new HttpError(404, "not_found", "Unknown or revoked link");
      if (method !== "GET") {
        // CSRF defence in depth: refuse cross-origin writes when the browser tells us the origin.
        if (!sameOrigin(req.headers.origin, req.headers.host)) throw new HttpError(403, "forbidden", "Cross-origin request refused");
        rateLimit(writes, hashToken(token), ctx.config.writeRateLimitPerMinute, Date.now(), "Too many changes in a short time; wait a minute");
      } else {
        // Looser, but export and dashboard are full scans.
        rateLimit(reads, hashToken(token), ctx.config.readRateLimitPerMinute, Date.now(), "Too many requests in a short time; wait a minute");
      }
      const data = await handleApi(ctx, {
        method,
        path: segs.slice(3).map(decodeSegment),
        query: url.searchParams,
        body: method === "GET" ? undefined : parseBody(req),
        actor: validateActorName(req.headers["x-actor-name"]),
        space: found.space,
        role: found.role,
      });
      return json(200, data);
    } catch (e) {
      return errorJson(e);
    }
  }
  throw new HttpError(404, "not_found", "Not found");
}

export async function route(ctx: Ctx, req: Req): Promise<Res> {
  let res: Res;
  try {
    res = await routeInner(ctx, req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res = { status, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: status === 404 ? "Not found" : "Error" };
  }
  res.headers = { ...securityHeaders(ctx), ...res.headers };
  return res;
}

export function createApp(ctx: Ctx) {
  return createServer(async (req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          tooLarge = true;
          break;
        }
        chunks.push(chunk);
      }
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    const out = tooLarge
      ? { ...json(413, { error: { code: "too_large", message: "Request body too large" } }), headers: { ...securityHeaders(ctx), "Content-Type": "application/json" } }
      : await route(ctx, { method: req.method ?? "GET", url: req.url ?? "/", headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(out.status, out.headers);
    res.end(req.method === "HEAD" ? undefined : out.body);
    if (process.env.LOG_REQUESTS) console.log(`${req.method} ${redact(req.url ?? "")} ${out.status} ${Date.now() - started}ms`);
  });
}
