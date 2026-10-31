// A question's fields, each retrieved or typed.
//
// Retrieved values come from the linked item, through a tool on the tool list: automatic tools give
// everything their platform exposes (title, status, summary, dates…); tools updated by hand give the
// item type (from the URL pattern) and the page title. Links to sites not on the list, and processes
// without a link, give nothing: their fields are typed.
//
// Typed values live in `Question.typed` and win over retrieved ones until someone chooses "use
// retrieved". The effective title and status are also stored on the question (search, counts) and
// kept in step by `sync`.
import type { Ctx } from "./ctx.ts";
import type { DateValue, Field, Question, QuestionState, Space, TypedStatus, TypedValue } from "./types.ts";
import { CUSTOM_TOOL_ID, FIELDS, isQuestionState } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { bad, HttpError, isHttpsUrl, requireText } from "./util.ts";

// ---------- date values ----------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isDay = (v: string) => DAY_RE.test(v);

/** "2026-03-01" (a whole day, kept as is) or a moment (normalised to ISO UTC). Throws on anything else. */
export function parseDateValue(v: unknown, label = "date"): DateValue {
  const s = typeof v === "string" ? v.trim() : "";
  const m = DAY_RE.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw bad(`Invalid ${label}`);
    return s;
  }
  const d = s.length >= 10 && s.length <= 40 && s.includes("T") ? new Date(s) : new Date(NaN);
  if (isNaN(d.getTime())) throw bad(`Invalid ${label}`);
  return d.toISOString();
}

/** Earliest / latest moment a value can mean (a whole day spans 24 h; time zones are ignored for this check). */
export const lowerBound = (v: DateValue) => (isDay(v) ? `${v}T00:00:00.000Z` : v);
export const upperBound = (v: DateValue) => (isDay(v) ? `${v}T23:59:59.999Z` : v);

// ---------- retrieved values ----------

export type Retrieved = {
  title?: string;
  kind?: string;
  /** `as`: the platform's own word, when it was mapped onto a category ("merged" → Accepted). */
  status?: { state: QuestionState; as?: string };
  summary?: string;
  results_url?: string;
  start?: DateValue;
  end?: DateValue;
};

/** Which fields the linked item can give at all (whether or not it has a value right now). */
export function retrievable(q: Question): Set<Field> {
  const p = q.process;
  if (!p || p.tool_id === CUSTOM_TOOL_ID) return new Set();
  if (p.fetch_mode !== "auto") return new Set(["title", "kind"]);
  return new Set(["title", "kind", "status", "summary", "results_url", "start", "end"]);
}

/** What the linked item gives. From the process: start = opened, end = ended, else planned closing. */
export function retrieved(q: Question): Retrieved {
  const can = retrievable(q);
  const p = q.process;
  const f = p?.fetched;
  const out: Retrieved = {};
  if (!p || !can.size) return out;
  if (p.item_type) out.kind = p.item_type;
  if (f?.title) out.title = f.title;
  if (can.has("status") && f && isQuestionState(f.state)) out.status = { state: f.state, ...(f.raw_state ? { as: f.raw_state } : {}) };
  if (can.has("summary") && f?.outcome_summary) out.summary = f.outcome_summary;
  if (can.has("results_url") && typeof f?.extra?.results_url === "string") out.results_url = f.extra.results_url;
  if (can.has("start") && f?.dates?.opens_at) out.start = f.dates.opens_at;
  const end = f?.dates?.resolved_at ?? f?.dates?.closes_at;
  if (can.has("end") && end) out.end = end;
  return out;
}

// ---------- views ----------

export type FieldView = {
  /** The value in use. `null`: typed as "none". Absent: nothing typed or retrieved. */
  value?: unknown;
  source: "typed" | "retrieved" | "empty";
  /** The retrieved value, also when a typed one is in use. */
  retrieved?: unknown;
  /** The platform's word for a mapped status ("merged"). */
  as?: string;
  /** Typed by whom, when. */
  by?: string;
  at?: string;
  /** Whether the linked item can give this field. */
  retrievable: boolean;
};
export type FieldViews = Record<Field, FieldView>;

export function fieldViews(q: Question): FieldViews {
  const r = retrieved(q);
  const can = retrievable(q);
  const out = {} as FieldViews;
  for (const f of FIELDS) {
    const t = q.typed?.[f];
    const rv = f === "status" ? r.status && { state: r.status.state } : r[f];
    const v: FieldView = { source: "empty", retrievable: can.has(f) };
    if (rv !== undefined) v.retrieved = rv;
    if (f === "status" && r.status?.as) v.as = r.status.as;
    if (t) Object.assign(v, { value: t.value, source: "typed", by: t.by, at: t.at });
    else if (rv !== undefined) Object.assign(v, { value: rv, source: "retrieved" });
    out[f] = v;
  }
  // Title and status always have a value: the stored one when nothing else applies.
  if (out.title.value === undefined) out.title.value = q.title;
  if (out.status.value === undefined) out.status.value = { state: q.status };
  return out;
}

