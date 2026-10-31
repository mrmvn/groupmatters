# Question register

A small web app where a group collects questions that need a collective answer. Each question can be attached to the process where it's worked on (a GitHub PR, a Loomio poll, a Polis conversation, a meeting…), and its status follows that process or is set by hand.

This is **v0**, built for a month-long pilot with one real group.

## Quick start

Requires Node.js ≥ 24. There's no build step and no runtime dependencies.

```sh
npm install                      # dev tools only: typescript, linkedom (tests)
npm test                         # questions & statuses, adapters (recorded fixtures), title pre-fill, HTTP, UI smoke
node src/cli.ts create-demo      # demo space with example questions and processes
npm start                        # → http://localhost:3000; open the edit link printed above
```

Create a real space with `node src/cli.ts create-space "Our group"`. It prints an **edit link** and a **view link**, once.

## What's in it

- Questions with a **status category** (not started, in progress, accepted, rejected, concluded, withdrawn). A question follows its process, or its status is set by hand from the space's editable status labels. Relations between questions (parent/child, related, duplicate), shown on both sides; children are listed under their parents, and duplicates suggest being withdrawn.
- One process per question: a link from the space's **tool list**, or a **custom** process (a meeting, an unconference…) with or without a link. GitHub, GitLab, public Loomio polls/threads, Polis, Decidim (any instance) and Consul Democracy (per instance) are fetched automatically (state, results, last activity); Metaculus too with an API token. Other tools are updated by hand, with the page title used to prefill questions. See `docs/TOOLS.md`.
- A **dashboard** (in the top-right menu): prototype widgets of fixed sizes for tools, statuses, momentum, attention, personal impact and milestones, each hideable.
- A **Tools** page (tool list, status labels, editable by anyone with edit access), **How this works** (the charter), the activity log and export, from the top-right menu.
- An append-only **activity log** (enforced by database triggers), "changed since your last visit", an Atom feed and a full JSON export.
- Access by secret link plus a display name; no accounts.

The v0 decision model (adopt, resolution criteria, objection windows, stewards, active cap, dormancy, Rules proposals) was removed to keep things simple; see `DECISIONS.md`.

## Layout

```
src/            server (TypeScript, run directly by Node)
  types.ts      domain types
  questions.ts  questions: create, edit, status, relations
  processes.ts  attach / refresh / hand-set states; questions follow their process
  tools.ts      tool registry + URL matching
  adapters/     GitHub, GitLab, Loomio, Polis, Metaculus, Decidim, Consul
  pagetitle.ts  title pre-fill for other tools (with SSRF guard)
  rules.ts      tool list and status labels
  http/         router + JSON API
  cli.ts        operator commands
public/         UI (vanilla JS modules, no build)
seed/charter.md default charter
test/           node:test suites + recorded API fixtures
docs/           API, tools & statuses, export format, deployment, user guide
DECISIONS.md    implementation decisions
```

## Documentation

| File | What it is |
|---|---|
| `docs/USER-GUIDE.md` | One-page guide for the pilot group |
| `docs/DEPLOY.md` | Configuration, Docker/VPS, backups, security notes |
| `docs/API.md` | JSON API |
| `docs/TOOLS.md` | What each platform exposes (states, last activity) and how states map to categories |
| `docs/EXPORT.md` | Export format `question-register/v3` |
| `DECISIONS.md` | Implementation decisions and M0 API findings |

## Design documents (hand-off pack)

| File | What it is |
|---|---|
| `01-project.md` | Vision, problem, users, principles, non-goals, prior art |
| `02-v0-spec.md` | The v0 specification, the source of truth |
| `03-plan.md` | Milestones, acceptance criteria, stack suggestions, security checklist |
| `04-charter-template.md` | Default rules a group starts with (copied to `seed/charter.md`) |
