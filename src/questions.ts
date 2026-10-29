// Questions: creation, edits and the status machine (spec §3). All rules enforced here, server-side.
import type { Ctx } from "./ctx.ts";
import type { Question, Resolution, Space, Status } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { modeAllowed, validateResolution } from "./criteria.ts";
import { prepareProcess, storeProcess } from "./processes.ts";
import { evaluateQuestion, syncDefaultWindow } from "./engine.ts";
import { validatePayload } from "./rules.ts";
import { canActAsSteward, sameName } from "./permissions.ts";
import { bad, conflict, forbidden, newId, notFound, requireText, trimOrUndef } from "./util.ts";

const TITLE_MAX = 300;

function log(ctx: Ctx, q: Question, actor: string, action: string, data: Record<string, unknown> = {}) {
  repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action, data });
}

function statusChange(ctx: Ctx, q: Question, actor: string, to: Status, data: Record<string, unknown> = {}) {
  const from = q.status;
  q.status = to;
  log(ctx, q, actor, "question.status_changed", { from, to, ...data });
}

function setSteward(ctx: Ctx, q: Question, actor: string, to: string | undefined, how: string) {
  const before = q.steward;
  if (before === to) return;
  if (to) q.steward = to;
  else delete q.steward;
  log(ctx, q, actor, "steward.changed", { before: before ?? null, after: to ?? null, how });
}

function checkCap(ctx: Ctx, space: Space, q: Question) {
  if (q.section !== "main") return; // Rules questions don't count toward the cap (DECISIONS.md)
  const n = repo.countActive(ctx.db, space.id);
  if (n >= space.settings.active_cap)
    throw conflict(`${n}/${space.settings.active_cap} active: resolve, park or drop one first.`, "active_cap");
}

export function load(ctx: Ctx, space: Space, id: string): Question {
  const q = repo.getQuestion(ctx.db, space.id, String(id));
  if (!q) throw notFound("Question not found");
  return q;
}

function validateParent(ctx: Ctx, space: Space, q: { id?: string }, parentId: unknown): string | undefined {
  if (parentId == null || parentId === "") return undefined;
  const pid = String(parentId);
  if (pid === q.id) throw bad("A question can't be part of itself");
  let cur = repo.getQuestion(ctx.db, space.id, pid);
  if (!cur) throw bad("Parent question not found");
  for (let i = 0; cur && i < 1000; i++) {
    if (cur.id === q.id) throw bad("That would make a loop of “part of” links");
    cur = cur.parent_id ? repo.getQuestion(ctx.db, space.id, cur.parent_id) : undefined;
  }
  return pid;
}

/** Create a question in the inbox, optionally with a process, criteria and immediate adoption. */
export async function create(ctx: Ctx, space: Space, actor: string, body: any): Promise<Question> {
  const title = requireText(body?.title, "Title", TITLE_MAX);
  const why = trimOrUndef(body?.why_it_matters, 5000);
  const rules_payload = body?.rules_payload ? validatePayload(ctx, space, body.rules_payload) : undefined;
  const section = rules_payload || body?.section === "rules" ? "rules" : "main";
  if (body?.section && !["main", "rules"].includes(body.section)) throw bad("Unknown section");
  const parent_id = validateParent(ctx, space, {}, body?.parent_id);
  const processUrl = trimOrUndef(body?.process_url, 2000);
  const prepared = processUrl ? await prepareProcess(ctx, space, processUrl, trimOrUndef(body?.framing, 2000)) : undefined;

  let resolution: Resolution = { mode: "tbd", criteria: [] };
  if (section === "rules") resolution = { mode: "criteria", criteria: [{ kind: "default_rule" }] };
  if (body?.resolution) resolution = validateResolution(body.resolution, { hasProcess: !!prepared, section });

  const now = ctx.now().toISOString();
  const q: Question = {
    id: newId(),
    space_id: space.id,
    section,
    title,
    status: "inbox",
    resolution,
    created_at: now,
    created_by: actor,
    last_activity_at: now,
  };
  if (why) q.why_it_matters = why;
  if (parent_id) q.parent_id = parent_id;
  if (rules_payload) q.rules_payload = rules_payload;

  tx(ctx.db, () => {
    repo.insertQuestion(ctx.db, q);
    log(ctx, q, actor, "question.created", {
      title,
      section,
      ...(why ? { why_it_matters: why } : {}),
      ...(parent_id ? { parent_id } : {}),
      ...(rules_payload ? { rules_payload } : {}),
      resolution,
    });
    if (prepared) storeProcess(ctx, q, actor, prepared);
    if (body?.adopt) adoptInTx(ctx, space, q, actor);
  });
  if (q.status === "active") return (await evaluateQuestion(ctx, space, q.id)) ?? q;
  return q;
}

