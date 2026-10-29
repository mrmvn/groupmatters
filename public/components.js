// Reusable UI pieces: status pills, process chips, question cards, the criteria editor, activity lines.
import { h, time, timeAgo, toLocalInput, fromLocalInput, fmtDate } from "./dom.js";
import { STATUS, STATE, TERMINAL, itemLabel, criteriaSummary, ACTION, TRIGGER } from "./labels.js";

export const statusPill = (status) =>
  h("span", { class: `pill st-${status}`, title: STATUS[status]?.hint }, h("span", { "aria-hidden": "true" }, STATUS[status]?.icon, " "), STATUS[status]?.label ?? status);

export const statePill = (state) => h("span", { class: `pill ps-${state}` }, STATE[state] ?? state);

export function toolName(tools, id) {
  return tools.find((t) => t.id === id)?.name ?? id;
}

/** Compact chip: tool · item type · state · key extra value */
export function processChip(process, tools) {
  if (!process) return null;
  const f = process.fetched;
  const extra = f?.extra ?? {};
  const key = ["probability", "community_prediction", "votes", "comments"].find((k) => extra[k] !== undefined);
  return h(
    "span",
    { class: "chip" },
    h("span", { class: "chip-tool" }, toolName(tools, process.tool_id)),
    " · ",
    itemLabel(process.item_type),
    " · ",
    f ? statePill(f.state) : h("span", { class: "muted" }, "state not set"),
    key ? h("span", { class: "muted" }, ` · ${extra[key]} ${key.replace(/_/g, " ")}`) : null,
    f?.fetch_error ? h("span", { class: "warn", title: f.fetch_error }, " ⚠") : null,
  );
}

export function questionCard(q, ctx) {
  const { tools, since, space } = ctx;
  const changed = since && q.last_activity_at > since;
  const badges = [];
  if (q.pending_resolution) badges.push(h("span", { class: "badge ready" }, "⏵ Ready to resolve"));
  if (q.open_objections) badges.push(h("span", { class: "badge objection" }, `✋ ${q.open_objections} objection${q.open_objections > 1 ? "s" : ""}`));
  if (changed) badges.push(h("span", { class: "badge changed" }, "★ Changed since your last visit"));
  if (q.section === "rules") badges.push(h("span", { class: "badge rules" }, "Rules"));
  return h(
    "li",
    { class: `card${changed ? " is-changed" : ""}` },
    h(
      "div",
      { class: "card-head" },
      h("a", { href: `#/q/${q.id}`, class: "card-title" }, q.title),
      statusPill(q.status),
    ),
    h(
      "div",
      { class: "card-meta" },
      q.steward ? h("span", null, "Steward: ", h("strong", null, q.steward)) : h("span", { class: "muted" }, "No steward"),
      processChip(q.process, tools),
    ),
    q.status === "resolved" && q.resolution_record
      ? h("div", { class: "card-criteria" }, `Resolved ${fmtDate(q.resolution_record.resolved_at, false)}`, q.resolution_record.outcome ? ` · ${STATE[q.resolution_record.outcome]}` : "")
      : q.status === "dropped"
        ? h("div", { class: "card-criteria" }, q.duplicate_of_id ? "Same as another question" : `Dropped: ${q.drop_reason ?? ""}`)
        : h("div", { class: "card-criteria" }, criteriaSummary(q.resolution, q.process, space.settings.default_rule_days)),
    badges.length ? h("div", { class: "badges" }, badges) : null,
  );
}

const KIND_LABEL = {
  process_outcome: "When the linked process reaches an outcome",
  date: "On a date (deadline)",
  default_rule: "Default rule: if nobody objects within an objection window",
  attested: "When the steward confirms a stated condition",
};

/**
 * Criteria editor. Returns { el, value() } where value() returns a Resolution or throws Error.
 * opts: { resolution, hasProcess, section, defaultDays, allowModes: ["tbd","open","criteria"] }
 */
