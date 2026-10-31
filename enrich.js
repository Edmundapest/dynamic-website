// Asynchronous post enrichment.
//
// Posting must return immediately (the AI call can take 10-30s, well past a
// proxy's patience). So POST inserts the row with status 'pending' and calls
// enqueue(id), which runs the heavy work detached from the request. The client
// polls GET /api/posts until the row flips to 'ready' (or 'error').
const db = require("./db");
const ai = require("./ai");
const { decodeEntities } = require("./search");

// Login walls and server-rendered JSON blobs read as "page text" but tell the
// model nothing. Instagram pages are exactly this (either "Log In Sign Up" or a
// few KB of ServerJS bbox data), and Xiaohongshu/Threads/X pages are nav
// boilerplate. Their real caption lives in og:description, which fetchPage
// already returns — so prefer that when the body looks like a wall.
const JUNK_TEXT =
  /never miss a post|(log ?in|sign ?up)[^\n]{0,120}(to continue|to see|to stay in the loop|to view)|\b__bbox\b|handlePayload|"require":\[\["|enable javascript to (view|continue)|创作中心|行吟信息科技/i;

function usableContent(page, snippet) {
  const text = String((page && page.text) || "");
  const desc = String((page && page.description) || "").trim();
  const snip = String(snippet || "").trim();
  if (!text || JUNK_TEXT.test(text.slice(0, 600))) {
    return decodeEntities([desc, snip].filter(Boolean).join("\n\n"));
  }
  return text;
}

// Normalize AI-produced tags (lowercase, keep [a-z0-9_-], dedupe, cap) so they
// match the format the API uses for poster tags.
function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (let t of arr) {
    t = String(t).trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]/g, "");
    if (!t) continue;
    if (t.length > 24) t = t.slice(0, 24);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

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

// Send the finished card back to the WhatsApp sender exactly once. We claim
// wa_replied_at first so a manual "Regenerate" can't spam the same chat.
async function maybeReplyWhatsApp(post, card) {
  if (!post || post.source !== "whatsapp" || !post.wa_id || post.wa_replied_at) return;

  // Never let a reply/DB hiccup turn a successfully enriched card into an
  // "error" post.
  try {
    const whatsapp = require("./whatsapp");
    if (!whatsapp.sendConfigured()) return;
    const { rows } = await db.query(
      `UPDATE posts SET wa_replied_at = now()
        WHERE id = $1 AND wa_replied_at IS NULL
        RETURNING id`,
      [post.id]
    );
    if (!rows.length) return;

    try {
      await whatsapp.sendCardReply(post, card);
    } catch (err) {
      // Release the claim so a later regenerate can retry the reply.
      await db.query("UPDATE posts SET wa_replied_at = NULL WHERE id = $1", [post.id]).catch(() => {});
      throw err;
    }
  } catch (err) {
    console.warn(`WhatsApp card reply failed for post ${post.id}: ${err.message}`);
  }
}

// Error replies aren't claimed: a later successful regenerate can still send
// the real card to the chat.
async function maybeReplyWhatsAppError(post, err) {
  if (!post || post.source !== "whatsapp" || !post.wa_id) return;
  try {
    const whatsapp = require("./whatsapp");
    if (!whatsapp.sendConfigured()) return;
    await whatsapp.sendErrorReply(post, err);
  } catch (e) {
    console.warn(`WhatsApp error reply failed for post ${post.id}: ${e.message}`);
  }
}

async function enrichPost(id) {
  const { rows } = await db.query(
    "SELECT id, kind, url, body, source, wa_id, wa_message_id, wa_replied_at FROM posts WHERE id = $1",
    [id]
  );
  const post = rows[0];
  if (!post) return;

  try {
    let context = post.body || "";
    let imageCandidates = [];
    let links = [];
    let sourceTitle = null;

    if (post.kind === "link" && post.url) {
      // Required lazily so this module loads even before fetchPage exists.
      const { fetchPage } = require("./fetchPage");
      const page = await fetchPage(post.url);
      imageCandidates.push(...(page.images || []));
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

        const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
        const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|linkedin\.com|tiktok\.com|pinterest\.com|youtube\.com|threads\.net|xiaohongshu\.com)$/i;

        // Prefer the social post: a reel or a RED note is usually what the
        // poster actually meant, and we now read their captions instead of the
        // login wall. Only skip it when its caption is too thin to work with.
        let target = results[0];
        for (const r of results) {
          if (!SOCIAL.test(host(r.url))) continue;
          if (String(r.snippet || "").trim().length >= 40 || results.length === 1) {
            target = r;
          }
          break;
        }

        try {
          const { fetchPage } = require("./fetchPage");
          const top = await fetchPage(target.url);
          // Instagram / Xiaohongshu return a login wall or JSON instead of the
          // post body; the caption in og:description is what we want there.
          const content = usableContent(top, target.snippet);
          if (content) {
            parts.push(`\nContent of the top result (${target.url}):\n${content.slice(0, 4000)}`);
          }
          sourceTitle = top.title || target.title;
          if (top.images) imageCandidates.push(...top.images);
        } catch {}
        if (results[0].image) imageCandidates.push(results[0].image);
        // Every result's own pictures, plus the query's image-search results.
        for (const r of results) {
          if (r.image) imageCandidates.push(r.image);
          if (Array.isArray(r.images)) imageCandidates.push(...r.images);
        }
        if (Array.isArray(results.images)) imageCandidates.push(...results.images);
      }

      // 2. Wikipedia background (reliable from cloud IPs) for concrete detail.
      //    Only full phrases are tried: a single common word ("studio",
      //    "happening") matches a Wikipedia article that has nothing to do with
      //    the note, which is worse than no background at all.
      try {
        const { findRelated } = require("./related");
        const words = post.body
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length >= 4)
          .slice(0, 6);
        const queries = [post.body.slice(0, 80)];
        if (words.length >= 2) queries.push(words.join(" "));
        const wiki = await findRelated(queries);
        if (wiki) {
          if (wiki.extract) {
            parts.push(`\nBackground (Wikipedia — ${wiki.title}):\n${String(wiki.extract || "").slice(0, 1500)}`);
          }
          if (wiki.image) imageCandidates.push(wiki.image);
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

    // Carousel: at least five pictures, from the page, the search results,
    // Wikipedia, and only then AI generation. Expiring links (Instagram,
    // Xiaohongshu) are downloaded and stored so the slides keep working.
    const { buildCarousel, displayUrls } = require("./images");
    const { buildImagePrompt, generateCardImage } = require("./imagegen");
    const imagePrompt = buildImagePrompt(card);
    const carousel = await buildCarousel({
      candidates: imageCandidates,
      need: 5,
      generate: (i) => generateCardImage(i ? `${imagePrompt} Variation ${i + 1}.` : imagePrompt),
    });

    // Wikipedia as a last top-up before generation already ran out of luck.
    let items = carousel.items;
    if (items.length < 5) {
      try {
        const { findRelated } = require("./related");
        const byLen = (card.keywords || []).slice().sort((a, b) => b.length - a.length);
        const related = await findRelated([
          card.title,
          (card.keywords || []).join(" "),
          byLen.join(" "),
          post.body,
        ]);
        if (related) {
          if (related.image) {
            const extra = await buildCarousel({
              candidates: [related.image],
              need: 5 - items.length,
            });
            items = items.concat(extra.items);
          }
          card.references = [...card.references, { url: related.url, title: related.title }].slice(0, 3);
        }
      } catch {}
    }

    const mapped = displayUrls(id, items);
    card.images = mapped.images;
    if (mapped.images.length < 5) {
      // Silent degradation is how a card ends up explaining performance art
      // instead of KL's weekend: make a thin deck visible in the logs.
      console.warn(
        `[carousel] post ${id} ended with ${mapped.images.length} slide(s) ` +
          `(${imageCandidates.length} candidate url(s) found)`
      );
    }
    const source = carousel.source === "none" && mapped.images.length ? "web" : carousel.source;
    if (source === "none") delete card.image_source;
    else card.image_source = source;
    if (carousel.generated || mapped.stored.length) {
      card.image_prompt = imagePrompt;
      await db.query("UPDATE posts SET images_data = $1 WHERE id = $2", [
        JSON.stringify(mapped.stored),
        id,
      ]);
    }

    // Merge the AI-generated tags into the post's tags (union with any the
    // poster supplied when writing).
    const aiTags = normalizeTags(card.tags);
    card.tags = aiTags;
    await db.query(
      `UPDATE posts
         SET card = $1, status = 'ready', error = NULL, updated_at = now(),
             tags = COALESCE(
               (SELECT array_agg(DISTINCT t) FROM unnest(tags || $3::text[]) AS t),
               '{}'
             )
       WHERE id = $2`,
      [card, id, aiTags]
    );

    await maybeReplyWhatsApp(post, card);
  } catch (err) {
    await db
      .query(
        `UPDATE posts SET status = 'error', error = $1, updated_at = now() WHERE id = $2`,
        [String(err.message || err).slice(0, 500), id]
      )
      .catch(() => {});
    await maybeReplyWhatsAppError(post, err);
  }
}

// Detached trigger: returns synchronously, work happens on the next tick.
function enqueue(id) {
  setImmediate(() => {
    enrichPost(id).catch((err) => console.error("enrich failed", id, err));
  });
}

module.exports = { enrichPost, enqueue };
