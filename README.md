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
| `push.js` | Web Push: VAPID setup, subscription storage, broadcast on new posts. |
| `public/index.html` | The wall (home page). |
| `public/dashboard.html` | The original DB dashboard at `/dashboard`. |
| `public/theme.js` | Per-browser theme engine: 24 presets + custom RGB picker (localStorage). |
| `public/sw.js` | Service worker: shows push notifications, opens the app on tap. |
| `public/manifest.webmanifest` | PWA manifest (installable app + icons). |
| `public/icon-*.png`, `public/apple-touch-icon.png` | App icons. |
| `render.yaml` | Render Blueprint describing the web service. |
| `.github/workflows/keep-warm.yml` | Cron that pings `/healthz` so the free Render service stays warm. |
| `.env.example` | Local env template. |

### Pages & API

| Route | What it does |
|---|---|
| `GET /` | The wall. Without the password it shows only the login gate — no feed. |
| `GET /dashboard` | The DB dashboard (stats, latency meter, notes demo). Data requires login. |
| `GET /healthz` | Liveness probe (no DB). Used by Render + the keep-warm cron. **Public.** |
| `POST /api/login` · `POST /api/logout` · `GET /api/session` | Shared-password auth. **Public** (login is rate-limited). |
| `GET /api/posts` | **Auth.** The private feed of posts (with their AI cards). |
| `POST /api/posts` | **Auth.** Create a post `{ author, body }`; returns `pending`, enriches in the background. |
| `POST /api/posts/:id/regenerate` | **Auth.** Re-run AI enrichment for a post. |
| `DELETE /api/posts/:id` | **Auth.** Delete a post. |
| `GET /api/stats` · `GET /api/ping` · `GET /api/db-health` | **Auth.** Dashboard stats/probes. |
| `POST /api/posts/:id/vote` | **Auth.** Thumbs up/down (steers future cards). |
| `POST /api/posts/:id/note` | **Auth.** Poster-authored note for a card. |
| `GET /api/push/public-key` · `GET /api/push/status` | **Public.** VAPID key + whether push is configured. |
| `POST /api/push/subscribe` · `POST /api/push/unsubscribe` | **Auth.** Save/remove a device's push subscription. |
| `GET/POST/DELETE /api/notes` · `POST /api/seed` · `POST /api/reset` | **Auth.** The dashboard's demo data. |

> Every route marked **Auth.** requires the shared-password session cookie; an
> unauthenticated request gets `401 { ok:false, error:"authentication required" }`.

### How a post becomes a card

1. `POST /api/posts` inserts a row with `status = 'pending'` and returns immediately.
2. In the background, `enrich.js` fetches the URL (if any) via `fetchPage.js`
   (SSRF-guarded), then asks DeepSeek for a JSON card.
3. The row is updated to `status = 'ready'` with the `card` (or `status = 'error'`).
4. The wall polls `GET /api/posts` and renders pending → ready cards live.

## Themes

The look is customizable per **browser/device** — the app has a single shared
password and no user accounts, so each visitor's choice is stored in
`localStorage` (key `wall_theme_v1`), not on the server.

- **24 presets** (15 dark, 9 light): Midnight, Nebula, Emerald, Sunset, Ocean,
  Crimson, Cyberpunk, Forest, Mono, Amber, Aurora, Slate, Rose, Indigo, Teal,
  Daybreak, Paper, Mint, Sky, Lavender, Sand, Cloud, Peach, Matcha.
- **Custom RGB picker**: choose accent, accent-2 and background colors; text and
  surfaces adapt automatically based on the background's luminance.
- Open it with the floating **🎨** button (bottom-right on both the wall and the
  dashboard). The choice applies instantly and persists across reloads.

`public/theme.js` is the whole system: it defines the presets, applies the chosen
colors as CSS custom properties on `<html>` (overriding each page's `:root`), and
injects the picker UI. It's loaded in `<head>` so there's no flash of the default
theme. See `window.WallTheme` in the console for the theme list and a `set()` API.

## Security

The wall and dashboard are **private**: everything except `/healthz`, the
auth/session routes, and the two public push endpoints requires the shared
password. What's in place:

- **All data is auth-gated.** Reads (`/api/posts`, images, stats, notes) and
  writes return `401` without a valid session cookie, so an unauthorized visitor
  sees no posts and can't post.
- **Rate limiting** (`express-rate-limit`, correct client IP via
  `app.set("trust proxy", 1)`):
  - global — 240 requests/min per IP;
  - `/api/login` — 10 attempts / 15 min per IP, counting only failures (brute-force
    protection for the shared password);
  - writes — 30/min per IP (posts, notes, seed, reset, votes, push subscribe).
- **Security headers** via `helmet`, with a `Content-Security-Policy` locked to
  `'self'` (plus inline styles/scripts and `https:` images, which the pages need)
  and `frame-ancestors 'none'`.
- **Request timeouts** (`headersTimeout`/`requestTimeout`/`keepAliveTimeout`) to
  blunt slowloris/resource-exhaustion, and a body cap (`express.json` 16 kB).
- **Auth cookie** is `HttpOnly`, `SameSite=Lax`, and `Secure` in production;
  the password is compared in constant time and the cookie is HMAC-signed.

### What this does *not* cover

In-app rate limiting stops brute force and request-level abuse, but **not a
volumetric DDoS** — that has to be absorbed at the network edge. If you want
strong DDoS protection, put **Cloudflare** (free) in front: add a custom domain
to Render, move DNS to Cloudflare, and enable its proxy + "Under Attack" mode.
For a sharper edge, add Cloudflare WAF/rate-limiting rules there too.

`POST_PASSWORD` is one shared secret for everyone — fine for a small private
wall, but it's all-or-nothing: anyone with the password can post *and* delete.
If you need per-person accounts later, that's a bigger change (users table +
per-user sessions).

## Push notifications (PWA)

The wall is a **PWA**, so it can be installed to the home screen and send a push
notification whenever someone posts. Notifications fire from `POST /api/posts`
via `push.js`, which broadcasts to every stored subscription.

**1. Generate VAPID keys once** (reuse the same pair across deploys so existing
subscriptions stay valid):

```bash
npx web-push generate-vapid-keys
```

Put the two keys in `.env` locally and in Render's environment as
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (optionally `VAPID_SUBJECT`). Without
them the app still runs — it just logs that push is disabled.

**2. Subscribe a device:** open the site and tap **🔔 New-post notifications →
Enable**, then allow notifications. Subscriptions are stored in the
`push_subscriptions` table; dead endpoints are pruned automatically.

### iPhone (important)

iOS only allows web push from a **PWA added to the Home Screen** — not from a
Safari tab — and requires **iOS 16.4+**. On an iPhone:

1. Open the site in **Safari**.
2. Tap **Share → Add to Home Screen**, then **Add**.
3. Open **The Wall** from the Home Screen icon (it runs full-screen).
4. Tap **🔔 New-post notifications → Enable** and allow notifications.

The page detects this: if you're on iOS in a Safari tab, the button guides you
to add it to the Home Screen first. Push also requires **HTTPS** (Render provides
it); on `localhost` most browsers treat it as a secure context too.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string. |
| `DEEPSEEK_API_KEY` | yes | DeepSeek key for AI cards (<https://platform.deepseek.com>). |
| `POST_PASSWORD` | yes | Shared password required to post. |
| `SESSION_SECRET` | yes | Random string used to sign session cookies. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | yes* | Web-push signing keys (see below). Without them, notifications are disabled but the app runs. |
| `VAPID_SUBJECT` | no | Contact for the push service, e.g. `mailto:you@example.com`. |
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
