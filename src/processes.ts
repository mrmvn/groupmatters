// Processes: attach / replace / remove, manual state updates, refresh (spec §2.3, §5.4).
import type { Ctx } from "./ctx.ts";
import type { Fetched, Process, Question, Space } from "./types.ts";
import { isTerminal } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { matchUrl, suggestPattern, type Match } from "./tools.ts";
import { AdapterError, getAdapter } from "./adapters/index.ts";
import { bad, conflict, HttpError, isHttpsUrl, trimOrUndef } from "./util.ts";
import { isNormalizedState } from "./criteria.ts";
import { canActAsSteward } from "./permissions.ts";

const OPEN_INTERVAL_MS = 15 * 60_000;
const TERMINAL_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const MIN_MANUAL_REFRESH_MS = 30_000;

export function unknownToolError(url: string) {
  const e = new HttpError(422, "unknown_tool", "This link doesn't match any tool on the tool list.");
  (e as any).details = { suggestion: suggestPattern(url) };
  return e;
}

export function matchOrThrow(ctx: Ctx, space: Space, url: string): Match {
  if (!isHttpsUrl(url)) throw bad("Process links must be https:// URLs");
  const m = matchUrl(ctx, repo.listTools(ctx.db, space.id), url);
  if (!m) throw unknownToolError(url);
  return m;
}

// Short-lived cache so "paste a link" preview + create doesn't fetch twice.
type CacheEntry = { at: number; fetched: Fetched; etag?: string };
const previewCaches = new WeakMap<Ctx, Map<string, CacheEntry>>();
const CACHE_MS = 60_000;

async function fetchFor(ctx: Ctx, m: Match, etag?: string): Promise<{ fetched: Fetched; etag?: string } | { notModified: true }> {
  const now = ctx.now().toISOString();
  const adapter = m.tool.adapter ? getAdapter(m.tool.adapter) : undefined;
  if (!adapter || !m.parsed) return { fetched: { state: "unknown", terminal: false, fetched_at: now, fetch_error: "No adapter" } };
  try {
    const r = await adapter.fetch(m.parsed, ctx, { etag });
    if (r.notModified) return { notModified: true };
    return { fetched: { ...r.fetched, fetched_at: now }, etag: r.etag };
  } catch (e) {
    const msg = e instanceof AdapterError ? e.message : `Could not reach ${m.tool.name}`;
    throw Object.assign(new AdapterError(msg, e instanceof AdapterError ? e.retryAfterMs : undefined), { cause: e });
  }
}

export type UrlPreview =
  | { matched: false; suggestion?: { name: string; pattern: string } }
  | { matched: true; tool_id: string; tool_name: string; item_type: string; fetch_mode: "auto" | "manual"; fetched?: Fetched; fetch_error?: string };

/** Resolve a pasted URL: which tool, which item type, and (for auto tools) the fetched state. */
export async function previewUrl(ctx: Ctx, space: Space, url: string): Promise<UrlPreview> {
  const m = matchUrl(ctx, repo.listTools(ctx.db, space.id), url.trim());
  if (!m) return { matched: false as const, suggestion: suggestPattern(url.trim()) };
  const base = { matched: true as const, tool_id: m.tool.id, tool_name: m.tool.name, item_type: m.item_type, fetch_mode: m.tool.fetch_mode };
  if (m.tool.fetch_mode !== "auto") return base;
  try {
    const f = await cachedFetch(ctx, m, url.trim());
    return { ...base, fetched: f.fetched };
  } catch (e) {
    return { ...base, fetch_error: (e as Error).message };
  }
}

async function cachedFetch(ctx: Ctx, m: Match, url: string) {
  let previewCache = previewCaches.get(ctx);
  if (!previewCache) previewCaches.set(ctx, (previewCache = new Map()));
  const hit = previewCache.get(url);
  if (hit && ctx.now().getTime() - hit.at < CACHE_MS && hit.at <= ctx.now().getTime()) return hit;
  const r = await fetchFor(ctx, m);
  if ("notModified" in r) throw new Error("unexpected 304");
  const entry = { at: ctx.now().getTime(), ...r };
  previewCache.set(url, entry);
  if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value!);
  return entry;
}

