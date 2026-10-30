// Dashboard: summaries of a space, computed on demand from questions and the activity log.
// Prototype widgets: the UI lets each person hide the ones they don't want (see public/dashboard.js).
import type { Ctx } from "./ctx.ts";
import type { ActivityEvent, Question, QuestionState, Space } from "./types.ts";
import { CUSTOM_TOOL_ID, QUESTION_STATES } from "./types.ts";
import * as repo from "./repo.ts";
import { list } from "./search.ts";
import { withFields } from "./fields.ts";
import { DAY_MS } from "./util.ts";

const ENDED: readonly QuestionState[] = ["accepted", "rejected", "concluded"];
const isEnded = (s: string) => (ENDED as readonly string[]).includes(s);
/** Entries in the activity log that aren't a person. */
const NOT_PEOPLE = new Set(["system", "operator", "anonymous"]);
const WEEKS = 12;

/**
 * Does this event move a question into an ended status? Retrieved changes are `question.status_changed`;
 * statuses typed by someone are a `question.fields_changed` with the new status in `fields.status.after`.
 */
function movesToEnded(e: ActivityEvent): boolean {
  const d = e.data as any;
  if (e.action === "question.status_changed") return isEnded(d.to);
  if (e.action !== "question.fields_changed") return false;
  const { before, after } = d.fields?.status ?? {};
  return after?.source === "typed" && isEnded(after.value?.state) && !(before?.source === "typed" && isEnded(before.value?.state));
}

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}
const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type Milestone = { id: string; label: string; hint: string; done: boolean; value: number; target: number };

