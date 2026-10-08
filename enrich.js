// Asynchronous post enrichment.
//
// Posting must return immediately (the AI call can take 10-30s, well past a
// proxy's patience). So POST inserts the row with status 'pending' and calls
// enqueue(id), which runs the heavy work detached from the request. The client
// polls GET /api/posts until the row flips to 'ready' (or 'error').
const db = require("./db");
const ai = require("./ai");

// Turns reader thumbs into an extra system message so the model drifts toward
// what people liked and away from what they didn't.
async function buildFeedbackGuidance() {
  try {
    const liked = await db.query(
      `SELECT card->>'title' AS title FROM posts
        WHERE status = 'ready' AND card IS NOT NULL AND votes_up > votes_down
        ORDER BY (votes_up - votes_down) DESC, votes_up DESC LIMIT 3`
    );
    const disliked = await db.query(
      `SELECT card->>'title' AS title FROM posts
        WHERE status = 'ready' AND card IS NOT NULL AND votes_down > votes_up
        ORDER BY (votes_down - votes_up) DESC LIMIT 3`
    );
    const list = (rows) =>
      rows.map((r) => r.title).filter(Boolean).map((t) => `- ${t}`).join("\n");
    const l = list(liked.rows);
    const d = list(disliked.rows);
    if (!l && !d) return "";
    return [
      "Reader feedback on earlier cards — adapt to what people like:",
      l ? `LIKED (match this style/tone):\n${l}` : "",
      d ? `DISLIKED (avoid this style/tone):\n${d}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

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
    let links = [];
    let sourceTitle = null;

    if (post.kind === "link" && post.url) {
      // Required lazily so this module loads even before fetchPage exists.
      const { fetchPage } = require("./fetchPage");
      const page = await fetchPage(post.url);
      images = page.images || [];
      links = page.links || [];
      sourceTitle = page.title || null;
      const linkList = links.slice(0, 25).map((l) => `- ${l.title} :: ${l.url}`).join("\n");
      context = [
        `URL: ${post.url}`,
        `Page title: ${page.title || "(none)"}`,
        page.description ? `Description: ${page.description}` : "",
        post.body ? `Poster's note: ${post.body}` : "",
        "",
        "Page text:",
        page.text || "(no readable text)",
        linkList ? `\nLinks found on the page:\n${linkList}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    } else if (post.body) {
      const parts = [`Poster's note: ${post.body}`];

      // 1. Web search (best-effort — DuckDuckGo blocks many datacenter IPs, so
      //    this may be empty on a cloud host but works from residential IPs).
      let results = [];
      try {
        const { webSearch } = require("./search");
        results = await webSearch(post.body.slice(0, 200), 6);
      } catch {}
      if (results.length) {
        links = results.map((r) => ({ url: r.url, title: r.title }));
        parts.push(
          "",
          "Web search results (use these for real, specific details):",
          results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
        );
        try {
          const { fetchPage } = require("./fetchPage");
          const top = await fetchPage(results[0].url);
          if (top.text) {
            parts.push(`\nContent of the top result (${results[0].url}):\n${top.text.slice(0, 4000)}`);
          }
          sourceTitle = top.title || results[0].title;
        } catch {}
      }

      // 2. Wikipedia background (reliable from cloud IPs) for concrete detail.
      try {
        const { findRelated } = require("./related");
        const words = post.body
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length >= 4)
          .slice(0, 6);
        const wiki = await findRelated([post.body.slice(0, 80), ...words]);
        if (wiki) {
          parts.push(`\nBackground (Wikipedia — ${wiki.title}):\n${String(wiki.extract || "").slice(0, 1500)}`);
          if (!links.some((l) => l.url === wiki.url)) links.push({ url: wiki.url, title: wiki.title });
        }
      } catch {}

      if (links.length) {
        parts.push(`\nLinks found on the page:\n${links.map((l) => `- ${l.title} :: ${l.url}`).join("\n")}`);
      }
      context = parts.filter(Boolean).join("\n");
    }

    // Learn from reader thumbs: earlier liked/disliked cards shape this one.
    const guidance = await buildFeedbackGuidance();
    const card = await ai.buildCard(context, guidance);
    // Carry the page's real images + source through to the stored card.
    card.images = images;
    card.source_url = post.url || null;
    card.source_title = sourceTitle;

    // Keep only reference links that really exist on the fetched page (prevents
    // the model from inventing URLs).
    const norm = (u) => String(u).replace(/\/+$/, "");
    const byUrl = new Map(links.map((l) => [norm(l.url), l]));
    const srcUrl = norm(post.url || "");
    card.references = (card.references || [])
      .map((u) => byUrl.get(norm(u)))
      .filter((l) => l && norm(l.url) !== srcUrl)
      .slice(0, 3)
      .map((l) => ({ url: l.url, title: l.title }));

    // No real picture (text note, or a link without images)? Generate one from
    // the text prompt, and attach a related article as a resource link.
    if (!card.images || card.images.length === 0) {
      const { buildImagePrompt, generateCardImage } = require("./imagegen");
      card.image_prompt = buildImagePrompt(card);

      // Prefer a generated image; fall back to a related public photo.
      const generated = await generateCardImage(card.image_prompt);
      if (generated) {
        if (generated.startsWith("data:")) {
          // Store the large image out-of-band and reference it by URL so the
          // feed payload stays small.
          await db.query("UPDATE posts SET image_data = $1 WHERE id = $2", [generated, id]);
          card.images = [`/api/posts/${id}/image`];
        } else {
          card.images = [generated];
        }
        card.image_source = "ai";
      } else {
        const { findRelated } = require("./related");
        const byLen = (card.keywords || []).slice().sort((a, b) => b.length - a.length);
        const related = await findRelated([
          card.title,
          (card.keywords || []).join(" "),
          ...byLen,
          post.body,
        ]);
        if (related) {
          if (related.image) {
            card.images = [related.image];
            card.image_source = "related";
          }
          card.references = [
            ...card.references,
            { url: related.url, title: related.title },
          ].slice(0, 3);
        }
      }
    }

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
