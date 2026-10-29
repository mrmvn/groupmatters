# v0 specification

This document is the source of truth for v0. Markers:
- **(decide)**: implementer chooses, records the choice in `DECISIONS.md`.
- **(deferred)**: not in v0; keep the model compatible where noted.

## 1. Concepts

| Concept | Meaning |
|---|---|
| **Space** | One group's register. A server can host several spaces; they share nothing. |
| **Question** | The core unit: something the group wants a collective answer to, in the group's words. |
| **Process** | An optional nested attribute of a question: a link to one item in an external tool, plus fetched state and an optional framing. At most one per question in v0. |
| **Tool** | An entry in the space's tool registry. A process URL is only accepted if it matches a registered tool. |
| **Resolution criteria** | What makes a question count as answered. A list of criteria; the first one met triggers resolution. |
| **Steward** | The person who adopted a question and looks after it. A display name, not an account. |
| **Activity log** | Append-only record of every change in a space. |
| **Rules space** | A section of the space holding the charter and questions about the register's own rules (for example, adding a tool). |

## 2. Data model

Shown as TypeScript-style types. Storage representation is the implementer's choice **(decide)**, subject to the storage notes in §2.6.

### 2.1 Space

```ts
type Space = {
  id: string;
  name: string;
  created_at: datetime;
  settings: {
    active_cap: number;              // default 8
    dormancy_days: number;           // default 30: active question with no activity → dormant
    default_rule_days: number;       // default 7: objection window for the default rule
    auto_confirm_process_outcomes: boolean; // default true, see §4.4
  };
  charter_markdown: string;          // seeded from 04-charter-template.md, editable via Rules questions
  // access tokens: see §6
};
```

### 2.2 Question

```ts
type Question = {
  id: string;
  space_id: string;
  section: "main" | "rules";         // "rules" = shown in the Rules space

  title: string;                     // required; group's words; may be prefilled from the process, always editable
  why_it_matters?: string;           // optional free text

  status: "inbox" | "active" | "standing" | "resolved" | "dormant" | "dropped";
  steward?: string;                  // display name; required for active and standing

  resolution: {
    mode: "tbd" | "open" | "criteria";
    criteria: Criterion[];           // must be non-empty when mode = "criteria", empty otherwise
  };

  process?: Process;                 // at most one in v0
  parent_id?: string;                // "part of": at most one parent question
  duplicate_of_id?: string;          // set when status = dropped because of a duplicate

  resolution_record?: ResolutionRecord;  // set when status = resolved
  pending_resolution?: PendingResolution; // set when a criterion is met but not yet confirmed (§4.4)

  created_at: datetime;
  created_by: string;                // display name
  last_activity_at: datetime;        // any logged event on this question, incl. process state changes
};
```

Notes:
- `resolution.mode = "tbd"`: criteria not decided yet. Allowed only in `inbox`, `dormant` or `dropped`.
- `resolution.mode = "open"`: deliberately open-ended or rhetorical. Such a question lives in `standing` once adopted.
- `resolution.mode = "criteria"`: one or more criteria, combined as **any-of** (the first one met triggers resolution).

### 2.3 Process (nested in Question)

