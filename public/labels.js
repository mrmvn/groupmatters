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

export const ACTION = {
  "question.created": "added the question",
  "question.edited": "edited the question",
  "question.status_changed": "changed the status",
  "question.removed": "removed the question",
  "question.restored": "restored the question",
  "process.attached": "linked a process",
  "process.replaced": "replaced the process",
  "process.removed": "removed the process",
  "process.framing_changed": "changed the framing",
  "process.state_changed": "process state changed",
  "process.now_manual": "process can't be fetched any more; now updated by hand",
  "relation.added": "related it to another question",
  "relation.removed": "removed a related question",
  "tool.added": "added a tool",
  "tool.edited": "edited a tool",
  "tool.enabled": "enabled a tool",
  "tool.disabled": "disabled a tool",
  "charter.changed": "changed the charter",
  "settings.changed": "changed the settings",
  "link.rotated": "rotated a link",
  "space.created": "created the space",
  "model.simplified": "simplified the register",
  // From the earlier decision model (kept readable in the history)
  "question.reopened": "reopened the question",
  "steward.changed": "changed the steward",
  "criteria.changed": "changed the answer criteria",
  "objection.raised": "objected",
  "objection.addressed": "addressed an objection",
  "objection_window.resumed": "objection window resumed",
  "resolution.pending": "ready to resolve",
  "resolution.cancelled": "pending resolution cancelled",
  "resolution.confirmed": "resolved the question",
};

/** Old statuses, for history lines written before the status model changed. */
export const OLD_STATUS = { inbox: "Pool", active: "Active", standing: "Standing", resolved: "Resolved", dormant: "Dormant", dropped: "Dropped" };
