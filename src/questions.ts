// Questions: creation, edits, process and relations. All rules enforced here, server-side.
//
// Each field (title, kind, status, summary, results link, start, end) is retrieved from the linked
// item or typed (see fields.ts). Linking an item whose status can be retrieved makes the status
// follow it; anyone can type a value instead, and go back to the retrieved one.
import type { Ctx } from "./ctx.ts";
import { CUSTOM_TOOL_ID, type Question, type Space, type TypedStatus } from "./types.ts";
import { hierarchyLoop, RELATION_INPUTS, storedKind, type RelationInput } from "./relations.ts";
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
  if (!q) throw notFound("Matter not found");
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
  if (oid === q.id) throw bad("A matter can't be related to itself");
  const other = repo.getQuestion(ctx.db, space.id, oid);
  if (!other || other.removed_at) throw bad("Related matter not found");
  return other;
}

/**
 * After a process is stored: what the question types and follows. Typed values stay unless the new
 * item gives them. The kind is dropped when a listed tool retrieves it (a link-less or unlisted
 * process can't, so a typed kind stays). The status follows the item when it can be retrieved, unless
 * first linking with a typed status that isn't the default "not started". When a previous process is
 * *replaced*, the typed summary and results link described it and are dropped. A kind typed with the
 * process is kept. Fields the item can't give (title, status) are typed with their current values.
 * Doesn't save.
 */
function adoptProcess(ctx: Ctx, space: Space, q: Question, actor: string, prepared: Prepared, replaced = false) {
  const now = ctx.now().toISOString();
  if (replaced) for (const f of ["summary", "results_url"] as const) delete q.typed[f];
  if (q.process?.tool_id !== CUSTOM_TOOL_ID) delete q.typed.kind;
  const typedState = (q.typed.status?.value as TypedStatus | undefined)?.state;
  if (retrievable(q).has("status") && (replaced || typedState === "not_started")) delete q.typed.status;
  if (prepared.kind) q.typed.kind = { value: prepared.kind, by: actor, at: now };
  freezeUnretrievable(space, q, actor, now);
}

/**
 * Create a question. Optional: a process (`process_url`, or `process: {url?, kind?}`), a related
 * question (`related_id`, with `related_kind`: how the new question stands to it, as in `relate`), a typed status (`status: {label}|{state}`), typed `fields` (`summary`,
 * `results_url`, `start`, `end`; empty ones are left to the linked item). With a link, the title is
 * retrieved unless a different one is given (then it's typed).
 */
export async function create(ctx: Ctx, space: Space, actor: string, body: any): Promise<Question> {
  const givenTitle = trimOrUndef(body?.title, TITLE_MAX + 1);
  const why = trimOrUndef(body?.why_it_matters, 5000);
  // `parent_id` is the pre-relations name, still accepted.
  const related = validateRelated(ctx, space, {}, body?.related_id ?? body?.parent_id);
  const relatedKind = relationInput(body?.related_kind);
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
    // Checked again here: the link may have been added while the item was being fetched (S6).
    if (linkUrl) assertLinkFree(ctx, space, linkUrl);
    repo.insertQuestion(ctx.db, q);
    log(ctx, q, actor, "question.created", {
      title,
      ...(why ? { why_it_matters: why } : {}),
      ...(related ? { related_id: related.id, ...(relatedKind !== "related" ? { related_kind: relatedKind } : {}) } : {}),
      typed: Object.keys(q.typed),
    });
    if (related) insertRelation(ctx, space, q, related, actor, relatedKind);
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
  const linkUrl = trimOrUndef(body?.url ?? body?.custom?.url, 2000);
  assertLinkFree(ctx, space, linkUrl, q.id);
  const prepared = await prepareProcess(ctx, space, body);
  const replaced = !!q.process;
  tx(ctx.db, () => {
    // Checked again here: the link may have been added while the item was being fetched (S6).
    assertLinkFree(ctx, space, linkUrl, q.id);
    storeProcess(ctx, q, actor, prepared);
    adoptProcess(ctx, space, q, actor, prepared, replaced);
    repo.saveQuestion(ctx.db, q);
    sync(ctx, q, actor);
  });
  return load(ctx, space, q.id);
}