```ts
type Process = {
  url: string;                       // https only
  tool_id: string;                   // derived by matching url against the tool registry
  item_type: string;                 // derived, e.g. "pull_request", "issue", "question", "conversation", "discussion"
  framing?: string;                  // optional: how this process interprets the question, and its limits

  fetch_mode: "auto" | "manual";     // from the tool entry
  fetched?: {
    title?: string;
    raw_state?: string;              // tool's own state label, e.g. "merged", "resolved", "closed"
    state: NormalizedState;
    terminal: boolean;               // has the item reached a final state?
    outcome_summary?: string;        // e.g. "Merged", "Resolved: 63%", "Closed without merge"
    dates?: { opens_at?: datetime; closes_at?: datetime; resolved_at?: datetime; updated_at?: datetime };
    extra?: Record<string, string | number | boolean>; // tool/type-specific fields worth showing (vote counts, probability…)
    fetched_at: datetime;
    fetch_error?: string;            // last error, if any; previous values are kept
  };
  // For fetch_mode = "manual", a steward fills `fetched.state`, `terminal` and `outcome_summary` by hand.
  // Manual updates are logged like any other change.
};

type NormalizedState =
  | "not_started"   // draft, not yet open
  | "open"          // in progress
  | "accepted"      // terminal, positive (PR merged, proposal passed, binary question resolved yes)
  | "rejected"      // terminal, negative (PR closed unmerged, proposal failed, resolved no)
  | "concluded"     // terminal, neither yes nor no (numeric resolution, opinion map produced, discussion closed)
  | "withdrawn"     // terminal, abandoned/annulled/deleted
  | "unknown";      // could not be determined
```

Questions **inherit** process fields for display and filtering: tool, item type, normalized state, and dates appear on question cards and are search filters (§7).

### 2.4 Criterion

```ts
type Criterion =
  | { kind: "process_outcome"; accept_states?: NormalizedState[] } // default: any terminal state
  | { kind: "date"; at: datetime }                                  // resolves at that time with whatever the process shows
  | { kind: "default_rule"; days?: number }                         // lazy consensus, see §4.3; default from space settings
  | { kind: "attested"; description: string };                      // steward confirms a described condition by hand
```

Rules:
- `process_outcome` requires a process. If the process is removed, the criterion is removed too and the change is logged.
- A typical combination is `[process_outcome, date]`: "when the PR is merged or closed, or on March 1, whichever comes first." The date then acts as a deadline. There is no separate deadline field.
- At most one criterion of each kind per question **(decide whether to enforce strictly; recommended: yes)**.
- `attested` covers cases that can't be checked automatically, such as a quorum reached at a meeting. On-platform quorum counting is **(deferred)**.

### 2.5 Resolution records

```ts
type PendingResolution = {
  triggered_by: Criterion["kind"];
  triggered_at: datetime;
};

type ResolutionRecord = {
  resolved_at: datetime;
  confirmed_by: string;              // display name, or "system" for auto-confirmation
  triggered_by: Criterion["kind"];
  synthesis?: string;                // optional: the group's own statement of the answer
  snapshot: {
    question: { title: string; why_it_matters?: string; framing?: string };
    process?: Process;               // full copy at resolution time, including fetched fields
  };
};
```

A resolved question can be **reopened** (status back to `active`). The previous resolution record is kept in the activity log; the question gets a new one when it resolves again.

### 2.6 Storage notes

- **Process storage must allow lifting the one-process limit later.** Recommended: store processes in their own table/collection with a `question_id` foreign key and a uniqueness constraint on `question_id`. The API and UI present the process as a nested attribute. Removing the constraint later enables several processes per question without migrating data.
- The activity log is append-only. No update or delete operations on log entries, at the storage layer if possible.
- All timestamps in UTC; display in the viewer's local time.
- Questions are never hard-deleted. `dropped` is the terminal "removed" state.

## 3. Statuses and transitions

| Status | Meaning |
|---|---|
| `inbox` | Captured, not yet adopted. Anyone can add. Criteria may be TBD. |
| `active` | Adopted, has a steward and criteria. Counts toward the space's active cap. |
| `standing` | Adopted, deliberately open-ended (`resolution.mode = "open"`). Does not count toward the cap. |
| `resolved` | A criterion was met and confirmed. |
| `dormant` | Inactive for too long, or parked. Can be revived. |
| `dropped` | Removed: duplicate, out of scope, withdrawn. Kept for the record. |

Allowed transitions:

