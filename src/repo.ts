// Data access layer: the only module that writes SQL for domain rows.
import type { DatabaseSync } from "node:sqlite";
import type { Ctx } from "./ctx.ts";
import type { ActivityEvent, Process, Question, Relation, Role, Space, Tool } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { hashToken, safeEqualHex } from "./tokens.ts";
import { newId } from "./util.ts";

type Row = Record<string, any>;
const j = (s: unknown) => (s == null ? undefined : JSON.parse(s as string));
const s = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const u = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

// ---------- spaces ----------

function rowToSpace(r: Row): Space {
  return {
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...j(r.settings_json) },
    charter_markdown: r.charter_markdown,
  };
}

export function insertSpace(db: DatabaseSync, space: Space, editHash: string, viewHash: string) {
  db.prepare(
    `INSERT INTO spaces (id, name, created_at, settings_json, charter_markdown, edit_token_hash, view_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(space.id, space.name, space.created_at, JSON.stringify(space.settings), space.charter_markdown, editHash, viewHash);
}

export function getSpace(db: DatabaseSync, id: string): Space | undefined {
  const r = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined;
  return r && rowToSpace(r);
}

export function listSpaces(db: DatabaseSync): Space[] {
  return (db.prepare("SELECT * FROM spaces ORDER BY created_at").all() as Row[]).map(rowToSpace);
}

export function updateSpace(db: DatabaseSync, space: Space) {
  db.prepare("UPDATE spaces SET name = ?, settings_json = ?, charter_markdown = ? WHERE id = ?").run(
    space.name,
    JSON.stringify(space.settings),
    space.charter_markdown,
    space.id,
  );
}

export function setSpaceTokenHash(db: DatabaseSync, id: string, which: Role, hash: string) {
  const col = which === "edit" ? "edit_token_hash" : "view_token_hash";
  db.prepare(`UPDATE spaces SET ${col} = ? WHERE id = ?`).run(hash, id);
}

/** Resolve a URL token to a space and role. */
export function findSpaceByToken(db: DatabaseSync, token: string): { space: Space; role: Role } | undefined {
  const h = hashToken(token);
  const r = db
    .prepare("SELECT * FROM spaces WHERE edit_token_hash = ? OR view_token_hash = ?")
    .get(h, h) as Row | undefined;
  if (!r) return undefined;
  if (safeEqualHex(r.edit_token_hash, h)) return { space: rowToSpace(r), role: "edit" };
  if (safeEqualHex(r.view_token_hash, h)) return { space: rowToSpace(r), role: "view" };
  return undefined;
}

// ---------- tools ----------

function rowToTool(r: Row): Tool {
  return {
    id: r.id,
    name: r.name,
    description: u(r.description),
    url_patterns: j(r.url_patterns_json),
    fetch_mode: r.fetch_mode,
    adapter: u(r.adapter),
    state_map: j(r.state_map_json),
    added_by_question_id: u(r.added_by_question_id),
    enabled: !!r.enabled,
  };
}

export function listTools(db: DatabaseSync, spaceId: string): Tool[] {
  return (db.prepare("SELECT * FROM tools WHERE space_id = ? ORDER BY position, id").all(spaceId) as Row[]).map(rowToTool);
}

export function getTool(db: DatabaseSync, spaceId: string, id: string): Tool | undefined {
  const r = db.prepare("SELECT * FROM tools WHERE space_id = ? AND id = ?").get(spaceId, id) as Row | undefined;
  return r && rowToTool(r);
}

export function insertTool(db: DatabaseSync, spaceId: string, t: Tool) {
  const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tools WHERE space_id = ?").get(spaceId) as Row).p;
  db.prepare(
    `INSERT INTO tools (space_id, id, name, description, url_patterns_json, fetch_mode, adapter, state_map_json, added_by_question_id, enabled, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spaceId,
    t.id,
    t.name,
    t.description ?? null,
    JSON.stringify(t.url_patterns),
    t.fetch_mode,
    t.adapter ?? null,
    s(t.state_map),
    t.added_by_question_id ?? null,
    t.enabled ? 1 : 0,
    pos,
  );
}

export function updateTool(db: DatabaseSync, spaceId: string, t: Tool) {
  db.prepare("UPDATE tools SET name = ?, description = ?, url_patterns_json = ?, state_map_json = ? WHERE space_id = ? AND id = ?").run(
    t.name,
    t.description ?? null,
    JSON.stringify(t.url_patterns),
    s(t.state_map),
    spaceId,
    t.id,
  );
}

export function setToolEnabled(db: DatabaseSync, spaceId: string, id: string, enabled: boolean) {
  db.prepare("UPDATE tools SET enabled = ? WHERE space_id = ? AND id = ?").run(enabled ? 1 : 0, spaceId, id);
}

// ---------- questions & processes ----------

export type ProcessRow = Process & {
  id: string;
  question_id: string;
  space_id: string;
  etag?: string;
  next_refresh_at?: string;
  fail_count: number;
};

function rowToProcess(r: Row): ProcessRow {
  return {
    id: r.id,
    question_id: r.question_id,
    space_id: r.space_id,
    url: u(r.url),
    tool_id: r.tool_id,
    item_type: r.item_type,
    framing: u(r.framing),
    fetch_mode: r.fetch_mode,
    fetched: j(r.fetched_json),
    etag: u(r.etag),
    next_refresh_at: u(r.next_refresh_at),
    fail_count: r.fail_count,
  };
}

export const publicProcess = (p: ProcessRow): Process => {
  const out: Process = { tool_id: p.tool_id, item_type: p.item_type, fetch_mode: p.fetch_mode };
  if (p.url) out.url = p.url;
  if (p.framing) out.framing = p.framing;
  if (p.fetched) out.fetched = p.fetched;
  return out;
};

function rowToQuestion(r: Row, p?: ProcessRow): Question {
  const q: Question = {
    id: r.id,
    space_id: r.space_id,
    title: r.title,
    why_it_matters: u(r.why_it_matters),
    status: r.status,
    status_source: r.status_source,
    status_label: u(r.status_label),
    removed_at: u(r.removed_at),
    created_at: r.created_at,
    created_by: r.created_by,
    last_activity_at: r.last_activity_at,
  };
  if (p) q.process = publicProcess(p);
  for (const k of Object.keys(q) as (keyof Question)[]) if (q[k] === undefined) delete q[k];
  return q;
}

export function getProcessRow(db: DatabaseSync, questionId: string): ProcessRow | undefined {
  const r = db.prepare("SELECT * FROM processes WHERE question_id = ?").get(questionId) as Row | undefined;
  return r && rowToProcess(r);
}

export function getQuestion(db: DatabaseSync, spaceId: string, id: string): Question | undefined {
  const r = db.prepare("SELECT * FROM questions WHERE id = ? AND space_id = ?").get(id, spaceId) as Row | undefined;
  if (!r) return undefined;
  return rowToQuestion(r, getProcessRow(db, id));
}

export function getQuestionById(db: DatabaseSync, id: string): Question | undefined {
  const r = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToQuestion(r, getProcessRow(db, id)) : undefined;
}

/** Questions of a space, newest first. Removed ones only with `removed: "include"` or `"only"`. */
export function listQuestions(db: DatabaseSync, spaceId: string, opts: { removed?: "exclude" | "include" | "only" } = {}): Question[] {
  const removed = opts.removed ?? "exclude";
  const where = removed === "include" ? "" : removed === "only" ? " AND removed_at IS NOT NULL" : " AND removed_at IS NULL";
  const procs = new Map<string, ProcessRow>();
  for (const r of db.prepare("SELECT * FROM processes WHERE space_id = ?").all(spaceId) as Row[]) {
    procs.set(r.question_id, rowToProcess(r));
  }
  return (db.prepare(`SELECT * FROM questions WHERE space_id = ?${where} ORDER BY created_at DESC`).all(spaceId) as Row[]).map((r) =>
    rowToQuestion(r, procs.get(r.id)),
  );
}

const Q_COLS = ["title", "why_it_matters", "status", "status_source", "status_label", "removed_at", "last_activity_at"] as const;

function questionValues(q: Question) {
  return [q.title, q.why_it_matters ?? null, q.status, q.status_source, q.status_label ?? null, q.removed_at ?? null, q.last_activity_at];
}

export function insertQuestion(db: DatabaseSync, q: Question) {
  db.prepare(
    `INSERT INTO questions (id, space_id, created_at, created_by, ${Q_COLS.join(", ")})
     VALUES (?, ?, ?, ?, ${Q_COLS.map(() => "?").join(", ")})`,
  ).run(q.id, q.space_id, q.created_at, q.created_by, ...questionValues(q));
}

/** Persist question fields (not the process: use the process functions for that). */
export function saveQuestion(db: DatabaseSync, q: Question) {
  const sets = Q_COLS.map((c) => (c === "last_activity_at" ? `${c} = MAX(${c}, ?)` : `${c} = ?`));
  db.prepare(`UPDATE questions SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`).run(
    ...questionValues(q),
    q.id,
    q.space_id,
  );
}

export function upsertProcess(
  db: DatabaseSync,
  q: { id: string; space_id: string },
  p: Process,
  extra: { etag?: string | null; next_refresh_at?: string | null; fail_count?: number },
  now: string,
) {
  const existing = getProcessRow(db, q.id);
  if (existing) {
    db.prepare(
      `UPDATE processes SET url = ?, tool_id = ?, item_type = ?, framing = ?, fetch_mode = ?, fetched_json = ?,
         etag = ?, next_refresh_at = ?, fail_count = ? WHERE question_id = ?`,
    ).run(
      p.url ?? null,
      p.tool_id,
      p.item_type,
      p.framing ?? null,
      p.fetch_mode,
      s(p.fetched),
      extra.etag === undefined ? (existing.etag ?? null) : extra.etag,
      extra.next_refresh_at === undefined ? (existing.next_refresh_at ?? null) : extra.next_refresh_at,
      extra.fail_count ?? existing.fail_count,
      q.id,
    );
  } else {
    db.prepare(
      `INSERT INTO processes (id, question_id, space_id, url, tool_id, item_type, framing, fetch_mode, fetched_json, etag, next_refresh_at, fail_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      q.id,
      q.space_id,
      p.url ?? null,
      p.tool_id,
      p.item_type,
      p.framing ?? null,
      p.fetch_mode,
      s(p.fetched),
      extra.etag ?? null,
      extra.next_refresh_at ?? null,
      extra.fail_count ?? 0,
      now,
    );
  }
}

/** Processes are detached by deleting their row; the activity log keeps the history. */
export function deleteProcess(db: DatabaseSync, questionId: string) {
  db.prepare("DELETE FROM processes WHERE question_id = ?").run(questionId);
}

export function dueProcesses(db: DatabaseSync, now: string): ProcessRow[] {
  return (
    db
      .prepare(
        `SELECT p.* FROM processes p JOIN questions q ON q.id = p.question_id
         WHERE p.fetch_mode = 'auto' AND p.url IS NOT NULL AND q.removed_at IS NULL
           AND (p.next_refresh_at IS NULL OR p.next_refresh_at <= ?)
         ORDER BY p.next_refresh_at`,
      )
      .all(now) as Row[]
  ).map(rowToProcess);
}

// ---------- activity ----------

function rowToEvent(r: Row): ActivityEvent {
  const e: ActivityEvent = { id: r.id, space_id: r.space_id, at: r.at, actor: r.actor, action: r.action, data: JSON.parse(r.data_json) };
  if (r.question_id) e.question_id = r.question_id;
  return e;
}

/** Append an activity event. Also bumps the question's last_activity_at. */
export function logEvent(
  ctx: Ctx,
  ev: { space_id: string; question_id?: string; actor: string; action: string; data?: Record<string, unknown> },
  at = ctx.now().toISOString(),
) {
  ctx.db
    .prepare("INSERT INTO activity (space_id, question_id, at, actor, action, data_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ev.space_id, ev.question_id ?? null, at, ev.actor, ev.action, JSON.stringify(ev.data ?? {}));
  if (ev.question_id) {
    ctx.db.prepare("UPDATE questions SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?").run(at, ev.question_id, at);
  }
}

export function listActivity(
  db: DatabaseSync,
  spaceId: string,
  opts: { questionId?: string; before?: number; limit?: number; since?: string } = {},
): ActivityEvent[] {
  const where = ["space_id = ?"];
  const args: (string | number)[] = [spaceId];
  if (opts.questionId) (where.push("question_id = ?"), args.push(opts.questionId));
  if (opts.before) (where.push("id < ?"), args.push(opts.before));
  if (opts.since) (where.push("at > ?"), args.push(opts.since));
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return (
    db.prepare(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`).all(...args) as Row[]
  ).map(rowToEvent);
}

export function allActivity(db: DatabaseSync, spaceId: string): ActivityEvent[] {
  return (db.prepare("SELECT * FROM activity WHERE space_id = ? ORDER BY id").all(spaceId) as Row[]).map(rowToEvent);
}



// ---------- relations ----------

function rowToRelation(r: Row): Relation {
  return { from_id: r.from_id, to_id: r.to_id, kind: r.kind, created_at: r.created_at, created_by: r.created_by };
}

/** Relations touching a question, in either direction. */
export function relationsOf(db: DatabaseSync, questionId: string): Relation[] {
  return (db.prepare("SELECT * FROM relations WHERE from_id = ? OR to_id = ? ORDER BY created_at").all(questionId, questionId) as Row[]).map(rowToRelation);
}

export function listRelations(db: DatabaseSync, spaceId: string): Relation[] {
  return (db.prepare("SELECT * FROM relations WHERE space_id = ? ORDER BY created_at, from_id, to_id").all(spaceId) as Row[]).map(rowToRelation);
}

export function insertRelation(db: DatabaseSync, spaceId: string, r: Relation) {
  db.prepare("INSERT INTO relations (space_id, from_id, to_id, kind, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(
    spaceId,
    r.from_id,
    r.to_id,
    r.kind,
    r.created_at,
    r.created_by,
  );
}

export function deleteRelation(db: DatabaseSync, r: Pick<Relation, "from_id" | "to_id" | "kind">) {
  db.prepare("DELETE FROM relations WHERE from_id = ? AND to_id = ? AND kind = ?").run(r.from_id, r.to_id, r.kind);
}
