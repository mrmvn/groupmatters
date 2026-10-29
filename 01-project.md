# Project description

## One-line summary

A process-agnostic register of questions a group needs to answer collectively. Each question links to the external tool that will answer it, states what counts as "answered," and keeps a record of the outcome.

## The problem

Groups already make collective decisions and answer shared questions across many tools: pull requests on GitHub, proposals on Loomio, forecasts on Metaculus, opinion maps on Polis, argument maps on Kialo, threads on forums. Each tool handles its own process well. What nobody has is a single place answering, for the group as a whole:

- What questions are we currently trying to answer?
- How is each one being answered, and where?
- What counts as "answered" for each one?
- What was the answer, by what process, and when?

All-in-one participation platforms (Decidim, Consul, Loomio) assume one tool runs the whole process. In practice, groups mix tools, and the record of what was decided gets lost between them.

## The idea

- The unit is a **question**. A decision is one kind of question ("should we do X?"), but the register also holds open curiosities with collective significance ("how do newcomers find a first task?").
- A question is written in the group's own words, independently of any platform.
- A question may have one **process**: a link to an item in an external tool that will help answer it. The register fetches that item's state where possible.
- A question states its **resolution criteria**: what makes it count as answered (the process reaching an outcome, a date, a default rule, a steward's attestation), or that it is deliberately open-ended.
- When a question resolves, the register takes a **snapshot** of the process state, so the record survives external edits or deletions.
- The group curates the register itself: adding questions, adopting them, merging duplicates, setting criteria. Discussion happens in the external tools, not in the register.
- The rules for how the register works (which tools are allowed, how questions are adopted, the default resolution rule) are themselves questions in a **Rules** space, changed through the same mechanism. The meta-process is reflexive from day one.

## Who it is for

- **Primary users: stewards and facilitators** of groups that already use several tools, such as open-source projects with governance outside the repository, cooperatives, DAOs, research and forecasting communities, and civic-tech teams running mixed participatory processes. They curate the register.
- **Secondary users: group members**, who mostly read it to see what is being decided and what was decided, and who drop in questions.
- **Participants in the external processes** mostly stay in those tools. The register links out to them; it does not try to replace them.

## Why not just use Notion, Anytype, Obsidian or Kumu?

The model can be piloted in any of those tools, and a pilot there is encouraged (see `03-plan.md`). A dedicated tool only earns its place through things general knowledge bases do poorly:

1. **Rules instead of conventions.** "Resolved" means the stated criteria were met, not that someone picked a dropdown value.
2. **Live external state with snapshots.** Normalized state across GitHub, Metaculus, Loomio and others, frozen at resolution.
3. **Provenance that cannot be silently rewritten.** An append-only activity log of who changed what.
4. **A structure governed by the group.** Adding a tool or changing a rule is itself a question resolved under the group's rules.
5. **Low-barrier access.** A secret link and a display name, no accounts.
6. **Neutrality and portability.** An open, exportable data model not tied to a vendor.

Longer term, those knowledge tools can become **views** on the register's data (an Obsidian export, a Kumu map) rather than competitors.

## Design principles

1. **Question first, platform second.** Questions are written in the group's words; processes are attached to them.
2. **Link out, don't absorb.** No discussion threads in the register. Deliberation lives in the linked tools.
3. **Explicit resolution.** Every active question says what "answered" means.
4. **Attention is scarce.** Capture is free (inbox), but active slots are capped and adoption requires a steward and criteria.
5. **Structure must pay for itself.** Every field and relation must change something visible or enforceable. Otherwise it is cut.
6. **Small vocabulary, governed growth.** New types, relations or tools are added through the Rules space, based on real need.
7. **Data separate from views.** The data model is API-first and exportable; the v0 UI is one view among possible others.
8. **Start simple, extend additively.** v0 constraints (one process per question, one parent relation) are enforced in a way that can be lifted later without migrations.

## Non-goals for v0

- Hosting discussion, voting or forecasting inside the register.
- Chat and social-media integrations (no clear unit boundaries).
- Accounts, passwords, SSO, email verification, private questions.
- Graph visualization, spatial layouts, multiple UI flavours.
- Interoperability with Decidim, Consul or similar beyond linking to their items.

## Prior art worth knowing

- **IBIS (Issue-Based Information System)**, Kunz and Rittel, ~1970: structures collective reasoning as issues (questions), positions and arguments. Validates the question-first approach. Later tools: Compendium, dialogue mapping.
- **Metagov Gateway and PolicyKit**: connected decision tools across platforms (Discord, Slack, Discourse, GitHub, Loomio, Open Collective…) with programmable governance policies. Gateway development was folded into PolicyKit in 2024. Different focus (automating policies), but useful lessons on multi-platform governance.
- **Polis, Kialo, Metaculus, Loomio, All Our Ideas**: candidate external processes.
- **Decidim, Consul**: all-in-one participation platforms, a contrast case.
