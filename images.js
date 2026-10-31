// Card carousel images.
//
// Every card shows a carousel of at least five pictures. Sources, in order of
// preference:
//   1. the images on the page the post links to (og:image + inline <img>)
//   2. images returned by the web search (Tavily ships a per-result `images`
//      array plus a top-level image list)
//   3. Wikipedia/Wikimedia, for text notes
//   4. AI generation (Cloudflare Workers AI), strictly as the last resort
//
// Not every URL survives: Instagram's CDN links carry a signed `oe=` expiry
// (a few days) and Xiaohongshu's photo links 404 within minutes. Those are
// downloaded right away, re-encoded and stored in the database, then served from
// /api/posts/:id/img/:idx. When `sharp` is available everything is stored that
// way (rows stay ~60-120 KB per image); without it only the expiring hosts are,
// so a missing native module can never break a card.
const CACHE_MS = 12_000;const MAX_BYTES = 4 * 1024 * 1024; // refuse absurd downloads
const STORE_MAX_BYTES = 700 * 1024; // keep each stored image small
const MIN_BYTES = 6 * 1024; // anything smaller is a pixel/icon, not a photo
const MAX_WIDTH = 1024;
const QUALITY = 68;
const TARGET = 5; // "at least five images"

const UA = "wall-bot/1.0 (+https://dynamic-website-urt2.onrender.com)";
const crypto = require("node:crypto");

// Stable identity for a stored slide. Two URLs that serve the same picture end
// up byte-identical after re-encoding, which is the only reliable way to catch
// duplicates across CDNs, proxies and size variants.
function hashOf(dataUri) {
  return crypto.createHash("sha1").update(String(dataUri)).digest("hex");
}

// Image hosts whose URLs expire (signed) or that refuse to be hotlinked.
const EXPIRING =
  /(^|\.)(cdninstagram\.com|fbcdn\.net|xhscdn\.com|twimg\.com|licdn\.com|tiktokcdn[\w.-]*\.com|ggpht\.com|googleusercontent\.com|sndcdn\.com|media\.giphy\.com)$/i;

// Platform chrome we never want in a carousel (mirrors fetchPage's filter).
// `blur_N` is the lazy-load placeholder Wix and others serve before the real
// picture arrives.
const JUNK =
  /(^|\/)(logo|logos|wordmark|icon|icons|favicon|sprite|sprites|badge|placeholder|avatar|spinner|loader)[/_ .-]|picasso-static\.|\/fe-platform\/|maps\.wikimedia\.org|blur_\d|scorecardresearch|doubleclick|googletagmanager|google-analytics|hotjar|ui-avatars|gravatar|\/pixel\.(gif|png)|\/1x1\.|\.svg($|\?)/i;

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  // Optional: without it we store only the images that must be stored.
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isExpiring(url) {
  const h = hostOf(url);
  return !!h && EXPIRING.test(h);
}

