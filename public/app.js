// Group Matters — single-page UI. Hash routes:
//   #/dashboard              summary widgets (the space name in the header links here)
//   #/list?lane=current&q=…  the items, as a list or (view=timeline) as bars over time; lanes, search, filters
//   #/q/<id>                 question page
//   #/tools                  tools (tool list, status labels); #/tools/add-tool?url=…; #/tools/tool?id=… (edit)
//   #/about                    how this works (the group's own text + the app's help)
//   #/timeline?…             old link: the items' timeline view
//   #/activity               activity feed
// No tabs: the space name opens the items, the menu (top right) has Dashboard, Tools, Activity, About, Export.
import { api, qs, getName, setName, TOKEN, ApiError } from "./api.js";
import { h, extLink, fmtDate, time, timeAgo, toast, debounce } from "./dom.js";
import { STATE, STATE_HINT, QUESTION_STATES, ENDED, CUSTOM_TOOL_ID, ROLE, RELATE_AS, itemLabel } from "./labels.js";
import { statusPill, questionPill, statePill, questionTree, questionCard, activityItem, mappingEditor, toolIcon } from "./components.js";
import { renderMarkdown } from "./md.js";
import { fieldCell, createFields, retrievedFromPreview, showValue, FIELD_LABEL } from "./fields.js";
import { timelineChart } from "./timeline.js";
import { dashboardPage } from "./dashboard.js";
import { PROMPTS_ENABLED, promptOfSession } from "./prompts.js";
import { helpSections } from "./help.js";

const app = document.getElementById("app");
const S = { space: null, role: "view", tools: [], counts: {}, since: null };
const canEdit = () => S.role === "edit";
/** Archived (API: removed) questions are read-only until restored. */
const canEditQ = (q) => canEdit() && !q.removed_at;

// ---------------------------------------------------------------- bootstrap

async function loadSpace() {
  const d = await api("GET", "space");
  Object.assign(S, d);
  if (!document.title.includes("·")) document.title = `${S.space.name} · Group Matters`;
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
  if (canEdit()) await chooseMode();
  if (canEdit() && !getName()) await askName();
  if (canEdit()) installLinkDrop();
  window.addEventListener("hashchange", render);
  // The menu closes on a click elsewhere, or Escape.
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".menu")) closeMenus();
    if (!e.target.closest?.(".dd")) closeFilters();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".menu-list:not([hidden])");
    const dd = document.querySelector(".dd-panel:not([hidden])")?.parentElement;
    closeMenus();
    closeFilters();
    (open?.parentElement.querySelector(".menu-btn") ?? dd?.querySelector(".dd-btn"))?.focus();
  });
  render();
}

/**
 * Opening the edit link: choose to edit or to stay a viewer (which moves to the view link, so no name is asked and the
 * edit link isn't left in the address bar). "Edit" is remembered on this device. Not a permission: the edit link
 * can always edit; sharing the view link is what keeps people read-only.
 */
