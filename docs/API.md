# JSON API

Every UI action goes through this API. Base path: `/api/s/<token>/`. The token is the secret from the space link. The edit token allows everything; the view token allows `GET` only.

- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) need a display name in the `X-Actor-Name` header, URI-encoded (`encodeURIComponent("Chloé")`). It's recorded as the actor in the activity log.
- **Bodies** are JSON (`Content-Type: application/json`, max 256 KB).
- **Errors**: `{ "error": { "code": "…", "message": "…", "details"?: {…} } }` with HTTP 400 (invalid), 403 (forbidden / view-only), 404, 409 (conflict: `duplicate_title` / `duplicate_link` with `details.existing: {id, title}`, `already_related`, `removed`) or 429 (rate limited).
- **Question endpoints** return a *detail* object: `{ question, related, activity, tool }`. `related` lists every relation touching the question, in both directions: `{id, title, status, kind, direction: "to"|"from", created_at, created_by}`.

## Statuses

`status` is one of `not_started`, `open`, `accepted`, `rejected`, `concluded`, `withdrawn` (see `TOOLS.md`). `status_label` holds the space's label when the status is typed.

## Fields: retrieved or typed

A question's fields are `title`, `kind`, `status`, `summary`, `results_url`, `start` and `end`. Each is **retrieved** from the linked item (through a tool on the tool list) or **typed**. Typed values are stored in `question.typed: {field: {value, by, at}}`; a field not in there is retrieved. `value: null` means "none" (e.g. no end date even though the item has one).

Questions returned by the API (detail, list, export) carry `fields: {field: {value?, source: "typed"|"retrieved"|"empty", retrieved?, as?, by?, at?, retrievable}}`: `value` is the one in use, `retrieved` the item's value (also shown when a typed one wins), `as` the platform's own word for a mapped status (`"merged"`), `retrievable` whether the linked item can give this field at all.

- **Automatic tools** can give every field: title, kind (the item type), status (the category its state maps to), summary (results, outcome statement), results link, start (opened/scheduled) and end (ended, else the planned closing date).
- **Tools updated by hand** (Kialo, your own tools) and items that can't be read (private, missing token) give the kind and the page title.
- **Custom processes** (a link to a site not on the list, or no link) give nothing.

`title` and `status` are always set: when the item can't give them they're typed (by the person who created the question, or kept as they were when a process is removed or an item becomes private). Date values are a whole day (`"2026-03-01"`, a calendar day with no time zone) or a moment (ISO 8601 UTC); an end in the future is a planned end.

## Space

| Method & path | Body | Purpose |
|---|---|---|
| `GET space` | | Space (name, settings incl. `status_labels`, charter), `role`, `tools` (with the effective `fetch_mode`; `auto_unavailable: true` when an adapter needs server setup; `usage: {questions, in_progress}`), `custom_kinds` (custom processes in use, by typed kind: `[{kind, questions, in_progress}]`, most used first), `adapters`, `counts` by status, server `now`. Usage counts skip removed questions; `in_progress` counts questions whose status is `open` |
| `PUT settings/status-labels` | `{status_labels: [{label, state}]}` | Replaces the hand-set status labels. At least one `not_started` label. Returns `{space}` |
| `POST tools` | `{name, description?, url_patterns:[{pattern,item_type}]}`, or `{kind: "consul", base_url, name?, description?}` | Adds a tool updated by hand, or an instance of a supported platform (patterns generated, fetched automatically). Custom processes whose link the new tool recognises become its processes (logged as `process.tool_matched`; automatic ones are fetched at once). Returns `{tools}` |
| `PATCH tools/:id` | `{name, description?, url_patterns}` | Edits a tool (links its new patterns recognise are adopted the same way). Automatic tools (with an adapter): only `name` and `description`; changed `url_patterns` → 400. A missing `description` keeps the current one, `""` clears it (max 400 characters). Returns `{tools}` |
| `POST tools/:id/enabled` | `{enabled}` | Enables or disables a tool. Returns `{tools}` |
| `GET activity?before=<id>&limit=<n>` | | Activity log, newest first (max 1000 per page) |
| `GET export` | | Full JSON export (see `EXPORT.md`) |
| `GET similar?title=…&exclude=<id>` | | Up to 5 similar questions (duplicate hints) |
| `GET dashboard?you=&since=` | | Summaries for the dashboard, computed from the questions and the activity log (removed questions excluded): `totals`, `by_status`, `tools` (questions per tool or custom kind, with `in_progress` and `ended`), `unused_tools`, `item_types`, `weekly` (12 weeks: `added`, `answered`, `actions`), `streak {current, best}` (weeks in a row with activity), `days_to_answer` (median), `recent_answers`, `you` (matched by display name, case-insensitive; `null` without `you`), `attention`, `milestones`, and `since {changed}` when `since` is given. "Answered" = accepted, rejected or concluded; people exclude `system` and `operator` |
| `GET timeline?…` | | Same filters as `GET questions` (no `sort`). `{items, undated, now}`: the questions with a start date, sorted by start, as `{id, title, status, status_label?, process?: {tool_id, kind?}, start: {value, source}, end?: {value, source}}` (`source`: `typed` or `retrieved`); `undated` counts the matching questions left out (no start date) |
| `POST resolve-url` | `{url}` | Classify a pasted link: `{matched:true, tool_id, tool_name, item_type, fetch_mode, title?, fetched?, fetch_error?, existing?}`, or `{matched:false, suggestion}` for a site not on the tool list (still accepted; nothing is retrieved). `title` is for pre-filling (from the API, or the page title for manual tools). `existing: {id, title}` when a question already tracks this item (nothing is fetched then) |

