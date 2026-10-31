// Question register — single-page UI. Hash routes:
//   #/dashboard              summary widgets (the space name in the header links here)
//   #/list?lane=current&q=…  the items, as a list or (view=timeline) as bars over time; lanes, search, filters
//   #/q/<id>                 question page
//   #/rules                  tools (tool list, status labels); #/rules/add-tool?url=…; #/rules/tool?id=… (edit)
//   #/how                    how this works (the charter)
//   #/timeline?…             old link: the items' timeline view
//   #/activity               activity feed
// No tabs: the space name opens the items, the menu (top right) has Dashboard, Tools, Activity, How this works, Export.
import { api, qs, getName, setName, TOKEN, ApiError } from "./api.js";
import { h, extLink, fmtDate, time, timeAgo, toast, debounce } from "./dom.js";
import { STATE, STATE_HINT, QUESTION_STATES, ENDED, CUSTOM_TOOL_ID, ROLE, RELATE_AS, itemLabel } from "./labels.js";
import { statusPill, questionPill, statePill, questionTree, questionCard, activityItem, mappingEditor } from "./components.js";
import { renderMarkdown } from "./md.js";
import { fieldCell, createFields, retrievedFromPreview, FIELD_LABEL } from "./fields.js";
import { timelineChart } from "./timeline.js";
import { dashboardPage } from "./dashboard.js";

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
  // The menu closes on a click elsewhere, or Escape.
  document.addEventListener("click", (e) => !e.target.closest?.(".menu") && closeMenus());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".menu-list:not([hidden])");
    closeMenus();
    open?.parentElement.querySelector(".menu-btn").focus();
  });
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
  let { parts, params } = parseHash();
  // The timeline is a view of the items page.
  if (parts[0] === "timeline") (params.set("view", "timeline"), (parts = ["list"]));
  onLinkDrop = null;
  let view;
  try {
    if (parts[0] === "q" && parts[1]) view = await pageQuestion(parts[1]);
    else if (parts[0] === "rules") view = await pageRules(parts[1], params);
    else if (parts[0] === "activity") view = await pageActivity();
    else if (parts[0] === "how") view = pageHow();
    else if (parts[0] === "dashboard") view = await pageDashboard();
    else view = await pageHome(params);
  } catch (e) {
    view = h("div", { class: "panel error" }, h("h2", null, "Something went wrong"), h("p", null, e.message));
  }
  if (seq !== renderSeq) return;
  app.replaceChildren(header(parts[0] ?? "list"), h("main", { id: "main" }, view));
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

function header(section) {
  const item = (key, label) => h("a", { href: `#/${key}`, role: "menuitem", "aria-current": section === key ? "page" : null, onclick: closeMenus }, label);
  const list = h(
    "div",
    { class: "menu-list", role: "menu", hidden: true },
    item("dashboard", "Dashboard"),
    item("rules", "Tools"),
    item("activity", "Activity"),
    item("how", "How this works"),
    h("button", { type: "button", role: "menuitem", onclick: () => (closeMenus(), downloadExport()) }, "Export"),
  );
  const button = h(
    "button",
    {
      type: "button",
      class: "menu-btn",
      "aria-label": "Menu",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: () => {
        const wasClosed = list.hidden;
        closeMenus();
        if (wasClosed) (list.hidden = false, button.setAttribute("aria-expanded", "true"));
      },
    },
    h("span", { class: "burger", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
  );
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-row" },
      h("a", { href: "#/list", class: "space-name", title: "Items" }, S.space.name),
      h(
        "div",
        { class: "who" },
        S.role === "view" ? h("span", { class: "badge" }, "View only") : null,
        canEdit() ? h("button", { class: "link", onclick: () => askName(), title: "Change your display name" }, h("span", { "aria-hidden": "true" }, "✎ "), h("strong", null, getName() || "?")) : null,
        h("div", { class: "menu" }, button, list),
      ),
    ),
  );
}

/** Close the menu (all of them: there is one). */
function closeMenus() {
  for (const m of document.querySelectorAll(".menu")) {
    m.querySelector(".menu-list").hidden = true;
    m.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
  }
}
const backToItems = () => h("a", { href: "#/list", class: "back" }, "← Items");

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

/**
 * Search, lanes, view toggle and filters of the items page, for both views ("list" or "timeline").
 * The default lane (no lane chosen, nothing searched) is Current for the list, All for the timeline.
 */
