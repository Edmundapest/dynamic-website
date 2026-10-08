// Dynamic website demo: Express + Postgres (Neon), deployable to Render.
// Loads .env locally; on Render the real environment variables are used.
require("dotenv").config();

const path = require("path");
const express = require("express");
const db = require("./db");

const app = express();
app.use(express.json({ limit: "16kb" }));
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
  } catch (err) {
    console.warn(`Database not initialized yet: ${err.message}`);
  }
});
