import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeCtx, makeSpace, fixture, GH_PR, GH_PR_API } from "./helpers.ts";
import * as Q from "../src/questions.ts";
import * as P from "../src/processes.ts";
import * as repo from "../src/repo.ts";
import { MIGRATIONS, openDb } from "../src/db.ts";
import { setStatusLabels } from "../src/rules.ts";
import { tick } from "../src/scheduler.ts";
import { list } from "../src/search.ts";

const openPr = () => ({ body: fixture("github_pr_open.json") });
const mergedPr = () => ({ body: fixture("github_pr_merged.json") });
const actions = (ctx: any, spaceId: string, qid: string) => repo.listActivity(ctx.db, spaceId, { questionId: qid }).map((e) => e.action);

test("create: title required; no process → Not started, set by hand; logged", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "  " }), /Title is required/);
  const q = await Q.create(ctx, space, "Ana", { title: "Should we?", why_it_matters: "Because" });
  assert.equal(q.status, "not_started");
  assert.equal(q.status_source, "manual");
  assert.equal(q.status_label, "Not started");
  assert.deepEqual(actions(ctx, space.id, q.id), ["question.created"]);
});

test("create with a hand-set status, by label or category; unknown labels refused", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "A", status: { label: "being DISCUSSED" } });
  assert.equal(a.status, "open");
  assert.equal(a.status_label, "Being discussed");
  const b = await Q.create(ctx, space, "Ana", { title: "B", status: { state: "rejected" } });
  assert.equal(b.status_label, "Not agreed");
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "C", status: { label: "Nope" } }), /Unknown status/);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "C", status: { state: "unknown" } }), /Choose a status/);
});

test("a question with a process follows it: GitHub PR open → In progress, merged → Accepted (logged as system)", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, GH_PR);
  assert.ok(preview.matched && preview.title, "title for pre-fill");
  const q = await Q.create(t.ctx, space, "Ana", { title: preview.matched ? preview.title! : "x", process_url: GH_PR });
  assert.equal(q.status_source, "process");
  assert.equal(q.status, "open");
  assert.equal(q.status_label, undefined);

  t.routes[GH_PR_API] = mergedPr();
  t.advance(16 * 60_000);
  await tick(t.ctx);
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.status, "accepted");
  const ev = repo.listActivity(t.ctx.db, space.id, { questionId: q.id }).find((e) => e.action === "question.status_changed")!;
  assert.equal(ev.actor, "system");
  assert.deepEqual(ev.data, { from: "open", to: "accepted", source: "process" });
});

test("set by hand stops following; switching back copies the process state", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  let q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  Q.setStatus(t.ctx, space, q, "Ben", { source: "manual", label: "Agreed", note: "Agreed at the meeting already" });
  t.routes[GH_PR_API] = { body: { ...fixture("github_pr_closed_unmerged.json") } };
  t.advance(16 * 60_000);
  await tick(t.ctx);
  q = Q.load(t.ctx, space, q.id);
  assert.equal(q.status, "accepted", "hand-set status wins");
  assert.equal(q.process?.fetched?.state, "rejected", "the process is still refreshed");
  Q.setStatus(t.ctx, space, q, "Ben", { source: "process" });
  assert.equal(Q.load(t.ctx, space, q.id).status, "rejected");
  const noProcess = await Q.create(t.ctx, space, "Ana", { title: "No process" });
  assert.throws(() => Q.setStatus(t.ctx, space, noProcess, "Ana", { source: "process" }), /Link a process first/);
});

test("removing the process keeps the status, now set by hand with the space's label", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  P.removeProcess(t.ctx, space, q, "Ana");
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.process, undefined);
  assert.equal(r.status, "open");
  assert.equal(r.status_source, "manual");
  assert.equal(r.status_label, "Being discussed");
});