function chooseMode() {
  const key = `qr:mode:${S.space.id}`;
  if (!S.view_token || localStorage.getItem(key) === "edit") return Promise.resolve();
  return new Promise((resolve) => {
    const dialog = h(
      "dialog",
      { class: "modal-dialog", "aria-labelledby": "mode-title", oncancel: (e) => e.preventDefault() },
      h(
        "div",
        { class: "panel modal" },
        h("h2", { id: "mode-title" }, S.space.name),
        h("p", null, "You opened the edit link. Do you want to change things, or just look?"),
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", class: "primary", onclick: () => (localStorage.setItem(key, "edit"), dialog.close(), dialog.remove(), resolve()) }, "Edit"),
          h("button", { type: "button", onclick: () => location.replace(`/s/${S.view_token}${location.hash}`) }, "View only"),
        ),
        h("p", { class: "muted small" }, "Viewing needs no name. Editing is remembered on this device."),
      ),
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** The token feeds are served under: the view link (never the edit link), if there is one. */
const subscribeToken = () => (S.role === "view" ? TOKEN : S.view_token);

/** Share dialog (edit link): the view link to hand out widely, and this edit link for those who should change things. */
function shareDialog() {
  const origin = location.origin;
  const editUrl = `${origin}/s/${TOKEN}`;
  const row = (label, note, url) => {
    const input = h("input", { type: "text", readonly: true, value: url, "aria-label": label, onfocus: (e) => e.target.select() });
    return h(
      "div",
      null,
      h("h3", null, label),
      h("p", { class: "muted small" }, note),
      h("div", { class: "row" }, input, h("button", { type: "button", onclick: async () => { try { await navigator.clipboard.writeText(url); toast("Link copied", "ok"); } catch { input.select(); toast("Press Ctrl/Cmd+C to copy", "info"); } } }, "Copy")),
    );
  };
  const body = h("div", { class: "panel modal" }, h("h2", { id: "share-title" }, "Share this space"));
  const fill = () => {
    body.replaceChildren(
      h("h2", { id: "share-title" }, "Share this space"),
      S.view_token
        ? h(
            "div",
            null,
            row("View link", "Read only, no name needed. Safe to post for everyone.", `${origin}/s/${S.view_token}`),
            row("Atom feed", "For a feed reader. It contains the view link: share with care.", `${origin}/feed/${S.view_token}.atom`),
            row("Calendar (ICS)", "Start and end dates, as a subscription in a calendar app. Contains the view link too.", `${origin}/feed/${S.view_token}.ics`),
          )
        : h(
            "div",
            null,
            h("h3", null, "View link"),
            h("p", { class: "muted small" }, "This space's existing view link was made before it could be shown here. Creating a new one stops the old one working."),
            h("button", { type: "button", onclick: async () => {
              if (!confirm("Create a new view link? The current view link will stop working.")) return;
              const r = await act(() => api("POST", "view-link", {}));
              if (r) (S.view_token = r.view_token, fill());
            } }, "Create a view link"),
          ),
      row("Edit link", "Anyone with it can change things. Give it only to people who should edit.", editUrl),
    );
  };
  fill();
  const dialog = h("dialog", { class: "modal-dialog", "aria-labelledby": "share-title", oncancel: () => dialog.remove(), onclick: (e) => e.target === dialog && (dialog.close(), dialog.remove()) }, body);
  document.body.append(dialog);
  dialog.showModal();
}

function askName() {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", maxlength: 60, value: getName(), required: true, autocomplete: "nickname", "aria-label": "Display name" });
    const close = () => (dialog.close(), dialog.remove(), resolve());
    const dialog = h(
      "dialog",
      { class: "modal-dialog", "aria-labelledby": "name-title", oncancel: (e) => (!getName() ? e.preventDefault() : (dialog.remove(), resolve())) },
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
    document.body.append(dialog);
    dialog.showModal();
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
  // dragenter/dragleave pairs are unreliable (child elements, dragging out of the window, cancelled drags),
  // so the overlay is kept alive by dragover (fires every ~50ms) and cleared when it stops.
  let timer = null;
  const hasLink = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === "text/uri-list" || t === "text/plain");
  const done = () => {
    clearTimeout(timer);
    document.body.classList.remove("dropping");
  };
  document.addEventListener("dragenter", (e) => {
    if (hasLink(e)) document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) done(); // left the window
  });
  document.addEventListener("dragend", done);
  window.addEventListener("blur", done);
  // Any normal interaction means no drag is in progress.
  for (const t of ["mousemove", "pointerdown", "keydown", "mouseover"]) document.addEventListener(t, done, true);
  document.addEventListener("dragover", (e) => {
    if (!hasLink(e)) return;
    document.body.classList.add("dropping");
    clearTimeout(timer);
    timer = setTimeout(done, 600); // some browsers only repeat dragover every ~350ms
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
let lastPageKey = null;

const PAGE_TITLES = { list: "Matters", dashboard: "Dashboard", tools: "Tools", activity: "Activity", about: "About" };

/** The page's <h1> (a visually hidden one when the page has none) and its text. */
function pageHeading(parts, view) {
  let h1 = document.querySelector("main h1");
  if (!h1) {
    h1 = h("h1", { class: "visually-hidden" }, PAGE_TITLES[parts[0] ?? "list"] ?? "Group Matters");
    document.getElementById("main").prepend(h1);
  }
  if (!h1.textContent.trim()) h1.textContent = PAGE_TITLES[parts[0] ?? "list"] ?? "Group Matters";
  return h1;
}

/** Identify a focused control well enough to find it again after a re-render. */
function focusKey(el) {
  if (!el || el === document.body || !app.contains(el)) return null;
  const text = el.id || el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("href") || el.textContent.trim().slice(0, 60);
  if (!text) return null;
  const same = [...app.querySelectorAll(el.tagName)].filter((x) => (x.id || x.getAttribute("aria-label") || x.getAttribute("name") || x.getAttribute("href") || x.textContent.trim().slice(0, 60)) === text);
  return { tag: el.tagName, text, nth: same.indexOf(el), value: "value" in el ? el.value : null, sel: el.selectionStart ?? null };
}

function restoreFocus(k) {
  const same = [...app.querySelectorAll(k.tag)].filter((x) => (x.id || x.getAttribute("aria-label") || x.getAttribute("name") || x.getAttribute("href") || x.textContent.trim().slice(0, 60)) === k.text);
  const el = same[Math.min(k.nth, same.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  if (k.sel != null && k.value === el.value) try { el.setSelectionRange(k.sel, k.sel); } catch {}
}
async function render() {
  const seq = ++renderSeq;
  let { parts, params } = parseHash();
  // The timeline is a view of the items page.
  if (parts[0] === "timeline") (params.set("view", "timeline"), (parts = ["list"]));
  onLinkDrop = null;
  let view;
  try {
    if (parts[0] === "q" && parts[1]) view = await pageQuestion(parts[1]);
    else if (parts[0] === "tools") view = await pageRules(parts[1], params);
    else if (parts[0] === "activity") view = await pageActivity();
    else if (parts[0] === "about") view = pageHow();
    else if (parts[0] === "dashboard") view = await pageDashboard();
    else view = await pageHome(params);
  } catch (e) {
    view = h("div", { class: "panel error" }, h("h2", null, "Something went wrong"), h("p", null, e.message));
  }
  if (seq !== renderSeq) return;
  // Same page re-rendered (refresh, filter): keep focus where it was. New page: focus its heading.
  const pageKey = parts.join("/");
  const samePage = pageKey === lastPageKey;
  const keep = samePage ? focusKey(document.activeElement) : null;
  const firstLoad = lastPageKey === null;
  lastPageKey = pageKey;
  app.replaceChildren(header(parts[0] ?? "list"), h("main", { id: "main" }, view));
  const heading = pageHeading(parts, view);
  // The matters page is the home page of the space: its tab is just "<Space> · Group Matters".
  document.title = !parts[0] || parts[0] === "list" ? `${S.space.name} · Group Matters` : `${heading.textContent} · ${S.space.name} · Group Matters`;
  if (keep) restoreFocus(keep);
  else if (!firstLoad) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  }
  if (!parts[0] || parts[0] === "list") {
    if (firstLoad) document.getElementById("composer-input")?.focus({ preventScroll: true });
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
  const item = (key, label) => h("a", { href: `#/${key}`, "aria-current": section === key ? "page" : null, onclick: closeMenus }, label);
  const list = h(
    "div",
    { class: "menu-list", hidden: true },
    item("dashboard", "Dashboard"),
    item("tools", "Tools"),
    item("activity", "Activity"),
    item("about", "About"),
    h("button", { type: "button", onclick: () => (closeMenus(), downloadExport()) }, "Export"),
    canEdit() ? h("button", { type: "button", onclick: () => (closeMenus(), shareDialog()) }, "Share…") : null,
  );
  const button = h(
    "button",
    {
      type: "button",
      class: "menu-btn",
      "aria-expanded": "false",
      onclick: () => {
        const wasClosed = list.hidden;
        closeMenus();
        if (wasClosed) (list.hidden = false, button.setAttribute("aria-expanded", "true"));
      },
    },
    h("span", { class: "burger", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    "Menu",
  );
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-row" },
      h("a", { href: "#/list", class: "space-name", title: "Matters" }, S.space.name),
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

/** Close the open filter dropdown, if any. */
function closeFilters() {
  openFilter = null;
  for (const d of document.querySelectorAll(".dd")) {
    d.querySelector(".dd-panel").hidden = true;
    d.querySelector(".dd-btn").setAttribute("aria-expanded", "false");
  }
}

/** Close the menu (all of them: there is one). */
function closeMenus() {
  for (const m of document.querySelectorAll(".menu")) {
    m.querySelector(".menu-list").hidden = true;
    m.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
  }
}
const backToItems = () => h("a", { href: "#/list", class: "back" }, "← Matters");

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
  archived: { label: "Archived (hidden from the other lanes, kept in the history)", status: "" },
};
// Shortcuts: no controls of their own, only the dashboard's "Needs attention" links (`preset=`), shown as a notice with a way out.
const PRESETS = {
  no_process: "current matters with no tool attached",
  quiet: "matters in progress but quiet for 30+ days",
  fetch_problems: "matters whose link couldn't be read",
};
const FILTER_KEYS = ["q", "preset", "status", "tool", "item_type", "related"];
/** Tool filter value for matters with no tool attached. */
const NO_TOOL = "none";
/** The filter dropdown that is open (it stays open while its boxes are ticked, across the re-render each tick causes). */
let openFilter = null;

/**
 * Search, lanes, view toggle and filters of the items page, for both views ("list" or "timeline").
 * The default lane (no lane chosen, nothing searched) is Current for the list, All for the timeline.
 */
function listControls(params, view) {
  const route = "list";
  const defaultLane = view === "timeline" ? "all" : "current";
  const sort = view === "list";
  const searching = FILTER_KEYS.some((k) => params.get(k));
  const lane = (params.get("lane") === "removed" ? "archived" : params.get("lane")) ?? (searching ? "all" : defaultLane); // `removed`: the old name of the lane
  const query = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k)]));
  query.status = params.get("status") || (LANES[lane]?.status ?? "");
  if (sort) query.sort = params.get("sort");
  if (lane === "archived") query.removed = "only";
  // Children under their parent, unless asked for a flat list (`flat=1`).
  const hierarchy = params.get("flat") !== "1";
  if (hierarchy) query.hierarchy = "1";

  const setParam = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    location.hash = `#/${route}?${p}`;
  };

  const searchInput = h("input", { type: "search", placeholder: "Search matters…", value: params.get("q") ?? "", "aria-label": "Search matters" });
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
  // Several values can be ticked at once: a button that opens a list of boxes. The choice is kept in the URL as a comma list.
  const multi = (key, label, options) => {
    const on = new Set((params.get(key) ?? "").split(",").filter(Boolean));
    const names = options.filter(([v]) => on.has(v)).map(([, l]) => l);
    const toggle = (v) => setParam(key, (on.has(v) ? [...on].filter((x) => x !== v) : [...on, v]).join(","));
    const open = openFilter === key;
    const panel = h(
      "div",
      { class: "dd-panel", role: "group", "aria-label": label, id: `dd-${key}`, hidden: !open },
      options.map(([v, l]) => h("label", { class: "dd-opt" }, h("input", { type: "checkbox", id: `dd-${key}-${v}`, checked: on.has(v), onchange: () => toggle(v) }), l)),
      on.size ? h("button", { type: "button", class: "link small", onclick: () => setParam(key, "") }, "Clear") : null,
    );
    const button = h(
      "button",
      {
        type: "button",
        class: `chip-btn dd-btn${on.size ? " on" : ""}`,
        "aria-expanded": open ? "true" : "false",
        "aria-controls": `dd-${key}`,
        onclick: () => {
          const wasOpen = openFilter === key;
          closeFilters();
          if (!wasOpen) (openFilter = key, panel.hidden = false, button.setAttribute("aria-expanded", "true"));
        },
      },
      names.length ? `${label}: ${names.length <= 2 ? names.join(", ") : `${names.length} selected`}` : label,
      h("span", { class: "dd-caret", "aria-hidden": "true" }, "▾"),
    );
    return h("div", { class: "dd" }, button, panel);
  };
  const itemTypes = [...new Set([...S.tools.flatMap((t) => t.url_patterns.map((p) => p.item_type)), ...(S.custom_kinds ?? []).map((k) => k.kind)])];
  const filters = h(
    "details",
    { class: "filters", open: ["status", "tool", "item_type", "sort", "flat"].some((k) => params.get(k)) },
    h("summary", null, "Filters"),
    h(
      "div",
      { class: "dd-row", role: "group", "aria-label": "Filters" },
      multi("status", "Status", QUESTION_STATES.map((s) => [s, STATE[s]])),
      multi("tool", "Tool", [[NO_TOOL, "No tool"], [CUSTOM_TOOL_ID, "Custom tool"], ...S.tools.map((t) => [t.id, t.name])]),
      itemTypes.length ? multi("item_type", "Item type", itemTypes.map((t) => [t, itemLabel(t)])) : null,
      sort ? sel("sort", "Order", [["", "Latest activity first"], ["created", "Newest first"]], null) : null,
      sel("flat", "Children", [["", "Under their parent"], ["1", "Listed apart (flat)"]], null),
    ),
  );
  const presetChip = PRESETS[params.get("preset")] ? h("p", null, `Showing ${PRESETS[params.get("preset")]} · `, h("button", { class: "link", onclick: () => setParam("preset", "") }, "clear")) : null;
  const relatedChip = params.get("related") ? h("p", null, "Showing matters related to another · ", h("a", { href: `#/q/${params.get("related")}` }, "open it"), " · ", h("button", { class: "link", onclick: () => setParam("related", "") }, "clear")) : null;
  // Lanes with counts, beside the search (the same on the list and the timeline). Withdrawn is the Status filter.
  const c = S.counts ?? {};
  const n = (states) => states.reduce((a, s) => a + (c[s] ?? 0), 0);
  const laneNav = h(
    "nav",
    { class: "sublanes", "aria-label": "Lanes" },
    [
      ["current", `Current (${n(["not_started", "open"])})`],
      ["ended", `Ended (${n(ENDED)})`],
      ["all", `All (${n(QUESTION_STATES)})`],
      ...(c.removed ? [["archived", `Archived (${c.removed})`]] : []),
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
  return { searching, lane, query, hierarchy, controls: [h("div", { class: "toolbar" }, viewToggle, searchForm, laneNav), filters, presetChip, relatedChip] };
}

async function pageHome(params) {
  const view = params.get("view") === "timeline" ? "timeline" : "list";
  const { searching, lane, query, hierarchy, controls } = listControls(params, view);
  let body;
  if (view === "list") {
    const { questions } = await api("GET", `questions${qs(query)}`);
    const ctx = { tools: S.tools, since: S.since, space: S.space, hierarchy, filters: { params, lane } };
    body = questions.length
      ? h("ul", { class: "cards" }, hierarchy ? questionTree(questions, ctx) : questions.map((q) => questionCard(q, ctx)))
      : h("p", { class: "empty" }, searching ? "No matters match." : lane === "archived" ? "Nothing is archived." : lane === "current" ? "No current matters. Add one above." : "Nothing here yet.");
  } else {
    // The questions with a start date as bars over time, to their end (or today).
    const { items, undated, now } = await api("GET", `timeline${qs(query)}`);
    const assumedStart = items.filter((it) => it.start.source === "assumed").length;
    const undatedNote = undated
      ? h("p", { class: "muted small" }, `${undated} matter${undated === 1 ? " has" : "s have"} no start date and ${undated === 1 ? "isn't" : "aren't"} shown. Dates come from the linked process, or can be set on each matter.`)
      : null;
    body = [
      h(
        "p",
        { class: "muted small" },
        "Each matter with a start date, from its start to its end (or today if it's still running). Hover a bar for its dates.",
        assumedStart ? ` ${assumedStart} ${assumedStart === 1 ? "has" : "have"} no start date but a planned end: drawn from today.` : "",
      ),
      items.length ? h("section", { class: "panel" }, timelineChart(items, now)) : h("p", { class: "empty" }, searching ? "No dated matters match." : "No matter has a start date yet."),
      undatedNote,
    ];
  }
  return h("div", null, canEdit() ? composer() : null, controls, body);
}

async function pageDashboard() {
  const d = await api("GET", `dashboard${qs({ since: S.since })}`);
  return dashboardPage(d, { since: S.since, role: S.role, name: S.space.name, tools: S.tools, back: backToItems() });
}

/** The add bar: "Name or link a matter", with a few examples of what a matter can be when there's room. */
const COMPOSER_HELP = "Name or link a matter";
const COMPOSER_EXAMPLES = "Name or link a matter: a question, a proposal, a poll, a meeting…";
const roomForExamples = () => typeof matchMedia !== "function" || matchMedia("(min-width: 561px)").matches;

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
  const input = h("input", { id: opts.relateTo ? null : "composer-input", type: "text", maxlength: 2000, placeholder: opts.placeholder ?? (roomForExamples() ? COMPOSER_EXAMPLES : COMPOSER_HELP), autocomplete: "off", "aria-label": opts.relateTo ? "Find or add a matter" : COMPOSER_HELP });
  // A line above the bar, only while it's idle (hidden as soon as there's text). On the main bar only, and off for now (see prompts.js).
  const prompt = opts.relateTo || !PROMPTS_ENABLED ? null : h("p", { class: "composer-prompt muted small" }, promptOfSession());
  const panel = h("div", { class: "composer-panel" });
  let mode = "idle"; // idle | text | link
  let preview = null;
  let details = null; // the optional fields (kind, status, summary…), rebuilt whenever the panel is

  const newDetails = (retrieved) => (details = createFields({ labels: S.space.settings.status_labels, kinds: knownKinds(), retrieved }));
  const title = h("input", { type: "text", maxlength: 300 });
  const hints = h("div", { class: "hints" });
  const submitLabel = () => (opts.relateTo ? RELATE_NEW[opts.kind?.() ?? "related"] : "Add matter");
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
          h("span", { class: "muted small" }, opts.relateTo ? "Relate an existing matter, or add yours as a new one: " : "Already asked? "),
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
      title.placeholder = "Write the matter";
      panel.replaceChildren(
        h(
          "div",
          { class: "notice" },
          h("p", null, "This site isn't on the tool list, so nothing is retrieved from the link: you'll type the title, status and dates. ", h("a", { href: `#/tools/add-tool${qs({ url })}` }, "Add this tool"), " to retrieve them."),
        ),
        field("Matter", title),
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
    title.placeholder = "Write the matter in the group's words";
    loadHints(title.value);
    panel.replaceChildren(
      h(
        "div",
        { class: "link-preview" },
        toolIcon(S.tools.find((t) => t.id === preview.tool_id) ?? { name: preview.tool_name }), " ",
        h("strong", null, preview.tool_name), " · ", itemLabel(preview.item_type),
        preview.fetched ? [" · ", statePill(preview.fetched.state, preview.fetched.raw_state), preview.fetched.outcome_summary ? ` ${preview.fetched.outcome_summary}` : ""] : preview.fetch_mode === "manual" ? h("span", { class: "muted" }, " · status and dates will be typed") : null,
        preview.fetch_error ? h("p", { class: "warn" }, preview.fetch_mode === "manual" ? `${preview.fetch_error}: its status and dates will be typed.` : `Couldn't retrieve details: ${preview.fetch_error}`) : null,
      ),
      field("Matter", title, preview.title ? "Retrieved from the link: keep it to follow the item's title, or rewrite it in the group's own words (it's then typed)." : "Write the matter in the group's own words."),
      hints,
      newDetails(retrievedFromPreview(preview)).el,
      h("div", { class: "row" }, submitBtn),
    );
  }, 350);

  input.addEventListener("input", () => {
    const v = input.value.trim();
    if (prompt) prompt.hidden = v.length > 0;
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
          toast("Matter added", "ok");
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
    prompt,
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
  related: "Add as a new related matter",
  child_of: "Add as a new parent matter",
  parent_of: "Add as a new child matter",
  duplicate_of: "Add as a new matter this duplicates",
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
    h("div", { class: "row" }, questionPill(q), canEditQ(q) ? overflowMenu(q) : null),
    q.removed_at
      ? h(
          "div",
          { class: "removed-banner" },
          h("strong", null, "Archived"),
          " ",
          time(q.removed_at, timeAgo(q.removed_at)),
          ". It's hidden from lists and its process is no longer refreshed.",
          canEdit() ? [" ", h("button", { onclick: async () => (await act(() => api("POST", `questions/${q.id}/restore`), "Restored")) && refresh() }, "Restore")] : null,
          " ",
          h("a", { href: "#/list?lane=archived" }, "All archived"),
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

/** "⋯" menu on a question's page: a disclosure (button + list of buttons). Holds the rarely needed, destructive actions. */
function overflowMenu(q) {
  const remove = async () => {
    closeMenus();
    const reason = prompt("Archive this matter? It's hidden from the lists but kept in the history, and can be restored.\n\nWhy? (optional)", "");
    if (reason === null) return;
    if (await act(() => api("POST", `questions/${q.id}/remove`, reason.trim() ? { reason: reason.trim() } : {}), "Archived")) {
      await loadSpace();
      location.hash = "#/list?lane=archived";
    }
  };
  const list = h("div", { class: "menu-list", hidden: true }, h("button", { type: "button", class: "danger-link", onclick: remove }, "Archive…"));
  const button = h(
    "button",
    {
      type: "button",
      class: "menu-btn more-btn",
      "aria-label": "More actions",
      "aria-expanded": "false",
      onclick: () => {
        const wasClosed = list.hidden;
        closeMenus();
        if (wasClosed) (list.hidden = false, button.setAttribute("aria-expanded", "true"));
      },
    },
    h("span", { "aria-hidden": "true" }, "⋯"),
  );
  return h("div", { class: "menu" }, button, list);
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
  const names = ["kind", "status", "summary", "results_url", "start", "end"];
  // With no attached link, typing a kind attaches a link-less (custom) process of that kind, as when creating a matter.
  const cellCtx = (f) =>
    f !== "kind" || q.process
      ? fc
      : {
          ...fc,
          save: async ({ set }) => {
            const kind = set?.kind;
            if (!kind) return true;
            const ok = await act(() => api("PUT", `questions/${q.id}/process`, { kind }), "Saved");
            if (ok) await refresh();
            return !!ok;
          },
        };
  // Read-only: hide empty fields nobody can retrieve.
  const shown = names.filter((f) => fc.editable || q.fields[f].value !== undefined || q.fields[f].retrievable);
  const anyRetrievable = names.some((f) => q.fields[f].retrievable);
  return h(
    "section",
    { class: "panel fields" },
    h("h2", null, "Details"),
    h("dl", { class: "meta field-list" }, shown.map((f) => [h("dt", null, FIELD_LABEL[f]), h("dd", null, fieldCell(f, q.fields[f], cellCtx(f)))])),
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

/**
 * What attaching a link will do to each field, given what the link preview retrieves. Mirrors the
 * server (`adoptProcess`): typed values stay, except the kind (a listed tool retrieves it), the status
 * (follows the item; on a first link a typed status other than the default "not started" stays), and,
 * when replacing a link, the typed summary and results link (they described the old one).
 * → [{field, retrieved, typed?, kept}]
 */
function attachEffects(q, replace, preview) {
  const r = retrievedFromPreview(preview);
  const out = [];
  for (const f of ["kind", "status", "summary", "results_url", "start", "end"]) {
    if (r[f] === undefined) continue;
    const view = q.fields[f];
    const typed = view.source === "typed" ? view : null;
    let kept = !!typed;
    if (f === "kind") kept = false;
    else if (f === "status") kept = !!typed && !replace && typed.value?.state !== "not_started";
    else if (f === "summary" || f === "results_url") kept = !!typed && !replace;
    out.push({ field: f, retrieved: f === "status" ? { state: r.status.state, label: S.space.settings.status_labels.find((l) => l.state === r.status.state)?.label } : r[f],
      // The default status a matter without a link gets isn't a choice: not worth mentioning.
      typed: typed && typed.value !== undefined && !(f === "status" && !kept && typed.value?.state === "not_started") ? typed.value : undefined,
      kept,
    });
  }
  return out;
}

/** Under the link field: is the link on the tool list, and what it would retrieve (and what stays typed). */
function attachPreview(q, replace, preview, url) {
  if (preview.existing && preview.existing.id === q.id) return h("p", { class: "muted small" }, "This is already this matter's attached link.");
  if (preview.existing) return h("div", { class: "notice-existing" }, "This link is already tracked by ", h("a", { href: `#/q/${preview.existing.id}` }, preview.existing.title), ": it can't be attached here too.");
  if (!preview.matched) {
    return h(
      "div",
      { class: "notice" },
      h("p", null, "Not on the tool list: the link is kept as a reference, but nothing is retrieved from it. You type the title, status and dates. ", h("a", { href: `#/tools/add-tool${qs({ url })}` }, "Add this tool"), " to retrieve them."),
    );
  }
  const effects = attachEffects(q, replace, preview);
  const f = preview.fetched;
  const typedGone = replace ? ["summary", "results_url"].filter((n) => q.fields[n].source === "typed" && q.fields[n].value !== undefined && q.fields[n].value !== null && !effects.some((e) => e.field === n)) : [];
  return h(
    "div",
    { class: "link-preview" },
    h(
      "p",
      null,
      "✓ Recognised: ",
      toolIcon(S.tools.find((t) => t.id === preview.tool_id) ?? { name: preview.tool_name }), " ",
      h("strong", null, preview.tool_name), " · ", itemLabel(preview.item_type),
      preview.fetch_mode === "manual" ? h("span", { class: "muted" }, " · only the kind and title are retrieved; status and dates stay typed") : null,
    ),
    preview.fetch_error ? h("p", { class: "warn" }, preview.fetch_mode === "manual" ? `${preview.fetch_error}: only the kind and title are retrieved.` : `Couldn't retrieve details right now: ${preview.fetch_error}. It will be retried.`) : null,
    preview.fetch_mode === "auto" && f && !effects.length ? h("p", { class: "muted small" }, "The item gives nothing else for now.") : null,
    effects.length
      ? h(
          "ul",
          { class: "hint-list" },
          effects.map((e) =>
            h(
              "li",
              null,
              h("strong", null, FIELD_LABEL[e.field], ": "),
              showValue(e.field, e.retrieved),
              " ",
              e.kept
                ? h("span", { class: "muted small" }, "· not applied: you typed ", showValue(e.field, e.typed), " (↺ use retrieved is on the matter)")
                : h("span", { class: "muted small" }, e.typed !== undefined && e.typed !== null ? ["· retrieved, replaces what you typed (", showValue(e.field, e.typed), ")"] : "· retrieved, kept up to date"),
            ),
          ),
        )
      : null,
    typedGone.length ? h("p", { class: "muted small" }, `Your typed ${typedGone.map((n) => FIELD_LABEL[n].toLowerCase()).join(" and ")} described the previous link and will be removed.`) : null,
  );
}

/** Attach (or replace) the link of a matter. Without a link, type its kind under Details instead. */
function attachForm(q, replace, prefillUrl) {
  return inlineForm(replace ? "Replace the attached link" : "Add an attached link", replace ? "Replace" : "Add", () => {
    const p = q.process;
    const url = h("input", { type: "url", required: true, placeholder: "https://…", value: prefillUrl ?? p?.url ?? "" });
    const area = h("div", { class: "link-check", "aria-live": "polite" });
    let preview = null;
    let seq = 0;
    const check = debounce(async (v) => {
      const mine = ++seq;
      preview = null;
      if (!v) return area.replaceChildren();
      if (!/^https:\/\//i.test(v)) return area.replaceChildren(h("p", { class: "warn" }, "Only https:// links are accepted."));
      area.replaceChildren(h("p", { class: "muted" }, "Checking the link…"));
      try {
        const r = await api("POST", "resolve-url", { url: v });
        if (mine !== seq) return;
        preview = r;
        area.replaceChildren(attachPreview(q, replace, r, v));
      } catch (e) {
        if (mine === seq) area.replaceChildren(h("p", { class: "error" }, e.message));
      }
    }, 350);
    url.addEventListener("input", () => check(url.value.trim()));
    if (prefillUrl) check(prefillUrl.trim());
    return {
      body: [field("Link", url, "Links from a tool on the list are retrieved: title, status, dates… Any other link works too; its fields are then typed."), area, toolHints()],
      submit: async () => {
        const v = url.value.trim();
        if (!v) throw new Error("Give a link");
        if (preview?.existing && preview.existing.id !== q.id) throw new Error(`This link is already tracked by “${preview.existing.title}”`);
        await api("PUT", `questions/${q.id}/process`, { url: v });
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
    h("ul", null, tools.map((t) => h("li", null, toolIcon(t), " ", h("strong", null, t.name), t.description ? ` — ${t.description}` : null))),
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
      h("p", { class: "muted" }, "No attached link yet. It points to where the matter is worked on: a pull request, a poll, a Polis conversation, a meeting…"),
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
    if (!confirm("Remove the attached link? The matter keeps its title and status, now typed.")) return;
    if (await act(() => api("DELETE", `questions/${q.id}/process`), "Attached link removed")) await refresh();
  };
  const toolLine = custom
    ? h("span", { class: "muted" }, p.url ? ["Not on the tool list: nothing is retrieved. ", canEditQ(q) ? h("a", { href: `#/tools/add-tool${qs({ url: p.url })}` }, "Add this tool") : null] : "No link: everything is typed.")
    : [
        toolIcon(tool ?? { name: p.tool_id }), " ",
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
    { "aria-label": "How this matter relates to the other one", onchange: () => form?.relationChanged() },
    Object.entries(RELATE_AS).map(([v, a]) => h("option", { value: v }, `This matter ${a.menu}…`)),
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
              h("div", { class: "notice rel-hint" }, "This matter duplicates “", h("a", { href: `#/q/${x.id}` }, x.title), "”. Withdraw it, so only one stays active? ", h("button", { onclick: withdraw(q.id, `Duplicate of “${x.title}”`) }, "Withdraw this matter")),
            )),
        ...d.related.filter((x) => x.role === "duplicated_by" && x.status !== "withdrawn").map((x) =>
          h("div", { class: "notice rel-hint" }, "“", h("a", { href: `#/q/${x.id}` }, x.title), "” duplicates this matter. Withdraw it, so only one stays active? ", h("button", { onclick: withdraw(x.id, `Duplicate of “${q.title}”`) }, "Withdraw it")),
        ),
      ];
  form = editable ? composer({ relateTo: q.id, exclude: new Set(d.related.map((x) => x.id)), onRelate: relate, kind: kindNow, placeholder: "Type to find a matter, or add a new one…" }) : null;
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Related matters"),
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
              editable ? [" ", h("button", { class: "link muted small", title: "Remove this relation (both matters stay)", onclick: unrelate(x) }, "unlink")] : null,
            ),
          ),
        )
      : h("p", { class: "muted" }, "None yet."),
    editable ? h("div", { class: "row" }, kindSel) : null,
    form,
  );
}

// ---------------------------------------------------------------- rules

/** The item types a tool handles, once each, in order. */
const toolTypes = (t) => [...new Set(t.url_patterns.map((p) => p.item_type))];

/** What a tool handles: its item types, and on click what is retrieved for each and the exact link patterns. */
function toolHandles(t) {
  return h(
    "details",
    { class: "handles" },
    h("summary", null, toolTypes(t).map(itemLabel).join(" · ") || "—"),
    toolLinksDetail(t),
  );
}

/** Per item type, what is retrieved (automatic tools), and the link patterns, as code. */
function toolLinksDetail(t) {
  return h(
    "div",
    { class: "handles-detail small" },
    toolTypes(t).map((type) =>
      h(
        "div",
        { class: "handles-type" },
        h("strong", null, itemLabel(type)),
        t.retrieves?.[type] ? h("div", { class: "muted" }, `${t.fetch_mode === "auto" ? "Retrieves" : "Would retrieve, once the server is set up"}: ${t.retrieves[type].join(", ")}.`) : null,
        t.url_patterns.filter((p) => p.item_type === type).map((p) => h("div", null, h("code", null, p.pattern))),
      ),
    ),
  );
}

async function pageRules(sub, params) {
  if (sub === "add-tool") return toolFormPage({ url: params.get("url") });
  if (sub === "tool") {
    const tool = S.tools.find((t) => t.id === params.get("id"));
    if (!tool) throw new Error("Unknown tool");
    return toolFormPage({ tool });
  }
  const updates = (t) =>
    t.fetch_mode === "auto"
      ? h("span", null, "Automatic")
      : h("span", null, "By hand", h("div", { class: "muted small" }, t.auto_unavailable ? "Kind and title only: more needs server setup" : "Kind and page title only"));
  const used = (u, href) =>
    u?.questions ? h("a", { href }, `${u.questions} matter${u.questions === 1 ? "" : "s"}`, u.in_progress ? ` · ${u.in_progress} in progress` : "") : h("span", { class: "muted" }, "—");
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
      h("p", { class: "muted" }, "Links from these tools can be attached to a matter, and their fields retrieved. Any other link, or none, makes it a custom tool, described by hand. Anyone with edit access can add a tool; no vote needed."),
      canEdit() ? h("p", null, h("a", { class: "button", href: "#/tools/add-tool" }, "Add a tool")) : null,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Handles"), h("th", null, "Updates"), canEdit() ? h("th", null, "Actions") : null)),
          h(
            "tbody",
            null,
            S.tools.map((t) =>
              h(
                "tr",
                { class: t.enabled ? "" : "disabled" },
                h(
                  "td",
                  { class: "tool-cell" },
                  h("span", { class: "tool-name" }, toolIcon(t), h("strong", null, t.name), t.enabled ? null : h("span", { class: "badge" }, "disabled")),
                  t.description ? h("div", { class: "muted small" }, t.description) : null,
                  h("div", { class: "small" }, t.usage?.questions ? used(t.usage, `#/list${qs({ lane: "all", tool: t.id })}`) : h("span", { class: "muted" }, "Not used yet")),
                ),
                h("td", null, toolHandles(t)),
                h("td", null, updates(t)),
                canEdit()
                  ? h(
                      "td",
                      { class: "nowrap" },
                      h("a", { class: "link", href: `#/tools/tool${qs({ id: t.id })}` }, "Edit"),
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
          h("h2", null, "Custom tools in use"),
          h("p", { class: "muted" }, "Tools described by hand (meetings, assemblies…), by kind. Offered as suggestions when attaching a custom tool."),
          h("ul", { class: "rel-list" }, customKinds.map((k) => h("li", null, h("strong", null, k.kind), " · ", used(k, `#/list${qs({ lane: "all", tool: CUSTOM_TOOL_ID, item_type: k.kind })}`)))),
        )
      : null,
    statusLabelsPanel(),
  );
}

/** "About": the group's own "About this group" text, then the app's help (the same for every space). */
function pageHow() {
  return h(
    "div",
    null,
    backToItems(),
    h("h1", null, "About"),
    aboutPanel(),
    h("section", { class: "panel help" }, helpSections(S.space.settings.status_labels)),
  );
}

/** The group's own text: what it is and how it uses this space. Hidden when empty, unless you can write it. */
function aboutPanel() {
  const text = (S.space.charter_markdown ?? "").trim();
  if (!text && !canEdit()) return null;
  const panel = h("section", { class: "panel about" });
  const show = () =>
    panel.replaceChildren(
      h("h2", null, "About this group"),
      text ? renderMarkdown(text) : h("p", { class: "muted" }, "Nothing here yet. Say what this group is, and how it uses this space: who takes part, which tools you use, how decisions get made."),
      canEdit() ? h("div", { class: "row" }, h("button", { onclick: edit }, text ? "Edit" : "Add a description")) : null,
    );
  const edit = () => {
    const area = h("textarea", { rows: 8, maxlength: 5000, value: text, "aria-label": "About this group", placeholder: "e.g. We're the tenants' association of Rue X. Proposals for the monthly general assembly go here first; polls run in Loomio." });
    const save = h("button", { type: "submit", class: "primary" }, "Save");
    panel.replaceChildren(
      h("h2", null, "About this group"),
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            save.disabled = true;
            const r = await act(() => api("PUT", "settings/about", { markdown: area.value }), "Saved");
            save.disabled = false;
            if (r) await refresh();
          },
        },
        h("p", { class: "muted small" }, "What this group is, and how it uses this space. Anyone with the edit link can change it, and changes are recorded in Activity. Basic Markdown works (headings, lists, **bold**, links)."),
        area,
        h("div", { class: "row" }, save, h("button", { type: "button", onclick: show }, "Cancel")),
      ),
    );
    area.focus();
  };
  show();
  return panel;
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
      h("p", { class: "muted small" }, "The words your group uses for a status, and the category each one counts as. Offered when setting a status by hand, and for custom tools. Keep at least one “Not started” label: new matters get the first one. Renaming a label doesn't change matters that already use it."),
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
    h("p", { class: "muted" }, "Every matter is in one of these categories. A matter follows its attached link, or its status is set by hand using these labels (also used for custom tools)."),
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
    h("p", { class: "muted small" }, "From these links, the kind (the item type above) and the page title are retrieved. Their status and dates are typed on each matter, with the space's status labels."),
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
    h("a", { href: "#/tools", class: "back" }, "← Tools"),
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
              location.hash = "#/tools";
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
      auto
        ? h(
            "div",
            { class: "field" },
            h("span", { class: "label" }, "Links accepted"),
            toolLinksDetail(tool),
            h("span", { class: "hint" }, "A built-in reader understands these links, so they can't be changed. To accept other links, add a separate tool."),
          )
        : null,
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
    // Feeds are built on the view link, which the edit link also knows (S.view_token): subscribing never uses the edit link.
    subscribeToken()
      ? h(
          "p",
          null,
          "Subscribe in a feed reader: ",
          h("a", { href: `/feed/${subscribeToken()}.atom` }, "Atom feed"),
          ". Start and end dates in your calendar app: ",
          h("a", { href: `/feed/${subscribeToken()}.ics` }, "calendar (ICS)"),
          " (copy the link and add it as a subscription).",
          h("span", { class: "muted small" }, " Both contain this space's view link: share with care."),
        )
      : h("p", { class: "muted small" }, "An Atom feed and a calendar of start and end dates need this space's view link. Create one from Share… in the menu."),
    h("section", { class: "panel" }, list, more),
  );
}

boot();
