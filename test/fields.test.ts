import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeCtx, makeSpace, fixture, GH_PR, GH_PR_API } from "./helpers.ts";
import * as Q from "../src/questions.ts";
import * as repo from "../src/repo.ts";
import { effectiveDates, fieldViews, parseDateValue } from "../src/fields.ts";
import { timeline } from "../src/timeline.ts";
import { MIGRATIONS, openDb } from "../src/db.ts";
import type { Question } from "../src/types.ts";

test("date values: a whole day stays a day; a moment becomes ISO UTC; anything else is refused", () => {
  assert.equal(parseDateValue("2026-03-01"), "2026-03-01");
  assert.equal(parseDateValue("2026-03-01T18:00:00+01:00"), "2026-03-01T17:00:00.000Z");
  for (const bad of ["2026-02-30", "1 March", "", "2026-03-01 18:00", 12]) assert.throws(() => parseDateValue(bad), /Invalid/, String(bad));
});

const base = (over: Partial<Question>): Question => ({
  id: "q",
  space_id: "s",
  title: "T",
  status: "open",
  typed: {},
  created_at: "2026-01-02T00:00:00.000Z",
  created_by: "Ana",
  last_activity_at: "2026-01-09T00:00:00.000Z",
  ...over,
});
const proc = (fetched: any, fetch_mode: "auto" | "manual" = "auto") => ({ url: GH_PR, tool_id: "github", item_type: "pull_request", fetch_mode, fetched: { state: "open" as const, terminal: false, fetched_at: "2026-01-10T00:00:00Z", ...fetched } });

test("views: retrieved from the linked item, typed values win, the retrieved one stays visible", () => {
  const none = fieldViews(base({}));
  assert.deepEqual([none.start.source, none.start.retrievable, none.title.value], ["empty", false, "T"]);
  const q = base({ process: proc({ title: "feat: x", raw_state: "open", outcome_summary: "3 votes", dates: { opens_at: "2025-12-20T00:00:00Z", closes_at: "2026-01-20T00:00:00Z" } }) });
  const v = fieldViews(q);
  assert.deepEqual(
    [v.title.source, v.kind.value, v.status.value, v.status.as, v.summary.value, v.start.value, v.end.value],
    ["retrieved", "pull_request", { state: "open" }, "open", "3 votes", "2025-12-20T00:00:00Z", "2026-01-20T00:00:00Z"],
    "closing date = planned end",
  );
  const ended = base({ process: proc({ dates: { closes_at: "2026-01-20T00:00:00Z", resolved_at: "2026-01-05T00:00:00Z" } }) });
  assert.equal(fieldViews(ended).end.value, "2026-01-05T00:00:00Z", "the actual end wins over the planned one");
  const typed = { ...q, typed: { start: { value: "2025-12-01", by: "Ben", at: "x" }, end: { value: null, by: "Ben", at: "x" } } };
  const tv = fieldViews(typed);
  assert.deepEqual([tv.start.value, tv.start.source, tv.start.retrieved, tv.start.by], ["2025-12-01", "typed", "2025-12-20T00:00:00Z", "Ben"]);
  assert.deepEqual([tv.end.value, tv.end.source], [null, "typed"], "typed as none");
  assert.deepEqual(effectiveDates(typed), { start: { value: "2025-12-01", source: "typed" } });
  // A tool updated by hand: only the kind and title can be retrieved.
  const hand = fieldViews(base({ process: proc({ title: "Page title", raw_state: "x", dates: { opens_at: "2025-01-01T00:00:00Z" } }, "manual") }));
  assert.deepEqual([hand.title.source, hand.kind.source, hand.status.retrievable, hand.start.source], ["retrieved", "retrieved", false, "empty"]);
});

test("typing values: dates (whole day or moment), none, clear; validated", async () => {
  const t = makeCtx({ [GH_PR_API]: { body: fixture("github_pr_open.json") } });
  const { ctx } = t;
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "PR?", process_url: GH_PR });
  const fromLink = effectiveDates(q).start!;
  assert.equal(fromLink.source, "retrieved");
  Q.updateFields(ctx, space, q, "Ben", { set: { start: "2099-01-03", end: "2099-02-01T17:00:00Z" } });
  let r = Q.load(ctx, space, q.id);
  assert.deepEqual(effectiveDates(r), { start: { value: "2099-01-03", source: "typed" }, end: { value: "2099-02-01T17:00:00.000Z", source: "typed" } });
  // Same-day start and end are fine for whole days; an end before the start isn't.
  Q.updateFields(ctx, space, r, "Ben", { set: { end: "2099-01-03" } });
  assert.throws(() => Q.updateFields(ctx, space, Q.load(ctx, space, q.id), "Ben", { set: { end: "2099-01-02" } }), /before the start/);
  assert.throws(() => Q.updateFields(ctx, space, r, "Ben", { set: { start: "soon" } }), /Invalid start date/);
  assert.throws(() => Q.updateFields(ctx, space, r, "Ben", { set: { results_url: "http://x.org" } }), /https/);
  Q.updateFields(ctx, space, Q.load(ctx, space, q.id), "Ben", { use_retrieved: ["start"], set: { end: null } });
  r = Q.load(ctx, space, q.id);
  assert.deepEqual(effectiveDates(r), { start: fromLink }, "back to the link's start; end typed as none");
  assert.equal(r.typed.end?.value, null);
  const n = repo.listActivity(ctx.db, space.id, { questionId: q.id }).length;
  Q.updateFields(ctx, space, r, "Ben", { use_retrieved: ["start"] });
  assert.equal(repo.listActivity(ctx.db, space.id, { questionId: q.id }).length, n, "no change, no log");
  // Without a process, clearing just removes the typed value.
  const plain = await Q.create(ctx, space, "Ana", { title: "Plain" });
  Q.updateFields(ctx, space, plain, "Ana", { set: { summary: "Done" } });
  Q.updateFields(ctx, space, Q.load(ctx, space, plain.id), "Ana", { set: { summary: "" } });
  assert.equal(Q.load(ctx, space, plain.id).typed.summary, undefined);
  // A typed title is checked for duplicates.
  assert.throws(() => Q.updateFields(ctx, space, Q.load(ctx, space, plain.id), "Ana", { set: { title: "pr" } }), /already in the register/);
});