function listControls(params, view) {
  const route = "list";
  const defaultLane = view === "timeline" ? "all" : "current";
  const sort = view === "list";
  const searching = FILTER_KEYS.some((k) => params.get(k));
  const lane = params.get("lane") ?? (searching ? "all" : defaultLane);
  const query = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k)]));
  query.status = params.get("status") || (LANES[lane]?.status ?? "");
  if (sort) query.sort = params.get("sort");
  // Children under their parent, unless asked for a flat list (`flat=1`).
  const hierarchy = params.get("flat") !== "1";
  if (hierarchy) query.hierarchy = "1";

  const setParam = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    location.hash = `#/${route}?${p}`;
  };

  const searchInput = h("input", { type: "search", placeholder: "Search questions…", value: params.get("q") ?? "", "aria-label": "Search questions" });
  const searchForm = h("form", { class: "search", role: "search", onsubmit: (e) => (e.preventDefault(), setParam("q", searchInput.value.trim())) }, searchInput, h("button", { type: "submit", class: "search-btn", "aria-label": "Search", title: "Search", onclick: (e) => { if (!searchInput.value.trim() && params.get("q") == null) (e.preventDefault(), searchInput.focus()); } }, "🔍"));

  const sel = (key, label, options, anyLabel = "Any", value = params.get(key) ?? "") =>
    field(
      label,
      h(
        "select",
        { onchange: (e) => setParam(key, e.target.value) },
        anyLabel ? h("option", { value: "" }, anyLabel) : null,
        options.map(([v, l]) => h("option", { value: v, selected: value === v }, l)),
      ),
    );
  const itemTypes = [...new Set([...S.tools.flatMap((t) => t.url_patterns.map((p) => p.item_type)), ...(S.custom_kinds ?? []).map((k) => k.kind)])];
  const presets = h(
    "div",
    { class: "presets", role: "group", "aria-label": "Shortcuts" },
    PRESETS.map(([k, l]) => h("button", { type: "button", class: `chip-btn${params.get("preset") === k ? " on" : ""}`, "aria-pressed": params.get("preset") === k ? "true" : "false", onclick: () => setParam("preset", params.get("preset") === k ? "" : k) }, l)),
  );
  const filters = h(
    "details",
    { class: "filters", open: ["preset", "status", "tool", "state", "source", "has_process", "item_type", "sort", "flat"].some((k) => params.get(k)) },
    h("summary", null, "Filters"),
    presets,
    h(
      "div",
      { class: "filter-grid" },
      sel("status", "Status", QUESTION_STATES.map((s) => [s, STATE[s]])),
      sel("source", "Status is", [["retrieved", "Retrieved"], ["typed", "Typed"]]),
      sel("tool", "Tool", [[CUSTOM_TOOL_ID, "Custom process"], ...S.tools.map((t) => [t.id, t.name])]),
      sel("item_type", "Item type", itemTypes.map((t) => [t, itemLabel(t)])),
      sel("state", "Process state", Object.entries(STATE)),
      sel("has_process", "Has a process", [["yes", "Yes"], ["no", "No"]]),
      sort ? sel("sort", "Order", [["", "Latest activity first"], ["created", "Newest first"]], null) : null,
      sel("flat", "Children", [["", "Under their parent"], ["1", "Listed apart (flat)"]], null),
    ),
  );
  const relatedChip = params.get("related") ? h("p", null, "Showing questions related to another · ", h("a", { href: `#/q/${params.get("related")}` }, "open it"), " · ", h("button", { class: "link", onclick: () => setParam("related", "") }, "clear")) : null;
  // Lanes with counts, beside the search (the same on the list and the timeline). Withdrawn is the Status filter.
  const c = S.counts ?? {};
  const n = (states) => states.reduce((a, s) => a + (c[s] ?? 0), 0);
  const laneNav = h(
    "nav",
    { class: "sublanes", "aria-label": "Lanes" },
    [
      ["current", `Current (${n(["not_started", "open"])})`],
      ["ended", `Ended (${n(ENDED)})`],
      ["all", "All"],
    ].map(([k, label]) => {
      const p = new URLSearchParams(params);
      p.set("lane", k);
      p.delete("status");
      return h("a", { href: `#/${route}?${p}`, class: `sublane${lane === k ? " current" : ""}`, "aria-current": lane === k ? "page" : null }, label);
    }),
  );
  // The same filters, shown the other way: two symbols, the current view selected.
  const viewBtn = (v, label) => {
    const p = new URLSearchParams(params);
    if (!p.get("lane")) p.set("lane", lane);
    if (v === "list") p.delete("view");
    else (p.set("view", "timeline"), p.delete("sort"));
    return h("a", { href: `#/list?${p}`, class: `view-btn${view === v ? " current" : ""}`, title: label, "aria-label": label, "aria-current": view === v ? "true" : null }, h("span", { class: `ico ico-${v}`, "aria-hidden": "true" }, h("i"), h("i"), h("i")));
  };
  const viewToggle = h("div", { class: "view-toggle", role: "group", "aria-label": "View" }, viewBtn("list", "Show as a list"), viewBtn("timeline", "Show on a timeline"));
  return { searching, lane, query, hierarchy, controls: [h("div", { class: "toolbar" }, searchForm, viewToggle, laneNav), filters, relatedChip] };
}

