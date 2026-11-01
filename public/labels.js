// Plain-language labels.

/** Status categories, shared by questions and processes. */
export const STATE = {
  not_started: "Not started",
  open: "In progress",
  accepted: "Accepted",
  rejected: "Rejected",
  concluded: "Concluded",
  withdrawn: "Withdrawn",
  unknown: "Unknown",
};
export const STATE_ICON = { not_started: "○", open: "◐", accepted: "✔", rejected: "✕", concluded: "●", withdrawn: "–", unknown: "?" };
export const STATE_HINT = {
  not_started: "Nothing happening yet",
  open: "Being discussed, voted on or worked on",
  accepted: "Decided yes: passed, merged, agreed",
  rejected: "Decided no: not passed, closed without merging",
  concluded: "Ended without a yes/no (e.g. a consultation closed)",
  withdrawn: "Dropped, duplicate or deleted",
  unknown: "Couldn't be read",
};
export const QUESTION_STATES = ["not_started", "open", "accepted", "rejected", "concluded", "withdrawn"];
export const ENDED = ["accepted", "rejected", "concluded"];

export const ITEM = {
  pull_request: "pull request",
  merge_request: "merge request",
  issue: "issue",
  question: "question",
  poll: "poll",
  discussion: "thread",
  conversation: "conversation",
  topic: "topic",
};
export const itemLabel = (t) => ITEM[t] ?? String(t ?? "item").replace(/_/g, " ");

export const CUSTOM_TOOL_ID = "custom";

/** What the other question is to this one (the `role` of a relation, see src/relations.ts), as a tag on the question's page. */
export const ROLE = {
  parent: "Parent",
  child: "Child",
  related: "Related",
  duplicate_of: "This is a duplicate of",
  duplicated_by: "Duplicated by",
};

/** What a relation says when made from a question ("this question is …"): menu text, the symbol on suggestions, and the toast. */
export const RELATE_AS = {
  related: { menu: "is related to", symbol: "＋", hint: "Relate this existing matter", done: "Related" },
  child_of: { menu: "is a child of", symbol: "↳", hint: "Make this matter a child of it", done: "Made a child" },
  parent_of: { menu: "is the parent of", symbol: "↱", hint: "Make this matter its parent", done: "Made the parent" },
  duplicate_of: { menu: "is a duplicate of", symbol: "≡", hint: "Mark this matter as a duplicate of it", done: "Marked as duplicate" },
  duplicated_by: { menu: "is duplicated by", symbol: "≡", hint: "Mark it as a duplicate of this matter", done: "Marked as duplicate" },
};

export const ACTION = {
  "question.created": "added the matter",
  "question.edited": "edited the matter",
  "question.status_changed": "changed the status",
  "question.removed": "archived the matter",
  "question.restored": "restored the matter",
  "process.attached": "linked a process",
  "process.replaced": "replaced the process",
  "process.removed": "removed the process",
  "process.framing_changed": "changed the framing",
  "question.dates_changed": "changed the dates",
  "question.fields_changed": "changed",
  "process.tool_matched": "linked to a tool on the list",
  "process.state_changed": "process state changed",
  "process.now_manual": "process can't be fetched any more; now updated by hand",
  "relation.added": "linked it to another matter",
  "relation.removed": "removed a link to another matter",
  "tool.added": "added a tool",
  "tool.edited": "edited a tool",
  "tool.enabled": "enabled a tool",
  "tool.disabled": "disabled a tool",
  "charter.changed": "edited the group’s description",
  "settings.changed": "changed the settings",
  "link.rotated": "rotated a link",
  "space.created": "created the space",
  "model.simplified": "simplified the register",
  // From the earlier decision model (kept readable in the history)
  "question.reopened": "reopened the matter",
  "steward.changed": "changed the steward",
  "criteria.changed": "changed the answer criteria",
  "objection.raised": "objected",
  "objection.addressed": "addressed an objection",
  "objection_window.resumed": "objection window resumed",
  "resolution.pending": "ready to resolve",
  "resolution.cancelled": "pending resolution cancelled",
  "resolution.confirmed": "resolved the matter",
};

/** Old statuses, for history lines written before the status model changed. */
export const OLD_STATUS = { inbox: "Pool", active: "Active", standing: "Standing", resolved: "Resolved", dormant: "Dormant", dropped: "Dropped" };
