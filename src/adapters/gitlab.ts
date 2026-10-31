// GitLab adapter: REST API v4, gitlab.com and operator-allowed self-hosted instances.
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, getJson } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

const RE = /^https:\/\/([a-z0-9.-]+)\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)\/-\/(merge_requests|issues|work_items)\/(\d{1,10})(?:[/?#]|$)/i;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

export function normalizeMergeRequest(d: any): F {
  const base = {
    title: clip(d.title),
    dates: { opens_at: d.created_at ?? undefined, updated_at: d.updated_at ?? undefined } as NonNullable<F["dates"]>,
    extra: { author: d.author?.username ?? "", comments: d.user_notes_count ?? 0 } as Record<string, string | number | boolean>,
  };
  switch (d.state) {
    case "merged":
      base.dates.resolved_at = d.merged_at ?? d.updated_at ?? undefined;
      return { ...base, raw_state: "merged", state: "accepted", terminal: true, outcome_summary: "Merged" };
    case "closed":
      base.dates.resolved_at = d.closed_at ?? undefined;
      return { ...base, raw_state: "closed", state: "rejected", terminal: true, outcome_summary: "Closed without merge" };
    case "opened":
    case "locked":
      if (d.draft || d.work_in_progress) return { ...base, raw_state: "draft", state: "not_started", terminal: false, outcome_summary: "Draft" };
      return { ...base, raw_state: d.state, state: "open", terminal: false, outcome_summary: "Open" };
    default:
      return { ...base, raw_state: String(d.state ?? ""), state: "unknown", terminal: false };
  }
}

export function normalizeIssue(d: any): F {
  const base = {
    title: clip(d.title),
    dates: { opens_at: d.created_at ?? undefined, updated_at: d.updated_at ?? undefined } as NonNullable<F["dates"]>,
    extra: {
      author: d.author?.username ?? "",
      comments: d.user_notes_count ?? 0,
      upvotes: d.upvotes ?? 0,
      downvotes: d.downvotes ?? 0,
    } as Record<string, string | number | boolean>,
  };
  if (d.state === "opened") return { ...base, raw_state: "opened", state: "open", terminal: false, outcome_summary: "Open" };
  if (d.state === "closed") {
    base.dates.resolved_at = d.closed_at ?? undefined;
    if (d.moved_to_id) return { ...base, raw_state: "closed (moved)", state: "withdrawn", terminal: true, outcome_summary: "Moved" };
    // GitLab does not record why an issue was closed: the steward confirms the meaning.
    return { ...base, raw_state: "closed", state: "concluded", terminal: true, outcome_summary: "Closed" };
  }
  return { ...base, raw_state: String(d.state ?? ""), state: "unknown", terminal: false };
}

export const gitlab: Adapter = {
  id: "gitlab",
  retrieves: {
    merge_request: ["title", "status", "dates", "last activity", "author", "comments"],
    issue: ["title", "status", "dates", "last activity", "author", "comments", "up/down votes"],
  },
  parse(url, ctx) {
    const m = RE.exec(url);
    if (!m) return null;
    const host = m[1].toLowerCase();
    // SSRF guard: only hosts the operator allowed (gitlab.com by default).
    if (!ctx.config.gitlabHosts.includes(host)) return null;
    return {
      item_type: m[3].toLowerCase() === "merge_requests" ? "merge_request" : "issue",
      ids: { host, project: m[2], iid: m[4] },
    };
  },
  async fetch(parsed: Parsed, ctx: Ctx, opts = {}): Promise<FetchResult> {
    const { host, project, iid } = parsed.ids;
    if (!ctx.config.gitlabHosts.includes(host)) throw new AdapterError(`GitLab host ${host} is not allowed on this server`);
    const kind = parsed.item_type === "merge_request" ? "merge_requests" : "issues";
    const h: Record<string, string> = { Accept: "application/json", "User-Agent": "question-register" };
    if (ctx.config.gitlabToken && host === "gitlab.com") h["PRIVATE-TOKEN"] = ctx.config.gitlabToken;
    if (opts.etag) h["If-None-Match"] = opts.etag;
    const url = `https://${host}/api/v4/projects/${encodeURIComponent(project)}/${kind}/${encodeURIComponent(iid)}`;
    const r = await getJson(ctx, url, h, host);
    if (r.status === 304) return { notModified: true };
    if (r.status === 404) throw new AdapterError("Not found on GitLab (deleted, or a private project?)");
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after")) || 60;
      throw new AdapterError("GitLab rate limit reached; will retry later", retry * 1000);
    }
    if (r.status !== 200) throw new AdapterError(`GitLab returned HTTP ${r.status}`);
    const etag = r.headers.get("etag") ?? undefined;
    return { fetched: kind === "merge_requests" ? normalizeMergeRequest(r.json) : normalizeIssue(r.json), etag };
  },
};
