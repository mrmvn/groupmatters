// OpaVote adapter: GET https://opavote.com/api/v1/items/:eid (verified 2026-10 on the public demo poll).
// The item endpoint answers without an API key (the eid in the link is the capability); only the
// owner-only endpoints (/items, /n-votes, ballots) need a key, and we don't use them.
//   → { title, description, mode: "poll" | "election", status: "EDITING" | "VOTING" | "END",
//       show_results: "yes" | …, contests: [{ title, method, n_seats, candidates, … }], eid }
//   → { error: true, msg } e.g. "This item has been deleted and is no longer available."
// There are no dates and no vote counts in the public response, so dates stay empty (type them).
// OpaVote doesn't say yes/no: an ended vote is "concluded" (ranked or multi-contest results have
// no single pass rule). Only the demo poll was available to check: other items (elections, polls
// with registration) may answer differently; unreadable ones fall back to hand updates.
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

const HOST = "opavote.com";
const RE = /^https:\/\/(?:www\.)?opavote\.com\/(?:vote|results|code)\/(\d{6,20})(?:[/?#]|$)/;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function normalizeItem(d: any): F {
  const title = clip(d.title) || undefined;
  const raw = typeof d.status === "string" ? d.status : "";
  const contests: any[] = Array.isArray(d.contests) ? d.contests : [];
  const n = contests.length;
  const kind = d.mode === "poll" ? "Poll" : d.mode === "election" ? "Election" : "Vote";
  const methods = [...new Set(contests.map((c) => c?.method).filter((m) => typeof m === "string"))];
  const detail = n ? ` · ${plural(n, "contest")}${methods.length ? ` (${methods.join(", ")})` : ""}` : "";
  const resultsUrl = d.show_results === "yes" && d.eid != null ? `https://${HOST}/results/${d.eid}/1` : undefined;
  const base = {
    title,
    raw_state: raw.toLowerCase() || undefined,
    extra: compact({ contests: n || undefined, mode: d.mode, results_url: resultsUrl }) as Record<string, string | number | boolean>,
  };
  const make = (state: F["state"], terminal: boolean, label: string): F =>
    compact({ ...base, state, terminal, outcome_summary: clip(`${label}${detail}`) });
  switch (raw) {
    case "EDITING":
      return make("not_started", false, `${kind} being prepared`);
    case "VOTING":
      return make("open", false, `${kind} open for voting`);
    case "END":
      return make("concluded", true, `${kind} ended`);
    default:
      return compact({ ...base, state: "unknown", terminal: false });
  }
}

export const opavote: Adapter = {
  id: "opavote",
  retrieves: {
    vote: ["title", "status", "number of contests", "poll or election", "results link"],
  },
  parse(url): Parsed | null {
    const m = RE.exec(url);
    return m ? { item_type: "vote", ids: { eid: m[1] } } : null;
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    const r = await getJson(ctx, `https://${HOST}/api/v1/items/${encodeURIComponent(parsed.ids.eid)}`, { Accept: "application/json", "User-Agent": "question-register" }, HOST);
    if (r.status === 429) throw new AdapterError("OpaVote rate limit reached; will retry later", 15 * 60_000);
    const j = r.json;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new AdapterError(`OpaVote returned HTTP ${r.status}`);
    if (j.error) {
      const msg = String(j.msg ?? "");
      if (/deleted/i.test(msg)) return { fetched: compact({ state: "withdrawn", terminal: true, raw_state: "deleted", outcome_summary: "Deleted on OpaVote" }) as F };
      if (/secret key|not authori|permission|private/i.test(msg)) throw new AdapterError("This OpaVote item can't be read without its owner's key", undefined, { manualFallback: true });
      if (r.status === 404 || /not found/i.test(msg)) throw new AdapterError("Not found on OpaVote");
      throw new AdapterError(`OpaVote: ${clip(msg, 120) || "error"}`);
    }
    return { fetched: normalizeItem(j) };
  },
};
