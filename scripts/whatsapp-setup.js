#!/usr/bin/env node
// One-command WhatsApp Cloud API setup for The Wall.
//
// What it can do for you:
//   1. Generate WHATSAPP_VERIFY_TOKEN if you don't have one (saved in .env).
//   2. Validate the Meta access token + phone number ID (and optionally look
//      up the phone number ID from a WABA id).
//   3. Set the WhatsApp env vars on Render and trigger a deploy
//      (requires RENDER_API_KEY; service is found by name or RENDER_SERVICE_ID).
//   4. Verify the public /api/whatsapp/webhook challenge.
//   5. Configure Meta's webhook subscription and subscribe the WABA to the app
//      (requires WHATSAPP_APP_ID + WHATSAPP_APP_SECRET, optionally WABA id).
//
// Usage:
//   npm run whatsapp:setup              # do everything it can
//   npm run whatsapp:setup -- --check   # validate only, change nothing
//   npm run whatsapp:setup -- --render  # only Render env vars + deploy
//   npm run whatsapp:setup -- --meta    # only Meta validation/webhook
//
// Put values in .env (or export them) first. No secret is printed.
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const DEFAULT_URL = "https://dynamic-website-urt2.onrender.com";
const args = process.argv.slice(2);
const ONLY_CHECK = args.includes("--check");
const ONLY_RENDER = args.includes("--render");
const ONLY_META = args.includes("--meta");
const RUN_RENDER = !ONLY_META;
const RUN_META = !ONLY_RENDER;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (v) => {
  v = String(v || "");
  if (!v) return "(missing)";
  return v.length <= 8 ? "••••" : v.slice(0, 4) + "…" + v.slice(-3);
};

function line() {
  console.log("-".repeat(64));
}
function ok(msg) {
  console.log("  ✓ " + msg);
}
function warn(msg) {
  console.log("  ! " + msg);
}
function section(msg) {
  console.log("\n" + msg);
}

function setEnvValue(key, value) {
  process.env[key] = value;
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const re = new RegExp("^" + key + "=.*$", "m");
  const next = re.test(text)
    ? text.replace(re, key + "=" + value)
    : text.replace(/\s*$/, "") + "\n" + key + "=" + value + "\n";
  if (next !== text) fs.writeFileSync(ENV_PATH, next);
}

function ensureVerifyToken() {
  let token = process.env.WHATSAPP_VERIFY_TOKEN || "";
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    setEnvValue("WHATSAPP_VERIFY_TOKEN", token);
    console.log("Generated WHATSAPP_VERIFY_TOKEN and saved it to .env.");
  }
  return token;
}

const cfg = {
  token: process.env.WHATSAPP_TOKEN || "",
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  verifyToken: ensureVerifyToken(),
  appSecret: process.env.WHATSAPP_APP_SECRET || "",
  appId: process.env.WHATSAPP_APP_ID || "",
  wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
  allowed: process.env.WHATSAPP_ALLOWED_NUMBERS || "",
  apiVersion: process.env.WHATSAPP_API_VERSION || "v23.0",
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || DEFAULT_URL).replace(/\/+$/, ""),
  renderKey: process.env.RENDER_API_KEY || "",
  renderServiceId: process.env.RENDER_SERVICE_ID || "",
};

