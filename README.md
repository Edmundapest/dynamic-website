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
| `images.js` | Card carousel: gathers/validates candidate photos, caches the expiring ones, resizes with `sharp` when present. |
| `enrich.js` | Async enrichment worker: fetch → AI → carousel → DB update. |
| `push.js` | Web Push: VAPID setup, subscription storage, broadcast on new posts. |
| `whatsapp.js` | WhatsApp Cloud API webhook: signed inbound messages → posts → AI-card replies. |
| `postUtils.js` | Shared URL detection + tag normalization for web and WhatsApp posts. |
| `wallpaper.js` | Daily Bing wallpaper lookup (bing.gifposter.com, Bing archive fallback), cached in memory. |
| `public/index.html` | The wall (home page). |
| `public/dashboard.html` | The original DB dashboard at `/dashboard`. |
| `public/theme.js` | Per-browser theme engine: 24 presets + custom RGB picker + daily wallpaper layer (localStorage). |
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
| `GET /api/wallpaper` | Today's Bing wallpaper URL + title/credit. Cached 30 min. **Public.** |
| `GET /api/whatsapp/webhook` | Meta's webhook verification challenge (`hub.challenge`). **Public.** |
| `POST /api/whatsapp/webhook` | Signed inbound WhatsApp messages. Creates posts + replies. **Public, signature-verified.** |
| `POST /api/login` · `POST /api/logout` · `GET /api/session` | Shared-password auth. **Public** (login is rate-limited). |
| `GET /api/posts` | **Auth.** The private feed of posts (with their AI cards). |
| `POST /api/posts` | **Auth.** Create a post `{ author, body, tags }`; returns `pending`, enriches in the background. |
| `POST /api/posts/:id/regenerate` | **Auth.** Re-run AI enrichment for a post. |
| `DELETE /api/posts/:id` | **Auth.** Delete a post. |
| `GET /api/stats` · `GET /api/ping` · `GET /api/db-health` | **Auth.** Dashboard stats/probes. |
| `POST /api/posts/:id/vote` | **Auth.** `{ value: 1\|-1\|0, voter }` — one vote per voter per post. |
| `POST /api/posts/:id/followup` | **Auth.** `{ prompt }` — the AI answers with the post as context, search results and listing pages; both turns are appended to `posts.thread`. |
| `GET /api/profile` | **Auth.** What the wall has learned about its readers (interests, dislikes, recent questions). |
| `GET /api/push/public-key` · `GET /api/push/status` | **Public.** VAPID key + whether push is configured. |
| `POST /api/push/subscribe` · `POST /api/push/unsubscribe` | **Auth.** Save/remove a device's push subscription. |
| `GET/POST/DELETE /api/notes` · `POST /api/seed` · `POST /api/reset` | **Auth.** The dashboard's demo data. |

> Every route marked **Auth.** requires the shared-password session cookie; an
> unauthenticated request gets `401 { ok:false, error:"authentication required" }`.

### How a post becomes a card

1. `POST /api/posts` inserts a row with `status = 'pending'` and returns immediately.
2. In the background, `enrich.js` fetches the URL (if any) via `fetchPage.js`
   (SSRF-guarded), then asks DeepSeek for a JSON card.
3. The card gets a **photo carousel of at least five images** (see below).
4. The row is updated to `status = 'ready'` with the `card` (or `status = 'error'`).
5. The wall polls `GET /api/posts` and renders pending → ready cards live.

### Card carousel (`images.js`)

Every card carries a swipeable carousel: arrows, dots, a `3 / 5` counter, and a
click-to-enlarge lightbox (arrow keys and `Esc` work; swiping works on touch).
Slides come from, in order:

1. the images on the linked page (`og:image` + inline `<img>`),
2. the images the web search returned (per-result and image-search),
3. Wikipedia, for text notes,
4. AI generation (Cloudflare Workers AI) — only to fill a shortfall.

Some of those URLs are short-lived: Instagram's CDN links are signed with an
`oe=` expiry (~4 days) and Xiaohongshu's photo links 404 within minutes. Those
are downloaded during enrichment, re-encoded to a ~1024px JPEG with `sharp`
(optional — if it is missing, only the expiring hosts are stored) and kept in
`posts.images_data`, then served from `GET /api/posts/:id/img/:idx`. Durable
hosts (Wikipedia, most blogs) stay as plain URLs. Storing costs roughly
40-90 KB per slide.

