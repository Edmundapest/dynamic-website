// Dynamic website demo: Express + Postgres (Neon), deployable to Render.
// Loads .env locally; on Render the real environment variables are used.
require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const db = require("./db");
const auth = require("./auth");
const enrich = require("./enrich");
const push = require("./push");
const icons = require("./icons");
const wallpaper = require("./wallpaper");
const whatsapp = require("./whatsapp");
const { detectUrl, parseTags } = require("./postUtils");

const app = express();

// Render terminates TLS at a proxy in front of us. Trust exactly one hop so
// req.ip is the real client address — required for rate limiting to be correct
// (trusting all proxies would let clients spoof X-Forwarded-For).
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers. The CSP is deliberately relaxed in two places: inline
// styles/scripts (the pages are self-contained single files) and https images
// (AI cards embed external photos). Everything else is locked to 'self'.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "https:", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // don't block external card images
    referrerPolicy: { policy: "no-referrer" },
  })
);

// Meta signs the RAW webhook bytes, so keep this route's body unparsed until
// the signature is checked. A larger cap because one delivery can batch
// several messages.
app.use(
  "/api/whatsapp/webhook",
  express.raw({ type: "application/json", limit: "256kb" })
);
app.use(express.json({ limit: "16kb" }));

// --- Rate limiting (brute force + flood defence) -------------------------
// A broad per-IP cap on everything...
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { ok: false, error: "too many requests, slow down" },
  })
);

// ...a strict cap on login (the shared password is brute-forceable otherwise),
// counting only failures so a legitimate login never burns the budget...
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: "too many login attempts, try again later" },
});

// ...and a tighter cap on writes, which cost DB work (and, for posts, AI calls).
const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "too many write requests, slow down" },
});

// The current demo dashboard now lives at /dashboard; "/" is the wall page
// (served automatically by the static handler's index.html).
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
// The service worker must be served from the site root so its scope covers the
// whole app, and it must never be cached (browsers hard-cache SW scripts).
app.get("/sw.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});
// PWA manifest. When the client passes its theme colors we return themed icon
// URLs (so a fresh "Add to Home Screen" matches the chosen theme); otherwise we
// fall back to the static icons. Public — the OS fetches these during install.
app.get("/manifest.webmanifest", (req, res) => {
  const manifest = {
    name: "The Wall",
    short_name: "The Wall",
    description: "A shared wall of links and notes, each investigated by AI.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0e1a",
    theme_color: "#0a0e1a",
  };
  if (req.query.accent || req.query.accent2 || req.query.bg) {
    const accent = icons.normHex(req.query.accent, "#6c8cff");
    const accent2 = icons.normHex(req.query.accent2, "#22d3ee");
    const bg = icons.normHex(req.query.bg, "#0a0e1a");
    const q =
      `accent=${encodeURIComponent(accent)}` +
      `&accent2=${encodeURIComponent(accent2)}` +
      `&bg=${encodeURIComponent(bg)}`;
    manifest.background_color = bg;
    manifest.theme_color = bg;
    manifest.icons = [
      { src: `/icon.png?size=192&${q}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/icon.png?size=512&${q}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/icon.png?size=512&${q}&maskable=1`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
  } else {
    manifest.icons = [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
  }
  res.type("application/manifest+json").send(JSON.stringify(manifest));
});

// Themed app icon, e.g. /icon.png?size=192&accent=%23a855f7&accent2=%2314b8a6&bg=%23140a24
// Public, and cached — handy as both the favicon and the install-time icon.
app.get("/icon.png", (req, res) => {
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 192, 16), 1024);
  const colors = {
    accent: icons.normHex(req.query.accent, "#6c8cff"),
    accent2: icons.normHex(req.query.accent2, "#22d3ee"),
    bg: icons.normHex(req.query.bg, "#0a0e1a"),
  };
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end(icons.render(size, colors));
});
app.use(express.static(path.join(__dirname, "public")));

// Render sets PORT for you; 3000 is the local default.
const PORT = process.env.PORT || 3000;

const PALETTE = [
  "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1",
  "#f368e0", "#ff9f43", "#54a0ff", "#00d2d3",
];
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

// --- Routes that never touch the database -------------------------------
// Used by Render's health check and the keep-warm cron.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Today's Bing wallpaper (mirrored by bing.gifposter.com). Public: the login
// page and the dashboard both use it as a background. Cached upstream by the
// wallpaper module, and by the browser for half an hour.
app.get("/api/wallpaper", async (_req, res) => {
  try {
    const data = await wallpaper.getWallpaper();
    res.setHeader("Cache-Control", "public, max-age=1800, stale-while-revalidate=86400");
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(503).json({ ok: false, error: "wallpaper unavailable" });
  }
});

// --- WhatsApp Cloud API ---------------------------------------------------
// Meta verifies the callback with a GET challenge, then POSTs signed message
// events. We acknowledge immediately and let enrich.js send the card reply
// once the AI work is done.
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode !== "subscribe" || !whatsapp.verifyToken(token)) {
    return res.status(403).end();
  }
  res.type("text/plain").send(String(challenge || ""));
});

