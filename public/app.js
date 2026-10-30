// Question register — single-page UI. Hash routes:
//   #/list?lane=current&q=…  home (lanes, search, filters)
//   #/q/<id>                 question page
//   #/rules                  charter, tool list, status labels; #/rules/add-tool?url=…; #/rules/tool?id=… (edit)
//   #/activity               activity feed
import { api, qs, getName, setName, TOKEN, ApiError } from "./api.js";
import { h, extLink, fmtDate, time, timeAgo, toast, debounce, toLocalInput, fromLocalInput } from "./dom.js";
import { STATE, STATE_HINT, QUESTION_STATES, ENDED, CUSTOM_TOOL_ID, itemLabel } from "./labels.js";
import { statusPill, questionPill, statePill, processChip, processKind, questionCard, activityItem, toolName, mappingEditor } from "./components.js";
import { renderMarkdown } from "./md.js";

const app = document.getElementById("app");
const S = { space: null, role: "view", tools: [], counts: {}, since: null };
const canEdit = () => S.role === "edit";
/** Removed questions are read-only until restored. */
const canEditQ = (q) => canEdit() && !q.removed_at;

// ---------------------------------------------------------------- bootstrap

async function loadSpace() {
  const d = await api("GET", "space");
  Object.assign(S, d);
  document.title = `${S.space.name} · Question register`;
}

async function boot() {
  try {
    await loadSpace();
  } catch (e) {
    app.replaceChildren(h("div", { class: "panel error" }, h("h1", null, "This link doesn't work"), h("p", null, e.message)));
    return;
  }
  const key = `qr:seen:${S.space.id}`;
  S.since = localStorage.getItem(key);
  localStorage.setItem(key, new Date().toISOString());
  if (canEdit() && !getName()) await askName();
  if (canEdit()) installLinkDrop();
  window.addEventListener("hashchange", render);
  render();
}

function askName() {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", maxlength: 60, value: getName(), required: true, autocomplete: "nickname", "aria-label": "Display name" });
    const close = () => (overlay.remove(), resolve());
    const overlay = h(
      "div",
      { class: "overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "name-title" },
      h(
        "form",
        {
          class: "panel modal",
          onsubmit: (e) => {
            e.preventDefault();
            const v = input.value.trim();
            if (!v) return;
            if (["system", "operator"].includes(v.toLowerCase())) return toast("That name is reserved", "error");
            setName(v);
            close();
            render();
          },
        },
        h("h2", { id: "name-title" }, "What should we call you?"),
        h("p", null, "Your display name is attached to everything you change here. Names aren't verified: please use the name people in the group know you by."),
        input,
        h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, "Continue"), getName() ? h("button", { type: "button", onclick: close }, "Cancel") : null),
      ),
    );
    document.body.append(overlay);
    input.focus();
  });
}

// ---------------------------------------------------------------- drag and drop a link

/** What the current page does with a dropped link (set by each page); otherwise: add it from the home page. */
let onLinkDrop = null;
let pendingDrop = null;

/** The first http(s) link in a drop: text/uri-list (browsers' link drags), then plain text. */
function linkFromDrop(dt) {
  const list = (dt.getData("text/uri-list") || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const text = (dt.getData("text/plain") || "").trim();
  const v = list || text;
  return /^https?:\/\/\S+$/i.test(v) ? v : null;
}

function installLinkDrop() {
  let depth = 0;
  const hasLink = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === "text/uri-list" || t === "text/plain");
  const done = () => ((depth = 0), document.body.classList.remove("dropping"));
  document.addEventListener("dragenter", (e) => {
    if (!hasLink(e)) return;
    depth++;
    document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", () => {
    if (--depth <= 0) done();
  });
  document.addEventListener("dragover", (e) => {
    if (!hasLink(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("drop", (e) => {
    done();
    // Let text fields receive dropped text as usual.
    if (e.target?.closest?.("input, textarea")) return;
    const url = linkFromDrop(e.dataTransfer);
    e.preventDefault();
    if (!url) return toast("Drop a link (https://…) to add it", "error");
    if (onLinkDrop) return onLinkDrop(url);
    pendingDrop = url;
    location.hash = "#/list?lane=current";
  });
}

/** Put a link in the home composer, as if pasted. */
function fillComposer(url) {
  const input = document.getElementById("composer-input");
  if (!input) return false;
  input.value = url;
  input.dispatchEvent(new Event("input"));
  input.focus();
  return true;
}

// ---------------------------------------------------------------- routing

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/list";
  const [path, query] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query ?? "") };
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { parts, params } = parseHash();
  onLinkDrop = null;
  let view;
  try {
    if (parts[0] === "q" && parts[1]) view = await pageQuestion(parts[1]);
    else if (parts[0] === "rules") view = await pageRules(parts[1], params);
    else if (parts[0] === "activity") view = await pageActivity();
    else view = await pageHome(params);
  } catch (e) {
    view = h("div", { class: "panel error" }, h("h2", null, "Something went wrong"), h("p", null, e.message));
  }
  if (seq !== renderSeq) return;
  app.replaceChildren(header(parts[0] ?? "list", params), h("main", { id: "main" }, view));
  if (!parts[0] || parts[0] === "list") {
    document.getElementById("composer-input")?.focus({ preventScroll: true });
    if (canEdit()) onLinkDrop = fillComposer;
    if (pendingDrop && fillComposer(pendingDrop)) pendingDrop = null;
  }
}

/** Re-load space counts and re-render the current page. */
async function refresh() {
  await loadSpace();
  await render();
}

function header(section, params) {
  const c = S.counts ?? {};
  const n = (states) => states.reduce((a, s) => a + (c[s] ?? 0), 0);
  const lane = params.get("lane") ?? (section === "list" && ![...params.keys()].length ? "current" : null);
  const tab = (key, label, href) =>
    h("a", { href, class: `tab${(section === "list" && lane === key) || (section === key && !lane) ? " current" : ""}`, "aria-current": section === "list" && lane === key ? "page" : null }, label);
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-row" },
      h("a", { href: "#/list?lane=current", class: "space-name" }, S.space.name),
      h(
        "div",
        { class: "who" },
        S.role === "view" ? h("span", { class: "badge" }, "View only") : null,
        canEdit() ? h("button", { class: "link", onclick: () => askName(), title: "Change your display name" }, "You: ", h("strong", null, getName() || "?"), " ✎") : null,
      ),
    ),
    h(
      "nav",
      { class: "lanes", "aria-label": "Lanes" },
      tab("current", `Current (${n(["not_started", "open"])})`, "#/list?lane=current"),
      tab("ended", `Ended (${n(ENDED)})`, "#/list?lane=ended"),
      tab("withdrawn", `Withdrawn (${n(["withdrawn"])})`, "#/list?lane=withdrawn"),
      h("a", { href: "#/rules", class: `tab${section === "rules" ? " current" : ""}` }, "Rules"),
      h("a", { href: "#/activity", class: `tab${section === "activity" ? " current" : ""}` }, "Activity"),
    ),
  );
}