test("attaching a process to a hand-set question makes it follow the process", async () => {
  const t = makeCtx({ [GH_PR_API]: mergedPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", status: { label: "Being discussed" } });
  const r = await Q.attachProcess(t.ctx, space, q, "Ben", { url: GH_PR });
  assert.equal(r.status_source, "process");
  assert.equal(r.status, "accepted");
});

test("custom process: kind required, link optional (https only), state from the space's labels; the question follows", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "Q", process: { custom: {} } }), /Kind of process is required/);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "Q", process: { custom: { kind: "Meeting", url: "http://x.org" } } }), /https/);
  const q = await Q.create(ctx, space, "Ana", {
    title: "Budget?",
    process: { custom: { kind: "General assembly", title: "Spring assembly", when: "2026-03-01T18:00:00Z" }, framing: "Members present vote" },
  });
  assert.equal(q.process?.tool_id, "custom");
  assert.equal(q.process?.url, undefined);
  assert.equal(q.process?.item_type, "General assembly");
  assert.equal(q.process?.fetched?.title, "Spring assembly");
  assert.equal(q.process?.fetched?.dates?.opens_at, "2026-03-01T18:00:00.000Z");
  assert.equal(q.status, "not_started");
  P.manualUpdate(ctx, q, "Ben", { state: "accepted", raw_state: "Agreed", outcome_summary: "41 for, 3 against" });
  const r = Q.load(ctx, space, q.id);
  assert.equal(r.status, "accepted");
  assert.equal(r.process?.fetched?.dates?.opens_at, "2026-03-01T18:00:00.000Z", "date kept on update");
});

test("manual tool: page title pre-filled; state set by anyone; question follows", async () => {
  const url = "https://www.kialo.com/should-we-x-1234";
  const t = makeCtx({ [url]: { body: `<html><head><meta property="og:title" content="Should we do X? &amp; why"><title>Kialo</title></head></html>`, headers: { "content-type": "text/html" } } });
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, url);
  assert.ok(preview.matched);
  assert.equal(preview.matched && preview.title, "Should we do X? & why");
  assert.equal(preview.matched && preview.fetch_mode, "manual");
  const q = await Q.create(t.ctx, space, "Ana", { title: "X?", process_url: url });
  assert.equal(q.process?.fetched?.title, "Should we do X? & why");
  assert.throws(() => P.manualUpdate(t.ctx, q, "Ben", { state: "unknown" }), /Choose a state/);
  P.manualUpdate(t.ctx, q, "Ben", { state: "open", raw_state: "Open" });
  assert.equal(Q.load(t.ctx, space, q.id).status, "open");
});

test("private Loomio poll: attached, but updated by hand", async () => {
  const url = "https://www.loomio.com/p/Priv4te1/secret";
  const t = makeCtx({ "https://www.loomio.com/api/v1/polls/Priv4te1": { status: 403, body: { error: "Not authorized" } } });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: url });
  assert.equal(q.process?.fetch_mode, "manual");
  assert.match(q.process?.fetched?.fetch_error ?? "", /isn't public/);
  P.manualUpdate(t.ctx, q, "Ana", { state: "accepted", raw_state: "Closed: passed" });
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.status, "accepted");
  assert.equal(r.process?.fetched?.fetch_error, undefined);
});

test("refresh errors keep previous values and back off; ETag 304 keeps state", async () => {
  let n = 0;
  const t = makeCtx({ [GH_PR_API]: () => (n++ === 0 ? { body: fixture("github_pr_open.json"), headers: { etag: '"e1"' } } : { status: 304 }) });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  t.advance(16 * 60_000);
  assert.equal((await P.refreshProcess(t.ctx, q.id)).changed, false);
  t.routes[GH_PR_API] = { status: 500, body: {} };
  t.advance(16 * 60_000);
  const r = await P.refreshProcess(t.ctx, q.id);
  assert.match(r.error!, /HTTP 500/);
  const row = repo.getProcessRow(t.ctx.db, q.id)!;
  assert.equal(row.fetched?.state, "open");
  assert.equal(row.fail_count, 1);
  assert.equal(Q.load(t.ctx, space, q.id).status, "open");
});

test("an item that becomes private switches the process to updating by hand", async () => {
  const url = "https://www.loomio.com/p/irvWwUHt";
  const api = "https://www.loomio.com/api/v1/polls/irvWwUHt";
  const t = makeCtx({ [api]: { body: fixture("loomio_poll_closed.json") } });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: url });
  assert.equal(q.status, "concluded");
  assert.equal(q.process?.fetched?.dates?.updated_at, "2026-09-24T13:59:24.811Z");
  t.routes[api] = { status: 403, body: {} };
  t.advance(2 * 86_400_000);
  await tick(t.ctx);
  const row = repo.getProcessRow(t.ctx.db, q.id)!;
  assert.equal(row.fetch_mode, "manual");
  assert.equal(row.fetched?.state, "concluded", "last known state kept");
  assert.ok(actions(t.ctx, space.id, q.id).includes("process.now_manual"));
});