export const withFields = <T extends Question>(q: T): T & { fields: FieldViews } => ({ ...q, fields: fieldViews(q) });

/** The start and end in use (none when typed as none), for the timeline. */
export function effectiveDates(q: Question): { start?: { value: DateValue; source: "typed" | "retrieved" }; end?: { value: DateValue; source: "typed" | "retrieved" } } {
  const v = fieldViews(q);
  const one = (f: FieldView) => (typeof f.value === "string" ? { value: f.value, source: f.source as "typed" | "retrieved" } : undefined);
  const out: ReturnType<typeof effectiveDates> = {};
  const s = one(v.start);
  const e = one(v.end);
  if (s) out.start = s;
  if (e) out.end = e;
  return out;
}

// ---------- keeping title and status in step ----------

/** The label the space uses for a category (its first one), or the category id. */
export function labelFor(space: Space | undefined, state: string): string {
  return space?.settings.status_labels.find((l) => l.state === state)?.label ?? state;
}

/**
 * Recompute the stored title and status from the typed and retrieved values; save and log if they changed.
 * Retrieval-driven changes are logged as `system` (`question.edited` / `question.status_changed`).
 * Runs inside a transaction. Callers that changed `typed` save the question themselves.
 */
export function sync(ctx: Ctx, q: Question, actor = "system", log = true) {
  const r = retrieved(q);
  const t = q.typed ?? {};
  const title = (t.title?.value as string | undefined) ?? r.title ?? q.title;
  const ts = t.status?.value as TypedStatus | undefined;
  const status: QuestionState = ts?.state ?? r.status?.state ?? q.status ?? "not_started";
  const label = ts?.label;
  const before = { title: q.title, status: q.status, label: q.status_label };
  if (before.title === title && before.status === status && before.label === label) return;
  q.title = title;
  q.status = status;
  if (label) q.status_label = label;
  else delete q.status_label;
  repo.saveQuestion(ctx.db, q);
  if (!log) return;
  const ev = (action: string, data: Record<string, unknown>) => repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action, data });
  if (before.title !== title) ev("question.edited", { title: { before: before.title, after: title }, source: "retrieved" });
  if (before.status !== status || before.label !== label) ev("question.status_changed", { from: before.status, to: status, source: ts ? "typed" : "retrieved", ...(label ? { label } : {}) });
}

/**
 * Type the current title and status when the item can no longer give them (process removed, made
 * private, not retrievable), so they don't change or vanish. Doesn't log or save.
 */
export function freezeUnretrievable(space: Space | undefined, q: Question, actor: string, at: string) {
  const can = retrievable(q);
  q.typed ??= {};
  if (!q.typed.title && !(can.has("title") && retrieved(q).title)) q.typed.title = { value: q.title, by: actor, at };
  if (!q.typed.status && !can.has("status")) q.typed.status = { value: { state: q.status, label: q.status_label ?? labelFor(space, q.status) }, by: actor, at };
}

// ---------- typing values ----------

const TEXT_MAX: Partial<Record<Field, number>> = { title: 300, kind: 60, summary: 300, results_url: 2000 };

/** The fields that can be typed along with a new question (title, kind and status have their own parameters). */
const CREATE_FIELDS = ["summary", "results_url", "start", "end"] as const;

export function resolveStatus(space: Space, v: any): TypedStatus {
  const label = typeof v?.label === "string" ? v.label.trim() : "";
  if (label) {
    const hit = space.settings.status_labels.find((l) => l.label.toLowerCase() === label.toLowerCase());
    if (!hit) throw bad(`Unknown status "${label}"`);
    return { state: hit.state, label: hit.label };
  }
  if (!isQuestionState(v?.state)) throw bad("Choose a status");
  return { state: v.state, label: labelFor(space, v.state) };
}

