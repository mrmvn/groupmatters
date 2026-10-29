// Resolution criteria: validation and (pure) evaluation. Spec §2.4, §4.1.
import type { Criterion, CriterionKind, NormalizedState, Question, Resolution, Status } from "./types.ts";
import { CRITERION_KINDS, NORMALIZED_STATES, TERMINAL_STATES } from "./types.ts";
import { bad, requireText } from "./util.ts";

export function validateCriterion(c: any): Criterion {
  if (!c || typeof c !== "object") throw bad("Invalid criterion");
  switch (c.kind) {
    case "process_outcome": {
      if (c.accept_states == null || (Array.isArray(c.accept_states) && c.accept_states.length === 0)) return { kind: "process_outcome" };
      if (!Array.isArray(c.accept_states)) throw bad("accept_states must be a list");
      for (const st of c.accept_states)
        if (!TERMINAL_STATES.includes(st)) throw bad(`"${st}" is not a final state (use: ${TERMINAL_STATES.join(", ")})`);
      return { kind: "process_outcome", accept_states: [...new Set(c.accept_states as NormalizedState[])] };
    }
    case "date": {
      const d = new Date(c.at);
      if (typeof c.at !== "string" || isNaN(d.getTime())) throw bad("A date criterion needs a valid date");
      return { kind: "date", at: d.toISOString() };
    }
    case "default_rule": {
      if (c.days == null || c.days === "") return { kind: "default_rule" };
      const days = Number(c.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw bad("Objection window must be 1–365 days");
      return { kind: "default_rule", days };
    }
    case "attested":
      return { kind: "attested", description: requireText(c.description, "What the steward will attest", 1000) };
    default:
      throw bad(`Unknown criterion kind "${c.kind}" (use: ${CRITERION_KINDS.join(", ")})`);
  }
}

export function validateResolution(input: any, opts: { hasProcess: boolean; section: "main" | "rules" }): Resolution {
  if (!input || typeof input !== "object") throw bad("Invalid resolution");
  const mode = input.mode;
  if (mode !== "tbd" && mode !== "open" && mode !== "criteria") throw bad('Resolution mode must be "tbd", "open" or "criteria"');
  if (mode !== "criteria") {
    if (Array.isArray(input.criteria) && input.criteria.length) throw bad(`Criteria must be empty when the mode is "${mode}"`);
    return { mode, criteria: [] };
  }
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) throw bad("Add at least one criterion");
  const criteria = input.criteria.map(validateCriterion);
  const seen = new Set<CriterionKind>();
  for (const c of criteria) {
    if (seen.has(c.kind)) throw bad(`Only one "${c.kind}" criterion per question`);
    seen.add(c.kind);
  }
  if (seen.has("process_outcome") && !opts.hasProcess) throw bad("“When the process reaches an outcome” needs a linked process");
  if (opts.section === "rules" && !seen.has("default_rule"))
    throw bad("Questions in the Rules space use the default rule (objection window)");
  return { mode, criteria };
}

/** Is this resolution mode allowed while the question has this status? (spec §2.2, §3) */
export function modeAllowed(status: Status, mode: Resolution["mode"]): boolean {
  switch (status) {
    case "active":
      return mode === "criteria";
    case "standing":
      return mode === "open";
    case "resolved":
      return mode === "criteria";
    default:
      return true; // inbox, dormant, dropped: anything, including tbd
  }
}

export type Met = { kind: CriterionKind; suggested_outcome: NormalizedState };

export const defaultWindowState = (q: Question, now: Date, openObjections: number) => {
  const w = q.default_window;
  if (!w) return { state: "none" as const };
  if (openObjections > 0 || w.paused_remaining_ms != null) return { state: "paused" as const, remaining_ms: w.paused_remaining_ms };
  const left = new Date(w.ends_at).getTime() - now.getTime();
  return left <= 0 ? { state: "elapsed" as const } : { state: "running" as const, remaining_ms: left };
};

/** First met criterion in list order, or null. `attested` is never met automatically. */
export function evaluate(q: Question, now: Date, openObjections: number): Met | null {
  if (q.status !== "active" || q.resolution.mode !== "criteria") return null;
  const f = q.process?.fetched;
  for (const c of q.resolution.criteria) {
    switch (c.kind) {
      case "process_outcome": {
        if (!f?.terminal) break;
        if (c.accept_states && !c.accept_states.includes(f.state)) break;
        if (q.reopen_baseline_state && f.state === q.reopen_baseline_state) break; // already counted before reopening
        return { kind: c.kind, suggested_outcome: f.state };
      }
      case "date": {
        const at = new Date(c.at).getTime();
        if (now.getTime() < at) break;
        if (q.reopened_at && at <= new Date(q.reopened_at).getTime()) break; // a past date doesn't re-trigger after reopening
        return { kind: c.kind, suggested_outcome: f?.terminal ? f.state : "concluded" };
      }
      case "default_rule": {
        if (defaultWindowState(q, now, openObjections).state === "elapsed") return { kind: c.kind, suggested_outcome: "accepted" };
        break;
      }
      case "attested":
        break;
    }
  }
  return null;
}

export const isNormalizedState = (s: unknown): s is NormalizedState => NORMALIZED_STATES.includes(s as NormalizedState);
