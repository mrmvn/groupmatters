import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, makeSpace, DAY } from "./helpers.ts";
import * as Q from "../src/questions.ts";
import * as repo from "../src/repo.ts";
import { dormancySweep } from "../src/engine.ts";
import { HttpError } from "../src/util.ts";

const crit = { mode: "criteria", criteria: [{ kind: "attested", description: "Agreed at a meeting" }] };
const open = { mode: "open", criteria: [] };

async function rejects(p: unknown, status: number, re?: RegExp) {
  await assert.rejects(
    async () => p instanceof Function ? await p() : await p,
    (e: unknown) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)),
  );
}

test("create: title required, starts in inbox with tbd criteria, logged", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  await rejects(() => Q.create(ctx, space, "Ana", { title: "  " }), 400);
  const q = await Q.create(ctx, space, "Ana", { title: "Why?" });
  assert.equal(q.status, "inbox");
  assert.equal(q.resolution.mode, "tbd");
  assert.equal(q.created_by, "Ana");
  const log = repo.listActivity(ctx.db, space.id, { questionId: q.id });
  assert.equal(log[0].action, "question.created");
  assert.equal(log[0].actor, "Ana");
});

test("adopt: inbox → active needs criteria; actor becomes steward", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  await rejects(() => Q.adopt(ctx, space, q, "Ben", {}), 409, /count as an answer/);
  const a = await Q.adopt(ctx, space, Q.load(ctx, space, q.id), "Ben", { resolution: crit });
  assert.equal(a.status, "active");
  assert.equal(a.steward, "Ben");
});

test("adopt with open mode → standing; standing doesn't count toward cap", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q", resolution: open, adopt: true });
  assert.equal(q.status, "standing");
  assert.equal(repo.countActive(ctx.db, space.id), 0);
});

test("active cap refuses adoption with a helpful message", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  space.settings.active_cap = 2;
  repo.updateSpace(ctx.db, space);
  await Q.create(ctx, space, "A", { title: "1", resolution: crit, adopt: true });
  await Q.create(ctx, space, "A", { title: "2", resolution: crit, adopt: true });
  const third = await Q.create(ctx, space, "A", { title: "3", resolution: crit });
  await rejects(() => Q.adopt(ctx, space, third, "A", {}), 409, /2\/2 active: resolve, park or drop one first/);
  // Rules questions are not capped
  const r = await Q.create(ctx, space, "A", { title: "rule", section: "rules", adopt: true });
  assert.equal(r.status, "active");
});

test("tbd criteria not allowed while active; open not allowed while active", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q", resolution: crit, adopt: true });
  await rejects(() => Q.setResolution(ctx, space, q, "Ana", { mode: "tbd", criteria: [] }), 409);
  await rejects(() => Q.setResolution(ctx, space, q, "Ana", open), 409);
  await rejects(() => Q.setResolution(ctx, space, q, "Ana", { mode: "criteria", criteria: [] }), 400);
});

test("criteria validation: one per kind, process_outcome needs a process", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  await rejects(
    () => Q.setResolution(ctx, space, q, "Ana", { mode: "criteria", criteria: [{ kind: "date", at: "2026-03-01" }, { kind: "date", at: "2026-04-01" }] }),
    400,
    /Only one/,
  );
  await rejects(() => Q.setResolution(ctx, space, q, "Ana", { mode: "criteria", criteria: [{ kind: "process_outcome" }] }), 400, /process/);
  await rejects(() => Q.setResolution(ctx, space, q, "Ana", { mode: "criteria", criteria: [{ kind: "attested" }] }), 400);
});

test("only the steward can park; drop needs steward (or anyone when none) and a reason", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q", resolution: crit, adopt: true });
  await rejects(() => Q.park(ctx, space, q, "Ben", {}), 403);
  await rejects(() => Q.drop(ctx, space, q, "Ben", { reason: "nah" }), 403);
  await rejects(() => Q.drop(ctx, space, q, "Ana", {}), 400);
  const inbox = await Q.create(ctx, space, "Ana", { title: "Other" });
  assert.equal(Q.drop(ctx, space, inbox, "Ben", { reason: "out of scope" }).status, "dropped");
  // steward name matching is case-insensitive
  assert.equal(Q.park(ctx, space, q, "ana", {}).status, "dormant");
});

test("duplicates: must point to an existing other question; no cycles", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "A" });
  const b = await Q.create(ctx, space, "Ana", { title: "B" });
  assert.throws(() => Q.drop(ctx, space, a, "Ana", { reason: "dup", duplicate_of_id: a.id }), HttpError);
  assert.throws(() => Q.drop(ctx, space, a, "Ana", { reason: "dup", duplicate_of_id: "nope" }), HttpError);
  const d = Q.drop(ctx, space, b, "Ana", { reason: "dup", duplicate_of_id: a.id });
  assert.equal(d.duplicate_of_id, a.id);
  assert.throws(() => Q.drop(ctx, space, Q.load(ctx, space, a.id), "Ana", { reason: "dup", duplicate_of_id: b.id }), /already marked/);
});

