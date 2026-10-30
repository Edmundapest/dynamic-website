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

// Bootstraps the schema. Safe to call repeatedly; also performs additive
// "migrations" so older tables gain new columns.
async function init() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         SERIAL PRIMARY KEY,
      author     TEXT,
      body       TEXT NOT NULL,
      color      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Additive migrations for tables created by an earlier version.
  await getPool().query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS author TEXT`);
  await getPool().query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS color TEXT`);

  // The wall's posts. `card` holds the AI-generated JSON; `status` tracks the
  // async enrichment lifecycle so the client can show pending → ready/error.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      author     TEXT,
      body       TEXT,
      kind       TEXT NOT NULL DEFAULT 'text',
      url        TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      card       JSONB,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC)`
  );
  // Feedback (thumbs) and an optional poster-authored note, added additively.
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS votes_up INT NOT NULL DEFAULT 0`);
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS votes_down INT NOT NULL DEFAULT 0`);
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS user_note TEXT`);
  // Generated card images are stored out-of-band so the feed stays small.
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_data TEXT`);
  // Freeform, poster-supplied tags (lowercased) used for filtering.
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`);
  // Where the post came from ('web' or 'whatsapp'), the WhatsApp sender, and
  // the inbound message id (used to reply and to dedupe Meta's retries).
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'`);
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS wa_id TEXT`);
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS wa_message_id TEXT`);
  await getPool().query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS wa_replied_at TIMESTAMPTZ`);
  // NULLs are distinct in Postgres, so web posts don't collide.
  await getPool().query(
    `CREATE UNIQUE INDEX IF NOT EXISTS posts_wa_message_idx ON posts (wa_message_id)`
  );

  // One row per (post, voter): makes thumbs-up/down count each person once
  // instead of letting a single visitor spam the counter.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS post_votes (
      post_id    INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      voter_id   TEXT NOT NULL,
      value      SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, voter_id)
    )
  `);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS post_votes_post_idx ON post_votes (post_id)`
  );

  // Web Push subscriptions (one row per browser/device that enabled alerts).
  // `endpoint` is the unique push-service URL; keys authenticate the payload
  // encryption for that device. Rows are pruned when the service reports 404/410.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id           SERIAL PRIMARY KEY,
      endpoint     TEXT NOT NULL UNIQUE,
      p256dh       TEXT NOT NULL,
      auth         TEXT NOT NULL,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Runs a query and reports how long the database round-trip took, in ms.
// This is what powers the on-page "latency" meter.
async function timedQuery(text, params) {
  const start = process.hrtime.bigint();
  const result = await getPool().query(text, params);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms };
}

module.exports = { getPool, init, query, timedQuery };