// ---------------------------------------------------------------- helpers

/** Run an API call with error toast; returns the result or undefined. */
async function act(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success, "ok");
    return r ?? true;
  } catch (e) {
    if (e instanceof ApiError && e.code === "name_required") {
      await askName();
      return undefined;
    }
    toast(e.message, "error");
    return undefined;
  }
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "label" }, label), input, hint ? h("span", { class: "hint" }, hint) : null);
}

/** A collapsible inline form; `build` returns { body, submit: async () => boolean } */
function inlineForm(title, submitLabel, build, opts = {}) {
  const { body, submit } = build();
  const btn = h("button", { type: "submit", class: opts.danger ? "danger" : "primary" }, submitLabel);
  const form = h(
    "form",
    {
      class: "inline-form",
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const ok = await submit();
          if (ok) await refresh();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      },
    },
    h("h3", null, title),
    body,
    h("div", { class: "row" }, btn, h("button", { type: "button", onclick: () => form.remove() }, "Cancel")),
  );
  return form;
}

const linesToList = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- home

const LANES = {
  current: { label: "Current (not started, in progress)", status: "not_started,open" },
  ended: { label: "Ended (accepted, rejected, concluded)", status: ENDED.join(",") },
  withdrawn: { label: "Withdrawn", status: "withdrawn" },
  all: { label: "All", status: "" },
};
const PRESETS = [
  ["no_process", "No process yet"],
  ["quiet", "Quiet for 30+ days"],
  ["fetch_problems", "Fetch problems"],
];
const FILTER_KEYS = ["q", "preset", "status", "tool", "item_type", "state", "source", "has_process", "related"];

async function pageHome(params) {
  const searching = FILTER_KEYS.some((k) => params.get(k));
  const lane = params.get("lane") ?? (searching ? "all" : "current");
  const query = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k)]));
  query.status = params.get("status") || (LANES[lane]?.status ?? "");
  query.sort = params.get("sort");
  const { questions } = await api("GET", `questions${qs(query)}`);

  const setParam = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    location.hash = `#/list?${p}`;
  };

  const searchInput = h("input", { type: "search", placeholder: "Search questions…", value: params.get("q") ?? "", "aria-label": "Search questions" });
  const searchForm = h("form", { class: "search", role: "search", onsubmit: (e) => (e.preventDefault(), setParam("q", searchInput.value.trim())) }, searchInput, h("button", { type: "submit" }, "Search"));

  const sel = (key, label, options, anyLabel = "Any") =>
    field(
      label,
      h(
        "select",
        { onchange: (e) => setParam(key, e.target.value) },
        anyLabel ? h("option", { value: "" }, anyLabel) : null,
        options.map(([v, l]) => h("option", { value: v, selected: (params.get(key) ?? "") === v }, l)),
      ),
    );
  const itemTypes = [...new Set([...S.tools.flatMap((t) => t.url_patterns.map((p) => p.item_type)), ...(S.custom_kinds ?? []).map((k) => k.kind)])];
  const filters = h(
    "details",
    { class: "filters", open: ["status", "tool", "state", "source", "has_process", "item_type", "sort"].some((k) => params.get(k)) || params.get("lane") === "all" },
    h("summary", null, "Filters"),
    h(
      "div",
      { class: "filter-grid" },
      sel("lane", "Lane", Object.entries(LANES).map(([k, l]) => [k, l.label]), null),
      sel("status", "Status", QUESTION_STATES.map((s) => [s, STATE[s]])),
      sel("source", "Status comes from", [["process", "The process"], ["manual", "Set by hand"]]),
      sel("tool", "Tool", [[CUSTOM_TOOL_ID, "Custom process"], ...S.tools.map((t) => [t.id, t.name])]),
      sel("item_type", "Item type", itemTypes.map((t) => [t, itemLabel(t)])),
      sel("state", "Process state", Object.entries(STATE)),
      sel("has_process", "Has a process", [["yes", "Yes"], ["no", "No"]]),
      sel("sort", "Order", [["", "Latest activity first"], ["created", "Newest first"]], null),
    ),
  );
  const presets = h(
    "div",
    { class: "presets", role: "group", "aria-label": "Shortcuts" },
    PRESETS.map(([k, l]) => h("button", { type: "button", class: `chip-btn${params.get("preset") === k ? " on" : ""}`, "aria-pressed": params.get("preset") === k ? "true" : "false", onclick: () => setParam("preset", params.get("preset") === k ? "" : k) }, l)),
  );

  const relatedChip = params.get("related") ? h("p", null, "Showing questions related to another · ", h("a", { href: `#/q/${params.get("related")}` }, "open it"), " · ", h("button", { class: "link", onclick: () => setParam("related", "") }, "clear")) : null;
  const ctx = { tools: S.tools, since: S.since, space: S.space };
  const list = questions.length
    ? h("ul", { class: "cards" }, questions.map((q) => questionCard(q, ctx)))
    : h("p", { class: "empty" }, searching ? "No questions match." : lane === "current" ? "No current questions. Add one above." : "Nothing here yet.");

  return h("div", null, canEdit() ? composer() : null, h("div", { class: "toolbar" }, searchForm, presets), filters, relatedChip, list);
}

