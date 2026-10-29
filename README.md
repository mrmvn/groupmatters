# Question register

A small web app where a group collects questions that need a collective answer. Each question is attached to the external process that will answer it (a GitHub PR, a Metaculus question, a Polis conversation…), and the register records when and how it was resolved.

This is **v0**, built for a month-long pilot with one real group.

## Quick start

Requires Node.js ≥ 24. There's no build step and no runtime dependencies.

```sh
npm install                      # dev tools only: typescript, linkedom (tests)
npm test                         # 57 tests: state machine, engine, adapters (fixtures), HTTP, UI smoke
node src/cli.ts create-demo      # demo space covering every status and criterion kind
npm start                        # → http://localhost:3000; open the edit link printed above
```

Create a real space with `node src/cli.ts create-space "Our group"`. It prints an **edit link** and a **view link**, once.

## What's in v0

- Questions with statuses (pool → active/standing → resolved; dormant; dropped), an active cap, stewards, "related" links and duplicates. All transitions are enforced on the server.
- One process per question, accepted only from tools on the space's **tool list**. GitHub and GitLab are fetched automatically; Metaculus, Loomio, Polis and Kialo are updated by hand.
- **Resolution criteria** (any-of): process outcome, date, default rule (objection window), steward attestation. Auto-confirmation for clear outcomes, a snapshot at resolution, and reopening.
- A **Rules** page with the charter, the tool list and settings. Anyone with edit access can add or enable/disable a tool by filling in a form (no voting). Charter and settings are changed by the operator for now.
- An append-only **activity log** (enforced by database triggers), "changed since your last visit", an Atom feed and a full JSON export.
- Access by secret link plus a display name; no accounts.

## Layout

```
src/            server (TypeScript, run directly by Node)
  types.ts      domain types (spec §2)
  questions.ts  status machine (spec §3)
  engine.ts     resolution engine (spec §4)
  criteria.ts   criteria validation + evaluation
  processes.ts  attach / refresh / manual updates
  tools.ts      tool registry + URL matching
  adapters/     GitHub, GitLab
  rules.ts      Rules-space templates
  http/         router + JSON API
  cli.ts        operator commands
public/         UI (vanilla JS modules, no build)
seed/charter.md default charter
test/           node:test suites + recorded API fixtures
docs/           API, export format, deployment, user guide
DECISIONS.md    choices made where the spec said "(decide)"
```

## Documentation

| File | What it is |
|---|---|
| `docs/USER-GUIDE.md` | One-page guide for the pilot group |
| `docs/DEPLOY.md` | Configuration, Docker/VPS, backups, security notes |
| `docs/API.md` | JSON API |
| `docs/EXPORT.md` | Export format `question-register/v1` |
| `DECISIONS.md` | Implementation decisions and M0 API findings |

## Design documents (hand-off pack)

| File | What it is |
|---|---|
| `01-project.md` | Vision, problem, users, principles, non-goals, prior art |
| `02-v0-spec.md` | The v0 specification, the source of truth |
| `03-plan.md` | Milestones, acceptance criteria, stack suggestions, security checklist |
| `04-charter-template.md` | Default rules a group starts with (copied to `seed/charter.md`) |
