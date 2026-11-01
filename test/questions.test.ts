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
import { fieldViews } from "../src/fields.ts";
import { tick } from "../src/scheduler.ts";
import { list } from "../src/search.ts";
import { setCharter } from "../src/spaces.ts";
import { arrange } from "../src/relations.ts";

const openPr = () => ({ body: fixture("github_pr_open.json") });
const mergedPr = () => ({ body: fixture("github_pr_merged.json") });
const actions = (ctx: any, spaceId: string, qid: string) => repo.listActivity(ctx.db, spaceId, { questionId: qid }).map((e) => e.action);

const src = (q: any, f: string) => fieldViews(q)[f as keyof ReturnType<typeof fieldViews>].source;

test("create: title required; no process → everything typed, Not started; logged", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "  " }), /Title is required/);
  const q = await Q.create(ctx, space, "Ana", { title: "Should we?", why_it_matters: "Because" });
  assert.equal(q.status, "not_started");
  assert.equal(q.status_label, "Not started");
  assert.deepEqual([src(q, "title"), src(q, "status"), q.typed.title?.by], ["typed", "typed", "Ana"]);
  assert.deepEqual(actions(ctx, space.id, q.id), ["question.created"]);
});

test("create with a typed status, by label or category; unknown labels refused", async () => {
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

test("a linked item's fields are retrieved: GitHub PR open → In progress, merged → Accepted (logged as system)", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, GH_PR);
  assert.ok(preview.matched && preview.title, "title for pre-fill");
  const q = await Q.create(t.ctx, space, "Ana", { title: preview.matched ? preview.title! : "x", process_url: GH_PR });
  assert.deepEqual([src(q, "title"), src(q, "kind"), src(q, "status"), src(q, "start")], ["retrieved", "retrieved", "retrieved", "retrieved"], "same title as retrieved: not typed");
  assert.equal(q.status, "open");
  assert.equal(q.status_label, undefined);
  assert.equal(fieldViews(q).status.as, "open", "the platform's word");

  t.routes[GH_PR_API] = mergedPr();
  t.advance(16 * 60_000);
  await tick(t.ctx);
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.status, "accepted");
  assert.equal(r.title, fixture("github_pr_merged.json").title, "a retrieved title follows the item");
  const ev = repo.listActivity(t.ctx.db, space.id, { questionId: q.id }).find((e) => e.action === "question.status_changed")!;
  assert.equal(ev.actor, "system");
  assert.deepEqual(ev.data, { from: "open", to: "accepted", source: "retrieved" });
});

test("a title rewritten at creation is typed, and stays when the item's title changes", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Should CI upgrade upload-artifact?", process_url: GH_PR });
  assert.equal(src(q, "title"), "typed");
  assert.equal(fieldViews(q).title.retrieved, fixture("github_pr_open.json").title);
  Q.updateFields(t.ctx, space, q, "Ben", { use_retrieved: ["title"] });
  assert.equal(Q.load(t.ctx, space, q.id).title, fixture("github_pr_open.json").title);
});

