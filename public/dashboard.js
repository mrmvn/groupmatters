// Dashboard page (#/dashboard): prototype widgets (collective only: no individual rankings), each hideable (kept in this browser's localStorage)
// so the group can try them and keep the useful ones. Data comes from GET dashboard (src/dashboard.ts).
import { h, time, timeAgo, fmtShortDate } from "./dom.js";
import { STATE, STATE_ICON, QUESTION_STATES, itemLabel } from "./labels.js";
import { statusPill } from "./components.js";

const HIDDEN_KEY = "qr:dash:hidden";
const read = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A horizontal bar: `fraction` (0–1) of the track. Width is set through the CSSOM (the strict CSP forbids style attributes). */
function bar(fraction, cls = "") {
  const fill = h("span", { class: `bar-fill ${cls}` });
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return h("span", { class: "bar", "aria-hidden": "true" }, fill);
}

/** A list of "label  ▇▇▇▇ n" rows. Each row: { label, n, href?, note? }. */
function barRows(rows, max = Math.max(1, ...rows.map((r) => r.n))) {
  return h(
    "ul",
    { class: "bar-rows" },
    rows.map((r) =>
      h(
        "li",
        null,
        h("span", { class: "bar-label" }, r.href ? h("a", { href: r.href }, r.label) : r.label, r.note ? h("span", { class: "muted small" }, ` ${r.note}`) : null),
        bar(r.n / max, r.cls),
        h("span", { class: "bar-n" }, r.n),
      ),
    ),
  );
}

const empty = (text) => h("p", { class: "muted" }, text);

// ---------------------------------------------------------------- widgets
// Each: { id, title, why (what it's for: shown in the chooser), cols, build(d, ctx) → Node }
// `cols` is how many of the grid's 4 columns the widget spans (1 to 4). Row heights follow the content
// (see .dash-grid in style.css): every row is as tall as its tallest widget and the others stretch to match,
// so the widgets are ordered to share a row with ones of a similar height (short numbers together, the longer
// lists side by side). Nothing is clipped, and hidden widgets leave gaps that later ones fill
// (grid-auto-flow: dense). On narrower screens the grid drops to 2 then 1 column.

