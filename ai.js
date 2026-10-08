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
Stay factual to the provided content. If the content is thin, be honest and concise rather than inventing specifics.`;

// Builds the card object for a post. `context` is a string describing the
// source (page title/description/text for links, or the raw text for notes).
async function buildCard(context) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: context.slice(0, 12_000) },
  ];

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
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { chat, buildCard, MODEL, BASE_URL };
