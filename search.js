// Free web search via DuckDuckGo Lite (no API key).
//
// DDG's Instant-Answer API and html.duckduckgo.com are blocked for server-side
// requests, but lite.duckduckgo.com/lite/ returns real results. Datacenter IPs
// (e.g. Render) are challenged intermittently, so we retry once; when it still
// returns nothing the caller falls back to Wikipedia. It works reliably from a
// residential IP (local dev).
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const TIMEOUT_MS = 10_000;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const clean = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Fetch the Lite results HTML (best-effort; null on failure).
async function fetchHtml(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parse(html, limit) {
  const links = [
    ...html.matchAll(
      /<a[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)[^"]*"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/gi
    ),
  ];
  const snippets = [
    ...html.matchAll(/<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi),
  ];

  const results = [];
  for (let i = 0; i < links.length && results.length < limit; i++) {
    let url;
    try {
      url = decodeURIComponent(links[i][1]);
    } catch {
      continue;
    }
    const title = clean(links[i][2]);
    const snippet = snippets[i] ? clean(snippets[i][1]) : "";
    if (!title || !/^https?:\/\//i.test(url)) continue;
    // Skip sponsored/ad results (they redirect through duckduckgo.com/y.js).
    if (/duckduckgo\.com\/y\.js|ad_domain=|ad_provider=/.test(url)) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

async function webSearch(query, limit = 6) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const html = await fetchHtml(q);
    if (html) {
      const results = parse(html, limit);
      if (results.length) return results;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  return [];
}

module.exports = { webSearch, decodeEntities };
