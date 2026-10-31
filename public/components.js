// Reusable UI pieces: status pills, process chips, question cards, activity lines.
import { h, time, timeAgo, fmtWhen } from "./dom.js";
import { STATE, STATE_ICON, STATE_HINT, QUESTION_STATES, itemLabel, ACTION, OLD_STATUS, CUSTOM_TOOL_ID } from "./labels.js";

/** A question's status: category colour and icon, with the hand-set label when there is one. */
export const statusPill = (state, label) =>
  h("span", { class: `pill st-${state}`, title: label && label !== STATE[state] ? `${STATE[state]}: ${STATE_HINT[state]}` : STATE_HINT[state] }, h("span", { "aria-hidden": "true" }, STATE_ICON[state] ?? "", " "), label ?? STATE[state] ?? state);

export const questionPill = (q) => statusPill(q.status, q.status_label);

/** A process state: the platform's own wording when known, coloured by category. */
export const statePill = (state, raw) => h("span", { class: `pill ps-${state}`, title: raw && STATE[state] ? STATE[state] : undefined }, raw ?? STATE[state] ?? state);

export function toolName(tools, id) {
  if (id === CUSTOM_TOOL_ID) return "Custom";
  return tools.find((t) => t.id === id)?.name ?? id;
}

/** "Loomio · poll"; for processes not on the tool list, just their kind ("General assembly"). */
export function processKind(q, tools) {
  const p = q.process;
  const kind = q.fields?.kind?.value ?? p.item_type;
  if (p.tool_id === CUSTOM_TOOL_ID) return kind ? itemLabel(kind) : p.url ? new URL(p.url).hostname.replace(/^www\./, "") : "Process";
  return kind ? `${toolName(tools, p.tool_id)} · ${itemLabel(kind)}` : toolName(tools, p.tool_id);
}

/** Compact chip: tool · kind · the platform's word for its state · key extra value */
export function processChip(q, tools) {
  const process = q.process;
  if (!process) return null;
  const f = process.fetched;
  const extra = f?.extra ?? {};
  const key = ["participants", "votes", "forecasters", "comments"].find((k) => extra[k] !== undefined);
  const hasState = process.fetch_mode === "auto" && f && f.state !== "unknown";
  return h(
    "span",
    { class: "chip" },
    h("span", { class: "chip-tool" }, processKind(q, tools)),
    process.url ? h("a", { href: process.url, target: "_blank", rel: "noopener noreferrer", class: "chip-ext", title: `Open on ${process.tool_id === CUSTOM_TOOL_ID ? new URL(process.url).hostname : toolName(tools, process.tool_id)}`, "aria-label": "Open the process (new tab)" }, "↗") : null,
    hasState ? [" · ", statePill(f.state, f.raw_state)] : null,
    key ? h("span", { class: "muted" }, ` · ${extra[key]} ${key.replace(/_/g, " ")}`) : null,
    f?.fetch_error ? h("span", { class: "warn", title: f.fetch_error }, " ⚠") : null,
  );
}

/** What the card says about the questions it's linked to, besides its place in the hierarchy: "Related to A, B". */
const LINK_TEXT = { parent: "Child of", child: "Parent of", related: "Related to", duplicate_of: "Duplicate of", duplicated_by: "Duplicated by" };
const LINK_MARK = { parent: "↳", child: "↱", related: "↔", duplicate_of: "≡", duplicated_by: "≡" };

function cardLinks(q, hierarchy, seen) {
  // In the hierarchy, what the layout already shows isn't written: the question it stands under, the ones nested
  // below it, the related ones next to it. (Children not in the list aren't mentioned either.)
  const shown = (l) => (hierarchy ? !(l.role === "child" || seen.has(l.id)) : true);
  const links = (q.links ?? []).filter(shown);
  if (!links.length) return null;
  const roles = Object.keys(LINK_TEXT).filter((r) => links.some((l) => l.role === r));
  return h(
    "div",
    { class: "card-links" },
    roles.map((r) =>
      h(
        "span",
        { class: "card-link" },
        h("span", { "aria-hidden": "true" }, LINK_MARK[r], " "),
        `${LINK_TEXT[r]} `,
        links.filter((l) => l.role === r).map((l, i) => [i ? ", " : "", h("a", { href: `#/q/${l.id}` }, l.title)]),
      ),
    ),
  );
}

/**
 * One question as a card. With `children` (cards of the questions below it: its children and duplicates)
 * they are nested under it, with a discreet branch (dashed for a duplicate). Related questions that follow
 * each other are joined by a dotted line. `kidIds`: the questions nested below. `ctx.hierarchy`: the list
 * is arranged by hierarchy (see cardLinks).
 */