export function edit(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (body?.title !== undefined) {
    const t = requireText(body.title, "Title", TITLE_MAX);
    if (t !== q.title) (changes.title = { before: q.title, after: t }), (q.title = t);
  }
  if (body?.why_it_matters !== undefined) {
    const w = trimOrUndef(body.why_it_matters, 5000);
    if (w !== q.why_it_matters) {
      changes.why_it_matters = { before: q.why_it_matters ?? null, after: w ?? null };
      if (w) q.why_it_matters = w;
      else delete q.why_it_matters;
    }
  }
  if (body?.parent_id !== undefined) {
    const p = validateParent(ctx, space, q, body.parent_id);
    if (p !== q.parent_id) {
      changes.parent_id = { before: q.parent_id ?? null, after: p ?? null };
      if (p) q.parent_id = p;
      else delete q.parent_id;
    }
  }
  if (Object.keys(changes).length === 0) return q;
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.edited", changes);
  });
  return q;
}

export async function setResolution(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status === "resolved") throw conflict("Reopen the question before changing its criteria");
  if (q.status !== "inbox" && q.status !== "dormant" && q.status !== "dropped" && !canActAsSteward(q, actor))
    throw forbidden(`Only the steward (${q.steward}) can change the criteria`);
  const resolution = validateResolution(body, { hasProcess: !!q.process, section: q.section });
  if (!modeAllowed(q.status, resolution.mode)) {
    const hint =
      q.status === "active"
        ? "An active question needs criteria. To make it open-ended, park it and adopt it as standing."
        : q.status === "standing"
          ? "A standing question is open-ended. Use “Make active” to give it criteria."
          : "This mode isn't allowed in the current status.";
    throw conflict(hint);
  }
  const before = q.resolution;
  if (JSON.stringify(before) === JSON.stringify(resolution)) return q;
  const beforeDays = before.criteria.find((c) => c.kind === "default_rule");
  const afterDays = resolution.criteria.find((c) => c.kind === "default_rule");
  tx(ctx.db, () => {
    q.resolution = resolution;
    if (q.pending_resolution) {
      delete q.pending_resolution;
      log(ctx, q, "system", "resolution.cancelled", { reason: "criteria changed" });
    }
    syncDefaultWindow(ctx, space, q, { restart: JSON.stringify(beforeDays) !== JSON.stringify(afterDays) });
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "criteria.changed", { before, after: resolution });
  });
  return (await evaluateQuestion(ctx, space, q.id)) ?? q;
}

// ---------- status transitions ----------

function adoptInTx(ctx: Ctx, space: Space, q: Question, actor: string) {
  if (q.status !== "inbox" && q.status !== "dormant") throw conflict("Only inbox or dormant questions can be adopted");
  if (q.resolution.mode === "tbd") throw conflict("Say what will count as an answer first (criteria), or mark it open-ended");
  const to: Status = q.resolution.mode === "open" ? "standing" : "active";
  if (to === "active") checkCap(ctx, space, q);
  setSteward(ctx, q, actor, actor, "adopted");
  statusChange(ctx, q, actor, to);
  syncDefaultWindow(ctx, space, q, { restart: true });
  repo.saveQuestion(ctx.db, q);
}

export async function adopt(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status !== "inbox" && q.status !== "dormant") throw conflict("Only inbox or dormant questions can be adopted");
  tx(ctx.db, () => {
    if (body?.resolution) {
      const r = validateResolution(body.resolution, { hasProcess: !!q.process, section: q.section });
      if (JSON.stringify(r) !== JSON.stringify(q.resolution)) {
        log(ctx, q, actor, "criteria.changed", { before: q.resolution, after: r });
        q.resolution = r;
      }
    }
    adoptInTx(ctx, space, q, actor);
  });
  return (await evaluateQuestion(ctx, space, q.id)) ?? q;
}

/** standing → active (steward; criteria; cap). */
export async function activate(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status !== "standing") throw conflict("Only standing questions can be made active this way");
  if (!canActAsSteward(q, actor)) throw forbidden(`Only the steward (${q.steward}) can do this`);
  const r = validateResolution(body?.resolution, { hasProcess: !!q.process, section: q.section });
  if (r.mode !== "criteria") throw bad("An active question needs criteria");
  tx(ctx.db, () => {
    checkCap(ctx, space, q);
    log(ctx, q, actor, "criteria.changed", { before: q.resolution, after: r });
    q.resolution = r;
    statusChange(ctx, q, actor, "active");
    syncDefaultWindow(ctx, space, q, { restart: true });
    repo.saveQuestion(ctx.db, q);
  });
  return (await evaluateQuestion(ctx, space, q.id)) ?? q;
}