| From | To | Who / trigger | Conditions |
|---|---|---|---|
| (new) | `inbox` | anyone with edit access | title required |
| `inbox` | `active` | anyone (becomes steward) | `resolution.mode = "criteria"` and active count < cap |
| `inbox` | `standing` | anyone (becomes steward) | `resolution.mode = "open"` |
| `inbox`, `active`, `standing`, `dormant` | `dropped` | steward, or anyone if no steward | reason required; optional `duplicate_of_id` |
| `active` | `resolved` | system or steward | via §4 |
| `active`, `standing` | `dormant` | system (inactivity) or steward | — |
| `dormant` | `inbox` | anyone | — |
| `dormant` | `active` | anyone (becomes steward) | as for `inbox → active` |
| `resolved` | `active` | steward or anyone | reason required; cap applies |
| `standing` | `active` | steward | criteria set; cap applies |
| `dropped` | `inbox` | anyone | reason required |

Other rules:
- **Active cap.** If the cap is reached, adoption is refused with a message pointing to the Active lane ("6/8 active: resolve, park or drop one first").
- **Stewardship** can be handed over or taken over; both are logged. A question whose steward hands over without a successor goes back to `inbox`.
- **Dormancy.** A daily job moves `active` and `standing` questions with `last_activity_at` older than `dormancy_days` to `dormant`, logged as `system`. Process state changes count as activity.
- **Duplicates.** Dropping as a duplicate requires choosing the original; the duplicate's card links to it.

## 4. Resolution engine

### 4.1 Evaluation

A scheduled job **(decide interval; recommended every 15 minutes)** and every process refresh evaluate the criteria of each `active` question:

- `process_outcome`: met when `process.fetched.terminal = true` and, if `accept_states` is set, the state is in it.
- `date`: met when now ≥ `at`.
- `default_rule`: see §4.3.
- `attested`: never met automatically; the steward triggers it with an "Attest" action.

The first criterion met creates a `pending_resolution`, or resolves directly when auto-confirmation applies (§4.4).

### 4.2 Snapshots

At resolution, refresh the process once more (auto tools), then copy the question's text fields and the full process into `resolution_record.snapshot`. If the refresh fails, use the last fetched values and note the failure in the log.

### 4.3 Default rule (lazy consensus)

- When a question with a `default_rule` criterion becomes `active`, an objection window opens for `days` (default from settings).
- Anyone with edit access can **Object**, with a required reason. Objections are logged and shown on the question.
- If the window closes with no unresolved objection, the criterion is met.
- An objection pauses the criterion. The steward can either **address** it (logged with a note; the window restarts for the remaining days, or a full window if fewer than 2 days remain **(decide)**), or change the question's criteria.
- The default rule is the criterion used for Rules-space questions (§8) and is available for any question without an external process.

### 4.4 Confirmation

- `process_outcome` with an unambiguous terminal state (`accepted`, `rejected`, `withdrawn`), when `auto_confirm_process_outcomes = true`: resolve automatically, `confirmed_by = "system"`.
- All other cases (`concluded` states, `date`, `default_rule`, manual-fetch tools): set `pending_resolution`. The question shows "Ready to resolve: [reason]". The steward, or anyone if the steward has been inactive for 7 days **(decide)**, confirms, optionally adding a synthesis.
- `attested`: the steward's attestation is the confirmation; a description of what was attested is required.

## 5. Tool registry

### 5.1 Tool entry

```ts
type Tool = {
  id: string;                        // e.g. "github"
  name: string;
  url_patterns: { pattern: string; item_type: string }[]; // regex or URLPattern syntax (decide); used to accept and classify URLs
  fetch_mode: "auto" | "manual";
  adapter?: string;                  // name of the code adapter, required when fetch_mode = "auto"
  state_map?: Record<string, NormalizedState>; // for manual tools: suggested raw states shown in the manual-update form
  added_by_question_id?: string;     // the Rules question that approved this tool (absent for seed tools)
  enabled: boolean;
};
```

