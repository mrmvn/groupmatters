// Loomio adapter: the API used by Loomio's own web client, for public content (verified 2026-10).
//   GET /api/v1/polls/:key        → { polls, outcomes, topics, … }
//   GET /api/v1/discussions/:key  → { discussions, topics, … }
// Private polls/threads answer 403: the process then falls back to being updated by hand.
// Last activity is the thread's `last_activity_at` (a poll lives in a thread, its "topic").
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson, iso } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched, NormalizedState } from "../types.ts";

const HOST = "www.loomio.com";
const RE = /^https:\/\/(?:www\.)?loomio\.com\/(p|d)\/([A-Za-z0-9_-]{4,40})(?:[/?#]|$)/;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

const stripHtml = (s: unknown) =>
  typeof s === "string"
    ? s
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
    : undefined;

function resultsSummary(p: any): string | undefined {
  if (!Array.isArray(p.results)) return undefined;
  const rows = p.results
    .filter((r: any) => typeof r.id === "number" && r.id >= 0 && r.name_format !== "i18n")
    .sort((a: any, b: any) => (a.rank ?? 99) - (b.rank ?? 99))
    .map((r: any) => `${r.name} ${r.vote_count ?? r.score ?? 0}`);
  if (!rows.length) return undefined;
  const cast = Number(p.vote_count_cast);
  const eligible = Number(p.vote_count_eligible);
  return rows.join(" · ") + (cast && eligible ? ` (${cast} of ${eligible} voted)` : "");
}

export function normalizePoll(d: any, now: Date): F {
  const p = d.polls?.[0];
  if (!p) throw new AdapterError("Unexpected response from Loomio");
  const topic = d.topics?.find((t: any) => t.id === p.topic_id);
  const outcome = p.current_outcome_id ? d.outcomes?.find((o: any) => o.id === p.current_outcome_id) : undefined;
  const dates = compact({
    opens_at: iso(p.opened_at ?? p.opening_at ?? p.created_at),
    closes_at: iso(p.closing_at),
    resolved_at: iso(p.closed_at),
    updated_at: iso(topic?.last_activity_at),
  });
  const extra = compact({
    poll_type: p.poll_type,
    votes: p.vote_count_cast ?? undefined,
    eligible_voters: p.vote_count_eligible ?? undefined,
    outcome: clip(stripHtml(outcome?.statement), 300),
  }) as Record<string, string | number | boolean>;
  const base = { title: clip(p.title), dates, extra };
  const hidden = p.hide_results && p.hide_results !== "off" && !p.closed_at;
  const results = hidden ? undefined : resultsSummary(p);

  if (p.discarded_at) return compact({ ...base, raw_state: "deleted", state: "withdrawn", terminal: true, outcome_summary: "Deleted" });
  if (p.closed_at) {
    // Some poll templates define a pass test; most don't, so a closed poll is "concluded" by default.
    const tests = (p.results ?? []).map((r: any) => r.test_result).filter((t: unknown) => typeof t === "boolean");
    const state: NormalizedState = tests.includes(false) ? "rejected" : tests.includes(true) ? "accepted" : "concluded";
    return compact({ ...base, raw_state: "closed", state, terminal: true, outcome_summary: clip(extra.outcome ?? results ?? "Closed") });
  }
  if (!p.opened_at && p.opening_at && new Date(p.opening_at) > now)
    return compact({ ...base, raw_state: "not yet open", state: "not_started", terminal: false, outcome_summary: "Not yet open" });
  return compact({ ...base, raw_state: "open", state: "open", terminal: false, outcome_summary: clip(results ? `Open: ${results}` : "Open") });
}

export function normalizeDiscussion(d: any): F {
  const disc = d.discussions?.[0];
  if (!disc) throw new AdapterError("Unexpected response from Loomio");
  const topic = d.topics?.find((t: any) => t.discussion_id === disc.id || (t.topicable_type === "Discussion" && t.topicable_id === disc.id));
  const base = {
    title: clip(disc.title),
    dates: compact({ opens_at: iso(disc.created_at), updated_at: iso(topic?.last_activity_at), resolved_at: iso(topic?.locked_at) }),
    extra: compact({ comments: topic?.replies_count ?? undefined, active_polls: topic?.active_polls_count ?? undefined }) as Record<string, string | number | boolean>,
  };
  if (disc.discarded_at || topic?.discarded_at) return compact({ ...base, raw_state: "deleted", state: "withdrawn", terminal: true, outcome_summary: "Deleted" });
  if (topic?.locked_at) return compact({ ...base, raw_state: "closed", state: "concluded", terminal: true, outcome_summary: "Thread closed" });
  return compact({ ...base, raw_state: "open", state: "open", terminal: false, outcome_summary: "Open" });
}

function check(status: number, json: any) {
  if (status === 200) return;
  if (status === 403 || status === 401) throw new AdapterError("This Loomio item isn't public", undefined, { manualFallback: true });
  if (status === 404) throw new AdapterError("Not found on Loomio (deleted?)");
  if (status === 429) throw new AdapterError("Loomio rate limit reached; will retry later", 15 * 60_000);
  throw new AdapterError(`Loomio returned HTTP ${status}${json?.error ? `: ${clip(String(json.error), 120)}` : ""}`);
}

export const loomio: Adapter = {
  id: "loomio",
  parse(url) {
    const m = RE.exec(url);
    if (!m) return null;
    return { item_type: m[1] === "p" ? "poll" : "discussion", ids: { key: m[2] } };
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    const kind = parsed.item_type === "poll" ? "polls" : "discussions";
    const r = await getJson(ctx, `https://${HOST}/api/v1/${kind}/${encodeURIComponent(parsed.ids.key)}`, { Accept: "application/json", "User-Agent": "question-register" }, HOST);
    check(r.status, r.json);
    return { fetched: kind === "polls" ? normalizePoll(r.json, ctx.now()) : normalizeDiscussion(r.json) };
  },
};