/** active/standing → dormant (steward). */
export function park(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (q.status !== "active" && q.status !== "standing") throw conflict("Only active or standing questions can be parked");
  if (!canActAsSteward(q, actor)) throw forbidden(`Only the steward (${q.steward}) can park this question`);
  return tx(ctx.db, () => {
    statusChange(ctx, q, actor, "dormant", { reason: trimOrUndef(body?.reason, 1000) ?? null });
    delete q.pending_resolution;
    delete q.default_window;
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

/** dormant → inbox (anyone). */
export function revive(ctx: Ctx, space: Space, q: Question, actor: string): Question {
  if (q.status !== "dormant") throw conflict("Only dormant questions can be revived");
  return tx(ctx.db, () => {
    statusChange(ctx, q, actor, "inbox");
    setSteward(ctx, q, actor, undefined, "returned to inbox");
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

/** inbox/active/standing/dormant → dropped (steward, or anyone if no steward). */
export function drop(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (!["inbox", "active", "standing", "dormant"].includes(q.status)) throw conflict("This question can't be dropped from its current status");
  if (!canActAsSteward(q, actor)) throw forbidden(`Only the steward (${q.steward}) can drop this question`);
  const reason = requireText(body?.reason, "A reason", 2000);
  let dup: string | undefined;
  if (body?.duplicate_of_id) {
    dup = String(body.duplicate_of_id);
    if (dup === q.id) throw bad("A question can't be a duplicate of itself");
    let cur = repo.getQuestion(ctx.db, space.id, dup);
    if (!cur) throw bad("Original question not found");
    for (let i = 0; cur && i < 1000; i++) {
      if (cur.id === q.id) throw bad("That question is already marked as a duplicate of this one");
      cur = cur.duplicate_of_id ? repo.getQuestion(ctx.db, space.id, cur.duplicate_of_id) : undefined;
    }
  }
  return tx(ctx.db, () => {
    q.drop_reason = reason;
    if (dup) q.duplicate_of_id = dup;
    delete q.pending_resolution;
    delete q.default_window;
    statusChange(ctx, q, actor, "dropped", { reason, ...(dup ? { duplicate_of_id: dup } : {}) });
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

/** dropped → inbox (anyone, reason). */
export function restore(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (q.status !== "dropped") throw conflict("Only dropped questions can be restored");
  const reason = requireText(body?.reason, "A reason", 2000);
  return tx(ctx.db, () => {
    statusChange(ctx, q, actor, "inbox", { reason });
    delete q.drop_reason;
    delete q.duplicate_of_id;
    setSteward(ctx, q, actor, undefined, "returned to inbox");
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

/** resolved → active (anyone, reason, cap). */
export async function reopen(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status !== "resolved") throw conflict("Only resolved questions can be reopened");
  const reason = requireText(body?.reason, "A reason", 2000);
  tx(ctx.db, () => {
    checkCap(ctx, space, q);
    const previous = q.resolution_record;
    delete q.resolution_record;
    q.reopened_at = ctx.now().toISOString();
    const f = q.process?.fetched;
    if (f?.terminal) q.reopen_baseline_state = f.state;
    else delete q.reopen_baseline_state;
    if (!q.steward) setSteward(ctx, q, actor, actor, "reopened");
    log(ctx, q, actor, "question.reopened", { reason, previous_record: previous ?? null });
    statusChange(ctx, q, actor, "active", { reason });
    syncDefaultWindow(ctx, space, q, { restart: true });
    repo.saveQuestion(ctx.db, q);
  });
  return (await evaluateQuestion(ctx, space, q.id)) ?? q;
}

/** Steward hands over to someone, or to nobody (question goes back to the inbox). */
export function handOver(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (!q.steward) throw conflict("This question has no steward");
  if (!sameName(q.steward, actor)) throw forbidden(`Only the steward (${q.steward}) can hand over. You can take over instead.`);
  const to = trimOrUndef(body?.to, 60);
  if (to && ["system", "operator"].includes(to.toLowerCase())) throw bad("That name is reserved");
  return tx(ctx.db, () => {
    setSteward(ctx, q, actor, to, "handed over");
    if (!to && (q.status === "active" || q.status === "standing")) {
      statusChange(ctx, q, actor, "inbox", { reason: "steward handed over without a successor" });
      delete q.pending_resolution;
      delete q.default_window;
    }
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

export function takeOver(ctx: Ctx, space: Space, q: Question, actor: string): Question {
  if (q.status === "inbox" || q.status === "dropped") throw conflict("Adopt the question instead");
  if (sameName(q.steward, actor)) throw conflict("You are already the steward");
  return tx(ctx.db, () => {
    setSteward(ctx, q, actor, actor, "taken over");
    repo.saveQuestion(ctx.db, q);
    return q;
  });
}

export async function attachProcess(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status === "resolved" || q.status === "dropped") throw conflict("Reopen or restore the question before changing its process");
  const url = requireText(body?.url, "Link", 2000);
  const prepared = await prepareProcess(ctx, space, url, trimOrUndef(body?.framing, 2000) ?? q.process?.framing);
  const fresh = load(ctx, space, q.id);
  tx(ctx.db, () => storeProcess(ctx, fresh, actor, prepared));
  return (await evaluateQuestion(ctx, space, q.id)) ?? fresh;
}