- The registry is **per space**, seeded with the default tools below.
- A process URL is accepted only if it matches an enabled tool's pattern. Otherwise the UI offers "Propose adding this tool", which creates a Rules question (§8).
- **Manual tools are declarative**: adding one requires only a registry entry (name, URL patterns, item types, suggested states), not code. This keeps tool addition cheap.
- **Auto tools need an adapter in code.** Adapters are part of the codebase; a space can only enable auto tools whose adapter exists.

### 5.2 Adapter interface

```ts
interface Adapter {
  id: string;
  // Given a URL already matched by a pattern, extract identifiers. No network.
  parse(url: string): { item_type: string; ids: Record<string, string> } | null;
  // Fetch and normalize. Must only call the tool's own API hosts, built from parsed ids (never the raw URL).
  fetch(parsed: { item_type: string; ids: Record<string, string> }): Promise<Process["fetched"]>;
}
```

### 5.3 Seed tools for v0

| Tool | Item types | Fetch mode in v0 | Notes |
|---|---|---|---|
| GitHub | pull_request, issue | auto | Public REST API. Merged → accepted; closed unmerged → rejected (PR); closed as completed → accepted, closed as not planned → rejected (issue) **(verify reasons in M0)**. Optional server token to raise rate limits. |
| GitLab | merge_request, issue | auto | gitlab.com and self-hosted instances (instance host is part of the URL). Same mapping logic as GitHub. |
| Metaculus | question | auto, if the public API is confirmed in M0; otherwise manual | Resolved → accepted/rejected for binary, concluded for numeric; annulled/ambiguous → withdrawn. Show community prediction in `extra` if available. |
| Loomio | proposal/poll, discussion | auto if a usable public API is confirmed in M0; otherwise manual | Closed proposal → concluded, with outcome summary; let the steward choose accepted/rejected if the outcome is binary. |
| Polis | conversation | manual | Manual states: open, closed (→ concluded). Show the report link if provided. |
| Kialo | discussion | manual | Manual states: open, closed (→ concluded). Kialo Edu discussions need link sharing enabled to be viewable. |

Additional candidates for later (add as manual tools through the Rules space, or as adapters): Discourse topics, Manifold markets, All Our Ideas, Decidim proposals, GitHub Discussions.

**Generic links** (any URL, manual status) are **not** a seed tool. A group may add one through the Rules space if it wants; that keeps the "every tool must be listed" rule meaningful.

### 5.4 Refresh

- Auto processes refresh on a schedule **(decide; recommended every 15 minutes for open items, daily for terminal ones)**, and on demand with a "Refresh" button.
- Respect rate limits; back off on errors; cache responses.
- A state change detected on refresh is logged as a `system` event and counts as activity.

## 6. Access and identity

- **No accounts.** Each space has two secret links:
  - an **edit link**, granting all actions;
  - a **view link**, read-only.
- Tokens are high-entropy (at least 128 bits), placed in the URL path, and stored hashed on the server.
- On first visit with a link, the browser asks for a **display name**, stored in a cookie or local storage. It is attached to every logged action. Names are not verified; the UI says so in the Rules space.
- **Link rotation** (invalidating and reissuing a link) is done by the server operator via a CLI or admin command in v0 **(decide)**. Rotation is logged in the space.
- Creating a space: an operator command or a simple creation page **(decide)** returns both links once.
- Private spaces beyond secret links, email verification, SSO: **(deferred)**.

## 7. Search and filtering

- Search covers **questions only**: title, why it matters, process framing, process fetched title, synthesis.
- Filters: status, section (main/rules), tool, item type, normalized process state, resolution mode (tbd/open/criteria), has process (yes/no), steward, parent question.
- Curator presets: "No process yet", "Criteria TBD", "Ready to resolve", "Objections open".
- **Duplicate hint on entry:** while typing a new title, show up to 5 similar existing questions (simple fuzzy or full-text match is enough).

## 8. Rules space

