import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace, DAY } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { tick } from "../src/scheduler.ts";
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

test("M5: propose a manual tool, object, address, accept, then use it", async () => {
  const url = "https://forum.example.org/t/should-we/42";
  const refused = await api(editToken, "POST", "questions", { title: "Forum thread", process_url: url });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.error.code, "unknown_tool");
  const suggestion = refused.json.error.details.suggestion;

  const created = await api(editToken, "POST", "questions", {
    title: "Add our forum to the tool list",
    rules_payload: {
      kind: "add_tool",
      tool: { name: "Our forum", url_patterns: [{ pattern: suggestion.pattern, item_type: "topic" }], state_map: { Open: "open", Closed: "concluded" } },
    },
    adopt: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const q = created.json.question;
  assert.equal(q.section, "rules");
  assert.equal(q.status, "active");
  assert.deepEqual(q.resolution.criteria, [{ kind: "default_rule" }]);

  const obj = await api(editToken, "POST", `questions/${q.id}/object`, { reason: "Is the forum public?" }, "Ben");
  assert.equal(obj.json.objections.length, 1);
  t.advance(8 * DAY);
  await tick(t.ctx);
  assert.equal((await api(editToken, "GET", `questions/${q.id}`)).json.question.pending_resolution, undefined);

  const addr = await api(editToken, "POST", `questions/${q.id}/address`, { objection_id: obj.json.objections[0].id, note: "Yes, it is public" });
  assert.ok(addr.json.question.default_window.ends_at);
  t.advance(8 * DAY);
  await tick(t.ctx);
  const pending = (await api(editToken, "GET", `questions/${q.id}`)).json.question;
  assert.equal(pending.pending_resolution.triggered_by, "default_rule");
  const done = await api(editToken, "POST", `questions/${q.id}/confirm`, { synthesis: "Forum added" });
  assert.equal(done.json.question.status, "resolved");

  const tools = (await api(editToken, "GET", "space")).json.tools;
  const forum = tools.find((x: any) => x.name === "Our forum");
  assert.ok(forum && forum.enabled && forum.added_by_question_id === q.id);

  const used = await api(editToken, "POST", "questions", { title: "Forum thread", process_url: url });
  assert.equal(used.status, 200);
  assert.equal(used.json.question.process.tool_id, forum.id);
  const manual = await api(editToken, "POST", `questions/${used.json.question.id}/process/manual`, { state: "open", raw_state: "Open" });
  assert.equal(manual.json.question.process.fetched.state, "open");
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

test("change charter and settings via a Rules question", async () => {
  const created = await api(editToken, "POST", "questions", {
    title: "Raise the active limit to 10",
    rules_payload: { kind: "change_charter", settings: { active_cap: 10 }, charter_markdown: "# New charter\n\nShort." },
    adopt: true,
  });
  const q = created.json.question;
  t.advance(8 * DAY);
  await tick(t.ctx);
  await api(editToken, "POST", `questions/${q.id}/confirm`, {});
  const s = (await api(editToken, "GET", "space")).json.space;
  assert.equal(s.settings.active_cap, 10);
  assert.equal(s.charter_markdown, "# New charter\n\nShort.");
});

test("rejected Rules proposal applies nothing", async () => {
  const created = await api(editToken, "POST", "questions", {
    title: "Disable Kialo",
    rules_payload: { kind: "set_tool_enabled", tool_id: "kialo", enabled: false },
    adopt: true,
  });
  t.advance(8 * DAY);
  await tick(t.ctx);
  await api(editToken, "POST", `questions/${created.json.question.id}/confirm`, { outcome: "rejected" });
  const tools = (await api(editToken, "GET", "space")).json.tools;
  assert.equal(tools.find((x: any) => x.id === "kialo").enabled, true);
});

test("search, filters and duplicate hints", async () => {
  await api(editToken, "POST", "questions", { title: "How do newcomers find a first task?", why_it_matters: "Onboarding" });
  const s = await api(editToken, "GET", "questions?q=newcomers");
  assert.ok(s.json.questions.length >= 1);
  const byWhy = await api(editToken, "GET", "questions?q=onboarding");
  assert.ok(byWhy.json.questions.length >= 1);
  const sim = await api(editToken, "GET", `similar?title=${encodeURIComponent("how can newcomers find a task")}`);
  assert.ok(sim.json.similar.some((x: any) => x.title.startsWith("How do newcomers")));
  const tbd = await api(editToken, "GET", "questions?preset=criteria_tbd");
  assert.ok(tbd.json.questions.every((q: any) => q.resolution.mode === "tbd"));
  const rules = await api(editToken, "GET", "questions?section=rules");
  assert.ok(rules.json.questions.every((q: any) => q.section === "rules"));
  const noProc = await api(editToken, "GET", "questions?has_process=no&status=inbox");
  assert.ok(noProc.json.questions.every((q: any) => !q.process && q.status === "inbox"));
});

test("export contains everything; feed works; activity readable", async () => {
  const ex = await api(viewToken, "GET", "export");
  assert.equal(ex.json.format, "question-register/v1");
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
