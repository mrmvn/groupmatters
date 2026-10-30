import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { DEFAULT_STATUS_LABELS } from "./types.ts";
import { INSTANCE_KINDS, SEED_TOOLS } from "./tools.ts";
import { dirname } from "node:path";

// Schema notes (spec §2.6):
// - processes live in their own table with a UNIQUE(question_id) constraint. Dropping that
//   constraint later enables several processes per question without migrating data.
// - activity is append-only, enforced by triggers at the storage layer.
// - questions are never deleted (enforced by trigger too).
export const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    charter_markdown TEXT NOT NULL,
    edit_token_hash TEXT NOT NULL UNIQUE,
    view_token_hash TEXT NOT NULL UNIQUE
  );

  CREATE TABLE tools (
    space_id TEXT NOT NULL REFERENCES spaces(id),
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    url_patterns_json TEXT NOT NULL,
    fetch_mode TEXT NOT NULL CHECK (fetch_mode IN ('auto','manual')),
    adapter TEXT,
    state_map_json TEXT,
    added_by_question_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (space_id, id)
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    section TEXT NOT NULL CHECK (section IN ('main','rules')),
    title TEXT NOT NULL,
    why_it_matters TEXT,
    status TEXT NOT NULL CHECK (status IN ('inbox','active','standing','resolved','dormant','dropped')),
    steward TEXT,
    resolution_json TEXT NOT NULL,
    parent_id TEXT REFERENCES questions(id),
    duplicate_of_id TEXT REFERENCES questions(id),
    drop_reason TEXT,
    resolution_record_json TEXT,
    pending_resolution_json TEXT,
    default_window_json TEXT,
    rules_payload_json TEXT,
    reopened_at TEXT,
    reopen_baseline_state TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );
  CREATE INDEX questions_space_status ON questions(space_id, status);
  CREATE TRIGGER questions_no_delete BEFORE DELETE ON questions
    BEGIN SELECT RAISE(ABORT, 'questions are never deleted'); END;

  CREATE TABLE processes (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),
    space_id TEXT NOT NULL REFERENCES spaces(id),
    url TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    framing TEXT,
    fetch_mode TEXT NOT NULL CHECK (fetch_mode IN ('auto','manual')),
    fetched_json TEXT,
    etag TEXT,
    next_refresh_at TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX processes_refresh ON processes(fetch_mode, next_refresh_at);

  CREATE TABLE objections (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id),
    space_id TEXT NOT NULL REFERENCES spaces(id),
    raised_by TEXT NOT NULL,
    raised_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    addressed_at TEXT,
    addressed_by TEXT,
    address_note TEXT
  );
  CREATE INDEX objections_question ON objections(question_id);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    question_id TEXT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX activity_space ON activity(space_id, id);
  CREATE INDEX activity_question ON activity(question_id, id);
  CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
    BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
    BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,
  // v2: relations between questions. Directed (from → to) with a kind, so asymmetric kinds
  // ("depends on", "part of"…) can be added later; every relation is shown on both questions.
  // Replaces questions.parent_id (one per question), which is migrated and then left unused.
  `
  CREATE TABLE relations (
    space_id TEXT NOT NULL REFERENCES spaces(id),
    from_id TEXT NOT NULL REFERENCES questions(id),
    to_id TEXT NOT NULL REFERENCES questions(id),
    kind TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind),
    CHECK (from_id <> to_id)
  );
  CREATE INDEX relations_to ON relations(to_id);
  CREATE INDEX relations_space ON relations(space_id);
  INSERT INTO relations (space_id, from_id, to_id, kind, created_at, created_by)
    SELECT space_id, id, parent_id, 'related', created_at, created_by FROM questions WHERE parent_id IS NOT NULL;
  UPDATE questions SET parent_id = NULL WHERE parent_id IS NOT NULL;
  `,
  // v3: the decision model is removed (DECISIONS.md, "Status model"). See simplifyModel.
  (db) => simplifyModel(db),
  // v4: questions can be removed (hidden, restorable); they are still never deleted.
  `ALTER TABLE questions ADD COLUMN removed_at TEXT;`,
  // v5: the Decidim tool joins every space's tool list.
  (db) => addSeedTool(db, "decidim"),
  // v6: tools say what they're useful for. Built-in tools and Consul instances get the seed text.
  (db) => addToolDescriptions(db),
];

