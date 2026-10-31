#!/usr/bin/env node
// Rebuild card carousels.
//
// Every ready card should show five distinct photos. This walks the wall,
// normalises each card's slides (keeping the ones already there, in order),
// drops duplicates — the same picture often arrives twice under a different
// URL, CDN host or size variant, and only a content hash catches that — and
// tops the deck back up to five from the page, the web search, Wikipedia and,
// last, AI generation.
//
// Stored slides are rewritten wholesale, so nothing is left orphaned in
// posts.images_data.
//
// Usage:
//   npm run backfill:images            # only cards that need it
//   npm run backfill:images -- --dry   # report, write nothing
//   npm run backfill:images -- --force # rebuild every card
//   npm run backfill:images -- --limit 5
require("../node_modules/dotenv").config();
const db = require("../db");
const {
  buildCarousel,
  cacheUrl,
  hashOf,
  dedupeKey,
  usable,
  isImageUrl,
} = require("../images");
const { webSearch } = require("../search");
const { fetchPage } = require("../fetchPage");
const { buildImagePrompt, generateCardImage } = require("../imagegen");

const NEED = 5;
const dry = process.argv.includes("--dry");
const force = process.argv.includes("--force");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;
const MAX_GENERATED = 40; // guard the free AI quota on a big wall

let generatedTotal = 0;

const OWN = /^\/api\/posts\/\d+\/img\/(\d+)$/;

// Does this card need work? Short decks, duplicate slides (by content hash or by
// URL identity) and junk placeholders all count.
function needsWork(existing, stored) {
  if (existing.length < NEED) return true;
  const hashes = new Set();
  const keys = new Set();
  for (const u of existing) {
    const own = OWN.exec(String(u));
    if (own) {
      const data = stored[Number(own[1])];
      if (!data) return true; // dangling index
      const h = hashOf(data);
      if (hashes.has(h)) return true;
      hashes.add(h);
      continue;
    }
    if (!String(u).startsWith("http")) return true;
    if (!usable(u)) return true;
    const k = dedupeKey(u);
    if (keys.has(k)) return true;
    keys.add(k);
  }
  return false;
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

// Rebuild one card's deck. Existing slides keep their order; anything that
// cannot be resolved is dropped in favour of a fresh candidate.
async function rebuild(post, card) {
  const stored = Array.isArray(post.images_data) ? post.images_data : [];
  const existing = Array.isArray(card.images) ? card.images : [];
  const items = [];
  const hashes = new Set();
  const keys = new Set();

  const addData = (data) => {
    if (!data) return false;
    const h = hashOf(data);
    if (hashes.has(h)) return false;
    hashes.add(h);
    items.push({ kind: "data", data });
    return true;
  };
  const addUrl = (url) => {
    if (!usable(url)) return false;
    const k = dedupeKey(url);
    if (keys.has(k)) return false;
    keys.add(k);
    items.push({ kind: "url", url });
    return true;
  };

  for (const u of existing) {
    if (items.length >= NEED) break;
    const own = OWN.exec(String(u));
    if (own) {
      addData(stored[Number(own[1])]);
      continue;
    }
    if (!String(u).startsWith("http") || !usable(u)) continue;
    // Store it, so an expiring/transform URL becomes a stable slide.
    const data = await cacheUrl(u);
    if (data) addData(data);
    else if (await isImageUrl(u)) addUrl(u);
  }

  let generated = 0;
  if (items.length < NEED) {
    const built = await buildCarousel({
      candidates: await candidatesFor(post, card),
      need: NEED - items.length,
      avoidHashes: hashes,
      generate: () => {
        if (generatedTotal >= MAX_GENERATED) return null;
        generated++;
        generatedTotal++;
        return generateCardImage(buildImagePrompt(card));
      },
    });
    for (const it of built.items) {
      if (it.kind === "data") addData(it.data);
      else addUrl(it.url);
    }
  }

  // Display list: stored slides become stable /img/:idx links.
  const data = [];
  const images = [];
  for (const it of items) {
    if (it.kind === "data") {
      images.push(`/api/posts/${post.id}/img/${data.length}`);
      data.push(it.data);
    } else {
      images.push(it.url);
    }
  }
  return { images, data, generated };
}

async function main() {
  await db.init();
  const { rows } = await db.query(
    `SELECT id, body, url, kind, card, images_data
       FROM posts WHERE status = 'ready' AND card IS NOT NULL
       ORDER BY id DESC${LIMIT ? " LIMIT " + LIMIT : ""}`
  );
  console.log(`${rows.length} ready post(s)${dry ? " (dry run)" : ""}${force ? " [force]" : ""}`);

  let changed = 0;
  for (const post of rows) {
    const card = post.card || {};
    const existing = Array.isArray(card.images) ? card.images : [];
    const stored = Array.isArray(post.images_data) ? post.images_data : [];
    if (!force && !needsWork(existing, stored)) continue;

    const out = await rebuild(post, card);
    const before = existing.length;
    const dupDropped = before - Math.min(before, out.images.length);
    console.log(
      `#${post.id} ${before} -> ${out.images.length} slides` +
        ` (stored ${out.data.length}, generated ${out.generated}` +
        (dupDropped > 0 ? `, removed ${dupDropped}` : "") +
        ")" +
        (out.images.length < NEED ? "  ⚠ still short" : "")
    );
    if (dry) continue;

    card.images = out.images;
    if (out.generated) card.image_source = "mixed";
    else if (!card.image_source) card.image_source = "web";
    await db.query(
      "UPDATE posts SET card = $1, images_data = $2, updated_at = now() WHERE id = $3",
      [card, JSON.stringify(out.data), post.id]
    );
    changed++;
  }
  console.log(dry ? "dry run: nothing written" : `updated ${changed} post(s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("backfill failed:", e);
  process.exit(1);
});
