// Dynamic website starter: Express + Postgres (Neon), deployable to Render.
// Loads .env locally; on Render the real environment variables are used.
require("dotenv").config();

const express = require("express");
const db = require("./db");

const app = express();
app.use(express.json());

// Render sets PORT for you; 3000 is the local default.
const PORT = process.env.PORT || 3000;

// --- Routes that never touch the database -------------------------------
// Used by Render's health check and for a fast plain "is it up?" probe.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- Static-ish landing page --------------------------------------------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Dynamic Website</title></head>
  <body style="font-family: system-ui; max-width: 640px; margin: 3rem auto">
    <h1>It works 🎉</h1>
    <p>Express is running. Database routes live under <code>/api/notes</code>.</p>
    <p><a href="/api/db-health">Check database connection</a></p>
  </body>
</html>`);
});

// --- Database-backed routes ---------------------------------------------
app.get("/api/db-health", async (_req, res) => {
  try {
    const { rows } = await db.query("SELECT now() AS now");
    res.json({ ok: true, db_time: rows[0].now });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/notes", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 100"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notes", async (req, res) => {
  const body = (req.body && req.body.body ? String(req.body.body) : "").trim();
  if (!body) return res.status(400).json({ error: "body is required" });
  try {
    const { rows } = await db.query(
      "INSERT INTO notes (body) VALUES ($1) RETURNING id, body, created_at",
      [body]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Boot ----------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // Best-effort schema setup; don't crash the server if the DB isn't ready.
  try {
    await db.init();
    console.log("Database ready (notes table ensured).");
  } catch (err) {
    console.warn(`Database not initialized yet: ${err.message}`);
  }
});
