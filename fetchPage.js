// SSRF-safe page fetcher + lightweight HTML extraction (no dependencies).
//
// Security: only http/https, the hostname is resolved and every address must be
// public (private/loopback/link-local/CGNAT/multicast blocked), redirects are
// followed manually and re-validated at each hop, and the body is capped in size
// and time. Extraction is regex-based (good enough for og: metadata + text).
const dns = require("node:dns/promises");
const net = require("node:net");

const MAX_BYTES = 512 * 1024; // 512 KB
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast/reserved
    return false;
  }
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("::ffff:")) return isPrivateIp(s.slice("::ffff:".length));
  return false;
}

async function assertPublicUrl(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http/https URLs are allowed");
  }
  const host = u.hostname;
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error("could not resolve host");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("blocked private/loopback address");
  }
  return u;
}

async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(Buffer.from(value));
    if (total >= MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function meta(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return m[1].trim();
  // attribute order can be reversed
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? m2[1].trim() : "";
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function extract(html, baseUrl) {
  const title =
    meta(html, "og:title") ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]).trim();
  const description = decodeEntities(
    meta(html, "og:description") || meta(html, "description")
  );

  const images = [];
  for (const prop of ["og:image", "twitter:image", "og:image:url"]) {
    const v = meta(html, prop);
    if (v) images.push(v);
  }
  if (images.length < 3) {
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      images.push(m[1]);
      if (images.length >= 6) break;
    }
  }
  const absolutize = (src) => {
    try { return new URL(src, baseUrl).toString(); } catch { return null; }
  };
  const cleanImages = [...new Set(images.map(absolutize).filter(Boolean))].slice(0, 3);

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);

  return { title: title.slice(0, 300), description: description.slice(0, 600), images: cleanImages, text };
}

async function fetchPage(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(u, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "wall-bot/1.0 (+https://example.com)", Accept: "text/html,*/*" },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect without a Location header");
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await readCapped(res);
    return { url: u.toString(), ...extract(html, u.toString()) };
  }
  throw new Error("too many redirects");
}

module.exports = { fetchPage, isPrivateIp, assertPublicUrl, extract };
