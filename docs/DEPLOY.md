# Deployment and backups

The register is a single Node process with a single SQLite file. It needs no other services.

## Requirements

- Node.js ≥ 24 (developed on 26). There's no build step and no runtime dependencies.
- A persistent directory for the database.
- HTTPS in front of it (a reverse proxy such as Caddy or nginx). Space links are secrets in the URL, so plain HTTP isn't acceptable outside localhost.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (use `0.0.0.0` in a container) |
| `DB_PATH` | `data/register.sqlite` | SQLite file |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL used when printing links and in the Atom and calendar feeds |
| `SOURCE_URL` | the upstream repository | "Source" link in the footer. If you run a modified version, point it at your own source (AGPL-3.0 §13) |
| `CONTACT_EMAIL` | — | "Contact" link (mailto) in the footer; hidden when unset. The privacy page tells people to use it |
| `HOSTING` | — | Optional sentence for the privacy page's "Hosting" section, e.g. where and with whom the server runs |
| `GITHUB_TOKEN` | — | Optional. Raises GitHub's limit from 60 to 5,000 requests/h. A fine-grained token with **no** permissions is enough for public repos |
| `GITLAB_TOKEN` | — | Optional, gitlab.com only |
| `GITLAB_HOSTS` | — | Comma-separated self-hosted GitLab hosts the server may call, e.g. `git.example.org` |
| `METACULUS_TOKEN` | — | Optional. Metaculus requires an API token for every request; with one, Metaculus links are fetched automatically. Without it they're updated by hand |
| `TICK_MS` | `900000` | Scheduler interval (refreshing linked items), 15 min |
| `WRITE_RATE_LIMIT` | `120` | Writes per minute per link |
| `READ_RATE_LIMIT` | `600` | Reads (API `GET`s) per minute per link |
| `LOG_REQUESTS` | — | Set to log requests (tokens are redacted) |
| `NODE_USE_ENV_PROXY` | — | Set to `1` if outbound traffic must go through `HTTPS_PROXY` |

Variables can live in an env file (see `.env.example`, git-ignored as `.env`): `npm start` and `npm run dev` read `.env` when it exists (or `node --env-file=.env src/main.ts`); with Docker the file isn't copied into the image, so use `docker run --env-file .env …`.

## Run locally

```sh
npm install            # dev tools only (typescript, linkedom); not needed to run
npm test
node src/cli.ts create-demo     # or: node src/cli.ts create-space "Our group"
npm start                       # http://localhost:3000, then open the printed edit link
```

## Small VPS with Docker

```sh
docker build -t question-register .
docker volume create register-data
docker run -d --name register --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v register-data:/data \
  -e PUBLIC_URL=https://groupmatters.org \
  question-register

docker exec register node src/cli.ts create-space "Our group"
```

Caddy in front (automatic HTTPS):

```
groupmatters.org {
  reverse_proxy 127.0.0.1:3000
}
www.groupmatters.org {
  redir https://groupmatters.org{uri} permanent
}
```

The app sends `Strict-Transport-Security` itself when `PUBLIC_URL` starts with `https://`, so the proxy doesn't need to add it.

### Keep the links out of the proxy's logs

Space links are secrets in the URL path (`/s/<token>`, `/api/s/<token>/…`, `/feed/<token>.atom`). Any access log that records the request URI stores them. The app's own log (`LOG_REQUESTS`) redacts them; your reverse proxy doesn't.

**Caddy** writes no access log unless a site has a `log` directive. The simplest choice is to leave it out. If you do want access logs, filter the URI:

```
groupmatters.org {
  reverse_proxy 127.0.0.1:3000
  log {
    output file /var/log/caddy/groupmatters.log
    format filter {
      request>uri regexp "^/(s|feed|api/s)/[A-Za-z0-9_-]+" "/${1}/[token]"
      request>headers>Referer delete
    }
  }
}
```

(Caddy before 2.8 needs the filters inside `fields { … }` and a `wrap json` line.)

**nginx** logs every request by default. Either turn it off for the site (`access_log off;`) or log a redacted URI:

```nginx
# in the http { } block
map $request_uri $redacted_uri {
  "~^/(?<p>s|feed|api/s)/[A-Za-z0-9_-]+(?<rest>.*)$"  "/$p/[token]$rest";
  default                                              $request_uri;
}
log_format redacted '$remote_addr - [$time_local] "$request_method $redacted_uri" $status $body_bytes_sent';

# in the server { } block
access_log /var/log/nginx/groupmatters.log redacted;
```

nginx's `error_log` can include the request line too; keep it at `error` level or above and rotate it.

Elsewhere, links can still leak through browser history and sync, bookmarks, and screenshots. Treat a link that got out as compromised and rotate it (`rotate-link`).

Run **one instance only**: the scheduler runs in-process.

## Without Docker (systemd)

```ini
[Service]
WorkingDirectory=/opt/question-register
ExecStart=/usr/bin/node src/main.ts
Environment=HOST=127.0.0.1 PORT=3000 DB_PATH=/var/lib/question-register/register.sqlite PUBLIC_URL=https://groupmatters.org
User=register
Restart=on-failure
```

## Operator commands

```sh
node src/cli.ts create-space "<name>"          # prints edit + view links once
node src/cli.ts list-spaces
node src/cli.ts set-charter <space-id> charter.md   # set a space's "About this group" text (markdown; logged). Members can also edit it in the app
node src/cli.ts rotate-link <space-id> edit    # or view; old link stops working
node src/cli.ts export <space-id> > export.json
```

In Docker, prefix these with `docker exec register`.

## Backups

The database uses WAL mode, so don't just copy the file while the server is running. Use SQLite's online backup:

```sh
sqlite3 /var/lib/question-register/register.sqlite ".backup '/backups/register-$(date +%F).sqlite'"
# Docker:
docker run --rm -v register-data:/data -v "$PWD":/backup alpine \
  sh -c "apk add -q sqlite && sqlite3 /data/register.sqlite \".backup '/backup/register-$(date +%F).sqlite'\""
```

Run it daily from cron and keep a few generations. To restore, stop the server, put the backup file in place as `register.sqlite` (and delete any `-wal`/`-shm` files), then start the server again.

For a portable, human-readable copy, also keep the JSON export of each space.

## Security notes

- Every response carries `Referrer-Policy: no-referrer`, a strict CSP, `Cross-Origin-Resource-Policy: same-origin` and, when `PUBLIC_URL` is https, `Strict-Transport-Security`. External links use `rel="noopener noreferrer"`.
- The Atom feed and the ICS calendar only work with the **view** link (feed readers are often cloud services, and entry links contain the token).
- Writes with a cross-origin `Origin` header (including `Origin: null`) are refused. Writes and reads are rate-limited per link.
- Only tokens' SHA-256 hashes are stored. A lost link can't be recovered, only rotated.
- All outbound requests go through one function (`src/net.ts`): https only, redirects followed by hand and checked **before** each hop is requested, response size capped while reading (2 MB for APIs).
- Adapters call `api.github.com`, `gitlab.com`, hosts listed in `GITLAB_HOSTS`, `www.loomio.com`, `pol.is`, `opavote.com` and `www.metaculus.com`, plus **Decidim and Consul instances**: any host whose links match (Decidim) or that a space added (Consul), but only after checking that the host resolves to public addresses. The server needs working DNS for that (behind a proxy without local DNS, Decidim/Consul links and title pre-fill fail safely).
- **Title pre-fill** for manual tools fetches the linked page once when a link is pasted or attached: https only, port 443, public addresses only (DNS checked at every redirect hop), 512 KB, 8 s timeout. Not yet covered: DNS rebinding (a host that resolves to a public address for the check and a private one for the connection). Only links matching a tool's patterns are fetched.
- Behind an outgoing HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so `fetch` uses `HTTPS_PROXY`.
- **Upgrades**: before a schema migration, the server writes a snapshot next to the database (`register.sqlite.before-vN.bak`).
- There are no analytics, trackers or third-party assets.