test("unregistered URL is refused with a tool suggestion", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  await assert.rejects(
    () => Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "https://forum.example.org/t/123" }),
    (e: any) => e.code === "unknown_tool" && e.details.suggestion.pattern === "https://forum.example.org/*",
  );
  await assert.rejects(() => Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "http://github.com/a/b/pull/1" }), /https/);
});

test("status labels: editable per space; need a Not started label; no duplicates", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  assert.throws(() => setStatusLabels(ctx, space, "Ana", [{ label: "Open", state: "open" }]), /Not started/);
  assert.throws(() => setStatusLabels(ctx, space, "Ana", [{ label: "New", state: "not_started" }, { label: "new", state: "open" }]), /twice/);
  assert.throws(() => setStatusLabels(ctx, space, "Ana", [{ label: "New", state: "unknown" }]), /Unknown category/);
  setStatusLabels(ctx, space, "Ana", [
    { label: "To do", state: "not_started" },
    { label: "Waiting for budget", state: "open" },
  ]);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  assert.equal(q.status_label, "To do");
  Q.setStatus(ctx, space, q, "Ana", { label: "Waiting for budget" });
  assert.equal(Q.load(ctx, space, q.id).status, "open");
});

test("relations: directed, shown on both sides, no self, no duplicates either way, duplicate kind, removable", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "A" });
  const b = await Q.create(ctx, space, "Ana", { title: "B", related_id: a.id });
  const c = await Q.create(ctx, space, "Ana", { title: "C" });
  assert.deepEqual(repo.relationsOf(ctx.db, a.id).map((r) => [r.from_id, r.to_id]), [[b.id, a.id]]);
  assert.throws(() => Q.relate(ctx, space, a, "Ana", { id: a.id }), /itself/);
  assert.throws(() => Q.relate(ctx, space, a, "Ana", { id: b.id }), /already related/);
  assert.throws(() => Q.relate(ctx, space, a, "Ana", { id: c.id, kind: "parent" }), /Unknown relation kind/);
  Q.relate(ctx, space, c, "Ben", { id: a.id, kind: "duplicate" });
  assert.equal(repo.relationsOf(ctx.db, a.id).find((r) => r.from_id === c.id)?.kind, "duplicate");
  assert.deepEqual(list(ctx, space, { related: a.id }).map((q) => q.title).sort(), ["B", "C"]);
  Q.unrelate(ctx, space, a, "Ben", c.id);
  assert.equal(repo.relationsOf(ctx.db, c.id).length, 0);
  assert.ok(actions(ctx, space.id, c.id).includes("relation.removed") && actions(ctx, space.id, a.id).includes("relation.removed"));
});

test("list: presets and sort by latest activity (including the platform's)", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const old = await Q.create(t.ctx, space, "Ana", { title: "Old, being discussed", status: { label: "Being discussed" } });
  t.advance(40 * 86_400_000);
  await Q.create(t.ctx, space, "Ana", { title: "Recent" });
  const pr = await Q.create(t.ctx, space, "Ana", { title: "PR", process_url: GH_PR }); // PR updated_at is in 2024: quiet on the platform
  assert.deepEqual(list(t.ctx, space, { preset: "no_process" }).map((q) => q.title).sort(), ["Old, being discussed", "Recent"]);
  assert.deepEqual(list(t.ctx, space, { preset: "quiet" }).map((q) => q.id), [old.id]);
  assert.equal(list(t.ctx, space, {})[0].id, pr.id);
  assert.equal(list(t.ctx, space, { sort: "created" }).at(-1)!.id, old.id);
});

test("activity log is append-only at the storage layer; questions can't be deleted", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  assert.throws(() => ctx.db.exec("UPDATE activity SET actor = 'x'"), /append-only/);
  assert.throws(() => ctx.db.exec("DELETE FROM activity"), /append-only/);
  assert.throws(() => ctx.db.prepare("DELETE FROM questions WHERE id = ?").run(q.id), /never deleted/);
});

