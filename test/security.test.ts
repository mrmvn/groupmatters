// Security fixes from PILOT-PLAN §1 (S1, S2, S4, S6–S9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace, fixture, GH_PR, GH_PR_API } from "./helpers.ts";
import { getJson } from "../src/adapters/common.ts";
import { readCapped, safeFetch } from "../src/net.ts";
import { rateLimit, route } from "../src/http/server.ts";
import * as Q from "../src/questions.ts";

test("S1: adapter redirects to another host are refused before being requested", async () => {
  const t = makeCtx({
    "https://api.example.org/a": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } },
    "https://api.example.org/b": { status: 307, headers: { location: "https://10.0.0.5/admin" } },
    "https://api.example.org/c": { status: 301, headers: { location: "/d" } },
    "https://api.example.org/d": { body: { ok: true } },
  });
  await assert.rejects(() => getJson(t.ctx, "https://api.example.org/a", {}, "api.example.org"), /redirect|https/i);
  await assert.rejects(() => getJson(t.ctx, "https://api.example.org/b", {}, "api.example.org"), /another host/);
  assert.deepEqual((await getJson(t.ctx, "https://api.example.org/c", {}, "api.example.org")).json, { ok: true }, "same-host redirect followed");
  assert.ok(!t.calls.some((u) => u.includes("169.254") || u.includes("10.0.0.5")), "never requested");
});

test("S1: a POST redirected with 302 becomes a GET; too many redirects are refused", async () => {
  const methods: string[] = [];
  const t = makeCtx({
    "https://api.example.org/graphql": (init) => (methods.push(init?.method ?? "GET"), { status: 302, headers: { location: "/graphql2" } }),
    "https://api.example.org/graphql2": (init) => (methods.push(init?.method ?? "GET"), { body: { data: 1 } }),
    "https://api.example.org/loop": { status: 302, headers: { location: "/loop" } },
  });
  assert.deepEqual((await getJson(t.ctx, "https://api.example.org/graphql", {}, "api.example.org", { query: "{}" })).json, { data: 1 });
  assert.deepEqual(methods, ["POST", "GET"]);
  await assert.rejects(() => getJson(t.ctx, "https://api.example.org/loop", {}, "api.example.org"), /Too many redirects/);
});

test("S2: oversized responses are refused while reading, not after", async () => {
  // Declared too large: refused without reading.
  const t = makeCtx({ "https://api.example.org/big": { body: "{}", headers: { "content-length": "999999999" } } });
  await assert.rejects(() => getJson(t.ctx, "https://api.example.org/big", {}, "api.example.org"), /too large/);

  // Streamed without a length: reading stops just past the cap.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  await assert.rejects(() => readCapped(new Response(endless), 256 * 1024), /too large/);
  assert.ok(pulled < 10, `stopped early (${pulled} chunks)`);

  // Truncating mode (titles) returns the first bytes.
  assert.equal((await readCapped(new Response("abcdef"), 3, true)), "abc");
});

test("safeFetch: private hosts, http, credentials and odd ports are refused before any request", async () => {
  const t = makeCtx();
  t.privateHosts.add("intranet.example.org");
  for (const u of ["https://intranet.example.org/", "http://example.org/", "https://u:p@example.org/", "https://example.org:8443/", "https://127.0.0.1/"])
    await assert.rejects(() => safeFetch(t.ctx, u, { maxBytes: 100 }), u);
  assert.deepEqual(t.calls, []);
});

test("S6: two simultaneous adds of the same link: only one succeeds", async () => {
  const t = makeCtx({ [GH_PR_API]: { body: fixture("github_pr_open.json") } });
  const { space } = makeSpace(t.ctx);
  const slow = t.ctx.fetch;
  t.ctx.fetch = async (url, init) => (await new Promise((r) => setTimeout(r, 20)), slow(url, init));
  const results = await Promise.allSettled([
    Q.create(t.ctx, space, "Ana", { title: "First", process_url: GH_PR }),
    Q.create(t.ctx, space, "Ben", { title: "Second", process_url: GH_PR }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(failed.reason.code, "duplicate_link");
});

test("S4, S7, S8, S9: feed, origin, malformed paths, activity limit, headers", async () => {
  const t = makeCtx();
  const { editToken, viewToken } = makeSpace(t.ctx);
  const call = (url: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) =>
    route(t.ctx, {
      method,
      url,
      headers: { host: "register.test", ...(body !== undefined ? { "content-type": "application/json", "x-actor-name": "Ana" } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    });

  // S4: feeds from view links only.
  assert.equal((await call(`/feed/${viewToken}.atom`)).status, 200);
  assert.equal((await call(`/feed/${editToken}.atom`)).status, 404);

  // S7: `Origin: null` and garbage origins are cross-origin; a malformed % is a 400.
  assert.equal((await call(`/api/s/${editToken}/questions`, "POST", { origin: "null" }, { title: "From a sandboxed iframe" })).status, 403);
  assert.equal((await call(`/api/s/${editToken}/questions`, "POST", { origin: "::not a url" }, { title: "Garbage origin" })).status, 403);
  assert.equal((await call(`/api/s/${editToken}/questions`, "POST", { origin: "http://register.test" }, { title: "Same origin" })).status, 200);
  assert.equal((await call(`/api/s/${editToken}/questions/%E0%A4%A`)).status, 400);

  // S8: activity limit capped.
  assert.equal((await call(`/api/s/${viewToken}/activity?limit=999999`)).status, 200);

  // S9: CORP everywhere; HSTS only with an https public URL.
  const plain = await call("/healthz");
  assert.equal(plain.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(plain.headers["Strict-Transport-Security"], undefined);
  t.ctx.config = { ...t.ctx.config, publicUrl: "https://groupmatters.org" };
  assert.equal((await call("/healthz")).headers["Strict-Transport-Security"], "max-age=31536000");
});

test("S8: the rate limiter drops the oldest keys, not everyone's history", () => {
  const map = new Map<string, number[]>();
  const now = Date.now();
  rateLimit(map, "busy", 2, now, "slow down");
  for (let i = 0; i < 10_000; i++) rateLimit(map, `k${i}`, 2, now, "slow down");
  assert.ok(!map.has("busy"), "oldest key evicted");
  assert.equal(map.size, 10_000);
  rateLimit(map, "k5", 2, now, "slow down");
  assert.throws(() => rateLimit(map, "k5", 2, now, "slow down"), /slow down/, "recent keys keep their history");
});
