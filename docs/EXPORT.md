# Export format — `question-register/v5`

`GET /api/s/<token>/export` (or `node src/cli.ts export <space-id>`) returns one JSON document containing everything in a space. Token hashes are never included. Changes within a version are **additive only** (new optional fields). Anything else bumps the version. Import is deferred, but this format is what it will read.

```jsonc
{
  "format": "question-register/v5",
  "exported_at": "2026-01-10T12:00:00.000Z",   // all datetimes: ISO 8601, UTC
  "space": {
    "id": "…", "name": "…", "created_at": "…",
    "settings": { "status_labels": [ { "label": "Not started", "state": "not_started" }, … ] },
    "charter_markdown": "…"
  },
  "tools": [ Tool, … ],          // registry, in display order
  "questions": [ Question, … ],  // oldest first
  "relations": [ Relation, … ],  // oldest first
  "activity": [ ActivityEvent, … ]  // complete, oldest first, ids strictly increasing
}
```

Types (see `src/types.ts`):

- **Question**: `{id, space_id, title, why_it_matters?, status, status_label?, typed, fields, process?, removed_at?, created_at, created_by, last_activity_at}`. `typed: {field: {value, by, at}}` holds the typed values of `title`, `kind`, `status` (`{state, label}`), `summary`, `results_url`, `start`, `end`; a field not in there is retrieved from the process, and `value: null` means "none". `fields` is the result per field (derived, for convenience; see `API.md`). `title`, `status` and `status_label` are the values in use. Date values are a whole day (`"2026-03-01"`, no time zone) or a UTC moment; an end in the future is planned. Removed questions are included, with `removed_at`. `status` is a category: `not_started`, `open`, `accepted`, `rejected`, `concluded`, `withdrawn`.
- **Process** (nested as `question.process`): `{url?, tool_id, item_type, fetch_mode, fetched?}`. `fetched` holds only retrieved data. Custom processes (no link, or a link to a site not on the tool list) have `tool_id: "custom"` and an empty `item_type`; their kind is typed on the question.
- **Fetched**: `{title?, raw_state?, state, terminal, outcome_summary?, dates?: {opens_at?, closes_at?, resolved_at?, updated_at?}, extra?, fetched_at, fetch_error?}`. `dates.updated_at` is the last activity on the platform, when known.
- **Relation**: `{from_id, to_id, kind: "related"|"child_of"|"duplicate", created_at, created_by}`. Directed: `child_of` means `from` is a child of `to` (its parent); `duplicate` means `from` duplicates `to`; `related` is symmetric. The `child_of` links never form a loop. New kind only: the format version is unchanged.
- **Tool**: `{id, name, description?, url_patterns: [{pattern, item_type}], fetch_mode, adapter?, enabled}`. `description` ("what is it useful for?") is additive (migration 6), so the format version is unchanged.
- **ActivityEvent**: `{id, space_id, question_id?, at, actor, action, data}`. `actor` is a display name, `system` or `operator`. `data` holds before/after values for the action.

### Changes from earlier versions

- **v5** (retrieved or typed, per field): questions lost `status_source`, `start_source`, `start_date`, `end_source`, `end_date` and `dates`, and gained `typed` and `fields`. Hand-set process states, summaries and results links (and a custom process' kind) became typed question values; `process.fetched` keeps only retrieved data. Tools lost `state_map`.
- **v4** (question dates): questions gained `start_source`, `start_date`, `end_source`, `end_date` and the derived `dates`. Processes lost `framing` (still in older `process.attached`/`process.framing_changed` events). Dates typed on processes updated by hand (a custom process' "when") moved from `process.fetched.dates` to the question's `start_date`/`end_date`.
- **v3** (status model simplified): questions lost `section`, `steward`, `resolution`, `resolution_record`, `pending_resolution`, `default_window`, `rules_payload`, `reopened_at`, `reopen_baseline_state`, `duplicate_of_id`, `drop_reason` and `objections`; settings lost `active_cap`, `dormancy_days`, `default_rule_days`, `auto_confirm_process_outcomes`. `duplicate_of_id` became a `duplicate` relation. Their history stays in `activity` (e.g. `resolution.confirmed` events carry the resolution record, `objection.raised` the reason).
- **v2**: `relations` replaced `Question.parent_id` (v1 `parent_id: P` on `Q` ≙ relation `Q → P`, kind `related`).

### Action names

`space.created`, `question.created`, `question.edited`, `question.status_changed` (`{from, to, source, label?, note?, reason?}`), `question.fields_changed` (`{fields: {field: {before, after}}, note?}`, each side `{source: "typed"|"retrieved", value?}`), `question.removed` (`{reason?}`), `question.restored`, `process.attached`, `process.replaced`, `process.removed`, `process.state_changed` (`{before, after}`), `process.now_manual`, `process.tool_matched` (`{tool_id, url}`: a custom process' link joined a newly listed tool), `relation.added`, `relation.removed` (both logged on both questions), `tool.added`, `tool.edited`, `tool.enabled`, `tool.disabled`, `settings.changed`, `charter.changed`, `link.rotated`, `model.simplified`.

From the earlier decision model, still found in older logs: `question.reopened`, `steward.changed`, `criteria.changed`, `objection.raised`, `objection.addressed`, `objection_window.resumed`, `resolution.pending`, `resolution.cancelled`, `resolution.confirmed`, `process.refresh_failed`, `process.framing_changed` (framing was removed in v4), `question.dates_changed` (v4 only), `process.state_changed` with `manual: true` (hand-set process states, before v5). `question.status_changed` and `question.edited` with `source: "retrieved"` are logged by `system` when a retrieved value changes. Old `question.status_changed` events use the old statuses (`inbox`, `active`, `standing`, `resolved`, `dormant`, `dropped`).