test("typing a value wins over the retrieved one; use_retrieved goes back; logged with before/after", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  let q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  Q.updateFields(t.ctx, space, q, "Ben", { set: { status: { label: "Agreed" }, summary: "Agreed at the meeting" }, note: "Agreed at the meeting already" });
  t.routes[GH_PR_API] = { body: { ...fixture("github_pr_closed_unmerged.json") } };
  t.advance(16 * 60_000);
  await tick(t.ctx);
  q = Q.load(t.ctx, space, q.id);
  assert.equal(q.status, "accepted", "typed status wins");
  assert.deepEqual(fieldViews(q).status.retrieved, { state: "rejected" }, "the retrieved one is still there");
  const log = repo.listActivity(t.ctx.db, space.id, { questionId: q.id }).find((e) => e.action === "question.fields_changed")!;
  assert.deepEqual((log.data.fields as any).status, { before: { source: "retrieved" }, after: { source: "typed", value: { state: "accepted", label: "Agreed" } } });
  assert.equal(log.data.note, "Agreed at the meeting already");
  Q.updateFields(t.ctx, space, q, "Ben", { use_retrieved: ["status"] });
  assert.equal(Q.load(t.ctx, space, q.id).status, "rejected");
  const noProcess = await Q.create(t.ctx, space, "Ana", { title: "No process" });
  assert.throws(() => Q.updateFields(t.ctx, space, noProcess, "Ana", { use_retrieved: ["status"] }), /can't be retrieved/);
  assert.throws(() => Q.updateFields(t.ctx, space, noProcess, "Ana", { set: { kind: "Meeting" } }), /Link a process first/);
  assert.throws(() => Q.updateFields(t.ctx, space, noProcess, "Ana", { set: { colour: "red" } as any }), /Unknown field/);
});

test("removing the process keeps the title and status, now typed; the typed kind goes", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  Q.updateFields(t.ctx, space, q, "Ana", { set: { kind: "Code change", end: "2099-02-01" } });
  P.removeProcess(t.ctx, space, Q.load(t.ctx, space, q.id), "Ana");
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.process, undefined);
  assert.deepEqual([r.status, r.status_label, src(r, "status"), src(r, "title")], ["open", "Being discussed", "typed", "typed"]);
  assert.equal(r.typed.kind, undefined);
  assert.equal(r.typed.end?.value, "2099-02-01", "typed dates stay");
});

test("linking a retrievable item makes the status follow it; a kind typed with the old process goes", async () => {
  const t = makeCtx({ [GH_PR_API]: mergedPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", status: { label: "Being discussed" }, process: { kind: "Meeting" } });
  assert.equal(q.typed.kind?.value, "Meeting");
  const r = await Q.attachProcess(t.ctx, space, q, "Ben", { url: GH_PR });
  assert.deepEqual([src(r, "status"), r.status, r.typed.kind, src(r, "title")], ["retrieved", "accepted", undefined, "typed"]);
});

test("first link keeps what is typed (summary, results, dates)", async () => {
  const t = makeCtx({ [GH_PR_API]: mergedPr() });
  const { space } = makeSpace(t.ctx);
  const a = await Q.create(t.ctx, space, "Ana", { title: "A", fields: { summary: "Mine", results_url: "Notes", start: "2099-01-01" } });
  const ra = await Q.attachProcess(t.ctx, space, a, "Ben", { url: GH_PR });
  assert.deepEqual([ra.typed.summary?.value, ra.typed.results_url?.value, ra.typed.start?.value], ["Mine", "Notes", "2099-01-01"]);
  assert.equal(src(ra, "status"), "retrieved", "the default status counts as unset");
});

test("a typed kind survives linking an unlisted site (nothing retrieves it); replacing a listed link drops summary and results", async () => {
  const t = makeCtx({ [GH_PR_API]: mergedPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process: { kind: "Meeting" } });
  const r = await Q.attachProcess(t.ctx, space, q, "Ben", { url: "https://forum.example.org/t/42" });
  assert.deepEqual([r.process?.tool_id, r.typed.kind?.value], ["custom", "Meeting"]);
  const g = await Q.attachProcess(t.ctx, space, r, "Ben", { url: GH_PR });
  Q.updateFields(t.ctx, space, g, "Ben", { set: { summary: "x", results_url: "y", end: "2099-02-01" } });
  const again = await Q.attachProcess(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { url: GH_PR });
  assert.deepEqual([again.typed.summary, again.typed.results_url, again.typed.end?.value], [undefined, undefined, "2099-02-01"]);
});

test("custom process: no link needs a kind; any https link is accepted; its fields are typed", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "Q", process: { custom: {} } }), /kind of process/);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "Q", process: { kind: "Meeting", url: "http://x.org" } }), /https/);
  const q = await Q.create(ctx, space, "Ana", { title: "Budget?", process: { kind: "General assembly" } });
  assert.deepEqual([q.process?.tool_id, q.process?.url, q.process?.item_type, q.typed.kind?.value], ["custom", undefined, "", "General assembly"]);
  const v = fieldViews(q);
  assert.deepEqual([v.status.source, v.status.retrievable, v.kind.retrievable], ["typed", false, false]);
  Q.updateFields(ctx, space, q, "Ben", { set: { status: { label: "Agreed" }, summary: "41 for, 3 against" } });
  assert.equal(Q.load(ctx, space, q.id).status, "accepted");
  // A site that isn't on the tool list: accepted, nothing retrieved.
  const other = await Q.create(ctx, space, "Ana", { title: "Forum thread", process_url: "https://forum.example.org/t/42" });
  assert.deepEqual([other.process?.tool_id, other.process?.url, src(other, "title")], ["custom", "https://forum.example.org/t/42", "typed"]);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { process_url: "https://forum.example.org/t/43" }), /Title is required/, "nothing retrieved: a title is needed");
});