test("migration from the v1 decision model: statuses, relations, tools; backup kept", () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-db-"));
  try {
    const path = join(dir, "r.sqlite");
    const v1 = new DatabaseSync(path);
    v1.exec(MIGRATIONS[0] as string);
    v1.exec("PRAGMA user_version = 1");
    v1.exec(`INSERT INTO spaces VALUES ('s','S','2026-01-01','{"active_cap":8}','', 'e', 'v')`);
    v1.exec(`INSERT INTO tools (space_id, id, name, url_patterns_json, fetch_mode, enabled, position) VALUES
      ('s','loomio','Loomio','[]','manual',1,1), ('s','kialo','Kialo','[]','manual',1,2)`);
    const ins = v1.prepare(`INSERT INTO questions (id, space_id, section, title, status, resolution_json, parent_id, duplicate_of_id, resolution_record_json, created_at, created_by, last_activity_at)
      VALUES (?, 's', 'main', ?, ?, '{"mode":"tbd","criteria":[]}', ?, ?, ?, '2026-01-01', 'Ana', '2026-01-01')`);
    ins.run("pool", "Pool", "inbox", null, null, null);
    ins.run("act", "Active, no process", "active", "pool", null, null);
    ins.run("dor", "Dormant", "dormant", null, null, null);
    ins.run("res", "Resolved", "resolved", null, null, JSON.stringify({ outcome: "rejected" }));
    ins.run("res2", "Resolved, no outcome", "resolved", null, null, JSON.stringify({}));
    ins.run("dup", "Dropped dup", "dropped", null, "pool", null);
    ins.run("lp", "Active Loomio", "active", null, null, null);
    v1.exec(`INSERT INTO processes (id, question_id, space_id, url, tool_id, item_type, fetch_mode, fetched_json, created_at)
      VALUES ('p1','lp','s','https://www.loomio.com/p/AbCd1234','loomio','poll','manual','{"state":"open","terminal":false,"fetched_at":"2026-01-01"}','2026-01-01')`);
    v1.exec(`INSERT INTO objections (id, question_id, space_id, raised_by, raised_at, reason) VALUES ('o1','act','s','Ben','2026-01-01','No')`);
    v1.close();

    const db = openDb(path);
    const q = (id: string) => db.prepare("SELECT status, status_source, status_label FROM questions WHERE id = ?").get(id) as any;
    assert.deepEqual({ ...q("pool") }, { status: "not_started", status_source: "manual", status_label: "Not started" });
    assert.deepEqual({ ...q("act") }, { status: "open", status_source: "manual", status_label: "Being discussed" });
    assert.equal(q("dor").status, "not_started");
    assert.deepEqual({ ...q("res") }, { status: "rejected", status_source: "manual", status_label: "Not agreed" });
    assert.equal(q("res2").status, "concluded");
    assert.equal(q("dup").status, "withdrawn");
    assert.deepEqual({ ...q("lp") }, { status: "open", status_source: "process", status_label: null });
    assert.deepEqual(repo.relationsOf(db, "pool").map((r) => [r.from_id, r.to_id, r.kind]).sort(), [["act", "pool", "related"], ["dup", "pool", "duplicate"]]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'objections'").get() as any).n, 0);
    assert.deepEqual(JSON.parse((db.prepare("SELECT settings_json FROM spaces").get() as any).settings_json).status_labels[0], { label: "Not started", state: "not_started" });
    const loomio = db.prepare("SELECT fetch_mode, adapter FROM tools WHERE id = 'loomio'").get() as any;
    assert.deepEqual({ ...loomio }, { fetch_mode: "auto", adapter: "loomio" });
    assert.equal((db.prepare("SELECT fetch_mode FROM processes WHERE id = 'p1'").get() as any).fetch_mode, "auto");
    assert.equal((db.prepare("SELECT fetch_mode FROM tools WHERE id = 'kialo'").get() as any).fetch_mode, "manual");
    assert.ok(existsSync(`${path}.before-v${MIGRATIONS.length}.bak`), "backup written");
    assert.deepEqual({ ...(db.prepare("SELECT fetch_mode, adapter FROM tools WHERE id = 'decidim'").get() as any) }, { fetch_mode: "auto", adapter: "decidim" }, "Decidim added");
    const desc = (id: string) => (db.prepare("SELECT description FROM tools WHERE id = ?").get(id) as any).description;
    assert.match(desc("loomio"), /Group decisions/, "seed descriptions filled");
    assert.match(desc("decidim"), /participation/);
    assert.throws(() => db.prepare("DELETE FROM questions WHERE id = 'pool'").run(), /never deleted/, "trigger recreated");
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as any).foreign_keys, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicates: same title (ignoring case, accents, punctuation) is refused, on create and edit", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "Should we move to Thursdays?" });
  await assert.rejects(
    () => Q.create(ctx, space, "Ben", { title: "  should we MOVE to thursdays " }),
    (e: any) => e.status === 409 && e.code === "duplicate_title" && e.details.existing.id === a.id,
  );
  const b = await Q.create(ctx, space, "Ben", { title: "Should we move to Fridays?" });
  assert.throws(() => Q.edit(ctx, space, b, "Ben", { title: "Should we móve to Thursdays!" }), /already in the register/);
  assert.equal(Q.edit(ctx, space, a, "Ana", { title: "Should we move to Thursdays?!" }).title, "Should we move to Thursdays?!", "its own title is fine");
});

