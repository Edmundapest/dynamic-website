// WhatsApp Cloud API integration.
//
// Inbound: Meta POSTs signed webhook events to /api/whatsapp/webhook. We verify
// the X-Hub-Signature-256 HMAC, enforce an allowlist, create a wall post, send
// an acknowledgement, and let enrich.js reply with the finished AI card.
//
// Outbound: POST https://graph.facebook.com/<version>/<phone-number-id>/messages
// with a permanent (System User) access token.
//
// Env:
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID    outbound replies
//   WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET  webhook setup + signatures
//   WHATSAPP_ALLOWED_NUMBERS                    comma-separated E.164 digits
//   WHATSAPP_API_VERSION                        optional, default v23.0
//   PUBLIC_URL / RENDER_EXTERNAL_URL            link back to the wall
//
// NOTE: set WHATSAPP_ALLOWED_NUMBERS. Without it every sender is ignored (and
// logged) so a public business number can't be used to fill the wall.
const crypto = require("node:crypto");
const db = require("./db");
const { detectUrl } = require("./postUtils");

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";
const MAX_BODY = 1000;
const TIMEOUT_MS = 15_000;

const sendReady = Boolean(TOKEN && PHONE_ID);
const hookReady = Boolean(VERIFY_TOKEN && APP_SECRET);

if (sendReady) {
  console.log(`WhatsApp replies enabled (${API_VERSION}, phone id ${PHONE_ID}).`);
} else {
  console.warn(
    "WhatsApp replies disabled: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID."
  );
}
if (!hookReady) {
  console.warn(
    "WhatsApp webhook disabled: set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET."
  );
}

function sendConfigured() {
  return sendReady;
}
function webhookConfigured() {
  return hookReady;
}

// Constant-time compare that doesn't leak length (hash both first).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyToken(token) {
  if (!VERIFY_TOKEN || typeof token !== "string") return false;
  return safeEqual(token, VERIFY_TOKEN);
}

