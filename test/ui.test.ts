// UI smoke test: runs the real SPA (public/*.js) in a linkedom DOM, with fetch routed to the
// real HTTP router in-process. Catches runtime errors on every page and exercises a few flows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { fixture, makeCtx } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { seedDemo } from "../src/demo.ts";
import * as repo from "../src/repo.ts";

const t = makeCtx({ "https://api.github.com/repos/nodejs/node/pulls/50000": { body: fixture("github_pr_merged.json") } });
const demo = await seedDemo(t.ctx);
const token = demo.editToken;

const { window, document } = parseHTML(`<!doctype html><html><body><div id="app"></div></body></html>`);
const errors: string[] = [];
let hash = "#/list?lane=active";
const store = new Map<string, string>();
const g = globalThis as any;
Object.assign(g, {
  window,
  document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)) },
  confirm: () => true,
  location: {
    pathname: `/s/${token}`,
    get hash() {
      return hash;
    },
    set hash(v: string) {
      hash = v.startsWith("#") ? v : `#${v}`;
      window.dispatchEvent(new window.Event("hashchange"));
    },
  },
});
window.HTMLElement.prototype.scrollIntoView = function () {};
if (!window.HTMLElement.prototype.focus) window.HTMLElement.prototype.focus = function () {};
g.fetch = async (url: string, init: any = {}) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  const r = await route(t.ctx, { method: init.method ?? "GET", url, headers, body: init.body ? Buffer.from(init.body) : undefined });
  return new Response(r.body as any, { status: r.status, headers: r.headers });
};
const origError = console.error;
console.error = (...a: unknown[]) => (errors.push(a.map(String).join(" ")), origError(...a));
store.set("qr:name", "Ana");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  for (let i = 0; i < 50; i++) {
    await sleep(20);
    if (document.querySelector("main")) break;
  }
  await sleep(60);
}
async function go(h: string) {
  g.location.hash = h;
  await settle();
  const main = document.querySelector("main");
  assert.ok(main, `page rendered for ${h}`);
  assert.ok(!main!.textContent!.includes("Something went wrong"), `no error on ${h}: ${main!.textContent!.slice(0, 300)}`);
  return main!;
}
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b: any) => b.textContent.trim().startsWith(label)) as any[];

await import(new URL("../public/app.js", import.meta.url).href);
await settle();

test("every lane renders", async () => {
  for (const lane of ["inbox", "active", "standing", "resolved", "archive", "all"]) {
    const main = await go(`#/list?lane=${lane}`);
    if (lane === "active") assert.match(main.textContent!, /Should we adopt a code of conduct\?/);
  }
  const header = document.querySelector("header")!.textContent!;
  assert.match(header, /Active \(\d+\/8\)/);
});

test("search and presets render", async () => {
  assert.match((await go("#/list?q=newcomers")).textContent!, /newcomers/);
  await go("#/list?preset=ready");
  await go("#/list?preset=objections");
  await go("#/list?preset=no_process&lane=all&section=all");
});

test("every question page renders", async () => {
  for (const q of repo.listQuestions(t.ctx.db, demo.space.id)) {
    const main = await go(`#/q/${q.id}`);
    assert.ok(main.textContent!.includes(q.title));
  }
});

test("rules pages and activity render", async () => {
  const rules = await go("#/rules");
  assert.match(rules.textContent!, /Tool list/);
  assert.match(rules.textContent!, /How this register works/);
  const add = await go("#/rules/add-tool?url=https%3A%2F%2Fforum.example.org%2Ft%2F1");
  assert.match(add.textContent!, /Add a tool/);
  assert.match((await go("#/activity")).textContent!, /added the question/);
});

test("flow: type a question in the composer and add it", async () => {
  await go("#/list?lane=inbox");
  const input = document.getElementById("composer-input") as any;
  input.value = "Should we rotate facilitation monthly?";
  input.dispatchEvent(new window.Event("input"));
  await sleep(400);
  const form = input.closest("form");
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  assert.match(hash, /^#\/q\//);
  assert.match(document.querySelector("main")!.textContent!, /Should we rotate facilitation monthly\?/);
});

test("flow: adopt with an attestation criterion, then attest", async () => {
  const id = hash.split("/")[2];
  buttons("Adopt")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  const form = document.querySelector(".inline-form") as any;
  const attested = [...form.querySelectorAll(".crit")].find((c: any) => c.textContent.includes("steward confirms")) as any;
  const textInput = attested.querySelector("input[type=text]");
  textInput.value = "Agreed at the next meeting";
  textInput.dispatchEvent(new window.Event("input"));
  attested.querySelector("input[type=checkbox]").checked = true;
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  assert.equal(repo.getQuestion(t.ctx.db, demo.space.id, id)!.status, "active");

  buttons("Attest")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  const f2 = document.querySelector(".inline-form") as any;
  const ta = f2.querySelector("textarea");
  ta.value = "Agreed by 8 of 9 at the 5 May meeting";
  f2.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  const q = repo.getQuestion(t.ctx.db, demo.space.id, id)!;
  assert.equal(q.status, "resolved");
  assert.match(document.querySelector("main")!.textContent!, /Resolved/);
});

test("no console errors", () => {
  assert.deepEqual(errors, []);
});