export function criteriaEditor(opts) {
  const r = opts.resolution ?? { mode: "tbd", criteria: [] };
  const modes = opts.allowModes ?? ["tbd", "open", "criteria"];
  const name = `mode-${Math.random().toString(36).slice(2)}`;
  const find = (k) => r.criteria.find((c) => c.kind === k);
  let mode = modes.includes(r.mode) ? r.mode : modes.includes("criteria") ? "criteria" : modes[0];

  const modeLabels = { tbd: "Not decided yet", open: "Open-ended (no answer expected; becomes Standing)", criteria: "Answered when…" };
  const modeRadios = h(
    "div",
    { class: "radios" },
    modes.map((m) =>
      h(
        "label",
        null,
        h("input", { type: "radio", name, value: m, checked: m === mode, onchange: () => ((mode = m), sync()) }),
        " ",
        modeLabels[m],
      ),
    ),
  );

  const rows = {};
  const checks = {};
  const forcedDefault = opts.section === "rules";

  // process_outcome
  const po = find("process_outcome");
  const acceptBoxes = TERMINAL.map((s) => h("label", { class: "inline" }, h("input", { type: "checkbox", value: s, checked: !!po?.accept_states?.includes(s) }), ` ${STATE[s]}`));
  checks.process_outcome = h("input", { type: "checkbox", checked: !!po, disabled: !opts.hasProcess && !po });
  rows.process_outcome = h(
    "div",
    { class: "crit" },
    h("label", null, checks.process_outcome, " ", KIND_LABEL.process_outcome, !opts.hasProcess ? h("span", { class: "muted" }, " (link a process first)") : null),
    h("details", { class: "sub" }, h("summary", null, "Only for some outcomes…"), h("div", null, "Count it only if the process ends as: ", acceptBoxes), h("p", { class: "muted small" }, "Leave all unticked to accept any final state.")),
  );

  // date
  const dt = find("date");
  checks.date = h("input", { type: "checkbox", checked: !!dt });
  const dateInput = h("input", { type: "datetime-local", value: dt ? toLocalInput(dt.at) : "", onchange: () => (checks.date.checked = true) });
  rows.date = h("div", { class: "crit" }, h("label", null, checks.date, " ", KIND_LABEL.date), h("div", { class: "sub" }, dateInput));

  // default_rule
  const dr = find("default_rule");
  checks.default_rule = h("input", { type: "checkbox", checked: !!dr || forcedDefault, disabled: forcedDefault });
  const daysInput = h("input", { type: "number", min: 1, max: 365, value: dr?.days ?? "", placeholder: String(opts.defaultDays ?? 7), class: "num" });
  rows.default_rule = h(
    "div",
    { class: "crit" },
    h("label", null, checks.default_rule, " ", KIND_LABEL.default_rule, forcedDefault ? h("span", { class: "muted" }, " (required in the Rules space)") : null),
    h("div", { class: "sub" }, "Window: ", daysInput, " days"),
  );

  // attested
  const at = find("attested");
  checks.attested = h("input", { type: "checkbox", checked: !!at });
  const attInput = h("input", { type: "text", value: at?.description ?? "", placeholder: "e.g. a majority agrees at the next general meeting", class: "wide", oninput: () => (checks.attested.checked = true) });
  rows.attested = h("div", { class: "crit" }, h("label", null, checks.attested, " ", KIND_LABEL.attested), h("div", { class: "sub" }, attInput));

  const critBox = h("fieldset", { class: "criteria-box" }, h("legend", null, "Any of these (the first one met counts)"), rows.process_outcome, rows.date, rows.default_rule, rows.attested);

  const sync = () => {
    critBox.hidden = mode !== "criteria";
  };
  sync();

  const el = h("div", { class: "criteria-editor" }, modes.length > 1 ? modeRadios : null, critBox);
  return {
    el,
    value() {
      if (mode !== "criteria") return { mode, criteria: [] };
      const criteria = [];
      if (checks.process_outcome.checked) {
        const states = acceptBoxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
        criteria.push(states.length ? { kind: "process_outcome", accept_states: states } : { kind: "process_outcome" });
      }
      if (checks.date.checked) {
        if (!dateInput.value) throw new Error("Pick a date, or untick the date option");
        criteria.push({ kind: "date", at: fromLocalInput(dateInput.value) });
      }
      if (checks.default_rule.checked) criteria.push(daysInput.value ? { kind: "default_rule", days: Number(daysInput.value) } : { kind: "default_rule" });
      if (checks.attested.checked) {
        if (!attInput.value.trim()) throw new Error("Describe what the steward will confirm");
        criteria.push({ kind: "attested", description: attInput.value.trim() });
      }
      if (!criteria.length) throw new Error("Tick at least one way the question gets answered");
      return { mode, criteria };
    },
  };
}

/** One line in an activity list. */
export function activityItem(e, titles) {
  const d = e.data ?? {};
  let detail = null;
  switch (e.action) {
    case "question.status_changed":
      detail = [STATUS[d.from]?.label ?? d.from, " → ", STATUS[d.to]?.label ?? d.to, d.reason ? ` (${d.reason})` : ""];
      break;
    case "steward.changed":
      detail = `${d.before ?? "nobody"} → ${d.after ?? "nobody"} (${d.how})`;
      break;
    case "process.state_changed":
      detail = `${d.before ? STATE[d.before.state] : "—"} → ${STATE[d.after?.state] ?? "?"}${d.after?.outcome_summary ? ` (${d.after.outcome_summary})` : ""}`;
      break;
    case "process.attached":
      detail = d.url;
      break;
    case "objection.raised":
      detail = `“${d.reason}”`;
      break;
    case "objection.addressed":
      detail = `“${d.note}”`;
      break;
    case "resolution.pending":
      detail = TRIGGER[d.triggered_by];
      break;
    case "resolution.confirmed":
      detail = [TRIGGER[d.record?.triggered_by], d.record?.outcome ? ` · ${STATE[d.record.outcome]}` : ""];
      break;
    case "question.reopened":
    case "resolution.cancelled":
      detail = d.reason;
      break;
    case "question.edited":
      detail = Object.keys(d).map((k) => k.replace(/_/g, " ")).join(", ");
      break;
    case "tool.added":
      detail = d.tool?.name;
      break;
    case "objection_window.resumed":
      detail = `ends ${fmtDate(d.ends_at)}`;
      break;
  }
  const qTitle = titles && e.question_id ? titles.get(e.question_id) : null;
  return h(
    "li",
    { class: "act" },
    h("span", { class: "act-actor" }, e.actor === "system" ? "⚙ system" : e.actor),
    " ",
    ACTION[e.action] ?? e.action,
    qTitle ? [" · ", h("a", { href: `#/q/${e.question_id}` }, qTitle)] : null,
    detail ? h("span", { class: "act-detail" }, " — ", detail) : null,
    " ",
    h("span", { class: "muted small" }, time(e.at, timeAgo(e.at))),
  );
}
