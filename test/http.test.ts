import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { rotateLink } from "../src/spaces.ts";

const t = makeCtx();
const { space, editToken, viewToken } = makeSpace(t.ctx);
// Calls the pure router directly (the sandbox used for development forbids binding sockets).
async function fetchLocal(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers: Record<string, string> = { host: "register.test" };
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  const r = await route(t.ctx, { method: init.method ?? "GET", url: path, headers, body: init.body ? Buffer.from(init.body) : undefined });
  return {
    status: r.status,
    headers: new Headers(r.headers),
    text: async () => r.body.toString(),
    json: async () => JSON.parse(r.body.toString()),
  };
}

async function api(token: string, method: string, path: string, body?: unknown, name: string | null = "Ana") {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (name) headers["X-Actor-Name"] = encodeURIComponent(name);
  const res = await fetchLocal(`/api/s/${token}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any, headers: res.headers };
}

test("security headers and SPA shell", async () => {
  const res = await fetchLocal(`/s/${editToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.equal((await fetchLocal(`/s/not-a-real-token-but-long-enough-to-look-like-one-xx`)).status, 404);
});

test("edit vs view links", async () => {
  const e = await api(editToken, "GET", "space");
  assert.equal(e.json.role, "edit");
  const v = await api(viewToken, "GET", "space");
  assert.equal(v.json.role, "view");
  const w = await api(viewToken, "POST", "questions", { title: "Can I?" });
  assert.equal(w.status, 403);
  const ok = await api(editToken, "POST", "questions", { title: "Can I?" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.question.created_by, "Ana");
  assert.equal(ok.json.activity[0].actor, "Ana");
});

test("writes need a display name; non-ASCII names work", async () => {
  const r = await api(editToken, "POST", "questions", { title: "x" }, null);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "name_required");
  const ok = await api(editToken, "POST", "questions", { title: "¿Qué?" }, "Chloé");
  assert.equal(ok.json.question.created_by, "Chloé");
  const sys = await api(editToken, "POST", "questions", { title: "x" }, "system");
  assert.equal(sys.status, 400, "reserved name");
});

test("unknown token → 404", async () => {
  const r = await api("A".repeat(43), "GET", "space");
  assert.equal(r.status, 404);
});

test("cross-origin writes are refused", async () => {
  const res = await fetchLocal(`/api/s/${editToken}/questions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-Actor-Name": "Ana" },
    body: JSON.stringify({ title: "csrf" }),
  });
  assert.equal(res.status, 403);
});

test("add a tool directly: usable at once, links already in the register join it, can be disabled", async () => {
  const url = "https://wiki.example.org/t/should-we/7";
  const preview = await api(editToken, "POST", "resolve-url", { url });
  assert.equal(preview.json.matched, false);
  const before = await api(editToken, "POST", "questions", { title: "Wiki thread", process_url: url });
  assert.equal(before.status, 200, "a link not on the tool list is accepted");
  assert.deepEqual([before.json.question.process.tool_id, before.json.question.fields.status.retrievable], ["custom", false]);
  const added = await api(editToken, "POST", "tools", { name: "Our wiki", url_patterns: [{ pattern: preview.json.suggestion.pattern, item_type: "topic" }] });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const wiki = added.json.tools.find((x: any) => x.name === "Our wiki");
  assert.ok(wiki && wiki.enabled && !wiki.added_by_question_id && !wiki.state_map);
  const adopted = (await api(editToken, "GET", `questions/${before.json.question.id}`)).json;
  assert.deepEqual([adopted.question.process.tool_id, adopted.question.fields.kind.value, adopted.question.fields.kind.source], [wiki.id, "topic", "retrieved"]);
  assert.ok(adopted.activity.some((e: any) => e.action === "process.tool_matched"));
  const used = await api(editToken, "POST", "questions", { title: "Wiki thread 2", process_url: "https://wiki.example.org/t/other/8" });
  assert.equal(used.status, 200);
  assert.equal(used.json.question.process.tool_id, wiki.id);
  const off = await api(editToken, "POST", `tools/${wiki.id}/enabled`, { enabled: false });
  assert.equal(off.json.tools.find((x: any) => x.id === wiki.id).enabled, false);
  const view = await api(viewToken, "POST", "tools", { name: "x" });
  assert.equal(view.status, 403);
});

test("edit a manual tool; automatic tools can't be edited", async () => {
  const added = await api(editToken, "POST", "tools", { name: "Board", url_patterns: [{ pattern: "https://board.example.org/*", item_type: "card" }] });
  const board = added.json.tools.find((x: any) => x.name === "Board");
  const edited = await api(editToken, "PATCH", `tools/${board.id}`, {
    name: "Our board",
    url_patterns: [{ pattern: "https://board.example.org/c/:id", item_type: "card" }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const after = edited.json.tools.find((x: any) => x.id === board.id);
  assert.equal(after.name, "Our board");
  assert.equal(after.url_patterns[0].pattern, "https://board.example.org/c/:id");
  const gh = await api(editToken, "PATCH", "tools/github", { name: "x", url_patterns: [{ pattern: "https://x.org/*", item_type: "x" }] });
  assert.equal(gh.status, 400);
  const view = await api(viewToken, "PATCH", `tools/${board.id}`, { name: "x" });
  assert.equal(view.status, 403);
});

test("tools say what they're useful for: seeded, editable on every tool (automatic: name and description only)", async () => {
  const tools = (await api(editToken, "GET", "space")).json.tools;
  assert.match(tools.find((x: any) => x.id === "loomio").description, /Group decisions/);
  const loomio = tools.find((x: any) => x.id === "loomio");
  const r = await api(editToken, "PATCH", "tools/loomio", { name: "Loomio (our group)", description: "  Votes on   proposals  " });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = r.json.tools.find((x: any) => x.id === "loomio");
  assert.deepEqual([after.name, after.description, after.fetch_mode], ["Loomio (our group)", "Votes on proposals", "auto"]);
  assert.deepEqual(after.url_patterns, loomio.url_patterns, "patterns untouched");
  // Sending the unchanged patterns along is fine; changing them isn't.
  assert.equal((await api(editToken, "PATCH", "tools/loomio", { name: "Loomio", url_patterns: loomio.url_patterns })).status, 200);
  assert.equal((await api(editToken, "PATCH", "tools/loomio", { name: "Loomio", url_patterns: [{ pattern: "https://x.org/*", item_type: "x" }] })).status, 400);
  const kept = (await api(editToken, "GET", "space")).json.tools.find((x: any) => x.id === "loomio");
  assert.deepEqual([kept.name, kept.description], ["Loomio", "Votes on proposals"], "missing description keeps the current one");
  const cleared = await api(editToken, "PATCH", "tools/loomio", { name: "Loomio", description: "" });
  assert.equal(cleared.json.tools.find((x: any) => x.id === "loomio").description, undefined);
  assert.equal((await api(editToken, "PATCH", "tools/loomio", { name: "Loomio", description: "x".repeat(401) })).status, 400);
  const log = (await api(editToken, "GET", "activity?limit=3")).json.activity.find((e: any) => e.action === "tool.edited");
  assert.equal(log.data.before.description, "Votes on proposals");
  const added = await api(editToken, "POST", "tools", { name: "Notes pad", description: "Meeting notes", url_patterns: [{ pattern: "https://pad.example.org/*", item_type: "pad" }] });
  assert.equal(added.json.tools.find((x: any) => x.name === "Notes pad").description, "Meeting notes");
});

test("tool usage: questions per tool and in progress; custom processes counted by kind", async () => {
  const added = await api(editToken, "POST", "tools", { name: "Usage board", url_patterns: [{ pattern: "https://usage.example.org/*", item_type: "card" }] });
  const tool = added.json.tools.find((x: any) => x.name === "Usage board");
  assert.deepEqual(tool.usage, { questions: 0, in_progress: 0 });
  const q1 = (await api(editToken, "POST", "questions", { title: "Usage one", process_url: "https://usage.example.org/1" })).json.question;
  await api(editToken, "POST", "questions", { title: "Usage two", process_url: "https://usage.example.org/2" });
  await api(editToken, "PUT", `questions/${q1.id}/fields`, { set: { status: { label: "Being discussed" } } });
  const c = (await api(editToken, "POST", "questions", { title: "Usage three" })).json.question;
  await api(editToken, "PUT", `questions/${c.id}/process`, { custom: { kind: "Garden meeting" } });
  const d = (await api(editToken, "POST", "questions", { title: "Usage four" })).json.question;
  await api(editToken, "PUT", `questions/${d.id}/process`, { custom: { kind: "Garden meeting" } });
  await api(editToken, "POST", `questions/${d.id}/remove`, {});
  const s = (await api(editToken, "GET", "space")).json;
  assert.deepEqual(s.tools.find((x: any) => x.id === tool.id).usage, { questions: 2, in_progress: 1 });
  assert.deepEqual(s.custom_kinds.find((k: any) => k.kind === "Garden meeting"), { kind: "Garden meeting", questions: 1, in_progress: 0 }, "removed questions don't count");
  await api(editToken, "POST", `questions/${d.id}/restore`);
});

test("relate existing questions: shown on both, removable", async () => {
  const a = (await api(editToken, "POST", "questions", { title: "Relation A" })).json.question;
  const b = (await api(editToken, "POST", "questions", { title: "Relation B" })).json.question;
  const r = await api(editToken, "POST", `questions/${a.id}/related`, { id: b.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.related.map((x: any) => [x.id, x.direction]), [[b.id, "to"]]);
  const fromB = (await api(editToken, "GET", `questions/${b.id}`)).json;
  assert.deepEqual(fromB.related.map((x: any) => [x.id, x.direction]), [[a.id, "from"]]);
  assert.equal((await api(editToken, "POST", `questions/${b.id}/related`, { id: a.id })).status, 409);
  const listed = await api(editToken, "GET", `questions?related=${b.id}`);
  assert.deepEqual(listed.json.questions.map((x: any) => x.id), [a.id]);
  const del = await api(editToken, "DELETE", `questions/${b.id}/related/${a.id}`);
  assert.equal(del.json.related.length, 0);
});

test("search, filters and duplicate hints", async () => {
  await api(editToken, "POST", "questions", { title: "How do newcomers find a first task?", why_it_matters: "Onboarding" });
  const s = await api(editToken, "GET", "questions?q=newcomers");
  assert.ok(s.json.questions.length >= 1);
  assert.ok(s.json.questions[0].activity_at);
  const byWhy = await api(editToken, "GET", "questions?q=onboarding");
  assert.ok(byWhy.json.questions.length >= 1);
  const sim = await api(editToken, "GET", `similar?title=${encodeURIComponent("how can newcomers find a task")}`);
  assert.ok(sim.json.similar.some((x: any) => x.title.startsWith("How do newcomers")));
  const noProc = await api(editToken, "GET", "questions?has_process=no&status=not_started,open");
  assert.ok(noProc.json.questions.length && noProc.json.questions.every((q: any) => !q.process && ["not_started", "open"].includes(q.status)));
  const typed = await api(editToken, "GET", "questions?source=typed");
  assert.ok(typed.json.questions.length && typed.json.questions.every((q: any) => q.fields.status.source === "typed"));
  const old = await api(editToken, "GET", "questions?source=manual");
  assert.equal(old.json.questions.length, typed.json.questions.length, "older name still accepted");
});

test("fields via the API: typed values with a note, views with their source; labels editable in settings", async () => {
  const q = (await api(editToken, "POST", "questions", { title: "Status via API" })).json.question;
  assert.equal(q.status_label, "Not started");
  assert.deepEqual(q.fields.status, { value: { state: "not_started", label: "Not started" }, source: "typed", by: "Ana", at: q.created_at, retrievable: false });
  const set = await api(editToken, "PUT", `questions/${q.id}/fields`, { set: { status: { label: "Agreed" }, end: "2026-01-09" }, note: "At the meeting" });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.question.status, "accepted");
  assert.equal(set.json.question.fields.end.value, "2026-01-09");
  assert.equal(set.json.activity[0].action, "question.fields_changed");
  assert.equal(set.json.activity[0].data.note, "At the meeting");
  assert.equal((await api(editToken, "PUT", `questions/${q.id}/fields`, { use_retrieved: ["status"] })).status, 400);
  assert.equal((await api(viewToken, "PUT", `questions/${q.id}/fields`, { set: { summary: "x" } })).status, 403);
  for (const gone of ["status", "dates"]) assert.equal((await api(editToken, "PUT", `questions/${q.id}/${gone}`, {})).status, 404, gone);
  const labels = [...(await api(editToken, "GET", "space")).json.space.settings.status_labels, { label: "Waiting for budget", state: "open" }];
  const saved = await api(editToken, "PUT", "settings/status-labels", { status_labels: labels });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.space.settings.status_labels.at(-1).label, "Waiting for budget");
  assert.equal((await api(viewToken, "PUT", "settings/status-labels", { status_labels: labels })).status, 403);
  assert.equal((await api(editToken, "PUT", "settings/status-labels", { status_labels: [] })).status, 400);
});

test("custom process via the API: no link needed, fields typed", async () => {
  const q = (await api(editToken, "POST", "questions", { title: "Unconference topic?" })).json.question;
  const r = await api(editToken, "PUT", `questions/${q.id}/process`, { kind: "Unconference" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.question.process.tool_id, "custom");
  assert.deepEqual(r.json.question.fields.kind, { value: "Unconference", source: "typed", by: "Ana", at: r.json.question.fields.kind.at, retrievable: false });
  assert.equal(r.json.tool, undefined);
  const m = await api(editToken, "PUT", `questions/${q.id}/fields`, { set: { status: { label: "Done" }, summary: "Notes published" } });
  assert.equal(m.json.question.status, "concluded");
  assert.equal((await api(editToken, "POST", `questions/${q.id}/process/manual`, { state: "open" })).status, 404, "old endpoint gone");
});

test("tools in the space payload show the effective fetch mode (Metaculus without a token is by hand)", async () => {
  const tools = (await api(editToken, "GET", "space")).json.tools;
  const meta = tools.find((x: any) => x.id === "metaculus");
  assert.equal(meta.fetch_mode, "manual");
  assert.equal(meta.auto_unavailable, true);
  assert.equal(tools.find((x: any) => x.id === "loomio").fetch_mode, "auto");
});

test("duplicates and removal via the API", async () => {
  const a = (await api(editToken, "POST", "questions", { title: "Unique title here" })).json.question;
  const dup = await api(editToken, "POST", "questions", { title: "unique TITLE here!" });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "duplicate_title");
  assert.equal(dup.json.error.details.existing.id, a.id);
  const rm = await api(editToken, "POST", `questions/${a.id}/remove`, { reason: "mistake" });
  assert.ok(rm.json.question.removed_at);
  assert.equal((await api(editToken, "PATCH", `questions/${a.id}`, { title: "x" })).status, 409, "read-only while removed");
  assert.equal((await api(editToken, "GET", "space")).json.counts.removed, 1);
  assert.ok(!(await api(editToken, "GET", "questions")).json.questions.some((q: any) => q.id === a.id));
  assert.equal((await api(editToken, "GET", "questions?removed=only")).json.questions[0].id, a.id);
  assert.equal((await api(viewToken, "POST", `questions/${a.id}/restore`)).status, 403);
  const back = await api(editToken, "POST", `questions/${a.id}/restore`);
  assert.equal(back.json.question.removed_at, undefined);
});

test("add a Consul instance as a tool: patterns generated, fetched automatically; Decidim is listed already", async () => {
  const bad = await api(editToken, "POST", "tools", { kind: "consul", base_url: "http://decide.example.es" });
  assert.equal(bad.status, 400);
  const r = await api(editToken, "POST", "tools", { kind: "consul", base_url: "https://decide.example.es/" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tool = r.json.tools.find((x: any) => x.adapter === "consul");
  assert.equal(tool.name, "Consul Democracy (decide.example.es)");
  assert.match(tool.description, /participatory budgets/, "default description");
  assert.equal(tool.fetch_mode, "auto");
  assert.ok(tool.url_patterns.some((p: any) => p.pattern === "https://decide.example.es/proposals/:id{/*}?"));
  const preview = await api(editToken, "POST", "resolve-url", { url: "https://decide.example.es/proposals/42-mas-arboles" });
  assert.equal(preview.json.tool_id, tool.id);
  assert.equal(preview.json.item_type, "proposal");
  assert.equal((await api(editToken, "PATCH", `tools/${tool.id}`, { name: "x", url_patterns: [{ pattern: "https://x.org/*", item_type: "x" }] })).status, 400, "automatic: not editable");
  assert.ok(r.json.tools.some((x: any) => x.id === "decidim" && x.fetch_mode === "auto"));
});

test("removed decision endpoints are gone", async () => {
  const q = (await api(editToken, "POST", "questions", { title: "Old endpoints" })).json.question;
  for (const a of ["adopt", "park", "object", "confirm"]) assert.equal((await api(editToken, "POST", `questions/${q.id}/${a}`, {})).status, 404, a);
});

test("export contains everything; feed works; activity readable", async () => {
  const ex = await api(viewToken, "GET", "export");
  assert.equal(ex.json.format, "question-register/v5");
  assert.ok(ex.json.questions.length > 0);
  assert.ok(ex.json.tools.length >= 6);
  assert.ok(ex.json.activity.length > 0);
  assert.ok(!JSON.stringify(ex.json).includes("token_hash"));
  const feed = await fetchLocal(`/feed/${viewToken}.atom`);
  assert.equal(feed.status, 200);
  assert.match(await feed.text(), /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  const act = await api(viewToken, "GET", "activity?limit=5");
  assert.equal(act.json.activity.length, 5);
});

test("link rotation invalidates the old link and is logged", async () => {
  const fresh = rotateLink(t.ctx, space.id, "view");
  assert.equal((await api(viewToken, "GET", "space")).status, 404);
  assert.equal((await api(fresh, "GET", "space")).json.role, "view");
  const act = await api(editToken, "GET", "activity?limit=1");
  assert.equal(act.json.activity[0].action, "link.rotated");
});

test("dashboard: totals, tools, answered questions, weeks, streak, people, milestones", async () => {
  const t2 = makeCtx();
  const sp = makeSpace(t2.ctx);
  const call = async (method: string, path: string, body?: unknown, name = "Ana") => {
    const headers: Record<string, string> = { "x-actor-name": encodeURIComponent(name) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await route(t2.ctx, { method, url: `/api/s/${sp.editToken}/${path}`, headers, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) });
    return JSON.parse(r.body.toString());
  };
  const a = await call("POST", "questions", { title: "Which license for the docs?", process: { kind: "Monthly meeting" } });
  await call("POST", "questions", { title: "Where do we meet?" }, "Ben");
  t2.advance(3 * 24 * 3600_000);
  await call("PUT", `questions/${a.question.id}/fields`, { set: { status: { label: "Agreed" } } }, "Ben");

  const d = await call("GET", `dashboard?you=ben&since=${encodeURIComponent("2000-01-01")}`);
  assert.equal(d.totals.questions, 2);
  assert.equal(d.totals.answered, 1);
  assert.equal(d.totals.without_process, 1);
  assert.equal(d.by_status.accepted, 1);
  assert.deepEqual(d.tools.map((x: any) => [x.name, x.questions, x.ended]), [["Monthly meeting", 1, 1]]);
  assert.equal(d.days_to_answer, 3);
  assert.equal(d.recent_answers[0].title, "Which license for the docs?");
  assert.equal(d.weekly.length, 12);
  assert.equal(d.weekly.reduce((n: number, w: any) => n + w.added, 0), 2);
  assert.equal(d.weekly.reduce((n: number, w: any) => n + w.answered, 0), 1);
  assert.equal(d.days.length, 84);
  assert.ok(d.streak.current >= 1);
  assert.equal(d.you.name, "Ben", "matched case-insensitively");
  assert.deepEqual([d.you.added, d.you.answered, d.you.actions], [1, 1, 2]);
  assert.deepEqual(d.people.map((p: any) => p.name).sort(), ["Ana", "Ben"]);
  assert.equal(d.since.changed, 2);
  assert.ok(d.milestones.find((m: any) => m.id === "first").done);
  assert.ok(!d.milestones.find((m: any) => m.id === "ten").done);
  assert.equal((await call("GET", "dashboard")).you, null);

  // Removed questions don't count.
  await call("POST", `questions/${a.question.id}/remove`, { reason: "test" });
  const after = await call("GET", "dashboard");
  assert.equal(after.totals.questions, 1);
  assert.equal(after.totals.answered, 0);
});
