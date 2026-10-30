// Metaculus adapter: GET https://www.metaculus.com/api/posts/:id/ with "Authorization: Token …".
// Metaculus requires an API token for every request (and the website is behind a bot challenge),
// so this adapter is only available when the operator sets METACULUS_TOKEN. Without it, Metaculus
// links are updated by hand. Written against docs/openapi.yml of github.com/Metaculus/metaculus
// (2026-10); not tested against the live API. Resolution values can be hidden (null) for
// restricted accounts: the state is then "concluded".
// There is no "last activity" timestamp (edited_at is editorial), so dates.updated_at stays empty.
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson, iso } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

const HOST = "www.metaculus.com";
const RE = /^https:\/\/(?:www\.)?metaculus\.com\/questions\/(\d{1,10})(?:[/?#]|$)/;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

export function normalizePost(p: any): F {
  const q = p.question ?? {};
  const status = q.status ?? p.status;
  const base = {
    title: clip(p.title ?? q.title),
    dates: compact({ opens_at: iso(q.open_time ?? p.open_time), closes_at: iso(q.scheduled_close_time ?? p.scheduled_close_time), resolved_at: iso(q.actual_resolve_time) }),
    extra: compact({ forecasters: p.nr_forecasters ?? undefined, forecasts: p.forecasts_count ?? undefined, comments: p.comment_count ?? undefined }) as Record<string, string | number | boolean>,
  };
  switch (status) {
    case "upcoming":
    case "draft":
    case "pending":
      return compact({ ...base, raw_state: status, state: "not_started", terminal: false, outcome_summary: "Upcoming" });
    case "open":
      return compact({ ...base, raw_state: "open", state: "open", terminal: false, outcome_summary: "Open for forecasts" });
    case "closed":
      return compact({ ...base, raw_state: "closed", state: "open", terminal: false, outcome_summary: "Closed, awaiting resolution" });
    case "rejected":
      return compact({ ...base, raw_state: "rejected", state: "withdrawn", terminal: true, outcome_summary: "Not published" });
    case "resolved": {
      const r = q.resolution == null ? undefined : String(q.resolution);
      const lower = r?.toLowerCase();
      if (lower === "yes") return compact({ ...base, raw_state: "resolved: yes", state: "accepted", terminal: true, outcome_summary: "Resolved Yes" });
      if (lower === "no") return compact({ ...base, raw_state: "resolved: no", state: "rejected", terminal: true, outcome_summary: "Resolved No" });
      if (lower === "annulled" || lower === "ambiguous")
        return compact({ ...base, raw_state: `resolved: ${lower}`, state: "withdrawn", terminal: true, outcome_summary: lower === "annulled" ? "Annulled" : "Ambiguous" });
      return compact({ ...base, raw_state: "resolved", state: "concluded", terminal: true, outcome_summary: r ? clip(`Resolved: ${r}`) : "Resolved" });
    }
    default:
      return compact({ ...base, raw_state: String(status ?? ""), state: "unknown", terminal: false });
  }
}

export const metaculus: Adapter = {
  id: "metaculus",
  available: (ctx) => !!ctx.config.metaculusToken,
  parse(url) {
    const m = RE.exec(url);
    return m ? { item_type: "question", ids: { id: m[1] } } : null;
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    if (!ctx.config.metaculusToken) throw new AdapterError("Metaculus needs an API token (METACULUS_TOKEN)", undefined, { manualFallback: true });
    const r = await getJson(
      ctx,
      `https://${HOST}/api/posts/${encodeURIComponent(parsed.ids.id)}/`,
      { Accept: "application/json", Authorization: `Token ${ctx.config.metaculusToken}`, "User-Agent": "question-register" },
      HOST,
    );
    if (r.status === 404) throw new AdapterError("Not found on Metaculus");
    if (r.status === 401 || r.status === 403) throw new AdapterError("Metaculus refused the request (check METACULUS_TOKEN)");
    if (r.status === 429) throw new AdapterError("Metaculus rate limit reached; will retry later", 15 * 60_000);
    if (r.status !== 200) throw new AdapterError(`Metaculus returned HTTP ${r.status}`);
    return { fetched: normalizePost(r.json) };
  },
};
