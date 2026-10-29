// Question register — single-page UI. Hash routes:
//   #/list?lane=active&q=…   home (lanes, search, filters)
//   #/q/<id>                 question page
//   #/rules                  charter, tool list, settings; #/rules/add-tool?url=…
//   #/activity               activity feed
import { api, qs, getName, setName, TOKEN, ApiError } from "./api.js";
import { h, extLink, fmtDate, fmtDuration, time, timeAgo, toast, debounce } from "./dom.js";
import { STATUS, STATE, TRIGGER, TERMINAL, itemLabel, criteriaSummary } from "./labels.js";
import { statusPill, statePill, processChip, questionCard, criteriaEditor, activityItem, toolName } from "./components.js";
import { renderMarkdown } from "./md.js";

const app = document.getElementById("app");
const S = { space: null, role: "view", tools: [], counts: {}, active_count: 0, since: null };
const canEdit = () => S.role === "edit";

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
  if (!parts[0] || parts[0] === "list") document.getElementById("composer-input")?.focus({ preventScroll: true });
}

/** Re-load space counts and re-render the current page. */
async function refresh() {
  await loadSpace();
  await render();
}

function header(section, params) {
  const c = S.counts.main ?? {};
  const lane = params.get("lane") ?? (section === "list" && ![...params.keys()].length ? "active" : null);
  const tab = (key, label, href) =>
    h("a", { href, class: `tab${(section === "list" && lane === key) || (section === key && !lane) ? " current" : ""}`, "aria-current": section === "list" && lane === key ? "page" : null }, label);
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-row" },
      h("a", { href: "#/list?lane=active", class: "space-name" }, S.space.name),
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
      tab("inbox", `Pool (${c.inbox ?? 0})`, "#/list?lane=inbox"),
      tab("active", `Active (${S.active_count}/${S.space.settings.active_cap})`, "#/list?lane=active"),
      tab("standing", `Standing (${c.standing ?? 0})`, "#/list?lane=standing"),
      tab("resolved", `Resolved (${c.resolved ?? 0})`, "#/list?lane=resolved"),
      tab("archive", `Archive (${(c.dormant ?? 0) + (c.dropped ?? 0)})`, "#/list?lane=archive"),
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

const LANE_STATUS = { inbox: "inbox", active: "active", standing: "standing", resolved: "resolved", archive: "dormant,dropped", all: "" };
const PRESETS = [
  ["no_process", "No process yet"],
  ["criteria_tbd", "Criteria TBD"],
  ["ready", "Ready to resolve"],
  ["objections", "Objections open"],
];

async function pageHome(params) {
  const searching = params.get("q") || params.get("preset") || params.get("tool") || params.get("state") || params.get("mode") || params.get("has_process") || params.get("steward") || params.get("parent");
  const lane = params.get("lane") ?? (searching ? "all" : "active");
  const section = params.get("section") ?? "main";
  const query = {
    status: LANE_STATUS[lane] ?? "",
    section: section === "all" ? "" : section,
    q: params.get("q"),
    preset: params.get("preset"),
    tool: params.get("tool"),
    item_type: params.get("item_type"),
    state: params.get("state"),
    mode: params.get("mode"),
    has_process: params.get("has_process"),
    steward: params.get("steward"),
    parent: params.get("parent"),
  };
  const { questions } = await api("GET", `questions${qs(query)}`);

  const setParam = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    location.hash = `#/list?${p}`;
  };

  const searchInput = h("input", { type: "search", placeholder: "Search questions…", value: params.get("q") ?? "", "aria-label": "Search questions" });
  const searchForm = h("form", { class: "search", role: "search", onsubmit: (e) => (e.preventDefault(), setParam("q", searchInput.value.trim())) }, searchInput, h("button", { type: "submit" }, "Search"));

  const sel = (key, label, options) =>
    field(
      label,
      h(
        "select",
        { onchange: (e) => setParam(key, e.target.value) },
        h("option", { value: "" }, "Any"),
        options.map(([v, l]) => h("option", { value: v, selected: params.get(key) === v }, l)),
      ),
    );
  const itemTypes = [...new Set(S.tools.flatMap((t) => t.url_patterns.map((p) => p.item_type)))];
  const filters = h(
    "details",
    { class: "filters", open: !!(query.tool || query.state || query.mode || query.has_process || query.steward || query.item_type || params.get("section") || params.get("lane") === "all") },
    h("summary", null, "Filters"),
    h(
      "div",
      { class: "filter-grid" },
      sel("lane", "Status", [["all", "All"], ...Object.keys(LANE_STATUS).filter((k) => k !== "all").map((k) => [k, k === "archive" ? "Archive (dormant, dropped)" : STATUS[k].label])]),
      sel("section", "Section", [["main", "Main"], ["rules", "Rules"], ["all", "Both"]]),
      sel("tool", "Tool", S.tools.map((t) => [t.id, t.name])),
      sel("item_type", "Item type", itemTypes.map((t) => [t, itemLabel(t)])),
      sel("state", "Process state", Object.entries(STATE)),
      sel("mode", "Answer criteria", [["tbd", "Not decided"], ["open", "Open-ended"], ["criteria", "Set"]]),
      sel("has_process", "Has a process", [["yes", "Yes"], ["no", "No"]]),
      field("Steward", h("input", { type: "text", value: params.get("steward") ?? "", onchange: (e) => setParam("steward", e.target.value.trim()) })),
    ),
  );
  const presets = h(
    "div",
    { class: "presets", role: "group", "aria-label": "Curator shortcuts" },
    PRESETS.map(([k, l]) => h("button", { type: "button", class: `chip-btn${params.get("preset") === k ? " on" : ""}`, "aria-pressed": params.get("preset") === k ? "true" : "false", onclick: () => setParam("preset", params.get("preset") === k ? "" : k) }, l)),
  );

  const parentChip = params.get("parent") ? h("p", null, "Showing questions related to another · ", h("a", { href: `#/q/${params.get("parent")}` }, "open it"), " · ", h("button", { class: "link", onclick: () => setParam("parent", "") }, "clear")) : null;
  const laneInfo = lane === "active" ? h("p", { class: "muted" }, `${S.active_count} of ${S.space.settings.active_cap} active slots used.`) : null;
  const ctx = { tools: S.tools, since: S.since, space: S.space };
  const list = questions.length
    ? h("ul", { class: "cards" }, questions.map((q) => questionCard(q, ctx)))
    : h("p", { class: "empty" }, searching ? "No questions match." : lane === "inbox" ? "The pool is empty." : "Nothing here yet.");

  return h("div", null, canEdit() ? composer() : null, h("div", { class: "toolbar" }, searchForm, presets), filters, parentChip, laneInfo, list);
}

