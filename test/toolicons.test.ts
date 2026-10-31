import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace, DAY } from "./helpers.ts";
import { fetchMissingToolIcons, fetchSiteIcon, iconLinks, sniffImage, toolIcon, toolOrigin } from "../src/toolicons.ts";
import { route } from "../src/http/server.ts";
import * as repo from "../src/repo.ts";
import type { Tool } from "../src/types.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const SVG = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`;
const html = (head: string) => ({ body: `<!doctype html><html><head>${head}</head></html>`, headers: { "content-type": "text/html" } });
const png = () => ({ body: PNG, headers: { "content-type": "image/png" } });

test("iconLinks: SVG first, then a raster of 32–96px, tiny/huge ones last; relative hrefs resolved", () => {
  const links = iconLinks(
    `<link rel="icon" sizes="16x16" href="/f16.png"><link rel="apple-touch-icon" href="/apple.png">
     <link rel="shortcut icon" href="/f.ico"><LINK REL="icon" sizes="32x32" href="f32.png">
     <link rel="icon" type="image/svg+xml" href="/f.svg?v=2&amp;x=1"><link rel="stylesheet" href="/s.css">`,
    "https://site.example/a/",
  );
  assert.equal(links[0], "https://site.example/f.svg?v=2&x=1");
  assert.equal(links[1], "https://site.example/a/f32.png");
  assert.ok(links.indexOf("https://site.example/apple.png") < links.indexOf("https://site.example/f16.png"));
  assert.ok(!links.some((l) => l.endsWith(".css")));
});

test("sniffImage: by content, not by the server's word", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from(SVG)), "image/svg+xml");
  assert.equal(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0])), "image/x-icon");
  assert.equal(sniffImage(Buffer.from("<!doctype html><html><body>Not found</body></html>")), undefined);
});

test("toolOrigin: the first pattern with a plain host; toolIcon: bundled, fetched, adapter fallback, none", () => {
  const t = (x: Partial<Tool>) => ({ id: "x", name: "X", url_patterns: [], fetch_mode: "manual", enabled: true, ...x }) as Tool;
  assert.equal(toolOrigin(t({ url_patterns: [{ pattern: "https://*/x", item_type: "a" }, { pattern: "https://pad.example.org/p/:id", item_type: "a" }] })), "https://pad.example.org");
  assert.equal(toolOrigin(t({ url_patterns: [{ pattern: "https://*.example.org/*", item_type: "a" }] })), undefined);
  assert.deepEqual(toolIcon(t({ id: "github" })), { url: "/assets/icons/github.svg", mono: true });
  assert.deepEqual(toolIcon(t({ icon: "data:image/png;base64,AA" })), { url: "data:image/png;base64,AA" });
  assert.equal(toolIcon(t({ adapter: "consul" }))?.url, "/assets/icons/consul.png");
  assert.equal(toolIcon(t({})), undefined);
});

test("fetchSiteIcon: declared icon, else /favicon.ico; refuses non-images and private hosts", async () => {
  const t = makeCtx({
    "https://a.example/": html(`<link rel="icon" href="/brand.svg">`),
    "https://a.example/brand.svg": { body: SVG, headers: { "content-type": "image/svg+xml" } },
    "https://b.example/": html(`<link rel="icon" href="/missing.png">`),
    "https://b.example/favicon.ico": png(),
    "https://c.example/favicon.ico": html("<title>Not an image</title>"),
    "https://d.example/": html(`<link rel="icon" href="https://intranet.example/i.png">`),
    "https://intranet.example/i.png": png(),
  });
  t.privateHosts.add("intranet.example");
  assert.match((await fetchSiteIcon(t.ctx, "https://a.example"))!, /^data:image\/svg\+xml;base64,/);
  assert.equal(await fetchSiteIcon(t.ctx, "https://b.example"), `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(await fetchSiteIcon(t.ctx, "https://c.example"), undefined);
  assert.equal(await fetchSiteIcon(t.ctx, "https://d.example"), undefined);
  assert.ok(!t.calls.includes("https://intranet.example/i.png"));
});

test("adding a tool fetches its icon once; the scheduler fills in the rest and retries weekly", async () => {
  const t = makeCtx({ "https://pad.example.org/": html(`<link rel="icon" href="/fav.png">`), "https://pad.example.org/fav.png": png() });
  const { space, editToken } = makeSpace(t.ctx);
  const post = async (body: unknown) => {
    const r = await route(t.ctx, {
      method: "POST",
      url: `/api/s/${editToken}/tools`,
      headers: { host: "register.test", "content-type": "application/json", "x-actor-name": "Ana" },
      body: Buffer.from(JSON.stringify(body)),
    });
    return JSON.parse(r.body.toString());
  };
  const res = await post({ name: "Pad", url_patterns: [{ pattern: "https://pad.example.org/p/:id", item_type: "pad" }] });
  const pad = res.tools.find((x: any) => x.name === "Pad");
  assert.match(pad.icon.url, /^data:image\/png;base64,/);
  assert.deepEqual(res.tools.find((x: any) => x.id === "loomio").icon, { url: "/assets/icons/loomio.svg" });
  // Built-in tools are never fetched.
  assert.ok(!t.calls.some((u) => u.includes("loomio.com")));

  // A tool whose site has no icon yet: tried, then retried only after a week.
  const r2 = await post({ name: "Wiki", url_patterns: [{ pattern: "https://wiki.example.org/*", item_type: "page" }] });
  assert.equal(r2.tools.find((x: any) => x.name === "Wiki").icon, undefined);
  const n = t.calls.length;
  await fetchMissingToolIcons(t.ctx);
  assert.equal(t.calls.length, n, "not retried before a week");
  t.routes["https://wiki.example.org/favicon.ico"] = png();
  t.advance(8 * DAY);
  await fetchMissingToolIcons(t.ctx);
  assert.ok(repo.listTools(t.ctx.db, space.id).find((x) => x.name === "Wiki")!.icon);
  // Static icons are served with an image type.
  const file = await route(t.ctx, { method: "GET", url: "/assets/icons/kialo.webp", headers: { host: "register.test" } });
  assert.deepEqual([file.status, file.headers["Content-Type"]], [200, "image/webp"]);
});
