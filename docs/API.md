# JSON API

Every UI action goes through this API. Base path: `/api/s/<token>/`. The token is the secret from the space link. The edit token allows everything; the view token allows `GET` only.

- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) need a display name in the `X-Actor-Name` header, URI-encoded (`encodeURIComponent("Chloé")`). It's recorded as the actor in the activity log.
- **Bodies** are JSON (`Content-Type: application/json`, max 256 KB).
- **Errors**: `{ "error": { "code": "…", "message": "…", "details"?: {…} } }` with HTTP 400 (invalid), 403 (forbidden / view-only), 404, 409 (conflict: `duplicate_title` / `duplicate_link` with `details.existing: {id, title}`, `already_related`, `removed`), 422 (`unknown_tool`, with `details.suggestion`) or 429 (rate limited).
- **Question endpoints** return a *detail* object: `{ question, related, activity, tool }`. `related` lists every relation touching the question, in both directions: `{id, title, status, kind, direction: "to"|"from", created_at, created_by}`.

## Statuses

`status` is one of `not_started`, `open`, `accepted`, `rejected`, `concluded`, `withdrawn` (see `TOOLS.md`). `status_source` is `"process"` (the question follows its process) or `"manual"` (set by hand; `status_label` holds the space's label).

## Space

| Method & path | Body | Purpose |
|---|---|---|
| `GET space` | | Space (name, settings incl. `status_labels`, charter), `role`, `tools` (with the effective `fetch_mode`; `auto_unavailable: true` when an adapter needs server setup), `adapters`, `counts` by status, server `now` |
| `PUT settings/status-labels` | `{status_labels: [{label, state}]}` | Replaces the hand-set status labels. At least one `not_started` label. Returns `{space}` |
| `POST tools` | `{name, url_patterns:[{pattern,item_type}], state_map?}`, or `{kind: "consul", base_url, name?}` | Adds a manual tool, or an instance of a supported platform (patterns generated, fetched automatically). Returns `{tools}` |
| `PATCH tools/:id` | `{name, url_patterns, state_map?}` | Edits a manual tool (automatic tools: 400). Returns `{tools}` |
| `POST tools/:id/enabled` | `{enabled}` | Enables or disables a tool. Returns `{tools}` |
| `GET activity?before=<id>&limit=<n>` | | Activity log, newest first (max 1000 per page) |
| `GET export` | | Full JSON export (see `EXPORT.md`) |
| `GET similar?title=…&exclude=<id>` | | Up to 5 similar questions (duplicate hints) |
| `POST resolve-url` | `{url}` | Classify a pasted link: `{matched:true, tool_id, tool_name, item_type, fetch_mode, title?, fetched?, fetch_error?, existing?}` or `{matched:false, suggestion}`. `title` is for pre-filling (from the API, or the page title for manual tools). `existing: {id, title}` when a question already tracks this item (nothing is fetched then) |

## Questions

| Method & path | Body | Notes |
|---|---|---|
| `GET questions?…` | | Filters: `status` (comma list), `source=process\|manual`, `tool` (incl. `custom`), `item_type`, `state` (process state), `has_process=yes\|no`, `related` (question id), `q` (text), `preset=no_process\|quiet\|fetch_problems`, `sort=activity` (default)`\|created`, `removed=only` (removed questions, hidden otherwise). Each item has `activity_at`: the latest of its own activity and its process' activity on the platform |
| `POST questions` | `{title, why_it_matters?, related_id?, process_url?, framing?, process?, status?}` | `process` is a process body (below), as an alternative to `process_url`. With a process the question follows it, unless `status` (`{label}` or `{state}`) is given. 409 if another question has the same title (ignoring case, accents, punctuation) or tracks the same item |
| `GET questions/:id` | | Detail |
| `PATCH questions/:id` | `{title?, why_it_matters?}` | 409 `duplicate_title` |
| `POST questions/:id/remove` | `{reason?}` | Hides the question (kept, restorable). A removed question is read-only (409 `removed`) |
| `POST questions/:id/restore` | | 409 if its title or link was taken meanwhile |
| `PUT questions/:id/status` | `{source: "process"}` or `{source: "manual", label \| state, note?}` | Follow the process, or set by hand |
| `PUT questions/:id/process` | process body | Attach or replace. The question then follows the process. 409 `duplicate_link` if another question tracks the same item (custom processes aren't checked) |
| `PATCH questions/:id/process` | `{framing}` | |
| `DELETE questions/:id/process` | | The question keeps its status, now set by hand |
| `POST questions/:id/process/refresh` | | Auto tools; response adds `refresh: {changed, error?, skipped?}` |
| `POST questions/:id/process/manual` | `{state, raw_state?, outcome_summary?, results_url?}` | Processes updated by hand (manual tools, custom processes, private items). `raw_state` is the label shown |
| `POST questions/:id/related` | `{id, kind?}` | Relates an existing question (this → id). `kind`: `related` (default) or `duplicate` (this question duplicates `id`). 409 if already related either way |
| `DELETE questions/:id/related/:otherId` | | Removes the relation, whichever its direction |

### Process body

```jsonc
{ "url": "https://www.loomio.com/p/AbCd1234", "framing": "optional" }        // a link from a listed tool
{ "custom": { "kind": "General assembly", "title": "optional",              // a custom process
              "url": "https://… (optional)", "when": "2026-03-01T18:00:00Z" },
  "framing": "optional" }
```

## Atom feed

`GET /feed/<token>.atom` returns the last 50 events.
