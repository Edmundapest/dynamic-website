// Web search for text notes.
//
// Provider order:
//   1. Tavily (if TAVILY_API_KEY is set) — reliable from any host, free tier
//      (1,000 searches/month). Also returns image URLs we can use on cards.
//   2. DuckDuckGo Lite (key-less fallback). Real results, but datacenter IPs
//      (e.g. Render) are challenged intermittently and often return nothing;
//      works reliably from a residential IP (local dev).
const TIMEOUT_MS = 10_000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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

// --- Tavily ---------------------------------------------------------------
async function tavilySearch(query, limit) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        include_images: true,
        include_answer: false,
      }),
    });
    if (!res.ok) {
      console.warn("tavily HTTP", res.status);
      return null;
    }
    const d = await res.json();
    const results = (Array.isArray(d.results) ? d.results : [])
      .map((r) => ({
        title: String(r.title || "").trim(),
        url: String(r.url || ""),
        snippet: String(r.content || "").trim(),
      }))
      .filter((r) => r.title && /^https?:\/\//i.test(r.url));
    const images = Array.isArray(d.images) ? d.images.filter((u) => typeof u === "string") : [];
    if (images.length && results.length) results[0].image = images[0];
    return results;
  } catch (err) {
    console.warn("tavily error:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- DuckDuckGo Lite (key-less fallback) ----------------------------------
async function ddgFetchHtml(query) {
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

function ddgParse(html, limit) {
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
    if (/duckduckgo\.com\/y\.js|ad_domain=|ad_provider=/.test(url)) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

async function ddgSearch(query, limit) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const html = await ddgFetchHtml(query);
    if (html) {
      const results = ddgParse(html, limit);
      if (results.length) return results;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  return [];
}

async function webSearch(query, limit = 6) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  if (process.env.TAVILY_API_KEY) {
    const r = await tavilySearch(q, limit);
    if (r && r.length) return r;
  }
  return ddgSearch(q, limit);
}

module.exports = { webSearch, decodeEntities };
