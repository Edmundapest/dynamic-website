// Card image generation.
//
// Text-to-image is OPTIONAL and pluggable: if a provider is configured via env,
// we use it; otherwise enrich.js falls back to a related public photo (related.js).
//
// History: Pollinations.ai used to be key-less, but now returns HTTP 402 for
// anonymous use, so it is no longer used. AI Horde is key-less but its anonymous
// queue is ~15+ minutes per image — unusable for cards.

function buildImagePrompt(card) {
  const title = String(card.title || "").trim();
  const summary = String(card.summary || "").trim();
  const keywords = Array.isArray(card.keywords) ? card.keywords.join(", ") : "";
  const subject = title || summary.slice(0, 120) || "an interesting topic";
  return (
    `${subject}. Keywords: ${keywords}. ` +
    `Digital illustration, vibrant editorial poster style, cinematic lighting, no text, no words.`
  );
}

async function withTimeout(promise, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(t);
  }
}

// Together AI (has a free FLUX schnell endpoint). Returns a hosted URL.
async function together(prompt) {
  return withTimeout(async (signal) => {
    const res = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width: 1200,
        height: 630,
        steps: 4,
        n: 1,
        response_format: "url",
      }),
    });
    if (!res.ok) throw new Error(`Together HTTP ${res.status}`);
    const d = await res.json();
    const item = d.data && d.data[0];
    if (item && item.url) return item.url;
    if (item && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    return null;
  }, 60_000);
}

// Hugging Face Inference API — returns raw bytes, stored as a data URI.
async function huggingface(prompt) {
  return withTimeout(async (signal) => {
    const model = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: prompt }),
    });
    if (!res.ok) throw new Error(`HF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  }, 60_000);
}

// Returns a displayable image URL/data-URI for the prompt, or null if no
// provider is configured (or the call fails) — caller then falls back.
async function generateCardImage(prompt) {
  try {
    if (process.env.TOGETHER_API_KEY) return await together(prompt);
    if (process.env.HF_TOKEN) return await huggingface(prompt);
  } catch (err) {
    console.warn("image generation failed:", err.message);
  }
  return null;
}

module.exports = { buildImagePrompt, generateCardImage };
