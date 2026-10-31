import type { DatabaseSync } from "node:sqlite";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  publicUrl: string;
  githubToken?: string;
  gitlabToken?: string;
  /** Metaculus requires a token for all API calls; without it Metaculus links are updated by hand. */
  metaculusToken?: string;
  /** Hosts the GitLab adapter may call. gitlab.com plus operator-configured self-hosted instances. */
  gitlabHosts: string[];
  /** Interval for criteria evaluation and refresh scheduling. */
  tickMs: number;
  writeRateLimitPerMinute: number;
  readRateLimitPerMinute: number;
};

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Everything a service needs. Injected so tests can control time and network. */
export type Ctx = {
  db: DatabaseSync;
  now: () => Date;
  fetch: Fetcher;
  config: Config;
  /** DNS lookup used to keep page fetches (title pre-fill) off private networks. Injectable for tests. */
  lookup?: (host: string) => Promise<string[]>;
};

export function loadConfig(env = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "data/register.sqlite",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    githubToken: env.GITHUB_TOKEN || undefined,
    gitlabToken: env.GITLAB_TOKEN || undefined,
    metaculusToken: env.METACULUS_TOKEN || undefined,
    gitlabHosts: ["gitlab.com", ...(env.GITLAB_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)],
    tickMs: Number(env.TICK_MS ?? 15 * 60 * 1000),
    writeRateLimitPerMinute: Number(env.WRITE_RATE_LIMIT ?? 120),
    readRateLimitPerMinute: Number(env.READ_RATE_LIMIT ?? 600),
  };
}

export const nowIso = (ctx: Ctx) => ctx.now().toISOString();
