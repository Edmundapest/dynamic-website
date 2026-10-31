// The feed: one page at a time, filtered and ordered in SQL.
//
// A wall grows. The old endpoint returned the newest 100 and filtered in the
// browser, which meant everything older than that was effectively gone and a
// search only looked at what had already been downloaded. These routes page with
// a keyset cursor (page 40 costs the same as page 1) and do search / tag / month
// / sort over the whole wall, plus a facets route for the archive jump and the
// tag chips.
const db = require("./db");
const auth = require("./auth");

const FEED_COLUMNS =
  "id, author, body, kind, url, status, card, error, votes_up, votes_down, thread, tags, source, created_at, updated_at";

// Each sort needs a matching keyset clause; the cursor columns must mirror the
// ORDER BY exactly (with id as the final tie-breaker).
const SORTS = {
  new: { order: "created_at DESC, id DESC", cols: ["created_at", "id"], dir: "<" },
  old: { order: "created_at ASC, id ASC", cols: ["created_at", "id"], dir: ">" },
  up: { order: "votes_up DESC, created_at DESC, id DESC", cols: ["votes_up", "created_at", "id"], dir: "<" },
  down: { order: "votes_down DESC, created_at DESC, id DESC", cols: ["votes_down", "created_at", "id"], dir: "<" },
  top: {
    order: "(votes_up - votes_down) DESC, created_at DESC, id DESC",
    cols: ["score", "created_at", "id"],
    expr: "(votes_up - votes_down)",
    dir: "<",
  },
};

// Cursors travel as base64url JSON so they stay opaque in a URL.
function encodeCursor(parts) {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parts = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    return Array.isArray(parts) && parts.length >= 2 && parts.length <= 3 ? parts : null;
  } catch {
    return null;
  }
}

// WHERE clauses + params shared by the page query and the count query.
function buildFilters({ q, tag, month }) {
  const where = [];
  const params = [];

  if (tag) {
    params.push(tag);
    where.push(`tags @> ARRAY[$${params.length}]::text[]`);
  }
  if (month) {
    const [y, m] = month.split("-").map(Number);
    params.push(new Date(Date.UTC(y, m - 1, 1)).toISOString());
    params.push(new Date(Date.UTC(y, m, 1)).toISOString());
    where.push(`created_at >= $${params.length - 1} AND created_at < $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(
      `(body ILIKE ${p} OR author ILIKE ${p} OR tags::text ILIKE ${p}` +
        ` OR card->>'title' ILIKE ${p} OR card->>'summary' ILIKE ${p}` +
        ` OR card->>'keywords' ILIKE ${p} OR card->>'fun_facts' ILIKE ${p})`
    );
  }
  return { where: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

// Column list / values for the cursor of one row.
function cursorValues(spec, row) {
  return spec.cols.map((c) => {
    if (c === "created_at") return row.created_at;
    if (c === "id") return row.id;
    if (c === "votes_up") return row.votes_up;
    if (c === "votes_down") return row.votes_down;
    return row.votes_up - row.votes_down; // score
  });
}

function register(app, { cleanVoter }) {
  app.get("/api/posts", auth.requireAuth, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);
      const sort = SORTS[String(req.query.sort)] ? String(req.query.sort) : "new";
      const q = String(req.query.q || "").trim().slice(0, 120).replace(/[%_]/g, " ");
      const tag = String(req.query.tag || "").trim().toLowerCase().slice(0, 40);
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : "";
      const spec = SORTS[sort];
      const { where, params } = buildFilters({ q, tag, month });

      // Everything strictly after the last row of the previous page.
      let pageWhere = where;
      const pageParams = params.slice();
      const cursor = decodeCursor(req.query.before);
      if (cursor && cursor.length === spec.cols.length) {
        const placeholders = spec.cols.map((_, i) => `$${params.length + i + 1}`).join(", ");
        const cols = spec.cols.map((c) => (c === "score" ? spec.expr : c)).join(", ");
        const clause = `(${cols}) ${spec.dir} (${placeholders})`;
        pageWhere = where ? `${where} AND ${clause}` : `WHERE ${clause}`;
        pageParams.push(...cursor);
      }

      const [page, total] = await Promise.all([
        db.query(
          `SELECT ${FEED_COLUMNS} FROM posts ${pageWhere} ORDER BY ${spec.order} LIMIT ${limit + 1}`,
          pageParams
        ),
        db.query(`SELECT count(*)::int AS n FROM posts ${where}`, params),
      ]);

      const hasMore = page.rows.length > limit;
      const rows = hasMore ? page.rows.slice(0, limit) : page.rows;

      // The reader's own thumbs for this page, so the buttons render correctly.
      const voter = cleanVoter(req.get("x-voter-id"));
      const mine = new Map();
      if (voter && rows.length) {
        const { rows: votes } = await db.query(
          `SELECT post_id, value FROM post_votes WHERE voter_id = $1 AND post_id = ANY($2)`,
          [voter, rows.map((r) => r.id)]
        );
        for (const v of votes) mine.set(v.post_id, v.value);
      }
      for (const r of rows) r.my_vote = mine.get(r.id) || 0;

      const last = rows[rows.length - 1];
      res.json({
        ok: true,
        posts: rows,
        hasMore,
        nextBefore: hasMore && last ? encodeCursor(cursorValues(spec, last)) : null,
        total: total.rows[0].n,
        sort,
        limit,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Facets for the whole wall: months (archive jump) and tag counts.
  app.get("/api/facets", auth.requireAuth, async (_req, res) => {
    try {
      const [months, tags, total] = await Promise.all([
        db.query(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS key, count(*)::int AS count
             FROM posts GROUP BY 1 ORDER BY 1 DESC`
        ),
        db.query(
          `SELECT tg AS tag, count(*)::int AS count
             FROM posts, unnest(tags) AS tg
            GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 48`
        ),
        db.query("SELECT count(*)::int AS n FROM posts"),
      ]);
      res.json({ ok: true, months: months.rows, tags: tags.rows, total: total.rows[0].n });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { register };
