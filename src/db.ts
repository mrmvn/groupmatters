import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Schema notes (spec §2.6):
// - processes live in their own table with a UNIQUE(question_id) constraint. Dropping that
//   constraint later enables several processes per question without migrating data.
// - activity is append-only, enforced by triggers at the storage layer.
// - questions are never deleted (enforced by trigger too).
const MIGRATIONS: string[] = [
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
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
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
