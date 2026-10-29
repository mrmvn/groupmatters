# Export format — `question-register/v1`

`GET /api/s/<token>/export` (or `node src/cli.ts export <space-id>`) returns one JSON document containing everything in a space. Token hashes are never included. The format is meant to stay stable: changes within v1 are **additive only** (new optional fields). Anything else bumps the version. Import is deferred, but this format is what it will read.

```jsonc
{
  "format": "question-register/v1",
  "exported_at": "2026-01-10T12:00:00.000Z",   // all datetimes: ISO 8601, UTC
  "space": {
    "id": "…", "name": "…", "created_at": "…",
    "settings": { "active_cap": 8, "dormancy_days": 30, "default_rule_days": 7, "auto_confirm_process_outcomes": true },
    "charter_markdown": "…"
  },
  "tools": [ Tool, … ],          // registry, in display order
  "questions": [ Question, … ],  // oldest first, each with "objections": [ Objection, … ]
  "activity": [ ActivityEvent, … ]  // complete, oldest first, ids strictly increasing
}
```

The types are those of `02-v0-spec.md` §2 (see also `src/types.ts`), with these additions:

- **Question**: `drop_reason?`, `default_window?` (`{opened_at, ends_at, paused_remaining_ms?}`), `rules_payload?`, `reopened_at?`, `reopen_baseline_state?`, `objections` (export only).
- **ResolutionRecord**: `outcome?` (`NormalizedState`), `attested?`.
- **PendingResolution**: `suggested_outcome?`.
- **Objection**: `{id, question_id, raised_by, raised_at, reason, addressed_at?, addressed_by?, address_note?}`.
- **ActivityEvent**: `{id, space_id, question_id?, at, actor, action, data}`. `actor` is a display name, `system` or `operator`. `data` holds before/after values for the action.

The process sits nested in its question as `question.process`, as in the spec. In storage it lives in its own table, so several processes per question can be allowed later. A future version of the format would then add `processes: []` alongside `process`.

### Action names

`space.created`, `question.created`, `question.edited`, `question.status_changed`, `question.reopened`, `steward.changed`, `criteria.changed`, `process.attached`, `process.replaced`, `process.removed`, `process.framing_changed`, `process.state_changed`, `process.refresh_failed`, `objection.raised`, `objection.addressed`, `objection_window.resumed`, `resolution.pending`, `resolution.cancelled`, `resolution.confirmed`, `tool.added`, `tool.enabled`, `tool.disabled`, `charter.changed`, `settings.changed`, `link.rotated`.

The full history of a question can be rebuilt from its events. For example, a previous resolution record is kept in the `question.reopened` event (`data.previous_record`).
