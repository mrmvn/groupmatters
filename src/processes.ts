// Processes: attach / replace / remove and refresh. A question has at most one process: a link
// matching a tool on the tool list (its fields are retrieved), or a custom process: a link to a site
// that isn't on the list, or no link at all (a meeting…), whose fields are typed. See fields.ts.
import type { Ctx } from "./ctx.ts";
import type { Fetched, NormalizedState, Process, Question, Space, Tool } from "./types.ts";
import { CUSTOM_TOOL_ID, NORMALIZED_STATES } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { matchUrl, suggestPattern, type Match } from "./tools.ts";
import { AdapterError, getAdapter } from "./adapters/index.ts";
import { fetchPageTitle } from "./pagetitle.ts";
import { freezeUnretrievable, sync } from "./fields.ts";
import { bad, HttpError, isHttpsUrl, trimOrUndef } from "./util.ts";

const OPEN_INTERVAL_MS = 15 * 60_000;
const TERMINAL_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const MIN_MANUAL_REFRESH_MS = 30_000;

export const isNormalizedState = (s: unknown): s is NormalizedState => NORMALIZED_STATES.includes(s as NormalizedState);

/** A URL without the parts that don't change what it points to (www., #fragment, trailing slash, utm_*). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url;
  }
}

/** Identity keys of a linked item: its canonical URL, plus the platform's ids when an adapter parses it. */
function itemKeys(ctx: Ctx, tools: Tool[], url: string): string[] {
  const keys = [canonicalUrl(url)];
  const m = matchUrl(ctx, tools, url);
  if (m?.parsed) keys.push(`${m.tool.id}:${Object.entries(m.parsed.ids).sort().map(([k, v]) => `${k}=${String(v).toLowerCase()}`).join("&")}`);
  return keys;
}

/**
 * The question already tracking this item through a tool on the list, if any (removed questions don't
 * count). Links to pages not on the list (meeting notes…) can serve several questions, so they're not compared.
 */
export function findQuestionWithLink(ctx: Ctx, space: Space, url: string, excludeId?: string): Question | undefined {
  const tools = repo.listTools(ctx.db, space.id);
  const wanted = new Set(itemKeys(ctx, tools, url));
  return repo
    .listQuestions(ctx.db, space.id)
    .find((q) => q.id !== excludeId && q.process?.url && q.process.tool_id !== CUSTOM_TOOL_ID && itemKeys(ctx, tools, q.process.url).some((k) => wanted.has(k)));
}

export function duplicateLinkError(existing: Question) {
  const e = new HttpError(409, "duplicate_link", `This link is already tracked by “${existing.title}”.`);
  (e as any).details = { existing: { id: existing.id, title: existing.title } };
  return e;
}

// Short-lived cache so "paste a link" preview + create doesn't fetch twice.
type CacheEntry = { at: number; fetched?: Fetched; etag?: string; error?: AdapterError; title?: string };
const previewCaches = new WeakMap<Ctx, Map<string, CacheEntry>>();
const CACHE_MS = 60_000;

async function fetchFor(ctx: Ctx, m: Match, etag?: string): Promise<{ fetched: Fetched; etag?: string } | { notModified: true }> {
  const now = ctx.now().toISOString();
  const adapter = m.tool.adapter ? getAdapter(m.tool.adapter) : undefined;
  if (!adapter || !m.parsed) throw new AdapterError("No adapter for this tool");
  try {
    const r = await adapter.fetch(m.parsed, ctx, { etag });
    if (r.notModified) return { notModified: true };
    return { fetched: { ...r.fetched, fetched_at: now }, etag: r.etag };
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw Object.assign(new AdapterError(`Could not reach ${m.tool.name}`), { cause: e });
  }
}

