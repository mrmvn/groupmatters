// Tiny DOM helpers. All text goes through textContent / text nodes: no HTML injection.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "required" || k === "open") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** External link: new tab, no referrer (keeps the secret space link private). */
export const extLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "ext" }, text ?? href);

export function fmtDate(iso, withTime = true) {
  if (!iso) return "";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function fmtShortDate(iso) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

export function fmtDuration(ms) {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h${m % 60 && hrs < 6 ? ` ${m % 60} min` : ""}`;
  const d = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return `${d} day${d > 1 ? "s" : ""}${rh ? ` ${rh} h` : ""}`;
}

export function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

/** <time> element with a readable local date and the ISO value as tooltip. */
export const time = (iso, label) => h("time", { datetime: iso, title: fmtDate(iso) }, label ?? fmtDate(iso));

let toastTimer;
export function toast(message, kind = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "error" ? 7000 : 3500);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Question dates: a whole day ("2026-03-01", local calendar day) or a moment (ISO).
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isDay = (v) => DAY_RE.test(v ?? "");
/** When a date value begins, in ms (a whole day starts at local midnight). */
export function dateStart(v) {
  const m = DAY_RE.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.parse(v);
}
/** When a date value ends, in ms (a whole day lasts until the next local midnight). */
export function dateEnd(v) {
  const m = DAY_RE.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() : Date.parse(v);
}
/** "3 Mar 2026" for a whole day, "3 Mar 2026, 18:00" for a moment. */
export const fmtWhen = (v) => (isDay(v) ? new Date(dateStart(v)).toLocaleDateString(undefined, { dateStyle: "medium" }) : fmtDate(v));
/** A date value → `{date, time}` input values (local); and back. An empty time means the whole day. */
export function toDayTimeInputs(v) {
  if (!v) return { date: "", time: "" };
  if (isDay(v)) return { date: v, time: "" };
  const [date, time] = toLocalInput(v).split("T");
  return { date, time };
}
export const fromDayTimeInputs = (date, time) => (!date ? "" : time ? new Date(`${date}T${time}`).toISOString() : date);

/** Local datetime-input value ↔ ISO */
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : undefined);
