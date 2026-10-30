# Tools: what can be fetched, and how states map

Every process state and every question status is in one of six **categories**:

| Category | Meaning |
|---|---|
| ○ **Not started** (`not_started`) | Nothing happening yet: draft, scheduled, upcoming |
| ◐ **In progress** (`open`) | Being discussed, voted on, forecast, worked on |
| ✔ **Accepted** (`accepted`) | Ended with a yes: passed, merged, completed, resolved Yes |
| ✕ **Rejected** (`rejected`) | Ended with a no: not passed, closed without merging, resolved No |
| ● **Concluded** (`concluded`) | Ended without a yes/no: a consultation closed, a poll with no pass rule, a thread closed |
| – **Withdrawn** (`withdrawn`) | Didn't run its course: deleted, duplicate, annulled, moved |

(`unknown` only appears on a process that couldn't be read.)

Each tool on a space's list has an optional **description** ("What is it useful for?"): built-in tools come with one, and anyone with edit access can change it, on any tool. It is shown in the Rules tool list, with how many questions use the tool, and when linking a process.

A question **follows its process** (its status is the process' category) or has a status **set by hand**, from the space's status labels (each label belongs to one category; editable on the Rules page).

## Per platform

Verified against the live APIs in October 2026, except Metaculus (needs an account token; written from its published OpenAPI spec).

| Platform | Item | Auth | Title | Platform state → category | Last activity | Other details |
|---|---|---|---|---|---|---|
| **GitHub** | pull request | none (token optional, raises rate limit) | ✔ | draft → Not started · open → In progress · merged → Accepted · closed unmerged → Rejected | ✔ `updated_at` | author, comments |
| | issue | | ✔ | open → In progress · closed (completed) → Accepted · closed (not planned) → Rejected · closed (duplicate) → Withdrawn · closed (other) → Concluded | ✔ `updated_at` | author, comments |
| **GitLab** (gitlab.com + `GITLAB_HOSTS`) | merge request | none (token optional) | ✔ | draft → Not started · opened/locked → In progress · merged → Accepted · closed → Rejected | ✔ `updated_at` | author, comments |
| | issue | | ✔ | opened → In progress · closed → Concluded (GitLab doesn't say why) · moved → Withdrawn | ✔ `updated_at` | author, comments, up/down votes |
| **Loomio** (loomio.com) | poll / proposal | none, **public items only** | ✔ | scheduled (not yet open) → Not started · open → In progress · closed → Concluded, or Accepted/Rejected when the poll template has a pass test · deleted → Withdrawn | ✔ thread's `last_activity_at` | results per option ("Looks good 19 · …"), votes cast/eligible, the facilitator's outcome statement, closing date |
| | thread | | ✔ | open → In progress · closed (locked) → Concluded · deleted → Withdrawn | ✔ `last_activity_at` | replies, active polls |
| **Polis** (pol.is) | conversation (or its report link) | none, public conversations | ✔ `topic` | active → In progress · closed → Concluded | ✔ last vote (`modified`) | participants; report link kept as "results" |
| **Metaculus** | question | **API token required** (`METACULUS_TOKEN`) | ✔ (with token) | upcoming → Not started · open → In progress · closed (awaiting resolution) → In progress · resolved Yes → Accepted · resolved No → Rejected · annulled/ambiguous → Withdrawn · other resolutions (number, date…) → Concluded · not published → Withdrawn | ✕ (no such field; `edited_at` is editorial) | forecasters, forecasts, comments |
| **Decidim** (any instance, no setup) | proposal | none, public items | ✔ (best of en/es/fr/ca/de… translations) | not answered → In progress · evaluating → In progress · accepted → Accepted · rejected → Rejected · withdrawn → Withdrawn · custom states (Decidim ≥ 0.28, e.g. "Main repo (merged)"): Concluded once answered, In progress before | ✔ `updatedAt` | supports, comments, the official answer |
| | meeting | | ✔ | before start → Not started · during → In progress · after → Concluded ("Held") · closed → Concluded (closing report as summary) · withdrawn → Withdrawn | ✔ `updatedAt` | attendees, start/end |
| | debate | | ✔ | by start/end dates when set, else In progress · closed → Concluded (conclusions as summary) | ✔ `updatedAt` | comments |
| | participatory process | | ✔ | before start → Not started · running → In progress (current step as the state: "Step 3 of 6: Voting") · after end → Concluded | ✔ `updatedAt` | number of steps |
| **Consul Democracy** (add your instance once on the Rules page) | proposal | none | ✔ | open → In progress · retired as *done* → Accepted, *started* → In progress, *unfeasible* → Rejected, *duplicated*/*other* → Withdrawn | ~ latest milestone date | supports, comments |
| | debate | | ✔ | always In progress (Consul debates don't close) | ✕ | votes for/against, comments |
| | participatory budget | | ✔ | informing/drafting → Not started · accepting … reviewing ballots → In progress (the phase as the state) · finished → Concluded | ✕ | — |
| | budget investment | | ✔ | unfeasible → Rejected · budget finished → Concluded · otherwise In progress | ~ latest milestone date | feasibility, price |
| **Kialo** | discussion | — | ✕ (login wall) | by hand | ✕ | — |
| **Your own tools** | any page matching the patterns | — | ✔ when the page has an `og:title` / `<title>` | by hand, from the tool's state list | ✕ | — |
| **Custom process** | a meeting, an unconference… (link optional) | — | typed by hand | by hand, from the space's status labels | ✕ | date ("when") |

### Notes

- **Private items fall back to updating by hand.** A private Loomio poll or Polis conversation (HTTP 401/403), or a Metaculus link on a server without a token, is still attached; its state is then set by hand from the tool's state list. If an item becomes private later, the process switches to "by hand" and the history says so.
- **Pass/fail on Loomio.** Loomio has no general "passed" flag. Only polls whose template defines a pass test report one; other closed polls are **Concluded**, with the results and the outcome statement as the summary. Set the question's status by hand if the group reads it as a yes or a no.
- **Decidim and Consul run on many servers.** Decidim links are recognised on any host (their paths are distinctive); Consul paths are generic (`/proposals/12`), so each instance is added once ("Add a tool" → *A Consul Democracy instance*). Both adapters only call public addresses (DNS checked first), at the instance's own `/api` (Decidim, POST) or `/graphql` (Consul, GET). Instances run different versions: fields an instance doesn't know are dropped and the query retried; Consul's older snake_case schema is tried when camelCase gives nothing. Forks with another schema (e.g. the German "projekt" Consul forks in Munich, Regensburg, Jena) only give a title; set states by hand there.
- **Consul has no "accepted" for proposals**: a proposal stays open until an admin retires it with a reason. Winning budget investments aren't exposed by the API either.
- **Self-hosted Loomio/Polis instances** aren't fetched yet (only loomio.com and pol.is). They could be added the same way as Consul instances.
- **Title pre-fill for other tools** reads the page's `og:title`, `twitter:title` or `<title>`. It only fetches https pages on public addresses (checked at every redirect, port 443, 512 KB max, 8 s timeout), and ignores generic titles (the site's name, login walls, bot challenges).
- **Refresh rhythm**: in-progress items every 15 minutes, ended items daily, with back-off on errors.

### Possible next adapters

- **Discourse** forums: public JSON (`/t/<id>.json`) with `closed`, `archived`, `last_posted_at`, and accepted answers.
- **Loomio/Polis self-hosted** instances behind an allow-list.