// The URL to try for one candidate. Two shapes are worth normalising:
//  - Wikimedia only serves a few pre-rendered widths (250 / 500 / 1280 px) and
//    inline article images are usually the 250px one — ask for the 500px one.
//  - Wix-style /*.w_N,h_N,... transforms request the original (sometimes 12000px
//    wide, tens of MB). Ask the CDN for a carousel-sized rendition instead.
function variants(url) {
  const wm = /^(https?:\/\/[\w.-]*wikimedia\.org\/.*\/thumb\/[^?#]*?)\/(\d{1,4})px-([^/?#]+)([?#].*)?$/i.exec(url);
  if (wm) {
    if (Number(wm[2]) >= 500) return [url]; // already big enough
    return [`${wm[1]}/500px-${wm[3]}`, url];
  }
  const wx = /([/?&])w_(\d{3,5}),h_(\d{3,5}),/.exec(url);
  if (wx && Math.max(Number(wx[2]), Number(wx[3])) > 2000) {
    return [url.replace(wx[0], `${wx[1]}w_1200,h_900,`)];
  }
  return [url];
}

function tooSmallThumb(url) {
  // e.g. Instagram "..._s150x150_tt6" / "dst-jpg_s150x150" / "p320x320"
  const m = /[?_&]s(\d{2,3})x(\d{2,3})/.exec(url) || /_s(\d{2,3})x(\d{2,3})\b/.exec(url);
  if (m && Math.max(Number(m[1]), Number(m[2])) <= 320) return true;
  // Wikimedia thumbnails narrower than 200px cannot be upgraded reliably.
  const w = /\/thumb\/[^?#]*?\/(\d{1,4})px-[^/?#]*([?#]|$)/i.exec(url);
  if (w && Number(w[1]) < 200) return true;
  return false;
}

function usable(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (JUNK.test(u)) return false;
  if (tooSmallThumb(u)) return false;
  return true;
}

// Fast content-type probe. Some CDNs reject HEAD, so fall back to a ranged GET.
async function isImageUrl(url) {
  if (!usable(url)) return false;
  const tryFetch = async (init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CACHE_MS);
    try {
      const res = await fetch(url, {
        ...init,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8", ...(init.headers || {}) },
      });
      const type = (res.headers.get("content-type") || "").toLowerCase();
      const ok = res.ok && type.startsWith("image/");
      if (res.body) await res.body.cancel().catch(() => {});
      return ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (await tryFetch({ method: "HEAD" })) return true;
  return tryFetch({ method: "GET", headers: { Range: "bytes=0-2048" } });
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CACHE_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" },
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("image/")) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) {
      if (res.body) await res.body.cancel().catch(() => {});
      // Tell the caller it is a real image, just far too heavy to serve.
      return { big: true };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, type: type.split(";")[0].trim() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Re-encode to a small JPEG so a row stays cheap, and give every stored image a
// real image/* MIME type (Cloudflare hands us bare base64, Instagram hands us
// URLs that expire).
async function toStoredDataUri(image) {
  const { buf, type } = image;
  if (sharp) {
    try {
      const out = await sharp(buf)
        .rotate()
        .resize({ width: MAX_WIDTH, height: MAX_WIDTH, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: QUALITY, progressive: true })
        .toBuffer();
      if (out.length && out.length <= STORE_MAX_BYTES) {
        return `data:image/jpeg;base64,${out.toString("base64")}`;
      }
    } catch {
      // fall through to the raw bytes
    }
  }
  if (buf.length > STORE_MAX_BYTES) return null;
  const safeType = /^image\/[a-z0-9.+-]+$/i.test(type) ? type : "image/jpeg";
  return `data:${safeType};base64,${buf.toString("base64")}`;
}

// An AI-generated image is returned as a data URI already; treat the same way.
async function normalizeDataUri(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(uri || ""));
  if (!m) return null;
  return toStoredDataUri({ buf: Buffer.from(m[2], "base64"), type: m[1].toLowerCase() });
}

// Query parameters that only pick a rendition or a cache-buster; dropping them
// lets the same asset found twice collapse into one candidate.
const VOLATILE_PARAM = /^(w|h|width|height|q|quality|fit|crop|auto|fm|format|dpr|rs|resize|size|v|ver|version|ixlib|tr|sig|token|expires|impolicy|oe|oh|stp|ccb|efg|_nc_.*)$/i;

function dedupeKey(url) {
  let raw = String(url).trim();
  try {
    const u = new URL(raw);
    // Same picture, different CDN node / mirror host.
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    host = host.replace(/^scontent[\w.-]*\.(cdninstagram\.com|fbcdn\.net)$/, "$1");
    host = host.replace(/^[\w-]+\.xhscdn\.com$/, "xhscdn.com");
    host = host.replace(/^thumb\.wikimedia\.org$/, "wikimedia.org");
    host = host.replace(/^upload\.wikimedia\.org$/, "wikimedia.org");
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !VOLATILE_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    // Wix (and friends) serve one picture through many transform URLs: keep the
    // media id, drop the /v1/... rendition tail.
    let path = u.pathname.toLowerCase();
    const v = path.indexOf("/v1/");
    if (v > 0) path = path.slice(0, v);
    // Wikimedia thumbnails are the same file at different widths.
    path = path.replace(/\/\d{1,4}px-/, "/");
    return `${host}${path}${keep ? "?" + keep : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

function dedupe(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const u = String(raw || "").trim();
    if (!usable(u)) continue;
    const key = dedupeKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

function collect(...lists) {
  return dedupe([].concat(...lists.filter(Boolean).map((l) => (Array.isArray(l) ? l : [l]))));
}

// Turns candidate URLs into carousel items, downloading and storing what must be
// stored and topping up with generated art when there is not enough. Returns:
//   { items: [{ kind: "data", data } | { kind: "url", url }], source }
// `need` caps how many we resolve; the caller turns `data` items into
// /api/posts/:id/img/:i URLs.
async function buildCarousel({ candidates, need = TARGET, generate, avoidHashes } = {}) {
  const urls = collect(candidates).slice(0, Math.max(need * 6, 12));
  const items = [];
  const seen = new Set(avoidHashes || []); // slides the card already shows
  let attempted = 0;
  let generated = 0;

  for (const url of urls) {
    if (items.length >= need) break;
    if (attempted >= need * 8) break; // don't scan forever on a dead page
    attempted++;

    // Wikimedia only serves a few pre-rendered widths (250 / 500 / 1280 px), and
    // inline article images are usually the 250px one. Try a nicer size first;
    // if that bucket does not exist we fall back to the URL as written.
    candidates: for (const candidate of variants(url)) {
      const expiring = isExpiring(candidate);
      let stored = null;
      if (expiring || sharp) {
        const bytes = await fetchBytes(candidate);
        // A real but oversized image is no good either: the browser would have
        // to download it in full, so move on instead of falling back to the URL.
        if (bytes && bytes.big) break candidates;
        if (bytes && bytes.buf.length < MIN_BYTES) break candidates; // pixel/icon
        if (bytes) stored = await toStoredDataUri(bytes);
      }
      if (stored) {
        const h = hashOf(stored);
        if (seen.has(h)) break candidates; // same picture, already in the deck
        seen.add(h);
      } else {
        // A raw scontent.cdninstagram.com / xhscdn.com link dies within days (or
        // minutes), so it must never end up in a card.
        if (expiring) continue;
        if (!(await isImageUrl(candidate))) continue;
      }
      items.push(stored ? { kind: "data", data: stored } : { kind: "url", url: candidate });
      break;
    }
  }

  // Last resort: generate the shortfall so the carousel always has five slides.
  const shortfall = need - items.length;
  if (shortfall > 0 && typeof generate === "function") {
    for (let i = 0; i < shortfall; i++) {
      let made = null;
      try {
        made = await generate(i);
      } catch {
        made = null;
      }
      const data = made ? await normalizeDataUri(made) : null;
      if (!data) break; // provider unavailable/rate-limited: keep what we have
      const h = hashOf(data);
      if (seen.has(h)) continue;
      seen.add(h);
      items.push({ kind: "data", data });
      generated++;
    }
  }

  const source = !items.length
    ? "none"
    : generated === items.length
      ? "ai"
      : generated
        ? "mixed"
        : "web";
  return { items, source, generated, stored: items.filter((i) => i.kind === "data").length };
}

// Display URLs for the card. Stored images are referenced by index into
// images_data; remote ones keep their own URL. `offset` is how many images the
// row already stores (appending to an existing carousel).
function displayUrls(postId, items, offset = 0) {
  const stored = [];
  const images = [];
  for (const item of items) {
    if (item.kind === "data") {
      images.push(`/api/posts/${postId}/img/${offset + stored.length}`);
      stored.push(item.data);
    } else {
      images.push(item.url);
    }
  }
  return { images, stored };
}

// Download one URL and return it in storable form (or null when it is dead,
// tiny, or too heavy). Used by the backfill to normalise existing slides.
async function cacheUrl(url) {
  for (const candidate of variants(url)) {
    const bytes = await fetchBytes(candidate);
    if (bytes && bytes.big) return null;
    if (!bytes) continue;
    if (bytes.buf.length < MIN_BYTES) return null;
    return toStoredDataUri(bytes);
  }
  return null;
}

module.exports = {
  buildCarousel,
  displayUrls,
  collect,
  cacheUrl,
  hashOf,
  dedupeKey,
  usable,
  isImageUrl,
  isExpiring,
  preferred: (url) => variants(url)[0],
  TARGET,
};