function addToolDescriptions(db: DatabaseSync) {
  db.exec("ALTER TABLE tools ADD COLUMN description TEXT");
  const set = db.prepare("UPDATE tools SET description = ? WHERE id = ? AND adapter IS ? AND description IS NULL");
  for (const t of SEED_TOOLS) if (t.description) set.run(t.description, t.id, t.adapter ?? null);
  for (const kind of Object.values(INSTANCE_KINDS))
    db.prepare("UPDATE tools SET description = ? WHERE adapter = ? AND description IS NULL").run(kind.description, kind.adapter);
}

/** Add a seed tool to every space (for tools added to SEED_TOOLS after spaces were created). */
function addSeedTool(db: DatabaseSync, id: string) {
  const t = SEED_TOOLS.find((x) => x.id === id)!;
  // The description column only exists from migration 6 on.
  const hasDescription = (db.prepare("PRAGMA table_info(tools)").all() as Row[]).some((c) => c.name === "description");
  for (const s of db.prepare("SELECT id FROM spaces").all() as Row[]) {
    if (db.prepare("SELECT 1 FROM tools WHERE space_id = ? AND id = ?").get(s.id, id)) continue;
    const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tools WHERE space_id = ?").get(s.id) as Row).p;
    db.prepare(
      "INSERT INTO tools (space_id, id, name, url_patterns_json, fetch_mode, adapter, state_map_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(s.id, id, t.name, JSON.stringify(t.url_patterns), t.fetch_mode, t.adapter ?? null, t.state_map ? JSON.stringify(t.state_map) : null, pos);
    if (hasDescription && t.description) db.prepare("UPDATE tools SET description = ? WHERE space_id = ? AND id = ?").run(t.description, s.id, id);
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db, path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function migrate(db: DatabaseSync, path: string) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  if (v >= MIGRATIONS.length) return;
  // Snapshot an existing database before changing its schema.
  if (v > 0 && path !== ":memory:") {
    const bak = `${path}.before-v${MIGRATIONS.length}.bak`;
    if (!existsSync(bak)) db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  }
  // Foreign keys are off while migrating so tables can be rebuilt (SQLite's 12-step procedure).
  db.exec("PRAGMA foreign_keys = OFF");
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      const m = MIGRATIONS[v];
      if (typeof m === "string") db.exec(m);
      else m(db);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error(`Migration ${v + 1} broke ${broken.length} foreign key(s)`);
      v++;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

type Row = Record<string, any>;

/**
 * Migration 3. Questions get a status category that follows their process or is set by hand.
 * Old statuses map as: with a process (and not resolved/dropped) → follow the process;
 * inbox/dormant → Not started; active/standing → Being discussed; resolved → its outcome; dropped → Dropped.
 * duplicate_of becomes a "duplicate" relation. Objections, criteria, stewards and resolution records
 * are dropped from the tables; their history stays in the activity log.
 * Seed tools that now have adapters (Loomio, Polis, Metaculus) become automatic.
 */
function simplifyModel(db: DatabaseSync) {
  const labelFor: Record<string, string> = Object.fromEntries([...DEFAULT_STATUS_LABELS].reverse().map((l) => [l.state, l.label]));
  const procs = new Map((db.prepare("SELECT question_id, fetched_json FROM processes").all() as Row[]).map((r) => [r.question_id, r]));
  const now = new Date().toISOString();

  db.exec(`
  CREATE TABLE questions_new (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    title TEXT NOT NULL,
    why_it_matters TEXT,
    status TEXT NOT NULL CHECK (status IN ('not_started','open','accepted','rejected','concluded','withdrawn')),
    status_source TEXT NOT NULL CHECK (status_source IN ('process','manual')),
    status_label TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );`);
  const ins = db.prepare(`INSERT INTO questions_new (id, space_id, title, why_it_matters, status, status_source, status_label, created_at, created_by, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rel = db.prepare(`INSERT OR IGNORE INTO relations (space_id, from_id, to_id, kind, created_at, created_by) VALUES (?, ?, ?, 'duplicate', ?, 'system')`);
  for (const q of db.prepare("SELECT * FROM questions").all() as Row[]) {
    const p = procs.get(q.id);
    const fetchedState = p?.fetched_json ? JSON.parse(p.fetched_json).state : undefined;
    let status: string, source = "manual", label: string | null;
    if (p && q.status !== "resolved" && q.status !== "dropped") {
      source = "process";
      status = fetchedState && fetchedState !== "unknown" ? fetchedState : "not_started";
      label = null;
    } else if (q.status === "resolved") {
      const outcome = q.resolution_record_json ? JSON.parse(q.resolution_record_json).outcome : undefined;
      status = outcome && labelFor[outcome] ? outcome : "concluded";
      label = labelFor[status];
    } else if (q.status === "dropped") (status = "withdrawn"), (label = labelFor.withdrawn);
    else if (q.status === "active" || q.status === "standing") (status = "open"), (label = labelFor.open);
    else (status = "not_started"), (label = labelFor.not_started);
    ins.run(q.id, q.space_id, q.title, q.why_it_matters, status, source, label, q.created_at, q.created_by, q.last_activity_at);
    if (q.duplicate_of_id && q.duplicate_of_id !== q.id) rel.run(q.space_id, q.id, q.duplicate_of_id, q.created_at);
  }
  db.exec(`
  DROP TABLE questions;
  ALTER TABLE questions_new RENAME TO questions;
  CREATE INDEX questions_space_status ON questions(space_id, status);
  CREATE TRIGGER questions_no_delete BEFORE DELETE ON questions
    BEGIN SELECT RAISE(ABORT, 'questions are never deleted'); END;
  DROP TABLE objections;

  CREATE TABLE processes_new (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),
    space_id TEXT NOT NULL REFERENCES spaces(id),
    url TEXT,
    tool_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    framing TEXT,
    fetch_mode TEXT NOT NULL CHECK (fetch_mode IN ('auto','manual')),
    fetched_json TEXT,
    etag TEXT,
    next_refresh_at TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  INSERT INTO processes_new SELECT id, question_id, space_id, url, tool_id, item_type, framing, fetch_mode, fetched_json, etag, next_refresh_at, fail_count, created_at FROM processes;
  DROP TABLE processes;
  ALTER TABLE processes_new RENAME TO processes;
  CREATE INDEX processes_refresh ON processes(fetch_mode, next_refresh_at);
  `);

  // Settings: only the hand-set status labels remain.
  db.prepare("UPDATE spaces SET settings_json = ?").run(JSON.stringify({ status_labels: DEFAULT_STATUS_LABELS }));

  // Seed tools that gained an adapter. Only rows still as seeded (no adapter yet) are touched.
  for (const id of ["loomio", "polis", "metaculus"]) {
    const seed = SEED_TOOLS.find((t) => t.id === id)!;
    db.prepare("UPDATE tools SET fetch_mode = 'auto', adapter = ?, url_patterns_json = ? WHERE id = ? AND adapter IS NULL").run(
      seed.adapter!,
      JSON.stringify(seed.url_patterns),
      id,
    );
  }
  // Their existing processes start being fetched (Metaculus only works with an API token, so it stays by hand).
  db.prepare("UPDATE processes SET fetch_mode = 'auto', next_refresh_at = ?, fail_count = 0 WHERE tool_id IN ('loomio','polis')").run(now);

  for (const s of db.prepare("SELECT id FROM spaces").all() as Row[])
    db.prepare("INSERT INTO activity (space_id, at, actor, action, data_json) VALUES (?, ?, 'system', 'model.simplified', ?)").run(
      s.id,
      now,
      JSON.stringify({ note: "Adopt, criteria, objections, stewards and the active limit were removed. Statuses now follow the process or are set by hand." }),
    );
}

/** Run fn inside a transaction (re-entrant: nested calls join the outer transaction). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
