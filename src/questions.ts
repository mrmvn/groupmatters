// Questions: creation, edits, status, process and relations. All rules enforced here, server-side.
//
// Status: every question has a category (QUESTION_STATES). It either follows the linked process
// (`status_source: "process"`) or is set by hand from the space's status labels ("manual").
// Attaching a process makes the question follow it; anyone can switch back to setting it by hand.
import type { Ctx } from "./ctx.ts";
import type { Question, QuestionState, RelationKind, Space } from "./types.ts";
import { isQuestionState, RELATION_KINDS } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { duplicateLinkError, findQuestionWithLink, followProcess, labelFor, prepareProcess, storeProcess } from "./processes.ts";
import { bad, conflict, HttpError, newId, notFound, requireText, trimOrUndef } from "./util.ts";

const TITLE_MAX = 300;

function log(ctx: Ctx, q: Question, actor: string, action: string, data: Record<string, unknown> = {}) {
  repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action, data });
}

export function load(ctx: Ctx, space: Space, id: string): Question {
  const q = repo.getQuestion(ctx.db, space.id, String(id));
  if (!q) throw notFound("Question not found");
  return q;
}

/** Resolve a hand-set status from `{label}` or `{state}` against the space's labels. */
export function resolveManualStatus(space: Space, body: any): { state: QuestionState; label: string } {
  const label = trimOrUndef(body?.label, 80);
  if (label) {
    const hit = space.settings.status_labels.find((l) => l.label.toLowerCase() === label.toLowerCase());
    if (!hit) throw bad(`Unknown status "${label}"`);
    return { state: hit.state, label: hit.label };
  }
  if (!isQuestionState(body?.state)) throw bad("Choose a status");
  return { state: body.state, label: labelFor(space, body.state) };
}

/** Titles compared without case, accents, punctuation or extra spaces. */
export const normalizeTitle = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Refuse a title another (non-removed) question already has. */
function assertTitleFree(ctx: Ctx, space: Space, title: string, excludeId?: string) {
  const n = normalizeTitle(title);
  const existing = repo.listQuestions(ctx.db, space.id).find((q) => q.id !== excludeId && normalizeTitle(q.title) === n);
  if (!existing) return;
  const e = new HttpError(409, "duplicate_title", `“${existing.title}” is already in the register.`);
  (e as any).details = { existing: { id: existing.id, title: existing.title } };
  throw e;
}

/** Refuse a link another (non-removed) question already tracks. */
function assertLinkFree(ctx: Ctx, space: Space, url: string | undefined, toolId: string | undefined, excludeId?: string) {
  if (!url || toolId === "custom") return;
  const existing = findQuestionWithLink(ctx, space, url, excludeId);
  if (existing) throw duplicateLinkError(existing);
}

function validateRelated(ctx: Ctx, space: Space, q: { id?: string }, otherId: unknown): Question | undefined {
  if (otherId == null || otherId === "") return undefined;
  const oid = String(otherId);
  if (oid === q.id) throw bad("A question can't be related to itself");
  const other = repo.getQuestion(ctx.db, space.id, oid);
  if (!other || other.removed_at) throw bad("Related question not found");
  return other;
}

/**
 * Create a question. Optional: a process (`process_url` + `framing`, or `process: {custom: …}`),
 * a related question (`related_id`), a hand-set status (`status: {label}|{state}`).
 */
export async function create(ctx: Ctx, space: Space, actor: string, body: any): Promise<Question> {
  const title = requireText(body?.title, "Title", TITLE_MAX);
  const why = trimOrUndef(body?.why_it_matters, 5000);
  // `parent_id` is the pre-relations name, still accepted.
  const related = validateRelated(ctx, space, {}, body?.related_id ?? body?.parent_id);
  const processUrl = trimOrUndef(body?.process_url, 2000);
  const processBody = body?.process ?? (processUrl ? { url: processUrl, framing: body?.framing } : undefined);
  assertTitleFree(ctx, space, title);
  if (processBody && !processBody.custom) assertLinkFree(ctx, space, String(processBody.url ?? "").trim(), undefined);
  const prepared = processBody ? await prepareProcess(ctx, space, processBody) : undefined;
  const manual = body?.status ? resolveManualStatus(space, body.status) : { state: "not_started" as const, label: labelFor(space, "not_started") };

  const now = ctx.now().toISOString();
  const q: Question = {
    id: newId(),
    space_id: space.id,
    title,
    status: manual.state,
    status_source: "manual",
    status_label: manual.label,
    created_at: now,
    created_by: actor,
    last_activity_at: now,
  };
  if (why) q.why_it_matters = why;
  if (prepared && !body?.status) {
    q.status_source = "process";
    delete q.status_label;
  }

  tx(ctx.db, () => {
    repo.insertQuestion(ctx.db, q);
    log(ctx, q, actor, "question.created", {
      title,
      ...(why ? { why_it_matters: why } : {}),
      ...(related ? { related_id: related.id } : {}),
      status: q.status,
      status_source: q.status_source,
      ...(q.status_label ? { label: q.status_label } : {}),
    });
    if (related) insertRelation(ctx, space, q, related, actor);
    if (prepared) {
      storeProcess(ctx, q, actor, prepared);
      followProcess(ctx, q.id, actor);
    }
  });
  return load(ctx, space, q.id);
}