test("tool updated by hand: kind and page title retrieved; status typed", async () => {
  const url = "https://www.kialo.com/should-we-x-1234";
  const t = makeCtx({ [url]: { body: `<html><head><meta property="og:title" content="Should we do X? &amp; why"><title>Kialo</title></head></html>`, headers: { "content-type": "text/html" } } });
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, url);
  assert.ok(preview.matched);
  assert.equal(preview.matched && preview.title, "Should we do X? & why");
  assert.equal(preview.matched && preview.fetch_mode, "manual");
  const q = await Q.create(t.ctx, space, "Ana", { process_url: url });
  assert.equal(q.title, "Should we do X? & why", "no title given: the retrieved one");
  const v = fieldViews(q);
  assert.deepEqual([v.title.source, v.kind.source, v.kind.value, v.status.source, v.status.retrievable], ["retrieved", "retrieved", "discussion", "typed", false]);
  Q.updateFields(t.ctx, space, q, "Ben", { set: { status: { label: "Being discussed" } } });
  assert.equal(Q.load(t.ctx, space, q.id).status, "open");
});

test("private Loomio poll: attached; only kind and title can be retrieved, status typed", async () => {
  const url = "https://www.loomio.com/p/Priv4te1/secret";
  const t = makeCtx({ "https://www.loomio.com/api/v1/polls/Priv4te1": { status: 403, body: { error: "Not authorized" } } });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: url });
  assert.equal(q.process?.fetch_mode, "manual");
  assert.match(q.process?.fetched?.fetch_error ?? "", /isn't public/);
  assert.equal(src(q, "status"), "typed");
  Q.updateFields(t.ctx, space, q, "Ana", { set: { status: { label: "Agreed" } } });
  assert.equal(Q.load(t.ctx, space, q.id).status, "accepted");
});

test("an item that becomes private: its status is kept, now typed", async () => {
  const api = "https://www.loomio.com/api/v1/polls/irvWwUHt";
  const t = makeCtx({ [api]: { body: fixture("loomio_poll_closed.json") } });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "https://www.loomio.com/p/irvWwUHt" });
  assert.equal(src(q, "status"), "retrieved");
  t.routes[api] = { status: 403, body: { error: "Not authorized" } };
  t.advance(25 * 60 * 60_000);
  await P.refreshProcess(t.ctx, q.id);
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.process?.fetch_mode, "manual");
  assert.deepEqual([src(r, "status"), r.status], ["typed", q.status]);
  assert.ok(r.status_label, "with the space's label");
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

test("unregistered URL: previewed with a tool suggestion, accepted as a custom process", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, "https://forum.example.org/t/123");
  assert.deepEqual(preview, { matched: false, suggestion: { name: "forum.example.org", pattern: "https://forum.example.org/*" } });
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "https://forum.example.org/t/123" });
  assert.equal(q.process?.tool_id, "custom");
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
  Q.updateFields(ctx, space, q, "Ana", { set: { status: { label: "Waiting for budget" } } });
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