// Validates Meta's `X-Hub-Signature-256: sha256=<hex>` over the raw body.
function verifySignature(raw, header) {
  if (!APP_SECRET || !Buffer.isBuffer(raw) || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(raw).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function allowedNumbers() {
  return String(process.env.WHATSAPP_ALLOWED_NUMBERS || "")
    .split(/[,\s]+/)
    .map((s) => s.replace(/[^\d]/g, ""))
    .filter(Boolean);
}

function isAllowed(waId) {
  const list = allowedNumbers();
  if (!list.length) return false;
  return list.includes(String(waId || "").replace(/[^\d]/g, ""));
}

function wallUrl() {
  const base =
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "https://dynamic-website-urt2.onrender.com";
  return String(base).replace(/\/+$/, "") + "/";
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// --- outbound ------------------------------------------------------------

async function sendText(to, body, replyToId) {
  if (!sendReady) return false;
  const text = String(body || "").slice(0, 4096);
  if (!text) return false;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: String(to),
    type: "text",
    text: { preview_url: true, body: text },
  };
  if (replyToId) payload.context = { message_id: replyToId };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(PHONE_ID)}/messages`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`WhatsApp HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function formatCard(post, card) {
  card = card || {};
  const blocks = [];
  const emoji = card.emoji ? " " + card.emoji : "";
  blocks.push(`✅ *${clip(card.title || "New post", 120)}*${emoji}`);
  if (card.summary) blocks.push(clip(card.summary, 900));

  const facts = (card.fun_facts || []).filter(Boolean).slice(0, 3);
  if (facts.length) {
    blocks.push(
      "💡 *Fun facts*\n" + facts.map((f) => "• " + clip(f, 300)).join("\n")
    );
  }

  const quote = (card.quotes || []).filter(Boolean)[0];
  if (quote) blocks.push(`💬 “${clip(quote, 300)}”`);

  if (card.source_url) {
    blocks.push(
      "🔗 " + clip(card.source_title || card.source_url, 120) + "\n" + card.source_url
    );
  }
  blocks.push("👉 View on The Wall\n" + wallUrl());

  let out = blocks.join("\n\n");
  if (out.length > 4096) out = out.slice(0, 4095) + "…";
  return out;
}

function sendCardReply(post, card) {
  return sendText(post.wa_id, formatCard(post, card), post.wa_message_id);
}

function sendErrorReply(post, err) {
  const reason = clip(err && err.message ? err.message : err, 240);
  return sendText(
    post.wa_id,
    `⚠️ I couldn't build a card for that post.\n\n${reason}\n\n` +
      `It's on the wall — open ${wallUrl()} to retry.`,
    post.wa_message_id
  );
}

// --- inbound -------------------------------------------------------------

function extractText(msg) {
  if (msg.type === "text" && msg.text && typeof msg.text.body === "string") {
    return msg.text.body.trim();
  }
  // Media messages are only used for their caption; the file itself stays on
  // WhatsApp (the card's image still comes from the page/search/AI chain).
  const captioned = ["image", "video", "document"];
  if (
    captioned.includes(msg.type) &&
    msg[msg.type] &&
    typeof msg[msg.type].caption === "string"
  ) {
    return msg[msg.type].caption.trim();
  }
  return "";
}

async function handleMessage(msg, profileName) {
  const from = String(msg.from || "").replace(/[^\d]/g, "");
  if (!from) return;

  if (!isAllowed(from)) {
    console.warn(
      `WhatsApp: ignoring message from ${from} (not in WHATSAPP_ALLOWED_NUMBERS).`
    );
    if (allowedNumbers().length) {
      await sendText(
        from,
        "This WhatsApp number isn't allowed to post to this wall.",
        msg.id
      ).catch(() => {});
    }
    return;
  }

  const text = extractText(msg);
  if (!text) {
    await sendText(
      from,
      "Send a text message or a link to post it to The Wall.",
      msg.id
    ).catch(() => {});
    return;
  }
  if (text.length > MAX_BODY) {
    await sendText(
      from,
      `That's a bit long — please keep posts under ${MAX_BODY} characters.`,
      msg.id
    ).catch(() => {});
    return;
  }

  const author = clip(profileName, 40) || "WhatsApp " + from.slice(-4);
  const url = detectUrl(text);
  const kind = url ? "link" : "text";

  // The unique wa_message_id index makes Meta retries idempotent.
  const { rows } = await db.query(
    `INSERT INTO posts (author, body, kind, url, status, source, wa_id, wa_message_id)
     VALUES ($1, $2, $3, $4, 'pending', 'whatsapp', $5, $6)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id, author, body, kind, url, status, tags, created_at`,
    [author, text, kind, url, from, msg.id]
  );
  if (!rows.length) return; // duplicate delivery

  const post = rows[0];

  // Required lazily so this module can load before the enrichment worker and
  // to keep the dependency graph acyclic.
  const enrich = require("./enrich");
  const push = require("./push");
  enrich.enqueue(post.id);
  push
    .notifyNewPost(post)
    .catch((err) => console.warn(`Push broadcast failed: ${err.message}`));

  await sendText(
    from,
    `✅ Got it, ${author}. I'm investigating this now — ` +
      "I'll reply with the card when it's ready.",
    msg.id
  ).catch((err) => console.warn(`WhatsApp ack failed: ${err.message}`));
}

// In-memory dedupe for non-post replies (Meta can redeliver a batch). Text
// posts are also deduped in Postgres by wa_message_id.
const seen = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return false;
}

async function handleWebhook(payload) {
  if (!payload || payload.object !== "whatsapp_business_account") return;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = change.value || {};

      const names = new Map();
      for (const c of value.contacts || []) {
        if (c && c.wa_id) {
          names.set(String(c.wa_id), (c.profile && c.profile.name) || "");
        }
      }

      for (const msg of value.messages || []) {
        if (!msg || !msg.from || !msg.id) continue;
        if (alreadySeen(msg.id)) continue;
        try {
          await handleMessage(msg, names.get(String(msg.from)) || "");
        } catch (err) {
          console.warn(`WhatsApp message ${msg.id} failed: ${err.message}`);
        }
      }
    }
  }
}

module.exports = {
  sendConfigured,
  webhookConfigured,
  verifyToken,
  verifySignature,
  allowedNumbers,
  isAllowed,
  sendText,
  sendCardReply,
  sendErrorReply,
  handleWebhook,
  formatCard,
  wallUrl,
};