export function edit(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (body?.title !== undefined) {
    const t = requireText(body.title, "Title", TITLE_MAX);
    if (t !== q.title) assertTitleFree(ctx, space, t, q.id);
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
  if (Object.keys(changes).length === 0) return q;
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.edited", changes);
  });
  return q;
}

/** `{source: "process"}` to follow the process, or `{source: "manual", label | state, note?}`. */
export function setStatus(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  const note = trimOrUndef(body?.note, 1000);
  const from = { status: q.status, source: q.status_source, label: q.status_label };
  if (body?.source === "process") {
    if (!q.process) throw bad("Link a process first");
    q.status_source = "process";
    delete q.status_label;
    const s = q.process.fetched?.state;
    if (isQuestionState(s)) q.status = s;
  } else if (body?.source === "manual" || body?.source === undefined) {
    const m = resolveManualStatus(space, body);
    q.status_source = "manual";
    q.status = m.state;
    q.status_label = m.label;
  } else throw bad("Unknown status source");
  if (from.status === q.status && from.source === q.status_source && from.label === q.status_label && !note) return q;
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.status_changed", {
      from: from.status,
      to: q.status,
      source: q.status_source,
      ...(q.status_label ? { label: q.status_label } : {}),
      ...(note ? { note } : {}),
    });
  });
  return q;
}

/** Attach or replace the process. The question then follows it. */
export async function attachProcess(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  if (!body?.custom) assertLinkFree(ctx, space, String(body?.url ?? "").trim(), undefined, q.id);
  const prepared = await prepareProcess(ctx, space, body);
  tx(ctx.db, () => {
    storeProcess(ctx, q, actor, prepared);
    if (q.status_source !== "process") {
      const from = q.status;
      q.status_source = "process";
      delete q.status_label;
      repo.saveQuestion(ctx.db, q);
      log(ctx, q, actor, "question.status_changed", { from, to: from, source: "process", reason: "process linked" });
    }
    followProcess(ctx, q.id, actor);
  });
  return load(ctx, space, q.id);
}

// ---------- removal ----------

/** Hide a question (spam, mistake, test). It stays in the database and the history, and can be restored. */
export function remove(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (q.removed_at) throw conflict("This question is already removed");
  const reason = trimOrUndef(body?.reason, 1000);
  q.removed_at = ctx.now().toISOString();
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.removed", reason ? { reason } : {});
  });
  return q;
}

export function restore(ctx: Ctx, space: Space, q: Question, actor: string): Question {
  if (!q.removed_at) throw conflict("This question isn't removed");
  // Someone may have added the same question or link in the meantime.
  assertTitleFree(ctx, space, q.title, q.id);
  assertLinkFree(ctx, space, q.process?.url, q.process?.tool_id, q.id);
  delete q.removed_at;
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.restored");
  });
  return q;
}

// ---------- relations ----------

function insertRelation(ctx: Ctx, space: Space, from: Question, to: Question, actor: string, kind: RelationKind = "related") {
  const existing = repo.relationsOf(ctx.db, from.id).find(
    (r) => (r.from_id === from.id && r.to_id === to.id) || (r.from_id === to.id && r.to_id === from.id),
  );
  if (existing) throw conflict("These questions are already related", "already_related");
  repo.insertRelation(ctx.db, space.id, { from_id: from.id, to_id: to.id, kind, created_at: ctx.now().toISOString(), created_by: actor });
  // Logged on both questions so each history shows it.
  log(ctx, from, actor, "relation.added", { kind, from_id: from.id, to_id: to.id, other_title: to.title });
  log(ctx, to, actor, "relation.added", { kind, from_id: from.id, to_id: to.id, other_title: from.title });
}

/** Relate an existing question to this one (q → other). `kind: "duplicate"` means q duplicates other. */
export function relate(ctx: Ctx, space: Space, q: Question, actor: string, body: any) {
  const kind = (body?.kind ?? "related") as RelationKind;
  if (!RELATION_KINDS.includes(kind)) throw bad("Unknown relation kind");
  const other = validateRelated(ctx, space, q, body?.id);
  if (!other) throw bad("Choose a question to relate");
  tx(ctx.db, () => insertRelation(ctx, space, q, other, actor, kind));
}

/** Remove the relation between q and another question, whichever its direction and kind. */
export function unrelate(ctx: Ctx, space: Space, q: Question, actor: string, otherId: string) {
  const r = repo.relationsOf(ctx.db, q.id).find((r) => r.from_id === otherId || r.to_id === otherId);
  if (!r) throw notFound("These questions aren't related");
  const other = load(ctx, space, otherId);
  tx(ctx.db, () => {
    repo.deleteRelation(ctx.db, r);
    const data = { kind: r.kind, from_id: r.from_id, to_id: r.to_id };
    log(ctx, q, actor, "relation.removed", { ...data, other_title: other.title });
    log(ctx, other, actor, "relation.removed", { ...data, other_title: q.title });
  });
}
