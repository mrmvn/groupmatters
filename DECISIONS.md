# Decisions

Choices made where the spec says **(decide)** or is silent, with short rationale. The spec (`02-v0-spec.md`) remains authoritative.

## Stack

- **TypeScript on Node ≥ 24, no build step.** Node runs `.ts` files natively (type stripping); `tsc --noEmit` is only used for type-checking. Developed and tested on Node 26.
- **Zero runtime dependencies.** `node:http` for the server, `node:sqlite` for storage, the global `URLPattern` for tool patterns. Dev-only: `typescript`, `@types/node`, `linkedom` (DOM for the UI smoke test). Less supply-chain risk, trivial self-hosting.
- **Frontend: vanilla ES modules** in `public/`, no framework, no bundler. Allows a strict CSP (`script-src 'self'`, no inline scripts or styles) and keeps the UI one replaceable view over the JSON API.
- **SQLite** behind one data-access module (`src/repo.ts`); nested values (criteria, records, settings) stored as JSON columns. Postgres stays possible by reimplementing `repo.ts`.
- **HTTP layer is a pure function** `route(request) → response` with a thin `node:http` wrapper, so it's testable without sockets.

## M0: external APIs (verified 2026-10-29)

| Tool | v0 mode | Evidence |
|---|---|---|
| GitHub | **auto** | `GET api.github.com/repos/{o}/{r}/pulls/{n}` and `/issues/{n}` work unauthenticated (60 req/h; 5,000/h with `GITHUB_TOKEN`). `merged`/`merged_at` and issue `state_reason` (`completed`, `not_planned`, `duplicate`) confirmed. Conditional requests with ETag supported (304s don't count against the limit when authenticated). Fixtures: `test/fixtures/github_*.json`. |
| GitLab | **auto** | `GET {host}/api/v4/projects/{url-encoded path}/merge_requests/{iid}` and `/issues/{iid}` work unauthenticated on gitlab.com (`ratelimit-limit: 500`). MR states `opened/closed/locked/merged`; issues only `opened/closed` (no close reason), `moved_to_id` present. Issue web URLs are now `/-/work_items/{iid}`, both forms accepted. Fixtures: `test/fixtures/gitlab_*.json`. |
| Metaculus | **manual** | `GET /api/posts/{id}/` and `/api2/questions/{id}/` return **403 "The API is only available to authenticated users"**. Official docs confirm every request needs a token. A token-based adapter can come later. |
| Loomio | **manual** | The API (`/api/b1`, `/api/user0`) needs a user API key and only sees that user's groups. There's no public read endpoint for arbitrary polls. |
| Polis, Kialo | manual | As specified. |

## State mapping

- **GitHub PR**: draft → `not_started`; open → `open`; merged → `accepted`; closed unmerged → `rejected`.
- **GitHub issue**: closed `completed` → `accepted`, `not_planned` → `rejected`, `duplicate` → `withdrawn`, closed with no reason (old issues) → `concluded` (needs confirmation). An `/issues/N` URL that points to a PR is handled as a PR.
- **GitLab MR**: same as GitHub; `locked` → `open`.
- **GitLab issue**: closed → `concluded`, because GitLab doesn't record why it was closed, so the steward confirms. Moved → `withdrawn`.

## Spec "(decide)" items

- **One criterion per kind**: enforced strictly, as recommended.
- **URL pattern syntax**: WHATWG **URLPattern** (`https://pol.is/:id`, `https://forum.example.org/t/*`). It's easier to read and write than regexes for people proposing manual tools.
- **Evaluation interval**: every 15 min (`TICK_MS`), and also immediately after every refresh and every relevant action (adopt, criteria change, address, manual update…).
- **Refresh schedule**: open items every 15 min, terminal ones daily. On errors: exponential backoff (15 min × 2ⁿ, up to 24 h) that respects `Retry-After`/rate-limit reset. ETag conditional requests. Previews are cached for 60 s so paste-then-create fetches once. On-demand refresh is throttled to once per 30 s per process.
- **Addressing objections**: the window **pauses** at the first open objection. Once all are addressed, it resumes for the time that was left, or for a full window if fewer than 2 days were left.
- **Steward inactive**: no activity-log entry by the steward's display name anywhere in the space for 7 days. After that, anyone can confirm.
- **Link rotation**: CLI command `rotate-link <space-id> edit|view`, logged as `link.rotated` by `operator`.
- **Space creation**: CLI only (`create-space`), which prints both links once. No public creation page, so nobody can create spaces on a pilot server without the operator.
- **Atom feed**: included at `/feed/<token>.atom` (last 50 events). The UI only offers it with the view link, so the edit link doesn't end up in feed readers.
- **REST shape**: see `docs/API.md`.
- **CSP**: strict. `default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`.

## Where the spec was silent

- **Additive fields.** `ResolutionRecord.outcome` (the final `NormalizedState`) and `.attested`; `PendingResolution.suggested_outcome`; `Question.drop_reason`, `default_window`, `rules_payload`, `reopened_at`, `reopen_baseline_state`. All are additive and appear in the export.
- **Outcome on confirmation.** The confirmer picks the outcome, with a sensible default: the process state for `process_outcome`, the process state (if terminal) or `concluded` for `date`, and `accepted` for `default_rule` and `attested`. This covers "let the steward choose accepted/rejected" for Loomio.
- **Rules payloads apply only when the outcome is `accepted`.**
- **Third Rules template, `set_tool_enabled`.** §8 requires that disabling a tool goes through a Rules question; a template makes it apply automatically.
- **Rules proposals are immutable** once created, so nobody can change a proposal after others have stopped objecting. To change one, drop it and propose again.
- **Rules questions** must include the `default_rule` criterion (others may be added). They **don't count toward the active cap**, which is about the group's attention on main questions; capping them could block changes to the rules themselves.
- **Reopening.** A process outcome that already counted before reopening doesn't trigger again (the baseline state is stored), and a date that was already in the past at reopening is ignored. Otherwise a reopened question would resolve again within 15 minutes. The steward can set new criteria.
- **An objection raised while a default-rule resolution is pending** cancels the pending resolution. **Changing criteria** cancels any pending resolution and re-evaluates.
- **Removing the process** of an active question is refused when `process_outcome` is its only criterion (otherwise an active question would have no criteria).
- **Who can change criteria**: anyone in inbox/dormant/dropped; only the steward in active/standing.
- **Stewardship**: anyone can take over (except in inbox, where you adopt instead). Returning to the inbox (handover to nobody, dormant → inbox, dropped → inbox) clears the steward. Reopening keeps the steward, and makes the actor steward if there's none.
- **Display names**: compared case-insensitively. `system` and `operator` are reserved. Max 60 characters, sent URI-encoded in `X-Actor-Name`.
- **Dormancy** is checked hourly. The effect is the same as a daily job.
- **Duplicate hints**: word overlap with en/fr/es/de stop-words plus substring matching. Spaces are small, so in-memory search is enough.
- **Manual tools** get an optional "link to results" (`extra.results_url`), which covers the Polis report link.
- **GitLab self-hosted instances** are only fetched when the operator lists their host in `GITLAB_HOSTS` (an SSRF guard). Otherwise the URL is treated as unmatched.
- **Markdown** (charter, synthesis) is rendered by a small built-in renderer that builds DOM nodes and never passes HTML through, instead of a sanitizer library.
- **Security extras**: tokens are 256-bit and stored as SHA-256 hashes (their high entropy makes a slow KDF unnecessary), compared with `timingSafeEqual`. Writes are rate-limited (120/min per token, in memory). Cross-origin writes are refused by an `Origin` check. Request logs redact tokens.
- **Date criteria** are entered in the browser's local time and stored in UTC.

## Simplification pass (post-v0)

- **No voting/proposals in the UI for now.** Adding (and enabling/disabling) a tool is a direct form action by anyone with edit access (`POST tools`, `POST tools/:id/enabled`), logged in the activity log. (The Rules-question code was later removed with the rest of the decision model, see below.)
- **"Pool" replaces "Inbox"** in all user-facing text. The internal status id stays `inbox`, so no data migration.
- **"Related" replaces "part of"** in the UI. The data model is unchanged (`parent_id`, one per question).
- **Relations table replaces `parent_id`.** Relations are many-to-many and directed (`from → to`, with a `kind`), so asymmetric kinds ("depends on", "part of"…) can come later; every relation is shown on both questions. Kinds: `related`, and since migration 3 `duplicate`. Migration 2 moves existing `parent_id` links into it (child → parent) and blanks the column. Export format bumped to v2. Relating an existing question is done from its "Related questions" box: suggestions there are link targets, not navigation.
- **Manual tools are editable** (name, URL patterns, states) via `PATCH tools/:id`, logged as `tool.edited`. Automatic tools (GitHub, GitLab) are tied to their adapter and can only be enabled/disabled. Processes keep their tool and recorded state when a tool changes.

## Status model (migration 3)

- **Question-level decisions are removed.** No adopt, resolution criteria, objection windows, stewards, active cap, dormancy, confirm/synthesis or Rules proposals. They may come back for some kinds of questions or processes, deliberately. The code was deleted rather than hidden; the history stays readable in the activity log.
- **One shared vocabulary.** Questions and processes use the same six categories: `not_started`, `open` ("In progress"), `accepted`, `rejected`, `concluded`, `withdrawn` (`unknown` is process-only). Tool states map onto them (`docs/TOOLS.md`).
- **A question follows its process or is set by hand.** `status_source: "process"` copies the process' category on every change (logged as `system` for fetched changes). `"manual"` uses a label from the space's **status labels** (`settings.status_labels`, `[{label, state}]`, editable on the Rules page; at least one `not_started` label, used for new questions). Linking a process makes the question follow it; removing it keeps the status, now set by hand. An `unknown` process state leaves the question unchanged.
- **Migration of old statuses**: with a process (and not resolved/dropped) → follow the process; inbox/dormant → Not started; active/standing → Being discussed (open); resolved → its recorded outcome (default concluded); dropped → Dropped (withdrawn). `duplicate_of_id` → a `duplicate` relation. The objections table is dropped. A `model.simplified` event is logged per space, and the database is snapshotted first (`VACUUM INTO <db>.before-v3.bak`). Tables with changed CHECK constraints are rebuilt (SQLite's 12-step procedure, foreign keys off during migrations).
- **Lanes**: Current (not started + in progress), Ended (accepted, rejected, concluded), Withdrawn. Lists sort by latest activity: the question's own, or its process' activity on the platform (`fetched.dates.updated_at`), whichever is later. Presets: no process, quiet for 30+ days, fetch problems.

## Processes

- **One process per question**, as before, but it can be a **custom process** (`tool_id: "custom"`, not a row in the tool list): a kind in the group's words ("General assembly"), optional title, date and link (any https URL). Its state is set by hand with the space's status labels.
- **Hand-set states by anyone with edit access** (no steward any more).
- **New adapters**: Loomio (public polls and threads via the API Loomio's web client uses, `/api/v1/polls/:key` and `/api/v1/discussions/:key`), Polis (`/api/v3/conversations`, `/api/v3/reports`), Metaculus (`/api/posts/:id/`, only with `METACULUS_TOKEN`; untested live). Verified live in October 2026 except Metaculus. Existing Loomio/Polis seed tools and their processes were switched to automatic by migration 3.
- **Fallback to updating by hand.** Adapters raise `manualFallback` for items that exist but can't be read (401/403, missing token). On attach the process is stored as manual with the reason; on refresh it switches to manual and logs `process.now_manual`. Tools whose adapter isn't usable on this server (Metaculus without a token) behave as manual; the API marks them `auto_unavailable`.
- **Loomio outcome**: closed polls are `concluded` unless the poll template defines a pass test (`results[].test_result`), since Loomio has no general "passed" flag. The facilitator's outcome statement, or the per-option results, become the summary.
- **Last activity**: GitHub/GitLab `updated_at`, Loomio thread `last_activity_at`, Polis `modified` (last vote, in µs). Metaculus has none.
- **Title pre-fill for manual tools** fetches the page and reads `og:title`/`twitter:title`/`<title>` (`src/pagetitle.ts`). Guarded against SSRF: https, port 443, public addresses only (DNS resolved and checked at every redirect hop, redirects followed by hand), 512 KB, 8 s. Generic titles (site name, login walls, bot challenges) are discarded. Kialo and Metaculus pages give nothing useful (login wall / bot challenge).

## Duplicates and removal (migration 4)

- **No duplicate titles or links.** Titles are compared without case, accents, punctuation or spacing (`normalizeTitle`). Links are compared by canonical URL (no `www.`, `#fragment`, trailing slash or `utm_*`) and, when an adapter parses them, by the platform's ids (so `/p/KEY/one-slug` and `/p/KEY/other-slug` are the same Loomio poll). Refused with 409 `duplicate_title` / `duplicate_link` and `details.existing`; the composer shows the existing question (and on a question page, offers to relate it). `resolve-url` reports `existing` before fetching anything. Custom processes aren't checked, since one meeting can address several questions. Near-duplicates (different wording) are still left to the suggestions and the `duplicate` relation.
- **Removing is hiding.** `removed_at` on the question: hidden from lists, counts, suggestions, relations and duplicate checks; its process is no longer refreshed; read-only until restored (`POST …/restore`, refused if its title or link was taken meanwhile). Hard deletion stays impossible (trigger), so the append-only log keeps making sense. Removal is for mistakes and spam; *Withdrawn* is for questions that didn't run their course.
- **State mappings are edited as rows** (the tool's own word → category), for tools and for status labels, instead of `label → state` text lines.

## Civic tech platforms (migration 5)

- **Decidim on any host, without setup.** A seed tool with host-wildcard patterns on Decidim's distinctive paths (`/<space>/<slug>/f/<component>/<proposals|debates|meetings>/<id>`, and `/processes/<slug>`); migration 5 adds it to existing spaces. The adapter POSTs a GraphQL query to the instance's `/api`.
- **Consul per instance.** Consul paths are too generic to match on any host, so a space adds its instance (`POST tools {kind: "consul", base_url}`); patterns are generated for that host. GraphQL GET at `/graphql` with a browser-like user agent (Consul's docs say some servers require it).
- **Fetching arbitrary hosts safely.** Both adapters refuse hosts that don't resolve only to public addresses (same check as title pre-fill), never follow redirects to another host, use fixed paths and small responses. This is a deliberate widening from "fixed API hosts" to "any public host matching the tool's patterns"; DNS rebinding between the check and the request remains a theoretical gap.
- **Version tolerance.** `tolerantQuery` drops fields reported as `undefinedField` and retries (Decidim 0.27 has no `proposalState`; forks differ). Consul tries snake_case when camelCase yields only id/title.
- **Mappings.** Decidim custom proposal states have no known meaning: Concluded once answered, In progress before. Meetings and processes follow their dates (processes end at the end of their end day, UTC). Consul proposals are In progress until retired; the retirement reason gives the category.
- **Drag and drop a link**: dropping a link anywhere (edit link only) fills the home composer; on a question without a process it opens "Link a process" prefilled. Drops into text fields behave normally.
