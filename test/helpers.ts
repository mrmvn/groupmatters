import { readFileSync } from "node:fs";
import type { Ctx, Fetcher } from "../src/ctx.ts";
import { loadConfig } from "../src/ctx.ts";
import { openDb } from "../src/db.ts";
import { createSpace } from "../src/spaces.ts";

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

export type FakeRoute = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A test context: in-memory DB, controllable clock, fake network keyed by exact URL. */
export function makeCtx(routes: Record<string, FakeRoute | (() => FakeRoute)> = {}) {
  let now = new Date("2026-01-10T12:00:00Z");
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const route = typeof r === "function" ? r() : r;
    return new Response(route.status === 304 ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
  const ctx: Ctx = {
    db: openDb(":memory:"),
    now: () => now,
    fetch: fetcher,
    config: { ...loadConfig({}), publicUrl: "http://test", gitlabHosts: ["gitlab.com"] },
  };
  return {
    ctx,
    calls,
    routes,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    setNow(d: Date) {
      now = d;
    },
  };
}

export function makeSpace(ctx: Ctx) {
  return createSpace(ctx, "Test space");
}

export const GH_PR = "https://github.com/acme/widgets/pull/7";
export const GH_PR_API = "https://api.github.com/repos/acme/widgets/pulls/7";
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