/** Fetch what's needed to attach a process (outside any transaction). */
export async function prepareProcess(ctx: Ctx, space: Space, url: string, framing?: string) {
  url = url.trim();
  const m = matchOrThrow(ctx, space, url);
  const p: Process = { url, tool_id: m.tool.id, item_type: m.item_type, fetch_mode: m.tool.fetch_mode };
  if (framing) p.framing = framing;
  let etag: string | undefined;
  let failed = false;
  if (m.tool.fetch_mode === "auto") {
    try {
      const f = await cachedFetch(ctx, m, url);
      p.fetched = f.fetched;
      etag = f.etag;
    } catch (e) {
      failed = true;
      p.fetched = { state: "unknown", terminal: false, fetched_at: ctx.now().toISOString(), fetch_error: (e as Error).message };
    }
  }
  return { process: p, etag, failed };
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
export function storeProcess(ctx: Ctx, q: Question, actor: string, prepared: Awaited<ReturnType<typeof prepareProcess>>) {
  if (q.status === "resolved" || q.status === "dropped") throw conflict("Reopen or restore the question before changing its process");
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
  // Replacing the process resets the reopen baseline (it referred to the old process).
  if (q.reopen_baseline_state) {
    delete q.reopen_baseline_state;
    repo.saveQuestion(ctx.db, q);
  }
  q.process = p;
  repo.logEvent(ctx, {
    space_id: q.space_id,
    question_id: q.id,
    actor,
    action: before ? "process.replaced" : "process.attached",
    data: before ? { before: { url: before.url, tool_id: before.tool_id }, after: summarize(p) } : summarize(p),
  });
}

const summarize = (p: Process) => ({
  url: p.url,
  tool_id: p.tool_id,
  item_type: p.item_type,
  state: p.fetched?.state,
  title: p.fetched?.title,
  framing: p.framing,
});

export function removeProcess(ctx: Ctx, space: Space, q: Question, actor: string) {
  return tx(ctx.db, () => {
    if (!q.process) throw bad("This question has no process");
    if (q.status === "resolved" || q.status === "dropped") throw conflict("Reopen or restore the question before changing its process");
    const had = q.resolution.criteria.some((c) => c.kind === "process_outcome");
    if (had) {
      const remaining = q.resolution.criteria.filter((c) => c.kind !== "process_outcome");
      if (remaining.length === 0 && q.status === "active")
        throw conflict(
          "This is the question's only criterion. Add another criterion (a date, the default rule or an attestation) before removing the process.",
        );
      const before = q.resolution;
      q.resolution = { mode: remaining.length ? "criteria" : "tbd", criteria: remaining };
      if (q.pending_resolution?.triggered_by === "process_outcome") delete q.pending_resolution;
      repo.saveQuestion(ctx.db, q);
      repo.logEvent(ctx, {
        space_id: space.id,
        question_id: q.id,
        actor,
        action: "criteria.changed",
        data: { before, after: q.resolution, reason: "process removed" },
      });
    }
    repo.deleteProcess(ctx.db, q.id);
    repo.logEvent(ctx, { space_id: space.id, question_id: q.id, actor, action: "process.removed", data: summarize(q.process) });
    delete q.process;
    return q;
  });
}

export function setFraming(ctx: Ctx, q: Question, actor: string, framingIn: unknown) {
  if (!q.process) throw bad("This question has no process");
  const framing = trimOrUndef(framingIn, 2000);
  const before = q.process.framing;
  if (before === framing) return q;
  const row = repo.getProcessRow(ctx.db, q.id)!;
  tx(ctx.db, () => {
    repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), framing }, {}, ctx.now().toISOString());
    repo.logEvent(ctx, { space_id: q.space_id, question_id: q.id, actor, action: "process.framing_changed", data: { before, after: framing } });
  });
  q.process = { ...q.process, framing };
  if (!framing) delete q.process.framing;
  return q;
}