async function pageHome(params) {
  const view = params.get("view") === "timeline" ? "timeline" : "list";
  const { searching, lane, query, hierarchy, controls } = listControls(params, view);
  let body;
  if (view === "list") {
    const { questions } = await api("GET", `questions${qs(query)}`);
    const ctx = { tools: S.tools, since: S.since, space: S.space, hierarchy };
    body = questions.length
      ? h("ul", { class: "cards" }, hierarchy ? questionTree(questions, ctx) : questions.map((q) => questionCard(q, ctx)))
      : h("p", { class: "empty" }, searching ? "No questions match." : lane === "current" ? "No current questions. Add one above." : "Nothing here yet.");
  } else {
    // The questions with a start date as bars over time, to their end (or today).
    const { items, undated, now } = await api("GET", `timeline${qs(query)}`);
    const undatedNote = undated
      ? h("p", { class: "muted small" }, `${undated} question${undated === 1 ? " has" : "s have"} no start date and ${undated === 1 ? "isn't" : "aren't"} shown. Dates come from the linked process, or can be set on each question.`)
      : null;
    body = [
      h("p", { class: "muted small" }, "Each question with a start date, from its start to its end (or today if it's still running). Hover a bar for its dates."),
      items.length ? h("section", { class: "panel" }, timelineChart(items, now)) : h("p", { class: "empty" }, searching ? "No dated questions match." : "No question has a start date yet."),
      undatedNote,
    ];
  }
  return h("div", null, canEdit() ? composer() : null, controls, body);
}

async function pageDashboard() {
  const d = await api("GET", `dashboard${qs({ you: getName(), since: S.since })}`);
  return dashboardPage(d, { since: S.since, role: S.role, name: S.space.name, back: backToItems() });
}