async function request(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

async function graph(pathname, { method = "GET", query, body, token = cfg.token } = {}) {
  const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${String(pathname).replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  let payload;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await request(url, { method, headers, body: payload });
  const { data, text } = await readJson(res);
  if (!res.ok) {
    throw new Error(data && data.error ? data.error.message : `Graph HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function renderApi(pathname, { method = "GET", body } = {}) {
  if (!cfg.renderKey) throw new Error("RENDER_API_KEY is not set");
  const res = await request(`https://api.render.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.renderKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const { data, text } = await readJson(res);
  if (!res.ok) {
    throw new Error(data && data.message ? data.message : `Render HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function resolveService() {
  if (!cfg.renderKey) return null;
  if (cfg.renderServiceId) {
    const service = await renderApi(`/services/${encodeURIComponent(cfg.renderServiceId)}`);
    return { id: service.id, name: service.name, url: publicServiceUrl(service) };
  }
  const list = await renderApi(`/services?name=${encodeURIComponent("dynamic-website")}&limit=20`);
  const services = (Array.isArray(list) ? list : [])
    .map((entry) => (entry && entry.service ? entry.service : entry))
    .filter(Boolean);
  if (!services.length) {
    throw new Error(
      "No Render service named 'dynamic-website' was found. Set RENDER_SERVICE_ID (srv-…) in .env."
    );
  }
  const service = services[0];
  return { id: service.id, name: service.name, url: publicServiceUrl(service) };
}

function publicServiceUrl(service) {
  if (!service) return "";
  if (service.serviceDetails && service.serviceDetails.url) return String(service.serviceDetails.url).replace(/\/+$/, "");
  if (service.slug) return `https://${service.slug}.onrender.com`;
  return "";
}

async function validateMeta() {
  section("1. Meta credentials");
  if (!cfg.token) {
    warn("WHATSAPP_TOKEN is missing. Create a permanent System User token in Meta and put it in .env.");
    return false;
  }
  ok(`WHATSAPP_TOKEN ${mask(cfg.token)}`);

  if (cfg.wabaId) {
    try {
      const data = await graph(`${cfg.wabaId}/phone_numbers`, {
        query: { fields: "id,display_phone_number,verified_name,quality_rating" },
      });
      const numbers = (data && data.data) || [];
      console.log(`  Phone numbers on WABA ${cfg.wabaId}:`);
      for (const n of numbers) {
        console.log(`    - ${n.display_phone_number || n.id} (${n.verified_name || "unverified"}) id=${n.id}`);
      }
      if (!cfg.phoneId && numbers.length === 1) {
        cfg.phoneId = numbers[0].id;
        setEnvValue("WHATSAPP_PHONE_NUMBER_ID", cfg.phoneId);
        console.log(`  Using the only phone number id (${cfg.phoneId}) and saving it to .env.`);
      }
    } catch (err) {
      warn(`Could not list WABA phone numbers: ${err.message}`);
      warn("The token may need whatsapp_business_management permission.");
    }
  }

  if (!cfg.phoneId) {
    warn("WHATSAPP_PHONE_NUMBER_ID is missing (set it or add WHATSAPP_BUSINESS_ACCOUNT_ID).");
    return false;
  }

  try {
    const info = await graph(cfg.phoneId, {
      query: { fields: "display_phone_number,verified_name,quality_rating" },
    });
    ok(
      `Phone number ID ${cfg.phoneId}: ${info.display_phone_number || "?"} ` +
        `(${info.verified_name || "unverified"})`
    );
  } catch (err) {
    warn(`Phone number validation failed: ${err.message}`);
    return false;
  }

  if (!cfg.allowed) {
    warn("WHATSAPP_ALLOWED_NUMBERS is empty — the webhook will ignore every sender.");
    return false;
  }
  ok(`Allowed senders: ${cfg.allowed}`);

  if (!cfg.appSecret) {
    warn("WHATSAPP_APP_SECRET is missing — signed webhooks will be rejected.");
    return false;
  }
  ok(`WHATSAPP_APP_SECRET ${mask(cfg.appSecret)}`);
  return true;
}

async function setupRender() {
  section("2. Render environment");
  if (!cfg.renderKey) {
    warn("RENDER_API_KEY is not set; skipping automatic env setup.");
    console.log("  Add the WhatsApp vars in the Render dashboard, or set RENDER_API_KEY in .env and rerun.");
    return false;
  }

  let service;
  try {
    service = await resolveService();
  } catch (err) {
    warn(err.message);
    return false;
  }
  if (!service) return false;
  if (service.url) cfg.publicUrl = service.url;
  ok(`Service: ${service.name} (${service.id})`);
  console.log(`  Public URL: ${cfg.publicUrl}`);

  const vars = {
    WHATSAPP_TOKEN: cfg.token,
    WHATSAPP_PHONE_NUMBER_ID: cfg.phoneId,
    WHATSAPP_VERIFY_TOKEN: cfg.verifyToken,
    WHATSAPP_APP_SECRET: cfg.appSecret,
    WHATSAPP_ALLOWED_NUMBERS: cfg.allowed,
    WHATSAPP_API_VERSION: cfg.apiVersion,
    PUBLIC_URL: cfg.publicUrl,
  };

  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    await renderApi(`/services/${encodeURIComponent(service.id)}/env-vars/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
    });
    ok(`set ${key}`);
  }

  console.log("  Triggering a deploy…");
  await renderApi(`/services/${encodeURIComponent(service.id)}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  console.log("  Waiting for /healthz (free instances can take a minute)…");
  for (let i = 1; i <= 30; i++) {
    try {
      const res = await request(`${cfg.publicUrl}/healthz`);
      if (res.ok) {
        ok("Deploy is healthy.");
        return true;
      }
    } catch {
      /* cold start / still deploying */
    }
    if (i % 3 === 0) console.log(`  still waiting (${i * 10}s)…`);
    await sleep(10_000);
  }
  warn("Timed out waiting for /healthz. Check the Render deploy logs.");
  return false;
}

async function verifyCallback() {
  section("3. Public webhook challenge");
  const challenge = "wall-" + crypto.randomBytes(8).toString("hex");
  const url = new URL(`${cfg.publicUrl}/api/whatsapp/webhook`);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", cfg.verifyToken);
  url.searchParams.set("hub.challenge", challenge);
  try {
    const res = await request(url);
    const text = (await res.text()).trim();
    if (res.ok && text === challenge) {
      ok("The deployed webhook accepts the verify token.");
      return true;
    }
    warn(`Callback returned HTTP ${res.status}. The verify token on Render may be stale.`);
  } catch (err) {
    warn(`Callback check failed: ${err.message}`);
  }
  return false;
}

async function setupMetaWebhook() {
  section("4. Meta webhook subscription");
  if (!cfg.appId || !cfg.appSecret) {
    warn("WHATSAPP_APP_ID / WHATSAPP_APP_SECRET are missing; configure the webhook in Meta manually.");
    console.log("  WhatsApp → Configuration → Webhook");
    console.log(`  Callback URL: ${cfg.publicUrl}/api/whatsapp/webhook`);
    console.log("  Verify token: WHATSAPP_VERIFY_TOKEN from .env");
    console.log("  Subscribe to: messages");
    return false;
  }

  const appToken = `${cfg.appId}|${cfg.appSecret}`;
  try {
    const res = await request(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.appId}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        object: "whatsapp_business_account",
        callback_url: `${cfg.publicUrl}/api/whatsapp/webhook`,
        verify_token: cfg.verifyToken,
        fields: "messages",
        access_token: appToken,
      }),
    });
    const { data, text } = await readJson(res);
    if (!res.ok) {
      throw new Error(data && data.error ? data.error.message : `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    ok("App webhook subscription set.");
  } catch (err) {
    warn(`Could not set the app webhook: ${err.message}`);
    warn("You can still set it in the Meta dashboard (WhatsApp → Configuration).");
    return false;
  }

  if (!cfg.wabaId) {
    warn("WHATSAPP_BUSINESS_ACCOUNT_ID is missing; subscribe the WABA to the app in Meta if needed.");
    return true;
  }
  try {
    const res = await request(
      `https://graph.facebook.com/${cfg.apiVersion}/${cfg.wabaId}/subscribed_apps`,
      { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" } }
    );
    const { data, text } = await readJson(res);
    if (!res.ok) {
      throw new Error(data && data.error ? data.error.message : `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    ok("WABA subscribed to the app.");
  } catch (err) {
    warn(`Could not subscribe the WABA: ${err.message}`);
    warn("Check that the token has whatsapp_business_management permission.");
  }
  return true;
}

function printManualChecklist() {
  section("Manual values (if you skipped Render automation)");
  console.log("  Add these in Render → your service → Environment:");
  console.log(`    WHATSAPP_TOKEN=${mask(cfg.token)}`);
  console.log(`    WHATSAPP_PHONE_NUMBER_ID=${cfg.phoneId || "(missing)"}`);
  console.log("    WHATSAPP_VERIFY_TOKEN=<from .env>");
  console.log(`    WHATSAPP_APP_SECRET=${mask(cfg.appSecret)}`);
  console.log(`    WHATSAPP_ALLOWED_NUMBERS=${cfg.allowed || "(missing)"}`);
  console.log(`    WHATSAPP_API_VERSION=${cfg.apiVersion}`);
  console.log("\n  Meta webhook:");
  console.log(`    Callback URL: ${cfg.publicUrl}/api/whatsapp/webhook`);
  console.log("    Verify token: WHATSAPP_VERIFY_TOKEN from .env");
  console.log("    Fields: messages");
}

(async () => {
  line();
  console.log("WhatsApp setup for The Wall");
  line();
  console.log(`  Public URL: ${cfg.publicUrl}`);
  console.log(`  Graph API:  ${cfg.apiVersion}`);
  console.log(`  Mode:       ${ONLY_CHECK ? "check only" : "apply"}`);

  if (ONLY_CHECK) {
    const metaOk = await validateMeta();
    section("Summary");
    console.log(metaOk ? "  Meta credentials look usable." : "  Meta credentials are incomplete.");
    console.log(`  Render key: ${cfg.renderKey ? "present" : "missing"}`);
    printManualChecklist();
    return;
  }

  const metaOk = RUN_META ? await validateMeta() : true;

  let renderOk = false;
  if (RUN_RENDER) renderOk = await setupRender();

  let callbackOk = false;
  if (metaOk && cfg.token) callbackOk = await verifyCallback();

  if (RUN_META) {
    if (callbackOk) await setupMetaWebhook();
    else {
      section("4. Meta webhook subscription");
      warn("Skipped: the public callback must verify first.");
      warn("Set the env vars on Render (or provide RENDER_API_KEY) and rerun.");
    }
  }

  section("Done");
  if (metaOk && renderOk && callbackOk) {
    console.log("  WhatsApp is ready. Send a message from an allowed number.");
    console.log("  You should get an acknowledgement, then the AI card.");
  } else {
    console.log("  Setup is incomplete. Fix the warnings above and rerun:");
    console.log("    npm run whatsapp:setup");
    printManualChecklist();
  }
})().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