/** Auto tools: fetch the item. Manual tools: try to read the page title. Cached for a minute. */
async function lookupUrl(ctx: Ctx, m: Match, url: string): Promise<CacheEntry> {
  let cache = previewCaches.get(ctx);
  if (!cache) previewCaches.set(ctx, (cache = new Map()));
  const key = `${m.fetch_mode}:${url}`;
  const hit = cache.get(key);
  const nowMs = ctx.now().getTime();
  if (hit && nowMs - hit.at < CACHE_MS && hit.at <= nowMs) return hit;
  let entry: CacheEntry;
  if (m.fetch_mode === "auto") {
    try {
      const r = await fetchFor(ctx, m);
      if ("notModified" in r) throw new AdapterError("unexpected 304");
      entry = { at: nowMs, fetched: r.fetched, etag: r.etag };
    } catch (e) {
      entry = { at: nowMs, error: e instanceof AdapterError ? e : new AdapterError((e as Error).message) };
    }
  } else {
    entry = { at: nowMs, title: await fetchPageTitle(ctx, url, m.tool.name) };
  }
  cache.set(key, entry);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return entry;
}

export type UrlPreview =
  | { matched: false; suggestion?: { name: string; pattern: string }; existing?: { id: string; title: string } }
  | {
      matched: true;
      tool_id: string;
      tool_name: string;
      item_type: string;
      fetch_mode: "auto" | "manual";
      title?: string;
      fetched?: Fetched;
      fetch_error?: string;
      /** A question already tracking this link. */
      existing?: { id: string; title: string };
    };

/** Resolve a pasted URL: which tool, which item type, its title and (auto tools) its state. */
export async function previewUrl(ctx: Ctx, space: Space, url: string): Promise<UrlPreview> {
  url = url.trim();
  const m = matchUrl(ctx, repo.listTools(ctx.db, space.id), url);
  const existing = findQuestionWithLink(ctx, space, url);
  if (!m) return { matched: false as const, suggestion: suggestPattern(url), ...(existing ? { existing: { id: existing.id, title: existing.title } } : {}) };
  if (existing) {
    // No need to fetch: the link is already tracked.
    return { matched: true as const, tool_id: m.tool.id, tool_name: m.tool.name, item_type: m.item_type, fetch_mode: m.fetch_mode, existing: { id: existing.id, title: existing.title } };
  }
  const r = await lookupUrl(ctx, m, url);
  const fallback = r.error?.manualFallback;
  return {
    matched: true as const,
    tool_id: m.tool.id,
    tool_name: m.tool.name,
    item_type: m.item_type,
    fetch_mode: fallback ? "manual" : m.fetch_mode,
    title: r.fetched?.title ?? r.title,
    ...(r.fetched ? { fetched: r.fetched } : {}),
    ...(r.error ? { fetch_error: r.error.message } : {}),
  };
}

/** `kind`: a kind typed along with a custom process ("General assembly"). */
export type Prepared = { process: Process; etag?: string; failed: boolean; kind?: string };

/**
 * Validate and fetch what's needed to attach a process (outside any transaction).
 * Body: `{url?, kind?}` (also accepted as `{custom: {url?, kind?}}`). A link matching a tool on the
 * list is retrieved through it; any other https link, or none, makes a custom process (a kind is
 * then needed when there's no link).
 */
