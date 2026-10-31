// Domain types. Datetimes are ISO-8601 strings in UTC.
// The v0 decision model (adopt, criteria, objections, cap, dormancy, Rules proposals) was removed
// in migration 3; see DECISIONS.md. Its history stays in the activity log.

export type ISODate = string;
/** A whole day ("2026-03-01", no time zone) or a moment (ISO-8601 in UTC). */
export type DateValue = string;

/**
 * A question's fields. Each is either retrieved (from the linked item, through a tool on the tool list)
 * or typed by someone. Typed values are kept in `Question.typed`; anything not typed is retrieved.
 */
export const FIELDS = ["title", "kind", "status", "summary", "results_url", "start", "end"] as const;
export type Field = (typeof FIELDS)[number];
export type TypedStatus = { state: QuestionState; label: string };
/** `value: null` means "explicitly none" (e.g. no end date even though the link gives one). */
export type TypedValue = { value: string | TypedStatus | null; by: string; at: ISODate };
export type Typed = Partial<Record<Field, TypedValue>>;

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

/** The tool id of a process not on the tool list: no link, or a link to a site that isn't registered. Nothing is retrieved. */
export const CUSTOM_TOOL_ID = "custom";

export type Process = {
  /** Absent for custom processes without a link (a meeting, an unconference…). */
  url?: string;
  tool_id: string;
  /** The item type the tool's URL pattern gives ("pull_request"). Empty for custom processes (no tool). */
  item_type: string;
  fetch_mode: "auto" | "manual";
  fetched?: Fetched;
};

export type Question = {
  id: string;
  space_id: string;
  title: string;
  why_it_matters?: string;
  /** Current title and category (stored for search and counts), from the typed value or the retrieved one. */
  status: QuestionState;
  /** The typed status label, when the status is typed. */
  status_label?: string;
  /** Typed field values. A field not in here is retrieved (see fields.ts). */
  typed: Typed;
  process?: Process;
  /** Set when removed (spam, mistake, test). Hidden from lists, restorable; never deleted. */
  removed_at?: ISODate;
  created_at: ISODate;
  created_by: string;
  last_activity_at: ISODate;
};

/**
 * A directed link between two questions. Shown on both of them. Stored as `from → to`:
 * `child_of` (from is a child of to: to is the parent), `duplicate` (from duplicates to) and the
 * symmetric `related`. See relations.ts for the other ways to say them (`parent_of`, `duplicated_by`).
 */
export const RELATION_KINDS = ["related", "child_of", "duplicate"] as const;
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
  added_by_question_id?: string;
  enabled: boolean;
  /** The tool site's favicon as a data: URI, fetched by the server (tools without a bundled icon; see toolicons.ts). */
  icon?: string;
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