const WIDGETS = [
  {
    id: "since",
    title: "Since your last visit",
    why: "What changed while you were away",
    cols: 1,
    build: (d, { since }) => {
      if (!since) return empty("Your first visit: nothing to compare with yet.");
      const n = d.since?.changed ?? 0;
      return h(
        "div",
        null,
        h("p", { class: "big" }, n),
        h("p", { class: "small" }, n === 1 ? "matter has" : "matters have", " changed since ", time(since, timeAgo(since)), n ? [" · ", h("a", { href: "#/activity" }, "Activity")] : null),
      );
    },
  },
  {
    id: "glance",
    title: "At a glance",
    why: "Headline numbers, linked to the list",
    cols: 3,
    build: (d) => {
      const tile = (n, label, href) => h("a", { class: "tile", href }, h("span", { class: "big" }, n), h("span", { class: "muted small" }, label));
      const s = d.by_status;
      return h(
        "div",
        { class: "tiles" },
        tile(s.open + s.not_started, "current", "#/list?lane=current"),
        tile(d.totals.answered, "answered", "#/list?lane=ended"),
        tile(s.withdrawn, "withdrawn", "#/list?lane=withdrawn"),
        tile(d.totals.questions, "in total", "#/list?lane=all"),
      );
    },
  },
  {
    id: "status",
    title: "Matters by status",
    why: "How the matters are spread across statuses",
    cols: 4,
    build: (d) => {
      const total = d.totals.questions;
      if (!total) return empty("No matters yet.");
      const strip = h("div", { class: "stack", role: "img", "aria-label": QUESTION_STATES.map((s) => `${STATE[s]}: ${d.by_status[s]}`).join(", ") });
      for (const s of QUESTION_STATES) {
        if (!d.by_status[s]) continue;
        const seg = h("span", { class: `seg st-${s}`, title: `${STATE[s]}: ${d.by_status[s]}` });
        seg.style.flexGrow = d.by_status[s];
        strip.append(seg);
      }
      return h(
        "div",
        null,
        strip,
        h(
          "ul",
          { class: "legend" },
          QUESTION_STATES.map((s) => h("li", null, h("a", { href: `#/list?lane=all&status=${s}` }, h("span", { class: `pill st-${s}` }, STATE_ICON[s], " ", STATE[s])), h("strong", null, d.by_status[s]))),
        ),
      );
    },
  },
  {
    id: "tools",
    title: "Top tools used",
    why: "Which tools the group's processes run on",
    cols: 2,
    build: (d) => {
      const top = d.tools.slice(0, 5);
      const rows = top.map((t) => ({ label: t.name, n: t.questions, href: `#/list?lane=all&tool=${t.custom ? "custom" : t.id}`, note: t.custom ? "(custom)" : t.in_progress ? `· ${t.in_progress} in progress` : "" }));
      if (d.totals.without_process) rows.push({ label: "No tool attached", n: d.totals.without_process, href: "#/list?lane=all&tool=none", cls: "muted-fill" });
      const pct = d.totals.questions ? Math.round((d.totals.with_process / d.totals.questions) * 100) : 0;
      return h(
        "div",
        null,
        rows.length ? barRows(rows) : empty("No matters yet."),
        d.tools.length > 5 ? h("p", { class: "muted small" }, `…and ${plural(d.tools.length - 5, "more tool")}. `, h("a", { href: "#/tools" }, "All tools")) : null,
        d.totals.questions ? h("p", { class: "muted small" }, `${pct}% of matters are linked to a process.`) : null,
        d.unused_tools.length ? h("p", { class: "muted small" }, "On the list, never used: ", d.unused_tools.map((t) => t.name).join(", "), ".") : null,
      );
    },
  },
  {
    id: "kinds",
    title: "What kind of items",
    why: "Polls, pull requests, meetings…",
    cols: 1,
    build: (d) => {
      const rows = d.item_types.slice(0, 6).map((k) => ({ label: k.kind === "none" ? "No kind" : itemLabel(k.kind), n: k.questions, href: k.kind === "none" ? null : `#/list?lane=all&item_type=${encodeURIComponent(k.kind)}`, cls: k.kind === "none" ? "muted-fill" : "" }));
      return rows.length ? barRows(rows) : empty("No matters yet.");
    },
  },
  {
    id: "attention",
    title: "Needs attention",
    why: "Where a nudge would help most",
    cols: 1,
    build: (d) => {
      const a = d.attention;
      const item = (n, text, href) => h("li", { class: n ? "todo" : "ok" }, h("span", { "aria-hidden": "true" }, n ? "● " : "✓ "), n ? [h("a", { href }, plural(n, "matter")), ` ${text}`] : `None ${text}`);
      return h(
        "div",
        null,
        h(
          "ul",
          { class: "checks" },
          item(a.quiet, "in progress but quiet for 30+ days", "#/list?preset=quiet"),
          item(a.no_process, "current with no tool attached", "#/list?preset=no_process"),
          item(a.fetch_problems, "with a problem retrieving from their link", "#/list?preset=fetch_problems"),
        ),
        a.oldest_open ? h("p", { class: "muted small" }, "Longest-waiting: ", h("a", { href: `#/q/${a.oldest_open.id}` }, a.oldest_open.title), ` (${plural(a.oldest_open.days, "day")})`) : null,
      );
    },
  },
  {
    id: "momentum",
    title: "Momentum, last 12 weeks",
    why: "Matters added and answered, week by week",
    cols: 2,
    build: (d) => {
      const max = Math.max(1, ...d.weekly.flatMap((w) => [w.added, w.answered]));
      const col = (n, cls, label) => {
        const c = h("span", { class: `mcol ${cls}`, title: label });
        c.style.height = `${n ? Math.max((n / max) * 100, 6) : 0}%`;
        return c;
      };
      const chart = h(
        "div",
        { class: "momentum", role: "img", "aria-label": d.weekly.map((w) => `week of ${w.start}: ${w.added} added, ${w.answered} answered`).join("; ") },
        d.weekly.map((w) =>
          h("span", { class: "mweek" }, col(w.added, "added", `Week of ${w.start}: ${plural(w.added, "matter")} added`), col(w.answered, "answered", `Week of ${w.start}: ${w.answered} answered`)),
        ),
      );
      const addedTotal = d.weekly.reduce((a, w) => a + w.added, 0);
      const answeredTotal = d.weekly.reduce((a, w) => a + w.answered, 0);
      return h(
        "div",
        null,
        chart,
        h("div", { class: "axis muted small" }, h("span", null, fmtShortDate(d.weekly[0].start)), h("span", null, "this week")),
        h(
          "p",
          { class: "small mlabels" },
          h("span", null, h("span", { class: "key added" }), ` Added (${addedTotal})`),
          h("span", null, h("span", { class: "key answered" }), ` Answered (${answeredTotal})`),
        ),
        h(
          "p",
          { class: "small" },
          d.days_to_answer !== null ? h("span", { class: "muted" }, `Typical time to answer: ${d.days_to_answer < 1 ? "under a day" : `${d.days_to_answer} days`}`) : null,
        ),
      );
    },
  },
  {
    id: "answers",
    title: "Recently answered",
    why: "A wall of wins: the last matters that got an answer",
    cols: 2,
    build: (d) =>
      d.recent_answers.length
        ? h("ul", { class: "plain" }, d.recent_answers.map((a) => h("li", null, statusPill(a.status, a.status_label), " ", h("a", { href: `#/q/${a.id}` }, a.title), " ", h("span", { class: "muted small" }, time(a.at, timeAgo(a.at))))))
        : empty("Nothing answered yet. The first one will show up here."),
  },
];

