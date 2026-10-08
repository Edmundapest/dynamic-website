// Asynchronous post enrichment.
//
// Posting must return immediately (the AI call can take 10-30s, well past a
// proxy's patience). So POST inserts the row with status 'pending' and calls
// enqueue(id), which runs the heavy work detached from the request. The client
// polls GET /api/posts until the row flips to 'ready' (or 'error').
const db = require("./db");
const ai = require("./ai");

async function enrichPost(id) {
  const { rows } = await db.query(
    "SELECT id, kind, url, body FROM posts WHERE id = $1",
    [id]
  );
  const post = rows[0];
  if (!post) return;

  try {
    let context = post.body || "";
    let images = [];
    let sourceTitle = null;

    if (post.kind === "link" && post.url) {
      // Required lazily so this module loads even before fetchPage exists.
      const { fetchPage } = require("./fetchPage");
      const page = await fetchPage(post.url);
      images = page.images || [];
      sourceTitle = page.title || null;
      context = [
        `URL: ${post.url}`,
        `Page title: ${page.title || "(none)"}`,
        page.description ? `Description: ${page.description}` : "",
        post.body ? `Poster's note: ${post.body}` : "",
        "",
        "Page text:",
        page.text || "(no readable text)",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const card = await ai.buildCard(context);
    // Carry the page's images + source through to the stored card so the wall
    // can show real pictures (or fall back to a styled banner for text posts).
    card.images = images;
    card.source_url = post.url || null;
    card.source_title = sourceTitle;

    await db.query(
      `UPDATE posts
         SET card = $1, status = 'ready', error = NULL, updated_at = now()
       WHERE id = $2`,
      [card, id]
    );
  } catch (err) {
    await db
      .query(
        `UPDATE posts SET status = 'error', error = $1, updated_at = now() WHERE id = $2`,
        [String(err.message || err).slice(0, 500), id]
      )
      .catch(() => {});
  }
}

// Detached trigger: returns synchronously, work happens on the next tick.
function enqueue(id) {
  setImmediate(() => {
    enrichPost(id).catch((err) => console.error("enrich failed", id, err));
  });
}

module.exports = { enrichPost, enqueue };