/** "Ask a question, or paste a link." */
function composer(opts = {}) {
  // An existing question with the same title or link: open it, or (on a question page) relate it.
  const existingNotice = (x, text) =>
    h(
      "div",
      { class: "notice-existing" },
      text,
      " ",
      h("a", { href: `#/q/${x.id}` }, x.title),
      opts.relateTo && x.id !== opts.relateTo && !opts.exclude?.has(x.id) ? [" · ", h("button", { type: "button", class: "link", onclick: () => opts.onRelate(x) }, "Relate it instead")] : null,
    );
  const input = h("input", { id: opts.relateTo ? null : "composer-input", type: "text", maxlength: 2000, placeholder: opts.placeholder ?? "Ask a question, or paste or drop a link.", autocomplete: "off", "aria-label": "Ask a question, or paste a link" });
  const panel = h("div", { class: "composer-panel" });
  let mode = "idle"; // idle | text | link
  let preview = null;

  const why = h("textarea", { rows: 2, placeholder: "Why it matters (optional)" });
  const framing = h("textarea", { rows: 2, placeholder: "Framing (optional): how this process interprets the question, and its limits" });
  const title = h("input", { type: "text", maxlength: 300 });
  const hints = h("div", { class: "hints" });
  const submitBtn = h("button", { type: "submit", class: "primary" }, opts.relateTo ? "Add as a new related question" : "Add question");

  const loadHints = debounce(async (t) => {
    if (t.length < 4) return hints.replaceChildren();
    try {
      const { similar } = await api("GET", `similar${qs({ title: t, exclude: opts.relateTo })}`);
      const list = opts.exclude ? similar.filter((s) => !opts.exclude.has(s.id)) : similar;
      if (!list.length) return hints.replaceChildren();
      const kindNow = opts.kind?.() ?? "related";
      // On a question page, a suggestion is a link target: clicking it relates the existing question.
      const item = (s) =>
        opts.relateTo
          ? h("li", null, h("button", { type: "button", class: "link", title: kindNow === "duplicate" ? "Mark this question as a duplicate of it" : "Relate this existing question", onclick: () => opts.onRelate(s) }, kindNow === "duplicate" ? "≡ " : "＋ ", s.title), " ", statusPill(s.status), " ", h("a", { href: `#/q/${s.id}`, class: "muted small", title: "Open it" }, "↗"))
          : h("li", null, h("a", { href: `#/q/${s.id}` }, s.title), " ", statusPill(s.status));
      hints.replaceChildren(
        h(
          "div",
          null,
          h("span", { class: "muted small" }, opts.relateTo ? "Relate an existing question, or add yours as a new one: " : "Already asked? "),
          h("ul", { class: "hint-list" }, list.map(item)),
        ),
      );
    } catch {}
  }, 300);

  const checkLink = debounce(async (url) => {
    panel.replaceChildren(h("p", { class: "muted" }, "Checking the link…"));
    try {
      preview = await api("POST", "resolve-url", { url });
    } catch (e) {
      panel.replaceChildren(h("p", { class: "error" }, e.message));
      return;
    }
    if (input.value.trim() !== url) return;
    if (!preview.matched) {
      mode = "idle";
      panel.replaceChildren(
        h(
          "div",
          { class: "notice" },
          h("p", null, "This link isn't from a tool on the group's tool list."),
          h("a", { class: "button", href: `#/rules/add-tool${qs({ url })}` }, "Add this tool"),
        ),
      );
      return;
    }
    if (preview.existing) {
      mode = "idle";
      panel.replaceChildren(existingNotice(preview.existing, "This link is already tracked by"));
      return;
    }
    mode = "link";
    title.value = preview.title ?? "";
    title.placeholder = "Write the question in the group's words";
    loadHints(title.value);
    panel.replaceChildren(
      h(
        "div",
        { class: "link-preview" },
        h("strong", null, preview.tool_name), " · ", itemLabel(preview.item_type),
        preview.fetched ? [" · ", statePill(preview.fetched.state, preview.fetched.raw_state), preview.fetched.outcome_summary ? ` ${preview.fetched.outcome_summary}` : ""] : preview.fetch_mode === "manual" ? h("span", { class: "muted" }, " · state is updated by hand") : null,
        preview.fetch_error ? h("p", { class: "warn" }, preview.fetch_mode === "manual" ? `${preview.fetch_error}: its state will be updated by hand.` : `Couldn't fetch details: ${preview.fetch_error}`) : null,
      ),
      field("Question", title, preview.title ? "Prefilled from the linked page. Edit it into the group's own words." : "Write the question in the group's own words."),
      hints,
      why,
      framing,
      h("div", { class: "row" }, submitBtn),
    );
  }, 350);

  input.addEventListener("input", () => {
    const v = input.value.trim();
    if (/^https?:\/\//i.test(v)) {
      if (/^http:\/\//i.test(v)) {
        mode = "idle";
        return panel.replaceChildren(h("p", { class: "warn" }, "Only https:// links are accepted."));
      }
      checkLink(v);
      return;
    }
    if (!v) {
      mode = "idle";
      return panel.replaceChildren();
    }
    if (mode !== "text") {
      mode = "text";
      panel.replaceChildren(hints, why, h("div", { class: "row" }, submitBtn));
    }
    loadHints(v);
  });

  const form = h(
    "form",
    {
      class: "composer panel",
      onsubmit: async (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v || mode === "idle") return;
        const body = { why_it_matters: why.value, related_id: opts.relateTo };
        if (mode === "link") Object.assign(body, { title: title.value, process_url: v, framing: framing.value });
        else body.title = v;
        submitBtn.disabled = true;
        let r;
        try {
          r = await api("POST", "questions", body);
          toast("Question added", "ok");
        } catch (err) {
          if (err.code === "duplicate_title" || err.code === "duplicate_link") {
            panel.querySelector(".notice-existing")?.remove();
            panel.prepend(existingNotice(err.details.existing, err.code === "duplicate_link" ? "This link is already tracked by" : "Already in the register:"));
          } else if (err instanceof ApiError && err.code === "name_required") await askName();
          else toast(err.message, "error");
        }
        submitBtn.disabled = false;
        if (r) {
          await loadSpace();
          location.hash = `#/q/${r.question.id}`;
        }
      },
    },
    input,
    panel,
  );
  return form;
}

// ---------------------------------------------------------------- question page