/** "Ask a question, or paste a link." */
function composer(opts = {}) {
  const input = h("input", { id: opts.parentId ? null : "composer-input", type: "text", maxlength: 2000, placeholder: opts.placeholder ?? "Ask a question, or paste a link.", autocomplete: "off", "aria-label": "Ask a question, or paste a link" });
  const panel = h("div", { class: "composer-panel" });
  let mode = "idle"; // idle | text | link
  let preview = null;

  const why = h("textarea", { rows: 2, placeholder: "Why it matters (optional)" });
  const framing = h("textarea", { rows: 2, placeholder: "Framing (optional): how this process interprets the question, and its limits" });
  const title = h("input", { type: "text", maxlength: 300 });
  const hints = h("div", { class: "hints" });
  const submitBtn = h("button", { type: "submit", class: "primary" }, "Add to the pool");

  const loadHints = debounce(async (t) => {
    if (t.length < 4) return hints.replaceChildren();
    try {
      const { similar } = await api("GET", `similar${qs({ title: t })}`);
      hints.replaceChildren(
        similar.length
          ? h("div", null, h("span", { class: "muted small" }, "Already asked? "), h("ul", { class: "hint-list" }, similar.map((s) => h("li", null, h("a", { href: `#/q/${s.id}` }, s.title), " ", statusPill(s.status)))))
          : "",
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
    mode = "link";
    title.value = preview.fetched?.title ?? "";
    title.placeholder = "Write the question in the group's words";
    loadHints(title.value);
    panel.replaceChildren(
      h(
        "div",
        { class: "link-preview" },
        h("strong", null, preview.tool_name), " · ", itemLabel(preview.item_type),
        preview.fetched ? [" · ", statePill(preview.fetched.state), preview.fetched.outcome_summary ? ` ${preview.fetched.outcome_summary}` : ""] : preview.fetch_mode === "manual" ? h("span", { class: "muted" }, " · state is updated by hand") : null,
        preview.fetch_error ? h("p", { class: "warn" }, `Couldn't fetch details: ${preview.fetch_error}`) : null,
      ),
      field("Question", title, "Prefilled from the linked item when possible. Edit it into the group's own words."),
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
        const body = { why_it_matters: why.value, parent_id: opts.parentId, section: opts.section };
        if (mode === "link") Object.assign(body, { title: title.value, process_url: v, framing: framing.value });
        else body.title = v;
        submitBtn.disabled = true;
        const r = await act(() => api("POST", "questions", body), "Added to the pool");
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
  const isSteward = q.steward && getName() && q.steward.toLowerCase() === getName().toLowerCase();
  const formSlot = h("div", { class: "form-slot" });
  const openForm = (f) => {
    formSlot.replaceChildren(f);
    f.scrollIntoView({ behavior: "smooth", block: "nearest" });
    f.querySelector("input:not([type=radio]):not([type=checkbox]), textarea, select")?.focus();
  };

  const meta = h(
    "dl",
    { class: "meta" },
    h("dt", null, "Steward"),
    h("dd", null, q.steward ?? h("span", { class: "muted" }, "nobody yet")),
    h("dt", null, "Added"),
    h("dd", null, q.created_by, " · ", time(q.created_at)),
    d.parent ? [h("dt", null, "Related to"), h("dd", null, h("a", { href: `#/q/${d.parent.id}` }, d.parent.title))] : null,
    d.duplicate_of ? [h("dt", null, "Same as"), h("dd", null, h("a", { href: `#/q/${d.duplicate_of.id}` }, d.duplicate_of.title))] : null,
    q.status === "dropped" && q.drop_reason ? [h("dt", null, "Dropped because"), h("dd", null, q.drop_reason)] : null,
  );

  const top = h(
    "div",
    { class: "q-head" },
    h("a", { href: q.section === "rules" ? "#/rules" : `#/list?lane=${q.status === "dormant" || q.status === "dropped" ? "archive" : q.status}`, class: "back" }, "← Back"),
    h("h1", null, q.title),
    h("div", { class: "row" }, statusPill(q.status), q.section === "rules" ? h("span", { class: "badge rules" }, "Rules question") : null),
    q.why_it_matters ? h("p", { class: "why" }, q.why_it_matters) : null,
    meta,
  );

  return h(
    "div",
    { class: "question" },
    top,
    resolutionBlock(q, d, isSteward, openForm),
    q.rules_payload ? payloadBlock(q.rules_payload) : null,
    processBlock(q, d, isSteward, openForm),
    canEdit() ? actionsBlock(q, d, isSteward, openForm) : null,
    formSlot,
    relationsBlock(q, d),
    h("section", { class: "panel" }, h("h2", null, "History"), h("ul", { class: "activity" }, d.activity.map((e) => activityItem(e)))),
  );
}

function resolutionBlock(q, d, isSteward, openForm) {
  const parts = [h("h2", null, "Answered when…"), h("p", { class: "criteria" }, criteriaSummary(q.resolution, q.process, S.space.settings.default_rule_days))];
  const openObj = d.objections.filter((o) => !o.addressed_at);

  if (q.default_window && q.status === "active") {
    const w = q.default_window;
    if (openObj.length || w.paused_remaining_ms != null)
      parts.push(h("p", { class: "window paused" }, `⏸ Objection window paused: ${openObj.length} open objection${openObj.length === 1 ? "" : "s"}. The steward can address them or change the criteria.`));
    else {
      const left = new Date(w.ends_at).getTime() - Date.now();
      parts.push(h("p", { class: "window" }, left > 0 ? ["⏳ Objection window ends in ", h("strong", null, fmtDuration(left)), ` (${fmtDate(w.ends_at)})`] : "⏳ Objection window has closed; checking shortly."));
    }
  }

  if (d.objections.length) {
    parts.push(
      h(
        "ul",
        { class: "objections" },
        d.objections.map((o) =>
          h(
            "li",
            { class: o.addressed_at ? "addressed" : "open" },
            h("div", null, h("strong", null, o.addressed_at ? "Addressed objection" : "✋ Objection"), " by ", o.raised_by, " · ", time(o.raised_at, timeAgo(o.raised_at))),
            h("blockquote", null, o.reason),
            o.addressed_at
              ? h("p", { class: "muted" }, `${o.addressed_by}: “${o.address_note}”`)
              : canEdit() && (isSteward || !q.steward)
                ? h(
                    "button",
                    {
                      onclick: () =>
                        openForm(
                          inlineForm("Address this objection", "Mark as addressed", () => {
                            const note = h("textarea", { rows: 3, required: true, placeholder: "What changed, or why you're going ahead" });
                            return {
                              body: [h("blockquote", null, o.reason), field("Your note", note, "When all objections are addressed, the window resumes.")],
                              submit: () => act(() => api("POST", `questions/${q.id}/address`, { objection_id: o.id, note: note.value }), "Objection addressed"),
                            };
                          }),
                        ),
                    },
                    "Address",
                  )
                : null,
          ),
        ),
      ),
    );
  }

  if (q.pending_resolution) {
    const p = q.pending_resolution;
    const canConfirm = canEdit() && (isSteward || !q.steward || d.steward_inactive);
    parts.push(
      h(
        "div",
        { class: "ready" },
        h("p", null, h("strong", null, "⏵ Ready to resolve: "), TRIGGER[p.triggered_by], " (", time(p.triggered_at, timeAgo(p.triggered_at)), ")."),
        canConfirm
          ? h("button", { class: "primary", onclick: () => openForm(confirmForm(q)) }, "Confirm resolution…")
          : h("p", { class: "muted" }, `Waiting for the steward (${q.steward}) to confirm. Anyone can confirm if they've been inactive for 7 days.`),
      ),
    );
  }

  const rec = q.resolution_record;
  if (q.status === "resolved" && rec) {
    const snap = rec.snapshot?.process;
    parts.push(
      h(
        "div",
        { class: "record" },
        h("p", null, h("strong", null, "✔ Resolved"), " ", time(rec.resolved_at), " because ", TRIGGER[rec.triggered_by], ". Confirmed by ", rec.confirmed_by === "system" ? "the system (clear outcome)" : rec.confirmed_by, "."),
        rec.outcome ? h("p", null, "Outcome: ", statePill(rec.outcome)) : null,
        rec.attested ? h("p", null, "Attested: “", rec.attested, "”") : null,
        rec.synthesis ? h("div", { class: "synthesis" }, h("h3", null, "What we concluded"), renderMarkdown(rec.synthesis)) : null,
        h(
          "details",
          null,
          h("summary", null, "Snapshot at resolution"),
          h(
            "dl",
            { class: "meta" },
            h("dt", null, "Question"),
            h("dd", null, rec.snapshot.question.title),
            rec.snapshot.question.framing ? [h("dt", null, "Framing"), h("dd", null, rec.snapshot.question.framing)] : null,
            snap ? [h("dt", null, "Process"), h("dd", null, extLink(snap.url, snap.fetched?.title ?? snap.url))] : null,
            snap?.fetched ? [h("dt", null, "State then"), h("dd", null, statePill(snap.fetched.state), " ", snap.fetched.outcome_summary ?? "", " · fetched ", fmtDate(snap.fetched.fetched_at))] : null,
            snap?.fetched?.extra ? [h("dt", null, "Details"), h("dd", null, Object.entries(snap.fetched.extra).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · "))] : null,
          ),
        ),
      ),
    );
  }
  return h("section", { class: "panel" }, parts);
}

function confirmForm(q) {
  return inlineForm("Confirm the resolution", "Confirm", () => {
    const synthesis = h("textarea", { rows: 4, placeholder: "Optional: the group's own statement of the answer (markdown allowed)" });
    const suggested = q.pending_resolution.suggested_outcome ?? "concluded";
    const outcome = h("select", null, TERMINAL.map((s) => h("option", { value: s, selected: s === suggested }, STATE[s])));
    return {
      body: [
        field("Outcome", outcome, q.rules_payload ? "Rules proposals are applied only when the outcome is “accepted”." : "Suggested from what triggered the resolution; change it if the outcome was different."),
        field("Synthesis", synthesis),
      ],
      submit: () => act(() => api("POST", `questions/${q.id}/confirm`, { synthesis: synthesis.value, outcome: outcome.value }), "Resolved"),
    };
  });
}

function payloadBlock(p) {
  let body;
  if (p.kind === "add_tool")
    body = [
      h("p", null, "If accepted, this tool is added to the tool list: ", h("strong", null, p.tool.name), " (updated by hand)."),
      h("ul", null, p.tool.url_patterns.map((u) => h("li", null, h("code", null, u.pattern), " → ", itemLabel(u.item_type)))),
      p.tool.state_map ? h("p", { class: "muted" }, "States: ", Object.entries(p.tool.state_map).map(([k, v]) => `${k} (${STATE[v]})`).join(", ")) : null,
    ];
  else if (p.kind === "change_charter")
    body = [
      p.settings ? h("p", null, "If accepted, these settings change: ", Object.entries(p.settings).map(([k, v]) => `${k.replace(/_/g, " ")} → ${v}`).join(", ")) : null,
      p.charter_markdown ? h("details", null, h("summary", null, "Proposed charter text"), renderMarkdown(p.charter_markdown)) : null,
    ];
  else if (p.kind === "set_tool_enabled") body = h("p", null, `If accepted, the tool “${toolName(S.tools, p.tool_id)}” is ${p.enabled ? "enabled" : "disabled"}.`);
  return h("section", { class: "panel proposal" }, h("h2", null, "Proposal"), body);
}

function processBlock(q, d, isSteward, openForm) {
  const p = q.process;
  const closed = q.status === "resolved" || q.status === "dropped";
  const attachForm = (replace) =>
    inlineForm(replace ? "Replace the linked process" : "Link a process", replace ? "Replace" : "Link", () => {
      const url = h("input", { type: "url", required: true, placeholder: "https://…", value: "" });
      const framing = h("textarea", { rows: 2, placeholder: "Optional", value: p?.framing ?? "" });
      return {
        body: [
          field("Link", url, `Accepted tools: ${S.tools.filter((t) => t.enabled).map((t) => t.name).join(", ")}.`),
          field("Framing", framing, "How this process interprets the question, and its limits."),
        ],
        submit: async () => {
          try {
            await api("PUT", `questions/${q.id}/process`, { url: url.value, framing: framing.value });
            toast("Process linked", "ok");
            return true;
          } catch (e) {
            if (e.code === "unknown_tool") {
              toast("That link isn't from a listed tool. You can add the tool in Rules.", "error");
              location.hash = `#/rules/add-tool${qs({ url: url.value })}`;
              return false;
            }
            throw e;
          }
        },
      };
    });

  if (!p) {
    return h(
      "section",
      { class: "panel" },
      h("h2", null, "Process"),
      h("p", { class: "muted" }, "No process linked. A process is the place where the question is worked on: a pull request, a poll, a forecast…"),
      canEdit() && !closed ? h("button", { onclick: () => openForm(attachForm(false)) }, "Link a process…") : null,
    );
  }
  const f = p.fetched;
  const tool = d.tool;
  const extra = f?.extra ? Object.entries(f.extra).filter(([k]) => k !== "results_url") : [];
  const manualForm = () =>
    inlineForm("Update the process state", "Save", () => {
      const states = tool?.state_map ? Object.entries(tool.state_map) : [];
      const select = h(
        "select",
        { required: true },
        h("option", { value: "" }, "Choose…"),
        states.map(([label, st]) => h("option", { value: `${st}|${label}`, selected: f?.raw_state === label }, `${label} (${STATE[st]})`)),
        h("optgroup", { label: "Other" }, Object.entries(STATE).map(([st, l]) => h("option", { value: `${st}|`, selected: !states.length && f?.state === st }, l))),
      );
      const summary = h("input", { type: "text", maxlength: 300, value: f?.outcome_summary ?? "", placeholder: "e.g. 63% yes, 41 votes" });
      const results = h("input", { type: "url", value: f?.extra?.results_url ?? "", placeholder: "https://… (report, results page)" });
      return {
        body: [field("State", select), field("Outcome summary", summary, "Optional, shown on cards."), field("Link to results", results, "Optional.")],
        submit: () => {
          const [state, raw] = select.value.split("|");
          return act(() => api("POST", `questions/${q.id}/process/manual`, { state, raw_state: raw || undefined, outcome_summary: summary.value, results_url: results.value }), "State updated");
        },
      };
    });

  return h(
    "section",
    { class: "panel process" },
    h("h2", null, "Process"),
    h("p", null, h("strong", null, toolName(S.tools, p.tool_id)), " · ", itemLabel(p.item_type), " · ", extLink(p.url, f?.title ?? "open the link ↗")),
    h(
      "dl",
      { class: "meta" },
      h("dt", null, "State"),
      h("dd", null, f ? [statePill(f.state), f.outcome_summary ? ` ${f.outcome_summary}` : "", f.raw_state && f.raw_state !== f.outcome_summary ? h("span", { class: "muted" }, ` (${f.raw_state})`) : ""] : h("span", { class: "muted" }, "not set yet")),
      f?.dates?.opens_at ? [h("dt", null, "Opened"), h("dd", null, time(f.dates.opens_at))] : null,
      f?.dates?.closes_at ? [h("dt", null, "Closes"), h("dd", null, time(f.dates.closes_at))] : null,
      f?.dates?.resolved_at ? [h("dt", null, "Ended"), h("dd", null, time(f.dates.resolved_at))] : null,
      extra.length ? [h("dt", null, "Details"), h("dd", null, extra.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · "))] : null,
      f?.extra?.results_url ? [h("dt", null, "Results"), h("dd", null, extLink(String(f.extra.results_url)))] : null,
      p.framing ? [h("dt", null, "Framing"), h("dd", null, p.framing)] : null,
      h("dt", null, p.fetch_mode === "auto" ? "Last checked" : "Updated"),
      h("dd", null, f ? time(f.fetched_at, timeAgo(f.fetched_at)) : "never", p.fetch_mode === "manual" ? h("span", { class: "muted" }, " · updated by hand") : ""),
      f?.fetch_error ? [h("dt", null, "Problem"), h("dd", { class: "warn" }, f.fetch_error)] : null,
      tool && !tool.enabled ? [h("dt", null, "Note"), h("dd", { class: "warn" }, "This tool is disabled; the state is no longer refreshed.")] : null,
    ),
    canEdit() && !closed
      ? h(
          "div",
          { class: "row" },
          p.fetch_mode === "auto"
            ? h("button", { onclick: async () => { const r = await act(() => api("POST", `questions/${q.id}/process/refresh`)); if (r) { toast(r.refresh?.error ? `Refresh failed: ${r.refresh.error}` : r.refresh?.skipped ? `Not refreshed: ${r.refresh.skipped}` : r.refresh?.changed ? "State changed" : "No change", r.refresh?.error ? "error" : "ok"); await refresh(); } } }, "↻ Refresh")
            : isSteward || !q.steward
              ? h("button", { onclick: () => openForm(manualForm()) }, "Update state…")
              : null,
          h(
            "button",
            {
              onclick: () =>
                openForm(
                  inlineForm("Edit framing", "Save", () => {
                    const t = h("textarea", { rows: 3, value: p.framing ?? "" });
                    return { body: field("Framing", t, "How this process interprets the question, and its limits."), submit: () => act(() => api("PATCH", `questions/${q.id}/process`, { framing: t.value }), "Saved") };
                  }),
                ),
            },
            "Edit framing",
          ),
          h("button", { onclick: () => openForm(attachForm(true)) }, "Replace link…"),
          h(
            "button",
            {
              class: "danger-link",
              onclick: async () => {
                if (!confirm("Remove the linked process? Its outcome criterion is removed too.")) return;
                if (await act(() => api("DELETE", `questions/${q.id}/process`), "Process removed")) await refresh();
              },
            },
            "Remove",
          ),
        )
      : null,
  );
}

function actionsBlock(q, d, isSteward, openForm) {
  const btns = [];
  const btn = (label, onclick, cls) => btns.push(h("button", { class: cls, onclick }, label));
  const steward = isSteward || !q.steward;
  const others = async () => (await api("GET", "questions")).questions.filter((x) => x.id !== q.id);

  const reasonForm = (title, submitLabel, path, success, required = true, extra) =>
    inlineForm(title, submitLabel, () => {
      const reason = h("textarea", { rows: 2, required });
      return { body: [extra?.text ? h("p", null, extra.text) : null, field(required ? "Reason" : "Reason (optional)", reason)], submit: () => act(() => api("POST", `questions/${q.id}/${path}`, { reason: reason.value }), success) };
    });

  const adoptForm = () =>
    inlineForm("Adopt this question", "Adopt", () => {
      const ed = criteriaEditor({ resolution: q.resolution.mode === "tbd" ? { mode: "criteria", criteria: q.section === "rules" ? [{ kind: "default_rule" }] : [] } : q.resolution, hasProcess: !!q.process, section: q.section, defaultDays: S.space.settings.default_rule_days, allowModes: ["criteria", "open"] });
      return {
        body: [
          h("p", null, "You'll become the steward: you keep it moving, answer objections and confirm the resolution. Say what will count as an answer."),
          q.section === "main" ? h("p", { class: "muted" }, `${S.active_count}/${S.space.settings.active_cap} active slots used.`) : null,
          ed.el,
        ],
        submit: () => act(() => api("POST", `questions/${q.id}/adopt`, { resolution: ed.value() }), "Adopted"),
      };
    });

  const criteriaForm = (modes) =>
    inlineForm("Answer criteria", "Save", () => {
      const ed = criteriaEditor({ resolution: q.resolution, hasProcess: !!q.process, section: q.section, defaultDays: S.space.settings.default_rule_days, allowModes: modes });
      return { body: ed.el, submit: () => act(() => api("PUT", `questions/${q.id}/resolution`, ed.value()), "Criteria saved") };
    });

  switch (q.status) {
    case "inbox":
      btn("Adopt…", () => openForm(adoptForm()), "primary");
      btn("Set criteria…", () => openForm(criteriaForm(["tbd", "open", "criteria"])));
      break;
    case "active":
      if (q.default_window) btn("Object…", () => openForm(inlineForm("Object", "Raise objection", () => {
        const reason = h("textarea", { rows: 3, required: true, placeholder: "What's your concern?" });
        return { body: [h("p", null, "An objection pauses the default rule until the steward addresses it."), field("Reason", reason)], submit: () => act(() => api("POST", `questions/${q.id}/object`, { reason: reason.value }), "Objection recorded") };
      })));
      if (steward && q.resolution.criteria.some((c) => c.kind === "attested"))
        btn("Attest…", () => openForm(inlineForm("Attest that the condition is met", "Attest and resolve", () => {
          const c = q.resolution.criteria.find((c) => c.kind === "attested");
          const att = h("textarea", { rows: 2, required: true, placeholder: "What happened, when, who was there…" });
          const outcome = h("select", null, TERMINAL.map((s) => h("option", { value: s, selected: s === "accepted" }, STATE[s])));
          const syn = h("textarea", { rows: 3, placeholder: "Optional: the group's own statement of the answer" });
          return { body: [h("p", null, "Condition: “", c.description, "”"), field("What you're attesting", att), field("Outcome", outcome), field("Synthesis", syn)], submit: () => act(() => api("POST", `questions/${q.id}/attest`, { attested: att.value, outcome: outcome.value, synthesis: syn.value }), "Resolved") };
        })), "primary");
      if (steward) btn("Change criteria…", () => openForm(criteriaForm(["criteria"])));
      if (steward) btn("Park", () => openForm(reasonForm("Park this question", "Park", "park", "Parked", false, { text: "Parked questions go to the archive (dormant) and free an active slot. Anyone can bring them back." })));
      break;
    case "standing":
      if (steward) btn("Make active…", () => openForm(inlineForm("Make it active", "Make active", () => {
        const ed = criteriaEditor({ resolution: { mode: "criteria", criteria: [] }, hasProcess: !!q.process, section: q.section, defaultDays: S.space.settings.default_rule_days, allowModes: ["criteria"] });
        return { body: ed.el, submit: () => act(() => api("POST", `questions/${q.id}/activate`, { resolution: ed.value() }), "Now active") };
      })), "primary");
      if (steward) btn("Park", () => openForm(reasonForm("Park this question", "Park", "park", "Parked", false)));
      break;
    case "dormant":
      btn("Adopt…", () => openForm(adoptForm()), "primary");
      btn("Back to the pool", async () => (await act(() => api("POST", `questions/${q.id}/revive`), "Back in the pool")) && refresh());
      btn("Set criteria…", () => openForm(criteriaForm(["tbd", "open", "criteria"])));
      break;
    case "resolved":
      btn("Reopen…", () => openForm(reasonForm("Reopen this question", "Reopen", "reopen", "Reopened", true, { text: "The current resolution stays in the history. The active limit applies." })));
      break;
    case "dropped":
      btn("Restore to the pool…", () => openForm(reasonForm("Restore to the pool", "Restore", "restore", "Restored")));
      break;
  }

  if (q.steward && isSteward)
    btn("Hand over…", () => openForm(inlineForm("Hand over stewardship", "Hand over", () => {
      const to = h("input", { type: "text", maxlength: 60, placeholder: "Their display name (leave empty for nobody)" });
      return { body: [field("New steward", to, q.status === "active" || q.status === "standing" ? "With nobody, the question goes back to the pool." : undefined)], submit: () => act(() => api("POST", `questions/${q.id}/hand_over`, { to: to.value }), "Stewardship handed over") };
    })));
  if (q.status !== "inbox" && q.status !== "dropped" && !isSteward) btn(q.steward ? "Take over stewardship" : "Become steward", async () => (await act(() => api("POST", `questions/${q.id}/take_over`), "You're the steward now")) && refresh());

  if (q.status !== "resolved" && q.status !== "dropped" && steward)
    btn("Drop…", () => openForm(inlineForm("Drop this question", "Drop", () => {
      const reason = h("textarea", { rows: 2, required: true, placeholder: "Duplicate, out of scope, withdrawn…" });
      const dup = h("select", null, h("option", { value: "" }, "Loading…"));
      others().then((list) => dup.replaceChildren(h("option", { value: "" }, "— not a duplicate —"), list.filter((x) => x.status !== "dropped").map((x) => h("option", { value: x.id }, x.title))));
      return { body: [field("Reason", reason), field("Same as… (optional)", dup, "If it's a duplicate, choose the original.")], submit: () => act(() => api("POST", `questions/${q.id}/drop`, { reason: reason.value, duplicate_of_id: dup.value || undefined }), "Dropped") };
    }, { danger: true })), "danger-link");

  btn("Edit…", () => openForm(inlineForm("Edit question", "Save", () => {
    const title = h("input", { type: "text", required: true, maxlength: 300, value: q.title });
    const why = h("textarea", { rows: 3, value: q.why_it_matters ?? "" });
    const parent = h("select", null, h("option", { value: q.parent_id ?? "" }, "Loading…"));
    others().then((list) => parent.replaceChildren(h("option", { value: "" }, "— none —"), list.filter((x) => x.status !== "dropped").map((x) => h("option", { value: x.id, selected: x.id === q.parent_id }, x.title))));
    return { body: [field("Question", title), field("Why it matters", why), field("Related to", parent)], submit: () => act(() => api("PATCH", `questions/${q.id}`, { title: title.value, why_it_matters: why.value, parent_id: parent.value }), "Saved") };
  })));

  return h("section", { class: "panel actions" }, h("h2", { class: "visually-hidden" }, "Actions"), h("div", { class: "row wrap" }, btns));
}

function relationsBlock(q, d) {
  const items = (list) => h("ul", { class: "rel-list" }, list.map((x) => h("li", null, h("a", { href: `#/q/${x.id}` }, x.title), " ", statusPill(x.status))));
  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Related questions"),
    d.children.length ? items(d.children) : h("p", { class: "muted" }, "None yet."),
    canEdit() && q.status !== "dropped" ? composer({ parentId: q.id, section: q.section, placeholder: "Add a related question…" }) : null,
    d.duplicates.length ? [h("h3", null, "Dropped as the same question"), items(d.duplicates)] : null,
  );
}

// ---------------------------------------------------------------- rules space

async function pageRules(sub, params) {
  if (sub === "add-tool") return addToolPage(params.get("url"));
  const st = S.space.settings;
  return h(
    "div",
    { class: "rules" },
    h("h1", null, "Rules"),
    h("p", null, "How this register works: the charter, the tools that can be linked, and the settings."),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Tool list"),
      h("p", { class: "muted" }, "Only links from these tools can be attached as processes. Anyone with edit access can add a tool; no vote needed."),
      canEdit() ? h("p", null, h("a", { class: "button", href: "#/rules/add-tool" }, "Add a tool")) : null,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Links accepted"), h("th", null, "Updates"), h("th", null, "Status"), canEdit() ? h("th", null) : null)),
          h(
            "tbody",
            null,
            S.tools.map((t) =>
              h(
                "tr",
                { class: t.enabled ? "" : "disabled" },
                h("td", null, t.name),
                h("td", null, t.url_patterns.map((p) => h("div", null, h("code", null, p.pattern), " → ", itemLabel(p.item_type)))),
                h("td", null, t.fetch_mode === "auto" ? "automatic" : "by hand"),
                h("td", null, t.enabled ? "enabled" : "disabled"),
                canEdit()
                  ? h("td", null, h("button", { class: "link", onclick: async () => (await act(() => api("POST", `tools/${t.id}/enabled`, { enabled: !t.enabled }), t.enabled ? "Tool disabled" : "Tool enabled")) && refresh() }, t.enabled ? "Disable" : "Enable"))
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Settings"),
      h(
        "dl",
        { class: "meta" },
        h("dt", null, "Active limit"), h("dd", null, st.active_cap),
        h("dt", null, "Objection window"), h("dd", null, `${st.default_rule_days} days`),
        h("dt", null, "Dormant after"), h("dd", null, `${st.dormancy_days} days without activity`),
        h("dt", null, "Clear outcomes resolve automatically"), h("dd", null, st.auto_confirm_process_outcomes ? "yes" : "no"),
      ),
    ),
    h("section", { class: "panel charter" }, renderMarkdown(S.space.charter_markdown)),
    h("section", { class: "panel" }, h("h2", null, "Export"), h("p", null, "Download everything in this space (questions, processes, resolutions, tools, charter and the full activity log) as JSON."), h("button", { onclick: downloadExport }, "Download export")),
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

function addToolPage(url) {
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {}
  const name = h("input", { type: "text", required: true, maxlength: 60, value: host.replace(/^www\./, "") });
  const patterns = h("textarea", { rows: 3, required: true, value: host ? `https://${host}/* → item` : "" });
  const states = h("textarea", { rows: 4, value: "Open → open\nClosed → concluded" });
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
  const btn = h("button", { type: "submit", class: "primary" }, "Add tool");
  return h(
    "div",
    null,
    h("a", { href: "#/rules", class: "back" }, "← Rules"),
    h("h1", null, "Add a tool"),
    h("p", null, "New tools are updated by hand: the steward of each question sets the process state. The tool is added to the list right away."),
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          const state_map = {};
          let url_patterns;
          try {
            url_patterns = parsePatterns();
            for (const l of linesToList(states.value)) {
              const [label, st] = l.split(/\s*(?:→|->)\s*/);
              if (!st || !(st.trim() in STATE)) throw new Error(`Unknown state in “${l}”`);
              state_map[label.trim()] = st.trim();
            }
          } catch (err) {
            return toast(err.message, "error");
          }
          btn.disabled = true;
          const r = await act(() => api("POST", "tools", { name: name.value, url_patterns, state_map }), "Tool added");
          btn.disabled = false;
          if (r) {
            await loadSpace();
            location.hash = "#/rules";
          }
        },
      },
      field("Tool name", name),
      field("Links accepted", patterns, "One per line: URL pattern → item type. Use :name for one path part and * for anything, e.g. https://forum.example.org/t/* → topic"),
      field("Check a link", tester),
      testOut,
      field("States", states, "One per line: label → open, not_started, accepted, rejected, concluded or withdrawn."),
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
