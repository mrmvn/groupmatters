// Questions: creation, edits, process and relations. All rules enforced here, server-side.
//
// Each field (title, kind, status, summary, results link, start, end) is retrieved from the linked
// item or typed (see fields.ts). Linking an item whose status can be retrieved makes the status
// follow it; anyone can type a value instead, and go back to the retrieved one.
import type { Ctx } from "./ctx.ts";
import type { Question, RelationKind, Space } from "./types.ts";
import { RELATION_KINDS } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { duplicateLinkError, findQuestionWithLink, prepareProcess, storeProcess, type Prepared } from "./processes.ts";
import { duplicateTitleError, freezeUnretrievable, parseCreateFields, resolveStatus, retrievable, setFields, sync, typeCreateFields, type FieldsBody } from "./fields.ts";
import { bad, conflict, newId, notFound, requireText, trimOrUndef } from "./util.ts";

const TITLE_MAX = 300;

function log(ctx: Ctx, q: Question, actor: string, action: string, data: Record<string, unknown> = {}) {
  repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action, data });
}

export function load(ctx: Ctx, space: Space, id: string): Question {
  const q = repo.getQuestion(ctx.db, space.id, String(id));
  if (!q) throw notFound("Question not found");
  return q;
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
  if (existing) throw duplicateTitleError(existing);
}

/** Refuse a link another (non-removed) question already tracks. */
function assertLinkFree(ctx: Ctx, space: Space, url: string | undefined, excludeId?: string) {
  if (!url) return;
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
 * After a process is stored: what the question types and follows. The status follows the new item when
 * it can be retrieved; the typed kind, summary and results belonged to the previous process. A kind
 * typed with the process is kept. Fields the item can't give (title, status) are typed with their
 * current values. Doesn't save.
 */
function adoptProcess(ctx: Ctx, space: Space, q: Question, actor: string, prepared: Prepared) {
  const now = ctx.now().toISOString();
  for (const f of ["kind", "summary", "results_url"] as const) delete q.typed[f];
  if (retrievable(q).has("status")) delete q.typed.status;
  if (prepared.kind) q.typed.kind = { value: prepared.kind, by: actor, at: now };
  freezeUnretrievable(space, q, actor, now);
}

/**
 * Create a question. Optional: a process (`process_url`, or `process: {url?, kind?}`), a related
 * question (`related_id`), a typed status (`status: {label}|{state}`), typed `fields` (`summary`,
 * `results_url`, `start`, `end`; empty ones are left to the linked item). With a link, the title is
 * retrieved unless a different one is given (then it's typed).
 */
export async function create(ctx: Ctx, space: Space, actor: string, body: any): Promise<Question> {
  const givenTitle = trimOrUndef(body?.title, TITLE_MAX + 1);
  const why = trimOrUndef(body?.why_it_matters, 5000);
  // `parent_id` is the pre-relations name, still accepted.
  const related = validateRelated(ctx, space, {}, body?.related_id ?? body?.parent_id);
  const processUrl = trimOrUndef(body?.process_url, 2000);
  const processBody = body?.process ?? (processUrl ? { url: processUrl } : undefined);
  const linkUrl = trimOrUndef(processBody?.url ?? processBody?.custom?.url, 2000);
  if (linkUrl) assertLinkFree(ctx, space, linkUrl);
  const prepared = processBody ? await prepareProcess(ctx, space, processBody) : undefined;
  const retrievedTitle = prepared?.process.fetched?.title?.trim();
  const title = requireText(givenTitle ?? retrievedTitle, "Title", TITLE_MAX);
  assertTitleFree(ctx, space, title);
  const typedStatus = body?.status ? resolveStatus(space, body.status) : undefined;
  const typedFields = parseCreateFields(space, body?.fields);

  const now = ctx.now().toISOString();
  const q: Question = {
    id: newId(),
    space_id: space.id,
    title,
    status: typedStatus?.state ?? "not_started",
    typed: {},
    created_at: now,
    created_by: actor,
    last_activity_at: now,
  };
  if (why) q.why_it_matters = why;
  if (title !== retrievedTitle) q.typed.title = { value: title, by: actor, at: now };
  if (prepared) {
    q.process = prepared.process; // for adoptProcess; stored below, with its log entry
    adoptProcess(ctx, space, q, actor, prepared);
  } else freezeUnretrievable(space, q, actor, now);
  // A status given explicitly is typed, even when the item could give one.
  if (typedStatus) q.typed.status = { value: typedStatus, by: actor, at: now };
  typeCreateFields(q, actor, now, typedFields);
  delete q.process;
  const st = q.typed.status?.value as { label?: string } | undefined;
  if (st?.label) q.status_label = st.label;

  tx(ctx.db, () => {
    repo.insertQuestion(ctx.db, q);
    log(ctx, q, actor, "question.created", {
      title,
      ...(why ? { why_it_matters: why } : {}),
      ...(related ? { related_id: related.id } : {}),
      typed: Object.keys(q.typed),
    });
    if (related) insertRelation(ctx, space, q, related, actor);
    if (prepared) {
      storeProcess(ctx, q, actor, prepared);
      sync(ctx, q, actor);
    }
  });
  return load(ctx, space, q.id);
}

/** Edit the title (typed) and why it matters. */
export function edit(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (body?.title !== undefined) {
    const t = requireText(body.title, "Title", TITLE_MAX);
    if (t !== q.title) setFields(ctx, space, q, actor, { set: { title: t } }, (x) => assertTitleFree(ctx, space, x, q.id));
  }
  if (body?.why_it_matters !== undefined) {
    const w = trimOrUndef(body.why_it_matters, 5000);
    if (w !== q.why_it_matters) {
      const change = { why_it_matters: { before: q.why_it_matters ?? null, after: w ?? null } };
      if (w) q.why_it_matters = w;
      else delete q.why_it_matters;
      tx(ctx.db, () => {
        repo.saveQuestion(ctx.db, q);
        log(ctx, q, actor, "question.edited", change);
      });
    }
  }
  return q;
}

/** Type field values, or go back to the retrieved ones (see fields.ts). */
export function updateFields(ctx: Ctx, space: Space, q: Question, actor: string, body: FieldsBody): Question {
  return setFields(ctx, space, q, actor, body, (t) => assertTitleFree(ctx, space, t, q.id));
}

/** Attach or replace the process. The status then follows it, when it can be retrieved. */
export async function attachProcess(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Promise<Question> {
  assertLinkFree(ctx, space, trimOrUndef(body?.url ?? body?.custom?.url, 2000), q.id);
  const prepared = await prepareProcess(ctx, space, body);
  tx(ctx.db, () => {
    storeProcess(ctx, q, actor, prepared);
    adoptProcess(ctx, space, q, actor, prepared);
    repo.saveQuestion(ctx.db, q);
    sync(ctx, q, actor);
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
  assertLinkFree(ctx, space, q.process?.url, q.id);
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