app.post("/api/whatsapp/webhook", (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!whatsapp.verifySignature(raw, req.get("x-hub-signature-256"))) {
    return res.status(403).json({ ok: false, error: "bad signature" });
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "bad json" });
  }

  // Meta retries on slow/non-200 responses; ack before doing any work.
  res.sendStatus(200);
  whatsapp.handleWebhook(payload).catch((err) => {
    console.warn(`WhatsApp webhook failed: ${err.message}`);
  });
});

// --- Session auth (shared posting password) ------------------------------
app.post("/api/login", loginLimiter, (req, res) => {
  const password = (req.body && req.body.password) || "";
  if (!auth.checkPassword(password)) {
    return res.status(401).json({ ok: false, error: "wrong password" });
  }
  res.setHeader("Set-Cookie", auth.cookieHeader());
  res.json({ ok: true, authenticated: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", auth.clearCookieHeader());
  res.json({ ok: true, authenticated: false });
});

app.get("/api/session", (req, res) => {
  res.json({ ok: true, authenticated: auth.isAuthed(req) });
});

// --- Web Push subscriptions ----------------------------------------------
// Anyone may subscribe (viewers included). We only ever store the opaque
// subscription object the browser hands us; no personal data.

app.get("/api/push/status", async (_req, res) => {
  try {
    res.json({ ok: true, configured: push.isConfigured(), subscribers: await push.countSubscriptions() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The VAPID public key the client uses to create a subscription.
app.get("/api/push/public-key", (_req, res) => {
  res.json({ ok: true, publicKey: push.publicKey() });
});

app.post("/api/push/subscribe", writeLimiter, auth.requireAuth, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!push.validSubscription(sub)) {
    return res.status(400).json({ ok: false, error: "invalid subscription" });
  }
  if (!push.isConfigured()) {
    return res.status(503).json({ ok: false, error: "push is not configured on the server" });
  }
  try {
    await push.saveSubscription(sub, req.headers["user-agent"]);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/push/unsubscribe", writeLimiter, auth.requireAuth, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  try {
    const removed = await push.removeSubscription(endpoint);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Wall posts ----------------------------------------------------------
// Reads and writes require the shared password (requireAuth).

// A per-browser id (from localStorage) that lets us count one vote per person.
function cleanVoter(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 6 || s.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

app.get("/api/posts", auth.requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, author, body, kind, url, status, card, error, votes_up, votes_down, thread, tags, source, created_at, updated_at
         FROM posts ORDER BY created_at DESC LIMIT 100`
    );
    const voter = cleanVoter(req.get("x-voter-id"));
    const mine = new Map();
    if (voter && rows.length) {
      const ids = rows.map((r) => r.id);
      const { rows: votes } = await db.query(
        `SELECT post_id, value FROM post_votes WHERE voter_id = $1 AND post_id = ANY($2)`,
        [voter, ids]
      );
      for (const v of votes) mine.set(v.post_id, v.value);
    }
    for (const r of rows) r.my_vote = mine.get(r.id) || 0;
    res.json({ ok: true, posts: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serves a stored AI-generated image (kept out of the JSON feed).
app.get("/api/posts/:id/image", auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  try {
    const { rows } = await db.query("SELECT image_data FROM posts WHERE id = $1", [id]);
    const data = rows[0] && rows[0].image_data;
    const m = data && /^data:(image\/[a-z+]+);base64,([\s\S]+)$/.exec(data);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.end(Buffer.from(m[2], "base64"));
  } catch {
    res.status(500).end();
  }
});

// Serves one slide of a card's carousel: images we downloaded because their
// original URL expires (Instagram, Xiaohongshu) or would be hotlink-blocked.
app.get("/api/posts/:id/img/:idx", auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const idx = Number.parseInt(req.params.idx, 10);
  if (!Number.isInteger(id) || !Number.isInteger(idx) || idx < 0 || idx > 63) {
    return res.status(400).end();
  }
  try {
    const { rows } = await db.query("SELECT images_data FROM posts WHERE id = $1", [id]);
    const list = rows[0] && Array.isArray(rows[0].images_data) ? rows[0].images_data : [];
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(list[idx] || ""));
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m[1]);
    // Content-addressed by post id + index and never rewritten in place, so it
    // is safe to cache hard; browsers fall back to a refetch on a new post.
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.end(Buffer.from(m[2], "base64"));
  } catch {
    res.status(500).end();
  }
});

app.post("/api/posts", writeLimiter, auth.requireAuth, async (req, res) => {
  const body = (req.body && req.body.body ? String(req.body.body) : "").trim();
  let author = (req.body && req.body.author ? String(req.body.author) : "").trim();
  if (author.length > 40) author = author.slice(0, 40);
  if (!body) return res.status(400).json({ ok: false, error: "post text is required" });
  if (body.length > 1000) return res.status(400).json({ ok: false, error: "post too long (max 1000)" });

  const url = detectUrl(body);
  const kind = url ? "link" : "text";
  const tags = parseTags(req.body && req.body.tags);
  try {
    const { rows } = await db.query(
      `INSERT INTO posts (author, body, kind, url, status, tags)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, author, body, kind, url, status, tags, source, created_at`,
      [author || null, body, kind, url, tags]
    );
    enrich.enqueue(rows[0].id); // fire-and-forget; response returns immediately
    // Notify every subscribed device. Fire-and-forget so a slow push service
    // never delays the poster's response.
    push
      .notifyNewPost(rows[0])
      .catch((err) => console.warn(`Push broadcast failed: ${err.message}`));
    res.status(201).json({ ok: true, post: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/posts/:id/regenerate", writeLimiter, auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try {
    const { rowCount } = await db.query(
      `UPDATE posts SET status = 'pending', error = NULL, card = NULL, updated_at = now() WHERE id = $1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "post not found" });
    enrich.enqueue(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/posts/:id", writeLimiter, auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try {
    const { rowCount } = await db.query("DELETE FROM posts WHERE id = $1", [id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Thumbs up/down, one vote per person per post (keyed by the client's voter id).
// value = 1, -1, or 0 to clear. Counts are recomputed from post_votes so a
// single visitor can't inflate the numbers by clicking repeatedly.
app.post("/api/posts/:id/vote", writeLimiter, auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const value = Number(req.body && req.body.value);
  if (value !== 1 && value !== -1 && value !== 0) {
    return res.status(400).json({ ok: false, error: "value must be 1, -1 or 0" });
  }
  const voter = cleanVoter(req.body && req.body.voter);
  if (!voter) return res.status(400).json({ ok: false, error: "missing voter id" });
  try {
    const { rowCount } = await db.query("SELECT 1 FROM posts WHERE id = $1", [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "post not found" });

    if (value === 0) {
      await db.query("DELETE FROM post_votes WHERE post_id = $1 AND voter_id = $2", [id, voter]);
    } else {
      await db.query(
        `INSERT INTO post_votes (post_id, voter_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (post_id, voter_id)
           DO UPDATE SET value = EXCLUDED.value, created_at = now()`,
        [id, voter, value]
      );
    }
    const { rows } = await db.query(
      `UPDATE posts
          SET votes_up = (SELECT count(*) FROM post_votes WHERE post_id = $1 AND value = 1),
              votes_down = (SELECT count(*) FROM post_votes WHERE post_id = $1 AND value = -1),
              updated_at = now()
        WHERE id = $1
        RETURNING votes_up, votes_down`,
      [id]
    );
    res.json({ ok: true, votes_up: rows[0].votes_up, votes_down: rows[0].votes_down, my_vote: value });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// What the wall has learned about its readers (interests, dislikes, recent
// questions). Auth-gated: it is derived from private postings.
app.get("/api/profile", auth.requireAuth, async (_req, res) => {
  try {
    const profile = require("./profile");
    const data = await profile.get();
    res.json({ ok: true, profile: data, summary: profile.summary(data) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Follow-up thread: ask the AI about a post, and it answers with the post (and
// the earlier turns) as context. Appended to posts.thread, capped at 40 turns.
app.post("/api/posts/:id/followup", writeLimiter, auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const prompt = (req.body && req.body.prompt ? String(req.body.prompt) : "").trim();
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (!prompt) return res.status(400).json({ ok: false, error: "prompt is required" });
  if (prompt.length > 500) return res.status(400).json({ ok: false, error: "prompt too long (max 500)" });
  try {
    const { rows } = await db.query(
      "SELECT id, body, url, card, thread, status FROM posts WHERE id = $1",
      [id]
    );
    const post = rows[0];
    if (!post) return res.status(404).json({ ok: false, error: "post not found" });
    if (post.status !== "ready") {
      return res.status(409).json({ ok: false, error: "this post is still being processed" });
    }

    const thread = Array.isArray(post.thread) ? post.thread : [];
    const ai = require("./ai");
    const prefs = require("./profile");
    const { webSearch, followupQuery } = require("./search");

    // A follow-up usually asks for something the card does not contain ("find 10
    // more events"), so search the web for it, keeping the post's topic (and,
    // for generic asks, nudging towards what this wall likes), then read the
    // listing pages the post already points at.
    const profile = await prefs.get();
    const query = followupQuery(prompt, post.card || {}, profile.terms);
    const refs = Array.isArray(post.card && post.card.references) ? post.card.references : [];
    const results = await webSearch(query, 10).catch((err) => {
      console.warn(`follow-up search failed: ${err.message}`);
      return [];
    });

    // Read the pages that actually name events: the ones the post points at,
    // plus the top search hits (roundups are usually first).
    const pageUrls = [...new Set([
      post.url,
      ...refs.map((r) => (r && r.url) || r),
      ...results.slice(0, 2).map((r) => r.url),
    ].filter((u) => typeof u === "string" && /^https?:/i.test(u)))];
    const { fetchPage } = require("./fetchPage");
    const pages = (
      await Promise.all(
        pageUrls.slice(0, 4).map(async (u) => {
          try {
            const page = await fetchPage(u);
            if (!page || !page.text) return null;
            return { url: u, title: page.title || u, text: String(page.text).slice(0, 2500) };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);

    const answer = await ai.continueThread({
      card: post.card || {},
      body: post.body,
      url: post.url,
      thread,
      prompt,
      searchResults: results,
      searchQuery: query,
      pages,
      profile: prefs.summary(profile),
    });

    // The reply cites result numbers ("… Halloween Weekend (3)"). Turn those
    // into named source chips and drop the bare markers from the text.
    const citedIdx = [];
    const reply = answer.replace(/\s*\((\d{1,2})\)/g, (match, n) => {
      const i = Number(n) - 1;
      if (i < 0 || i >= results.length) return match; // keep "(2026)" and friends
      if (!citedIdx.includes(i)) citedIdx.push(i);
      return "";
    });

    const hostOf = (u) => {
      try { return new URL(u).hostname.replace(/^www\./i, ""); } catch { return ""; }
    };
    const sources = citedIdx
      .slice(0, 4)
      .map((i) => ({
        url: results[i].url,
        title: String(results[i].title || hostOf(results[i].url)).slice(0, 90),
      }));

    const at = new Date().toISOString();
    const next = thread
      .concat([
        { role: "user", text: prompt, at },
        { role: "assistant", text: reply, at, ...(sources.length ? { sources } : {}) },
      ])
      .slice(-40);
    const { rows: saved } = await db.query(
      "UPDATE posts SET thread = $1, updated_at = now() WHERE id = $2 RETURNING thread",
      [JSON.stringify(next), id]
    );
    res.json({ ok: true, thread: saved[0].thread });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- Data API (every route here proves the database is live) -------------

// Aggregate stats: row count, engine version, round-trip timing.
app.get("/api/stats", auth.requireAuth, async (_req, res) => {
  try {
    const { result: countRes, ms: countMs } = await db.timedQuery(
      "SELECT count(*)::int AS n FROM notes"
    );
    const { result: infoRes } = await db.timedQuery(
      `SELECT version() AS version, current_database() AS db, now() AS now`
    );
    const info = infoRes.rows[0];
    res.json({
      ok: true,
      notes: countRes.rows[0].n,
      query_ms: Number(countMs.toFixed(1)),
      db: info.db,
      db_time: info.now,
      engine: String(info.version).split(" ").slice(0, 2).join(" "),
      region: process.env.RENDER_REGION || (process.env.RENDER ? "render" : "local"),
      node: process.version,
      uptime: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Raw DB ping returning how many ms the round-trip took.
app.get("/api/ping", auth.requireAuth, async (_req, res) => {
  try {
    const { ms } = await db.timedQuery("SELECT 1");
    res.json({ ok: true, ms: Number(ms.toFixed(1)) });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/notes", auth.requireAuth, async (_req, res) => {
  try {
    const { result, ms } = await db.timedQuery(
      "SELECT id, author, body, color, created_at FROM notes ORDER BY id DESC LIMIT 200"
    );
    res.json({ ok: true, query_ms: Number(ms.toFixed(1)), notes: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/notes", writeLimiter, auth.requireAuth, async (req, res) => {
  const body = (req.body && req.body.body ? String(req.body.body) : "").trim();
  let author = (req.body && req.body.author ? String(req.body.author) : "").trim();
  if (!body) return res.status(400).json({ ok: false, error: "body is required" });
  if (body.length > 500) return res.status(400).json({ ok: false, error: "body too long (max 500)" });
  if (author.length > 40) author = author.slice(0, 40);
  try {
    const { result, ms } = await db.timedQuery(
      `INSERT INTO notes (author, body, color)
       VALUES ($1, $2, $3)
       RETURNING id, author, body, color, created_at`,
      [author || null, body, pickColor()]
    );
    res.status(201).json({ ok: true, query_ms: Number(ms.toFixed(1)), note: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/notes/:id", writeLimiter, auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try {
    const { rowCount } = await db.query("DELETE FROM notes WHERE id = $1", [id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Insert a burst of demo rows in a single statement.
app.post("/api/seed", writeLimiter, auth.requireAuth, async (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.body && req.body.n, 10) || 10, 1), 100);
  const samples = [
    "Ship it 🚀", "This row came from Postgres", "SELECT * FROM good_vibes",
    "Persisted, not cached", "Hello from Neon", "Dynamic and proud",
    "100% server-rendered data", "Survived a refresh 💾",
  ];
  const names = ["Ada", "Linus", "Grace", "Dennis", "Barbara", "Alan", "Margaret", ""];
  const values = [];
  const params = [];
  for (let i = 0; i < n; i++) {
    const b = i + 1;
    params.push(
      names[Math.floor(Math.random() * names.length)] || null,
      samples[Math.floor(Math.random() * samples.length)],
      pickColor()
    );
    values.push(`($${b * 3 - 2}, $${b * 3 - 1}, $${b * 3})`);
  }
  try {
    const { result, ms } = await db.timedQuery(
      `INSERT INTO notes (author, body, color) VALUES ${values.join(", ")} RETURNING id`,
      params
    );
    res.status(201).json({ ok: true, query_ms: Number(ms.toFixed(1)), inserted: result.rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/reset", writeLimiter, auth.requireAuth, async (_req, res) => {
  try {
    const { rowCount } = await db.query("TRUNCATE notes RESTART IDENTITY");
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Boot ----------------------------------------------------------------
const server = app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  try {
    await db.init();
    console.log("Database ready (notes table ensured).");
    // Self-heal: resume any posts left 'pending' by a restart/redploy so they
    // don't stay stuck forever.
    const { rows } = await db.query("SELECT id FROM posts WHERE status = 'pending'");
    if (rows.length) {
      console.log(`Resuming ${rows.length} pending post(s).`);
      for (const r of rows) enrich.enqueue(r.id);
    }
  } catch (err) {
    console.warn(`Database not initialized yet: ${err.message}`);
  }
});

// Slowloris / resource-exhaustion defence: bound how long a request may take and
// how long idle connections linger. Legitimate requests here are short — AI
// enrichment runs out-of-band — so nothing needs more than a few seconds.
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 20_000;
