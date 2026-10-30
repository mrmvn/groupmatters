// UI smoke test: runs the real SPA (public/*.js) in a linkedom DOM, with fetch routed to the
// real HTTP router in-process. Catches runtime errors on every page and exercises a few flows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { fixture, makeCtx } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { seedDemo } from "../src/demo.ts";
import * as repo from "../src/repo.ts";

const t = makeCtx({
  "https://api.github.com/repos/nodejs/node/pulls/50000": { body: fixture("github_pr_merged.json") },
  "https://www.loomio.com/api/v1/polls/irvWwUHt": { body: fixture("loomio_poll_closed.json") },
});
const demo = await seedDemo(t.ctx);
const token = demo.editToken;

const { window, document } = parseHTML(`<!doctype html><html><body><div id="app"></div></body></html>`);
const errors: string[] = [];
let hash = "#/list?lane=current";
const store = new Map<string, string>();
const g = globalThis as any;
Object.assign(g, {
  window,
  document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  Event: window.Event,
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
/** linkedom's select.value is read-only: pick the option instead. */
function choose(select: any, value: string) {
  const opts = [...select.querySelectorAll("option")] as any[];
  assert.ok(opts.some((o) => o.getAttribute("value") === value), `option ${value}`);
  for (const o of opts) o.toggleAttribute("selected", o.getAttribute("value") === value);
  assert.equal(select.value, value);
}
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b: any) => b.textContent.trim().startsWith(label)) as any[];

await import(new URL("../public/app.js", import.meta.url).href);
await settle();

test("every lane renders", async () => {
  for (const lane of ["current", "ended", "withdrawn", "all"]) {
    const main = await go(`#/list?lane=${lane}`);
    if (lane === "current") assert.match(main.textContent!, /Should we move the weekly call to Thursdays\?/);
    if (lane === "ended") assert.match(main.textContent!, /Should CI use the newer upload-artifact action\?/);
  }
  const header = document.querySelector("header")!.textContent!;
  assert.match(header, /Current \(\d+\)/);
  assert.match(header, /Ended \(\d+\)/);
});

test("search, presets and filters render", async () => {
  assert.match((await go("#/list?q=newcomers")).textContent!, /newcomers/);
  for (const p of ["no_process", "quiet", "fetch_problems"]) await go(`#/list?preset=${p}`);
  await go("#/list?lane=all&status=accepted&source=process&tool=custom&sort=created");
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
  await go("#/list?lane=current");
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

test("flow: set the status by hand, then follow the process again", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.process?.tool_id === "github")!;
  assert.equal(q.status, "accepted");
  await go(`#/q/${q.id}`);
  buttons("Set by hand instead")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  const form = document.querySelector(".inline-form") as any;
  choose(form.querySelector("select"), "Being discussed");
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  let r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.deepEqual([r.status, r.status_source, r.status_label], ["open", "manual", "Being discussed"]);
  buttons("Follow the process")[0].dispatchEvent(new window.Event("click"));
  await sleep(200);
  await settle();
  r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.deepEqual([r.status, r.status_source], ["accepted", "process"]);
});

test("flow: link a custom process, then update its state", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("Should we move the weekly call"))!;
  await go(`#/q/${q.id}`);
  buttons("Link a process")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  let form = document.querySelector(".inline-form") as any;
  const custom = form.querySelector('input[type=radio][value=custom]');
  custom.checked = true;
  custom.dispatchEvent(new window.Event("change"));
  const kind = [...form.querySelectorAll("input[type=text]")].find((i: any) => i.placeholder.startsWith("e.g. Meeting")) as any;
  kind.value = "Meeting";
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  assert.equal(repo.getQuestion(t.ctx.db, demo.space.id, q.id)!.process?.item_type, "Meeting");
  buttons("Update state")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  form = document.querySelector(".inline-form") as any;
  choose(form.querySelector("select"), "accepted|Agreed");
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  const r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.equal(r.status, "accepted");
  assert.match(document.querySelector("main")!.textContent!, /Agreed/);
});

test("rules: status labels panel renders and edits", async () => {
  const main = await go("#/rules");
  assert.match(main.textContent!, /Statuses/);
  buttons("Edit labels")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  const form = document.querySelector(".inline-form") as any;
  buttons("＋ Add a row")[0].dispatchEvent(new window.Event("click"));
  const rows = form.querySelectorAll(".map-row");
  const last = rows[rows.length - 1];
  last.querySelector("input").value = "Waiting for budget";
  choose(last.querySelector("select"), "open");
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  assert.ok(repo.getSpace(t.ctx.db, demo.space.id)!.settings.status_labels.some((l) => l.label === "Waiting for budget"));
});