test("duplicates: the same linked item is refused, whatever the URL's form; custom processes aren't checked", async () => {
  const t = makeCtx({
    [GH_PR_API]: openPr(),
    "https://www.loomio.com/api/v1/polls/irvWwUHt": { body: fixture("loomio_poll_closed.json") },
  });
  const { space } = makeSpace(t.ctx);
  const pr = await Q.create(t.ctx, space, "Ana", { title: "PR", process_url: GH_PR });
  for (const url of [`${GH_PR}/`, `${GH_PR}#issuecomment-1`, GH_PR.replace("github.com", "www.github.com")])
    await assert.rejects(() => Q.create(t.ctx, space, "Ben", { title: `Again ${url}`, process_url: url }), (e: any) => e.code === "duplicate_link" && e.details.existing.id === pr.id, url);
  const poll = await Q.create(t.ctx, space, "Ana", { title: "Poll", process_url: "https://www.loomio.com/p/irvWwUHt/some-slug" });
  const other = await Q.create(t.ctx, space, "Ben", { title: "Other" });
  await assert.rejects(() => Q.attachProcess(t.ctx, space, other, "Ben", { url: "https://loomio.com/p/irvWwUHt/another-slug?utm_source=x" }), /already tracked by “Poll”/);
  await Q.attachProcess(t.ctx, space, poll, "Ana", { url: "https://www.loomio.com/p/irvWwUHt" }); // replacing on the same question is fine
  const preview = await P.previewUrl(t.ctx, space, `${GH_PR}/files`);
  assert.deepEqual(preview.matched && preview.existing, { id: pr.id, title: "PR" });
  const meeting = { custom: { kind: "Meeting", url: "https://notes.example.org/assembly" } };
  await Q.create(t.ctx, space, "Ana", { title: "Budget", process: meeting });
  await Q.create(t.ctx, space, "Ana", { title: "Venue", process: meeting }); // one meeting can address several questions
});

test("remove and restore: hidden from lists and checks, read-only, not refreshed, restorable", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Spam?", process_url: GH_PR });
  const keep = await Q.create(t.ctx, space, "Ana", { title: "Keep" });
  Q.relate(t.ctx, space, keep, "Ana", { id: q.id });
  Q.remove(t.ctx, space, q, "Ben", { reason: "Test entry" });
  assert.deepEqual(list(t.ctx, space, {}).map((x) => x.id), [keep.id]);
  assert.deepEqual(list(t.ctx, space, { removed: "only" }).map((x) => x.id), [q.id]);
  assert.deepEqual(list(t.ctx, space, { related: keep.id }), [], "hidden from related lists too");
  assert.equal(repo.dueProcesses(t.ctx.db, "9999").length, 0, "not refreshed");
  assert.throws(() => Q.relate(t.ctx, space, keep, "Ana", { id: q.id }), /not found/);
  assert.throws(() => Q.remove(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", {}), /already removed/);

  // Its title and link are free again…
  const again = await Q.create(t.ctx, space, "Chloé", { title: "spam", process_url: GH_PR });
  // …so restoring conflicts until the new one changes.
  assert.throws(() => Q.restore(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben"), (e: any) => e.code === "duplicate_title");
  Q.remove(t.ctx, space, again, "Chloé", {});
  Q.restore(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben");
  assert.equal(Q.load(t.ctx, space, q.id).removed_at, undefined);
  assert.deepEqual(actions(t.ctx, space.id, q.id).filter((a) => a.startsWith("question.r")), ["question.restored", "question.removed"], "newest first");
  assert.throws(() => t.ctx.db.prepare("DELETE FROM questions WHERE id = ?").run(q.id), /never deleted/);
});