A slide never repeats. The same photo reaches the deck under different URLs,
CDN nodes and size variants, so dedupe runs twice: `dedupeKey()` normalises a
candidate URL (mirror hosts, `?w=…`/`?v=…` params, `/v1/fill/…` renditions,
Wikimedia widths), and stored slides are compared by SHA-1 of their bytes —
which is the only way to catch two different URLs serving the same picture.

`images_data` is a JSON array of data URIs; `card.images` holds the display URLs,
so the feed payload stays small. Cards created before carousels existed can be
topped up in place — existing pictures are kept, only the shortfall is added:

```bash
npm run backfill:images -- --dry   # report what would change
npm run backfill:images            # cards that are short or have duplicates
npm run backfill:images -- --force # rebuild every card's deck
```

### Follow-up thread

Under every card there is a **follow-up box**: ask a question and the AI answers
with the post as context — the card's summary, fun facts, quotes, the original
note, the source URL and the earlier turns of the same thread. It is told to stay
concrete, to never invent dates/prices/names, and to name what is missing instead
of guessing. `POST /api/posts/:id/followup` appends `{ role, text, at }` twice
(you, then the AI) to `posts.thread`, which is capped at the last 40 turns and
returned with the feed, so the conversation is part of the card rather than a
separate feature. Replaces the old single poster note.

A follow-up is not limited to what the card already knows. For every question it

1. runs a web search built from the prompt **plus** the post's keywords, so
   "find 10 more events" stays about the same topic;
