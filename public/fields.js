// Per-field display and editing: each value says whether it's retrieved (from the linked item) or
// typed. Double-click a value (or press ✎) to type it; "↺ use retrieved" goes back.
import { h, extLink, fmtDate, fmtWhen, dateEnd, toDayTimeInputs, fromDayTimeInputs } from "./dom.js";
import { STATE, QUESTION_STATES, itemLabel } from "./labels.js";
import { statusPill } from "./components.js";

export const FIELD_LABEL = { title: "Title", kind: "Kind", status: "Status", summary: "Summary", results_url: "Results", start: "Start", end: "End" };
const isDate = (f) => f === "start" || f === "end";

/** How a value reads. `null` is a value typed as "none". */
export function showValue(field, v) {
  if (v === null) return h("span", { class: "muted" }, isDate(field) ? "no date" : "none");
  if (v === undefined || v === "") return h("span", { class: "muted" }, "—");
  switch (field) {
    case "status":
      return statusPill(v.state, v.label);
    case "kind":
      return itemLabel(v);
    case "results_url":
      // A link, or plain words ("Adopted 9–1"); only https links become links.
      return /^https:\/\//i.test(String(v)) ? extLink(String(v)) : String(v);
    case "start":
    case "end":
      return [fmtWhen(v), field === "end" && dateEnd(v) > Date.now() ? h("span", { class: "muted" }, " (planned)") : null];
    default:
      return String(v);
  }
}