- Shows the **charter** (rendered markdown), the **tool registry**, and **Rules questions** (`section = "rules"`).
- Rules questions always use the `default_rule` criterion unless the charter says otherwise.
- Two built-in Rules question templates:
  1. **Add a tool**: the question carries a proposed tool entry (name, URL pattern, item type, manual states). On resolution as accepted, the tool is added to the registry and enabled, with `added_by_question_id` set.
  2. **Change the charter or settings**: the question carries the proposed new charter text and/or settings values. On resolution as accepted, they are applied.
- For any other Rules question, the outcome is recorded but nothing is applied automatically.
- Removing or disabling a tool also goes through a Rules question. Existing processes using a disabled tool keep their last state and stop refreshing.

## 9. Activity log

Every change produces an entry:

```ts
type ActivityEvent = {
  id: string;
  space_id: string;
  question_id?: string;
  at: datetime;
  actor: string;                     // display name or "system"
  action: string;                    // e.g. question.created, question.status_changed, process.attached, process.state_changed,
                                     // criteria.changed, objection.raised, objection.addressed, resolution.pending,
                                     // resolution.confirmed, question.reopened, tool.added, charter.changed, link.rotated
  data: object;                      // before/after values relevant to the action
};
```

- Shown per question (newest first) and per space ("Activity" feed).
- **Since your last visit:** the browser remembers the last visit time and highlights questions with newer events.
- An Atom feed per space, reachable with the view token, is nice to have **(decide whether it fits in v0)**.

## 10. UI

One responsive web UI. Discussion threads are deliberately absent.

### 10.1 Space home

- Header: space name, lanes **Inbox (n)**, **Active (n/cap)**, **Standing (n)**, **Resolved (n)**, link to **Rules**, link to archive filter (dormant/dropped), current display name.
- A single input at the top: "Ask a question, or paste a link." Typing text starts a new question (with duplicate hints). Pasting a URL matched by the registry starts a new question with the process attached and the title prefilled from the fetched item; an unmatched URL offers "Propose adding this tool."
- Question cards show: title, status, steward, process chip (tool icon, item type, normalized state, key `extra` value such as a probability or vote count), criteria summary (e.g. "When PR closes, or Mar 1"), and badges for "Ready to resolve", "Objection", "Changed since your visit."
- Search box and filters (§7).

### 10.2 Question page

- Title, why it matters, status, steward, parent ("Part of…"), children (questions whose parent is this one).
- **Resolution** block: criteria in plain words, objection window countdown if any, pending resolution with a Confirm button, or the resolution record (outcome, synthesis, snapshot, who confirmed, when).
- **Process** block: tool, item type, link out, fetched state and dates, extra fields, framing, last refresh and errors, Refresh button; manual state form for manual tools.
- Actions, shown according to status: adopt, hand over stewardship, edit fields, attach/replace/remove process, set criteria, object / address objection, attest, confirm resolution, reopen, park (→ dormant), drop (with reason / duplicate of).
- Activity log for the question.

### 10.3 Rules page

Charter, tool registry table, Rules questions with the same cards and actions as the main space.

### 10.4 Design notes

- Plain language in the UI: "part of", "same as", "answered when…", not internal terms.
- Status colours used consistently; never colour alone to convey meaning.
- Must work on a phone.
- External links open in a new tab with `rel="noopener noreferrer"`.

## 11. API and export

- All UI actions go through a JSON HTTP API **(decide REST shape)**, authenticated by the space token. This keeps data and views separable.
- **Export:** one endpoint returns the full space as JSON (space settings, charter, tools, questions with processes and resolution records, activity log). Import is **(deferred)**, but the export format should be stable and documented.

## 12. Deferred (do not build in v0)

- Several processes per question (storage already allows it, §2.6).
- More relation types than `parent_id` and `duplicate_of_id`.
- On-platform endorsement, seconding or quorum counting.
- Accounts, email verification, SSO, private questions.
- Graph view, spatial layout, alternative UIs.
- Needs/objectives as a node type (express them as parent questions instead).
- Chat or social-media tools.
- Digest emails (an Atom feed may come first).
- Import.
