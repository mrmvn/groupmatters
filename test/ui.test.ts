// UI smoke test: runs the real SPA (public/*.js) in a linkedom DOM, with fetch routed to the
// real HTTP router in-process. Catches runtime errors on every page and exercises a few flows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { fixture, makeCtx } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { seedDemo } from "../src/demo.ts";
import * as repo from "../src/repo.ts";
import { effectiveDates } from "../src/fields.ts";

const t = makeCtx({
  "https://api.github.com/repos/nodejs/node/pulls/50000": { body: fixture("github_pr_merged.json") },
  "https://www.loomio.com/api/v1/polls/irvWwUHt": { body: fixture("loomio_poll_closed.json") },
  "https://api.github.com/repos/nodejs/node/pulls/50001": { body: fixture("github_pr_open.json") },
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
  const lanes = document.querySelector("main .sublanes")!.textContent!;
  assert.match(lanes, /Current \(\d+\)/);
  assert.match(lanes, /Ended \(\d+\)/);
  assert.ok(document.querySelector('main .sublane.current[href*="lane=all"]'), "the chosen lane is marked");
});

test("header: tabs are List, Timeline, Rules, Activity; the space name opens the dashboard", async () => {
  await go("#/list?lane=ended");
  const tabs = [...document.querySelectorAll("header nav .tab")] as any[];
  assert.deepEqual(tabs.map((a) => a.textContent), ["List", "Timeline", "Rules", "Activity"]);
  assert.equal(document.querySelector("header .tab.current")!.textContent, "List");
  assert.equal(document.querySelector("header a.space-name")!.getAttribute("href"), "#/dashboard");
  await go("#/dashboard");
  assert.equal(document.querySelector("header .tab.current"), null, "no tab is current on the dashboard");
});

test("dashboard renders its widgets; hiding one is remembered and can be undone", async () => {
  const main = await go("#/dashboard");
  const titles = [...main.querySelectorAll(".widget h2")].map((x: any) => x.textContent);
  for (const w of ["At a glance", "Top tools used", "Questions by status", "Needs attention", "Your impact", "Milestones"]) assert.ok(titles.includes(w), w);
  assert.ok(main.querySelector('.widget a[href="#/list?lane=all&tool=custom"]'), "tools link to the filtered list");
  assert.match(main.textContent!, /asked/, "personal widget uses the display name");
  (main.querySelector(".widget-hide") as any).click();
  assert.equal(JSON.parse(store.get("qr:dash:hidden")!).length, 1);
  assert.equal(main.querySelectorAll(".widget[hidden]").length, 1);
  const again = await go("#/dashboard");
  assert.equal(again.querySelectorAll(".widget[hidden]").length, 1, "still hidden");
  const box = [...again.querySelectorAll(".widget-choice input")].find((b: any) => !b.checked) as any;
  box.checked = true;
  box.dispatchEvent(new window.Event("change"));
  assert.equal(JSON.parse(store.get("qr:dash:hidden")!).length, 0);
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

/** Double-click a field's value and return its inline editor. */
async function editField(name: string) {
  const v = document.querySelector(`.field-${name} .field-value, .field-${name} h1`) as any;
  v.dispatchEvent(new window.Event("dblclick"));
  await sleep(30);
  return document.querySelector(`.field-${name} .field-editor`) as any;
}
async function submitAndSettle(form: any) {
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(200);
  await settle();
  return document.querySelector("main")!;
}

test("fields: a retrieved status says so (with the platform's word); double-click types it; ↺ use retrieved goes back", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.process?.tool_id === "github")!;
  assert.equal(q.status, "accepted");
  let main = await go(`#/q/${q.id}`);
  assert.match(main.querySelector(".field-status")!.textContent!, /retrieved as “merged”/);
  assert.match(main.querySelector(".field-kind")!.textContent!, /pull request\s*retrieved/);
  const form = await editField("status");
  choose(form.querySelector("select"), "Being discussed");
  main = await submitAndSettle(form);
  let r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.deepEqual([r.status, r.status_label, (r.typed.status?.value as any)?.label, r.typed.status?.by], ["open", "Being discussed", "Being discussed", "Ana"]);
  const cell = main.querySelector(".field-status")!;
  assert.match(cell.textContent!, /typed/);
  assert.match(cell.textContent!, /retrieved:\s*✔\s*Accepted/);
  (([...cell.querySelectorAll("button")] as any[]).find((b) => /use retrieved/.test(b.textContent))).click();
  await sleep(200);
  await settle();
  r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.deepEqual([r.status, r.typed.status], ["accepted", undefined]);
});

