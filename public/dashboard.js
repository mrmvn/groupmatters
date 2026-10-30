// Dashboard page (#/dashboard): prototype widgets, each hideable (kept in this browser's localStorage)
// so the group can try them and keep the useful ones. Data comes from GET dashboard (src/dashboard.ts).
import { h, time, timeAgo, fmtShortDate } from "./dom.js";
import { STATE, STATE_ICON, QUESTION_STATES, itemLabel } from "./labels.js";
import { statusPill } from "./components.js";

const HIDDEN_KEY = "qr:dash:hidden";
const GOAL_KEY = "qr:dash:goal";
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
// Each: { id, title, why (what it's for: shown in the chooser), wide?, build(d, ctx) → Node }

const WIDGETS = [
  {
    id: "since",
    title: "Since your last visit",
    why: "What changed while you were away",
    build: (d, { since }) => {
      if (!since) return empty("This is your first visit here: nothing to compare with yet.");
      const n = d.since?.changed ?? 0;
      return h(
        "div",
        null,
        h("p", { class: "big" }, n ? plural(n, "question") : "Nothing", n ? " changed" : " has changed"),
        h("p", { class: "muted small" }, "since ", time(since, timeAgo(since)), ". "),
        n ? h("a", { href: "#/activity" }, "See the activity") : null,
      );
    },
  },
  {
    id: "glance",
    title: "At a glance",
    why: "Headline numbers, linked to the list",
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
    title: "Questions by status",
    why: "How the questions are spread across statuses",
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
    build: (d) => {
      const rows = d.item_types.slice(0, 6).map((k) => ({ label: k.kind === "none" ? "No kind" : itemLabel(k.kind), n: k.questions, href: k.kind === "none" ? null : `#/list?lane=all&item_type=${encodeURIComponent(k.kind)}`, cls: k.kind === "none" ? "muted-fill" : "" }));
      return rows.length ? barRows(rows) : empty("No questions yet.");
    },
  },
  {
    id: "momentum",
    title: "Momentum, last 12 weeks",
    why: "Questions added and answered, week by week",
    wide: true,
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
          d.days_to_answer !== null ? h("span", { class: "muted" }, ` · typical time to answer: ${d.days_to_answer < 1 ? "under a day" : `${d.days_to_answer} days`}`) : null,
        ),
      );
    },
  },
  {
    id: "goal",
    title: "Monthly goal",
    why: "A shared target: questions answered this month",
    build: (d) => {
      const n = d.month.answered;
      const box = h("div", null);
      const draw = () => {
        const g = Math.max(1, Number(localStorage.getItem(GOAL_KEY)) || 3);
        const input = h("input", { type: "number", min: 1, max: 99, value: g, "aria-label": "Goal: questions answered this month", class: "goal-input" });
        input.addEventListener("change", () => {
          localStorage.setItem(GOAL_KEY, String(Math.max(1, Math.min(99, Math.round(Number(input.value)) || 3))));
          draw();
        });
        box.replaceChildren(
          h("p", { class: "big" }, `${n} / ${g}`, h("span", { class: "muted small" }, " answered this month")),
          bar(n / g, n >= g ? "done" : ""),
          h("p", { class: "small" }, n >= g ? "🎉 Goal reached. " : `${g - n} to go. `, h("label", { class: "inline muted" }, "Goal: ", input), h("span", { class: "muted" }, ` (kept in this browser only)`)),
          d.month.added ? h("p", { class: "muted small" }, `${plural(d.month.added, "question")} added this month.`) : null,
        );
      };
      draw();
      return box;
    },
  },
  {
    id: "heatmap",
    title: "Activity",
    why: "A day-by-day grid of changes by people, and the weekly streak",
    wide: true,
    build: (d) => {
      const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 7 ? 3 : 4);
      const grid = h(
        "div",
        { class: "heatmap", role: "img", "aria-label": `Changes per day over the last ${d.weekly.length} weeks` },
        d.days.map((x) => h("span", { class: `hm l${level(x.n)}${x.future ? " future" : ""}`, title: `${x.date}: ${plural(x.n, "change")}` })),
      );
      const { current, best } = d.streak;
      return h(
        "div",
        null,
        h("div", { class: "scroll-x" }, grid),
        h(
          "p",
          null,
          current ? h("strong", null, `🔥 ${plural(current, "week")} in a row`) : h("span", { class: "muted" }, "No streak yet: any change this week starts one"),
          h("span", { class: "muted small" }, best ? ` · best: ${plural(best, "week")}` : ""),
        ),
      );
    },
  },
  {
    id: "attention",
    title: "Needs attention",
    why: "Where a nudge would help most",
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
    build: (d) =>
      d.recent_answers.length
        ? h("ul", { class: "plain" }, d.recent_answers.map((a) => h("li", null, statusPill(a.status, a.status_label), " ", h("a", { href: `#/q/${a.id}` }, a.title), " ", h("span", { class: "muted small" }, time(a.at, timeAgo(a.at))))))
        : empty("Nothing answered yet. The first one will show up here."),
  },
  {
    id: "you",
    title: "Your impact",
    why: "Your own contributions (matched by display name)",
    build: (d, { role }) => {
      const y = d.you;
      if (!y) return empty(role === "view" ? "Personal stats need a display name, which only the edit link asks for." : "Set your display name to see your stats.");
      if (!y.actions) return empty(`Nothing under the name “${y.name}” yet. Add or change something and it will show up here.`);
      return h(
        "div",
        null,
        h(
          "div",
          { class: "tiles" },
          h("span", { class: "tile" }, h("span", { class: "big" }, y.added), h("span", { class: "muted small" }, "asked")),
          h("span", { class: "tile" }, h("span", { class: "big" }, y.answered), h("span", { class: "muted small" }, "moved to answered")),
          h("span", { class: "tile" }, h("span", { class: "big" }, y.actions), h("span", { class: "muted small" }, "changes")),
        ),
        h("p", { class: "muted small" }, y.rank ? `#${y.rank} of ${plural(y.of, "person", "people")} active in the last 30 days (${plural(y.last_30_days, "change")}).` : "Nothing in the last 30 days.", y.first_at ? ` Here since ${fmtShortDate(y.first_at)}.` : ""),
      );
    },
  },
  {
    id: "people",
    title: "Who's active",
    why: "Contributors over the last 30 days (group impact; names aren't verified)",
    build: (d) => {
      if (!d.people.length) return empty("No activity in the last 30 days.");
      return h(
        "div",
        null,
        barRows(d.people.map((p) => ({ label: p.name, n: p.actions, note: [p.added ? `${p.added} asked` : "", p.answered ? `${p.answered} answered` : ""].filter(Boolean).join(", ") }))),
        h("p", { class: "muted small" }, `${plural(d.totals.contributors, "person", "people")} have contributed in total.`),
      );
    },
  },
  {
    id: "milestones",
    title: "Milestones",
    why: "Little group achievements to unlock",
    wide: true,
    build: (d) => {
      const done = d.milestones.filter((m) => m.done).length;
      return h(
        "div",
        null,
        h("p", { class: "muted small" }, `${done} of ${d.milestones.length} unlocked`),
        h(
          "ul",
          { class: "badges-grid" },
          d.milestones.map((m) =>
            h(
              "li",
              { class: `ms${m.done ? " done" : ""}`, title: m.hint },
              h("span", { class: "ms-icon", "aria-hidden": "true" }, m.done ? "🏅" : "🔒"),
              h("span", null, h("strong", null, m.label), h("br"), h("span", { class: "muted small" }, m.done ? "Unlocked" : `${Math.min(m.value, m.target)} / ${m.target} · ${m.hint}`)),
            ),
          ),
        ),
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
    const sec = h("section", { class: `panel widget${w.wide ? " wide" : ""}`, "aria-labelledby": `w-${w.id}` }, h("div", { class: "widget-head" }, h("h2", { id: `w-${w.id}` }, w.title), hide), body);
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
  return h("div", null, h("h1", null, "Dashboard"), h("p", { class: "muted" }, `A summary of ${ctx.name}.`), chooser, h("div", { class: "dash-grid" }, [...sections.values()]));
}
