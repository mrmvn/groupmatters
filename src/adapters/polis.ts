// Polis adapter: pol.is public API v3 (no auth needed for public conversations; verified 2026-10).
//   GET /api/v3/conversations?conversation_id=…  → topic, is_active, participant_count, created, modified
//   GET /api/v3/reports?report_id=…              → [{ conversation_id, … }] (for report links)
// `modified` is the last vote time, in microseconds; it serves as "last activity".
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson, iso } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

const HOST = "pol.is";
const RE = /^https:\/\/pol\.is\/(?:(report)\/(r[a-z0-9]{6,40})|([0-9][a-z0-9]{3,20}))\/?(?:[?#]|$)/i;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

export function normalizeConversation(c: any, reportUrl?: string): F {
  const participants = Number(c.participant_count) || 0;
  const active = c.is_active !== false;
  const f: F = {
    title: clip(c.topic) || undefined,
    raw_state: active ? "open" : "closed",
    state: active ? "open" : "concluded",
    terminal: !active,
    outcome_summary: `${active ? "Open" : "Closed"} · ${participants} participant${participants === 1 ? "" : "s"}`,
    dates: compact({ opens_at: iso(c.created), updated_at: iso(c.modified) }),
    extra: compact({ participants, results_url: reportUrl }) as Record<string, string | number | boolean>,
  };
  return compact(f);
}

function check(status: number, what: string) {
  if (status === 200) return;
  if (status === 403 || status === 401) throw new AdapterError(`This Polis ${what} isn't public`, undefined, { manualFallback: true });
  if (status === 404) throw new AdapterError(`Polis ${what} not found`);
  if (status === 429) throw new AdapterError("Polis rate limit reached; will retry later", 15 * 60_000);
  throw new AdapterError(`Polis returned HTTP ${status}`);
}

const headers = { Accept: "application/json", "User-Agent": "question-register" };

export const polis: Adapter = {
  id: "polis",
  parse(url): Parsed | null {
    const m = RE.exec(url);
    if (!m) return null;
    return m[1] ? { item_type: "conversation", ids: { report_id: m[2] } } : { item_type: "conversation", ids: { conversation_id: m[3] } };
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    let { conversation_id, report_id } = parsed.ids;
    let reportUrl: string | undefined;
    if (report_id) {
      const r = await getJson(ctx, `https://${HOST}/api/v3/reports?report_id=${encodeURIComponent(report_id)}`, headers, HOST);
      check(r.status, "report");
      conversation_id = Array.isArray(r.json) ? r.json[0]?.conversation_id : undefined;
      if (!conversation_id) throw new AdapterError("Polis report not found");
      reportUrl = `https://${HOST}/report/${report_id}`;
    }
    const r = await getJson(ctx, `https://${HOST}/api/v3/conversations?conversation_id=${encodeURIComponent(conversation_id)}`, headers, HOST);
    check(r.status, "conversation");
    if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) throw new AdapterError("Unexpected response from Polis");
    return { fetched: normalizeConversation(r.json, reportUrl) };
  },
};