test("hierarchy: child_of / parent_of, several parents allowed, loops refused (direct or through the chain), removed ones count", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const mk = (title: string, extra: object = {}) => Q.create(ctx, space, "Ana", { title, ...extra });
  const A = await mk("A"), B = await mk("B"), C = await mk("C"), D = await mk("D");
  Q.relate(ctx, space, B, "Ana", { id: A.id, kind: "child_of" }); // B is a child of A
  Q.relate(ctx, space, B, "Ana", { id: C.id, kind: "parent_of" }); // B is the parent of C
  assert.deepEqual(repo.relationsOf(ctx.db, B.id).map((r) => [r.from_id, r.to_id, r.kind]), [[B.id, A.id, "child_of"], [C.id, B.id, "child_of"]], "stored as child → parent");
  // A → B → C: making A a child of C (or of B) would close a loop.
  assert.throws(() => Q.relate(ctx, space, A, "Ana", { id: C.id, kind: "child_of" }), (e: any) => e.code === "hierarchy_loop" && /“C” is already below “A”.*“C” → “B” → “A”/.test(e.message));
  assert.throws(() => Q.relate(ctx, space, C, "Ana", { id: A.id, kind: "parent_of" }), (e: any) => e.code === "hierarchy_loop");
  assert.throws(() => Q.relate(ctx, space, A, "Ana", { id: B.id, kind: "child_of" }), /already related/, "the pair is related already");
  // A second parent is fine, as long as it's no loop.
  Q.relate(ctx, space, C, "Ana", { id: D.id, kind: "child_of" });
  assert.deepEqual(repo.relationsOf(ctx.db, C.id).filter((r) => r.from_id === C.id).map((r) => r.to_id).sort(), [B.id, D.id].sort());
  // …but a loop is a loop even through a removed question.
  Q.remove(ctx, space, Q.load(ctx, space, B.id), "Ana", {});
  assert.throws(() => Q.relate(ctx, space, A, "Ana", { id: C.id, kind: "child_of" }), (e: any) => e.code === "hierarchy_loop" && /“B”/.test(e.message));
  // Duplicates read from either side.
  Q.relate(ctx, space, D, "Ana", { id: A.id, kind: "duplicated_by" });
  assert.equal(repo.relationsOf(ctx.db, D.id).find((r) => r.kind === "duplicate")?.from_id, A.id, "A duplicates D");
  // The log says it from each side.
  const ev = repo.listActivity(ctx.db, space.id, { questionId: C.id }).find((e) => e.action === "relation.added" && (e.data as any).to_id === D.id)!;
  const data = ev.data as any;
  assert.deepEqual([data.kind, data.from_id, data.other_title], ["child_of", C.id, "D"]);
});

test("create with a relation: the new question is a child of / the parent of / a duplicate of the other", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const root = await Q.create(ctx, space, "Ana", { title: "Root" });
  const kid = await Q.create(ctx, space, "Ana", { title: "Kid", related_id: root.id, related_kind: "child_of" });
  const top = await Q.create(ctx, space, "Ana", { title: "Top", related_id: root.id, related_kind: "parent_of" });
  const dup = await Q.create(ctx, space, "Ana", { title: "Dup", related_id: root.id, related_kind: "duplicate_of" });
  const rel = (q: { id: string }) => repo.relationsOf(ctx.db, q.id).map((r) => [r.from_id, r.to_id, r.kind]);
  assert.deepEqual(rel(kid), [[kid.id, root.id, "child_of"]]);
  assert.deepEqual(rel(top), [[root.id, top.id, "child_of"]]);
  assert.deepEqual(rel(dup), [[dup.id, root.id, "duplicate"]]);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "X", related_id: root.id, related_kind: "sibling" }), /Unknown relation kind/);
});

