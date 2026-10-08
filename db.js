// Postgres connection for Neon (or any Postgres).
//
// Neon requires TLS, so ssl.rejectUnauthorized is set to false. We use the
// POOLED connection string from Neon (the one containing "-pooler") because
// serverless-style apps open many short-lived connections.
//
// The pool is created lazily so the web server can boot even if DATABASE_URL
// is not set yet (e.g. right after `git push`, before you add the env var).
const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy the connection string from your Neon " +
        "project into the environment (see .env.example)."
    );
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    // Keep the footprint small on a free tier.
    max: 5,
    idleTimeoutMillis: 30_000,
  });

  return pool;
}

// Creates the demo table if it does not exist. Safe to call repeatedly.
async function init() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         SERIAL PRIMARY KEY,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, init, query };
