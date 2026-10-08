// Session auth for a single shared posting password.
//
// - Login compares the submitted password to POST_PASSWORD in constant time.
// - On success we set a signed, HttpOnly cookie whose payload is just an expiry
//   timestamp; the HMAC (keyed by SESSION_SECRET) makes it unforgeable.
// - requireAuth guards write routes; reads stay public.
const crypto = require("node:crypto");

const COOKIE = "wall_auth";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function hmac(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

// Constant-time comparison that does not leak length (hashes both first).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPassword(input) {
  const expected = process.env.POST_PASSWORD || "";
  if (!expected) return false;
  return safeEqual(input || "", expected);
}

function makeToken() {
  const exp = String(Date.now() + MAX_AGE_MS);
  return `${exp}.${hmac(exp)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const i = token.lastIndexOf(".");
  if (i === -1) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function secureSuffix() {
  return process.env.RENDER || process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function cookieHeader() {
  return `${COOKIE}=${makeToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${
    MAX_AGE_MS / 1000
  }${secureSuffix()}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureSuffix()}`;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: "authentication required" });
}

module.exports = {
  checkPassword,
  cookieHeader,
  clearCookieHeader,
  isAuthed,
  requireAuth,
  COOKIE,
};
