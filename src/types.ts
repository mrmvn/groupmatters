// Domain types. Mirrors 02-v0-spec.md §2. Datetimes are ISO-8601 strings in UTC.

export type ISODate = string;

export const NORMALIZED_STATES = [
  "not_started",
  "open",
  "accepted",
  "rejected",
  "concluded",
  "withdrawn",
  "unknown",
] as const;
export type NormalizedState = (typeof NORMALIZED_STATES)[number];
export const TERMINAL_STATES: readonly NormalizedState[] = ["accepted", "rejected", "concluded", "withdrawn"];
export const UNAMBIGUOUS_TERMINAL: readonly NormalizedState[] = ["accepted", "rejected", "withdrawn"];
export const isTerminal = (s: NormalizedState) => TERMINAL_STATES.includes(s);

export const STATUSES = ["inbox", "active", "standing", "resolved", "dormant", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

export type Section = "main" | "rules";

export type SpaceSettings = {
  active_cap: number;
  dormancy_days: number;
  default_rule_days: number;
  auto_confirm_process_outcomes: boolean;
};

export const DEFAULT_SETTINGS: SpaceSettings = {
  active_cap: 8,
  dormancy_days: 30,
  default_rule_days: 7,
  auto_confirm_process_outcomes: true,
};

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
  dates?: { opens_at?: ISODate; closes_at?: ISODate; resolved_at?: ISODate; updated_at?: ISODate };
  extra?: Record<string, string | number | boolean>;
  fetched_at: ISODate;
  fetch_error?: string;
};

export type Process = {
  url: string;
  tool_id: string;
  item_type: string;
  framing?: string;
  fetch_mode: "auto" | "manual";
  fetched?: Fetched;
};

export type Criterion =
  | { kind: "process_outcome"; accept_states?: NormalizedState[] }
  | { kind: "date"; at: ISODate }
  | { kind: "default_rule"; days?: number }
  | { kind: "attested"; description: string };
export type CriterionKind = Criterion["kind"];
export const CRITERION_KINDS: readonly CriterionKind[] = ["process_outcome", "date", "default_rule", "attested"];

export type Resolution = { mode: "tbd" | "open" | "criteria"; criteria: Criterion[] };

export type PendingResolution = {
  triggered_by: CriterionKind;
  triggered_at: ISODate;
  suggested_outcome?: NormalizedState; // implementation addition, see DECISIONS.md
};

export type ResolutionRecord = {
  resolved_at: ISODate;
  confirmed_by: string;
  triggered_by: CriterionKind;
  outcome?: NormalizedState; // implementation addition, see DECISIONS.md
  synthesis?: string;
  attested?: string;
  snapshot: {
    question: { title: string; why_it_matters?: string; framing?: string };
    process?: Process;
  };
};

// Objection window state for the default_rule criterion (§4.3).
export type DefaultWindow = {
  opened_at: ISODate;
  ends_at: ISODate; // meaningful only when not paused
  paused_remaining_ms?: number; // set while at least one objection is open
};

export type RulesPayload =
  | {
      kind: "add_tool";
      tool: {
        name: string;
        url_patterns: { pattern: string; item_type: string }[];
        state_map?: Record<string, NormalizedState>;
      };
    }
  | { kind: "change_charter"; charter_markdown?: string; settings?: Partial<SpaceSettings> }
  | { kind: "set_tool_enabled"; tool_id: string; enabled: boolean };

export type Question = {
  id: string;
  space_id: string;
  section: Section;
  title: string;
  why_it_matters?: string;
  status: Status;
  steward?: string;
  resolution: Resolution;
  process?: Process;
  parent_id?: string;
  duplicate_of_id?: string;
  drop_reason?: string;
  resolution_record?: ResolutionRecord;
  pending_resolution?: PendingResolution;
  default_window?: DefaultWindow;
  rules_payload?: RulesPayload;
  reopened_at?: ISODate;
  reopen_baseline_state?: NormalizedState;
  created_at: ISODate;
  created_by: string;
  last_activity_at: ISODate;
};

export type Objection = {
  id: string;
  question_id: string;
  raised_by: string;
  raised_at: ISODate;
  reason: string;
  addressed_at?: ISODate;
  addressed_by?: string;
  address_note?: string;
};

export type Tool = {
  id: string;
  name: string;
  url_patterns: { pattern: string; item_type: string }[];
  fetch_mode: "auto" | "manual";
  adapter?: string;
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