test("flow: link a custom process (a kind, no link), then type its status", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("Should we move the weekly call"))!;
  await go(`#/q/${q.id}`);
  buttons("Add an attached link")[0].dispatchEvent(new window.Event("click"));
  await sleep(50);
  const form = document.querySelector(".inline-form") as any;
  (form.querySelector('input[list="attach-kinds"]') as any).value = "Meeting";
  let main = await submitAndSettle(form);
  let r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.deepEqual([r.process?.tool_id, r.typed.kind?.value], ["custom", "Meeting"]);
  assert.match(main.textContent!, /No link: everything is typed/);
  assert.match(main.textContent!, /Nothing is retrieved here/);
  const ed = await editField("status");
  choose(ed.querySelector("select"), "Agreed");
  main = await submitAndSettle(ed);
  assert.equal(repo.getQuestion(t.ctx.db, demo.space.id, q.id)!.status, "accepted");
  assert.match(main.querySelector(".field-status")!.textContent!, /Agreed\s*typed/);
});

test("fields: dates typed with ✎ (time optional), cleared with No date", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("How do newcomers"))!;
  await go(`#/q/${q.id}`);
  (document.querySelector('.field-start button[aria-label="Type the start"]') as any).click();
  await sleep(30);
  let ed = document.querySelector(".field-start .field-editor") as any;
  ed.querySelector("input[type=date]").value = "2026-01-04";
  await submitAndSettle(ed);
  ed = await editField("end");
  ed.querySelector("input[type=date]").value = "2026-01-06";
  ed.querySelector("input[type=time]").value = "17:30";
  const main = await submitAndSettle(ed);
  let r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.equal(r.typed.start?.value, "2026-01-04", "no time: whole day");
  assert.equal(r.typed.end?.value, new Date("2026-01-06T17:30").toISOString());
  assert.match(main.querySelector(".field-start")!.textContent!, /typed/);
  ed = await editField("end");
  (([...ed.querySelectorAll("button")] as any[]).find((b) => b.textContent === "No date")).click();
  await sleep(200);
  await settle();
  r = repo.getQuestion(t.ctx.db, demo.space.id, q.id)!;
  assert.equal(r.typed.end, undefined, "nothing to retrieve: cleared");
});

test("flow: a link from a site not on the tool list is accepted, with a typed title", async () => {
  await go("#/list?lane=current");
  const input = document.getElementById("composer-input") as any;
  input.value = "https://forum.example.org/t/should-we-9";
  input.dispatchEvent(new window.Event("input"));
  await sleep(500);
  const panel = document.querySelector(".composer-panel")!;
  assert.match(panel.textContent!, /isn't on the tool list/);
  const title = panel.querySelector("input[type=text]") as any;
  assert.equal(title.required, true);
  title.value = "Should the forum be moderated?";
  await submitAndSettle(input.closest("form"));
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title === "Should the forum be moderated?")!;
  assert.deepEqual([q.process?.tool_id, q.process?.url], ["custom", "https://forum.example.org/t/should-we-9"]);
  assert.ok(document.querySelector('main a[href^="#/rules/add-tool"]'), "offers to add the tool");
});

