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

test("add a tool directly: no proposal, usable at once, can be disabled", async () => {
  const url = "https://wiki.example.org/t/should-we/7";
  const refused = await api(editToken, "POST", "questions", { title: "Wiki thread", process_url: url });
  assert.equal(refused.json.error.code, "unknown_tool");
  const added = await api(editToken, "POST", "tools", {
    name: "Our wiki",
    url_patterns: [{ pattern: refused.json.error.details.suggestion.pattern, item_type: "topic" }],
    state_map: { Open: "open", Closed: "concluded" },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const wiki = added.json.tools.find((x: any) => x.name === "Our wiki");
  assert.ok(wiki && wiki.enabled && !wiki.added_by_question_id);
  const used = await api(editToken, "POST", "questions", { title: "Wiki thread", process_url: url });
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
    state_map: { Todo: "not_started", Done: "concluded" },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const after = edited.json.tools.find((x: any) => x.id === board.id);
  assert.equal(after.name, "Our board");
  assert.equal(after.url_patterns[0].pattern, "https://board.example.org/c/:id");
  assert.deepEqual(after.state_map, { Todo: "not_started", Done: "concluded" });
  const gh = await api(editToken, "PATCH", "tools/github", { name: "x", url_patterns: [{ pattern: "https://x.org/*", item_type: "x" }] });
  assert.equal(gh.status, 400);
  const view = await api(viewToken, "PATCH", `tools/${board.id}`, { name: "x" });
  assert.equal(view.status, 403);
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
  const manual = await api(editToken, "GET", "questions?source=manual");
  assert.ok(manual.json.questions.every((q: any) => q.status_source === "manual"));
});

test("status: set by hand via the API, labels editable in settings", async () => {
  const q = (await api(editToken, "POST", "questions", { title: "Status via API" })).json.question;
  assert.equal(q.status_label, "Not started");
  const set = await api(editToken, "PUT", `questions/${q.id}/status`, { source: "manual", label: "Agreed", note: "At the meeting" });
  assert.equal(set.json.question.status, "accepted");
  assert.equal(set.json.activity[0].data.note, "At the meeting");
  assert.equal((await api(editToken, "PUT", `questions/${q.id}/status`, { source: "process" })).status, 400);
  const labels = [...(await api(editToken, "GET", "space")).json.space.settings.status_labels, { label: "Waiting for budget", state: "open" }];
  const saved = await api(editToken, "PUT", "settings/status-labels", { status_labels: labels });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.space.settings.status_labels.at(-1).label, "Waiting for budget");
  assert.equal((await api(viewToken, "PUT", "settings/status-labels", { status_labels: labels })).status, 403);
  assert.equal((await api(editToken, "PUT", "settings/status-labels", { status_labels: [] })).status, 400);
});

test("custom process via the API: no link needed, state set by hand", async () => {
  const q = (await api(editToken, "POST", "questions", { title: "Unconference topic?" })).json.question;
  const r = await api(editToken, "PUT", `questions/${q.id}/process`, { custom: { kind: "Unconference", title: "Autumn unconference" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.question.process.tool_id, "custom");
  assert.equal(r.json.question.status_source, "process");
  assert.equal(r.json.tool, undefined);
  const m = await api(editToken, "POST", `questions/${q.id}/process/manual`, { state: "concluded", raw_state: "Done", outcome_summary: "Notes published" });
  assert.equal(m.json.question.status, "concluded");
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
  assert.equal(ex.json.format, "question-register/v3");
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
