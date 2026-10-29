import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace, fixture, GH_PR, GH_PR_API, DAY, HOUR } from "./helpers.ts";
import * as Q from "../src/questions.ts";
import * as E from "../src/engine.ts";
import * as P from "../src/processes.ts";
import * as repo from "../src/repo.ts";
import { tick } from "../src/scheduler.ts";

const openPr = () => ({ body: fixture("github_pr_open.json") });
const mergedPr = () => ({ body: fixture("github_pr_merged.json") });
const closedPr = () => ({ body: fixture("github_pr_closed_unmerged.json") });

test("paste a GitHub PR: title and state are fetched; merge is reflected after refresh and auto-resolves", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const preview = await P.previewUrl(t.ctx, space, GH_PR);
  assert.ok(preview.matched && preview.fetched?.title);
  const q = await Q.create(t.ctx, space, "Ana", {
    title: preview.matched ? preview.fetched!.title : "x",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }] },
    adopt: true,
  });
  assert.equal(q.status, "active");
  assert.equal(q.process?.tool_id, "github");
  assert.equal(q.process?.fetched?.state, "open");

  t.routes[GH_PR_API] = mergedPr();
  t.advance(16 * 60_000);
  await tick(t.ctx);
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.status, "resolved");
  assert.equal(r.resolution_record?.confirmed_by, "system");
  assert.equal(r.resolution_record?.triggered_by, "process_outcome");
  assert.equal(r.resolution_record?.outcome, "accepted");
  assert.equal(r.resolution_record?.snapshot.process?.fetched?.state, "accepted", "snapshot has state at resolution");
  const actions = repo.listActivity(t.ctx.db, space.id, { questionId: q.id }).map((e) => e.action);
  assert.ok(actions.includes("process.state_changed"));
  assert.ok(actions.includes("resolution.confirmed"));
});

test("auto-confirmation can be turned off: unambiguous outcome then waits for confirmation", async () => {
  const t = makeCtx({ [GH_PR_API]: closedPr() });
  const { space } = makeSpace(t.ctx);
  space.settings.auto_confirm_process_outcomes = false;
  repo.updateSpace(t.ctx.db, space);
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Q",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }] },
    adopt: true,
  });
  assert.equal(q.status, "active");
  assert.equal(q.pending_resolution?.triggered_by, "process_outcome");
  await assert.rejects(() => E.confirm(t.ctx, space, q, "Ben", {}), /Only the steward/);
  const r = await E.confirm(t.ctx, space, q, "Ana", { synthesis: "We won't do it." });
  assert.equal(r.status, "resolved");
  assert.equal(r.resolution_record?.outcome, "rejected");
  assert.equal(r.resolution_record?.synthesis, "We won't do it.");
});

test("process outcome OR date, whichever comes first: the date wins → pending, then confirm", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const at = new Date(t.ctx.now().getTime() + 3 * DAY).toISOString();
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Q",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }, { kind: "date", at }] },
    adopt: true,
  });
  t.advance(2 * DAY);
  await tick(t.ctx);
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution, undefined);
  t.advance(1 * DAY + HOUR);
  await tick(t.ctx);
  const p = Q.load(t.ctx, space, q.id);
  assert.equal(p.status, "active");
  assert.equal(p.pending_resolution?.triggered_by, "date");
  const r = await E.confirm(t.ctx, space, p, "Ana", {});
  assert.equal(r.resolution_record?.triggered_by, "date");
  assert.equal(r.resolution_record?.outcome, "concluded");
  assert.equal(r.resolution_record?.snapshot.process?.fetched?.state, "open", "snapshot keeps what the process showed");
});

test("process outcome OR date: the process wins", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const at = new Date(t.ctx.now().getTime() + 30 * DAY).toISOString();
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Q",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }, { kind: "date", at }] },
    adopt: true,
  });
  t.routes[GH_PR_API] = closedPr();
  t.advance(HOUR);
  await tick(t.ctx);
  const r = Q.load(t.ctx, space, q.id);
  assert.equal(r.status, "resolved");
  assert.equal(r.resolution_record?.outcome, "rejected");
});

test("process_outcome with accept_states only fires on listed states", async () => {
  const t = makeCtx({ [GH_PR_API]: closedPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Q",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome", accept_states: ["accepted"] }] },
    adopt: true,
  });
  assert.equal(q.status, "active");
  assert.equal(q.pending_resolution, undefined);
});

