# Export format — `question-register/v3`

`GET /api/s/<token>/export` (or `node src/cli.ts export <space-id>`) returns one JSON document containing everything in a space. Token hashes are never included. Changes within a version are **additive only** (new optional fields). Anything else bumps the version. Import is deferred, but this format is what it will read.

```jsonc
{
  "format": "question-register/v3",
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

- **Question**: `{id, space_id, title, why_it_matters?, status, status_source: "process"|"manual", status_label?, process?, removed_at?, created_at, created_by, last_activity_at}`. Removed questions are included, with `removed_at`. `status` is a category: `not_started`, `open`, `accepted`, `rejected`, `concluded`, `withdrawn`.
- **Process** (nested as `question.process`): `{url?, tool_id, item_type, framing?, fetch_mode, fetched?}`. Custom processes have `tool_id: "custom"`, `item_type` = their kind ("General assembly"), and may have no `url`.
- **Fetched**: `{title?, raw_state?, state, terminal, outcome_summary?, dates?: {opens_at?, closes_at?, resolved_at?, updated_at?}, extra?, fetched_at, fetch_error?}`. `dates.updated_at` is the last activity on the platform, when known.
- **Relation**: `{from_id, to_id, kind: "related"|"duplicate", created_at, created_by}`. Directed; `duplicate` means `from` duplicates `to`.
- **Tool**: `{id, name, url_patterns: [{pattern, item_type}], fetch_mode, adapter?, state_map?, enabled}`.
- **ActivityEvent**: `{id, space_id, question_id?, at, actor, action, data}`. `actor` is a display name, `system` or `operator`. `data` holds before/after values for the action.

### Changes from earlier versions

- **v3** (status model simplified): questions lost `section`, `steward`, `resolution`, `resolution_record`, `pending_resolution`, `default_window`, `rules_payload`, `reopened_at`, `reopen_baseline_state`, `duplicate_of_id`, `drop_reason` and `objections`; settings lost `active_cap`, `dormancy_days`, `default_rule_days`, `auto_confirm_process_outcomes`. `duplicate_of_id` became a `duplicate` relation. Their history stays in `activity` (e.g. `resolution.confirmed` events carry the resolution record, `objection.raised` the reason).
- **v2**: `relations` replaced `Question.parent_id` (v1 `parent_id: P` on `Q` ≙ relation `Q → P`, kind `related`).

### Action names

`space.created`, `question.created`, `question.edited`, `question.status_changed` (`{from, to, source, label?, note?, reason?}`), `question.removed` (`{reason?}`), `question.restored`, `process.attached`, `process.replaced`, `process.removed`, `process.framing_changed`, `process.state_changed`, `process.now_manual`, `relation.added`, `relation.removed` (both logged on both questions), `tool.added`, `tool.edited`, `tool.enabled`, `tool.disabled`, `settings.changed`, `charter.changed`, `link.rotated`, `model.simplified`.

From the earlier decision model, still found in older logs: `question.reopened`, `steward.changed`, `criteria.changed`, `objection.raised`, `objection.addressed`, `objection_window.resumed`, `resolution.pending`, `resolution.cancelled`, `resolution.confirmed`, `process.refresh_failed`. Old `question.status_changed` events use the old statuses (`inbox`, `active`, `standing`, `resolved`, `dormant`, `dropped`).