test("flow: the composer shows the details fields, for typed text and for links", async () => {
  await go("#/list?lane=current");
  const input = document.getElementById("composer-input") as any;
  input.value = "Which venue for the autumn assembly?";
  input.dispatchEvent(new window.Event("input"));
  await sleep(400);
  const panel = document.querySelector(".composer-panel") as any;
  const labels = [...panel.querySelectorAll(".create-fields .label")].map((l: any) => l.textContent);
  assert.deepEqual(labels, ["Kind", "Status", "Summary", "Results", "Start", "End"]);
  assert.equal(panel.textContent.includes("Why it matters"), false);
  panel.querySelector('input[aria-label="Kind"]').value = "General assembly";
  choose(panel.querySelector('select[aria-label="Status"]'), "Being discussed");
  panel.querySelector('input[aria-label="Summary"]').value = "Venue and date";
  panel.querySelector('input[aria-label="Results"]').value = "Not decided yet";
  panel.querySelector('input[aria-label="Start: day"]').value = "2026-10-03";
  await submitAndSettle(input.closest("form"));
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title === "Which venue for the autumn assembly?")!;
  assert.deepEqual([q.process?.tool_id, q.status, q.status_label], ["custom", "open", "Being discussed"]);
  assert.deepEqual([q.typed.kind?.value, q.typed.summary?.value, q.typed.results_url?.value, q.typed.start?.value], ["General assembly", "Venue and date", "Not decided yet", "2026-10-03"]);
  const main = document.querySelector("main")!;
  assert.match(main.querySelector(".field-results_url")!.textContent!, /Not decided yet/);
  assert.equal(main.textContent!.includes("null"), false, "no stray null");
});

test("flow: a link from a listed tool shows what will be retrieved in the details", async () => {
  await go("#/list?lane=current");
  const input = document.getElementById("composer-input") as any;
  input.value = "https://github.com/nodejs/node/pull/50001";
  input.dispatchEvent(new window.Event("input"));
  await sleep(500);
  const panel = document.querySelector(".composer-panel") as any;
  const details = panel.querySelector(".create-fields");
  assert.ok(details, "details shown");
  const val = (sel: string) => details.querySelector(sel).value;
  assert.match(details.textContent, /retrieved/);
  assert.equal(val('input[aria-label="Kind"]').toLowerCase(), "pull request");
  assert.equal(val('select[aria-label="Status"]'), "Being discussed");
  assert.match(val('input[aria-label="Start: day"]'), /^\d{4}-\d{2}-\d{2}$/, "start pre-filled");
  // Unchanged pre-filled values aren't typed: they keep following the item. Changing one types it.
  details.querySelector('input[aria-label="Summary"]').value = "My own summary";
  await submitAndSettle(input.closest("form"));
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.process?.url === "https://github.com/nodejs/node/pull/50001")!;
  assert.deepEqual(Object.keys(q.typed).sort(), ["summary"]);
  assert.equal(q.typed.summary?.value, "My own summary");
});

