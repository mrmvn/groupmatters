import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "./helpers.ts";
import { extractTitle, fetchPageTitle, isGenericTitle } from "../src/pagetitle.ts";
import { isPrivateAddress } from "../src/net.ts";

const html = (head: string) => ({ body: `<!doctype html><html><head>${head}</head><body></body></html>`, headers: { "content-type": "text/html; charset=utf-8" } });

test("extractTitle: og:title, then twitter:title, then <title>; entities decoded", () => {
  assert.equal(extractTitle(`<meta content="OG &#8220;one&#8221;" property="og:title"><title>T</title>`), "OG “one”");
  assert.equal(extractTitle(`<meta name="twitter:title" content='Tw'><title>T</title>`), "Tw");
  assert.equal(extractTitle(`<title>\n  Plain &amp; simple \n</title>`), "Plain & simple");
  assert.equal(extractTitle(`<p>no title</p>`), undefined);
});

test("generic titles are discarded", () => {
  assert.ok(isGenericTitle("Kialo", "https://www.kialo.com/x-1", "Kialo"));
  assert.ok(isGenericTitle("Just a moment...", "https://www.metaculus.com/questions/1/"));
  assert.ok(isGenericTitle("Polis", "https://pol.is/abc"));
  assert.ok(isGenericTitle("Log in", "https://forum.example.org/t/1"));
  assert.ok(!isGenericTitle("Should we move to Thursdays?", "https://forum.example.org/t/1", "Forum"));
});

test("private and special addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["93.184.216.34", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("fetchPageTitle: reads public pages, follows safe redirects, refuses private hosts and non-https", async () => {
  const t = makeCtx({
    "https://forum.example.org/t/1": html(`<meta property="og:title" content="Thursday calls?">`),
    "https://forum.example.org/t/2": { status: 302, headers: { location: "/t/1" } },
    "https://forum.example.org/t/3": { status: 302, headers: { location: "https://intranet.example.org/secret" } },
    "https://intranet.example.org/secret": html(`<title>Internal</title>`),
    "https://forum.example.org/t/4": { status: 302, headers: { location: "http://forum.example.org/t/1" } },
    "https://forum.example.org/file.json": { body: { title: "x" }, headers: { "content-type": "application/json" } },
  });
  t.privateHosts.add("intranet.example.org");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/t/1", "Forum"), "Thursday calls?");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/t/2"), "Thursday calls?", "same-site redirect");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/t/3"), undefined, "redirect to a private host");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/t/4"), undefined, "redirect to http");
  assert.equal(await fetchPageTitle(t.ctx, "https://intranet.example.org/secret"), undefined, "private host");
  assert.equal(await fetchPageTitle(t.ctx, "https://127.0.0.1/x"), undefined, "private IP literal");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org:8443/x"), undefined, "non-standard port");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/file.json"), undefined, "not HTML");
  assert.equal(await fetchPageTitle(t.ctx, "https://forum.example.org/missing"), undefined, "404");
  assert.ok(!t.calls.includes("https://intranet.example.org/secret"), "never requested");
});
