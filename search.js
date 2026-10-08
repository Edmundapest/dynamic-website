// Free web search via DuckDuckGo Lite (no API key).
//
// DDG's Instant-Answer API and html.duckduckgo.com are blocked for server-side
// requests (HTTP 202), but lite.duckduckgo.com/lite/ returns real results. We
// parse the result links + snippets and hand them to the AI for summarising.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
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

async function webSearch(query, limit = 6) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const links = [...html.matchAll(
    /<a[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)[^"]*"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/gi
  )];
  const snippets = [...html.matchAll(
    /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi
  )];

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

module.exports = { webSearch, decodeEntities };
