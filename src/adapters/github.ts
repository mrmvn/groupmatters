// GitHub adapter: public REST API v3 (verified in M0, see DECISIONS.md).
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, getJson } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

const API_HOST = "api.github.com";
const RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,10})(?:[/?#]|$)/;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

export function normalizePull(d: any): F {
  const base = {
    title: clip(d.title),
    dates: { opens_at: d.created_at ?? undefined, updated_at: d.updated_at ?? undefined } as NonNullable<F["dates"]>,
    extra: { author: d.user?.login ?? "", comments: (d.comments ?? 0) + (d.review_comments ?? 0) } as Record<string, string | number | boolean>,
  };
  if (d.state === "open") {
    if (d.draft) return { ...base, raw_state: "draft", state: "not_started", terminal: false, outcome_summary: "Draft" };
    return { ...base, raw_state: "open", state: "open", terminal: false, outcome_summary: "Open" };
  }
  if (d.merged || d.merged_at) {
    base.dates.resolved_at = d.merged_at ?? d.closed_at ?? undefined;
    return { ...base, raw_state: "merged", state: "accepted", terminal: true, outcome_summary: "Merged" };
  }
  base.dates.resolved_at = d.closed_at ?? undefined;
  return { ...base, raw_state: "closed", state: "rejected", terminal: true, outcome_summary: "Closed without merge" };
}

export function normalizeIssue(d: any): F {
  const base = {
    title: clip(d.title),
    dates: { opens_at: d.created_at ?? undefined, updated_at: d.updated_at ?? undefined } as NonNullable<F["dates"]>,
    extra: { author: d.user?.login ?? "", comments: d.comments ?? 0 } as Record<string, string | number | boolean>,
  };
  if (d.state === "open") return { ...base, raw_state: "open", state: "open", terminal: false, outcome_summary: "Open" };
  base.dates.resolved_at = d.closed_at ?? undefined;
  switch (d.state_reason) {
    case "completed":
      return { ...base, raw_state: "closed (completed)", state: "accepted", terminal: true, outcome_summary: "Closed as completed" };
    case "not_planned":
      return { ...base, raw_state: "closed (not planned)", state: "rejected", terminal: true, outcome_summary: "Closed as not planned" };
    case "duplicate":
      return { ...base, raw_state: "closed (duplicate)", state: "withdrawn", terminal: true, outcome_summary: "Closed as duplicate" };
    default:
      return { ...base, raw_state: "closed", state: "concluded", terminal: true, outcome_summary: "Closed" };
  }
}

function headers(ctx: Ctx, etag?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "question-register",
  };
  if (ctx.config.githubToken) h.Authorization = `Bearer ${ctx.config.githubToken}`;
  if (etag) h["If-None-Match"] = etag;
  return h;
}

function check(status: number, json: any, h: Headers) {
  if (status === 200) return;
  if (status === 404) throw new AdapterError("Not found on GitHub (deleted, or a private repository?)");
  if (status === 403 || status === 429) {
    const reset = Number(h.get("x-ratelimit-reset"));
    const retry = Number(h.get("retry-after"));
    const ms = retry ? retry * 1000 : reset ? Math.max(reset * 1000 - Date.now(), 60_000) : 15 * 60_000;
    throw new AdapterError("GitHub rate limit reached; will retry later", ms);
  }
  throw new AdapterError(`GitHub returned HTTP ${status}${json?.message ? `: ${clip(json.message, 120)}` : ""}`);
}

export const github: Adapter = {
  id: "github",
  retrieves: {
    pull_request: ["title", "status", "dates", "last activity", "author", "comments"],
    issue: ["title", "status (with the closing reason)", "dates", "last activity", "author", "comments"],
  },
  parse(url) {
    const m = RE.exec(url);
    if (!m) return null;
    return { item_type: m[3] === "pull" ? "pull_request" : "issue", ids: { owner: m[1], repo: m[2], number: m[4] } };
  },
  async fetch(parsed: Parsed, ctx: Ctx, opts = {}): Promise<FetchResult> {
    const { owner, repo, number } = parsed.ids;
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const kind = parsed.item_type === "pull_request" ? "pulls" : "issues";
    const r = await getJson(ctx, `https://${API_HOST}${path}/${kind}/${encodeURIComponent(number)}`, headers(ctx, opts.etag), API_HOST);
    if (r.status === 304) return { notModified: true };
    check(r.status, r.json, r.headers);
    const etag = r.headers.get("etag") ?? undefined;
    if (kind === "pulls") return { fetched: normalizePull(r.json), etag };
    // An "issue" URL can point at a pull request: normalize it as one.
    if (r.json.pull_request) {
      const pr = await getJson(ctx, `https://${API_HOST}${path}/pulls/${encodeURIComponent(number)}`, headers(ctx), API_HOST);
      check(pr.status, pr.json, pr.headers);
      return { fetched: normalizePull(pr.json) };
    }
    return { fetched: normalizeIssue(r.json), etag };
  },
};
