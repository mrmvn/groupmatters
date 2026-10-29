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
  /** Fetch and normalize. Must only call the tool's own API hosts, built from parsed ids. */
  fetch(parsed: Parsed, ctx: Ctx, opts?: { etag?: string }): Promise<FetchResult>;
}

export class AdapterError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}



const MAX_BYTES = 2_000_000;

/** GET a JSON document from a fixed API host. Never follows redirects to another host. */
export async function getJson(
  ctx: Ctx,
  url: string,
  headers: Record<string, string>,
  expectedHost: string,
): Promise<{ status: number; json?: any; headers: Headers }> {
  const res = await ctx.fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
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

export const clip = (s: unknown, n = 300) => (typeof s === "string" ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : undefined);