export async function prepareProcess(ctx: Ctx, space: Space, body: any): Promise<Prepared> {
  const c = body?.custom ?? body ?? {};
  const url = trimOrUndef(c.url ?? body?.url, 2000);
  const kind = trimOrUndef(c.kind ?? body?.kind, 60);
  if (url && !isHttpsUrl(url)) throw bad("Links must be https:// URLs");
  const m = url ? matchUrl(ctx, repo.listTools(ctx.db, space.id), url) : undefined;
  if (!m) {
    if (!url && !kind) throw bad("Give a link, or the kind of process (a meeting, a survey…)");
    const p: Process = { tool_id: CUSTOM_TOOL_ID, item_type: "", fetch_mode: "manual" };
    if (url) p.url = url;
    return { process: p, failed: false, ...(kind ? { kind } : {}) };
  }
  const p: Process = { url, tool_id: m.tool.id, item_type: m.item_type, fetch_mode: m.fetch_mode };
  const now = ctx.now().toISOString();
  const r = await lookupUrl(ctx, m, url!);
  const extra = kind ? { kind } : {};
  if (r.fetched) return { process: { ...p, fetched: r.fetched }, etag: r.etag, failed: false, ...extra };
  if (r.error?.manualFallback) {
    // Exists but can't be read (private, or no API token): only the type and title are retrieved.
    return { process: { ...p, fetch_mode: "manual", fetched: { state: "unknown", terminal: false, fetched_at: now, fetch_error: r.error.message } }, failed: false, ...extra };
  }
  if (r.error) return { process: { ...p, fetched: { state: "unknown", terminal: false, fetched_at: now, fetch_error: r.error.message } }, failed: true, ...extra };
  // A tool updated by hand: the page title, when it has one.
  return { process: { ...p, fetched: { ...(r.title ? { title: r.title } : {}), state: "unknown", terminal: false, fetched_at: now } }, failed: false, ...extra };
}

function nextRefresh(ctx: Ctx, f: Fetched | undefined, failCount: number, retryAfterMs?: number) {
  const now = ctx.now().getTime();
  if (failCount > 0) {
    const backoff = Math.min(OPEN_INTERVAL_MS * 2 ** (failCount - 1), MAX_BACKOFF_MS);
    return new Date(now + Math.max(backoff, retryAfterMs ?? 0)).toISOString();
  }
  return new Date(now + (f?.terminal ? TERMINAL_INTERVAL_MS : OPEN_INTERVAL_MS)).toISOString();
}

/** Store a prepared process on a question (inside a transaction). Logs attach/replace. */
export function storeProcess(ctx: Ctx, q: Question, actor: string, prepared: Prepared) {
  const before = q.process;
  const p = prepared.process;
  repo.upsertProcess(
    ctx.db,
    q,
    p,
    {
      etag: prepared.etag ?? null,
      fail_count: prepared.failed ? 1 : 0,
      next_refresh_at: p.fetch_mode === "auto" ? nextRefresh(ctx, p.fetched, prepared.failed ? 1 : 0) : null,
    },
    ctx.now().toISOString(),
  );
  q.process = p;
  repo.logEvent(ctx, {
    space_id: q.space_id,
    question_id: q.id,
    actor,
    action: before ? "process.replaced" : "process.attached",
    data: before ? { before: summarize(before), after: summarize(p) } : summarize(p),
  });
}

const summarize = (p: Process) => ({
  url: p.url,
  tool_id: p.tool_id,
  item_type: p.item_type,
  state: p.fetched?.state,
  title: p.fetched?.title,
});

/**
 * Remove the process. The title and status it gave are kept, now typed; the typed kind goes with it
 * (it was the kind of process). Dates, summary and results typed on the question stay.
 */
export function removeProcess(ctx: Ctx, space: Space, q: Question, actor: string) {
  return tx(ctx.db, () => {
    if (!q.process) throw bad("This matter has no process");
    repo.deleteProcess(ctx.db, q.id);
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor, action: "process.removed", data: summarize(q.process) });
    delete q.process;
    delete q.typed.kind;
    freezeUnretrievable(space, q, actor, ctx.now().toISOString());
    repo.saveQuestion(ctx.db, q);
    sync(ctx, q, actor);
    return q;
  });
}

const pickState = (f: Fetched) => ({ state: f.state, raw_state: f.raw_state, outcome_summary: f.outcome_summary, title: f.title });

/** After a refresh: reload the question and bring its title and status in step (logged as system). */
function syncAfterRefresh(ctx: Ctx, questionId: string, frozen = false) {
  const q = repo.getQuestionById(ctx.db, questionId);
  if (!q) return;
  if (frozen) {
    freezeUnretrievable(repo.getSpace(ctx.db, q.space_id), q, "system", ctx.now().toISOString());
    repo.saveQuestion(ctx.db, q);
  }
  sync(ctx, q);
}

