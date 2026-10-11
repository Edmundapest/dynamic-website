// Web Push for "The Wall".
//
// Sends a notification to every device that enabled alerts whenever a new
// post is created. Push is optional: if the VAPID keys are missing the module
// reports `configured === false` and all sends are no-ops, so the rest of the
// app keeps working.
//
// On iPhone, web push only works from a PWA that has been added to the Home
// Screen (iOS 16.4+) — Safari tabs cannot subscribe. The client UI explains
// this; the server side is identical to desktop.
const webpush = require("web-push");
const db = require("./db");

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn(
    "Web Push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable notifications."
  );
}

function isConfigured() {
  return configured;
}

function publicKey() {
  return PUBLIC_KEY || null;
}

// Validate a subscription object posted by the browser before trusting it.
function validSubscription(sub) {
  return Boolean(
    sub &&
      typeof sub.endpoint === "string" &&
      sub.endpoint.startsWith("https://") &&
      sub.keys &&
      typeof sub.keys.p256dh === "string" &&
      typeof sub.keys.auth === "string"
  );
}

// Insert or refresh a subscription. Endpoint is the natural key, so a device
// that re-subscribes (e.g. after clearing storage) just updates its row.
async function saveSubscription(sub, userAgent) {
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           last_seen_at = now()`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null]
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return 0;
  const { rowCount } = await db.query(
    "DELETE FROM push_subscriptions WHERE endpoint = $1",
    [endpoint]
  );
  return rowCount;
}

async function countSubscriptions() {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM push_subscriptions");
  return rows[0].n;
}

// Send `payload` (a plain object) to every stored subscription. Subscriptions
// the push service reports as gone (404/410) are deleted so the table self-heals.
async function broadcast(payload) {
  if (!configured) return { sent: 0, failed: 0, removed: 0, skipped: true };

  const { rows } = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
  );
  if (!rows.length) return { sent: 0, failed: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.all(
    rows.map(async (r) => {
      const subscription = {
        endpoint: r.endpoint,
        keys: { p256dh: r.p256dh, auth: r.auth },
      };
      try {
        await webpush.sendNotification(subscription, body);
        sent++;
      } catch (err) {
        failed++;
        // 404/410 mean the endpoint is permanently gone — prune it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await removeSubscription(r.endpoint).catch(() => {});
        } else {
          console.warn(`Push failed (${err && err.statusCode}): ${err && err.message}`);
        }
      }
    })
  );

  return { sent, failed, removed: 0 };
}

// Convenience builder for the "someone posted" notification.
async function notifyNewPost(post) {
  const who = (post.author && String(post.author).trim()) || "Someone";
  const text = String(post.body || "").replace(/\s+/g, " ").trim();
  const snippet = text.length > 140 ? text.slice(0, 137) + "…" : text;
  return broadcast({
    title: `${who} posted on The Wall`,
    body: snippet || "A new post just landed.",
    url: "/",
    tag: "wall-post", // collapse multiple alerts into one on the device
    postId: post.id,
  });
}

module.exports = {
  isConfigured,
  publicKey,
  validSubscription,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
  broadcast,
  notifyNewPost,
};
