# Tool icons

Small icons for the built-in tools, shown next to the tool's name so it's recognisable at a glance.
They're served from this server: readers' browsers never contact the tools' sites. Tools added by a
group get their site's favicon, fetched once by the server and stored with the tool (`src/toolicons.ts`).

Each logo belongs to its owner and is used only to name its tool (nominative use), without
modification apart from format conversion. No endorsement is implied.

| File | Tool | Source |
|---|---|---|
| `github.svg` | GitHub | [Simple Icons](https://simpleicons.org) 16.36 (CC0 1.0 for the file) |
| `gitlab.svg` | GitLab | [Simple Icons](https://simpleicons.org) 16.36 (CC0 1.0 for the file), filled with GitLab's brand orange `#FC6D26` |
| `loomio.svg` | Loomio | www.loomio.com favicon (`/images/brand/favicon-yellow-on-transparent.svg`) |
| `polis.png` | Polis | pol.is favicon (`/favicon.ico`, 64 px image converted to PNG) |
| `metaculus.png` | Metaculus | www.metaculus.com favicon (`/favicon.ico`, 128 px image extracted) |
| `opavote.png` | OpaVote | opavote.com favicon (`/static/img/favicon-96x96.png`) |
| `decidim.png` | Decidim | decidim.org favicon (`/images/favicon.png`) |
| `kialo.webp` | Kialo | www.kialo.com icon (`kialo_logo_square_60x60.webp`) |
| `consul.png` | Consul Democracy | consuldemocracy.org site icon (32 px); used for instances whose own favicon can't be fetched |

Retrieved 2026-10-31. To add one: put a small square file here (SVG, or PNG/WebP at 32–128 px) and
add it to `BUNDLED` in `src/toolicons.ts`, keyed by the seed tool's id.