test("dropped → inbox requires a reason and clears the duplicate link", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "A" });
  const b = await Q.create(ctx, space, "Ana", { title: "B" });
  Q.drop(ctx, space, b, "Ana", { reason: "dup", duplicate_of_id: a.id });
  assert.throws(() => Q.restore(ctx, space, Q.load(ctx, space, b.id), "Ben", {}), HttpError);
  const r = Q.restore(ctx, space, Q.load(ctx, space, b.id), "Ben", { reason: "not the same after all" });
  assert.equal(r.status, "inbox");
  assert.equal(r.duplicate_of_id, undefined);
});

test("refused transitions", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  assert.throws(() => Q.park(ctx, space, q, "Ana", {}), /Only active or standing/);
  assert.throws(() => Q.revive(ctx, space, q, "Ana"), /Only dormant/);
  assert.throws(() => Q.restore(ctx, space, q, "Ana", { reason: "x" }), /Only dropped/);
  await rejects(() => Q.reopen(ctx, space, q, "Ana", { reason: "x" }), 409);
  await rejects(() => Q.activate(ctx, space, q, "Ana", { resolution: crit }), 409);
  const s = await Q.create(ctx, space, "Ana", { title: "S", resolution: open, adopt: true });
  await rejects(() => Q.activate(ctx, space, s, "Ben", { resolution: crit }), 403);
  const act = await Q.activate(ctx, space, s, "Ana", { resolution: crit });
  assert.equal(act.status, "active");
});

test("dormant → inbox clears steward; dormant → active via adopt", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q", resolution: crit, adopt: true });
  Q.park(ctx, space, q, "Ana", {});
  const re = await Q.adopt(ctx, space, Q.load(ctx, space, q.id), "Ben", {});
  assert.equal(re.status, "active");
  assert.equal(re.steward, "Ben");
  Q.park(ctx, space, re, "Ben", {});
  const inbox = Q.revive(ctx, space, Q.load(ctx, space, q.id), "Chloé");
  assert.equal(inbox.status, "inbox");
  assert.equal(inbox.steward, undefined);
});

test("stewardship: hand over to someone, take over, hand over to nobody → inbox", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q", resolution: crit, adopt: true });
  assert.throws(() => Q.handOver(ctx, space, q, "Ben", { to: "Ben" }), HttpError);
  assert.equal(Q.handOver(ctx, space, q, "Ana", { to: "Ben" }).steward, "Ben");
  assert.equal(Q.takeOver(ctx, space, Q.load(ctx, space, q.id), "Chloé").steward, "Chloé");
  const back = Q.handOver(ctx, space, Q.load(ctx, space, q.id), "Chloé", {});
  assert.equal(back.status, "inbox");
  assert.equal(back.steward, undefined);
  const actions = repo.listActivity(ctx.db, space.id, { questionId: q.id }).map((e) => e.action);
  assert.ok(actions.filter((a) => a === "steward.changed").length >= 4);
});

test("parent: no self, no loops", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const a = await Q.create(ctx, space, "Ana", { title: "A" });
  const b = await Q.create(ctx, space, "Ana", { title: "B", parent_id: a.id });
  assert.throws(() => Q.edit(ctx, space, a, "Ana", { parent_id: a.id }), /itself/);
  assert.throws(() => Q.edit(ctx, space, a, "Ana", { parent_id: b.id }), /loop/);
  assert.equal(Q.edit(ctx, space, b, "Ana", { parent_id: "" }).parent_id, undefined);
});

test("dormancy sweep moves inactive active/standing questions, logged as system", async () => {
  const t = makeCtx();
  const { space } = makeSpace(t.ctx);
  const a = await Q.create(t.ctx, space, "Ana", { title: "A", resolution: crit, adopt: true });
  const s = await Q.create(t.ctx, space, "Ana", { title: "S", resolution: open, adopt: true });
  t.advance(29 * DAY);
  assert.equal(dormancySweep(t.ctx), 0);
  Q.edit(t.ctx, space, Q.load(t.ctx, space, s.id), "Ana", { title: "S2" }); // activity keeps it alive
  t.advance(2 * DAY);
  assert.equal(dormancySweep(t.ctx), 1);
  assert.equal(Q.load(t.ctx, space, a.id).status, "dormant");
  assert.equal(Q.load(t.ctx, space, s.id).status, "standing");
  const ev = repo.listActivity(t.ctx.db, space.id, { questionId: a.id })[0];
  assert.equal(ev.actor, "system");
});

test("activity log is append-only at the storage layer; questions can't be deleted", async () => {
  const { ctx } = makeCtx();
  const { space } = makeSpace(ctx);
  const q = await Q.create(ctx, space, "Ana", { title: "Q" });
  assert.throws(() => ctx.db.exec("UPDATE activity SET actor = 'x'"), /append-only/);
  assert.throws(() => ctx.db.exec("DELETE FROM activity"), /append-only/);
  assert.throws(() => ctx.db.prepare("DELETE FROM questions WHERE id = ?").run(q.id), /never deleted/);
});
