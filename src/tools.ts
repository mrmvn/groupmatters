// Tool registry: seed tools, URL matching and classification (spec §5).
import type { Ctx } from "./ctx.ts";
import type { Tool } from "./types.ts";
import { getAdapter, type Parsed } from "./adapters/index.ts";
import { bad, isHttpsUrl, requireText } from "./util.ts";

// URL patterns use the WHATWG URLPattern syntax (see DECISIONS.md).
export const SEED_TOOLS: Tool[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Changes to code or documents (pull requests), and tasks, bugs or proposals tracked as issues, in public GitHub repositories.",
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
    description: "Merge requests and issues on gitlab.com (and on other GitLab servers the operator allows): changes to code or documents, tracked tasks and proposals.",
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
    description: "Forecasting: how likely something is to happen, estimated by a crowd of forecasters, until the question resolves.",
    // Automatic only when the operator sets METACULUS_TOKEN; otherwise updated by hand.
    fetch_mode: "auto",
    adapter: "metaculus",
    enabled: true,
    url_patterns: [
      { pattern: "https://www.metaculus.com/questions/:id(\\d+){/*}?", item_type: "question" },
      { pattern: "https://metaculus.com/questions/:id(\\d+){/*}?", item_type: "question" },
    ],
  },
  {
    id: "loomio",
    name: "Loomio",
    description: "Group decisions: proposals, polls and votes, with a discussion thread around them.",
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
  },
  {
    id: "polis",
    name: "Polis",
    description: "Mapping opinions in a large group: people vote on short statements, and Polis shows where they agree and where they split.",
    fetch_mode: "auto",
    adapter: "polis",
    enabled: true,
    url_patterns: [
      { pattern: "https://pol.is/report/:id", item_type: "conversation" },
      { pattern: "https://pol.is/:id", item_type: "conversation" },
    ],
  },
  {
    // Any Decidim instance: its URLs are distinctive, and fetches only go to public addresses.
    id: "decidim",
    name: "Decidim",
    description: "Citizen participation platforms run by cities and organisations: proposals, debates, meetings and whole participatory processes.",
    fetch_mode: "auto",
    adapter: "decidim",
    enabled: true,
    url_patterns: [
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/proposals/:id(\\d+){/*}?", item_type: "proposal" },
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/debates/:id(\\d+){/*}?", item_type: "debate" },
      { pattern: "https://*/:space(processes|assemblies|conferences|initiatives)/:slug/f/:component(\\d+)/meetings/:id(\\d+){/*}?", item_type: "meeting" },
      { pattern: "https://*/processes/:slug{/}?", item_type: "participatory_process" },
    ],
  },
  {
    id: "kialo",
    name: "Kialo",
    description: "Structured debate: mapping the arguments for and against a claim, as a tree.",
    fetch_mode: "manual",
    enabled: true,
    url_patterns: [
      { pattern: "https://www.kialo.com/:slug", item_type: "discussion" },
      { pattern: "https://www.kialo-edu.com/*", item_type: "discussion" },
    ],
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

/** Tools added by giving an instance's address: the patterns are generated, the adapter fetches. */
export const INSTANCE_KINDS: Record<string, { name: string; description: string; adapter: string; patterns: (host: string) => { pattern: string; item_type: string }[] }> = {
  consul: {
    name: "Consul Democracy",
    description: "A city's or organisation's citizen participation site: proposals, debates, participatory budgets and the projects voted in them.",
    adapter: "consul",
    patterns: (host) => [
      { pattern: `https://${host}/proposals/:id{/*}?`, item_type: "proposal" },
      { pattern: `https://${host}/debates/:id{/*}?`, item_type: "debate" },
      { pattern: `https://${host}/budgets/:id(\\d+)/investments/:inv{/*}?`, item_type: "investment" },
      { pattern: `https://${host}/budgets/:id(\\d+){/}?`, item_type: "budget" },
    ],
  },
};

/** A pattern suggestion for "propose adding this tool": same host, any path. */
export function suggestPattern(url: string): { name: string; pattern: string } | undefined {
  if (!isHttpsUrl(url)) return undefined;
  const host = new URL(url).hostname;
  return { name: host.replace(/^www\./, ""), pattern: `https://${host}/*` };
}