async function pageQuestion(id) {
  const d = await api("GET", `questions/${id}`);
  const q = d.question;
  const formSlot = h("div", { class: "form-slot" });
  const openForm = (f) => {
    formSlot.replaceChildren(f);
    f.scrollIntoView({ behavior: "smooth", block: "nearest" });
    f.querySelector("input:not([type=radio]):not([type=checkbox]), textarea, select")?.focus();
  };

  const editForm = () =>
    inlineForm("Edit question", "Save", () => {
      const title = h("input", { type: "text", required: true, maxlength: 300, value: q.title });
      const why = h("textarea", { rows: 3, value: q.why_it_matters ?? "" });
      return { body: [field("Question", title), field("Why it matters", why)], submit: () => act(() => api("PATCH", `questions/${q.id}`, { title: title.value, why_it_matters: why.value }), "Saved") };
    });

  const removeForm = () =>
    inlineForm(
      "Remove this question",
      "Remove",
      () => {
        const reason = h("input", { type: "text", maxlength: 1000, placeholder: "Optional: spam, added by mistake, test…" });
        return {
          body: [
            h("p", null, "Removed questions are hidden from lists, but kept: anyone can restore them from the Rules page. For a question that was dropped or didn't run its course, set a ", h("em", null, "Withdrawn"), " status instead."),
            field("Reason", reason),
          ],
          submit: () => act(() => api("POST", `questions/${q.id}/remove`, { reason: reason.value }), "Question removed"),
        };
      },
      { danger: true },
    );

  const top = h(
    "div",
    { class: "q-head" },
    h("a", { href: `#/list?lane=${q.status === "withdrawn" ? "withdrawn" : ENDED.includes(q.status) ? "ended" : "current"}`, class: "back" }, "← Back"),
    h("h1", null, q.title),
    h(
      "div",
      { class: "row" },
      questionPill(q),
      canEdit() && !q.removed_at ? [h("button", { class: "link", onclick: () => openForm(editForm()) }, "Edit"), h("button", { class: "link danger-link", onclick: () => openForm(removeForm()) }, "Remove…")] : null,
    ),
    q.removed_at
      ? h(
          "div",
          { class: "removed-banner" },
          h("strong", null, "Removed"),
          " ",
          time(q.removed_at, timeAgo(q.removed_at)),
          ". It's hidden from lists and its process is no longer refreshed.",
          canEdit() ? [" ", h("button", { onclick: async () => (await act(() => api("POST", `questions/${q.id}/restore`), "Restored")) && refresh() }, "Restore")] : null,
        )
      : null,
    q.why_it_matters ? h("p", { class: "why" }, q.why_it_matters) : null,
    h("dl", { class: "meta" }, h("dt", null, "Added"), h("dd", null, q.created_by, " · ", time(q.created_at))),
  );

  // A dropped link becomes this question's process, when it has none yet.
  if (canEditQ(q) && !q.process) onLinkDrop = (url) => openForm(attachForm(q, false, url));

  return h(
    "div",
    { class: "question" },
    top,
    q.removed_at ? null : statusBlock(q, openForm),
    processBlock(q, d, openForm),
    formSlot,
    relationsBlock(q, d),
    h("section", { class: "panel" }, h("h2", null, "History"), h("ul", { class: "activity" }, d.activity.map((e) => activityItem(e)))),
  );
}

/** Select of the space's status labels (value = label), grouped by category. */
function labelSelect(current) {
  const labels = S.space.settings.status_labels;
  return h(
    "select",
    { required: true },
    QUESTION_STATES.filter((s) => labels.some((l) => l.state === s)).map((s) =>
      h("optgroup", { label: STATE[s] }, labels.filter((l) => l.state === s).map((l) => h("option", { value: l.label, selected: l.label === current }, l.label))),
    ),
  );
}

function statusBlock(q, openForm) {
  const follows = q.status_source === "process";
  const manualForm = () =>
    inlineForm("Set the status by hand", "Set status", () => {
      const select = labelSelect(q.status_label);
      const note = h("input", { type: "text", maxlength: 1000, placeholder: "Optional: why (shown in the history)" });
      return {
        body: [
          field("Status", select, "The space's status labels, grouped by category. They're edited on the Rules page."),
          field("Note", note),
          q.process ? h("p", { class: "muted small" }, "The status stops following the process until you switch back.") : null,
        ],
        submit: () => act(() => api("PUT", `questions/${q.id}/status`, { source: "manual", label: select.value, note: note.value }), "Status set"),
      };
    });
  const follow = async () => (await act(() => api("PUT", `questions/${q.id}/status`, { source: "process" }), "Status follows the process")) && refresh();
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Status"),
    h(
      "p",
      null,
      questionPill(q),
      " ",
      h("span", { class: "muted" }, follows ? `${STATE[q.status]} · follows the process` : `${q.status_label && q.status_label !== STATE[q.status] ? `${STATE[q.status]} · ` : ""}set by hand`),
    ),
    h("p", { class: "muted small" }, STATE_HINT[q.status]),
    canEdit()
      ? h(
          "div",
          { class: "row" },
          h("button", { onclick: () => openForm(manualForm()) }, follows ? "Set by hand instead…" : "Change status…"),
          !follows && q.process ? h("button", { onclick: follow }, "Follow the process") : null,
        )
      : null,
  );
}