/** Manual tools: the steward sets the state by hand (spec §2.3). */
export function manualUpdate(ctx: Ctx, q: Question, actor: string, body: any) {
  if (!q.process) throw bad("This question has no process");
  if (q.process.fetch_mode !== "manual") throw bad("This process is updated automatically; use Refresh");
  if (q.status === "resolved" || q.status === "dropped") throw conflict("This question is closed");
  if (!canActAsSteward(q, actor)) throw new HttpError(403, "forbidden", `Only the steward (${q.steward}) can update the process state`);
  const state = body?.state;
  if (!isNormalizedState(state)) throw bad("Choose a state");
  const results_url = trimOrUndef(body?.results_url, 2000);
  if (results_url && !isHttpsUrl(results_url)) throw bad("The results link must be an https:// URL");
  const before = q.process.fetched;
  const fetched: Fetched = {
    ...(before?.title ? { title: before.title } : {}),
    raw_state: trimOrUndef(body?.raw_state, 80),
    state,
    terminal: isTerminal(state),
    outcome_summary: trimOrUndef(body?.outcome_summary, 300),
    fetched_at: ctx.now().toISOString(),
  };
  const extra = { ...(before?.extra ?? {}) };
  if (results_url) extra.results_url = results_url;
  else delete extra.results_url;
  if (Object.keys(extra).length) fetched.extra = extra;
  for (const k of Object.keys(fetched) as (keyof Fetched)[]) if (fetched[k] === undefined) delete fetched[k];
  const row = repo.getProcessRow(ctx.db, q.id)!;
  tx(ctx.db, () => {
    repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), fetched }, {}, fetched.fetched_at);
    repo.logEvent(ctx, {
      space_id: q.space_id,
      question_id: q.id,
      actor,
      action: "process.state_changed",
      data: { manual: true, before: before && pickState(before), after: pickState(fetched) },
    });
  });
  q.process = { ...q.process, fetched };
  return q;
}

const pickState = (f: Fetched) => ({ state: f.state, raw_state: f.raw_state, outcome_summary: f.outcome_summary, title: f.title });

export type RefreshOutcome = { changed: boolean; error?: string; skipped?: string };

/** Refresh one auto process. Keeps previous values on error. Logs state changes as `system`. */
export async function refreshProcess(ctx: Ctx, questionId: string, opts: { onDemand?: boolean } = {}): Promise<RefreshOutcome> {
  const row = repo.getProcessRow(ctx.db, questionId);
  if (!row) return { changed: false, skipped: "no process" };
  if (row.fetch_mode !== "auto") return { changed: false, skipped: "manual" };
  const tool = repo.getTool(ctx.db, row.space_id, row.tool_id);
  if (!tool?.enabled) {
    // Disabled tools keep their last state and stop refreshing.
    repo.upsertProcess(ctx.db, { id: questionId, space_id: row.space_id }, repo.publicProcess(row), {
      next_refresh_at: new Date(ctx.now().getTime() + TERMINAL_INTERVAL_MS).toISOString(),
    }, ctx.now().toISOString());
    return { changed: false, skipped: "tool disabled" };
  }
  if (opts.onDemand && row.fetched && ctx.now().getTime() - new Date(row.fetched.fetched_at).getTime() < MIN_MANUAL_REFRESH_MS && !row.fetched.fetch_error)
    return { changed: false, skipped: "refreshed moments ago" };
  const m = matchUrl(ctx, [tool], row.url);
  const prev = row.fetched;
  const q = { id: questionId, space_id: row.space_id };
  const nowIso = ctx.now().toISOString();
  try {
    if (!m) throw new AdapterError("The link no longer matches this tool's patterns");
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
    });
    return { changed };
  } catch (e) {
    const msg = (e as Error).message || "Refresh failed";
    const fails = row.fail_count + 1;
    const fetched: Fetched = prev ? { ...prev, fetch_error: msg } : { state: "unknown", terminal: false, fetched_at: nowIso, fetch_error: msg };
    repo.upsertProcess(ctx.db, q, { ...repo.publicProcess(row), fetched }, {
      fail_count: fails,
      next_refresh_at: nextRefresh(ctx, fetched, fails, (e as AdapterError).retryAfterMs),
    }, nowIso);
    return { changed: false, error: msg };
  }
}