/** The dashboard: a grid of widgets, with a chooser to hide the ones you don't want. */
export function dashboardPage(d, ctx) {
  const hidden = new Set(read(HIDDEN_KEY, []));
  const save = () => localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  const sections = new Map();
  const apply = (id) => {
    const s = sections.get(id);
    if (s) s.hidden = hidden.has(id);
  };
  for (const w of WIDGETS) {
    let body;
    try {
      body = w.build(d, ctx);
    } catch (e) {
      body = h("p", { class: "error" }, `This widget failed: ${e.message}`);
    }
    const hide = h("button", { type: "button", class: "link muted small widget-hide", title: "Hide this widget (bring it back with “Choose widgets”)", "aria-label": `Hide “${w.title}”`, onclick: () => (hidden.add(w.id), save(), apply(w.id), sync(w.id)) }, "Hide");
    const sec = h("section", { class: `panel widget c${w.cols}`, "aria-labelledby": `w-${w.id}` }, h("div", { class: "widget-head" }, h("h2", { id: `w-${w.id}` }, w.title), hide), h("div", { class: "widget-body" }, body));
    sections.set(w.id, sec);
    apply(w.id);
  }
  const boxes = new Map();
  const sync = (id) => {
    const b = boxes.get(id);
    if (b) b.checked = !hidden.has(id);
  };
  const chooser = h(
    "details",
    { class: "filters" },
    h("summary", null, "Choose widgets"),
    h("p", { class: "muted small" }, "These are prototypes: untick the ones you don't find useful. Your choice is kept in this browser only."),
    h(
      "div",
      { class: "widget-choice" },
      WIDGETS.map((w) => {
        const box = h("input", { type: "checkbox", checked: !hidden.has(w.id), onchange: (e) => (e.target.checked ? hidden.delete(w.id) : hidden.add(w.id), save(), apply(w.id)) });
        boxes.set(w.id, box);
        return h("label", { class: "inline" }, box, h("span", null, h("strong", null, w.title), h("span", { class: "muted small" }, ` — ${w.why}`)));
      }),
    ),
  );
  return h("div", null, ctx.back, h("h1", null, "Dashboard"), chooser, h("div", { class: "dash-grid" }, [...sections.values()]));
}
