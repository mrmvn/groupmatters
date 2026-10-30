// Domain types. Datetimes are ISO-8601 strings in UTC.
// The v0 decision model (adopt, criteria, objections, cap, dormancy, Rules proposals) was removed
// in migration 3; see DECISIONS.md. Its history stays in the activity log.

export type ISODate = string;

/**
 * Broad status categories, shared by processes and questions.
 * Every tool's raw states map onto one of these; so do the space's hand-set status labels.
 */
export const NORMALIZED_STATES = ["not_started", "open", "accepted", "rejected", "concluded", "withdrawn", "unknown"] as const;
export type NormalizedState = (typeof NORMALIZED_STATES)[number];
/** Categories a question can be in (`unknown` only exists for processes that couldn't be fetched). */
export const QUESTION_STATES = ["not_started", "open", "accepted", "rejected", "concluded", "withdrawn"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];
export const TERMINAL_STATES: readonly NormalizedState[] = ["accepted", "rejected", "concluded", "withdrawn"];
export const isTerminal = (s: NormalizedState) => TERMINAL_STATES.includes(s);
export const isQuestionState = (s: unknown): s is QuestionState => QUESTION_STATES.includes(s as QuestionState);

/** A hand-set status label and the category it belongs to. */
export type StatusLabel = { label: string; state: QuestionState };

export type SpaceSettings = {
  /** Labels offered when a status is set by hand (questions, custom processes). Editable per space. */
  status_labels: StatusLabel[];
};

export const DEFAULT_STATUS_LABELS: StatusLabel[] = [
  { label: "Not started", state: "not_started" },
  { label: "Being discussed", state: "open" },
  { label: "Agreed", state: "accepted" },
  { label: "Not agreed", state: "rejected" },
  { label: "Done", state: "concluded" },
  { label: "Dropped", state: "withdrawn" },
];

export const DEFAULT_SETTINGS: SpaceSettings = { status_labels: DEFAULT_STATUS_LABELS };

export type Space = {
  id: string;
  name: string;
  created_at: ISODate;
  settings: SpaceSettings;
  charter_markdown: string;
};

export type Fetched = {
  title?: string;
  raw_state?: string;
  state: NormalizedState;
  terminal: boolean;
  outcome_summary?: string;
  /** `updated_at` is the item's last activity on its platform, when the platform tells us. */
  dates?: { opens_at?: ISODate; closes_at?: ISODate; resolved_at?: ISODate; updated_at?: ISODate };
  extra?: Record<string, string | number | boolean>;
  fetched_at: ISODate;
  fetch_error?: string;
};

/** The id of the built-in "custom" tool: a process described by hand, with or without a link. */
export const CUSTOM_TOOL_ID = "custom";

export type Process = {
  /** Absent for custom processes without a link (a meeting, an unconference…). */
  url?: string;
  tool_id: string;
  /** For custom processes: what kind of process it is, in the group's words ("meeting"). */
  item_type: string;
  framing?: string;
  fetch_mode: "auto" | "manual";
  fetched?: Fetched;
};

export type Question = {
  id: string;
  space_id: string;
  title: string;
  why_it_matters?: string;
  /** Current category. Follows the process when `status_source` is "process". */
  status: QuestionState;
  status_source: "process" | "manual";
  /** The hand-set label (manual source only). */
  status_label?: string;
  process?: Process;
  /** Set when removed (spam, mistake, test). Hidden from lists, restorable; never deleted. */
  removed_at?: ISODate;
  created_at: ISODate;
  created_by: string;
  last_activity_at: ISODate;
};

/** A directed link between two questions. Shown on both of them. */
export const RELATION_KINDS = ["related", "duplicate"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export type Relation = { from_id: string; to_id: string; kind: RelationKind; created_at: ISODate; created_by: string };

export type Tool = {
  id: string;
  name: string;
  /** What the tool is useful for, in the group's words. Shown in the tool list and when linking a process. */
  description?: string;
  url_patterns: { pattern: string; item_type: string }[];
  fetch_mode: "auto" | "manual";
  adapter?: string;
  /** Raw state label → category. For auto tools, used as a fallback when the item can't be fetched. */
  state_map?: Record<string, NormalizedState>;
  added_by_question_id?: string;
  enabled: boolean;
};

export type ActivityEvent = {
  id: number;
  space_id: string;
  question_id?: string;
  at: ISODate;
  actor: string;
  action: string;
  data: Record<string, unknown>;
};

export type Role = "edit" | "view";
