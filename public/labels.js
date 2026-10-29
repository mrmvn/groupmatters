// Plain-language labels (spec §10.4: "related", "answered when…", not internal terms).
import { fmtShortDate } from "./dom.js";

export const STATUS = {
  inbox: { label: "Pool", icon: "◌", hint: "On the table, not yet adopted" },
  active: { label: "Active", icon: "●", hint: "Adopted, being answered" },
  standing: { label: "Standing", icon: "◆", hint: "Adopted, deliberately open-ended" },
  resolved: { label: "Resolved", icon: "✔", hint: "Answered" },
  dormant: { label: "Dormant", icon: "☾", hint: "Parked or inactive" },
  dropped: { label: "Dropped", icon: "✕", hint: "Removed (kept for the record)" },
};

export const STATE = {
  not_started: "not started",
  open: "open",
  accepted: "accepted",
  rejected: "rejected",
  concluded: "concluded",
  withdrawn: "withdrawn",
  unknown: "unknown",
};

export const ITEM = {
  pull_request: "pull request",
  merge_request: "merge request",
  issue: "issue",
  question: "question",
  poll: "poll",
  discussion: "discussion",
  conversation: "conversation",
  topic: "topic",
};
export const itemLabel = (t) => ITEM[t] ?? String(t ?? "item").replace(/_/g, " ");

export const TERMINAL = ["accepted", "rejected", "concluded", "withdrawn"];

function processOutcomeText(c, process) {
  const item = process ? itemLabel(process.item_type) : "process";
  if (c.accept_states?.length) return `when the ${item} ends as ${c.accept_states.map((s) => STATE[s]).join(" or ")}`;
  if (process?.item_type === "pull_request" || process?.item_type === "merge_request") return `when the ${item} is merged or closed`;
  if (process?.item_type === "issue") return `when the issue is closed`;
  return `when the ${item} reaches an outcome`;
}

/** "Answered when the pull request is merged or closed, or by Mar 1" */
export function criteriaSummary(resolution, process, defaultDays) {
  if (!resolution || resolution.mode === "tbd") return "Answer criteria not decided yet";
  if (resolution.mode === "open") return "Open-ended: not meant to be closed";
  const parts = resolution.criteria.map((c) => {
    switch (c.kind) {
      case "process_outcome":
        return processOutcomeText(c, process);
      case "date":
        return resolution.criteria.length > 1 ? `by ${fmtShortDate(c.at)}` : `on ${fmtShortDate(c.at)}`;
      case "default_rule":
        return `if nobody objects within ${c.days ?? defaultDays ?? 7} days`;
      case "attested":
        return `when the steward confirms: “${c.description}”`;
      default:
        return c.kind;
    }
  });
  return `Answered ${parts.join(", or ")}`;
}

export const TRIGGER = {
  process_outcome: "the process reached an outcome",
  date: "the date passed",
  default_rule: "nobody objected within the window",
  attested: "the steward attested",
};

export const ACTION = {
  "question.created": "added the question",
  "question.edited": "edited the question",
  "question.status_changed": "changed the status",
  "question.reopened": "reopened the question",
  "steward.changed": "changed the steward",
  "criteria.changed": "changed the answer criteria",
  "process.attached": "linked a process",
  "process.replaced": "replaced the process",
  "process.removed": "removed the process",
  "process.framing_changed": "changed the framing",
  "process.state_changed": "process state changed",
  "process.refresh_failed": "process refresh failed",
  "objection.raised": "objected",
  "objection.addressed": "addressed an objection",
  "objection_window.resumed": "objection window resumed",
  "resolution.pending": "ready to resolve",
  "resolution.cancelled": "pending resolution cancelled",
  "resolution.confirmed": "resolved the question",
  "tool.added": "added a tool",
  "tool.enabled": "enabled a tool",
  "tool.disabled": "disabled a tool",
  "charter.changed": "changed the charter",
  "settings.changed": "changed the settings",
  "link.rotated": "rotated a link",
  "space.created": "created the space",
};
