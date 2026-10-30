// Reusable UI pieces: status pills, process chips, question cards, activity lines.
import { h, time, timeAgo } from "./dom.js";
import { STATE, STATE_ICON, STATE_HINT, QUESTION_STATES, itemLabel, ACTION, OLD_STATUS, CUSTOM_TOOL_ID } from "./labels.js";

/** A question's status: category colour and icon, with the hand-set label when there is one. */
export const statusPill = (state, label) =>
  h("span", { class: `pill st-${state}`, title: label && label !== STATE[state] ? `${STATE[state]}: ${STATE_HINT[state]}` : STATE_HINT[state] }, h("span", { "aria-hidden": "true" }, STATE_ICON[state] ?? "", " "), label ?? STATE[state] ?? state);

export const questionPill = (q) => statusPill(q.status, q.status_source === "manual" ? q.status_label : undefined);

/** A process state: the platform's own wording when known, coloured by category. */
export const statePill = (state, raw) => h("span", { class: `pill ps-${state}`, title: raw && STATE[state] ? STATE[state] : undefined }, raw ?? STATE[state] ?? state);

export function toolName(tools, id) {
  if (id === CUSTOM_TOOL_ID) return "Custom";
  return tools.find((t) => t.id === id)?.name ?? id;
}

/** "Loomio · poll" or, for custom processes, just their kind ("General assembly"). */
export const processKind = (p, tools) => (p.tool_id === CUSTOM_TOOL_ID ? p.item_type : `${toolName(tools, p.tool_id)} · ${itemLabel(p.item_type)}`);

/** Compact chip: tool · item type · state · key extra value */
export function processChip(process, tools) {
  if (!process) return null;
  const f = process.fetched;
  const extra = f?.extra ?? {};
  const key = ["participants", "votes", "forecasters", "comments"].find((k) => extra[k] !== undefined);
  const hasState = f && f.state !== "unknown";
  return h(
    "span",
    { class: "chip" },
    h("span", { class: "chip-tool" }, processKind(process, tools)),
    process.url ? h("a", { href: process.url, target: "_blank", rel: "noopener noreferrer", class: "chip-ext", title: `Open on ${process.tool_id === CUSTOM_TOOL_ID ? new URL(process.url).hostname : toolName(tools, process.tool_id)}`, "aria-label": "Open the process (new tab)" }, "↗") : null,
    " · ",
    hasState ? statePill(f.state, f.raw_state) : h("span", { class: "muted" }, "state not set"),
    key ? h("span", { class: "muted" }, ` · ${extra[key]} ${key.replace(/_/g, " ")}`) : null,
    f?.fetch_error ? h("span", { class: "warn", title: f.fetch_error }, " ⚠") : null,
  );
}

export function questionCard(q, ctx) {
  const { tools, since } = ctx;
  const changed = since && q.last_activity_at > since;
  const platformAt = q.process?.fetched?.dates?.updated_at;
  return h(
    "li",
    { class: `card${changed ? " is-changed" : ""}` },
    h("div", { class: "card-head" }, h("a", { href: `#/q/${q.id}`, class: "card-title" }, q.title), questionPill(q)),
    h(
      "div",
      { class: "card-meta" },
      processChip(q.process, tools),
      q.process?.fetched?.outcome_summary ? h("span", { class: "muted" }, q.process.fetched.outcome_summary) : null,
    ),
    h(
      "div",
      { class: "card-criteria" },
      q.process ? (q.status_source === "process" ? "Status follows the process" : "Status set by hand") : "No process",
      " · ",
      platformAt ? ["last activity on the platform ", time(platformAt, timeAgo(platformAt))] : ["last change ", time(q.last_activity_at, timeAgo(q.last_activity_at))],
    ),
    changed ? h("div", { class: "badges" }, h("span", { class: "badge changed" }, "★ Changed since your last visit")) : null,
  );
}

/** One line in an activity list. */
export function activityItem(e, titles) {
  const d = e.data ?? {};
  let detail = null;
  const st = (s) => STATE[s] ?? OLD_STATUS[s] ?? s;
  switch (e.action) {
    case "question.status_changed":
      detail = [
        st(d.from),
        " → ",
        d.label ?? st(d.to),
        d.source === "process" ? " (follows the process)" : d.source === "manual" ? " (set by hand)" : "",
        d.reason ? ` (${d.reason})` : "",
        d.note ? ` — “${d.note}”` : "",
      ];
      break;
    case "steward.changed":
      detail = `${d.before ?? "nobody"} → ${d.after ?? "nobody"} (${d.how})`;
      break;
    case "process.state_changed":
      detail = `${d.before ? (d.before.raw_state ?? STATE[d.before.state]) : "—"} → ${d.after?.raw_state ?? STATE[d.after?.state] ?? "?"}${d.after?.outcome_summary ? ` (${d.after.outcome_summary})` : ""}`;
      break;
    case "process.attached":
      detail = d.url ?? d.item_type;
      break;
    case "process.now_manual":
    case "model.simplified":
    case "question.removed":
      detail = d.reason ?? d.note;
      break;
    case "objection.raised":
      detail = `“${d.reason}”`;
      break;
    case "objection.addressed":
      detail = `“${d.note}”`;
      break;
    case "resolution.confirmed":
      detail = [d.record?.outcome ? STATE[d.record.outcome] : "", d.record?.synthesis ? ` — “${d.record.synthesis}”` : ""];
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
    case "tool.edited":
      detail = d.after?.name;
      break;
    case "relation.added":
    case "relation.removed":
      detail = [d.kind === "duplicate" ? "duplicate: " : "", d.other_title ? `“${d.other_title}”` : ""];
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

/**
 * Rows of "label → category": a text input, a category select and a remove button, plus "Add".
 * Used for a tool's states and the space's status labels. Returns { el, value() } where value()
 * returns [{label, state}] or throws an Error with a readable message.
 */
export function mappingEditor(rows, opts = {}) {
  const list = h("div", { class: "map-rows" });
  const addRow = (label = "", state = "open") => {
    const input = h("input", { type: "text", maxlength: 80, value: label, placeholder: opts.placeholder ?? "Label", "aria-label": opts.labelName ?? "Label" });
    const select = h(
      "select",
      { "aria-label": "Category" },
      QUESTION_STATES.map((s) => h("option", { value: s, selected: s === state }, `${STATE_ICON[s]} ${STATE[s]}`)),
    );
    const row = h("div", { class: "map-row" }, input, h("span", { "aria-hidden": "true" }, "→"), select, h("button", { type: "button", class: "link", title: "Remove this row", onclick: () => row.remove() }, "✕"));
    list.append(row);
    return input;
  };
  for (const r of rows) addRow(r.label, r.state);
  const el = h(
    "div",
    { class: "map-editor" },
    h("div", { class: "map-head muted small" }, h("span", null, opts.labelName ?? "Label"), h("span", null, "counts as")),
    list,
    h("button", { type: "button", class: "link", onclick: () => addRow("", "open").focus() }, "＋ Add a row"),
  );
  return {
    el,
    value() {
      const out = [...list.querySelectorAll(".map-row")]
        .map((row) => ({ label: row.querySelector("input").value.trim(), state: row.querySelector("select").value }))
        .filter((r) => r.label);
      if (!out.length) throw new Error("Add at least one row");
      const seen = new Set();
      for (const r of out) {
        if (seen.has(r.label.toLowerCase())) throw new Error(`“${r.label}” appears twice`);
        seen.add(r.label.toLowerCase());
      }
      return out;
    },
  };
}
