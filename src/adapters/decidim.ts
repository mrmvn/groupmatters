// Decidim adapter: the public GraphQL API every Decidim instance serves at /api (verified on
// meta.decidim.org and participa.gencat.cat, 2026-10). Works with any instance: Decidim URLs are
// distinctive (/processes/<slug>/f/<component>/proposals/<id>), and requests only go to public
// addresses (checked before each fetch). Fields an instance doesn't know (older versions) are dropped.
//
// Items: proposals, debates, meetings (in processes, assemblies, conferences, initiatives) and
// participatory processes themselves. Last activity: `updatedAt` where Decidim exposes it.
import type { Adapter, FetchResult, Parsed } from "./common.ts";
import { AdapterError, clip, compact, getJson, iso, tolerantQuery } from "./common.ts";
import type { Ctx } from "../ctx.ts";
import type { Fetched, NormalizedState } from "../types.ts";
import { hostIsPublic } from "../net.ts";

const RE =
  /^https:\/\/([a-z0-9.-]+)\/(processes|assemblies|conferences|initiatives)\/([A-Za-z0-9_-]{1,100})(?:\/f\/(\d{1,10})\/(proposals|debates|meetings)\/(\d{1,12}))?\/?(?:[?#]|$)/i;
const LOCALES = ["en", "es", "fr", "ca", "de", "it", "pt", "eu", "gl"];

type F = Omit<Fetched, "fetched_at" | "fetch_error">;

/** Pick a translation: a common locale first, then whatever exists. */
export function pickTranslation(t: any): string | undefined {
  const list: { locale: string; text: string }[] = (t?.translations ?? []).filter((x: any) => typeof x?.text === "string" && x.text.trim());
  for (const l of LOCALES) {
    const hit = list.find((x) => x.locale === l);
    if (hit) return hit.text;
  }
  return list[0]?.text ?? (typeof t?.translation === "string" ? t.translation : undefined);
}

const stripHtml = (s?: string) =>
  s
    ?.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim() || undefined;

const humanize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const count = (n: unknown, word: string) => (typeof n === "number" ? `${n} ${word}${n === 1 ? "" : "s"}` : undefined);
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");

export function normalizeProposal(p: any): F {
  const custom = pickTranslation(p.proposalState?.title);
  const state: string | null = p.state ?? null;
  let category: NormalizedState;
  let raw: string;
  if (p.withdrawnAt || p.withdrawn || state === "withdrawn") (category = "withdrawn"), (raw = "Withdrawn");
  else if (state === "accepted") (category = "accepted"), (raw = custom ?? "Accepted");
  else if (state === "rejected") (category = "rejected"), (raw = custom ?? "Rejected");
  else if (state === "evaluating") (category = "open"), (raw = custom ?? "Evaluating");
  else if (!state || state === "not_answered" || state === "published") (category = "open"), (raw = "Open");
  // Custom states (Decidim ≥ 0.28): unknown meaning; once answered, count it as concluded.
  else (category = p.answeredAt ? "concluded" : "open"), (raw = custom ?? humanize(state));
  return compact({
    title: clip(pickTranslation(p.title)),
    raw_state: raw,
    state: category,
    terminal: ["accepted", "rejected", "concluded", "withdrawn"].includes(category),
    outcome_summary: clip(join(raw, count(p.voteCount, "support"), count(p.totalCommentsCount, "comment"))),
    dates: compact({ opens_at: iso(p.publishedAt), resolved_at: category === "open" ? undefined : iso(p.answeredAt ?? p.withdrawnAt), updated_at: iso(p.updatedAt) }),
    extra: compact({ supports: p.voteCount ?? undefined, comments: p.totalCommentsCount ?? undefined, answer: clip(stripHtml(pickTranslation(p.answer))) }) as Record<string, string | number | boolean>,
  });
}

/** Meetings and debates: by their dates, unless closed (or withdrawn) explicitly. */
function byDates(start: unknown, end: unknown, now: Date): { state: NormalizedState; raw: string } {
  const s = iso(start);
  const e = iso(end);
  if (s && new Date(s) > now) return { state: "not_started", raw: "Upcoming" };
  if (e && new Date(e) < now) return { state: "concluded", raw: "Ended" };
  return { state: "open", raw: "Open" };
}

export function normalizeMeeting(m: any, now: Date): F {
  let { state, raw } = byDates(m.startTime, m.endTime, now);
  if (m.withdrawnAt) (state = "withdrawn"), (raw = "Withdrawn");
  else if (m.closed) (state = "concluded"), (raw = "Closed");
  else if (state === "concluded") raw = "Held";
  const report = clip(stripHtml(pickTranslation(m.closingReport)));
  return compact({
    title: clip(pickTranslation(m.title)),
    raw_state: raw,
    state,
    terminal: state === "concluded" || state === "withdrawn",
    outcome_summary: clip(report ?? join(raw, count(m.attendeesCount, "attendee"))),
    dates: compact({ opens_at: iso(m.startTime), closes_at: iso(m.endTime), resolved_at: state === "concluded" ? iso(m.endTime) : undefined, updated_at: iso(m.updatedAt) }),
    extra: compact({ attendees: m.attendeesCount ?? undefined, outcome: report }) as Record<string, string | number | boolean>,
  });
}

export function normalizeDebate(d: any, now: Date): F {
  let { state, raw } = byDates(d.startTime, d.endTime, now);
  if (d.closedAt) (state = "concluded"), (raw = "Closed");
  const conclusions = clip(stripHtml(pickTranslation(d.conclusions)));
  return compact({
    title: clip(pickTranslation(d.title)),
    raw_state: raw,
    state,
    terminal: state === "concluded",
    outcome_summary: clip(conclusions ?? join(raw, count(d.commentsCount, "comment"))),
    dates: compact({ opens_at: iso(d.startTime ?? d.createdAt), closes_at: iso(d.endTime), resolved_at: iso(d.closedAt), updated_at: iso(d.updatedAt ?? d.lastCommentAt) }),
    extra: compact({ comments: d.commentsCount ?? undefined, outcome: conclusions }) as Record<string, string | number | boolean>,
  });
}

/** Participatory processes: by their start/end dates; the active step names the phase. */
export function normalizeProcess(p: any, now: Date): F {
  const start = iso(p.startDate);
  // endDate is a day: the process runs until the end of it.
  const end = p.endDate ? iso(`${String(p.endDate).slice(0, 10)}T23:59:59Z`) : undefined;
  const steps: any[] = p.steps ?? [];
  const active = steps.find((s) => s.active);
  let state: NormalizedState = "open";
  if (start && new Date(start) > now) state = "not_started";
  else if (end && new Date(end) < now) state = "concluded";
  const raw = state === "not_started" ? "Upcoming" : state === "concluded" ? "Finished" : (pickTranslation(active?.title) ?? "Open");
  const stepNo = active ? steps.indexOf(active) + 1 : undefined;
  return compact({
    title: clip(pickTranslation(p.title)),
    raw_state: clip(raw, 80),
    state,
    terminal: state === "concluded",
    outcome_summary: clip(state === "open" && stepNo ? `Step ${stepNo} of ${steps.length}: ${raw}` : raw),
    dates: compact({ opens_at: start, closes_at: end, resolved_at: state === "concluded" ? end : undefined, updated_at: iso(p.updatedAt) }),
    extra: compact({ steps: steps.length || undefined }) as Record<string, string | number | boolean>,
  });
}

const T = (name: string) => `${name} { translations { locale text } }`;
const FIELDS: Record<string, string[]> = {
  proposal: ["id", T("title"), "state", `proposalState { ${T("title")} }`, "publishedAt", "answeredAt", "updatedAt", "voteCount", "totalCommentsCount", "withdrawnAt", T("answer")],
  meeting: ["id", T("title"), "startTime", "endTime", "closed", T("closingReport"), "withdrawnAt", "attendeesCount", "updatedAt"],
  debate: ["id", T("title"), "startTime", "endTime", "createdAt", "updatedAt", "closedAt", T("conclusions"), "commentsCount"],
  participatory_process: ["id", T("title"), "startDate", "endDate", "updatedAt", `steps { ${T("title")} active startDate endDate }`],
};
const COMPONENT_TYPE: Record<string, string> = { proposal: "Proposals", meeting: "Meetings", debate: "Debates" };

function buildQuery(parsed: Parsed, fields: string[]): string {
  const { item_type, ids } = parsed;
  const f = fields.join(" ");
  if (item_type === "participatory_process") return `{ participatoryProcess(slug: ${JSON.stringify(ids.slug)}) { ${f} } }`;
  return `{ component(id: ${Number(ids.component)}) { ... on ${COMPONENT_TYPE[item_type]} { ${item_type}(id: ${Number(ids.id)}) { ${f} } } } }`;
}

export const decidim: Adapter = {
  id: "decidim",
  parse(url): Parsed | null {
    const m = RE.exec(url);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (m[4]) return { item_type: m[5].replace(/s$/, ""), ids: { host, space: m[2], slug: m[3], component: m[4], id: m[6] } };
    // A whole space: only participatory processes have dates and phases.
    if (m[2].toLowerCase() !== "processes") return null;
    return { item_type: "participatory_process", ids: { host, space: m[2], slug: m[3] } };
  },
  async fetch(parsed: Parsed, ctx: Ctx): Promise<FetchResult> {
    const host = parsed.ids.host;
    if (!(await hostIsPublic(ctx, host))) throw new AdapterError("This address isn't reachable from the register");
    const url = `https://${host}/api`;
    const json = await tolerantQuery(async (fields) => {
      const r = await getJson(ctx, url, { Accept: "application/json", "User-Agent": "question-register" }, host, { query: buildQuery(parsed, fields) });
      if (r.status === 429) throw new AdapterError("Decidim rate limit reached; will retry later", 15 * 60_000);
      if (r.status !== 200 || !r.json || typeof r.json !== "object") throw new AdapterError(`No Decidim API answered at ${host} (HTTP ${r.status})`);
      return r.json;
    }, FIELDS[parsed.item_type]);
    const errors: any[] = json.errors ?? [];
    if (errors.some((e) => /UNAUTHORIZED|permission/i.test(`${e?.extensions?.code} ${e?.message}`)))
      throw new AdapterError("This Decidim item isn't public", undefined, { manualFallback: true });
    const item = parsed.item_type === "participatory_process" ? json.data?.participatoryProcess : json.data?.component?.[parsed.item_type];
    if (!item) throw new AdapterError(errors[0]?.message ? `Decidim: ${clip(String(errors[0].message), 120)}` : "Not found on this Decidim");
    const now = ctx.now();
    const fetched =
      parsed.item_type === "proposal"
        ? normalizeProposal(item)
        : parsed.item_type === "meeting"
          ? normalizeMeeting(item, now)
          : parsed.item_type === "debate"
            ? normalizeDebate(item, now)
            : normalizeProcess(item, now);
    return { fetched };
  },
};