2. reads up to four pages that actually list things — the post's own source and
   references (whatsonkl, Eventbrite, the event's site) and the top two search
   hits — and hands their text to the model;
3. asks for one line per item with venue/date/price, cited as `(3)` against the
   search results. Those markers are turned into source chips under the answer,
   so the card shows exactly which pages the reply came from.

So "Find 10 more events" enumerates real listings with dates and venues, says how
many it actually found, and admits when prices are not published.

### Preference profile (`profile.js`)

The wall learns from itself — no separate tagging, no onboarding quiz:

| Signal | Weight |
|---|---|
| Each AI tag on a post | 1 |
| Each AI keyword on a post | 0.6 |
| An up/down vote on a post | ±2 on its tags (±1.2 on keywords) |
| A follow-up question mentioning a known interest | 1.4 |

Scores decay with a 60-day half-life, so taste drifts with the wall instead of
being frozen by old posts. Two rules keep it honest: a topic is only marked
*disliked* with at least two downvoted posts and more down than up (one stray
thumb never brands a topic), and the profile is rebuilt from `posts`/`post_votes`
(never stored), so deleting a post deletes its influence. It is cached for 5
minutes and folded into the system prompt of **both** card generation and
follow-ups, where it may only decide emphasis and ranking — never facts. Inspect
it at `GET /api/profile` (auth): top interests with scores, disliked terms and
the last few questions. Set `PREFERENCES=off` to disable.

### Feed: votes, tags, sort & collapse

- **Tags are AI-generated.** When a post is enriched, the model also returns
  `tags` (3-6 short lowercase tags); `enrich.js` normalizes them and merges them
  into `posts.tags`. You don't type tags — they appear automatically a moment
  after posting. Tags show as chips on each card and in a tag bar above the feed.
  `GET /api/posts` returns `tags: string[]`.
- **Votes count once per person.** Each browser keeps a random `voter` id in
  `localStorage` (`wall_voter`) and sends it on every vote. The server stores one
  row per `(post_id, voter_id)` in `post_votes` and recomputes `votes_up` /
  `votes_down` from it — so clicking 👍 repeatedly does nothing extra. Clicking
  the same button again clears your vote (`value: 0`); clicking the other one
  switches it. `GET /api/posts` returns your own `my_vote` per post (via the
  `x-voter-id` header) so the UI can show your state.
- **Search & filter.** The search box filters the feed by free text (body, author,
  card title/summary) and by `#tag`; clicking a tag chip filters to it.
- **Sort.** The dropdown sorts the cached feed: Newest, Oldest, Most upvoted,
  Most downvoted, or Top score (up − down).
- **Collapse.** Each card has an arrow that collapses its body (author row + tags
  + vote bar stay visible). Collapse state is remembered per post while you browse.

Filtering and sorting happen in the browser over the up-to-100 posts the feed
returns; nothing extra is stored server-side for them.

### Wall UI (social-style)

The wall is laid out like a small social feed: a sticky top bar, an author row
(avatar + name + relative time) on each card, hashtag chips, and a feed of cards.

On phones (≤560px) the layout tightens up instead of just shrinking: the hero
blurb and the carousel arrows are hidden (swiping and the dots remain), the tag
bar and a card's tags become single scrolling rows, the feed toolbar stacks with
a full-width search box, and each card starts **collapsed** so ~2.4 cards fit on
screen — tap the chevron to open one (the expanded state survives the poll).

Two **floating buttons** (bottom-right, stacked above the theme 🎨 button) drive
the main actions:

- **✍️ New post** opens a bottom-sheet composer (name + text). Tags are added by
  AI, so there's nothing else to fill in. Your name is remembered per browser
  (`wall_name`) and pre-filled next time.
- **🔔 Notifications** opens a popover to enable/disable Web Push for this device.

Everything else (the feed, search, sort and the theme picker) sits behind the
password like the rest of the site. It's built for a two-person private wall —
one shared password, per-browser identity and votes — rather than public sign-ups.

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

### Daily wallpaper

The background follows Bing's **image of the day** (mirrored by
<https://bing.gifposter.com/>). `wallpaper.js` scrapes the current `og:image`
from that page (falling back to Bing's public image archive API), caches the
result for 30 minutes, and exposes it at `GET /api/wallpaper`. The client
(`theme.js`) paints it as a fixed layer behind every page, with a theme-colored
overlay so cards and text stay readable; light and dark themes get different
overlay strengths. It refreshes on load, every hour, and when the tab becomes
visible again.

The choice is per-browser: untick **Daily Bing wallpaper** in the 🎨 panel to
go back to the plain theme background. The panel also shows today's title and a
credit link. If the source is unreachable, the app keeps the normal theme
background (and the last good wallpaper, if one was already cached).

### Themed app icon

The theme also re-tints the **icon** via a small server generator (`icons.js` +
`GET /icon.png?size=…&accent=…&accent2=…&bg=…`), so it matches your colors:

- the **browser tab / bookmark favicon** updates live when you change theme;
- a **fresh "Add to Home Screen"** captures the themed icon — iOS reads the
  `apple-touch-icon` link, Android reads the manifest, and `theme.js` rewrites
  both to themed URLs (`/icon.png?size=180&…`, `/manifest.webmanifest?accent=…`),
  which the server renders with `theme_color`/`background_color` set to your
  background.

**Limitation:** an icon that is *already* on a home screen **cannot** be changed
afterward — the OS launcher caches it and there is no web API to restyle it.
Re-adding to the Home Screen (after choosing a theme) picks up the new icon.
Themed PNGs/icons come from the server route, which is public (the OS fetches it
during install, with no cookie).

## Security

The wall and dashboard are **private**: everything except `/healthz`, the
auth/session routes, the two public push endpoints (public key + status),
`/api/wallpaper`, and the WhatsApp webhook requires the shared password. The
wallpaper endpoint only returns a public Bing image URL and its title. The
WhatsApp webhook is public by necessity but requires Meta's HMAC signature, an
allowlisted sender, and dedupes retries via `posts.wa_message_id`. What's in
place:

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

## Posting from WhatsApp (optional)

The wall can accept posts from WhatsApp and reply in the chat with the finished
AI card. It uses the **WhatsApp Cloud API** and the same async enrichment worker
as the website, so posting is instant and the card arrives a few seconds later.

**Flow:** you message the business number → the webhook verifies Meta's HMAC
signature and the sender allowlist → a `posts` row is created (`source =
'whatsapp'`) → you get an acknowledgement → when the AI card is ready,
`enrich.js` sends it back as a WhatsApp reply. Card replies are claimed with
`wa_replied_at`, so regenerating a post on the wall won't spam the chat.

### 1. Create the Meta app

1. In <https://developers.facebook.com>, create an app with the **WhatsApp**
   product, or use an existing WhatsApp Business Account.
2. Open **WhatsApp → API Setup**. Note the **Phone number ID** (not the phone
   number itself). For production, create a **System User** permanent token
   with `whatsapp_business_messaging`; the 24-hour test token expires quickly.
3. In **App settings → Basic**, copy the **App secret** and **App ID**.

### Automated setup helper

`scripts/whatsapp-setup.js` can do most of the setup for you:

```bash
npm run whatsapp:setup
```

It will generate `WHATSAPP_VERIFY_TOKEN` if needed, validate the Meta token and
phone number ID, set the WhatsApp env vars on Render, trigger a deploy, verify
the public webhook challenge, and configure the Meta webhook + WABA
subscription. It never prints secret values.

For the automation parts, add these **setup-only** values to `.env` (they are
not needed by the running app):

| Name | Purpose |
|---|---|
| `WHATSAPP_APP_ID` | Meta app ID, used to set the app webhook subscription. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA id; lets the helper find the phone number ID and subscribe the WABA. |
| `RENDER_API_KEY` | Render Account Settings → API Keys. Lets the helper set env vars and deploy. |
| `RENDER_SERVICE_ID` | Optional `srv-…`; otherwise the helper finds the service named `dynamic-website`. |

Use `npm run whatsapp:setup -- --check` to validate without changing anything,
`--render` to only configure Render, or `--meta` to only configure Meta. If you
prefer the dashboard, skip the helper and follow the manual steps below.

### 2. Configure the server

Set these in Render (or `.env` locally):

| Name | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Permanent access token used to send replies. |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's Cloud API phone number ID. |
| `WHATSAPP_VERIFY_TOKEN` | Any random string; paste the same value into Meta's webhook setup. |
| `WHATSAPP_APP_SECRET` | Meta app secret, used to verify `X-Hub-Signature-256`. |
| `WHATSAPP_ALLOWED_NUMBERS` | Comma-separated E.164 digits (no `+`) allowed to post. **Required** — with it empty every sender is ignored and logged. |
| `WHATSAPP_API_VERSION` | Optional Graph API version (default `v23.0`; override when Meta deprecates it). |
| `PUBLIC_URL` | Optional link back to the wall; Render injects `RENDER_EXTERNAL_URL` automatically. |
| `WHATSAPP_APP_ID` / `WHATSAPP_BUSINESS_ACCOUNT_ID` | Setup-only; used by `npm run whatsapp:setup` to register the webhook and subscribe the WABA. |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` | Setup-only; lets the helper set Render env vars and deploy. |

### 3. Register the webhook

In **WhatsApp → Configuration → Webhook**:

- **Callback URL:** `https://<your-app>/api/whatsapp/webhook`
- **Verify token:** the same `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field.

Meta immediately calls the `GET` endpoint; a correct token returns the challenge
as plain text. Send a WhatsApp message from a number in
`WHATSAPP_ALLOWED_NUMBERS`; you should get an acknowledgement, then the card.

**Notes:** replies use the free-form 24-hour customer-service window (the reply
arrives within that window), and media messages are posted by their **caption**
only — the file itself isn't downloaded. The Graph API version is configurable
because Meta retires old versions; the endpoint shape is stable.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string. |
| `TAVILY_API_KEY` | no | Web search for text notes (1,000 free credits/month, no card). Without it a key-less DuckDuckGo scrape is used, which datacenter hosts often block. |
| `DEEPSEEK_API_KEY` | yes | DeepSeek key for AI cards (<https://platform.deepseek.com>). |
| `POST_PASSWORD` | yes | Shared password required to post. |
| `SESSION_SECRET` | yes | Random string used to sign session cookies. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | yes* | Web-push signing keys (see below). Without them, notifications are disabled but the app runs. |
| `VAPID_SUBJECT` | no | Contact for the push service, e.g. `mailto:you@example.com`. |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | no | WhatsApp Cloud API token + phone number ID. Without them replies are disabled. |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | no | Webhook verification + signature checking. Both are required for the webhook. |
| `WHATSAPP_ALLOWED_NUMBERS` | no* | Comma-separated E.164 senders allowed to post (*the webhook ignores everyone while empty). |
| `WHATSAPP_API_VERSION` | no | Graph API version (default `v23.0`). |
| `SEARCH_COUNTRY` | no | Tavily country boost for search results (default `malaysia`). Without it, a vague query like "things to do this weekend" returns US results. |
| `SEARCH_LOCATION` | no | Appended to local-intent queries ("near me", "this weekend", restaurants…). Default `Kuala Lumpur`. |
| `SEARCH_REGION` | no | DuckDuckGo fallback region code (default `my-en`). |
| `SEARCH_LANGUAGE` | no | Language boost for results (default `en`). |
| `PREFERENCES` | no | Set to `off` to stop the wall steering prompts with its learned interest profile. |
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
- **Carousel storage adds up.** Photos that must be cached (Instagram,
  Xiaohongshu) and AI-generated slides live in `posts.images_data` at roughly
  40-90 KB each — about 0.3 MB per five-slide card. On Neon's 512 MB free tier
  that is comfortably thousands of posts, but it is not free of cost: delete
  posts you don't want and the row goes with them.

## Adding another table

Drop a `CREATE TABLE IF NOT EXISTS ...` into `db.init()` in `db.js`, or run
migrations from a script. Everything persists in Neon.