/** "retrieved", "retrieved as “merged”", "typed", or "not retrieved" for an item that could give it. */
export function sourceTag(field, view) {
  if (view.source === "typed") return h("span", { class: "src src-typed", title: view.by ? `Typed by ${view.by}, ${fmtDate(view.at)}` : "Typed" }, "typed");
  if (view.source === "retrieved")
    return h("span", { class: "src src-retrieved", title: "From the linked item, kept up to date" }, field === "status" && view.as ? `retrieved as “${view.as}”` : "retrieved");
  return view.retrievable ? h("span", { class: "src src-empty", title: "The linked item can give this, but hasn't (yet)" }, "not retrieved") : null;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The inline editor for one field. Resolves via `onSave(value)` (`null` = none) or `onCancel()`. */
function editor(field, view, { labels, kinds, onSave, onCancel }) {
  const start = view.value ?? view.retrieved;
  let input, read;
  if (field === "status") {
    const sel = h(
      "select",
      { "aria-label": "Status" },
      QUESTION_STATES.filter((s) => labels.some((l) => l.state === s)).map((s) =>
        h("optgroup", { label: STATE[s] }, labels.filter((l) => l.state === s).map((l) => h("option", { value: l.label, selected: start?.label === l.label || (!start?.label && start?.state === s && labels.find((x) => x.state === s) === l) }, l.label))),
      ),
    );
    const note = h("input", { type: "text", maxlength: 1000, placeholder: "Optional: why (shown in the history)", "aria-label": "Note" });
    read = () => ({ value: { label: sel.value }, note: note.value });
    input = [sel, note];
  } else if (isDate(field)) {
    const pre = toDayTimeInputs(typeof start === "string" ? start : "");
    const date = h("input", { type: "date", value: pre.date, "aria-label": `${FIELD_LABEL[field]}: day` });
    const time = h("input", { type: "time", value: pre.time, "aria-label": `${FIELD_LABEL[field]}: time (optional)` });
    read = () => {
      if (!date.value) throw new Error("Choose a day, or use “No date”");
      return { value: fromDayTimeInputs(date.value, time.value) };
    };
    input = [date, " ", time, h("span", { class: "hint" }, "Leave the time empty for the whole day.")];
  } else {
    const listId = field === "kind" ? `kinds-${Math.random().toString(36).slice(2)}` : null;
    const el = h("input", {
      type: "text",
      maxlength: field === "kind" ? 60 : field === "results_url" ? 2000 : 300,
      placeholder: field === "results_url" ? "A link, or a few words" : null,
      value: typeof start === "string" ? (field === "kind" ? itemLabel(start) : start) : "",
      list: listId,
      "aria-label": FIELD_LABEL[field],
    });
    read = () => ({ value: el.value.trim() || null });
    input = [el, listId ? h("datalist", { id: listId }, kinds.map((k) => h("option", { value: k }))) : null];
  }
  const save = h("button", { type: "submit", class: "primary" }, "Save");
  const form = h(
    "form",
    {
      class: "field-editor",
      onsubmit: async (e) => {
        e.preventDefault();
        let r;
        try {
          r = read();
        } catch (err) {
          return onSave(undefined, err);
        }
        save.disabled = true;
        await onSave(r.value, undefined, r.note);
        save.disabled = false;
      },
      onkeydown: (e) => e.key === "Escape" && onCancel(),
    },
    input,
    h(
      "div",
      { class: "row" },
      save,
      field !== "title" && field !== "status" ? h("button", { type: "button", onclick: () => onSave(null) }, isDate(field) ? "No date" : "Clear") : null,
      h("button", { type: "button", onclick: onCancel }, "Cancel"),
    ),
  );
  queueMicrotask(() => form.querySelector("input, select")?.focus());
  return form;
}

/**
 * One field: its value, where it comes from, and (when editable) ✎ / double-click to type it, plus the
 * retrieved value and "↺ use retrieved" when a typed one is in use.
 * `ctx`: {editable, labels, kinds, save(body) → Promise<boolean>, toast(msg)}. `display`: wraps the value (e.g. an h1).
 */
export function fieldCell(field, view, ctx, display = (v) => h("span", { class: "field-value" }, v)) {
  const cell = h("div", { class: `field-cell field-${field}` });
  const startEdit = () => {
    if (!ctx.editable) return;
    cell.replaceChildren(
      editor(field, view, {
        labels: ctx.labels,
        kinds: ctx.kinds ?? [],
        onCancel: () => cell.replaceChildren(...content().filter(Boolean)),
        onSave: async (value, err, note) => {
          if (err) return ctx.toast(err.message);
          await ctx.save({ set: { [field]: value }, ...(note ? { note } : {}) });
        },
      }),
    );
  };
  const content = () => {
    const shown = display(showValue(field, view.value));
    if (ctx.editable) {
      shown.addEventListener("dblclick", startEdit);
      shown.title = "Double-click to type a value";
    }
    const differs = view.source === "typed" && view.retrieved !== undefined && !same(view.retrieved, view.value);
    const canGoBack = ctx.editable && view.source === "typed" && view.retrievable && (view.retrieved !== undefined || field !== "title");
    return [
      shown,
      h(
        "span",
        { class: "field-meta" },
        sourceTag(field, view),
        ctx.editable ? h("button", { type: "button", class: "link edit-field", "aria-label": `Type the ${FIELD_LABEL[field].toLowerCase()}`, title: "Type a value", onclick: startEdit }, "✎") : null,
      ),
      differs || canGoBack
        ? h(
            "div",
            { class: "field-retrieved" },
            differs ? ["retrieved: ", showValue(field, view.retrieved), view.as && field === "status" ? ` (as “${view.as}”)` : "", " "] : null,
            canGoBack ? h("button", { type: "button", class: "link", onclick: () => ctx.save({ use_retrieved: [field] }) }, "↺ use retrieved") : null,
          )
        : null,
    ];
  };
  cell.append(...content().filter(Boolean)); // (native append() would write "null")
  return cell;
}

// ---------------------------------------------------------------- creating a question

/** What a link preview (`POST resolve-url`) says the linked item will give, shaped like `question.fields` values. */
export function retrievedFromPreview(p) {
  const out = {};
  if (!p?.matched) return out;
  if (p.item_type) out.kind = p.item_type;
  const f = p.fetch_mode === "auto" ? p.fetched : undefined;
  if (!f) return out;
  if (f.state && f.state !== "unknown") out.status = { state: f.state, as: f.raw_state };
  if (f.outcome_summary) out.summary = f.outcome_summary;
  if (typeof f.extra?.results_url === "string") out.results_url = f.extra.results_url;
  if (f.dates?.opens_at) out.start = f.dates.opens_at;
  const end = f.dates?.resolved_at ?? f.dates?.closes_at;
  if (end) out.end = end;
  return out;
}

/**
 * The details of a new question: kind, status, summary, results, start, end. All optional. Fields the
 * linked item gives are pre-filled with the retrieved values and keep following the item; only a value
 * the user changes (or fills in) is sent, and so typed. `read()` → `{process_kind?, status?, fields}`
 * to merge into the creation request.
 */
export function createFields({ labels, kinds, retrieved = {} }) {
  const has = (f) => retrieved[f] !== undefined;
  const row = (name, input, hint) =>
    h(
      "label",
      { class: "field" },
      h("span", { class: "label" }, FIELD_LABEL[name], has(name) ? h("span", { class: "src src-retrieved" }, "retrieved") : null),
      input,
      has(name) ? h("span", { class: "hint" }, "From the link, kept up to date. Change it to type your own.") : hint ? h("span", { class: "hint" }, hint) : null,
    );

  const listId = `kinds-${Math.random().toString(36).slice(2)}`;
  const kindStart = has("kind") ? itemLabel(retrieved.kind) : "";
  const kind = h("input", { type: "text", maxlength: 60, list: listId, value: kindStart, placeholder: "e.g. Meeting, General assembly, Survey", "aria-label": "Kind" });
  const kindList = h("datalist", { id: listId }, kinds.map((k) => h("option", { value: k })));

  // The retrieved status is pre-selected as the first label of its category; without one, "" = Not started.
  const rs = retrieved.status;
  const statusStart = rs ? (labels.find((l) => l.state === rs.state)?.label ?? "") : "";
  const status = h(
    "select",
    { "aria-label": "Status" },
    rs ? null : h("option", { value: "" }, `${labels.find((l) => l.state === "not_started")?.label ?? "Not started"} (default)`),
    QUESTION_STATES.filter((s) => labels.some((l) => l.state === s)).map((s) =>
      h("optgroup", { label: STATE[s] }, labels.filter((l) => l.state === s).map((l) => h("option", { value: l.label, selected: l.label === statusStart }, l.label))),
    ),
  );

  const summaryStart = has("summary") ? retrieved.summary : "";
  const resultsStart = has("results_url") ? retrieved.results_url : "";
  const summary = h("input", { type: "text", maxlength: 300, value: summaryStart, "aria-label": "Summary", placeholder: "What it is, or how it went" });
  const results = h("input", { type: "text", maxlength: 2000, value: resultsStart, "aria-label": "Results", placeholder: "A link, or a few words" });
  const dateInputs = (name) => {
    const pre = has(name) ? toDayTimeInputs(retrieved[name]) : { date: "", time: "" };
    const date = h("input", { type: "date", value: pre.date, "aria-label": `${FIELD_LABEL[name]}: day` });
    const time = h("input", { type: "time", value: pre.time, "aria-label": `${FIELD_LABEL[name]}: time (optional)` });
    return { date, time, pre, el: h("span", { class: "date-pair" }, date, " ", time) };
  };
  const start = dateInputs("start");
  const end = dateInputs("end");

  const el = h(
    "fieldset",
    { class: "create-fields" },
    h("legend", null, "Details (all optional)"),
    row("kind", kind, "Kind of item: a meeting, a survey… Needed for a question with no link."),
    kindList,
    row("status", status),
    row("summary", summary, "Shown on the question page."),
    row("results_url", results, "Where to read the outcome, or the outcome itself."),
    row("start", start.el, "Leave the time empty for the whole day."),
    row("end", end.el, "Leave the time empty for the whole day."),
  );

  return {
    el,
    read() {
      const out = { fields: {} };
      // Unchanged pre-filled values stay retrieved; an emptied one just goes back to following the item.
      if (kind.value.trim() && kind.value.trim() !== kindStart) out.process_kind = kind.value.trim();
      if (status.value && status.value !== statusStart) out.status = { label: status.value };
      if (summary.value.trim() && summary.value.trim() !== summaryStart) out.fields.summary = summary.value.trim();
      if (results.value.trim() && results.value.trim() !== resultsStart) out.fields.results_url = results.value.trim();
      for (const [name, d] of [["start", start], ["end", end]]) {
        if (d.time.value && !d.date.value) throw new Error(`Choose a day for the ${name}, or clear the time`);
        if (d.date.value && (d.date.value !== d.pre.date || d.time.value !== d.pre.time)) out.fields[name] = fromDayTimeInputs(d.date.value, d.time.value);
      }
      return out;
    },
  };
}