export function dashboard(ctx: Ctx, space: Space, opts: { you?: string; since?: string } = {}) {
  const now = ctx.now();
  const questions = repo.listQuestions(ctx.db, space.id);
  const live = new Map(questions.map((q) => [q.id, q]));
  const events = repo.allActivity(ctx.db, space.id).filter((e) => !e.question_id || live.has(e.question_id));
  const human = events.filter((e) => !NOT_PEOPLE.has(e.actor));

  // ---- status summary ----
  const by_status = Object.fromEntries(QUESTION_STATES.map((s) => [s, 0])) as Record<QuestionState, number>;
  for (const q of questions) by_status[q.status]++;

  // ---- tools ----
  const toolName = new Map(repo.listTools(ctx.db, space.id).map((t) => [t.id, t.name]));
  type Row = { id: string; name: string; custom: boolean; questions: number; in_progress: number; ended: number };
  const rows = new Map<string, Row>();
  const bump = (id: string, name: string, custom: boolean, q: Question) => {
    const r = rows.get(id) ?? { id, name, custom, questions: 0, in_progress: 0, ended: 0 };
    r.questions++;
    if (q.status === "open") r.in_progress++;
    if (isEnded(q.status)) r.ended++;
    rows.set(id, r);
  };
  let without_process = 0;
  for (const q of questions) {
    const p = q.process;
    if (!p) {
      without_process++;
      continue;
    }
    if (p.tool_id === CUSTOM_TOOL_ID) {
      const kind = (q.typed.kind?.value as string | undefined)?.trim() || "Other";
      bump(`custom:${kind.toLowerCase()}`, kind, true, q);
    } else bump(p.tool_id, toolName.get(p.tool_id) ?? p.tool_id, false, q);
  }
  const toolRows = [...rows.values()].sort((a, b) => b.questions - a.questions || a.name.localeCompare(b.name));
  const unused_tools = repo.listTools(ctx.db, space.id).filter((t) => t.enabled && !rows.has(t.id)).map((t) => ({ id: t.id, name: t.name }));

  // ---- kinds of item (poll, pull request, meeting…) ----
  const kinds = new Map<string, number>();
  for (const q of questions) {
    const k = withFields(q).fields.kind.value;
    const key = typeof k === "string" && k ? k : "none";
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const item_types = [...kinds].map(([kind, n]) => ({ kind, questions: n })).sort((a, b) => b.questions - a.questions || a.kind.localeCompare(b.kind));

  // ---- answered questions ----
  // When a question was answered: the last change into an ended status (none if it arrived already ended).
  const answeredAt = new Map<string, { at: string; logged: boolean }>();
  for (const q of questions) {
    if (!isEnded(q.status)) continue;
    const ev = events.findLast((e) => e.question_id === q.id && movesToEnded(e));
    answeredAt.set(q.id, ev ? { at: ev.at, logged: true } : { at: q.created_at, logged: false });
  }
  const answered = [...answeredAt].map(([id, a]) => ({ q: live.get(id)!, ...a })).sort((a, b) => (a.at < b.at ? 1 : -1));
  const recent_answers = answered.slice(0, 5).map(({ q, at }) => ({ id: q.id, title: q.title, status: q.status, ...(q.status_label ? { status_label: q.status_label } : {}), at }));
  const days_to_answer = median(answered.filter((a) => a.logged).map((a) => (Date.parse(a.at) - Date.parse(live.get(a.q.id)!.created_at)) / DAY_MS));

  // ---- weeks and days ----
  const thisWeek = weekStart(now);
  const first = new Date(thisWeek.getTime() - (WEEKS - 1) * 7 * DAY_MS);
  const weekIndex = (iso: string) => Math.floor((weekStart(new Date(iso)).getTime() - first.getTime()) / (7 * DAY_MS));
  const weekly = Array.from({ length: WEEKS }, (_, i) => ({ start: day(new Date(first.getTime() + i * 7 * DAY_MS)), added: 0, answered: 0, actions: 0 }));
  for (const e of events) if (e.action === "question.created") weekly[weekIndex(e.at)] && weekly[weekIndex(e.at)].added++;
  for (const a of answered) weekly[weekIndex(a.at)] && weekly[weekIndex(a.at)].answered++;
  for (const e of human) weekly[weekIndex(e.at)] && weekly[weekIndex(e.at)].actions++;

  const perDay = new Map<string, number>();
  for (const e of human) perDay.set(e.at.slice(0, 10), (perDay.get(e.at.slice(0, 10)) ?? 0) + 1);
  const today = day(now);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = day(new Date(first.getTime() + i * DAY_MS));
    return { date: d, n: perDay.get(d) ?? 0, future: d > today };
  });

  // ---- streak: consecutive weeks with some human activity ----
  const activeWeeks = new Set(human.map((e) => day(weekStart(new Date(e.at)))));
  const wk = (i: number) => day(new Date(thisWeek.getTime() + i * 7 * DAY_MS));
  let current = 0;
  for (let i = activeWeeks.has(wk(0)) ? 0 : -1; activeWeeks.has(wk(i)); i--) current++;
  let best = 0;
  if (activeWeeks.size) {
    const sorted = [...activeWeeks].sort();
    let run = 0;
    let prev = 0;
    for (const w of sorted) {
      const t = Date.parse(w);
      run = prev && t - prev === 7 * DAY_MS ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    }
  }

  // ---- people ----
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  type Person = { name: string; actions: number; added: number; answered: number };
  const person = (evs: ActivityEvent[]): Map<string, Person> => {
    const m = new Map<string, Person>();
    for (const e of evs) {
      const p = m.get(e.actor) ?? { name: e.actor, actions: 0, added: 0, answered: 0 };
      p.actions++;
      if (e.action === "question.created") p.added++;
      if (movesToEnded(e)) p.answered++;
      m.set(e.actor, p);
    }
    return m;
  };
  const recent = [...person(human.filter((e) => e.at > monthAgo)).values()].sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  const everyone = person(human);
  const contributors = everyone.size;

  const youName = opts.you?.trim().toLowerCase();
  let you = null as null | (Person & { last_30_days: number; rank?: number; of: number; first_at?: string });
  if (youName) {
    const total = [...everyone.values()].find((p) => p.name.toLowerCase() === youName);
    const idx = recent.findIndex((p) => p.name.toLowerCase() === youName);
    const mine = human.filter((e) => e.actor.toLowerCase() === youName);
    you = {
      name: total?.name ?? opts.you!.trim(),
      actions: total?.actions ?? 0,
      added: total?.added ?? 0,
      answered: total?.answered ?? 0,
      last_30_days: idx >= 0 ? recent[idx].actions : 0,
      ...(idx >= 0 ? { rank: idx + 1 } : {}),
      of: recent.length,
      ...(mine[0] ? { first_at: mine[0].at } : {}),
    };
  }

  // ---- needs attention ----
  const count = (preset: string) => list(ctx, space, { preset }).length;
  const quietCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const oldestOpen = questions
    .filter((q) => q.status === "open" || q.status === "not_started")
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
  const attention = {
    no_process: count("no_process"),
    quiet: count("quiet"),
    fetch_problems: count("fetch_problems"),
    ...(oldestOpen ? { oldest_open: { id: oldestOpen.id, title: oldestOpen.title, days: Math.floor((now.getTime() - Date.parse(oldestOpen.created_at)) / DAY_MS) } } : {}),
  };

  // ---- this month ----
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const month = {
    start: monthStart.slice(0, 10),
    added: events.filter((e) => e.action === "question.created" && e.at >= monthStart).length,
    answered: answered.filter((a) => a.at >= monthStart).length,
  };

  // ---- milestones ----
  const withProcess = questions.length - without_process;
  const milestones: Milestone[] = [
    { id: "first", label: "First question", hint: "Add a question", value: questions.length, target: 1 },
    { id: "ten", label: "10 questions", hint: "Ten questions in the register", value: questions.length, target: 10 },
    { id: "answered", label: "First answer", hint: "A question accepted, rejected or concluded", value: answered.length, target: 1 },
    { id: "five-answered", label: "5 answered", hint: "Five questions answered", value: answered.length, target: 5 },
    { id: "linked", label: "Linked up", hint: "Five questions linked to a process", value: withProcess, target: 5 },
    { id: "team", label: "Team effort", hint: "Three people have contributed", value: contributors, target: 3 },
    { id: "streak", label: "4-week streak", hint: "Activity four weeks in a row", value: best, target: 4 },
    { id: "tidy", label: "Nothing quiet", hint: "No in-progress question quiet for 30+ days (needs 5+ questions)", value: questions.length >= 5 && !attention.quiet ? 1 : 0, target: 1 },
  ].map((m) => ({ ...m, done: m.value >= m.target }));

  const since = opts.since && !Number.isNaN(Date.parse(opts.since)) ? opts.since : undefined;
  return {
    now: now.toISOString(),
    totals: { questions: questions.length, answered: answered.length, with_process: withProcess, without_process, contributors, quiet_cutoff: quietCutoff.slice(0, 10) },
    by_status,
    tools: toolRows,
    unused_tools,
    item_types,
    weekly,
    days,
    streak: { current, best },
    month,
    days_to_answer: days_to_answer === undefined ? null : Math.round(days_to_answer * 10) / 10,
    recent_answers,
    people: recent.slice(0, 5),
    you,
    attention,
    milestones,
    ...(since ? { since: { changed: questions.filter((q) => q.last_activity_at > since).length } } : {}),
  };
}
