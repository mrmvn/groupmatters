// ICS calendar feed (RFC 5545) of the matters' start and end dates (F4). Served from the view link
// only, like the Atom feed. Each date is its own event ("Starts: …", "Ends: …") rather than one event
// spanning months, which would clutter a calendar. Whole days stay all-day events; moments are
// zero-length events in UTC. Removed matters are left out.
import type { Ctx } from "./ctx.ts";
import type { Question, Space } from "./types.ts";
import * as repo from "./repo.ts";
import { effectiveDates, isDay, labelFor } from "./fields.ts";

type DateValue = string;

/** TEXT values: backslash, semicolon, comma and newlines escaped. */
export const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets are folded (CRLF + space), without splitting a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, ""); // 20260301T120000Z
const day = (v: string) => v.replace(/-/g, "");
function nextDay(v: string): string {
  const d = new Date(`${v}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return day(d.toISOString().slice(0, 10));
}

function dateLines(v: DateValue): string[] {
  return isDay(v) ? [`DTSTART;VALUE=DATE:${day(v)}`, `DTEND;VALUE=DATE:${nextDay(v)}`] : [`DTSTART:${stamp(v)}`];
}

function event(ctx: Ctx, space: Space, q: Question, which: "start" | "end", v: DateValue, base: string, host: string): string[] {
  const status = q.status_label ?? labelFor(space, q.status);
  const url = `${base}#/q/${q.id}`;
  const summary = which === "start" ? `Starts: ${q.title}` : `Ends: ${q.title}`;
  const desc = [`Status: ${status}`, q.process?.url ? `Process: ${q.process.url}` : "", q.why_it_matters ?? "", url].filter(Boolean).join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:${q.id}-${which}@${host}`,
    `DTSTAMP:${stamp(ctx.now().toISOString())}`,
    `LAST-MODIFIED:${stamp(new Date(q.last_activity_at).toISOString())}`,
    ...dateLines(v),
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(desc)}`,
    `URL:${url}`,
    "TRANSP:TRANSPARENT", // shows as free: these are reminders, not meetings
    "END:VEVENT",
  ];
}

export function calendarFeed(ctx: Ctx, space: Space, token: string): string {
  const base = `${ctx.config.publicUrl}/s/${token}`;
  const host = new URL(ctx.config.publicUrl).host;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Group Matters//Matter register//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(space.name)}`,
    `X-WR-CALDESC:${icsText(`Start and end dates of the matters in ${space.name}`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const q of repo.listQuestions(ctx.db, space.id)) {
    const { start, end } = effectiveDates(q);
    if (start) lines.push(...event(ctx, space, q, "start", start.value, base, host));
    // Same value as the start: one event is enough.
    if (end && end.value !== start?.value) lines.push(...event(ctx, space, q, "end", end.value, base, host));
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
