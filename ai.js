// DeepSeek client (OpenAI-compatible chat completions API).
//
// Endpoint: https://api.deepseek.com/chat/completions
// Docs: https://api-docs.deepseek.com  (fully OpenAI-compatible)
// Auth:   DEEPSEEK_API_KEY
//
// Uses the global fetch built into Node 18+ — no SDK dependency.

const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

function apiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
  return key;
}

// Low-level chat call with a hard timeout (AbortController).
async function chat(messages, { json = false, timeoutMs = 45_000, temperature = 0.8 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// Extracts the first JSON object from a string (models sometimes wrap it in
// prose or ```json fences even in JSON mode).
function parseJsonLoose(text) {
  if (!text || typeof text !== "string") throw new Error("empty AI response");
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error("AI response was not valid JSON");
  }
}

const SYSTEM_PROMPT = `You are the curator of a public "wall" where people post links and notes.
Given the posted content, produce a single JSON object (no markdown) with these keys:
- "title": a short, catchy headline (max 80 chars)
- "emoji": exactly one emoji that captures the vibe
- "summary": 2-3 plain sentences explaining what this is about
- "fun_facts": an array of 3 genuinely interesting facts drawn from the content
- "quotes": an array of 1-2 short, memorable, quirky quotes found in or inspired by the content
- "keywords": an array of 3-5 lowercase topic keywords
- "tags": an array of 3-6 short lowercase tags (single words or hyphenated, no "#") a reader would use to find this post — broad enough to group related posts, specific enough to be useful
- "references": up to 3 URLs chosen ONLY from the "Links found on the page" list in the input that are the most useful further reading; use [] if there is no such list or none fit
Stay factual to the provided content. If the input contains "Web search results", ground the summary and fun facts in them and include concrete specifics (names, dates, places, numbers). If the content is thin, be honest and concise rather than inventing specifics.`;

// Builds the card object for a post. `context` is a string describing the
// source (page title/description/text for links, or the raw text for notes).
async function buildCard(context, guidance = "") {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (guidance) messages.push({ role: "system", content: guidance });
  messages.push({ role: "user", content: context.slice(0, 12_000) });

  let lastErr;
  // One retry on failure (transient network / malformed JSON).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await chat(messages, { json: true });
      const card = parseJsonLoose(raw);
      return {
        title: String(card.title || "").slice(0, 120),
        emoji: String(card.emoji || "✨").slice(0, 8),
        summary: String(card.summary || "").slice(0, 1200),
        fun_facts: Array.isArray(card.fun_facts) ? card.fun_facts.slice(0, 5).map(String) : [],
        quotes: Array.isArray(card.quotes) ? card.quotes.slice(0, 3).map(String) : [],
        keywords: Array.isArray(card.keywords) ? card.keywords.slice(0, 6).map(String) : [],
        tags: Array.isArray(card.tags) ? card.tags.slice(0, 6).map(String) : [],
        references: Array.isArray(card.references) ? card.references.slice(0, 3).map(String) : [],
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const THREAD_PROMPT = `You are continuing the conversation under a card on a private wall.
The reader asks a follow-up about the post. Be concrete and useful, in plain text.

- When the post (or the fresh search results below) already answers it, answer from
  those: 2-4 sentences, under 120 words, no repetition of the card's summary.
- When the reader asks for options, more of something, or a specific number of items,
  enumerate them from the listing pages and search results below: one short line per
  item with the name plus venue/date/price when stated. Cite each item with the result's
  number in parentheses, e.g. "Boo! @ GMBB Halloween Weekend (3)", and say how many you
  actually found. Never paste raw URLs.
- Never invent a date, price, venue or event. If the results do not cover it, say so
  and name what to check.
- Reader preferences may be supplied; use them only to decide what to put first.
  Never mention the preferences or that a profile exists.`;

// Answers a follow-up prompt about one post, using the card, the original note
// and the earlier turns of the thread as context.
async function continueThread({ card, body, url, thread, prompt, searchResults, searchQuery, pages, profile } = {}) {
  const c = card || {};
  const context = [
    body ? `Posted note: ${body}` : "",
    url ? `Source: ${url}` : "",
    c.title ? `Card title: ${c.title}` : "",
    c.summary ? `Card summary: ${c.summary}` : "",
    Array.isArray(c.fun_facts) && c.fun_facts.length
      ? `Known details:\n- ${c.fun_facts.join("\n- ")}`
      : "",
    Array.isArray(c.quotes) && c.quotes.length ? `Quotes:\n- ${c.quotes.join("\n- ")}` : "",
    Array.isArray(c.references) && c.references.length
      ? `Further reading:\n- ${c.references.map((r) => r.url || r).join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);

  const messages = [
    { role: "system", content: THREAD_PROMPT },
    { role: "system", content: `Post context:
${context || "(nothing was captured for this post)"}` },
  ];
  for (const m of (Array.isArray(thread) ? thread : []).slice(-12)) {
    if (!m || !m.text) continue;
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.text).slice(0, 1500),
    });
  }
  if (Array.isArray(pages) && pages.length) {
    const listing = pages
      .slice(0, 3)
      .map((p) => `### ${p.title || p.url}\n${p.url}\n${String(p.text || "").slice(0, 2500)}`)
      .join("\n\n");
    messages.push({
      role: "system",
      content:
        `Listing pages the post itself points at (verbatim text, may include navigation noise). ` +
        `These are the best source for actual event names, dates, venues and prices:\n\n${listing}`,
    });
  }

  if (profile) messages.push({ role: "system", content: `Reader preferences on this wall: ${profile}` });

  if (Array.isArray(searchResults) && searchResults.length) {
    const list = searchResults
      .slice(0, 10)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${String(r.snippet || "").slice(0, 220)}`)
      .join("\n\n");
    messages.push({
      role: "system",
      content:
        `Fresh web search results for this question (query: "${searchQuery || prompt}"). ` +
        `Use them for anything the post does not already answer, especially when the reader asks ` +
        `for more options. Never state an event, date or price that is not in these results.\n\n${list}`,
    });
  }

  messages.push({ role: "user", content: String(prompt || "").slice(0, 1000) });

  const raw = await chat(messages, { temperature: 0.6 });
  const text = String(raw || "").trim().slice(0, 1200);
  if (!text) throw new Error("empty AI reply");
  return text;
}

module.exports = { chat, buildCard, continueThread, MODEL, BASE_URL };