export function questionCard(q, ctx, children = [], kidIds = []) {
  const { tools, since } = ctx;
  const seen = new Set([q.parent_id, ...kidIds, ...(q.cluster ?? [])].filter(Boolean));
  const changed = since && q.last_activity_at > since;
  const platformAt = q.process?.fetched?.dates?.updated_at;
  return h(
    "li",
    { class: `node${q.nested_as === "duplicate" ? " is-duplicate" : ""}${q.cluster_prev ? " cluster-prev" : ""}` },
    h(
      "div",
      { class: `card${changed ? " is-changed" : ""}` },
      h(
        "div",
        { class: "card-head" },
        h("span", null, q.nested_as === "duplicate" ? h("span", { class: "card-tag", title: "Duplicate of the matter above it" }, "≡ duplicate ") : null, h("a", { href: `#/q/${q.id}`, class: "card-title" }, q.title)),
        questionPill(q),
      ),
      q.cluster ? h("span", { class: "visually-hidden" }, "Related to the neighbouring matter") : null,
      h(
        "div",
        { class: "card-meta" },
        processChip(q, tools),
        q.fields?.summary?.value ? h("span", { class: "muted" }, q.fields.summary.value) : null,
      ),
      h(
        "div",
        { class: "card-criteria" },
        q.process ? (q.fields?.status?.source === "retrieved" ? "Status retrieved" : "Status typed") : "No tool attached",
        " · ",
        platformAt ? ["last activity on the platform ", time(platformAt, timeAgo(platformAt))] : ["last change ", time(q.last_activity_at, timeAgo(q.last_activity_at))],
      ),
      cardLinks(q, ctx.hierarchy, seen),
      changed ? h("div", { class: "badges" }, h("span", { class: "badge changed" }, "★ Changed since your last visit")) : null,
    ),
    children.length ? h("ul", { class: "cards children" }, children) : null,
  );
}

/** The cards of a list arranged by hierarchy (`parent_id` on each question, parents first), nested. */
export function questionTree(questions, ctx) {
  const kids = new Map();
  for (const q of questions) if (q.parent_id) kids.set(q.parent_id, [...(kids.get(q.parent_id) ?? []), q]);
  const build = (q) => questionCard(q, ctx, (kids.get(q.id) ?? []).map(build), (kids.get(q.id) ?? []).map((k) => k.id));
  return questions.filter((q) => !q.parent_id).map(build);
}

/** "child of “X”", "parent of “X”", "duplicate of “X”"… for a relation event, from the side of the question it was logged on. */
function relationDetail(e, d) {
  const self = e.question_id === d.from_id;
  const other = d.other_title ? `“${d.other_title}”` : "another matter";
  if (d.kind === "child_of") return `${self ? "child" : "parent"} of ${other}`;
  if (d.kind === "duplicate") return self ? `duplicate of ${other}` : `duplicated by ${other}`;
  return `related to ${other}`;
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
        d.source === "process" || d.source === "retrieved" ? " (retrieved)" : d.source === "manual" || d.source === "typed" ? " (typed)" : "",
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
      detail = d.source === "retrieved" ? `title → “${d.title?.after}” (retrieved)` : Object.keys(d).map((k) => k.replace(/_/g, " ")).join(", ");
      break;
    case "question.fields_changed": {
      const one = (f, x) =>
        x?.source !== "typed"
          ? "back to retrieved"
          : `${x.value === null ? "none" : f === "status" ? (x.value.label ?? STATE[x.value.state]) : f === "start" || f === "end" ? fmtWhen(x.value) : f === "kind" ? itemLabel(x.value) : `“${x.value}”`} (typed)`;
      const name = (f) => (f === "results_url" ? "results" : f);
      detail = [Object.entries(d.fields ?? {}).map(([f, c]) => `${name(f)} → ${one(f, c.after)}`).join(" · "), d.note ? ` — “${d.note}”` : ""];
      break;
    }
    case "process.tool_matched":
      detail = d.url;
      break;
    case "question.dates_changed": {
      const one = (x) => (x?.source === "manual" ? fmtWhen(x.date) : x?.source === "none" ? "none" : "from the link");
      detail = ["start", "end"].filter((k) => JSON.stringify(d.before?.[k]) !== JSON.stringify(d.after?.[k])).map((k) => `${k}: ${one(d.after?.[k])}`).join(" · ");
      break;
    }
    case "tool.added":
      detail = d.tool?.name;
      break;
    case "tool.edited":
      detail = d.after?.name;
      break;
    case "relation.added":
    case "relation.removed":
      detail = relationDetail(e, d);
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
