// Adapter interface (spec §5.2), slightly extended: fetch receives the context (for the
// injected fetcher and tokens) and an ETag for conditional requests.
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";

export type Parsed = { item_type: string; ids: Record<string, string> };

export type FetchResult =
  | { notModified: true }
  | { notModified?: false; fetched: Omit<Fetched, "fetched_at" | "fetch_error">; etag?: string };

export interface Adapter {
  id: string;
  /** Extract identifiers from an already-matched URL. No network. */
  parse(url: string, ctx: Ctx): Parsed | null;
  /** Whether the adapter can run with this configuration (e.g. needs an API token). Default: yes. */
  available?(ctx: Ctx): boolean;
  /** Fetch and normalize. Must only call the tool's own API hosts, built from parsed ids. */
  fetch(parsed: Parsed, ctx: Ctx, opts?: { etag?: string }): Promise<FetchResult>;
}

export class AdapterError extends Error {
  retryAfterMs?: number;
  /** The item exists but can't be read (private): the process should be updated by hand instead. */
  manualFallback?: boolean;
  constructor(message: string, retryAfterMs?: number, opts: { manualFallback?: boolean } = {}) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.manualFallback = opts.manualFallback;
  }
}

/** Platform timestamps → ISO. Accepts ISO strings, and epoch numbers/strings in s, ms or µs. */
export function iso(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e14) n = n / 1000; // µs
  else if (n < 1e11) n = n * 1000; // s
  return new Date(n).toISOString();
}

/** Drop undefined values (keeps stored JSON tidy). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}



const MAX_BYTES = 2_000_000;

/** GET a JSON document from a fixed API host. Never follows redirects to another host. */
export async function getJson(
  ctx: Ctx,
  url: string,
  headers: Record<string, string>,
  expectedHost: string,
  body?: unknown,
): Promise<{ status: number; json?: any; headers: Headers }> {
  const init: RequestInit = { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) };
  if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } });
  const res = await ctx.fetch(url, init);
  if (res.url && new URL(res.url).hostname !== expectedHost) throw new AdapterError("Unexpected redirect to another host");
  if (res.status === 304) return { status: 304, headers: res.headers };
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new AdapterError("Response too large");
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new AdapterError(`Unexpected response (HTTP ${res.status})`);
  }
  return { status: res.status, json, headers: res.headers };
}

/**
 * Run a GraphQL query built from a field list, dropping fields the server doesn't know and retrying.
 * Instances run different versions (and forks) of the same software, with slightly different schemas.
 */
export async function tolerantQuery(run: (fields: string[]) => Promise<any>, fields: string[]): Promise<any> {
  let current = [...fields];
  for (let i = 0; i < 4; i++) {
    const json = await run(current);
    const unknown = new Set<string>(
      (json?.errors ?? []).filter((e: any) => e?.extensions?.code === "undefinedField").map((e: any) => String(e.extensions.fieldName)),
    );
    if (!unknown.size) return json;
    const next = current.filter((f) => !unknown.has(f.split(/[\s({]/)[0]));
    if (next.length === current.length) return json;
    current = next;
  }
  return run(current);
}

export const clip = (v: unknown, n = 300) => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
