// Web search for text notes.
//
// Provider order:
//   1. Tavily (if TAVILY_API_KEY is set) — reliable from any host, free tier
//      (1,000 searches/month). Also returns image URLs we can use on cards.
//   2. DuckDuckGo Lite (key-less fallback). Real results, but datacenter IPs
//      (e.g. Render) are challenged intermittently and often return nothing;
//      works reliably from a residential IP (local dev).
const TIMEOUT_MS = 10_000;

// Localise results to where the wall's readers actually are. Without these the
// provider ranks a vague query ("things to do on this weekend") against a
// US-centric index and you get American listicles. All overridable via .env.
const COUNTRY = (process.env.SEARCH_COUNTRY || "malaysia").trim().toLowerCase();
const LANGUAGE = (process.env.SEARCH_LANGUAGE || "en").trim();
const LOCATION = (process.env.SEARCH_LOCATION || "Kuala Lumpur").trim();
// DuckDuckGo region code (https://duckduckgo.com/params) — `my-en` = Malaysia/English.
const REGION = (process.env.SEARCH_REGION || "my-en").trim();

// Queries that only make sense next to a place. For these we also append
// LOCATION to the query text, because a country boost alone cannot turn a
// location-free query into a local one.
const LOCAL_INTENT =
  /\b(near me|nearby|this weekend|next weekend|weekend|tonight|today|tomorrow|this week|next week|open now|opening hours|happening|events?|things to do|where to|best .* (in|around)|restaurant|cafe|hawker|mamak|mall|clinic|dentist|plumber|gym|salon|barber|petrol|parking|traffic)\b/i;

function withLocation(q) {
  if (!LOCATION) return q;
  if (new RegExp(`\\b${LOCATION.split(",")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q)) return q;
  return LOCAL_INTENT.test(q) ? `${q} ${LOCATION}` : q;
}

// Notes are written as sentences ("whats happening on kl this weekend"), which
// make poor search queries. Strip the question scaffolding and expand the local
// shorthand so the provider sees a query, not a question.
const QUESTION_LEAD =
  /^(?:hi|hey|so|ok|okay|pls|please)?[\s,]*?(?:what'?s|whats|what is|what are|any|anyone|anybody|some|tell me|show me|find|looking for|where'?s|where is|any idea)\b[\s:,-]*/i;

function toQuery(text) {
  const original = String(text || "").replace(/\s+/g, " ").trim();
  let q = original.replace(QUESTION_LEAD, "").replace(/\s+/g, " ").trim();
  // "happening on / what's on" → "events in", which is what a search engine
  // expects; the literal rewording scores badly (0 results for "happening on
  // Kuala Lumpur this weekend").
  q = q.replace(/^(?:happening|going on|on)\s+(?:in|on|at|around)?\s*/i, "events in ");
  q = q.replace(/\bkl\b/gi, "Kuala Lumpur");
  // Drop connectors left behind by the question scaffolding ("on in …").
  for (let i = 0; i < 3; i++) {
    const next = q.replace(/^(?:on|in|at|about|for|of|to|from)\s+/i, "");
    if (next === q) break;
    q = next;
  }
  q = q.replace(/[?!.]+$/g, "").trim();
  // If stripping gutted the note, keep the original wording.
  return q.length >= 4 ? q : original;
}

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
        // `country` is only honoured when topic is `general` (the default).
        country: COUNTRY,
        // Boosts matching-language results without dropping the rest.
        language: LANGUAGE,
      }),
    });
    if (!res.ok) {
      console.warn("tavily HTTP", res.status);
      return null;
    }
    const d = await res.json();
    const imageUrl = (i) => (typeof i === "string" ? i : (i && i.url) || "");
    const results = (Array.isArray(d.results) ? d.results : [])
      .map((r) => ({
        title: String(r.title || "").trim(),
        url: String(r.url || ""),
        snippet: String(r.content || "").trim(),
        // Per-result images feed the card carousel.
        images: (Array.isArray(r.images) ? r.images : []).map(imageUrl).filter(Boolean),
      }))
      .filter((r) => r.title && /^https?:\/\//i.test(r.url));
    const images = Array.isArray(d.images) ? d.images.map(imageUrl).filter(Boolean) : [];
    if (images.length && results.length) results[0].image = images[0];
    // Top-level image-search results, carried on the array for the carousel.
    results.images = images;
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
    const url =
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` +
      (REGION ? `&kl=${encodeURIComponent(REGION)}` : "");
    const res = await fetch(url, {
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

// Filler words that carry no topic in a follow-up ("find 10 more events").
const FILLER = /^(?:find|show|give|list|suggest|tell|me|us|please|can|could|would|you|i|we|any|some|more|new|other|another|else|additional|different|top|about|with|for|and|the|a|an|\d+)$/i;

// A follow-up like "find 10 more events" has no topic of its own: borrow the
// post's keywords so the search stays about the same thing. When the ask is
// generic ("what else should we do?") the wall's own interests are mixed in too,
// otherwise the profile could never surface the things this wall actually likes.
const GENERIC_ASK = /\b(what else|anything else|more|other|another|else|recommend|suggest|suggestions?|ideas?|options?|should we|activities)\b/i;

function followupQuery(prompt, card, interests = []) {
  const base = toQuery(prompt);
  const topic = card && Array.isArray(card.keywords) ? card.keywords.join(" ") : "";
  const generic = GENERIC_ASK.test(prompt) || base.split(/\s+/).filter(Boolean).length <= 2;
  const bias = generic
    ? (interests || [])
        .slice(0, 3)
        .map((t) => String(t).replace(/-/g, " "))
        .join(" ")
    : "";
  const words = `${base} ${topic} ${bias}`
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !FILLER.test(w.replace(/[^\p{L}\p{N}]/gu, "")));
  const seen = new Set();
  const unique = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(w);
  }
  return (unique.join(" ") || base || topic || String(prompt || "")).slice(0, 300);
}

async function webSearch(query, limit = 6) {
  const raw = String(query || "").trim();
  if (raw.length < 2) return [];
  if (process.env.TAVILY_API_KEY) {
    // Try the cleaned query first, then the note as written: a rewrite must
    // never be the reason a search comes back empty.
    const attempts = [...new Set([withLocation(toQuery(raw)), withLocation(raw)])];
    for (let i = 0; i < attempts.length; i++) {
      const q = attempts[i];
      const r = await tavilySearch(q, limit);
      if (r && r.length) return r;
      console.warn(`web search returned nothing for "${q}"`);
      // The provider does occasionally answer 200 with an empty result set;
      // one short retry recovers that instead of degrading the whole card.
      if (i === attempts.length - 1) {
        await new Promise((res) => setTimeout(res, 600));
        const again = await tavilySearch(q, limit);
        if (again && again.length) return again;
      }
    }
  }
  const ddg = await ddgSearch(withLocation(toQuery(raw)), limit);
  if (!ddg.length) console.warn(`no search results at all for "${raw}"`);
  return ddg;
}

module.exports = { webSearch, decodeEntities, toQuery, followupQuery };
