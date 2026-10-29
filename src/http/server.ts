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
};

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

// Per-token write rate limit (sliding one-minute window).
const writes = new Map<string, number[]>();
function rateLimit(key: string, perMinute: number, now: number) {
  const arr = (writes.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= perMinute) throw new HttpError(429, "rate_limited", "Too many changes in a short time; wait a minute");
  arr.push(now);
  writes.set(key, arr);
  if (writes.size > 10_000) writes.clear();
}

export const redact = (url: string) => url.replace(/\/(s|feed)\/[A-Za-z0-9_-]{20,}/, "/$1/[token]");

async function routeInner(ctx: Ctx, req: Req): Promise<Res> {
  const url = new URL(req.url, "http://localhost");
  const segs = url.pathname.split("/").filter(Boolean);
  const { method } = req;

  if (method === "GET" && segs[0] === "assets") return file(segs.slice(1).join("/"));
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return file("home.html");
  if (method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });

  // SPA shell, one per space link
  if (method === "GET" && segs[0] === "s" && segs.length === 2) {
    if (!looksLikeToken(segs[1]) || !repo.findSpaceByToken(ctx.db, segs[1])) throw new HttpError(404, "not_found", "Not found");
    return file("index.html", false);
  }

  // Atom feed
  if (method === "GET" && segs[0] === "feed" && segs.length === 2 && segs[1].endsWith(".atom")) {
    const token = segs[1].slice(0, -5);
    const found = looksLikeToken(token) ? repo.findSpaceByToken(ctx.db, token) : undefined;
    if (!found) throw new HttpError(404, "not_found", "Not found");
    return { status: 200, headers: { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "no-store" }, body: atomFeed(ctx, found.space, token) };
  }

  // JSON API
  if (segs[0] === "api" && segs[1] === "s" && segs.length >= 3) {
    try {
      const token = segs[2];
      const found = looksLikeToken(token) ? repo.findSpaceByToken(ctx.db, token) : undefined;
      if (!found) throw new HttpError(404, "not_found", "Unknown or revoked link");
      if (method !== "GET") {
        // CSRF defence in depth: refuse cross-origin writes when the browser tells us the origin.
        const origin = req.headers.origin;
        if (origin && req.headers.host && new URL(origin).host !== req.headers.host)
          throw new HttpError(403, "forbidden", "Cross-origin request refused");
        rateLimit(hashToken(token), ctx.config.writeRateLimitPerMinute, Date.now());
      }
      const data = await handleApi(ctx, {
        method,
        path: segs.slice(3).map(decodeURIComponent),
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
  res.headers = { ...SECURITY_HEADERS, ...res.headers };
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
      ? { ...json(413, { error: { code: "too_large", message: "Request body too large" } }), headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" } }
      : await route(ctx, { method: req.method ?? "GET", url: req.url ?? "/", headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(out.status, out.headers);
    res.end(req.method === "HEAD" ? undefined : out.body);
    if (process.env.LOG_REQUESTS) console.log(`${req.method} ${redact(req.url ?? "")} ${out.status} ${Date.now() - started}ms`);
  });
}