test("refresh errors keep previous values and back off", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  t.routes[GH_PR_API] = { status: 500, body: {} };
  t.advance(16 * 60_000);
  const r = await P.refreshProcess(t.ctx, q.id);
  assert.match(r.error!, /HTTP 500/);
  const row = repo.getProcessRow(t.ctx.db, q.id)!;
  assert.equal(row.fetched?.state, "open");
  assert.ok(row.fetched?.fetch_error);
  assert.equal(row.fail_count, 1);
});

test("ETag: 304 keeps state without a change event", async () => {
  let n = 0;
  const t = makeCtx({ [GH_PR_API]: () => (n++ === 0 ? { body: fixture("github_pr_open.json"), headers: { etag: '"e1"' } } : { status: 304 }) });
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR });
  t.advance(16 * 60_000);
  const r = await P.refreshProcess(t.ctx, q.id);
  assert.equal(r.changed, false);
  assert.equal(repo.getProcessRow(t.ctx.db, q.id)?.fetched?.state, "open");
});

test("manual tool: Polis state set by hand; concluded needs confirmation", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "What do we value?",
    process_url: "https://pol.is/2demo",
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }] },
    adopt: true,
  });
  assert.equal(q.process?.fetch_mode, "manual");
  assert.throws(() => P.manualUpdate(t.ctx, q, "Ben", { state: "concluded" }), /Only the steward/);
  P.manualUpdate(t.ctx, q, "Ana", { state: "concluded", raw_state: "Closed", outcome_summary: "Report published", results_url: "https://pol.is/report/r1" });
  const e = await E.evaluateQuestion(t.ctx, space, q.id);
  assert.equal(e?.status, "active");
  assert.equal(e?.pending_resolution?.triggered_by, "process_outcome");
  assert.equal(e?.process?.fetched?.extra?.results_url, "https://pol.is/report/r1");
});

test("unregistered URL is refused with a propose suggestion", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  await assert.rejects(
    () => Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "https://forum.example.org/t/123" }),
    (e: any) => e.code === "unknown_tool" && e.details.suggestion.pattern === "https://forum.example.org/*",
  );
  await assert.rejects(() => Q.create(t.ctx, space, "Ana", { title: "Q", process_url: "http://github.com/a/b/pull/1" }), /https/);
});

test("default rule: window elapses → pending → confirm", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Thursdays?", resolution: { mode: "criteria", criteria: [{ kind: "default_rule", days: 3 }] }, adopt: true });
  assert.ok(q.default_window);
  t.advance(3 * DAY - HOUR);
  await tick(t.ctx);
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution, undefined);
  t.advance(2 * HOUR);
  await tick(t.ctx);
  const p = Q.load(t.ctx, space, q.id);
  assert.equal(p.pending_resolution?.triggered_by, "default_rule");
  const r = await E.confirm(t.ctx, space, p, "Ana", {});
  assert.equal(r.resolution_record?.outcome, "accepted");
});

test("default rule: an objection blocks resolution until addressed; window resumes", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Thursdays?", resolution: { mode: "criteria", criteria: [{ kind: "default_rule", days: 7 }] }, adopt: true });
  t.advance(2 * DAY);
  assert.throws(() => E.object(t.ctx, space, q, "Ben", {}), /reason/);
  E.object(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { reason: "Clashes with my course" });
  t.advance(10 * DAY);
  await tick(t.ctx);
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution, undefined, "objection blocks");
  const [o] = repo.listObjections(t.ctx.db, q.id);
  assert.throws(() => E.address(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { objection_id: o.id, note: "x" }), /steward/);
  E.address(t.ctx, space, Q.load(t.ctx, space, q.id), "Ana", { objection_id: o.id, note: "Moved to Thursday mornings" });
  const w = Q.load(t.ctx, space, q.id).default_window!;
  // 5 days remained when paused (≥ 2 days), so the window restarts for 5 days
  assert.equal(new Date(w.ends_at).getTime() - t.ctx.now().getTime(), 5 * DAY);
  t.advance(5 * DAY + 1);
  await tick(t.ctx);
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution?.triggered_by, "default_rule");
});

