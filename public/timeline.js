// Timeline chart: one bar per question with a start date, from its start to its end (or today), coloured by status.
// Positions are set through the CSSOM (el.style), which the strict CSP allows; no inline style attributes.
import { h, fmtWhen, dateStart, dateEnd } from "./dom.js";
import { STATE } from "./labels.js";
import { statusPill } from "./components.js";

const DAY = 86_400_000;

/** Tick dates between t0 and t1: weeks, months or years depending on the span, at most ~12 labels. */
export function ticks(t0, t1) {
  const span = t1 - t0;
  const unit = span <= 75 * DAY ? "week" : span <= 3 * 365 * DAY ? "month" : "year";
  const start = new Date(t0);
  let d;
  if (unit === "week") {
    d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // next Monday
  } else if (unit === "month") d = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  else d = new Date(start.getFullYear() + 1, 0, 1);
  const out = [];
  while (d.getTime() < t1 && out.length < 400) {
    out.push(new Date(d));
    if (unit === "week") d.setDate(d.getDate() + 7);
    else if (unit === "month") d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  }
  const step = Math.ceil(out.length / 12) || 1;
  // Thin months to quarters/half-years so labels don't collide; keep January for the year label.
  const kept = unit === "month" && step > 1 ? out.filter((x) => x.getMonth() % (step <= 3 ? 3 : step <= 6 ? 6 : 12) === 0) : out.filter((_, i) => i % step === 0);
  return kept.map((date, i) => ({
    t: date.getTime(),
    label:
      unit === "year"
        ? String(date.getFullYear())
        : unit === "month"
          ? date.toLocaleDateString(undefined, i === 0 || date.getMonth() === 0 ? { month: "short", year: "numeric" } : { month: "short" })
          : date.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  }));
}

const days = (ms) => {
  const n = Math.round(ms / DAY);
  return n < 1 ? "less than a day" : `${n} day${n === 1 ? "" : "s"}`;
};

const ENDED = ["accepted", "rejected", "concluded", "withdrawn"];
const SOURCE = { retrieved: "retrieved", typed: "typed" };

/** Start and end in ms, and how the bar is drawn. Whole days run from midnight to midnight (local). */
export function layout(it, now) {
  const start = dateStart(it.start.value);
  const end = it.end ? Math.max(dateEnd(it.end.value), start) : undefined;
  if (end !== undefined) return { start, end, kind: end <= now ? "done" : start >= now ? "scheduled" : "planned" };
  if (ENDED.includes(it.status)) return { start, kind: "unknown_end" };
  return { start, end: Math.max(now, start), kind: start > now ? "scheduled" : "running" };
}

/** A readable sentence for one bar (tooltip and screen readers). */
export function describe(it, now) {
  const label = it.status_label && it.status_label !== STATE[it.status] ? `${it.status_label} (${STATE[it.status]})` : STATE[it.status];
  const l = layout(it, now);
  const parts = [label, `${l.start > now ? "starts" : "from"} ${fmtWhen(it.start.value)} (${SOURCE[it.start.source]})`];
  if (it.end) parts.push(`${l.kind === "done" ? "to" : "until"} ${fmtWhen(it.end.value)}${l.kind === "done" ? "" : ", planned"} (${SOURCE[it.end.source]}), ${days(l.end - l.start)}`);
  else if (l.kind === "unknown_end") parts.push("end date unknown");
  else if (l.kind === "running") parts.push(`still running, ${days(now - l.start)} so far`);
  return parts.join(", ");
}

/** The chart. `items` come from GET timeline (sorted by start); `nowIso` is the server's clock. */
export function timelineChart(items, nowIso) {
  const now = Date.parse(nowIso);
  const spans = items.map((it) => layout(it, now));
  const times = spans.flatMap((l) => [l.start, l.end ?? l.start]);
  let t0 = Math.min(...times, now);
  let t1 = Math.max(...times, now);
  if (t1 - t0 < 14 * DAY) t0 = t1 - 14 * DAY;
  const pad = (t1 - t0) * 0.02;
  t0 -= pad;
  t1 += pad;
  const pct = (t) => ((t - t0) / (t1 - t0)) * 100;
  const place = (el, from, to) => {
    el.style.left = `${pct(from).toFixed(3)}%`;
    if (to !== undefined) el.style.width = `${Math.max(pct(to) - pct(from), 0).toFixed(3)}%`;
    return el;
  };

  const tickList = ticks(t0, t1);
  const axis = h(
    "div",
    { class: "tl-row tl-axis", "aria-hidden": "true" },
    h("div", { class: "tl-label" }),
    h("div", { class: "tl-track" }, tickList.map((k) => place(h("span", { class: "tl-tick" }, k.label), k.t))),
  );
  const grid = h(
    "div",
    { class: "tl-grid", "aria-hidden": "true" },
    tickList.map((k) => place(h("span", { class: "tl-gridline" }), k.t)),
    place(h("span", { class: "tl-today", title: "Today" }), now),
  );

  // Children sit under their parent (duplicates under their original), indented with a small branch (`depth` comes with hierarchy=1).
  const label = (it) => {
    const el = h(
      "div",
      { class: `tl-label${it.depth ? " tl-child" : ""}` },
      it.depth ? h("span", { class: "tl-branch", "aria-hidden": "true" }, it.nested_as === "duplicate" ? "≡" : "└") : null,
      h("a", { href: `#/q/${it.id}`, title: it.title }, it.title),
    );
    if (it.depth) el.style.paddingLeft = `${Math.min(it.depth, 4) * 0.9}rem`;
    return el;
  };

  const rows = items.map((it, i) => {
    const l = spans[i];
    const text = describe(it, now);
    const cls = `tl-bar st-${it.status}`;
    // Solid up to today (or the end); dashed for what's planned; a short fade when the end is unknown.
    const pieces =
      l.kind === "done" ? [place(h("span", { class: cls }), l.start, l.end)]
      : l.kind === "running" ? [place(h("span", { class: `${cls} ongoing` }), l.start, l.end)]
      : l.kind === "planned" ? [place(h("span", { class: `${cls} ongoing` }), l.start, now), place(h("span", { class: "tl-planned" }), now, l.end)]
      : l.kind === "scheduled" ? [place(h("span", { class: `${cls} scheduled` }), l.start, l.end)]
      : [place(h("span", { class: `${cls} unknown-end` }), l.start)];
    pieces[0].setAttribute("role", "img");
    pieces[0].setAttribute("aria-label", text);
    for (const p of pieces) p.setAttribute("title", text);
    return h(
      "li",
      { class: "tl-row" },
      label(it),
      h("div", { class: "tl-track" }, pieces),
    );
  });

  const kinds = new Set(spans.map((l) => l.kind));
  const present = [...new Set(items.map((it) => it.status))];
  const legend = h(
    "div",
    { class: "tl-legend small" },
    present.map((s) => statusPill(s)),
    kinds.has("running") || kinds.has("planned") ? h("span", null, h("span", { class: "tl-key ongoing" }), " still running") : null,
    kinds.has("planned") || kinds.has("scheduled") ? h("span", null, h("span", { class: "tl-key planned" }), " planned") : null,
    kinds.has("unknown_end") ? h("span", null, h("span", { class: "tl-key unknown-end" }), " end date unknown") : null,
    h("span", null, h("span", { class: "tl-key today" }), " today"),
  );
  return h("div", { class: "timeline" }, legend, h("div", { class: "tl-scroll" }, h("div", { class: "tl-chart" }, axis, h("div", { class: "tl-body" }, grid, h("ul", { class: "tl-rows" }, rows)))));
}
