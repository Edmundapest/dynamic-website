// Daily Bing wallpaper.
//
// bing.gifposter.com mirrors Bing's "image of the day" and exposes the current
// photo in its Open Graph metadata (og:image), so we scrape that once, cache it
// in memory, and hand the URL to the browser. If the scrape fails we fall back
// to Bing's own public image archive API. No API key, no dependency.
//
// The URL is all the client needs: the image is hotlinkable and the page's CSP
// already allows https images. Caching keeps us from hitting the source on every
// page load while still picking up the new wallpaper shortly after it changes.
const PAGE = "https://bing.gifposter.com/";
const BING_API =
  "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 10_000;
const OK_TTL_MS = 30 * 60 * 1000; // re-check every 30 min
const FAIL_TTL_MS = 5 * 60 * 1000; // back off after a failure
const MAX_BYTES = 256 * 1024; // the page is small; cap it anyway

let cache = { at: 0, data: null };
let lastFail = 0;
let pending = null;

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Reads a <meta property|name="key" content="..."> value, in either attribute
// order (the gifposter page uses both).
function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(
    `<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`,
    "i"
  ).exec(html);
  if (a) return decodeEntities(a[1]).trim();
  const b = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`,
    "i"
  ).exec(html);
  return b ? decodeEntities(b[1]).trim() : "";
}

async function fetchText(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: accept || "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(Buffer.from(value));
      if (total >= MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

function validImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// Primary source: bing.gifposter.com's og:image is the current daily photo.
async function fromGifposter() {
  const html = await fetchText(PAGE);
  const url = validImageUrl(meta(html, "og:image"));
  if (!url) throw new Error("no og:image on bing.gifposter.com");
  return {
    url,
    title: meta(html, "og:title") || "Bing image of the day",
    description: meta(html, "og:description") || "",
    copyright: "",
    page: PAGE,
    source: "bing.gifposter.com",
  };
}

// Fallback: Bing's public image archive API.
async function fromBing() {
  const raw = await fetchText(BING_API, "application/json");
  const data = JSON.parse(raw);
  const img = data && Array.isArray(data.images) ? data.images[0] : null;
  if (!img) throw new Error("no image in Bing archive response");
  // `url` is already the full 1920x1080 path; `urlbase` is the fallback shape.
  const path = img.url || (img.urlbase ? `${img.urlbase}_1920x1080.jpg` : null);
  const url = validImageUrl(path ? `https://www.bing.com${path}` : "");
  if (!url) throw new Error("invalid Bing image URL");
  return {
    url,
    title: img.title || "Bing image of the day",
    description: img.copyright || "",
    copyright: img.copyright || "",
    page: "https://www.bing.com/",
    source: "bing.com",
  };
}

// Returns { url, title, description, copyright, page, source, date, fetchedAt }.
// Cached for OK_TTL_MS; on failure the last good value is served as stale.
async function getWallpaper() {
  const now = Date.now();
  if (cache.data && now - cache.at < OK_TTL_MS) return cache.data;

  if (now - lastFail < FAIL_TTL_MS) {
    if (cache.data) return cache.data;
    throw new Error("wallpaper temporarily unavailable");
  }
  if (pending) return pending;

  pending = (async () => {
    try {
      let data;
      try {
        data = await fromGifposter();
      } catch (err) {
        console.warn(`wallpaper: gifposter failed (${err.message}), trying Bing`);
        data = await fromBing();
      }
      data.date = new Date().toISOString().slice(0, 10);
      data.fetchedAt = new Date().toISOString();
      cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      lastFail = Date.now();
      if (cache.data) return cache.data; // stale beats nothing
      throw err;
    } finally {
      pending = null;
    }
  })();

  return pending;
}

module.exports = { getWallpaper, fromGifposter, fromBing, meta, decodeEntities };