test("timeline page: only dated questions, bars placed over time, same filters as the list, linked both ways", async () => {
  const main = await go("#/timeline");
  assert.ok(document.querySelector('header a[href="#/timeline"].current'), "Timeline tab");
  const rows = [...main.querySelectorAll(".tl-rows .tl-row")] as any[];
  const dated = repo.listQuestions(t.ctx.db, demo.space.id).filter((q) => effectiveDates(q).start);
  assert.equal(rows.length, dated.length, "only questions with a start date");
  assert.match(main.textContent!, /no start date and (isn't|aren't) shown/);
  const bar = main.querySelector(".tl-bar") as any;
  assert.match(bar.style.left, /^\d+(\.\d+)?%$/);
  assert.match(bar.getAttribute("aria-label"), /(from|starts) .*\((typed|retrieved)\)/);

  assert.ok(main.querySelector(".tl-today"));
  assert.ok(main.querySelector(".tl-bar.unknown-end"), "t-shirts: ended, end unknown");
  assert.ok(main.querySelector(".tl-planned"), "a planned end");
  assert.ok(main.querySelectorAll(".tl-tick").length > 0);
  const ended = await go("#/timeline?lane=ended");
  assert.ok(([...ended.querySelectorAll(".tl-bar")] as any[]).every((b) => /st-(accepted|rejected|concluded)/.test(b.className)));
  assert.ok(ended.querySelector('a[href="#/list?lane=ended"]'), "same filters as a list");
  const list = await go("#/list?lane=ended");
  assert.ok(list.querySelector('a[href="#/timeline?lane=ended"]'), "and back");
  assert.match((await go("#/timeline?q=zzzz-nothing")).textContent!, /No dated questions match/);
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

test("flow: a removed question can be restored from the Rules page", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("Should we print t-shirts"))!;
  // The question page has no Edit or Remove button: removal is an API action.
  const page = await go(`#/q/${q.id}`);
  assert.deepEqual(buttons("Edit").concat(buttons("Remove…")), []);
  assert.equal(page.textContent!.includes("null"), false);
  // @ts-ignore (browser module)
  await (await import("../public/api.js")).api("POST", `questions/${q.id}/remove`, {});
  // Saving anything in the app reloads the counts.
  await go(`#/q/${repo.listQuestions(t.ctx.db, demo.space.id).find((x) => x.title.startsWith("Should meeting notes"))!.id}`);
  const ed = await editField("summary");
  ed.querySelector("input").value = "Spanish and French";
  await submitAndSettle(ed);
  await go(`#/q/${q.id}`);
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

test("tool edit page: patterns and description, no state words", async () => {
  const main = await go("#/rules/tool?id=kialo");
  assert.equal(main.querySelectorAll(".map-row").length, 0);
  assert.match(main.textContent!, /the kind .* and the page title are retrieved/);
});

test("tool edit page renders for manual tools", async () => {
  await go("#/rules/tool?id=kialo");
  assert.match(document.querySelector("main")!.textContent!, /Edit \u201cKialo\u201d/);
  assert.ok(([...document.querySelectorAll("textarea")] as any[]).some((t) => /kialo\.com\/:slug/.test(t.value)));
  assert.match((document.querySelector("textarea") as any).value, /Structured debate/, "description first");
});

test("rules list shows what each tool is for and how much it's used; automatic tools edit name and description only", async () => {
  const rules = await go("#/rules");
  assert.match(rules.textContent!, /Group decisions/);
  assert.match(rules.textContent!, /Used by/);
  assert.ok(rules.querySelector('a[href="#/list?lane=all&tool=github"]'), "usage links to the filtered list");
  assert.ok(rules.querySelector('a[href="#/rules/tool?id=github"]'), "automatic tools have an Edit link");
  const main = await go("#/rules/tool?id=github");
  assert.equal((main.querySelector("input[type=text]") as any).value, "GitHub");
  const visible = ([...main.querySelectorAll("textarea")] as any[]).filter((t) => !t.closest("[hidden]"));
  assert.equal(visible.length, 1, "only the description");
  visible[0].value = "Our code and docs";
  main.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(150);
  await settle();
  assert.equal(repo.getTool(t.ctx.db, demo.space.id, "github")!.description, "Our code and docs");
  assert.match(hash, /^#\/rules/);
});

test("add an attached link: the tool list with descriptions is offered as a hint", async () => {
  const q = repo.listQuestions(t.ctx.db, demo.space.id).find((x) => !x.process)!;
  const main = await go(`#/q/${q.id}`);
  const btn = ([...main.querySelectorAll("button")] as any[]).find((b) => /Add an attached link/.test(b.textContent));
  btn.click();
  await sleep(50);
  const hints = document.querySelector(".tool-hints")!;
  assert.match(hints.textContent!, /Tools on the list: .*Loomio/);
  assert.match(hints.textContent!, /Group decisions/);
});

test("no console errors", () => {
  assert.deepEqual(errors, []);
});