test("timeline: only questions with a start date, sorted by start; same filters as the list", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "Later one" });
  const b = await Q.create(ctx, space, "Ana", { title: "Meeting topic", process: { kind: "Meeting" } });
  await Q.create(ctx, space, "Ana", { title: "Undated" });
  Q.updateFields(ctx, space, a, "Ana", { set: { start: "2026-01-05T09:00:00Z" } });
  Q.updateFields(ctx, space, b, "Ana", { set: { start: "2026-01-05", end: "2026-01-05" } });
  Q.updateFields(ctx, space, Q.load(ctx, space, a.id), "Ben", { set: { status: { label: "Agreed" } } });
  const { items, undated } = timeline(ctx, space, {});
  assert.deepEqual(items.map((i) => i.title), ["Meeting topic", "Later one"], "the whole day sorts before 09:00 that day");
  assert.equal(undated, 1);
  const later = items.find((i) => i.id === a.id)!;
  assert.deepEqual([later.status, later.status_label, later.end], ["accepted", "Agreed", undefined], "ended, end unknown");
  assert.deepEqual(timeline(ctx, space, { tool: "custom" }).items.map((i) => i.id), [b.id]);
  assert.deepEqual(timeline(ctx, space, { item_type: "Meeting" }).items.map((i) => i.id), [b.id], "filter by typed kind");
});

test("migration 8: sources become typed values; hand-set process states become typed statuses; tool states dropped", () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-db-"));
  try {
    const path = join(dir, "r.sqlite");
    const v7 = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 7)) typeof m === "string" ? v7.exec(m) : m(v7);
    v7.exec("PRAGMA user_version = 7");
    v7.exec(`INSERT INTO spaces VALUES ('s','S','2026-01-01','{"status_labels":[{"label":"Not started","state":"not_started"},{"label":"Being discussed","state":"open"}]}','', 'e', 'v')`);
    const ins = v7.prepare(
      `INSERT INTO questions (id, space_id, title, status, status_source, status_label, start_source, start_date, end_source, created_at, created_by, last_activity_at) VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, '2026-01-01', 'Ana', '2026-01-01')`,
    );
    ins.run("plain", "Plain", "open", "manual", "Being discussed", "process", null, "none");
    ins.run("gh", "Exactly the PR title", "open", "process", null, "manual", "2026-03-01", "process");
    ins.run("own", "Our words", "open", "process", null, "process", null, "process");
    ins.run("meet", "Meeting topic", "accepted", "process", null, "process", null, "process");
    const proc = v7.prepare(`INSERT INTO processes (id, question_id, space_id, url, tool_id, item_type, fetch_mode, fetched_json, created_at) VALUES (?, ?, 's', ?, ?, ?, ?, ?, '2026-01-01')`);
    const ghFetched = JSON.stringify({ title: "Exactly the PR title", state: "open", terminal: false, fetched_at: "x" });
    proc.run("p1", "gh", GH_PR, "github", "pull_request", "auto", ghFetched);
    proc.run("p2", "own", "https://github.com/a/b/pull/2", "github", "pull_request", "auto", ghFetched);
    proc.run("p3", "meet", null, "custom", "General assembly", "manual", JSON.stringify({ state: "accepted", raw_state: "Agreed", outcome_summary: "9 for", terminal: true, fetched_at: "x" }));
    v7.exec(`INSERT INTO tools (space_id, id, name, url_patterns_json, fetch_mode, state_map_json, enabled, position) VALUES ('s','kialo','Kialo','[]','manual','{"Open":"open"}',1,1)`);
    v7.close();

    const db = openDb(path);
    const v = (id: string) => fieldViews(repo.getQuestion(db, "s", id)!);
    const plain = v("plain");
    assert.deepEqual([plain.title.source, plain.status.source, plain.status.value, plain.end.value], ["typed", "typed", { state: "open", label: "Being discussed" }, undefined], "none without a process: nothing to keep");
    const gh = v("gh");
    assert.deepEqual([gh.title.source, gh.status.source, gh.start.source, gh.start.value], ["retrieved", "retrieved", "typed", "2026-03-01"]);
    assert.equal(v("own").title.source, "typed", "a title in the group's own words stays typed");
    const meet = repo.getQuestion(db, "s", "meet")!;
    assert.deepEqual([meet.typed.kind?.value, (meet.typed.status?.value as any)?.label, meet.typed.summary?.value, meet.process?.item_type], ["General assembly", "Agreed", "9 for", ""]);
    assert.equal(meet.process?.fetched?.raw_state, undefined, "hand-set values moved out of the process");
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    for (const c of ["status_source", "start_source", "start_date", "end_source", "end_date"]) assert.ok(!cols("questions").includes(c), c);
    assert.ok(!cols("tools").includes("state_map_json"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
