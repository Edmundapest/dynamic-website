# Dynamic Website — Express + Postgres (free forever)

A minimal dynamic-website starter: **Express** app on **Render** (free web
service) + **PostgreSQL** on **Neon** (free plan). No credit card required for
either. See the trade-offs at the bottom.

## What's here

| File | Purpose |
|---|---|
| `server.js` | Express app + JSON API. Loads `.env` locally, listens on `process.env.PORT`. |
| `db.js` | Lazy `pg` connection pool, schema bootstrap, and a timed-query helper. |
| `public/index.html` | The demo UI — a live wall of messages, latency meter, and stats. Self-contained (no build step). |
| `render.yaml` | Render Blueprint describing the web service. |
| `.github/workflows/keep-warm.yml` | Cron that pings `/healthz` so the free Render service stays warm. |
| `.env.example` | Local env template. |

### Pages & API

| Route | What it does |
|---|---|
| `GET /` | The demo page: live stats, latency meter, message wall. |
| `GET /healthz` | Liveness probe (no DB). Used by Render + the keep-warm cron. |
| `GET /api/stats` | Row count, DB engine/version, region, uptime, query time. |
| `GET /api/ping` | `SELECT 1` round-trip measured in ms. |
| `GET /api/db-health` | Confirms the DB is reachable, returns its clock. |
| `GET /api/notes` | Latest 200 messages. |
| `POST /api/notes` | Create a message: `{ "author": "...", "body": "..." }`. |
| `DELETE /api/notes/:id` | Delete one message. |
| `POST /api/seed` | Insert demo rows: `{ "n": 10 }`. |
| `POST /api/reset` | Truncate the table. |

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
4. When prompted for `DATABASE_URL`, paste the Neon **pooled** connection string.
5. Deploy. Render gives you a `https://<name>.onrender.com` URL.
6. Verify: open `/` and `/api/db-health` (should show a `db_time`).

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