## Questions

| Method & path | Body | Notes |
|---|---|---|
| `GET questions?…` | | Filters: `status` (comma list), `source=retrieved\|typed` (where the status comes from; `process`/`manual` also accepted), `tool` (incl. `custom`), `item_type` (the kind in use: typed, or the tool's item type), `state` (process state), `has_process=yes\|no`, `related` (question id), `q` (text), `preset=no_process\|quiet\|fetch_problems`, `sort=activity` (default)`\|created`, `removed=only` (removed questions, hidden otherwise). Each item has `activity_at` (the latest of its own activity and its process' activity on the platform) and `fields` |
| `POST questions` | `{title?, related_id?, process_url?, process?, status?, fields?}` | `process` is a process body (below), as an alternative to `process_url`. `fields` types `summary`, `results_url`, `start`, `end` (as in `PUT …/fields`; empty ones are ignored, so a retrieved value is kept); `why_it_matters` is still accepted but no longer shown. With a link, the title is retrieved when `title` is absent or equal to the retrieved one, typed otherwise (required when nothing is retrieved). The status is retrieved when the item can give it, unless `status` (`{label}` or `{state}`) is given (then typed). 409 if another question has the same title (ignoring case, accents, punctuation) or tracks the same item |
| `GET questions/:id` | | Detail |
| `PATCH questions/:id` | `{title?, why_it_matters?}` | A title given here is typed. 409 `duplicate_title` |
| `POST questions/:id/remove` | `{reason?}` | Hides the question (kept, restorable). A removed question is read-only (409 `removed`) |
| `POST questions/:id/restore` | | 409 if its title or link was taken meanwhile |
| `PUT questions/:id/fields` | `{set?: {field: value}, use_retrieved?: [field], note?}` | Type values, or go back to the retrieved ones. Values: `title`, `kind`, `summary` (text), `results_url` (a link, which must be https, or plain text), `start`/`end` (`"YYYY-MM-DD"` or an ISO moment), `status` (`{label}` or `{state}`). `null` or `""` means "none" (or, when the item can't give the field, removes the typed value). 400 for an end before the start (when one is typed), `use_retrieved` on a field the item can't give, `kind` without a process; 409 `duplicate_title`. Logged as `question.fields_changed` with each field's before/after `{source, value?}` |
| `PUT questions/:id/process` | process body | Attach or replace. The status then follows the item when it can be retrieved; a typed kind, summary and results link (they belonged to the previous process) are dropped. 409 `duplicate_link` if another question tracks the same item through a listed tool |
| `DELETE questions/:id/process` | | The question keeps its title and status, now typed; the typed kind goes |
| `POST questions/:id/process/refresh` | | Auto tools; response adds `refresh: {changed, error?, skipped?}` |
| `POST questions/:id/related` | `{id, kind?}` | Relates an existing question (this → id). `kind`: `related` (default) or `duplicate` (this question duplicates `id`). 409 if already related either way |
| `DELETE questions/:id/related/:otherId` | | Removes the relation, whichever its direction |

### Process body

```jsonc
{ "url": "https://www.loomio.com/p/AbCd1234" }      // any https link: retrieved through the tool that recognises it, else a custom process
{ "kind": "General assembly" }                        // no link: a custom process (the kind is typed)
{ "url": "https://notes.example.org/x", "kind": "Meeting" }  // both (the kind is typed); `{custom: {url?, kind?}}` is also accepted
```

## Atom feed

`GET /feed/<token>.atom` returns the last 50 events.
