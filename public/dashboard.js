// Dashboard page (#/dashboard): prototype widgets, each hideable (kept in this browser's localStorage)
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
// Each: { id, title, why (what it's for: shown in the chooser), size: [columns, rows], build(d, ctx) → Node }
// The grid has 4 columns on a wide screen and fixed row heights (see .dash-grid in style.css), so sizes
// are what lets the widgets fit together like a puzzle: the sizes below add up to full rows
// (row 1: glance 2 + since 1 + you 1; row 2: status 4; rows 3–4: tools 2 + momentum 2;
// rows 5–6: answers 2 + kinds 1 + attention 1; row 7: milestones 4). Hidden widgets leave gaps that
// later ones fill (grid-auto-flow: dense). On narrower screens widths are capped (2 columns, then 1).

const WIDGETS = [
  {
    id: "since",
    title: "Since your last visit",
    why: "What changed while you were away",
    size: [1, 1],
    build: (d, { since }) => {
      if (!since) return empty("Your first visit: nothing to compare with yet.");
      const n = d.since?.changed ?? 0;
      return h(
        "div",
        null,
        h("p", { class: "big" }, n),
        h("p", { class: "small" }, n === 1 ? "question has" : "questions have", " changed since ", time(since, timeAgo(since)), n ? [" · ", h("a", { href: "#/activity" }, "Activity")] : null),
      );
    },
  },
  {
    id: "glance",
    title: "At a glance",
    why: "Headline numbers, linked to the list",
    size: [2, 1],
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
    id: "you",
    title: "Your impact",
    why: "Your own contributions (matched by display name)",
    size: [1, 1],
    build: (d, { role }) => {
      const y = d.you;
      if (!y) return empty(role === "view" ? "Personal stats need a display name, which only the edit link asks for." : "Set your display name to see your stats.");
      if (!y.actions) return empty(`Nothing under the name “${y.name}” yet. Add or change something and it will show up here.`);
      return h(
        "div",
        null,
        h(
          "div",
          { class: "tiles compact" },
          h("span", { class: "tile" }, h("span", { class: "big" }, y.added), h("span", { class: "muted small" }, "asked")),
          h("span", { class: "tile", title: "Questions you moved to accepted, rejected or concluded" }, h("span", { class: "big" }, y.answered), h("span", { class: "muted small" }, "answered")),
          h("span", { class: "tile" }, h("span", { class: "big" }, y.actions), h("span", { class: "muted small" }, "changes")),
        ),
        h("p", { class: "muted small" }, y.rank ? `#${y.rank} of ${y.of} active in the last 30 days` : "Nothing in the last 30 days"),
      );
    },
  },
  {
    id: "status",
    title: "Questions by status",
    why: "How the questions are spread across statuses",
    size: [4, 1],
    build: (d) => {
      const total = d.totals.questions;
      if (!total) return empty("No questions yet.");
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
          QUESTION_STATES.map((s) => h("li", null, h("a", { href: `#/list?lane=all&status=${s}` }, h("span", { class: `pill st-${s}` }, STATE_ICON[s], " ", STATE[s])), " ", h("strong", null, d.by_status[s]))),
        ),
      );
    },
  },
  {
    id: "tools",
    title: "Top tools used",
    why: "Which tools the group's processes run on",
    size: [2, 2],
    build: (d) => {
      const top = d.tools.slice(0, 5);
      const rows = top.map((t) => ({ label: t.name, n: t.questions, href: `#/list?lane=all&tool=${t.custom ? "custom" : t.id}`, note: t.custom ? "(custom)" : t.in_progress ? `· ${t.in_progress} in progress` : "" }));
      if (d.totals.without_process) rows.push({ label: "No process", n: d.totals.without_process, href: "#/list?lane=all&has_process=no", cls: "muted-fill" });
      const pct = d.totals.questions ? Math.round((d.totals.with_process / d.totals.questions) * 100) : 0;
      return h(
        "div",
        null,
        rows.length ? barRows(rows) : empty("No questions yet."),
        d.tools.length > 5 ? h("p", { class: "muted small" }, `…and ${plural(d.tools.length - 5, "more tool")}. `, h("a", { href: "#/rules" }, "All tools")) : null,
        d.totals.questions ? h("p", { class: "muted small" }, `${pct}% of questions are linked to a process.`) : null,
        d.unused_tools.length ? h("p", { class: "muted small" }, "On the list, never used: ", d.unused_tools.map((t) => t.name).join(", "), ".") : null,
      );
    },
  },
  {
    id: "kinds",
    title: "What kind of items",
    why: "Polls, pull requests, meetings…",
    size: [1, 2],
    build: (d) => {
      const rows = d.item_types.slice(0, 6).map((k) => ({ label: k.kind === "none" ? "No kind" : itemLabel(k.kind), n: k.questions, href: k.kind === "none" ? null : `#/list?lane=all&item_type=${encodeURIComponent(k.kind)}`, cls: k.kind === "none" ? "muted-fill" : "" }));
      return rows.length ? barRows(rows) : empty("No questions yet.");
    },
  },
  {
    id: "momentum",
    title: "Momentum, last 12 weeks",
    why: "Questions added and answered, week by week",
    size: [2, 2],
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
          h("span", { class: "mweek" }, col(w.added, "added", `Week of ${w.start}: ${plural(w.added, "question")} added`), col(w.answered, "answered", `Week of ${w.start}: ${w.answered} answered`)),
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
          { class: "small" },
          h("span", { class: "key added" }), ` Added (${addedTotal})  `,
          h("span", { class: "key answered" }), ` Answered (${answeredTotal})`,
        ),
        h(
          "p",
          { class: "small" },
          d.streak.current ? h("strong", null, `🔥 ${plural(d.streak.current, "week")} in a row with activity`) : h("span", { class: "muted" }, "No streak yet: any change this week starts one"),
          d.streak.best > d.streak.current ? h("span", { class: "muted" }, ` · best: ${plural(d.streak.best, "week")}`) : null,
          d.days_to_answer !== null ? h("span", { class: "muted" }, ` · typical time to answer: ${d.days_to_answer < 1 ? "under a day" : `${d.days_to_answer} days`}`) : null,
        ),
      );
    },
  },
  {
    id: "attention",
    title: "Needs attention",
    why: "Where a nudge would help most",
    size: [1, 2],
    build: (d) => {
      const a = d.attention;
      const item = (n, text, href) => h("li", { class: n ? "todo" : "ok" }, h("span", { "aria-hidden": "true" }, n ? "● " : "✓ "), n ? [h("a", { href }, plural(n, "question")), ` ${text}`] : `None ${text}`);
      return h(
        "div",
        null,
        h(
          "ul",
          { class: "checks" },
          item(a.quiet, "in progress but quiet for 30+ days", "#/list?preset=quiet"),
          item(a.no_process, "current without a process yet", "#/list?preset=no_process"),
          item(a.fetch_problems, "with a problem retrieving from their link", "#/list?preset=fetch_problems"),
        ),
        a.oldest_open ? h("p", { class: "muted small" }, "Longest-waiting: ", h("a", { href: `#/q/${a.oldest_open.id}` }, a.oldest_open.title), ` (${plural(a.oldest_open.days, "day")})`) : null,
      );
    },
  },
  {
    id: "answers",
    title: "Recently answered",
    why: "A wall of wins: the last questions that got an answer",
    size: [2, 2],
    build: (d) =>
      d.recent_answers.length
        ? h("ul", { class: "plain" }, d.recent_answers.map((a) => h("li", null, statusPill(a.status, a.status_label), " ", h("a", { href: `#/q/${a.id}` }, a.title), " ", h("span", { class: "muted small" }, time(a.at, timeAgo(a.at))))))
        : empty("Nothing answered yet. The first one will show up here."),
  },
  {
    id: "milestones",
    title: "Milestones",
    why: "Little group achievements to unlock",
    size: [4, 1],
    build: (d) => {
      const done = d.milestones.filter((m) => m.done).length;
      return h(
        "div",
        null,
        h(
          "ul",
          { class: "badges-grid" },
          d.milestones.map((m) =>
            h(
              "li",
              { class: `ms${m.done ? " done" : ""}`, title: `${m.hint}${m.done ? " (unlocked)" : ""}` },
              h("span", { class: "ms-icon", "aria-hidden": "true" }, m.done ? "🏅" : "🔒"),
              h("strong", null, m.label),
              m.done ? null : h("span", { class: "muted small" }, `${Math.min(m.value, m.target)}/${m.target}`),
            ),
          ),
        ),
        h("p", { class: "muted small" }, `${done} of ${d.milestones.length} unlocked`),
      );
    },
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
    const [cols, rows] = w.size;
    const sec = h("section", { class: `panel widget c${cols} r${rows}`, "aria-labelledby": `w-${w.id}` }, h("div", { class: "widget-head" }, h("h2", { id: `w-${w.id}` }, w.title), hide), h("div", { class: "widget-body" }, body));
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
  return h("div", null, ctx.back, h("h1", null, "Dashboard"), h("p", { class: "muted" }, `A summary of ${ctx.name}.`), chooser, h("div", { class: "dash-grid" }, [...sections.values()]));
}