test("arrange: children under their first parent present in the list; a hidden parent leaves the child at the top", () => {
  const rel = (from: string, to: string, at: string) => ({ from_id: from, to_id: to, kind: "child_of" as const, created_at: at, created_by: "Ana" });
  const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  // c is a child of b and a (b first); d of c; e of a missing question.
  const rels = [rel("c", "b", "1"), rel("c", "a", "2"), rel("d", "c", "3"), rel("e", "gone", "4")];
  assert.deepEqual(
    arrange(items, rels).map((i) => [i.id, i.depth, i.parent_id]),
    [["a", 0, undefined], ["b", 0, undefined], ["c", 1, "b"], ["d", 2, "c"], ["e", 0, undefined]],
  );
  assert.deepEqual(arrange(items.filter((i) => i.id !== "b"), rels).map((i) => [i.id, i.depth]), [["a", 0], ["c", 1], ["d", 2], ["e", 0]], "c moves under its other parent");
  assert.deepEqual(arrange(items.filter((i) => i.id !== "b" && i.id !== "a"), rels).map((i) => [i.id, i.depth]), [["c", 0], ["d", 1], ["e", 0]]);
});

test("arrange: duplicates nest under their original; related ones are kept together (not on the timeline); no loops from duplicates", () => {
  const rel = (from: string, to: string, kind: "child_of" | "duplicate" | "related", at = "1") => ({ from_id: from, to_id: to, kind, created_at: at, created_by: "Ana" });
  const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const out = arrange(items, [rel("d", "a", "duplicate"), rel("c", "a", "child_of"), rel("e", "b", "related"), rel("b", "e", "related", "2")], { cluster: true });
  assert.deepEqual(out.map((i) => [i.id, i.depth, i.nested_as]), [["a", 0, undefined], ["c", 1, "child"], ["d", 1, "duplicate"], ["b", 0, undefined], ["e", 0, undefined]]);
  assert.deepEqual(out.map((i) => [i.id, i.cluster_prev, i.cluster]).slice(3), [["b", undefined, ["e"]], ["e", true, ["b"]]]);
  // A group goes where its first member was, members in order; through-chains join.
  const far = arrange(["a", "x", "b", "y", "c"].map((id) => ({ id })), [rel("a", "b", "related"), rel("b", "c", "related")], { cluster: true });
  assert.deepEqual(far.map((i) => i.id), ["a", "b", "c", "x", "y"]);
  assert.deepEqual(far.map((i) => i.cluster_prev), [undefined, true, true, undefined, undefined]);
  // Without clustering (timeline) the order is kept; related questions at different levels aren't joined.
  assert.deepEqual(arrange(["a", "x", "b"].map((id) => ({ id })), [rel("a", "b", "related")]).map((i) => i.id), ["a", "x", "b"]);
  const levels = arrange(["a", "b", "k"].map((id) => ({ id })), [rel("k", "a", "child_of"), rel("b", "k", "related")], { cluster: true });
  assert.deepEqual(levels.map((i) => [i.id, i.depth, i.cluster]), [["a", 0, undefined], ["k", 1, undefined], ["b", 0, undefined]]);
  // Duplicates can loop (nothing forbids it): every question still shows, none nested under a descendant.
  const loop = arrange(["a", "b", "c"].map((id) => ({ id })), [rel("a", "b", "duplicate"), rel("b", "c", "duplicate"), rel("c", "a", "duplicate")]);
  assert.deepEqual(loop.map((i) => i.id).sort(), ["a", "b", "c"]);
  assert.equal(loop.filter((i) => i.depth === 0).length, 1);
  // A child that is also a duplicate stands under its parent.
  assert.deepEqual(arrange(["a", "b", "c"].map((id) => ({ id })), [rel("c", "b", "duplicate"), rel("c", "a", "child_of")]).find((i) => i.id === "c")?.parent_id, "a");
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
    const q = (id: string) => {
      const r = repo.getQuestion(db, "s", id)!;
      return { status: r.status, source: fieldViews(r).status.source, label: r.status_label };
    };
    assert.deepEqual(q("pool"), { status: "not_started", source: "typed", label: "Not started" });
    assert.deepEqual(q("act"), { status: "open", source: "typed", label: "Being discussed" });
    assert.equal(q("dor").status, "not_started");
    assert.deepEqual(q("res"), { status: "rejected", source: "typed", label: "Not agreed" });
    assert.equal(q("res2").status, "concluded");
    assert.equal(q("dup").status, "withdrawn");
    assert.deepEqual(q("lp"), { status: "open", source: "retrieved", label: undefined });
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

test("create with typed summary, results and dates; a custom link or a kind alone", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", {
    title: "Which license?",
    process: { kind: "Meeting" },
    status: { label: "Agreed" },
    fields: { summary: "CC BY", results_url: "Adopted 9–1", start: "2026-03-01", end: "", unknown: undefined },
  }).catch((e) => e);
  assert.match(String(q.message), /Can't set "unknown"/);
  const ok = await Q.create(ctx, space, "Ana", {
    title: "Which license?",
    process: { kind: "Meeting" },
    status: { label: "Agreed" },
    fields: { summary: "CC BY", results_url: "Adopted 9–1", start: "2026-03-01", end: "" },
  });
  const f = fieldViews(ok);
  assert.deepEqual([f.kind.value, f.summary.value, f.results_url.value, f.start.value, f.end.value], ["Meeting", "CC BY", "Adopted 9–1", "2026-03-01", undefined]);
  assert.equal(ok.status, "accepted");
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "B", fields: { start: "2026-03-05", end: "2026-03-01" } }), /end date is before/);
  await assert.rejects(() => Q.create(ctx, space, "Ana", { title: "C", fields: { results_url: "http://example.org/x" } }), /https/);
});

