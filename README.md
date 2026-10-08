# Dynamic Website — Express + Postgres (free forever)

A minimal dynamic-website starter: **Express** app on **Render** (free web
service) + **PostgreSQL** on **Neon** (free plan). No credit card required for
either. See the trade-offs at the bottom.

## What's here

| File | Purpose |
|---|---|
| `server.js` | Express app. Loads `.env` locally, listens on `process.env.PORT`, exposes `/`, `/healthz`, and `/api/*`. |
| `db.js` | Lazy `pg` connection pool + `notes` table bootstrap. |
| `render.yaml` | Render Blueprint describing the web service. |
| `.env.example` | Local env template. |

Routes: `GET /` (landing page), `GET /healthz` (no DB), `GET /api/db-health`,
`GET /api/notes`, `POST /api/notes` with `{ "body": "..." }`.

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
