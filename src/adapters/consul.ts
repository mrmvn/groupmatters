// Consul Democracy adapter: the public, read-only GraphQL API at /graphql (verified on
// demo.consuldemocracy.org and sammenomaarhus.dk, 2026-10). Consul URLs are generic (/proposals/12),
// so a group adds its instance once (a tool with adapter "consul" and that host's patterns).
// Recent versions use camelCase fields, older ones snake_case: both are tried. Forks with another
// schema (e.g. some German "projekt" forks) give what they can (usually the title); states by hand.
//
// Consul has no explicit "state" on proposals: they are open until "retired" with a reason
// (done / started / unfeasible / duplicated / other). Budgets have phases; investments a feasibility.
// No last-activity timestamp is exposed (milestones' publication dates are used when present).
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson, iso, tolerantQuery } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched, NormalizedState } from "../types.ts";
import { hostIsPublic } from "../net.ts";

const RE = /^https:\/\/([a-z0-9.-]+)\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?(proposals|debates|budgets)\/(\d{1,12})(?:[-\w%]*)(?:\/investments\/(\d{1,12})[-\w%]*)?\/?(?:[?#]|$)/;

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

/** Read a field whichever casing the instance uses. */
const get = (o: any, camel: string) => o?.[camel] ?? o?.[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a}_${b.toLowerCase()}`);
const count = (n: unknown, word: string) => (typeof n === "number" ? `${n} ${word}${n === 1 ? "" : "s"}` : undefined);
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");

/** Consul dates look like "2026-10-29 03:00:00 +0100". */
const consulDate = (v: unknown) => (typeof v === "string" ? iso(v.replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2})$/, "$1T$2$3:$4")) : undefined);

function lastMilestone(o: any): { at?: string; title?: string } {
  const nodes = (get(o, "milestones")?.edges ?? []).map((e: any) => e.node).filter(Boolean);
  const dated = nodes.map((n: any) => ({ at: consulDate(get(n, "publicationDate")), title: n.title })).filter((n: any) => n.at);
  dated.sort((a: any, b: any) => (a.at < b.at ? 1 : -1));
  return dated[0] ?? {};
}

const RETIRED: Record<string, { state: NormalizedState; raw: string }> = {
  done: { state: "accepted", raw: "Done" },
  started: { state: "open", raw: "Started" },
  unfeasible: { state: "rejected", raw: "Unfeasible" },
  duplicated: { state: "withdrawn", raw: "Duplicate" },
  other: { state: "withdrawn", raw: "Retired" },
};


export function normalizeProposal(p: any): F {
  const reason = get(p, "retiredReason");
  const retired = get(p, "retiredAt") ? (RETIRED[reason] ?? RETIRED.other) : undefined;
  const state = retired?.state ?? "open";
  const raw = retired?.raw ?? "Open";
  const ms = lastMilestone(p);
  const votes = get(p, "cachedVotesUp");
  return compact({
    title: clip(p.title),
    raw_state: raw,
    state,
    terminal: state !== "open",
    outcome_summary: clip(join(raw, count(votes, "support"), count(get(p, "commentsCount"), "comment"), ms.title)),
    dates: compact({ opens_at: consulDate(get(p, "publicCreatedAt")), resolved_at: retired ? consulDate(get(p, "retiredAt")) : undefined, updated_at: ms.at }),
    extra: compact({ supports: votes ?? undefined, comments: get(p, "commentsCount") ?? undefined, explanation: clip(get(p, "retiredExplanation")) }) as Record<string, string | number | boolean>,
  });
}

export function normalizeDebate(d: any): F {
  const up = get(d, "cachedVotesUp");
  const down = get(d, "cachedVotesDown");
  return compact({
    title: clip(d.title),
    raw_state: "Open",
    state: "open",
    terminal: false,
    outcome_summary: clip(join("Open", typeof up === "number" ? `${up} for, ${down ?? 0} against` : undefined, count(get(d, "commentsCount"), "comment"))),
    dates: compact({ opens_at: consulDate(get(d, "publicCreatedAt")) }),
    extra: compact({ votes_for: up ?? undefined, votes_against: down ?? undefined, comments: get(d, "commentsCount") ?? undefined }) as Record<string, string | number | boolean>,
  });
}

const PHASES: Record<string, NormalizedState> = {
  drafting: "not_started",
  informing: "not_started",
  accepting: "open",
  reviewing: "open",
  selecting: "open",
  valuating: "open",
  publishing_prices: "open",
  balloting: "open",
  reviewing_ballots: "open",
  finished: "concluded",
};

export function normalizeBudget(b: any): F {
  const phase = String(b.phase ?? "");
  const state = PHASES[phase] ?? "unknown";
  const raw = phase ? phase.charAt(0).toUpperCase() + phase.slice(1).replace(/_/g, " ") : "Unknown";
  return compact({ title: clip(b.name), raw_state: raw, state, terminal: state === "concluded", outcome_summary: raw === "Finished" ? "Finished" : `Phase: ${raw}` });
}

export function normalizeInvestment(i: any, budget: any): F {
  const feas = String(i.feasibility ?? "");
  const phase = PHASES[String(budget?.phase ?? "")];
  let state: NormalizedState = "open";
  let raw = "Open";
  if (feas === "unfeasible") (state = "rejected"), (raw = "Unfeasible");
  else if (phase === "concluded") (state = "concluded"), (raw = "Budget finished");
  else if (phase === "not_started") (state = "not_started"), (raw = "Not open yet");
  const ms = lastMilestone(i);
  return compact({
    title: clip(i.title),
    raw_state: raw,
    state,
    terminal: state !== "open" && state !== "not_started",
    outcome_summary: clip(join(raw, feas && feas !== "unfeasible" ? `feasibility: ${feas}` : undefined, i.price ? `price ${i.price}` : undefined, ms.title)),
    dates: compact({ updated_at: ms.at }),
    extra: compact({ feasibility: feas || undefined, price: i.price ?? undefined, comments: get(i, "commentsCount") ?? undefined, budget: budget?.name }) as Record<string, string | number | boolean>,
  });
}

const MS = "milestones { edges { node { publicationDate title } } }";
const FIELDS: Record<string, string[]> = {
  proposal: ["id", "title", "publicCreatedAt", "cachedVotesUp", "commentsCount", "retiredAt", "retiredReason", "retiredExplanation", MS],
  debate: ["id", "title", "publicCreatedAt", "cachedVotesUp", "cachedVotesDown", "commentsCount"],
  budget: ["id", "name", "phase"],
  investment: ["id", "title", "feasibility", "price", "commentsCount", MS],
};

function buildQuery(parsed: Parsed, fields: string[], casing: "camel" | "snake"): string {
  const f = (casing === "snake" ? fields.map(snake) : fields).join(" ");
  const { item_type, ids } = parsed;
  if (item_type === "investment") return `{ budget(id: ${Number(ids.budget)}) { name phase investment(id: ${Number(ids.id)}) { ${f} } } }`;
  return `{ ${item_type}(id: ${Number(ids.id)}) { ${f} } }`;
}

export const consul: Adapter = {
  id: "consul",
  retrieves: {
    proposal: ["title", "status", "dates", "last milestone", "supports", "comments", "the retirement explanation"],
    debate: ["title", "opening date", "votes for and against", "comments"],
    budget: ["name", "phase"],
    investment: ["title", "status", "last milestone", "feasibility", "price", "comments", "budget"],
  },
  parse(url): Parsed | null {
    const m = RE.exec(url);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (m[2] === "budgets") return m[4] ? { item_type: "investment", ids: { host, budget: m[3], id: m[4] } } : { item_type: "budget", ids: { host, id: m[3] } };
    return { item_type: m[2].replace(/s$/, ""), ids: { host, id: m[3] } };
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    const host = parsed.ids.host;
    if (!(await hostIsPublic(ctx, host))) throw new AdapterError("This address isn't reachable from the register");
    const ask = async (casing: "camel" | "snake") =>
      tolerantQuery(async (fields) => {
        const url = `https://${host}/graphql?query=${encodeURIComponent(buildQuery(parsed, fields, casing))}`;
        // Some instances reject requests without a browser-like user agent (Consul docs).
        const r = await getJson(ctx, url, { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; question-register)" }, host);
        if (r.status === 429) throw new AdapterError("Consul rate limit reached; will retry later", 15 * 60_000);
        if (r.status !== 200 || !r.json || typeof r.json !== "object") throw new AdapterError(`No Consul API answered at ${host} (HTTP ${r.status})`);
        return r.json;
      }, casing === "snake" ? FIELDS[parsed.item_type].map(snake) : FIELDS[parsed.item_type]);
    const pick = (json: any) => (parsed.item_type === "investment" ? json?.data?.budget?.investment : json?.data?.[parsed.item_type]);
    let json = await ask("camel");
    // Older instances: snake_case fields (a camelCase query then only keeps "id" and "title").
    const item0 = pick(json);
    const sparse = item0 && Object.keys(item0).length <= 2 && parsed.item_type !== "budget";
    if (!item0 || sparse) {
      const alt = await ask("snake");
      if (pick(alt) && Object.keys(pick(alt)).length > Object.keys(item0 ?? {}).length) json = alt;
    }
    const item = pick(json);
    if (!item) throw new AdapterError("Not found on this Consul instance (hidden, or not public?)");
    const fetched =
      parsed.item_type === "proposal"
        ? normalizeProposal(item)
        : parsed.item_type === "debate"
          ? normalizeDebate(item)
          : parsed.item_type === "budget"
            ? normalizeBudget(item)
            : normalizeInvestment(item, json.data.budget);
    return { fetched };
  },
};