/** Link a process: a link from a listed tool, or a custom process described by hand. */
function attachForm(q, replace, prefillUrl) {
  return inlineForm(replace ? "Replace the process" : "Link a process", replace ? "Replace" : "Link", () => {
    const p = q.process;
    const isCustom = p?.tool_id === CUSTOM_TOOL_ID;
    const name = `kind-${Math.random().toString(36).slice(2)}`;
    let kind = isCustom ? "custom" : "link";
    const url = h("input", { type: "url", placeholder: "https://…", value: prefillUrl ?? (!isCustom && p?.url ? p.url : "") });
    const cKind = h("input", { type: "text", maxlength: 60, placeholder: "e.g. Meeting, Unconference, Paper survey", value: isCustom ? p.item_type : "", list: `${name}-kinds` });
    const usedKinds = (S.custom_kinds ?? []).map((k) => k.kind);
    const kinds = h("datalist", { id: `${name}-kinds` }, [...new Set([...usedKinds, "Meeting", "General assembly", "Unconference", "Workshop", "Survey", "Working group"])].map((k) => h("option", { value: k })));
    const cTitle = h("input", { type: "text", maxlength: 300, placeholder: "Optional, e.g. Spring general assembly", value: isCustom ? (p.fetched?.title ?? "") : "" });
    const cUrl = h("input", { type: "url", placeholder: "Optional: https://… (notes, event page)", value: isCustom ? (p.url ?? "") : "" });
    const cWhen = h("input", { type: "datetime-local", value: isCustom && p.fetched?.dates?.opens_at ? toLocalInput(p.fetched.dates.opens_at) : "" });
    const framing = h("textarea", { rows: 2, placeholder: "Optional", value: p?.framing ?? "" });
    const linkBox = h("div", null, field("Link", url), toolHints());
    const customBox = h("div", null, field("Kind of process", cKind), kinds, field("Title", cTitle), field("When", cWhen), field("Link", cUrl), h("p", { class: "muted small" }, "Its state is set by hand, using the space's status labels."));
    const sync = () => ((linkBox.hidden = kind !== "link"), (customBox.hidden = kind !== "custom"), (url.required = kind === "link"), (cKind.required = kind === "custom"));
    sync();
    const radio = (v, label) => h("label", null, h("input", { type: "radio", name, value: v, checked: kind === v, onchange: () => ((kind = v), sync()) }), " ", label);
    return {
      body: [
        h("div", { class: "radios" }, radio("link", "A link from a listed tool"), radio("custom", "Custom: a meeting, an unconference… (link optional)")),
        linkBox,
        customBox,
        field("Framing", framing, "How this process interprets the question, and its limits."),
      ],
      submit: async () => {
        const body =
          kind === "custom"
            ? { custom: { kind: cKind.value, title: cTitle.value, url: cUrl.value, when: fromLocalInput(cWhen.value) }, framing: framing.value }
            : { url: url.value, framing: framing.value };
        try {
          await api("PUT", `questions/${q.id}/process`, body);
          toast("Process linked", "ok");
          return true;
        } catch (e) {
          if (e.code === "unknown_tool") {
            toast("That link isn't from a listed tool. Add the tool, or use a custom process.", "error");
            location.hash = `#/rules/add-tool${qs({ url: url.value })}`;
            return false;
          }
          throw e;
        }
      },
    };
  });
}

/** The enabled tools and what each is useful for, folded under their names. */
function toolHints() {
  const tools = S.tools.filter((t) => t.enabled);
  return h(
    "details",
    { class: "tool-hints hint" },
    h("summary", null, `Tools on the list: ${tools.map((t) => t.name).join(", ")}`),
    h("ul", null, tools.map((t) => h("li", null, h("strong", null, t.name), t.description ? ` — ${t.description}` : null))),
  );
}

/** Hand-set process states: the tool's own states, or the space's status labels for custom processes. */
function manualStateForm(q, tool) {
  const f = q.process.fetched;
  return inlineForm("Update the process state", "Save", () => {
    const custom = q.process.tool_id === CUSTOM_TOOL_ID;
    const states = custom ? S.space.settings.status_labels.map((l) => [l.label, l.state]) : tool?.state_map ? Object.entries(tool.state_map) : [];
    const select = h(
      "select",
      { required: true },
      h("option", { value: "" }, "Choose…"),
      states.map(([label, st]) => h("option", { value: `${st}|${label}`, selected: f?.raw_state === label }, `${label} (${STATE[st]})`)),
      h("optgroup", { label: "Categories" }, QUESTION_STATES.map((st) => h("option", { value: `${st}|`, selected: !states.length && f?.state === st }, STATE[st]))),
    );
    const summary = h("input", { type: "text", maxlength: 300, value: f?.outcome_summary ?? "", placeholder: "e.g. 63% yes, 41 votes" });
    const results = h("input", { type: "url", value: f?.extra?.results_url ?? "", placeholder: "https://… (report, minutes, results page)" });
    return {
      body: [field("State", select), field("Summary", summary, "Optional, shown on cards."), field("Link to results", results, "Optional.")],
      submit: () => {
        const [state, raw] = select.value.split("|");
        return act(() => api("POST", `questions/${q.id}/process/manual`, { state, raw_state: raw || undefined, outcome_summary: summary.value, results_url: results.value }), "State updated");
      },
    };
  });
}

