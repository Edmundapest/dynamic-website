// Finds a related public image + link for a post that has no source page
// (e.g. a text note). Uses the Wikipedia/Wikimedia APIs — free, no key.
const UA = "wall-bot/1.0 (+https://dynamic-website-urt2.onrender.com)";
const TIMEOUT_MS = 8000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Top matching article title for a query.
async function searchTitle(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&redirects=resolve&search=${encodeURIComponent(q)}`;
  const d = await getJson(url);
  const titles = d && Array.isArray(d[1]) ? d[1] : [];
  return titles[0] || null;
}

// Image (up to `px` wide), plain-text intro, and canonical URL for a title.
async function pageInfo(title, px = 800) {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1` +
    `&prop=pageimages|extracts|info&inprop=url&exintro=1&explaintext=1` +
    `&piprop=thumbnail&pithumbsize=${px}&titles=${encodeURIComponent(title)}`;
  const d = await getJson(url);
  const pages = d && d.query && d.query.pages ? Object.values(d.query.pages) : [];
  const page = pages[0];
  if (!page || page.missing !== undefined || !page.title) return null;
  return {
    title: page.title,
    url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    image: page.thumbnail ? page.thumbnail.source : null,
    extract: page.extract || "",
  };
}

// Tries candidate queries and prefers the first result that has an image;
// falls back to the first result that at least has a link.
async function findRelated(queries) {
  const tried = new Set();
  let linkOnly = null;
  for (const raw of queries) {
    const q = String(raw || "").trim();
    if (!q || q.length < 3 || tried.has(q.toLowerCase())) continue;
    tried.add(q.toLowerCase());
    const title = await searchTitle(q);
    if (!title) continue;
    const info = await pageInfo(title);
    if (!info) continue;
    if (info.image) return info; // best: has a picture
    if (!linkOnly) linkOnly = info; // keep as a fallback link
  }
  return linkOnly;
}

module.exports = { findRelated, searchTitle, pageInfo };
