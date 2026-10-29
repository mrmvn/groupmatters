# JSON API

Every UI action goes through this API. Base path: `/api/s/<token>/`. The token is the secret from the space link. The edit token allows everything; the view token allows `GET` only.

- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) need a display name in the `X-Actor-Name` header, URI-encoded (`encodeURIComponent("Chloé")`). It's recorded as the actor in the activity log.
- **Bodies** are JSON (`Content-Type: application/json`, max 256 KB).
- **Errors**: `{ "error": { "code": "…", "message": "…", "details"?: {…} } }` with HTTP 400 (invalid), 403 (forbidden / view-only), 404, 409 (conflict, e.g. `active_cap`), 422 (`unknown_tool`, with `details.suggestion`) or 429 (rate limited).
- **Question endpoints** return a *detail* object: `{ question, objections, parent, duplicate_of, children, duplicates, activity, steward_inactive, tool }`.

## Space

| Method & path | Purpose |
|---|---|
| `GET space` | Space (name, settings, charter), `role`, `tools`, `adapters`, `counts` by section/status, `active_count`, server `now` |
| `POST tools` | `{name, url_patterns:[{pattern,item_type}], state_map?}` | Adds a manual tool immediately (no proposal or vote). Returns `{tools}` |
| `POST tools/:id/enabled` | `{enabled}` | Enables or disables a tool. Returns `{tools}` |
| `GET activity?before=<id>&limit=<n>` | Activity log, newest first (max 1000 per page) |
| `GET export` | Full JSON export (see `EXPORT.md`) |
| `GET similar?title=…&exclude=<id>` | Up to 5 similar questions (duplicate hints) |
| `POST resolve-url` `{url}` | Classify a pasted link: `{matched:true, tool_id, tool_name, item_type, fetch_mode, fetched?}` or `{matched:false, suggestion}` |

## Questions

| Method & path | Body | Notes |
|---|---|---|
| `GET questions?…` | | Filters: `status` (comma list), `section`, `tool`, `item_type`, `state`, `mode`, `has_process=yes\|no`, `steward`, `parent`, `q` (text), `preset=no_process\|criteria_tbd\|ready\|objections` |
| `POST questions` | `{title, why_it_matters?, section?, parent_id?, process_url?, framing?, resolution?, rules_payload?, adopt?}` | Creates in `inbox`. With `adopt:true`, the creator adopts it in the same step |
| `GET questions/:id` | | Detail |
| `PATCH questions/:id` | `{title?, why_it_matters?, parent_id?}` | |
| `PUT questions/:id/resolution` | `{mode, criteria}` | See criteria below |
| `PUT questions/:id/process` | `{url, framing?}` | Attach or replace |
| `PATCH questions/:id/process` | `{framing}` | |
| `DELETE questions/:id/process` | | Also removes the `process_outcome` criterion |
| `POST questions/:id/process/refresh` | | Auto tools; response adds `refresh: {changed, error?, skipped?}` |
| `POST questions/:id/process/manual` | `{state, raw_state?, outcome_summary?, results_url?}` | Manual tools; steward only |

### Actions: `POST questions/:id/<action>`

| Action | Body | Transition / effect |
|---|---|---|
| `adopt` | `{resolution?}` | inbox/dormant → active (criteria) or standing (open); actor becomes steward |
| `activate` | `{resolution}` | standing → active (steward) |
| `park` | `{reason?}` | active/standing → dormant (steward) |
| `revive` | | dormant → inbox |
| `drop` | `{reason, duplicate_of_id?}` | → dropped (steward, or anyone if none) |
| `restore` | `{reason}` | dropped → inbox |
| `reopen` | `{reason}` | resolved → active |
| `hand_over` | `{to?}` | steward only; empty `to` → back to inbox |
| `take_over` | | actor becomes steward |
| `object` | `{reason}` | default-rule questions |
| `address` | `{objection_id, note}` | steward |
| `attest` | `{attested, outcome?, synthesis?}` | steward; resolves |
| `confirm` | `{outcome?, synthesis?}` | confirms a pending resolution |

### Criteria

```json
{ "mode": "criteria", "criteria": [
  { "kind": "process_outcome", "accept_states": ["accepted"] },
  { "kind": "date", "at": "2026-03-01T00:00:00Z" },
  { "kind": "default_rule", "days": 7 },
  { "kind": "attested", "description": "Majority at the AGM" }
]}
```

`mode` can also be `"tbd"` or `"open"`, both with an empty `criteria` list. A question can have at most one criterion of each kind.

### Rules payloads (`rules_payload` on `POST questions`)

```json
{ "kind": "add_tool", "tool": { "name": "Our forum",
  "url_patterns": [{ "pattern": "https://forum.example.org/t/*", "item_type": "topic" }],
  "state_map": { "Open": "open", "Closed": "concluded" } } }
{ "kind": "change_charter", "charter_markdown": "…", "settings": { "active_cap": 10 } }
{ "kind": "set_tool_enabled", "tool_id": "kialo", "enabled": false }
```

The payload is applied when the question resolves with outcome `accepted`.

## Atom feed

`GET /feed/<token>.atom` returns the last 50 events.
