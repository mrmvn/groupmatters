// Adapter interface (spec §5.2), slightly extended: fetch receives the context (for the
// injected fetcher and tokens) and an ETag for conditional requests.
import type { Ctx } from "../ctx.ts";
import type { Fetched } from "../types.ts";
import { FetchRefused, safeFetch } from "../net.ts";

export type Parsed = { item_type: string; ids: Record<string, string> };

export type FetchResult =
  | { notModified: true }
  | { notModified?: false; fetched: Omit<Fetched, "fetched_at" | "fetch_error">; etag?: string };

export interface Adapter {
  id: string;
  /** What is retrieved besides the link's own item type, in plain words, per item type. Shown on the Tools page. */
  retrieves: Record<string, string[]>;
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

/**
 * GET (or POST, with `body`) a JSON document from a fixed API host. Redirects are followed by hand and
 * only within `expectedHost` (checked before each hop is requested); the body is read with a size cap.
 * The host's addresses aren't checked here: fixed hosts are trusted, and adapters for hosts taken
 * from links (Decidim, Consul) check `hostIsPublic` first.
 */
export async function getJson(
  ctx: Ctx,
  url: string,
  headers: Record<string, string>,
  expectedHost: string,
  body?: unknown,
): Promise<{ status: number; json?: any; headers: Headers }> {
  let res, text;
  try {
    res = await safeFetch(ctx, url, {
      ...(body !== undefined ? { method: "POST" as const, body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } } : { headers }),
      allowedHost: expectedHost,
      requirePublic: false,
      standardPortOnly: false,
      timeoutMs: 15_000,
      maxBytes: MAX_BYTES,
    });
    if (res.status === 304) {
      res.discard();
      return { status: 304, headers: res.headers };
    }
    text = await res.text();
  } catch (e) {
    if (e instanceof FetchRefused) throw new AdapterError(e.message);
    throw e;
  }
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