/** Validate one typed value. Empty optional values become `null` ("none"). */
function parseValue(space: Space, f: Field, v: unknown): string | TypedStatus | null {
  if (f === "status") return resolveStatus(space, v);
  if (f === "title") return requireText(v, "Title", TEXT_MAX.title!);
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  if (f === "start" || f === "end") return parseDateValue(v, f === "start" ? "start date" : "end date");
  const s = String(v).trim();
  if (s.length > TEXT_MAX[f]!) throw bad(`Keep the ${f.replace("_", " ")} under ${TEXT_MAX[f]} characters`);
  // Results: a link, or a few words ("Adopted 9–1"). Only a value that looks like a link must be a safe one.
  if (f === "results_url" && /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !isHttpsUrl(s)) throw bad("A results link must be an https:// URL");
  return s;
}

/** An end before the start, when one of them is typed. */
function assertDatesInOrder(q: Question) {
  const d = effectiveDates(q);
  if (d.start && d.end && (d.start.source === "typed" || d.end.source === "typed") && upperBound(d.end.value) < lowerBound(d.start.value))
    throw bad("The end date is before the start date");
}

/** Validate the optional values typed along with a new question (`fields`). Empty ones are left to the item. */
export function parseCreateFields(space: Space, v: unknown): Partial<Record<(typeof CREATE_FIELDS)[number], string>> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad("Invalid fields");
  for (const f of Object.keys(v)) if (!(CREATE_FIELDS as readonly string[]).includes(f)) throw bad(`Can't set "${f}" here`);
  const out: Partial<Record<(typeof CREATE_FIELDS)[number], string>> = {};
  for (const f of CREATE_FIELDS) {
    const value = parseValue(space, f, (v as any)[f]);
    if (typeof value === "string") out[f] = value;
  }
  return out;
}

/** Type the values given with a new question. `q.process` must already be set when it has one. */
export function typeCreateFields(q: Question, actor: string, at: string, values: ReturnType<typeof parseCreateFields>) {
  for (const [f, value] of Object.entries(values) as [Field, string][]) q.typed[f] = { value, by: actor, at };
  assertDatesInOrder(q);
}

export type FieldsBody = { set?: Partial<Record<Field, unknown>>; use_retrieved?: Field[]; note?: string };

/**
 * Type values (`set`), or go back to the retrieved ones (`use_retrieved`). Logged as
 * `question.fields_changed` with each changed field's before/after (`{source, value}`).
 * `assertTitle` checks a typed title against other questions (duplicates).
 */
export function setFields(ctx: Ctx, space: Space, q: Question, actor: string, body: FieldsBody, assertTitle: (t: string) => void): Question {
  const set = body?.set ?? {};
  const back = body?.use_retrieved ?? [];
  if (typeof set !== "object" || !Array.isArray(back)) throw bad("Invalid fields");
  for (const f of [...Object.keys(set), ...back]) if (!FIELDS.includes(f as Field)) throw bad(`Unknown field "${f}"`);
  if (set.kind !== undefined && !q.process) throw bad("Link a process first: the kind is the kind of process");
  const now = ctx.now().toISOString();
  const can = retrievable(q);
  const r = retrieved(q);
  const next = structuredClone(q.typed ?? {});
  for (const [f, v] of Object.entries(set) as [Field, unknown][]) {
    const value = parseValue(space, f, v);
    // Clearing a field the item can't give simply removes the typed value.
    if (value === null && !can.has(f)) delete next[f];
    else next[f] = { value, by: actor, at: now };
  }
  for (const f of back) {
    if (f === "title" && !r.title) throw bad("No title was retrieved for this item");
    if (f === "status" && !can.has("status")) throw bad("This item's status can't be retrieved");
    delete next[f];
  }
  const newTitle = (next.title?.value as string | undefined) ?? r.title ?? q.title;
  if (newTitle !== q.title) assertTitle(newTitle);
  assertDatesInOrder({ ...q, typed: next });

  const snap = (t: TypedValue | undefined) => (t ? { source: "typed", value: t.value } : { source: "retrieved" });
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of FIELDS) {
    const [b, a] = [snap(q.typed?.[f]), snap(next[f])];
    if (JSON.stringify(b) !== JSON.stringify(a)) changes[f] = { before: b, after: a };
  }
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : undefined;
  if (!Object.keys(changes).length) return q;
  tx(ctx.db, () => {
    q.typed = next;
    repo.saveQuestion(ctx.db, q);
    sync(ctx, q, actor, false);
    repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action: "question.fields_changed", data: { fields: changes, ...(note ? { note } : {}) } });
  });
  return q;
}

/** Duplicate-title errors share their shape with question creation. */
export function duplicateTitleError(existing: { id: string; title: string }) {
  const e = new HttpError(409, "duplicate_title", `“${existing.title}” is already in the register.`);
  (e as any).details = { existing: { id: existing.id, title: existing.title } };
  return e;
}