test("results can be a link or plain words; a non-https link is refused", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Results?" });
  Q.updateFields(ctx, space, q, "Ana", { set: { results_url: "Adopted 9–1" } });
  assert.equal(fieldViews(q).results_url.value, "Adopted 9–1");
  Q.updateFields(ctx, space, q, "Ana", { set: { results_url: "https://example.org/results" } });
  assert.equal(fieldViews(q).results_url.value, "https://example.org/results");
  assert.throws(() => Q.updateFields(ctx, space, q, "Ana", { set: { results_url: "ftp://example.org/x" } }), /https/);
});

test("the About text replaces the old one and logs it with the text it replaced; unchanged text isn't logged; empty clears it", () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  assert.equal(repo.getSpace(t.ctx.db, space.id)!.charter_markdown, "", "new spaces start without one");
  setCharter(t.ctx, space.id, "# Us\n\nBe kind.\n", "Ana");
  assert.equal(repo.getSpace(t.ctx.db, space.id)!.charter_markdown, "# Us\n\nBe kind.\n");
  setCharter(t.ctx, space.id, "# Us\n\nBe kind.", "Ana");
  assert.equal(repo.listActivity(t.ctx.db, space.id, {}).map((e) => e.action).filter((a) => a === "charter.changed").length, 1);
  setCharter(t.ctx, space.id, "  \n", "Ben");
  assert.equal(repo.getSpace(t.ctx.db, space.id)!.charter_markdown, "");
  const last = t.ctx.db.prepare("SELECT actor, data_json FROM activity WHERE action = 'charter.changed' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(last.actor, "Ben");
  assert.equal(JSON.parse(last.data_json).previous, "# Us\n\nBe kind.");
  assert.throws(() => setCharter(t.ctx, space.id, "x".repeat(5001)), /too long/);
  assert.throws(() => setCharter(t.ctx, "nope", "x"), /No space/);
});
