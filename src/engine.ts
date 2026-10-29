// Resolution engine (spec §4): evaluation, pending resolutions, confirmation, snapshots,
// default-rule objection windows, attestation.
import type { Ctx } from "./ctx.ts";
import type { CriterionKind, NormalizedState, Question, ResolutionRecord, Space } from "./types.ts";
import { TERMINAL_STATES, UNAMBIGUOUS_TERMINAL } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { evaluate } from "./criteria.ts";
import { refreshProcess } from "./processes.ts";
import { applyPayload } from "./rules.ts";
import { canActAsSteward } from "./permissions.ts";
import { bad, conflict, DAY_MS, forbidden, newId, requireText, trimOrUndef } from "./util.ts";

const STEWARD_INACTIVE_DAYS = 7;
const MIN_REMAINING_MS = 2 * DAY_MS;

const openObjections = (ctx: Ctx, q: Question) => repo.listObjections(ctx.db, q.id).filter((o) => !o.addressed_at).length;

function windowDays(space: Space, q: Question): number | undefined {
  const c = q.resolution.criteria.find((c) => c.kind === "default_rule");
  if (!c || c.kind !== "default_rule") return undefined;
  return c.days ?? space.settings.default_rule_days;
}

/** (Re)open the objection window if the question is active with a default_rule criterion; clear it otherwise. */
export function syncDefaultWindow(ctx: Ctx, space: Space, q: Question, opts: { restart?: boolean } = {}) {
  const days = windowDays(space, q);
  if (q.status !== "active" || days === undefined) {
    delete q.default_window;
    return;
  }
  if (q.default_window && !opts.restart) return;
  const now = ctx.now();
  q.default_window = { opened_at: now.toISOString(), ends_at: new Date(now.getTime() + days * DAY_MS).toISOString() };
  if (openObjections(ctx, q) > 0) q.default_window.paused_remaining_ms = days * DAY_MS;
}

/** Evaluate one question; create a pending resolution or resolve directly (auto-confirmation). */
export async function evaluateQuestion(ctx: Ctx, space: Space, questionId: string): Promise<Question | undefined> {
  const q = repo.getQuestion(ctx.db, space.id, questionId);
  if (!q || q.status !== "active" || q.pending_resolution) return q;
  const met = evaluate(q, ctx.now(), openObjections(ctx, q));
  if (!met) return q;
  const auto =
    met.kind === "process_outcome" &&
    space.settings.auto_confirm_process_outcomes &&
    q.process?.fetch_mode === "auto" &&
    UNAMBIGUOUS_TERMINAL.includes(met.suggested_outcome);
  if (auto) {
    return resolve(ctx, space, q.id, { triggered_by: met.kind, confirmed_by: "system", outcome: met.suggested_outcome });
  }
  return tx(ctx.db, () => {
    q.pending_resolution = { triggered_by: met.kind, triggered_at: ctx.now().toISOString(), suggested_outcome: met.suggested_outcome };
    repo.saveQuestion(ctx.db, q);
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor: "system", action: "resolution.pending", data: { ...q.pending_resolution } });
    return q;
  });
}

type ResolveArgs = {
  triggered_by: CriterionKind;
  confirmed_by: string;
  outcome: NormalizedState;
  synthesis?: string;
  attested?: string;
};

/** Resolve: refresh the process once more, snapshot, record, apply Rules payloads. */
export async function resolve(ctx: Ctx, space: Space, questionId: string, args: ResolveArgs): Promise<Question> {
  let refreshNote: string | undefined;
  const before = repo.getQuestion(ctx.db, space.id, questionId);
  if (before?.process?.fetch_mode === "auto") {
    const age = before.process.fetched ? ctx.now().getTime() - new Date(before.process.fetched.fetched_at).getTime() : Infinity;
    if (age > 60_000 || before.process.fetched?.fetch_error) {
      const r = await refreshProcess(ctx, questionId);
      if (r.error) refreshNote = r.error;
    }
  }
  return tx(ctx.db, () => {
    const q = repo.getQuestion(ctx.db, space.id, questionId);
    if (!q) throw bad("Question not found");
    if (q.status !== "active") throw conflict("Only active questions can be resolved");
    const record: ResolutionRecord = {
      resolved_at: ctx.now().toISOString(),
      confirmed_by: args.confirmed_by,
      triggered_by: args.triggered_by,
      outcome: args.outcome,
      snapshot: {
        question: { title: q.title, ...(q.why_it_matters ? { why_it_matters: q.why_it_matters } : {}), ...(q.process?.framing ? { framing: q.process.framing } : {}) },
        ...(q.process ? { process: structuredClone(q.process) } : {}),
      },
    };
    if (args.synthesis) record.synthesis = args.synthesis;
    if (args.attested) record.attested = args.attested;
    q.status = "resolved";
    q.resolution_record = record;
    delete q.pending_resolution;
    delete q.default_window;
    delete q.reopen_baseline_state;
    repo.saveQuestion(ctx.db, q);
    if (refreshNote)
      repo.logEvent(ctx, {
        space_id: space.id,
        question_id: q.id,
        actor: "system",
        action: "process.refresh_failed",
        data: { error: refreshNote, note: "Snapshot uses the last fetched values" },
      });
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor: args.confirmed_by, action: "question.status_changed", data: { from: "active", to: "resolved" } });
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor: args.confirmed_by, action: "resolution.confirmed", data: { record } });
    if (q.rules_payload && args.outcome === "accepted") applyPayload(ctx, space, q);
    return q;
  });
}

export function stewardInactive(ctx: Ctx, space: Space, q: Question): boolean {
  if (!q.steward) return true;
  const last = repo.lastActionBy(ctx.db, space.id, q.steward);
  return !last || ctx.now().getTime() - new Date(last).getTime() > STEWARD_INACTIVE_DAYS * DAY_MS;
}