test("flow: clicking a suggestion in Related questions relates the existing question", async () => {
  const qs = repo.listQuestions(t.ctx.db, demo.space.id).filter((q) => q.status !== "withdrawn");
  const [here, target] = [qs[0], qs.find((q) => q.id !== qs[0].id && !repo.relationsOf(t.ctx.db, qs[0].id).some((r) => r.from_id === q.id || r.to_id === q.id))!];
  const before = repo.listQuestions(t.ctx.db, demo.space.id).length;
  await go(`#/q/${here.id}`);
  const input = [...document.querySelectorAll("form.composer input")][0] as any;
  input.value = target.title;
  input.dispatchEvent(new window.Event("input"));
  await sleep(400);
  await settle();
  const pick = [...document.querySelectorAll(".hint-list button")].find((b: any) => b.textContent.includes(target.title)) as any;
  assert.ok(pick, "suggestion is a button");
  pick.dispatchEvent(new window.Event("click"));
  await sleep(200);
  await settle();
  assert.ok(repo.relationsOf(t.ctx.db, here.id).some((r) => r.from_id === here.id && r.to_id === target.id));
  assert.equal(repo.listQuestions(t.ctx.db, demo.space.id).length, before, "no new question created");
  // shown on the other side too
  await go(`#/q/${target.id}`);
  assert.ok([...document.querySelectorAll(".rel-list a")].some((a: any) => a.textContent === here.title));
});

test("flow: pasting an already tracked link shows the existing question", async () => {
  await go("#/list?lane=current");
  const input = document.getElementById("composer-input") as any;
  input.value = "https://github.com/nodejs/node/pull/50000/files";
  input.dispatchEvent(new window.Event("input"));
  await sleep(500);
  const notice = document.querySelector(".notice-existing") as any;
  assert.ok(notice, "notice shown");
  assert.match(notice.textContent, /already tracked by Should CI use the newer upload-artifact action\?/);
});

test("flow: remove a question, then restore it from the Rules page", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("Should we print t-shirts"))!;
  await go(`#/q/${q.id}`);
  buttons("Remove…")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  (document.querySelector(".inline-form") as any).dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  assert.ok(repo.getQuestion(t.ctx.db, demo.space.id, q.id)!.removed_at);
  assert.match(document.querySelector("main")!.textContent!, /Removed/);
  const rules = await go("#/rules");
  assert.match(rules.textContent!, /Removed questions \(1\)/);
  buttons("Restore")[0].dispatchEvent(new window.Event("click"));
  await sleep(200);
  await settle();
  assert.equal(repo.getQuestion(t.ctx.db, demo.space.id, q.id)!.removed_at, undefined);
});

test("process chips on cards link out to the platform", async () => {
  const main = await go("#/list?lane=all");
  const links = [...main.querySelectorAll(".chip-ext")] as any[];
  assert.ok(links.some((l) => l.getAttribute("href") === "https://github.com/nodejs/node/pull/50000"));
  assert.ok(links.every((l) => l.getAttribute("target") === "_blank" && l.getAttribute("rel")?.includes("noopener")));
});

/** A drop event carrying a link, as browsers send when dragging one from another tab. */
function dropLink(url: string, target: any = document.querySelector("main")) {
  const data: Record<string, string> = { "text/uri-list": url, "text/plain": url };
  const dt = { types: Object.keys(data), getData: (k: string) => data[k] ?? "", dropEffect: "" };
  for (const type of ["dragenter", "dragover", "drop"]) {
    const ev = new window.Event(type, { bubbles: true, cancelable: true }) as any;
    ev.dataTransfer = dt;
    target.dispatchEvent(ev);
  }
}

test("flow: drop a link on the home page → it's checked in the composer", async () => {
  await go("#/list?lane=current");
  dropLink("https://www.kialo.com/should-we-drop-links-123");
  await sleep(500);
  const input = document.getElementById("composer-input") as any;
  assert.equal(input.value, "https://www.kialo.com/should-we-drop-links-123");
  assert.match(document.querySelector(".composer-panel")!.textContent!, /Kialo/);
  assert.ok(!document.body.classList.contains("dropping"));
});

test("flow: drop a link elsewhere → home composer; on a question without process → link form", async () => {
  await go("#/activity");
  dropLink("https://www.kialo.com/dropped-from-activity-9");
  await settle();
  await sleep(450);
  assert.match(hash, /^#\/list/);
  assert.equal((document.getElementById("composer-input") as any).value, "https://www.kialo.com/dropped-from-activity-9");
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => !x.process)!;
  await go(`#/q/${q.id}`);
  dropLink("https://www.kialo.com/for-this-question-7");
  await sleep(50);
  const url = document.querySelector(".inline-form input[type=url]") as any;
  assert.equal(url.value, "https://www.kialo.com/for-this-question-7");
});

test("add-tool page offers Consul instances, preselected for Consul-looking links", async () => {
  const main = await go("#/rules/add-tool?url=https%3A%2F%2Fdecide.example.es%2Fproposals%2F12-x");
  const consul = main.querySelector('input[type=radio][value=consul]') as any;
  assert.ok(consul.checked);
  assert.equal((main.querySelector('input[placeholder="https://participa.example.org"]') as any).value, "https://decide.example.es");
});

test("tool edit page shows the state mapping as rows", async () => {
  await go("#/rules/tool?id=kialo");
  const rows = [...document.querySelectorAll(".map-row")] as any[];
  assert.deepEqual(rows.map((r) => [r.querySelector("input").value, r.querySelector("select").value]), [["Open", "open"], ["Closed", "concluded"]]);
});

test("tool edit page renders for manual tools", async () => {
  await go("#/rules/tool?id=kialo");
  assert.match(document.querySelector("main")!.textContent!, /Edit \u201cKialo\u201d/);
  assert.match((document.querySelector("textarea") as any).value, /kialo\.com\/:slug/);
});

test("no console errors", () => {
  assert.deepEqual(errors, []);
});