export type RefreshOutcome = { changed: boolean; error?: string; skipped?: string };

/** Refresh one auto process. Keeps previous values on error. Logs state changes as `system`. */
export async function refreshProcess(ctx: Ctx, questionId: string, opts: { onDemand?: boolean } = {}): Promise<RefreshOutcome> {
  const row = repo.getProcessRow(ctx.db, questionId);
  if (!row) return { changed: false, skipped: "no process" };
  if (row.fetch_mode !== "auto" || !row.url) return { changed: false, skipped: "manual" };
  const tool = repo.getTool(ctx.db, row.space_id, row.tool_id);
  const q = { id: questionId, space_id: row.space_id };
  if (!tool?.enabled) {
    // Disabled tools keep their last state and stop refreshing.
    repo.upsertProcess(ctx.db, q, repo.publicProcess(row), { next_refresh_at: new Date(ctx.now().getTime() + TERMINAL_INTERVAL_MS).toISOString() }, ctx.now().toISOString());
    return { changed: false, skipped: "tool disabled" };
  }
  if (opts.onDemand && row.fetched && ctx.now().getTime() - new Date(row.fetched.fetched_at).getTime() < MIN_MANUAL_REFRESH_MS && !row.fetched.fetch_error)
    return { changed: false, skipped: "refreshed moments ago" };
  const m = matchUrl(ctx, [tool], row.url);
  const prev = row.fetched;
  const nowIso = ctx.now().toISOString();
  try {
    if (!m) throw new AdapterError("The link no longer matches this tool's patterns");
    if (m.fetch_mode !== "auto") throw new AdapterError(`${tool.name} can't be fetched with this server's configuration`, undefined, { manualFallback: true });
    const r = await fetchFor(ctx, m, prev && !prev.fetch_error ? row.etag : undefined);
    const fetched: Fetched = "notModified" in r ? { ...prev!, fetched_at: nowIso } : r.fetched;
    delete fetched.fetch_error;
    const changed = !prev || prev.state !== fetched.state || prev.terminal !== fetched.terminal || prev.raw_state !== fetched.raw_state;
    tx(ctx.db, () => {
      repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), fetched }, {
        etag: "notModified" in r ? undefined : (r.etag ?? null),
        fail_count: 0,
        next_refresh_at: nextRefresh(ctx, fetched, 0),
      }, nowIso);
      if (changed)
        repo.logEvent(ctx, {
          space_id: row.space_id,
          question_id: questionId,
          actor: "system",
          action: "process.state_changed",
          data: { before: prev && pickState(prev), after: pickState(fetched) },
        });
      syncAfterRefresh(ctx, questionId);
    });
    return { changed };
  } catch (e) {
    const msg = (e as Error).message || "Refresh failed";
    const fails = row.fail_count + 1;
    const fetched: Fetched = prev ? { ...prev, fetch_error: msg } : { state: "unknown", terminal: false, fetched_at: nowIso, fetch_error: msg };
    if ((e as AdapterError).manualFallback) {
      // It became unreadable (made private, token removed): switch to updating by hand.
      tx(ctx.db, () => {
        repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), fetch_mode: "manual", fetched }, { next_refresh_at: null, fail_count: 0 }, nowIso);
        repo.logEvent(ctx, { space_id: row.space_id, question_id: questionId, actor: "system", action: "process.now_manual", data: { reason: msg } });
        // Its status can't be retrieved any more: keep the current one, now typed.
        syncAfterRefresh(ctx, questionId, true);
      });
      return { changed: false, error: msg };
    }
    repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), fetched }, {
      fail_count: fails,
      next_refresh_at: nextRefresh(ctx, fetched, fails, (e as AdapterError).retryAfterMs),
    }, nowIso);
    return { changed: false, error: msg };
  }
}
