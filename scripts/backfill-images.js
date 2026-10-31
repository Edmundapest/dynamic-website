#!/usr/bin/env node
// Backfill card carousels.
//
// Cards created before carousels existed have one image (or none, or a dead
// hotlink). This tops every ready post up to five slides, keeping the pictures
// it already shows and only adding new ones. Expiring sources (Instagram,
// Xiaohongshu) are downloaded and stored, exactly like a fresh post.
//
// Usage:
//   npm run backfill:images            # fix every ready post
//   npm run backfill:images -- --dry   # report what would change, write nothing
//   npm run backfill:images -- --limit 5
require("../node_modules/dotenv").config();
const db = require("../db");
const { buildCarousel, displayUrls, isImageUrl } = require("../images");
const { webSearch } = require("../search");
const { fetchPage } = require("../fetchPage");
const { buildImagePrompt, generateCardImage } = require("../imagegen");

const NEED = 5;
const dry = process.argv.includes("--dry");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;
const MAX_GENERATED = 40; // guard the free AI quota on a big wall

let generated = 0;

// Keep the pictures the card already shows, but drop references that no longer
// resolve (dead hotlinks, or image rows we never stored).
async function keepExisting(card, stored) {
  const out = [];
  for (const u of Array.isArray(card.images) ? card.images : []) {
    if (out.length >= NEED) break;
    const own = /^\/api\/posts\/\d+\/img\/(\d+)$/.exec(String(u));
    if (own) {
      if (Number(own[1]) < stored.length) out.push({ kind: "own", url: u });
      continue;
    }
    if (String(u).startsWith("/api/posts/")) continue; // legacy generated image
    if (await isImageUrl(u)) out.push({ kind: "own", url: u });
  }
  return out;
}

async function candidatesFor(post, card) {
  const list = [];
  if (post.url) {
    try {
      const page = await fetchPage(post.url);
      list.push(...(page.images || []));
    } catch {}
  }
  const q = String(card.title || post.body || "").slice(0, 160).trim();
  if (q) {
    try {
      const results = await webSearch(q, 4);
      for (const r of results) {
        if (r.image) list.push(r.image);
        if (Array.isArray(r.images)) list.push(...r.images);
      }
      if (Array.isArray(results.images)) list.push(...results.images);
    } catch {}
  }
  // Event posts (concerts, festivals) are image-poor; Wikipedia is not.
  try {
    const { findRelated } = require("../related");
    const rel = await findRelated([
      card.title,
      ...(Array.isArray(card.keywords) ? card.keywords : []),
      post.body,
    ]);
    if (rel && rel.image) list.push(rel.image);
  } catch {}
  return list;
}

async function main() {
  await db.init();
  const { rows } = await db.query(
    `SELECT id, body, url, kind, card, images_data
       FROM posts WHERE status = 'ready' AND card IS NOT NULL
       ORDER BY id DESC${LIMIT ? " LIMIT " + LIMIT : ""}`
  );
  console.log(`${rows.length} ready post(s)${dry ? " (dry run)" : ""}`);

  let changed = 0;
  for (const post of rows) {
    const card = post.card || {};
    const stored = Array.isArray(post.images_data) ? post.images_data : [];
    const existing = Array.isArray(card.images) ? card.images : [];
    if (existing.length >= NEED) continue;

    const keep = await keepExisting(card, stored);
    const need = NEED - keep.length;
    const candidates = await candidatesFor(post, card);
    const built = await buildCarousel({
      candidates,
      need,
      generate: () =>
        generated < MAX_GENERATED
          ? (generated++, generateCardImage(buildImagePrompt(card)))
          : null,
    });

    // New stored images are appended after the ones already in the row, so the
    // /api/posts/:id/img/:index links the card already holds stay valid.
    const offset = stored.length;
    const mapped = displayUrls(post.id, built.items, offset);
    const display = keep.map((k) => k.url).concat(mapped.images);
    const newStored = stored.concat(mapped.stored);

    console.log(
      `#${post.id} ${keep.length} -> ${display.length} slides` +
        ` (+${mapped.stored.length} stored, ${built.generated} generated)` +
        (display.length < NEED ? "  ⚠ still short" : "")
    );
    if (dry) continue;

    card.images = display;
    if (mapped.stored.length) card.image_source = built.generated ? "mixed" : card.image_source || "web";
    if (newStored.length) {
      await db.query("UPDATE posts SET images_data = $1 WHERE id = $2", [
        JSON.stringify(newStored),
        post.id,
      ]);
    }
    await db.query("UPDATE posts SET card = $1, updated_at = now() WHERE id = $2", [card, post.id]);
    changed++;
  }
  console.log(dry ? "dry run: nothing written" : `updated ${changed} post(s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("backfill failed:", e);
  process.exit(1);
});
