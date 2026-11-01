# GroupMatters

Keep track of your group's matters, and link them to where they're worked on. Each matter can be attached to an external link (a GitHub PR, a Loomio poll, a Polis conversation, a meeting…), and its status follows that process or is set by hand. Some tool adaptors are built-in, but new ones can be added. 

This is a prototype for experimentation.

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

- **Matters** with a status category (not started, in progress, accepted, rejected, concluded, withdrawn), either followed from their process or set by hand using the space's editable status labels. Relations between matters (parent/child, related, duplicate).
- **One attached link per matter**: a URL allowed from the space's tool list, or a custom process (a meeting, an unconference…). GitHub, GitLab, public Loomio polls/threads, Polis, OpaVote, Decidim and Consul Democracy are fetched automatically; Metaculus too with an API token. Other links are updated by hand. See `docs/TOOLS.md`.
- A **dashboard** with collective numbers only (no individual rankings), a **timeline** view, **Tools** and **About** pages, and "changed since your last visit".
- An append-only **activity log** (enforced by database triggers), an Atom feed, an ICS calendar and a full JSON export. Installable on phones.
- Access by secret link plus a display name; no accounts.

## Layout

```
src/        server (TypeScript, run directly by Node): questions, processes, adapters/, http/, cli.ts…
public/     UI (vanilla JS modules, no build)
test/       node:test suites + recorded API fixtures
docs/       user guide, deployment, API, tools, export format
deploy/     VPS deployment scripts and systemd/Caddy files
```

## Documentation

- `docs/USER-GUIDE.md`: one-page guide for a group
- `docs/DEPLOY.md`: configuration, Docker/VPS, backups, security
- `docs/API.md`: JSON API
- `docs/TOOLS.md`: what each platform exposes and how states map to categories
- `docs/EXPORT.md`: export format
- `DECISIONS.md`: implementation decisions

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a service, you must offer its source to your users.