// ---------- removal ----------

/** Hide a question (spam, mistake, test). It stays in the database and the history, and can be restored. */
export function remove(ctx: Ctx, space: Space, q: Question, actor: string, body: any): Question {
  if (q.removed_at) throw conflict("This matter is already removed");
  const reason = trimOrUndef(body?.reason, 1000);
  q.removed_at = ctx.now().toISOString();
  tx(ctx.db, () => {
    repo.saveQuestion(ctx.db, q);
    log(ctx, q, actor, "question.removed", reason ? { reason } : {});
  });
  return q;
}

export function restore(ctx: Ctx, space: Space, q: Question, actor: string): Question {
  if (!q.removed_at) throw conflict("This matter isn't removed");
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

/** How a question is related to another, as the caller says it ("child_of", "duplicated_by"…); `related` by default. */
function relationInput(v: unknown): RelationInput {
  if (v == null || v === "") return "related";
  if (!RELATION_INPUTS.includes(v as RelationInput)) throw bad("Unknown relation kind");
  return v as RelationInput;
}

/** Store a relation between `q` and `other`; `how` says what `q` is to `other` ("q is a child of other"). */
function insertRelation(ctx: Ctx, space: Space, q: Question, other: Question, actor: string, how: RelationInput = "related") {
  const { kind, swap } = storedKind(how);
  const [from, to] = swap ? [other, q] : [q, other];
  const existing = repo.relationsOf(ctx.db, from.id).find(
    (r) => (r.from_id === from.id && r.to_id === to.id) || (r.from_id === to.id && r.to_id === from.id),
  );
  if (existing) throw conflict("These matters are already related", "already_related");
  if (kind === "child_of") {
    // The hierarchy can't loop: `to` must not already be `from` or below it.
    const chain = hierarchyLoop(repo.listRelations(ctx.db, space.id), from.id, to.id);
    if (chain) {
      const titles = new Map(repo.listQuestions(ctx.db, space.id, { removed: "include" }).map((x) => [x.id, x.title]));
      const path = chain.map((id) => `“${titles.get(id) ?? "?"}”`).join(" → ");
      throw conflict(
        `“${to.title}” is already below “${from.title}” (${path}), so it can't also be its parent. Choose another relation, or unlink them first.`,
        "hierarchy_loop",
      );
    }
  }
  repo.insertRelation(ctx.db, space.id, { from_id: from.id, to_id: to.id, kind, created_at: ctx.now().toISOString(), created_by: actor });
  // Logged on both questions so each history shows it.
  log(ctx, from, actor, "relation.added", { kind, from_id: from.id, to_id: to.id, other_title: to.title });
  log(ctx, to, actor, "relation.added", { kind, from_id: from.id, to_id: to.id, other_title: from.title });
}

/**
 * Relate an existing question to this one. `kind` says what *this* question is: `related` (default),
 * `child_of` / `parent_of`, `duplicate_of` (`duplicate` is the older name) / `duplicated_by`.
 * A child can have several parents; loops in the hierarchy are refused.
 */
export function relate(ctx: Ctx, space: Space, q: Question, actor: string, body: any) {
  const how = relationInput(body?.kind);
  const other = validateRelated(ctx, space, q, body?.id);
  if (!other) throw bad("Choose a matter to relate");
  tx(ctx.db, () => insertRelation(ctx, space, q, other, actor, how));
}

/** Remove the relation between q and another question, whichever its direction and kind. */
export function unrelate(ctx: Ctx, space: Space, q: Question, actor: string, otherId: string) {
  const r = repo.relationsOf(ctx.db, q.id).find((r) => r.from_id === otherId || r.to_id === otherId);
  if (!r) throw notFound("These matters aren't related");
  const other = load(ctx, space, otherId);
  tx(ctx.db, () => {
    repo.deleteRelation(ctx.db, r);
    const data = { kind: r.kind, from_id: r.from_id, to_id: r.to_id };
    log(ctx, q, actor, "relation.removed", { ...data, other_title: other.title });
    log(ctx, other, actor, "relation.removed", { ...data, other_title: q.title });
  });
}
