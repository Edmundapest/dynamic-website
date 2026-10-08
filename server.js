// Dynamic website demo: Express + Postgres (Neon), deployable to Render.
// Loads .env locally; on Render the real environment variables are used.
require("dotenv").config();

const path = require("path");
const express = require("express");
const db = require("./db");
const auth = require("./auth");
const enrich = require("./enrich");

const app = express();
app.use(express.json({ limit: "16kb" }));

// The current demo dashboard now lives at /dashboard; "/" is the wall page
// (served automatically by the static handler's index.html).
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
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

// --- Session auth (shared posting password) ------------------------------
app.post("/api/login", (req, res) => {
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

// --- Wall posts ----------------------------------------------------------
// Reads are public; writes require the shared password (requireAuth).

function detectUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

app.get("/api/posts", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, author, body, kind, url, status, card, error, votes_up, votes_down, user_note, created_at, updated_at
         FROM posts ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ ok: true, posts: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/posts", auth.requireAuth, async (req, res) => {
  const body = (req.body && req.body.body ? String(req.body.body) : "").trim();
  let author = (req.body && req.body.author ? String(req.body.author) : "").trim();
  if (author.length > 40) author = author.slice(0, 40);
  if (!body) return res.status(400).json({ ok: false, error: "post text is required" });
  if (body.length > 1000) return res.status(400).json({ ok: false, error: "post too long (max 1000)" });

  const url = detectUrl(body);
  const kind = url ? "link" : "text";
  try {
    const { rows } = await db.query(
      `INSERT INTO posts (author, body, kind, url, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, author, body, kind, url, status, created_at`,
      [author || null, body, kind, url]
    );
    enrich.enqueue(rows[0].id); // fire-and-forget; response returns immediately
    res.status(201).json({ ok: true, post: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/posts/:id/regenerate", auth.requireAuth, async (req, res) => {
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

app.delete("/api/posts/:id", auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try {
    const { rowCount } = await db.query("DELETE FROM posts WHERE id = $1", [id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public thumbs feedback — anyone viewing can rate; the votes steer future cards.
app.post("/api/posts/:id/vote", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const value = Number(req.body && req.body.value);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (value !== 1 && value !== -1) {
    return res.status(400).json({ ok: false, error: "value must be 1 or -1" });
  }
  try {
    const col = value === 1 ? "votes_up" : "votes_down"; // safe: fixed set
    const { rows } = await db.query(
      `UPDATE posts SET ${col} = ${col} + 1 WHERE id = $1 RETURNING votes_up, votes_down`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "post not found" });
    res.json({ ok: true, votes_up: rows[0].votes_up, votes_down: rows[0].votes_down });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Poster-authored note (auth-gated): one editable note per card.
app.post("/api/posts/:id/note", auth.requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const note = (req.body && req.body.note ? String(req.body.note) : "").trim();
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (note.length > 500) return res.status(400).json({ ok: false, error: "note too long (max 500)" });
  try {
    const { rows } = await db.query(
      `UPDATE posts SET user_note = $1, updated_at = now() WHERE id = $2 RETURNING user_note`,
      [note || null, id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "post not found" });
    res.json({ ok: true, user_note: rows[0].user_note });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Data API (every route here proves the database is live) -------------

// Aggregate stats: row count, engine version, round-trip timing.
app.get("/api/stats", async (_req, res) => {
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
app.get("/api/ping", async (_req, res) => {
  try {
    const { ms } = await db.timedQuery("SELECT 1");
    res.json({ ok: true, ms: Number(ms.toFixed(1)) });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/notes", async (_req, res) => {
  try {
    const { result, ms } = await db.timedQuery(
      "SELECT id, author, body, color, created_at FROM notes ORDER BY id DESC LIMIT 200"
    );
    res.json({ ok: true, query_ms: Number(ms.toFixed(1)), notes: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/notes", async (req, res) => {
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

app.delete("/api/notes/:id", async (req, res) => {
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
app.post("/api/seed", async (req, res) => {
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

app.post("/api/reset", async (_req, res) => {
  try {
    const { rowCount } = await db.query("TRUNCATE notes RESTART IDENTITY");
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Boot ----------------------------------------------------------------
app.listen(PORT, async () => {
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
