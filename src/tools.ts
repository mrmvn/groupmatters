// Tool registry: seed tools, URL matching and classification (spec §5).
import type { Ctx } from "./ctx.ts";
import type { NormalizedState, Tool } from "./types.ts";
import { NORMALIZED_STATES } from "./types.ts";
import { getAdapter, type Parsed } from "./adapters/index.ts";
import { bad, isHttpsUrl, requireText } from "./util.ts";

// URL patterns use the WHATWG URLPattern syntax (see DECISIONS.md).
export const SEED_TOOLS: Tool[] = [
  {
    id: "github",
    name: "GitHub",
    fetch_mode: "auto",
    adapter: "github",
    enabled: true,
    url_patterns: [
      { pattern: "https://github.com/:owner/:repo/pull/:number(\\d+){/*}?", item_type: "pull_request" },
      { pattern: "https://github.com/:owner/:repo/issues/:number(\\d+){/*}?", item_type: "issue" },
    ],
  },
  {
    id: "gitlab",
    name: "GitLab",
    fetch_mode: "auto",
    adapter: "gitlab",
    enabled: true,
    url_patterns: [
      { pattern: "https://*/*/-/merge_requests/:iid(\\d+){/*}?", item_type: "merge_request" },
      { pattern: "https://*/*/-/issues/:iid(\\d+){/*}?", item_type: "issue" },
      { pattern: "https://*/*/-/work_items/:iid(\\d+){/*}?", item_type: "issue" },
    ],
  },
  {
    id: "metaculus",
    name: "Metaculus",
    // Automatic only when the operator sets METACULUS_TOKEN; otherwise updated by hand.
    fetch_mode: "auto",
    adapter: "metaculus",
    enabled: true,
    url_patterns: [
      { pattern: "https://www.metaculus.com/questions/:id(\\d+){/*}?", item_type: "question" },
      { pattern: "https://metaculus.com/questions/:id(\\d+){/*}?", item_type: "question" },
    ],
    state_map: {
      Upcoming: "not_started",
      Open: "open",
      "Closed, awaiting resolution": "open",
      "Resolved: Yes": "accepted",
      "Resolved: No": "rejected",
      "Resolved (numeric, date or multiple choice)": "concluded",
      Annulled: "withdrawn",
      Ambiguous: "withdrawn",
    },
  },
  {
    id: "loomio",
    name: "Loomio",
    // Public polls and threads are fetched; private ones fall back to updating by hand.
    fetch_mode: "auto",
    adapter: "loomio",
    enabled: true,
    url_patterns: [
      { pattern: "https://www.loomio.com/p/:key{/*}?", item_type: "poll" },
      { pattern: "https://loomio.com/p/:key{/*}?", item_type: "poll" },
      { pattern: "https://www.loomio.com/d/:key{/*}?", item_type: "discussion" },
      { pattern: "https://loomio.com/d/:key{/*}?", item_type: "discussion" },
    ],
    state_map: {
      "Not yet open": "not_started",
      Open: "open",
      "Closed: passed": "accepted",
      "Closed: not passed": "rejected",
      "Closed (other outcome)": "concluded",
      "Discussion closed": "concluded",
      Deleted: "withdrawn",
    },
  },
  {
    id: "polis",
    name: "Polis",
    fetch_mode: "auto",
    adapter: "polis",
    enabled: true,
    url_patterns: [
      { pattern: "https://pol.is/report/:id", item_type: "conversation" },
      { pattern: "https://pol.is/:id", item_type: "conversation" },
    ],
    state_map: { Open: "open", Closed: "concluded" },
  },
  {
    // Any Decidim instance: its URLs are distinctive, and fetches only go to public addresses.
    id: "decidim",
    name: "Decidim",
    fetch_mode: "auto",
    adapter: "decidim",
    enabled: true,
    url_patterns: [
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/proposals/:id(\\d+){/*}?", item_type: "proposal" },
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/debates/:id(\\d+){/*}?", item_type: "debate" },
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/meetings/:id(\\d+){/*}?", item_type: "meeting" },
      { pattern: "https://*/processes/:slug{/}?", item_type: "participatory_process" },
    ],
    // Used only if an item can't be fetched (private): its state is then set by hand.
    state_map: { Open: "open", Evaluating: "open", Accepted: "accepted", Rejected: "rejected", Withdrawn: "withdrawn", Finished: "concluded" },
  },
  {
    id: "kialo",
    name: "Kialo",
    fetch_mode: "manual",
    enabled: true,
    url_patterns: [
      { pattern: "https://www.kialo.com/:slug", item_type: "discussion" },
      { pattern: "https://www.kialo-edu.com/*", item_type: "discussion" },
    ],
    state_map: { Open: "open", Closed: "concluded" },
  },
];

/** `fetch_mode` is the effective mode: an auto tool whose adapter isn't usable here acts as manual. */
export type Match = { tool: Tool; item_type: string; parsed?: Parsed; fetch_mode: "auto" | "manual" };

const patternCache = new Map<string, URLPattern>();
function compile(p: string): URLPattern {
  let c = patternCache.get(p);
  if (!c) {
    c = new URLPattern(p);
    patternCache.set(p, c);
  }
  return c;
}

/** Find the first enabled tool whose pattern matches the URL. Auto tools also need their adapter to parse it. */
export function matchUrl(ctx: Ctx, tools: Tool[], url: string): Match | undefined {
  if (!isHttpsUrl(url)) return undefined;
  for (const tool of tools) {
    if (!tool.enabled) continue;
    for (const { pattern, item_type } of tool.url_patterns) {
      let ok = false;
      try {
        ok = compile(pattern).test(url);
      } catch {
        continue;
      }
      if (!ok) continue;
      if (tool.fetch_mode === "manual") return { tool, item_type, fetch_mode: "manual" };
      const adapter = tool.adapter ? getAdapter(tool.adapter) : undefined;
      const parsed = adapter?.parse(url, ctx);
      if (!parsed) continue;
      const usable = !adapter!.available || adapter!.available(ctx);
      return { tool, item_type: parsed.item_type, parsed, fetch_mode: usable ? "auto" : "manual" };
    }
  }
  return undefined;
}

export function validatePattern(p: unknown): string {
  const pattern = requireText(p, "URL pattern", 500);
  let compiled: URLPattern;
  try {
    compiled = new URLPattern(pattern);
  } catch {
    throw bad(`"${pattern}" is not a valid URL pattern. Example: https://pol.is/:id`);
  }
  if (compiled.protocol !== "https") throw bad("URL patterns must start with https://");
  return pattern;
}

export function validateStateMap(m: unknown): Record<string, NormalizedState> | undefined {
  if (m == null) return undefined;
  if (typeof m !== "object" || Array.isArray(m)) throw bad("States must be an object of label → state");
  const out: Record<string, NormalizedState> = {};
  for (const [k, v] of Object.entries(m)) {
    const label = requireText(k, "State label", 80);
    if (!NORMALIZED_STATES.includes(v as NormalizedState)) throw bad(`Unknown state "${v}"`);
    out[label] = v as NormalizedState;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Tools added by giving an instance's address: the patterns are generated, the adapter fetches. */
export const INSTANCE_KINDS: Record<string, { name: string; adapter: string; patterns: (host: string) => { pattern: string; item_type: string }[]; state_map: Record<string, NormalizedState> }> = {
  consul: {
    name: "Consul Democracy",
    adapter: "consul",
    patterns: (host) => [
      { pattern: `https://${host}/proposals/:id{/*}?`, item_type: "proposal" },
      { pattern: `https://${host}/debates/:id{/*}?`, item_type: "debate" },
      { pattern: `https://${host}/budgets/:id(\\d+)/investments/:inv{/*}?`, item_type: "investment" },
      { pattern: `https://${host}/budgets/:id(\\d+){/}?`, item_type: "budget" },
    ],
    state_map: { Open: "open", Started: "open", Done: "accepted", Unfeasible: "rejected", Retired: "withdrawn", Finished: "concluded" },
  },
};

/** A pattern suggestion for "propose adding this tool": same host, any path. */
export function suggestPattern(url: string): { name: string; pattern: string } | undefined {
  if (!isHttpsUrl(url)) return undefined;
  const host = new URL(url).hostname;
  return { name: host.replace(/^www\./, ""), pattern: `https://${host}/*` };
}