/** "Name a process or paste its link." */
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
  const input = h("input", { id: opts.relateTo ? null : "composer-input", type: "text", maxlength: 2000, placeholder: opts.placeholder ?? "Name or link your process", autocomplete: "off", "aria-label": "Name or link your process" });
  const panel = h("div", { class: "composer-panel" });
  let mode = "idle"; // idle | text | link
  let preview = null;
  let details = null; // the optional fields (kind, status, summary…), rebuilt whenever the panel is

  const newDetails = (retrieved) => (details = createFields({ labels: S.space.settings.status_labels, kinds: knownKinds(), retrieved }));
  const title = h("input", { type: "text", maxlength: 300 });
  const hints = h("div", { class: "hints" });
  const submitLabel = () => (opts.relateTo ? RELATE_NEW[opts.kind?.() ?? "related"] : "Add question");
  const submitBtn = h("button", { type: "submit", class: "primary" }, submitLabel());

  const loadHints = debounce(async (t) => {
    if (t.length < 4) return hints.replaceChildren();
    try {
      const { similar } = await api("GET", `similar${qs({ title: t, exclude: opts.relateTo })}`);
      const list = opts.exclude ? similar.filter((s) => !opts.exclude.has(s.id)) : similar;
      if (!list.length) return hints.replaceChildren();
      const as = RELATE_AS[opts.kind?.() ?? "related"];
      // On a question page, a suggestion is a link target: clicking it relates the existing question.
      const item = (s) =>
        opts.relateTo
          ? h("li", null, h("button", { type: "button", class: "link", title: as.hint, onclick: () => opts.onRelate(s) }, `${as.symbol} `, s.title), " ", statusPill(s.status), " ", h("a", { href: `#/q/${s.id}`, class: "muted small", title: "Open it" }, "↗"))
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
    if (preview.existing) {
      mode = "idle";
      panel.replaceChildren(existingNotice(preview.existing, "This link is already tracked by"));
      return;
    }
    if (!preview.matched) {
      // Not on the tool list: accepted, but nothing is retrieved.
      mode = "link";
      title.value = "";
      title.required = true;
      title.placeholder = "Write the question";
      panel.replaceChildren(
        h(
          "div",
          { class: "notice" },
          h("p", null, "This site isn't on the tool list, so nothing is retrieved from the link: you'll type the title, status and dates. ", h("a", { href: `#/rules/add-tool${qs({ url })}` }, "Add this tool"), " to retrieve them."),
        ),
        field("Question", title),
        hints,
        newDetails().el,
        h("div", { class: "row" }, submitBtn),
      );
      queueMicrotask(() => title.focus());
      return;
    }
    mode = "link";
    title.required = !preview.title;
    title.value = preview.title ?? "";
    title.placeholder = "Write the question in the group's words";
    loadHints(title.value);
    panel.replaceChildren(
      h(
        "div",
        { class: "link-preview" },
        h("strong", null, preview.tool_name), " · ", itemLabel(preview.item_type),
        preview.fetched ? [" · ", statePill(preview.fetched.state, preview.fetched.raw_state), preview.fetched.outcome_summary ? ` ${preview.fetched.outcome_summary}` : ""] : preview.fetch_mode === "manual" ? h("span", { class: "muted" }, " · status and dates will be typed") : null,
        preview.fetch_error ? h("p", { class: "warn" }, preview.fetch_mode === "manual" ? `${preview.fetch_error}: its status and dates will be typed.` : `Couldn't retrieve details: ${preview.fetch_error}`) : null,
      ),
      field("Question", title, preview.title ? "Retrieved from the link: keep it to follow the item's title, or rewrite it in the group's own words (it's then typed)." : "Write the question in the group's own words."),
      hints,
      newDetails(retrievedFromPreview(preview)).el,
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
      panel.replaceChildren(hints, newDetails().el, h("div", { class: "row" }, submitBtn));
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
        let d;
        try {
          d = details.read();
        } catch (err) {
          return toast(err.message, "error");
        }
        const body = { related_id: opts.relateTo, ...(opts.relateTo ? { related_kind: SEEN_FROM_NEW[opts.kind?.() ?? "related"] } : {}), title: mode === "link" ? title.value : v, fields: d.fields };
        if (d.status) body.status = d.status;
        if (mode === "link") body.process = { url: v, ...(d.process_kind ? { kind: d.process_kind } : {}) };
        else if (d.process_kind) body.process = { kind: d.process_kind };
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
  // The relation chosen beside it changes what the button says and what the suggestions do.
  form.relationChanged = () => {
    submitBtn.textContent = submitLabel();
    loadHints(input.value.trim());
  };
  return form;
}

/** The relation chosen on a question's page says what *that* question is to the other one; the new question sees it the other way round. */
const SEEN_FROM_NEW = { related: "related", child_of: "parent_of", parent_of: "child_of", duplicate_of: "duplicated_by", duplicated_by: "duplicate_of" };

/** The button for a new question made from a question's page, by relation. */
const RELATE_NEW = {
  related: "Add as a new related question",
  child_of: "Add as a new parent question",
  parent_of: "Add as a new child question",
  duplicate_of: "Add as a new question this duplicates",
  duplicated_by: "Add as a new duplicate",
};

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

  const fc = fieldCtx(q);
  const top = h(
    "div",
    { class: "q-head" },
    h("a", { href: `#/list?lane=${q.status === "withdrawn" ? "withdrawn" : ENDED.includes(q.status) ? "ended" : "current"}`, class: "back" }, "← Back"),
    fieldCell("title", q.fields.title, fc, (v) => h("h1", null, v)),
    h("div", { class: "row" }, questionPill(q)),
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
    h("dl", { class: "meta" }, h("dt", null, "Added"), h("dd", null, q.created_by, " · ", time(q.created_at))),
  );

  // A dropped link becomes this question's process, when it has none yet.
  if (canEditQ(q) && !q.process) onLinkDrop = (url) => openForm(attachForm(q, false, url));

  return h(
    "div",
    { class: "question" },
    top,
    fieldsBlock(q, fc),
    processBlock(q, d, openForm),
    formSlot,
    relationsBlock(q, d),
    h("section", { class: "panel" }, h("h2", null, "History"), h("ul", { class: "activity" }, d.activity.map((e) => activityItem(e)))),
  );
}

/** Kinds to suggest when typing one: those already in use, and a few common ones. */
const knownKinds = () => [...new Set([...(S.custom_kinds ?? []).map((k) => k.kind), "Meeting", "General assembly", "Unconference", "Workshop", "Survey", "Working group"])];

/** What field cells need: who can edit, the status labels, known kinds, and how to save. */
function fieldCtx(q) {
  return {
    editable: canEditQ(q),
    labels: S.space.settings.status_labels,
    kinds: knownKinds(),
    toast: (m) => toast(m, "error"),
    save: async (body) => {
      const ok = await act(() => api("PUT", `questions/${q.id}/fields`, body), "Saved");
      if (ok) await refresh();
      return !!ok;
    },
  };
}

/** The question's fields, each retrieved from the linked item or typed. */
function fieldsBlock(q, fc) {
  const names = ["kind", "status", "summary", "results_url", "start", "end"].filter((f) => f !== "kind" || q.process);
  // Read-only: hide empty fields nobody can retrieve.
  const shown = names.filter((f) => fc.editable || q.fields[f].value !== undefined || q.fields[f].retrievable);
  const anyRetrievable = names.some((f) => q.fields[f].retrievable);
  return h(
    "section",
    { class: "panel fields" },
    h("h2", null, "Details"),
    h("dl", { class: "meta field-list" }, shown.map((f) => [h("dt", null, FIELD_LABEL[f]), h("dd", null, fieldCell(f, q.fields[f], fc))])),
    fc.editable
      ? h(
          "p",
          { class: "muted small" },
          anyRetrievable
            ? "“Retrieved” values come from the linked item and stay up to date. Double-click a value (or ✎) to type your own; “↺ use retrieved” goes back."
            : "Nothing is retrieved here: double-click a value (or ✎) to type it.",
        )
      : null,
  );
}

/** Link a process: any link (retrieved when its site is on the tool list), or none with a kind (a meeting…). */
function attachForm(q, replace, prefillUrl) {
  return inlineForm(replace ? "Replace the attached link" : "Add an attached link", replace ? "Replace" : "Add", () => {
    const p = q.process;
    const url = h("input", { type: "url", placeholder: "https://… (optional)", value: prefillUrl ?? p?.url ?? "" });
    const kind = h("input", { type: "text", maxlength: 60, placeholder: "e.g. Meeting, General assembly, Survey", value: q.fields?.kind?.source === "typed" ? (q.fields.kind.value ?? "") : "", list: "attach-kinds" });
    const kinds = h("datalist", { id: "attach-kinds" }, fieldCtx(q).kinds.map((k) => h("option", { value: k })));
    return {
      body: [
        field("Link", url, "Links from a tool on the list are retrieved: title, status, dates… Any other link works too; its fields are then typed."),
        toolHints(),
        field("Kind", kind, "Needed when there's no link (a meeting, a survey…). For links from listed tools, the kind is retrieved."),
        kinds,
      ],
      submit: async () => {
        if (!url.value.trim() && !kind.value.trim()) throw new Error("Give a link, or a kind");
        await api("PUT", `questions/${q.id}/process`, { url: url.value.trim() || undefined, kind: kind.value.trim() || undefined });
        toast("Attached link saved", "ok");
        return true;
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

/** The linked item: where it is, which tool reads it, when it was last checked, platform details. */
function processBlock(q, d, openForm) {
  const p = q.process;
  if (!p) {
    return h(
      "section",
      { class: "panel" },
      h("h2", null, "Attached link"),
      h("p", { class: "muted" }, "No attached link yet. It points to where the question is worked on: a pull request, a poll, a Polis conversation, a meeting…"),
      canEditQ(q) ? h("button", { onclick: () => openForm(attachForm(q, false)) }, "Add an attached link…") : null,
    );
  }
  const f = p.fetched;
  const tool = d.tool;
  const custom = p.tool_id === CUSTOM_TOOL_ID;
  const extra = f?.extra ? Object.entries(f.extra).filter(([k]) => k !== "results_url" && k !== "outcome") : [];
  const refreshBtn = h(
    "button",
    {
      onclick: async () => {
        const r = await act(() => api("POST", `questions/${q.id}/process/refresh`));
        if (!r) return;
        toast(r.refresh?.error ? `Refresh failed: ${r.refresh.error}` : r.refresh?.skipped ? `Not refreshed: ${r.refresh.skipped}` : r.refresh?.changed ? "Updated" : "No change", r.refresh?.error ? "error" : "ok");
        await refresh();
      },
    },
    "↻ Refresh",
  );
  const remove = async () => {
    if (!confirm("Remove the attached link? The question keeps its title and status, now typed.")) return;
    if (await act(() => api("DELETE", `questions/${q.id}/process`), "Attached link removed")) await refresh();
  };
  const toolLine = custom
    ? h("span", { class: "muted" }, p.url ? ["Not on the tool list: nothing is retrieved. ", canEditQ(q) ? h("a", { href: `#/rules/add-tool${qs({ url: p.url })}` }, "Add this tool") : null] : "No link: everything is typed.")
    : [
        h("strong", null, tool?.name ?? p.tool_id),
        h(
          "span",
          { class: "muted" },
          p.fetch_mode === "auto"
            ? " · retrieves the title, kind, status, dates and more"
            : tool?.auto_unavailable || f?.fetch_error
              ? " · can't be read here: only the kind and title are retrieved"
              : " · retrieves the kind and the page title; the rest is typed",
        ),
      ];
  return h(
    "section",
    { class: "panel process" },
    h("h2", null, "Attached link"),
    h(
      "dl",
      { class: "meta" },
      p.url ? [h("dt", null, "Link"), h("dd", null, extLink(p.url))] : null,
      h("dt", null, "Tool"),
      h("dd", null, toolLine),
      f?.dates?.updated_at ? [h("dt", null, "Last activity"), h("dd", null, time(f.dates.updated_at, timeAgo(f.dates.updated_at)), h("span", { class: "muted" }, " (on the platform)"))] : null,
      f?.extra?.outcome ? [h("dt", null, "Outcome"), h("dd", null, String(f.extra.outcome))] : null,
      extra.length ? [h("dt", null, "Details"), h("dd", null, extra.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · "))] : null,
      p.fetch_mode === "auto" ? [h("dt", null, "Last checked"), h("dd", null, f ? time(f.fetched_at, timeAgo(f.fetched_at)) : "never")] : null,
      f?.fetch_error ? [h("dt", null, "Problem"), h("dd", { class: "warn" }, f.fetch_error, p.fetch_mode === "manual" ? " — type its status and other fields." : "")] : null,
      tool && !tool.enabled ? [h("dt", null, "Note"), h("dd", { class: "warn" }, "This tool is disabled; nothing is refreshed.")] : null,
    ),
    canEditQ(q)
      ? h(
          "div",
          { class: "row" },
          p.fetch_mode === "auto" ? refreshBtn : null,
          h("button", { onclick: () => openForm(attachForm(q, true)) }, "Replace…"),
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
  let form;
  const kindSel = h(
    "select",
    { "aria-label": "How this question relates to the other one", onchange: () => form?.relationChanged() },
    Object.entries(RELATE_AS).map(([v, a]) => h("option", { value: v }, `This question ${a.menu}…`)),
  );
  const kindNow = () => kindSel.value || "related";
  const relate = async (x) => {
    const kind = kindNow();
    if (await act(() => api("POST", `questions/${q.id}/related`, { id: x.id, kind }), RELATE_AS[kind].done)) await refresh();
  };
  const withdraw = (id, note) => async () => {
    if (await act(() => api("PUT", `questions/${id}/fields`, { set: { status: { state: "withdrawn" } }, note }), "Withdrawn")) await refresh();
  };
  // A duplicate is better withdrawn, so only one of the two stays active (suggested, never forced).
  const dupHints = !editable
    ? []
    : [
        ...(q.status === "withdrawn"
          ? []
          : d.related.filter((x) => x.role === "duplicate_of").map((x) =>
              h("div", { class: "notice rel-hint" }, "This question duplicates “", h("a", { href: `#/q/${x.id}` }, x.title), "”. Withdraw it, so only one stays active? ", h("button", { onclick: withdraw(q.id, `Duplicate of “${x.title}”`) }, "Withdraw this question")),
            )),
        ...d.related.filter((x) => x.role === "duplicated_by" && x.status !== "withdrawn").map((x) =>
          h("div", { class: "notice rel-hint" }, "“", h("a", { href: `#/q/${x.id}` }, x.title), "” duplicates this question. Withdraw it, so only one stays active? ", h("button", { onclick: withdraw(x.id, `Duplicate of “${q.title}”`) }, "Withdraw it")),
        ),
      ];
  form = editable ? composer({ relateTo: q.id, exclude: new Set(d.related.map((x) => x.id)), onRelate: relate, kind: kindNow, placeholder: "Type to find a question, or add a new one…" }) : null;
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Related questions"),
    dupHints,
    d.related.length
      ? h(
          "ul",
          { class: "rel-list" },
          d.related.map((x) =>
            h(
              "li",
              { class: `rel-${x.role}` },
              h("span", { class: "rel-kind" }, ROLE[x.role], ": "),
              h("a", { href: `#/q/${x.id}` }, x.title),
              " ",
              statusPill(x.status),
              editable ? [" ", h("button", { class: "link muted small", title: "Remove this relation (both questions stay)", onclick: unrelate(x) }, "unlink")] : null,
            ),
          ),
        )
      : h("p", { class: "muted" }, "None yet."),
    editable ? h("div", { class: "row" }, kindSel) : null,
    form,
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
  const updates = (t) => (t.fetch_mode === "auto" ? "everything it can" : t.auto_unavailable ? "kind and title (more needs server setup)" : "kind and page title");
  const used = (u, href) =>
    u?.questions ? h("a", { href }, `${u.questions} question${u.questions === 1 ? "" : "s"}`, u.in_progress ? ` · ${u.in_progress} in progress` : "") : h("span", { class: "muted" }, "—");
  const customKinds = S.custom_kinds ?? [];
  return h(
    "div",
    { class: "rules" },
    backToItems(),
    h("h1", null, "Tools"),
    h("p", null, "The tools that can be linked to an item, and the status labels."),
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
          h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Links accepted"), h("th", null, "Retrieves"), h("th", null, "Used by"), h("th", null, "Status"), canEdit() ? h("th", null) : null)),
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
  );
}

/** The charter. */
function pageHow() {
  return h("div", null, backToItems(), h("section", { class: "panel charter" }, renderMarkdown(S.space.charter_markdown)));
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
  // Adding: a tool whose links are recognised (patterns), or an instance of a platform we can fetch.
  let kind = !tool && url && /\/(proposals|debates|budgets)\/\d+/.test(url) ? "consul" : "manual";
  const baseUrl = h("input", { type: "url", placeholder: "https://participa.example.org", value: host ? `https://${host}` : "" });
  const manualBox = h(
    "div",
    null,
    field("Links accepted", patterns, "One per line: URL pattern → item type. Use :name for one path part and * for anything, e.g. https://forum.example.org/t/* → topic"),
    field("Check a link", tester),
    testOut,
    h("p", { class: "muted small" }, "From these links, the kind (the item type above) and the page title are retrieved. Their status and dates are typed on each question, with the space's status labels."),
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
    h("a", { href: "#/rules", class: "back" }, "← Tools"),
    h("h1", null, tool ? `Edit “${tool.name}”` : "Add a tool"),
    h(
      "p",
      null,
      auto
        ? `${tool.name} is followed automatically: its links and states come with it. You can rename it and say what your group uses it for.`
        : tool
        ? "Changes apply right away. Links already in the register that the patterns now recognise join this tool."
        : "List a site so its links are recognised: their kind and page title are retrieved, the rest is typed. Some platforms can be read fully (status, dates…). Links already in the register from this site join the tool.",
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
          let url_patterns;
          try {
            url_patterns = parsePatterns();
          } catch (err) {
            return toast(err.message, "error");
          }
          btn.disabled = true;
          const body = { name: name.value, description: description.value, url_patterns };
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
    backToItems(),
    h("h1", null, "Activity"),
    h("p", { class: "muted" }, "Every change in this space, newest first. The log can't be edited."),
    S.role === "view"
      ? h("p", null, "Subscribe in a feed reader: ", h("a", { href: `/feed/${TOKEN}.atom` }, "Atom feed"), h("span", { class: "muted small" }, " (contains this view link: share with care)"))
      : h("p", { class: "muted small" }, "An Atom feed is available from the view link (open the space with it and come back here)."),
    h("section", { class: "panel" }, list, more),
  );
}

boot();
