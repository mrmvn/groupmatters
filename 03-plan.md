# v0 implementation plan

> **Historical design document.** Written before the pilot; parts (adopt, criteria, stewards, snapshots, active cap) were removed. See `DECISIONS.md` and `docs/` for what the app does now.

Goal: a deployable v0 that one real group can use for a month-long pilot. Scope is defined in `02-v0-spec.md`.

## Stack suggestions

These are recommendations, not requirements. Record the final choice in `DECISIONS.md`.

- **Language:** TypeScript end to end.
- **Web framework:** a full-stack framework with server routes (for example SvelteKit or Next.js), or a small API server plus a lightweight frontend.
- **Database:** SQLite for v0 (single file, easy to self-host and back up), behind a thin data-access layer so Postgres stays an option.
- **Scheduled jobs:** in-process scheduler for refresh, criteria evaluation and dormancy. One instance only in v0.
- **Deployment:** a single container plus a mounted volume for the database. Document how to run it locally and on a small VPS.
- **Tests:** unit tests for the state machine, criteria engine and adapters; adapter tests use recorded fixtures, never live APIs in CI.

## Milestones

### M0 — Verify external APIs and set up the project

Tasks:
- Check the current public APIs for GitHub, GitLab, Metaculus and Loomio: endpoints, authentication needs, rate limits, and how terminal states are represented. Use official documentation.
- Decide per tool whether v0 uses `auto` or `manual` fetch mode (spec §5.3), and record it.
- Record sample responses as test fixtures.
- Set up the repository, stack, linting, tests, and `DECISIONS.md`.

Done when: `DECISIONS.md` lists each seed tool's fetch mode with evidence, fixtures exist for every auto tool, and an empty app runs locally.

### M1 — Spaces, access, activity log

Tasks:
- Space creation (operator command or page) returning edit and view links once.
- Token handling: hashed storage, view vs edit permissions, link rotation command.
- Display-name prompt and storage.
- Append-only activity log and the API to read it.

Done when: two links work with the right permissions, every write is logged with the actor's display name, and log entries cannot be modified through the application.

### M2 — Questions, statuses, lanes, search

Tasks:
- Question create/edit with title, why it matters, parent.
- Status machine exactly as in spec §3, including the active cap, stewardship rules and drop/duplicate handling.
- Space home with lanes and cards, question page, duplicate hints on entry.
- Search and filters from spec §7 (process-related filters can return empty until M3).

Done when: all transitions in spec §3 are enforced by the server (not only the UI) and covered by tests, including refused transitions.

### M3 — Tool registry and processes

Tasks:
- Per-space tool registry seeded with the v0 tools.
- URL matching and classification; "propose adding this tool" path for unmatched URLs (the Rules question itself arrives in M5; in M3 it can create a plain inbox question in the Rules section).
- Adapters for the tools marked `auto` in M0, with normalization to `NormalizedState`, `terminal`, `outcome_summary`, dates and `extra`.
- Manual state form for manual tools.
- Scheduled refresh and on-demand refresh, with backoff and caching.
- "Paste a link" flow with title prefill.

Done when: pasting a GitHub PR URL creates a question with the PR's title and state; merging or closing the PR is reflected after a refresh; a Polis URL can be attached and its state set by hand; an unregistered URL is refused with the propose option.

### M4 — Resolution engine

Tasks:
- Criteria editing (spec §2.4) with any-of semantics and per-kind validation.
- Adoption gate: `active` requires criteria; `standing` requires `open`.
- Evaluation job and on-refresh evaluation; pending resolution and confirmation flow; auto-confirmation for unambiguous process outcomes.
- Default rule: objection window, objections, addressing objections.
- Attestation.
- Snapshots at resolution; reopening.
- Daily dormancy job.

Done when: each criterion kind resolves a question correctly in tests, including the combination "process outcome or date, whichever first"; snapshots contain the process state at resolution time; an objection blocks a default-rule resolution until addressed.

### M5 — Rules space, charter, export

Tasks:
- Rules page with charter, registry table and Rules questions.
- "Add a tool" and "Change charter or settings" templates that apply their payload when resolved as accepted.
- Charter seeded from `04-charter-template.md`.
- Full JSON export endpoint and a short format description in the repository.
- Optional: Atom feed per space.

Done when: a manual tool can be proposed, objected to, addressed, accepted, and then used for a new process, entirely through the UI; export round-trips all data in the space.

### M6 — Pilot readiness

Tasks:
- Security checks (below).
- Deployment guide and backup instructions.
- A demo space with seed questions covering every status and criterion kind.
- A one-page user guide for the pilot group, in plain language.

Done when: a non-developer can open the edit link on a phone, add a question, paste a GitHub link, adopt it with criteria, and see it resolve.

## Security checklist

- Tokens: high entropy, hashed at rest, never logged in plain text, constant-time comparison.
- `Referrer-Policy: no-referrer` on all pages, and `rel="noopener noreferrer"` on external links, so secret links in the URL path don't leak to external sites.
- **No server-side request forgery:** adapters only call hard-coded API hosts (or the GitLab instance host parsed from a matched pattern) built from parsed identifiers, never the raw user URL. Manual tools never fetch anything.
- Accept `https` URLs only for processes.
- Escape all external and user content; render markdown (charter, synthesis) with a sanitizer.
- Rate-limit write endpoints per token.
- Content Security Policy that disallows inline scripts **(decide on strictness given the framework)**.
- No third-party analytics or trackers.

## Optional: pilot in Anytype first

If the group wants to test the model before the app exists:
- Object types: **Question** (title, why it matters, status, steward, resolution mode, criteria as text, parent, process URL, tool, item type, process state, framing, synthesis) and **Tool** (name, URL pattern, item types, fetch mode, approved by).
- Process stays as properties of the Question, matching the nested model.
- Collections or set views stand in for the lanes, filtered by status.
- The charter is a page; Rules questions are Questions tagged "rules."
- Snapshots and the activity log are manual (a "resolution note" with the external state copied in).

Note where the pilot is painful (status changed without criteria being met, links going stale, no record of who changed what). Those observations should shape priorities after v0.

## After v0: likely next steps

Driven by pilot feedback, in no fixed order: several processes per question, on-platform seconding and quorum, Atom/email digests, more adapters (Discourse, Manifold, Decidim), import, alternative views (Obsidian export, Kumu map), SSO.
