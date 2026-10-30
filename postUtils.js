// Shared helpers for turning user text into a post row.
//
// Used by the web API (server.js) and the WhatsApp webhook (whatsapp.js) so
// both paths detect links and normalize tags the same way.

function detectUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Normalize tags: lowercase, strip "#", keep [a-z0-9_-], dedupe, cap.
function parseTags(input) {
  const arr = Array.isArray(input) ? input : String(input || "").split(/[,\s]+/);
  const seen = new Set();
  const out = [];
  for (let t of arr) {
    t = String(t).trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]/g, "");
    if (!t) continue;
    if (t.length > 24) t = t.slice(0, 24);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = { detectUrl, parseTags };
