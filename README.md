# The Wall — AI-investigated posts (Express + Postgres)

A dynamic website: **Express** app on **Render** (free web service) +
**PostgreSQL** on **Neon** (free plan) + **DeepSeek** for AI. No credit card for
the hosting/DB.

**What it does:** a public **wall** where anyone can read posts, and anyone with
the shared password can post a link or a note. Each new post is sent to AI, which
turns it into a card — a title, summary, fun facts and quirky quotes. The original
demo dashboard now lives at `/dashboard`.

## What's here

| File | Purpose |
|---|---|
| `server.js` | Express app + JSON API. Loads `.env` locally, listens on `process.env.PORT`. |
| `db.js` | Lazy `pg` pool, schema bootstrap (`notes` + `posts`), timed-query helper. |
| `auth.js` | Shared-password check, signed HttpOnly session cookie, `requireAuth`. |
| `ai.js` | DeepSeek client (OpenAI-compatible) — builds the card JSON. |
| `fetchPage.js` | SSRF-safe page fetcher + regex HTML extraction (no deps). |
| `enrich.js` | Async enrichment worker: fetch → AI → DB update. |
| `public/index.html` | The wall (home page). |
| `public/dashboard.html` | The original DB dashboard at `/dashboard`. |
| `render.yaml` | Render Blueprint describing the web service. |
| `.github/workflows/keep-warm.yml` | Cron that pings `/healthz` so the free Render service stays warm. |
| `.env.example` | Local env template. |

### Pages & API

| Route | What it does |
|---|---|
| `GET /` | The wall: post feed + gated composer. |
| `GET /dashboard` | The DB dashboard (stats, latency meter, notes demo). |
| `GET /healthz` | Liveness probe (no DB). Used by Render + the keep-warm cron. |
| `POST /api/login` · `POST /api/logout` · `GET /api/session` | Shared-password auth. |
| `GET /api/posts` | Public feed of posts (with their AI cards). |
| `POST /api/posts` | **Auth.** Create a post `{ author, body }`; returns `pending`, enriches in the background. |
| `POST /api/posts/:id/regenerate` | **Auth.** Re-run AI enrichment for a post. |
| `DELETE /api/posts/:id` | **Auth.** Delete a post. |
| `GET /api/stats` · `GET /api/ping` · `GET /api/db-health` | Dashboard stats/probes. |
| `GET/POST/DELETE /api/notes` · `POST /api/seed` · `POST /api/reset` | The dashboard's demo data. |

### How a post becomes a card

1. `POST /api/posts` inserts a row with `status = 'pending'` and returns immediately.
2. In the background, `enrich.js` fetches the URL (if any) via `fetchPage.js`
   (SSRF-guarded), then asks DeepSeek for a JSON card.
3. The row is updated to `status = 'ready'` with the `card` (or `status = 'error'`).
4. The wall polls `GET /api/posts` and renders pending → ready cards live.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string. |
| `DEEPSEEK_API_KEY` | yes | DeepSeek key for AI cards (<https://platform.deepseek.com>). |
| `POST_PASSWORD` | yes | Shared password required to post. |
| `SESSION_SECRET` | yes | Random string used to sign session cookies. |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | no | Override DeepSeek endpoint/model. |

Generate a session secret:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 1. Create the database on Neon

1. Sign up at <https://neon.tech> with GitHub (no card).
2. **Create project**. Pick the region closest to where you'll host the app.
3. On the project dashboard, open **Connection string** and copy the
   **Pooled connection** (it contains `-pooler`). Keep it handy.

## 2. Run it locally (optional but recommended)

```bash
cp .env.example .env        # then paste your DATABASE_URL into .env
npm install
npm start                   # http://localhost:3000
```

## 3. Deploy to Render

1. Push this folder to a GitHub repository.
2. Sign up at <https://render.com> with GitHub (no card).
3. **New +** → **Blueprint** → select the repo. Render reads `render.yaml`.
4. When prompted, set the env vars (`sync: false`): `DATABASE_URL` (Neon pooled),
   `DEEPSEEK_API_KEY`, `POST_PASSWORD`, `SESSION_SECRET`.
5. Deploy. Render gives you a `https://<name>.onrender.com` URL.
6. Verify: open `/` (the wall), unlock with `POST_PASSWORD`, and post a link —
   its card fills in after the AI responds.

## Free-tier trade-offs (know these before you launch)

- **Cold starts.** Render sleeps the app after 15 min idle → next request waits
  ~1 min. Neon suspends compute after 5 min idle → first query adds ~0.5–1.2 s.
  A free uptime pinger (e.g. a GitHub Actions cron hitting `/healthz` every
  10 min) keeps the app warm, but does *not* keep Neon awake by itself.
- **Ephemeral disk.** Render's free filesystem is wiped on redeploy — never
  store uploads or SQLite files there. Keep all state in Postgres.
- **750 instance-hours/month** on Render covers one always-on service (744 h);
  a sleeping service uses none.
- **No private networking** on free Render services, so the app talks to Neon
  over the public internet — that's why TLS (`sslmode=require`) is required.

## Adding another table

Drop a `CREATE TABLE IF NOT EXISTS ...` into `db.init()` in `db.js`, or run
migrations from a script. Everything persists in Neon.
