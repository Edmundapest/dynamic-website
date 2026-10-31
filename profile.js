// What this wall has learned about its readers.
//
// There is no separate "knowledge base" table to keep in sync: the signal is
// already in the wall. Every post carries AI tags + keywords, every thumbs vote
// is +1/-1, and every follow-up question says what someone cares about right
// now. This module folds those into a weighted interest profile, decays it by
// age, caches it briefly, and hands the top terms to the prompts so later cards
// and answers lean towards what this wall actually likes.
//
// Recomputing from the source keeps it honest: delete a post and its influence
// goes with it, and there is no stale profile to migrate.
const db = require("./db");

const CACHE_MS = 5 * 60 * 1000; // rebuild at most every 5 minutes
const HALF_LIFE_DAYS = 60; // an interest loses half its weight in two months
const TOP_N = 12;
const ENABLED = !/^(0|off|false|no)$/i.test(String(process.env.PREFERENCES || "on"));

// Weights per signal. A follow-up question is the strongest "I care" signal we
// have; a vote is next; a post is the baseline.
const W_TAG = 1;
const W_KEYWORD = 0.6;
const W_VOTE = 2;
const W_ASK = 1.4;

let cache = { at: 0, value: null };

function decay(ageDays) {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length >= 3);
}

async function build() {
  const [postRes, voteRes] = await Promise.all([
    db.query(
      `SELECT id, kind, tags, card->'keywords' AS keywords, created_at,
              (votes_up - votes_down) AS score, thread
         FROM posts
        WHERE card IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 300`
    ),
    db.query(
      `SELECT post_id, coalesce(sum(value), 0)::int AS net
         FROM post_votes GROUP BY post_id`
    ),
  ]);

  const voteBy = new Map(voteRes.rows.map((r) => [r.post_id, r.net]));
  const scores = new Map();
  // Evidence, not just score: one downvoted post must not brand a whole topic
  // as disliked, which is what a single -2 * W_VOTE would do on a small wall.
  const posEvidence = new Map();
  const negEvidence = new Map();
  const evidence = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  const bump = (key, amount) => {
    const k = String(key || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (k.length < 3) return;
    scores.set(k, (scores.get(k) || 0) + amount);
  };

  const now = Date.now();
  const questions = [];
  for (const post of postRes.rows) {
    const ageDays = (now - new Date(post.created_at).getTime()) / 86_400_000;
    const w = decay(ageDays);
    const tags = Array.isArray(post.tags) ? post.tags : [];
    const keywords = Array.isArray(post.keywords) ? post.keywords : [];

    const net = voteBy.get(post.id) || 0;
    for (const t of tags) bump(t, W_TAG * w);
    for (const k of keywords) bump(k, W_KEYWORD * w);

    if (net) {
      for (const t of tags) bump(t, net * W_VOTE * w);
      for (const k of keywords) bump(k, net * W_VOTE * w * 0.6);
      // One vote on one post is one piece of evidence, even when the same topic
      // arrives as both a tag and a keyword.
      const keys = new Set(
        tags.concat(keywords).map((t) => String(t || "").trim().toLowerCase().replace(/\s+/g, "-"))
      );
      for (const k of keys) {
        if (k.length < 3) continue;
        evidence(net > 0 ? posEvidence : negEvidence, k);
      }
    }

    // Follow-up prompts: keep the recent ones verbatim (useful context) and
    // give a boost to whichever known interests they mention.
    for (const turn of Array.isArray(post.thread) ? post.thread : []) {
      if (!turn || turn.role !== "user" || !turn.text) continue;
      questions.push({ text: String(turn.text).slice(0, 140), at: turn.at || post.created_at });
    }
  }

  // Match the questions against the vocabulary the wall already uses, so a new
  // interest only counts if it is something we actually talk about.
  const vocab = new Set(scores.keys());
  const qWords = new Set();
  for (const q of questions) {
    const ageDays = (now - new Date(q.at).getTime()) / 86_400_000;
    const w = decay(ageDays);
    for (const word of words(q.text)) {
      qWords.add(word);
      if (vocab.has(word)) bump(word, W_ASK * w);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.filter(([, s]) => s > 0).slice(0, TOP_N).map(([key, score]) => ({ key, score: +score.toFixed(2) }));
  const down = ranked
    .filter(([key, s]) => {
      if (s >= 0) return false;
      const neg = negEvidence.get(key) || 0;
      const pos = posEvidence.get(key) || 0;
      return neg >= 2 && neg > pos; // repeated, not a one-off
    })
    .sort((a, b) => a[1] - b[1])
    .slice(0, 6)
    .map(([key, score]) => ({ key, score: +score.toFixed(2) }));

  // Most recent questions first, de-duplicated.
  const seen = new Set();
  const recentQuestions = questions
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .filter((q) => {
      const k = q.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4)
    .map((q) => q.text);

  return {
    top,
    down,
    recentQuestions,
    posts: postRes.rows.length,
    terms: top.map((t) => t.key),
    questionWords: [...qWords].slice(0, 40),
    builtAt: new Date().toISOString(),
  };
}

// Cached profile. Never throws: a profile is an optimisation, not a dependency.
async function get() {
  if (!ENABLED) return { top: [], down: [], recentQuestions: [], terms: [], posts: 0, builtAt: null };
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    cache = { at: Date.now(), value: await build() };
  } catch (err) {
    console.warn("preference profile failed:", err.message);
    cache = { at: Date.now(), value: { top: [], down: [], recentQuestions: [], terms: [], posts: 0, builtAt: null } };
  }
  return cache.value;
}

// One system-message-sized paragraph describing the wall's taste. Empty string
// when there is nothing to say yet (a fresh wall).
function summary(profile) {
  if (!profile || !profile.top.length) return "";
  const list = (arr) => arr.map((t) => t.key.replace(/-/g, " ")).join(", ");
  const parts = [`This wall's readers mostly post about: ${list(profile.top)}.`];
  if (profile.down.length) parts.push(`Downvoted / disliked: ${list(profile.down)}.`);
  if (profile.recentQuestions.length) {
    parts.push(`They recently asked: ${profile.recentQuestions.map((q) => `"${q}"`).join("; ")}.`);
  }
  parts.push(
    "Use this only to choose emphasis (what to highlight, suggest or rank first). " +
      "Never invent or bend facts to fit it, and never mention this profile to the reader."
  );
  return parts.join(" ");
}


module.exports = { get, summary, build, ENABLED };