test("default rule: fewer than 2 days left → full window after addressing", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", resolution: { mode: "criteria", criteria: [{ kind: "default_rule" }] }, adopt: true });
  t.advance(6 * DAY);
  E.object(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { reason: "wait" });
  const [o] = repo.listObjections(t.ctx.db, q.id);
  E.address(t.ctx, space, Q.load(t.ctx, space, q.id), "Ana", { objection_id: o.id, note: "ok" });
  const w = Q.load(t.ctx, space, q.id).default_window!;
  assert.equal(new Date(w.ends_at).getTime() - t.ctx.now().getTime(), 7 * DAY);
});

test("objection while pending (default rule) cancels the pending resolution", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", resolution: { mode: "criteria", criteria: [{ kind: "default_rule", days: 1 }] }, adopt: true });
  t.advance(DAY + 1);
  await tick(t.ctx);
  assert.ok(Q.load(t.ctx, space, q.id).pending_resolution);
  E.object(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { reason: "late objection" });
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution, undefined);
});

test("attested: steward attests with a description; others can't", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Budget?",
    resolution: { mode: "criteria", criteria: [{ kind: "attested", description: "Quorum at the AGM" }] },
    adopt: true,
  });
  await tick(t.ctx);
  assert.equal(Q.load(t.ctx, space, q.id).pending_resolution, undefined, "never met automatically");
  await assert.rejects(() => E.attest(t.ctx, space, q, "Ben", { attested: "yes" }), /steward/);
  await assert.rejects(() => E.attest(t.ctx, space, q, "Ana", {}), /attesting/);
  const r = await E.attest(t.ctx, space, q, "Ana", { attested: "14 of 20 members voted yes at the AGM" });
  assert.equal(r.status, "resolved");
  assert.equal(r.resolution_record?.attested, "14 of 20 members voted yes at the AGM");
});

test("anyone can confirm once the steward has been inactive for 7 days", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const at = new Date(t.ctx.now().getTime() + DAY).toISOString();
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", resolution: { mode: "criteria", criteria: [{ kind: "date", at }] }, adopt: true });
  t.advance(2 * DAY);
  await tick(t.ctx);
  await assert.rejects(() => E.confirm(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", {}), /Only the steward/);
  t.advance(6 * DAY);
  const r = await E.confirm(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", {});
  assert.equal(r.resolution_record?.confirmed_by, "Ben");
});

test("reopen keeps the previous record in the log; past criteria don't immediately re-trigger", async () => {
  const t = makeCtx({ [GH_PR_API]: mergedPr() });
  const { space } = makeSpace(t.ctx);
  const at = new Date(t.ctx.now().getTime() + DAY).toISOString();
  const q = await Q.create(t.ctx, space, "Ana", {
    title: "Q",
    process_url: GH_PR,
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }, { kind: "date", at }] },
    adopt: true,
  });
  assert.equal(q.status, "resolved");
  t.advance(2 * DAY);
  await assert.rejects(() => Q.reopen(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", {}), /reason/);
  const r = await Q.reopen(t.ctx, space, Q.load(t.ctx, space, q.id), "Ben", { reason: "The change was reverted" });
  assert.equal(r.status, "active");
  assert.equal(r.resolution_record, undefined);
  await tick(t.ctx);
  const after = Q.load(t.ctx, space, q.id);
  assert.equal(after.status, "active");
  assert.equal(after.pending_resolution, undefined);
  const ev = repo.listActivity(t.ctx.db, space.id, { questionId: q.id }).find((e) => e.action === "question.reopened")!;
  assert.ok((ev.data as any).previous_record.snapshot);
});

test("removing the process removes process_outcome; refused when it's the only criterion of an active question", async () => {
  const t = makeCtx({ [GH_PR_API]: openPr() });
  const { space } = makeSpace(t.ctx);
  const at = new Date(t.ctx.now().getTime() + 9 * DAY).toISOString();
  const q = await Q.create(t.ctx, space, "Ana", { title: "Q", process_url: GH_PR, resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }] }, adopt: true });
  assert.throws(() => P.removeProcess(t.ctx, space, q, "Ana"), /only criterion/);
  await Q.setResolution(t.ctx, space, Q.load(t.ctx, space, q.id), "Ana", { mode: "criteria", criteria: [{ kind: "process_outcome" }, { kind: "date", at }] });
  const r = P.removeProcess(t.ctx, space, Q.load(t.ctx, space, q.id), "Ana");
  assert.deepEqual(r.resolution.criteria.map((c) => c.kind), ["date"]);
  assert.equal(Q.load(t.ctx, space, q.id).process, undefined);
});