/** Confirm a pending resolution (spec §4.4). */
export async function confirm(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status !== "active" || !q.pending_resolution) throw conflict("There is no resolution waiting for confirmation");
  if (!canActAsSteward(q, actor) && !stewardInactive(ctx, space, q))
    throw forbidden(`Only the steward (${q.steward}) can confirm, unless they have been inactive for ${STEWARD_INACTIVE_DAYS} days`);
  let outcome = q.pending_resolution.suggested_outcome ?? "concluded";
  if (body?.outcome != null) {
    if (!TERMINAL_STATES.includes(body.outcome)) throw bad(`Outcome must be one of: ${TERMINAL_STATES.join(", ")}`);
    outcome = body.outcome;
  }
  return resolve(ctx, space, q.id, {
    triggered_by: q.pending_resolution.triggered_by,
    confirmed_by: actor,
    outcome,
    synthesis: trimOrUndef(body?.synthesis, 10_000),
  });
}

/** Steward attests a described condition (spec §4.4). */
export async function attest(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (q.status !== "active") throw conflict("Only active questions can be resolved");
  const c = q.resolution.criteria.find((c) => c.kind === "attested");
  if (!c) throw bad("This question has no attestation criterion");
  if (!canActAsSteward(q, actor)) throw forbidden(`Only the steward (${q.steward}) can attest`);
  const attested = requireText(body?.attested, "What you are attesting", 2000);
  let outcome: NormalizedState = "accepted";
  if (body?.outcome != null) {
    if (!TERMINAL_STATES.includes(body.outcome)) throw bad(`Outcome must be one of: ${TERMINAL_STATES.join(", ")}`);
    outcome = body.outcome;
  }
  return resolve(ctx, space, q.id, { triggered_by: "attested", confirmed_by: actor, outcome, attested, synthesis: trimOrUndef(body?.synthesis, 10_000) });
}

/** Anyone may object to a default-rule resolution, with a reason (spec §4.3). */
export function object(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  const reason = requireText(body?.reason, "A reason", 5000);
  if (q.status !== "active" || !q.default_window) throw conflict("Objections apply to active questions using the default rule");
  return tx(ctx.db, () => {
    const now = ctx.now();
    const w = q.default_window!;
    if (w.paused_remaining_ms == null) w.paused_remaining_ms = Math.max(new Date(w.ends_at).getTime() - now.getTime(), 0);
    const o = { id: newId(), question_id: q.id, raised_by: actor, raised_at: now.toISOString(), reason };
    repo.insertObjection(ctx.db, space.id, o);
    if (q.pending_resolution?.triggered_by === "default_rule") {
      delete q.pending_resolution;
      repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor: "system", action: "resolution.cancelled", data: { reason: "objection raised" } });
    }
    repo.saveQuestion(ctx.db, q);
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor, action: "objection.raised", data: { objection_id: o.id, reason } });
    return q;
  });
}

/** The steward addresses an objection. When none remain, the window resumes (spec §4.3). */
export function address(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  const note = requireText(body?.note, "A note on how the objection was addressed", 5000);
  if (!canActAsSteward(q, actor)) throw forbidden(`Only the steward (${q.steward}) can address objections`);
  const o = repo.listObjections(ctx.db, q.id).find((o) => o.id === body?.objection_id);
  if (!o) throw bad("Objection not found");
  if (o.addressed_at) throw conflict("This objection was already addressed");
  return tx(ctx.db, () => {
    const now = ctx.now();
    repo.addressObjection(ctx.db, o.id, actor, now.toISOString(), note);
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor, action: "objection.addressed", data: { objection_id: o.id, note } });
    const w = q.default_window;
    if (w && openObjections(ctx, q) === 0) {
      const days = windowDays(space, q) ?? space.settings.default_rule_days;
      let remaining = w.paused_remaining_ms ?? days * DAY_MS;
      if (remaining < MIN_REMAINING_MS) remaining = days * DAY_MS;
      q.default_window = { opened_at: w.opened_at, ends_at: new Date(now.getTime() + remaining).toISOString() };
      repo.saveQuestion(ctx.db, q);
      repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor: "system", action: "objection_window.resumed", data: { ends_at: q.default_window.ends_at } });
    }
    return q;
  });
}

// ---------- scheduled jobs ----------

export async function evaluateAll(ctx: Ctx) {
  for (const q of repo.listQuestionsByStatus(ctx.db, "active")) {
    const space = repo.getSpace(ctx.db, q.space_id);
    if (!space) continue;
    try {
      await evaluateQuestion(ctx, space, q.id);
    } catch (e) {
      console.error(`evaluate ${q.id}:`, (e as Error).message);
    }
  }
}

/** Move inactive active/standing questions to dormant (spec §3). */
export function dormancySweep(ctx: Ctx) {
  const now = ctx.now().getTime();
  let moved = 0;
  for (const status of ["active", "standing"] as const) {
    for (const q of repo.listQuestionsByStatus(ctx.db, status)) {
      const space = repo.getSpace(ctx.db, q.space_id);
      if (!space) continue;
      if (now - new Date(q.last_activity_at).getTime() <= space.settings.dormancy_days * DAY_MS) continue;
      tx(ctx.db, () => {
        q.status = "dormant";
        delete q.pending_resolution;
        delete q.default_window;
        repo.saveQuestion(ctx.db, q);
        repo.logEvent(ctx, {
          space_id: space.id,
          question_id: q.id,
          actor: "system",
          action: "question.status_changed",
          data: { from: status, to: "dormant", reason: `No activity for ${space.settings.dormancy_days} days` },
        });
      });
      moved++;
    }
  }
  return moved;
}