function processBlock(q, d, openForm) {
  const p = q.process;
  if (!p) {
    return h(
      "section",
      { class: "panel" },
      h("h2", null, "Process"),
      h("p", { class: "muted" }, "No process linked. A process is where the question is worked on: a pull request, a poll, a Polis conversation, a meeting…"),
      canEditQ(q) ? h("button", { onclick: () => openForm(attachForm(q, false)) }, "Link a process…") : null,
    );
  }
  const f = p.fetched;
  const tool = d.tool;
  const hasState = f && f.state !== "unknown";
  const extra = f?.extra ? Object.entries(f.extra).filter(([k]) => k !== "results_url" && k !== "outcome") : [];
  const refreshBtn = h(
    "button",
    {
      onclick: async () => {
        const r = await act(() => api("POST", `questions/${q.id}/process/refresh`));
        if (!r) return;
        toast(r.refresh?.error ? `Refresh failed: ${r.refresh.error}` : r.refresh?.skipped ? `Not refreshed: ${r.refresh.skipped}` : r.refresh?.changed ? "State changed" : "No change", r.refresh?.error ? "error" : "ok");
        await refresh();
      },
    },
    "↻ Refresh",
  );
  const framingForm = () =>
    inlineForm("Edit framing", "Save", () => {
      const t = h("textarea", { rows: 3, value: p.framing ?? "" });
      return { body: field("Framing", t, "How this process interprets the question, and its limits."), submit: () => act(() => api("PATCH", `questions/${q.id}/process`, { framing: t.value }), "Saved") };
    });
  const remove = async () => {
    if (!confirm("Remove the linked process? The question keeps its current status, set by hand.")) return;
    if (await act(() => api("DELETE", `questions/${q.id}/process`), "Process removed")) await refresh();
  };
  return h(
    "section",
    { class: "panel process" },
    h("h2", null, "Process"),
    h("p", null, h("strong", null, processKind(p, S.tools)), f?.title || p.url ? " · " : "", p.url ? extLink(p.url, f?.title ?? "open the link ↗") : (f?.title ?? "")),
    h(
      "dl",
      { class: "meta" },
      h("dt", null, "State"),
      h("dd", null, hasState ? [statePill(f.state, f.raw_state), " ", h("span", { class: "muted" }, STATE[f.state]), f.outcome_summary ? h("div", null, f.outcome_summary) : ""] : h("span", { class: "muted" }, "not set yet")),
      f?.extra?.outcome ? [h("dt", null, "Outcome"), h("dd", null, String(f.extra.outcome))] : null,
      f?.dates?.opens_at ? [h("dt", null, p.tool_id === CUSTOM_TOOL_ID ? "When" : "Opened"), h("dd", null, time(f.dates.opens_at))] : null,
      f?.dates?.closes_at ? [h("dt", null, "Closes"), h("dd", null, time(f.dates.closes_at))] : null,
      f?.dates?.resolved_at ? [h("dt", null, "Ended"), h("dd", null, time(f.dates.resolved_at))] : null,
      f?.dates?.updated_at ? [h("dt", null, "Last activity"), h("dd", null, time(f.dates.updated_at, timeAgo(f.dates.updated_at)), h("span", { class: "muted" }, " (on the platform)"))] : null,
      extra.length ? [h("dt", null, "Details"), h("dd", null, extra.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · "))] : null,
      f?.extra?.results_url ? [h("dt", null, "Results"), h("dd", null, extLink(String(f.extra.results_url)))] : null,
      p.framing ? [h("dt", null, "Framing"), h("dd", null, p.framing)] : null,
      h("dt", null, p.fetch_mode === "auto" ? "Last checked" : "Updated"),
      h("dd", null, f && (p.fetch_mode === "auto" || hasState) ? time(f.fetched_at, timeAgo(f.fetched_at)) : "never", p.fetch_mode === "manual" ? h("span", { class: "muted" }, " · updated by hand") : ""),
      f?.fetch_error ? [h("dt", null, "Problem"), h("dd", { class: "warn" }, f.fetch_error, p.fetch_mode === "manual" ? " — update the state by hand." : "")] : null,
      tool && !tool.enabled ? [h("dt", null, "Note"), h("dd", { class: "warn" }, "This tool is disabled; the state is no longer refreshed.")] : null,
    ),
    canEditQ(q)
      ? h(
          "div",
          { class: "row" },
          p.fetch_mode === "auto" ? refreshBtn : h("button", { onclick: () => openForm(manualStateForm(q, tool)) }, "Update state…"),
          h("button", { onclick: () => openForm(framingForm()) }, "Edit framing"),
          h("button", { onclick: () => openForm(attachForm(q, true)) }, p.tool_id === CUSTOM_TOOL_ID ? "Edit / replace…" : "Replace…"),
          h("button", { class: "danger-link", onclick: remove }, "Remove"),
        )
      : null,
  );
}

function relationsBlock(q, d) {
  const editable = canEditQ(q);
  const unrelate = (x) => async () => {
    if (await act(() => api("DELETE", `questions/${q.id}/related/${x.id}`), "Relation removed")) await refresh();
  };
  const kindSel = h("select", { "aria-label": "Kind of relation" }, h("option", { value: "related" }, "Related to"), h("option", { value: "duplicate" }, "This question is a duplicate of"));
  const relate = async (x) => {
    if (await act(() => api("POST", `questions/${q.id}/related`, { id: x.id, kind: kindSel.value }), kindSel.value === "duplicate" ? "Marked as duplicate" : "Related")) await refresh();
  };
  const kindText = (x) => (x.kind === "duplicate" ? (x.direction === "to" ? "this is a duplicate of" : "duplicate of this") : null);
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Related questions"),
    d.related.length
      ? h(
          "ul",
          { class: "rel-list" },
          d.related.map((x) =>
            h(
              "li",
              null,
              kindText(x) ? h("span", { class: "muted small" }, kindText(x), ": ") : null,
              h("a", { href: `#/q/${x.id}` }, x.title),
              " ",
              statusPill(x.status),
              editable ? [" ", h("button", { class: "link muted small", title: "Remove this relation (both questions stay)", onclick: unrelate(x) }, "unlink")] : null,
            ),
          ),
        )
      : h("p", { class: "muted" }, "None yet."),
    editable ? h("div", { class: "row" }, kindSel) : null,
    editable
      ? composer({ relateTo: q.id, exclude: new Set(d.related.map((x) => x.id)), onRelate: relate, kind: () => kindSel.value, placeholder: "Type to find a question, or add a new one…" })
      : null,
  );
}

// ---------------------------------------------------------------- rules

async function pageRules(sub, params) {
  if (sub === "add-tool") return toolFormPage({ url: params.get("url") });
  if (sub === "tool") {
    const tool = S.tools.find((t) => t.id === params.get("id"));
    if (!tool) throw new Error("Unknown tool");
    return toolFormPage({ tool });
  }
  const updates = (t) => (t.fetch_mode === "auto" ? "automatic" : t.auto_unavailable ? "by hand (automatic needs server setup)" : "by hand");
  const used = (u, href) =>
    u?.questions ? h("a", { href }, `${u.questions} question${u.questions === 1 ? "" : "s"}`, u.in_progress ? ` · ${u.in_progress} in progress` : "") : h("span", { class: "muted" }, "—");
  const customKinds = S.custom_kinds ?? [];
  return h(
    "div",
    { class: "rules" },
    h("h1", null, "Rules"),
    h("p", null, "How this register works: the charter, the tools that can be linked and the status labels."),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Tool list"),
      h("p", { class: "muted" }, "Links from these tools can be attached as processes. Anything else can be linked as a custom process. Anyone with edit access can add a tool; no vote needed."),
      canEdit() ? h("p", null, h("a", { class: "button", href: "#/rules/add-tool" }, "Add a tool")) : null,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Links accepted"), h("th", null, "Updates"), h("th", null, "Used by"), h("th", null, "Status"), canEdit() ? h("th", null) : null)),
          h(
            "tbody",
            null,
            S.tools.map((t) =>
              h(
                "tr",
                { class: t.enabled ? "" : "disabled" },
                h("td", null, h("strong", null, t.name), t.description ? h("div", { class: "muted small" }, t.description) : null),
                h("td", null, t.url_patterns.map((p) => h("div", null, h("code", null, p.pattern), " → ", itemLabel(p.item_type)))),
                h("td", null, updates(t)),
                h("td", null, used(t.usage, `#/list${qs({ lane: "all", tool: t.id })}`)),
                h("td", null, t.enabled ? "enabled" : "disabled"),
                canEdit()
                  ? h(
                      "td",
                      null,
                      h("a", { class: "link", href: `#/rules/tool${qs({ id: t.id })}` }, "Edit"),
                      " · ",
                      h("button", { class: "link", onclick: async () => (await act(() => api("POST", `tools/${t.id}/enabled`, { enabled: !t.enabled }), t.enabled ? "Tool disabled" : "Tool enabled")) && refresh() }, t.enabled ? "Disable" : "Enable"),
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
    customKinds.length
      ? h(
          "section",
          { class: "panel" },
          h("h2", null, "Custom processes in use"),
          h("p", { class: "muted" }, "Processes described by hand (meetings, assemblies…), by kind. Offered as suggestions when linking a custom process."),
          h("ul", { class: "rel-list" }, customKinds.map((k) => h("li", null, h("strong", null, k.kind), " · ", used(k, `#/list${qs({ lane: "all", tool: CUSTOM_TOOL_ID, item_type: k.kind })}`)))),
        )
      : null,
    statusLabelsPanel(),
    S.counts.removed ? await removedPanel() : null,
    h("section", { class: "panel charter" }, renderMarkdown(S.space.charter_markdown)),
    h("section", { class: "panel" }, h("h2", null, "Export"), h("p", null, "Download everything in this space (questions, processes, relations, tools, charter and the full activity log) as JSON."), h("button", { onclick: downloadExport }, "Download export")),
  );
}

async function removedPanel() {
  const { questions } = await api("GET", "questions?removed=only");
  return h(
    "section",
    { class: "panel" },
    h("h2", null, `Removed questions (${questions.length})`),
    h("p", { class: "muted" }, "Hidden from lists, kept in the history. Restoring brings a question back as it was."),
    h(
      "ul",
      { class: "rel-list" },
      questions.map((q) =>
        h(
          "li",
          null,
          h("a", { href: `#/q/${q.id}` }, q.title),
          " ",
          h("span", { class: "muted small" }, "removed ", time(q.removed_at, timeAgo(q.removed_at))),
          canEdit() ? [" · ", h("button", { class: "link", onclick: async () => (await act(() => api("POST", `questions/${q.id}/restore`), "Restored")) && refresh() }, "Restore")] : null,
        ),
      ),
    ),
  );
}

function statusLabelsPanel() {
  const labels = S.space.settings.status_labels;
  const table = h(
    "table",
    null,
    h("thead", null, h("tr", null, h("th", null, "Category"), h("th", null, "Labels"))),
    h("tbody", null, QUESTION_STATES.map((s) => h("tr", null, h("td", null, statusPill(s), h("div", { class: "muted small" }, STATE_HINT[s])), h("td", null, labels.filter((l) => l.state === s).map((l) => l.label).join(", ") || h("span", { class: "muted" }, "—"))))),
  );
  const editForm = () => {
    const ed = mappingEditor(labels, { labelName: "Label", placeholder: "e.g. Waiting for budget" });
    const btn = h("button", { type: "submit", class: "primary" }, "Save labels");
    const form = h(
      "form",
      {
        class: "inline-form",
        onsubmit: async (e) => {
          e.preventDefault();
          let status_labels;
          try {
            status_labels = ed.value();
          } catch (err) {
            return toast(err.message, "error");
          }
          btn.disabled = true;
          const r = await act(() => api("PUT", "settings/status-labels", { status_labels }), "Labels saved");
          btn.disabled = false;
          if (r) await refresh();
        },
      },
      h("p", { class: "muted small" }, "The words your group uses for a status, and the category each one counts as. Offered when setting a status by hand, and for custom processes. Keep at least one “Not started” label: new questions get the first one. Renaming a label doesn't change questions that already use it."),
      ed.el,
      h("div", { class: "row" }, btn, h("button", { type: "button", onclick: () => form.replaceWith(editBtn) }, "Cancel")),
    );
    return form;
  };
  const editBtn = canEdit() ? h("button", { onclick: () => editBtn.replaceWith(editForm()) }, "Edit labels…") : null;
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Statuses"),
    h("p", { class: "muted" }, "Every question and process is in one of these categories. A question follows its process, or its status is set by hand using these labels (also used for custom processes)."),
    h("div", { class: "table-wrap" }, table),
    editBtn,
  );
}

async function downloadExport() {
  const data = await act(() => api("GET", "export"));
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `${S.space.name.replace(/[^\w-]+/g, "_")}-export-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

/** Add a tool, or edit one when `tool` is given (automatic tools: only the name and description). */
function toolFormPage({ url, tool }) {
  const auto = !!tool?.adapter;
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {}
  const name = h("input", { type: "text", required: true, maxlength: 60, value: tool ? tool.name : host.replace(/^www\./, "") });
  const patterns = h("textarea", { rows: 3, required: true, value: tool ? tool.url_patterns.map((p) => `${p.pattern} → ${p.item_type}`).join("\n") : host ? `https://${host}/* → item` : "" });
  const states = mappingEditor(
    tool?.state_map ? Object.entries(tool.state_map).map(([label, state]) => ({ label, state })) : [{ label: "Open", state: "open" }, { label: "Closed", state: "concluded" }],
    { labelName: "The tool's own word", placeholder: "e.g. Closed: passed" },
  );
  const tester = h("input", { type: "url", value: url ?? "", placeholder: "Paste an example link to check the patterns" });
  const testOut = h("span", { class: "hint" });
  const parsePatterns = () =>
    linesToList(patterns.value).map((l) => {
      const [pattern, item] = l.split(/\s*(?:→|->)\s*/);
      if (!item) throw new Error(`Add an item type after the pattern, like: ${pattern} → topic`);
      return { pattern: pattern.trim(), item_type: item.trim() };
    });
  const test = () => {
    if (!tester.value) return (testOut.textContent = "");
    if (typeof URLPattern === "undefined") return (testOut.textContent = "Your browser can't check patterns; the server will.");
    try {
      const hit = parsePatterns().find((p) => new URLPattern(p.pattern).test(tester.value));
      testOut.textContent = hit ? `✔ Matches (${hit.item_type})` : "✕ Doesn't match any pattern";
    } catch (e) {
      testOut.textContent = `✕ ${e.message}`;
    }
  };
  tester.addEventListener("input", test);
  patterns.addEventListener("input", test);
  queueMicrotask(test);
  const description = h("textarea", { rows: 2, maxlength: 400, value: tool?.description ?? "", placeholder: "e.g. Decisions that need everyone's consent: proposals and votes" });
  const btn = h("button", { type: "submit", class: "primary" }, tool ? "Save tool" : "Add tool");
  // Adding: a tool updated by hand (patterns + states), or an instance of a platform we can fetch.
  let kind = !tool && url && /\/(proposals|debates|budgets)\/\d+/.test(url) ? "consul" : "manual";
  const baseUrl = h("input", { type: "url", placeholder: "https://participa.example.org", value: host ? `https://${host}` : "" });
  const manualBox = h(
    "div",
    null,
    field("Links accepted", patterns, "One per line: URL pattern → item type. Use :name for one path part and * for anything, e.g. https://forum.example.org/t/* → topic"),
    field("Check a link", tester),
    testOut,
    h(
      "div",
      { class: "field" },
      h("span", { class: "label" }, "States"),
      h(
        "span",
        { class: "hint" },
        "How this tool names its states, and the category each one counts as. When someone updates a linked item by hand, they pick from these words; the question's status then follows the category. Example for a forum: “Open” → In progress, “Solved” → Accepted, “Closed” → Concluded.",
      ),
      states.el,
    ),
  );
  const consulBox = h(
    "div",
    null,
    field("Instance address", baseUrl, "The home page of your city's or organisation's Consul Democracy site. Proposals, debates, budgets and investments from it are then fetched automatically."),
    h("p", { class: "muted small" }, "Decidim needs no setup: links from any Decidim instance are recognised already."),
  );
  if (auto) kind = "auto";
  const syncKind = () => {
    manualBox.hidden = kind !== "manual";
    consulBox.hidden = kind !== "consul";
    patterns.required = kind === "manual";
    baseUrl.required = kind === "consul";
    name.required = kind !== "consul";
    name.placeholder = kind === "consul" ? "Optional, e.g. Decide Madrid" : "";
    if (kind === "consul" && name.value === host.replace(/^www\./, "")) name.value = "";
  };
  syncKind();
  const kindName = `toolkind-${Math.random().toString(36).slice(2)}`;
  const kindRadio = (v, label) => h("label", null, h("input", { type: "radio", name: kindName, value: v, checked: kind === v, onchange: () => ((kind = v), syncKind()) }), " ", label);
  return h(
    "div",
    null,
    h("a", { href: "#/rules", class: "back" }, "← Rules"),
    h("h1", null, tool ? `Edit “${tool.name}”` : "Add a tool"),
    h(
      "p",
      null,
      auto
        ? `${tool.name} is followed automatically: its links and states come with it. You can rename it and say what your group uses it for.`
        : tool
        ? "Changes apply right away. Links already attached stay with this tool; their recorded state is kept even if you rename or remove a state label."
        : "Tools updated by hand work with any website: anyone with edit access sets the state, and the page title prefills questions when possible. Some platforms can be followed automatically.",
    ),
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          const done = async (r) => {
            btn.disabled = false;
            if (r) {
              await loadSpace();
              location.hash = "#/rules";
            }
          };
          if (auto) {
            btn.disabled = true;
            return done(await act(() => api("PATCH", `tools/${tool.id}`, { name: name.value, description: description.value }), "Tool saved"));
          }
          if (kind === "consul") {
            btn.disabled = true;
            return done(await act(() => api("POST", "tools", { kind: "consul", base_url: baseUrl.value, name: name.value || undefined, description: description.value || undefined }), "Tool added"));
          }
          const state_map = {};
          let url_patterns;
          try {
            url_patterns = parsePatterns();
            for (const r of states.value()) state_map[r.label] = r.state;
          } catch (err) {
            return toast(err.message, "error");
          }
          btn.disabled = true;
          const body = { name: name.value, description: description.value, url_patterns, state_map };
          return done(await act(() => (tool ? api("PATCH", `tools/${tool.id}`, body) : api("POST", "tools", body)), tool ? "Tool saved" : "Tool added"));
        },
      },
      tool ? null : h("div", { class: "radios" }, kindRadio("manual", "Any website, updated by hand"), kindRadio("consul", "A Consul Democracy instance (followed automatically)")),
      field("Tool name", name),
      field("What is it useful for?", description, "Optional. Shown in the tool list and when someone links a process, to help pick the right tool."),
      manualBox,
      consulBox,
      h("div", { class: "row" }, btn),
    ),
  );
}

// ---------------------------------------------------------------- activity

async function pageActivity() {
  const [{ activity }, { questions }] = await Promise.all([api("GET", "activity?limit=100"), api("GET", "questions")]);
  const titles = new Map(questions.map((q) => [q.id, q.title]));
  const list = h("ul", { class: "activity" }, activity.map((e) => activityItem(e, titles)));
  let last = activity.at(-1)?.id;
  const more = h(
    "button",
    {
      hidden: activity.length < 100,
      onclick: async () => {
        const r = await act(() => api("GET", `activity?limit=100&before=${last}`));
        if (!r) return;
        list.append(...r.activity.map((e) => activityItem(e, titles)));
        last = r.activity.at(-1)?.id;
        if (r.activity.length < 100) more.hidden = true;
      },
    },
    "Load more",
  );
  return h(
    "div",
    null,
    h("h1", null, "Activity"),
    h("p", { class: "muted" }, "Every change in this space, newest first. The log can't be edited."),
    S.role === "view"
      ? h("p", null, "Subscribe in a feed reader: ", h("a", { href: `/feed/${TOKEN}.atom` }, "Atom feed"), h("span", { class: "muted small" }, " (contains this view link: share with care)"))
      : h("p", { class: "muted small" }, "An Atom feed is available from the view link (open the space with it and come back here)."),
    h("section", { class: "panel" }, list, more),
  );
}

boot();
