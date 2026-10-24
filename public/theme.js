/* Per-browser theme system for The Wall.
 *
 * - 24 preset themes (dark + light) plus a custom RGB picker (accent, accent2,
 *   background — text/surfaces are derived from the background's luminance).
 * - The choice is saved in localStorage, so each browser/device keeps its own
 *   look. This app has a single shared password and no user accounts, so
 *   localStorage is the right "per person" store (no server round-trip).
 * - Applied as CSS custom properties on <html>, which override the page's :root.
 *
 * Load it in <head> (before the body paints) so there's no flash of the
 * default theme.
 */
(function () {
  "use strict";

  var KEY = "wall_theme_v1";
  var root = document.documentElement;

  // --- color helpers -------------------------------------------------------
  function hexToRgb(hex) {
    var h = String(hex || "#000").replace("#", "");
    if (h.length === 3) h = h.replace(/(.)/g, "$1$1");
    var n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function toHex(rgb) {
    return "#" + rgb.map(function (v) { return clamp255(v).toString(16).padStart(2, "0"); }).join("");
  }
  function rgbTriple(hex) { return hexToRgb(hex).join(","); }
  function shade(hex, amount) { // amount > 0 lightens toward white, < 0 darkens
    var c = hexToRgb(hex), target = amount > 0 ? 255 : 0, p = Math.abs(amount);
    return toHex(c.map(function (v) { return v + (target - v) * p; }));
  }
  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // --- presets -------------------------------------------------------------
  var THEMES = [
    { id: "midnight",  name: "Midnight",  dark: true,  bg: "#0a0e1a", bg2: "#0e1428", accent: "#6c8cff", accent2: "#22d3ee" },
    { id: "nebula",    name: "Nebula",    dark: true,  bg: "#140a24", bg2: "#1d0f33", accent: "#a855f7", accent2: "#f472b6" },
    { id: "emerald",   name: "Emerald",   dark: true,  bg: "#04160f", bg2: "#06251a", accent: "#10b981", accent2: "#34d399" },
    { id: "sunset",    name: "Sunset",    dark: true,  bg: "#1a0f0a", bg2: "#2a170d", accent: "#ff7a45", accent2: "#ffd166" },
    { id: "ocean",     name: "Ocean",     dark: true,  bg: "#04121f", bg2: "#062033", accent: "#38bdf8", accent2: "#22d3ee" },
    { id: "crimson",   name: "Crimson",   dark: true,  bg: "#1a0a0d", bg2: "#2a0f14", accent: "#ef4444", accent2: "#fb7185" },
    { id: "cyberpunk", name: "Cyberpunk", dark: true,  bg: "#0b0518", bg2: "#160a2b", accent: "#ff2e97", accent2: "#f9d423" },
    { id: "forest",    name: "Forest",    dark: true,  bg: "#07140b", bg2: "#0c2213", accent: "#4ade80", accent2: "#a3e635" },
    { id: "mono",      name: "Mono",      dark: true,  bg: "#0d0d0f", bg2: "#16161a", accent: "#9ca3af", accent2: "#e5e7eb" },
    { id: "amber",     name: "Amber",     dark: true,  bg: "#170f04", bg2: "#26180a", accent: "#f59e0b", accent2: "#fbbf24" },
    { id: "aurora",    name: "Aurora",    dark: true,  bg: "#06131a", bg2: "#0a1f2b", accent: "#22d3ee", accent2: "#a78bfa" },
    { id: "slate",     name: "Slate",     dark: true,  bg: "#0f172a", bg2: "#1e293b", accent: "#60a5fa", accent2: "#94a3b8" },
    { id: "rose",      name: "Rose",      dark: true,  bg: "#1a0d13", bg2: "#2a1420", accent: "#f43f5e", accent2: "#fb923c" },
    { id: "indigo",    name: "Indigo",    dark: true,  bg: "#0d0b1f", bg2: "#171436", accent: "#6366f1", accent2: "#818cf8" },
    { id: "teal",      name: "Teal",      dark: true,  bg: "#04161a", bg2: "#07262c", accent: "#14b8a6", accent2: "#5eead4" },
    { id: "daybreak",  name: "Daybreak",  dark: false, bg: "#f4f7ff", bg2: "#e6ecfb", accent: "#3b6ef6", accent2: "#0ea5e9" },
    { id: "paper",     name: "Paper",     dark: false, bg: "#f7f3ea", bg2: "#efe8da", accent: "#b45309", accent2: "#d97706" },
    { id: "mint",      name: "Mint",      dark: false, bg: "#f0fbf4", bg2: "#dcf5e6", accent: "#059669", accent2: "#10b981" },
    { id: "sky",       name: "Sky",       dark: false, bg: "#eef7ff", bg2: "#d9ecff", accent: "#0284c7", accent2: "#38bdf8" },
    { id: "lavender",  name: "Lavender",  dark: false, bg: "#f6f2ff", bg2: "#e9e0ff", accent: "#7c3aed", accent2: "#c026d3" },
    { id: "sand",      name: "Sand",      dark: false, bg: "#faf5ec", bg2: "#f0e6d2", accent: "#a16207", accent2: "#ca8a04" },
    { id: "cloud",     name: "Cloud",     dark: false, bg: "#f5f6f8", bg2: "#e7e9ee", accent: "#475569", accent2: "#64748b" },
    { id: "peach",     name: "Peach",     dark: false, bg: "#fff4ee", bg2: "#ffe4d6", accent: "#ea580c", accent2: "#fb7185" },
    { id: "matcha",    name: "Matcha",    dark: false, bg: "#f4faf0", bg2: "#e3f2d8", accent: "#4d7c0f", accent2: "#65a30d" }
  ];

  // --- variables -----------------------------------------------------------
  function baseVars(dark) {
    if (dark) {
      return {
        "--card": "rgba(255,255,255,0.045)", "--stroke": "rgba(255,255,255,0.10)",
        "--text": "#e8ecf8", "--muted": "#8a93ad",
        "--good": "#34e39b", "--warn": "#feca57", "--bad": "#ff6b6b",
        "--input-bg": "rgba(0,0,0,.25)", "--btn-bg": "rgba(255,255,255,.06)",
        "--btn-hover": "rgba(255,255,255,.12)", "--toast-bg": "#111a30", "--hero-a": "#ffffff"
      };
    }
    return {
      "--card": "rgba(0,0,0,0.035)", "--stroke": "rgba(0,0,0,0.12)",
      "--text": "#1b2233", "--muted": "#5a6478",
      "--good": "#0f9d63", "--warn": "#b7791f", "--bad": "#d64545",
      "--input-bg": "rgba(255,255,255,0.82)", "--btn-bg": "rgba(0,0,0,0.05)",
      "--btn-hover": "rgba(0,0,0,0.10)", "--toast-bg": "#ffffff", "--hero-a": "#0f172a"
    };
  }

  function buildVars(t) {
    var v = baseVars(!!t.dark);
    v["--bg"] = t.bg;
    v["--bg2"] = t.bg2;
    v["--accent"] = t.accent;
    v["--accent2"] = t.accent2;
    v["--glow-a"] = rgbTriple(t.accent);
    v["--glow-b"] = rgbTriple(t.accent2);
    v["--glow-c"] = rgbTriple(t.accent2);
    v["--hero-b"] = t.accent2;
    v["--hero-c"] = t.accent;
    return v;
  }

  function applyVars(vars) {
    Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
  }

  // Point the favicon, Apple touch icon and PWA manifest at a themed icon, so
  // the browser tab and a FRESH "Add to Home Screen" match the chosen colors.
  // (An icon already on a home screen cannot change — the OS caches it.)
  function setLink(rel, href) {
    var link = document.querySelector('link[rel="' + rel + '"]');
    if (!link) { link = document.createElement("link"); link.rel = rel; document.head.appendChild(link); }
    link.href = href;
  }
  function updateIconLinks(t) {
    var q = "accent=" + encodeURIComponent(t.accent) +
            "&accent2=" + encodeURIComponent(t.accent2) +
            "&bg=" + encodeURIComponent(t.bg);
    setLink("icon", "/icon.png?size=64&" + q);
    setLink("apple-touch-icon", "/icon.png?size=180&" + q);
    setLink("manifest", "/manifest.webmanifest?" + q);
  }

  // --- state ---------------------------------------------------------------
  var state = load() || { type: "preset", id: "midnight" };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function presetById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }
  function currentTheme() {
    if (state.type === "custom") {
      var dark = luminance(state.bg) < 0.5;
      return {
        dark: dark,
        bg: state.bg,
        bg2: shade(state.bg, dark ? 0.06 : -0.05),
        accent: state.accent,
        accent2: state.accent2
      };
    }
    return presetById(state.id);
  }
  function apply() {
    var t = currentTheme();
    applyVars(buildVars(t));
    updateIconLinks(t);
    applyWallpaper();
  }

  // --- daily Bing wallpaper ------------------------------------------------
  // The server resolves today's image (bing.gifposter.com, with Bing's own
  // archive as a fallback) and the browser paints it behind the theme as a
  // fixed layer, topped by a theme-tinted gradient so text stays readable.
  var WALL_KEY = "wall_wallpaper_v1";
  var WALL_REFRESH_MS = 60 * 60 * 1000;
  var WALL_RETRY_MS = 10 * 60 * 1000;
  var wallData = null;
  var wallLastTry = 0;

  function wallpaperEnabled() {
    try { return localStorage.getItem(WALL_KEY) !== "off"; } catch (e) { return true; }
  }
  function setWallpaperEnabled(on) {
    try {
      if (on) localStorage.removeItem(WALL_KEY);
      else localStorage.setItem(WALL_KEY, "off");
    } catch (e) { /* private mode */ }
  }
  function applyWallpaper() {
    if (!wallData || !wallData.url || !wallpaperEnabled()) {
      root.classList.remove("has-wallpaper");
      renderWallCredit();
      return;
    }
    var t = currentTheme();
    root.style.setProperty("--wall-rgb", hexToRgb(t.bg).join(","));
    root.style.setProperty("--wall-top", t.dark ? "0.72" : "0.80");
    root.style.setProperty("--wall-bottom", t.dark ? "0.88" : "0.92");
    var url = String(wallData.url).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    root.style.setProperty("--wallpaper", 'url("' + url + '")');
    root.classList.add("has-wallpaper");
    renderWallCredit();
  }
  function loadWallpaper(force) {
    if (!wallpaperEnabled()) return;
    if (!force && Date.now() - wallLastTry < WALL_RETRY_MS) return;
    wallLastTry = Date.now();
    fetch("/api/wallpaper", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.ok && d.url) { wallData = d; applyWallpaper(); }
      })
      .catch(function () { /* keep the theme background */ });
  }
  function renderWallCredit() {
    var box = document.getElementById("wt-wall-credit");
    if (!box) return;
    box.textContent = "";
    if (!wallpaperEnabled()) {
      box.textContent = "Daily wallpaper is off for this device.";
      return;
    }
    if (!wallData) {
      box.textContent = "Loading today's Bing wallpaper…";
      return;
    }
    box.appendChild(document.createTextNode(wallData.title || "Bing image of the day"));
    if (wallData.copyright) {
      box.appendChild(document.createTextNode(" · " + wallData.copyright));
    }
    var a = document.createElement("a");
    a.href = wallData.page || "https://bing.gifposter.com/";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = " bing.gifposter.com";
    box.appendChild(a);
  }
  function injectWallpaperCSS() {
    if (document.getElementById("wt-wall-css")) return;
    var s = document.createElement("style");
    s.id = "wt-wall-css";
    s.textContent = [
      "html.has-wallpaper body::before{content:'';position:fixed;top:0;right:0;bottom:0;left:0;",
      "z-index:-1;pointer-events:none;background-image:",
      "radial-gradient(1100px 600px at 12% -8%,rgba(var(--glow-a),0.18),transparent 60%),",
      "radial-gradient(900px 500px at 100% 0%,rgba(var(--glow-b),0.12),transparent 55%),",
      "radial-gradient(900px 700px at 50% 130%,rgba(var(--glow-c),0.08),transparent 60%),",
      "linear-gradient(180deg,rgba(var(--wall-rgb),var(--wall-top)),rgba(var(--wall-rgb),var(--wall-bottom))),var(--wallpaper);",
      "background-size:auto,auto,auto,auto,cover;background-position:center,center,center,center,center;",
      "background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,no-repeat}",
      "@media (prefers-reduced-motion: no-preference){html.has-wallpaper body::before{animation:wt-wall-fade .6s ease both}}",
      "@keyframes wt-wall-fade{from{opacity:0}to{opacity:1}}"
    ].join("");
    document.head.appendChild(s);
  }

  injectWallpaperCSS();
  // Apply immediately (script sits in <head>, before the body paints).
  apply();
  loadWallpaper(true);
  setInterval(function () { loadWallpaper(true); }, WALL_REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadWallpaper(false);
  });

  // --- picker UI -----------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildUI() {
    if (document.getElementById("wt-ui")) return;

    var style = el("style");
    style.textContent = [
      "#wt-fab{position:fixed;right:18px;bottom:18px;z-index:60;width:48px;height:48px;border-radius:14px;",
      "cursor:pointer;font-size:22px;line-height:1;border:1px solid var(--stroke);background:var(--card);",
      "color:var(--text);backdrop-filter:blur(8px);box-shadow:0 10px 30px rgba(0,0,0,.35);display:grid;place-items:center}",
      "#wt-fab:hover{background:var(--btn-hover)}",
      "#wt-panel{position:fixed;right:18px;bottom:78px;z-index:61;width:min(340px,calc(100vw - 36px));max-height:70vh;",
      "overflow:auto;background:var(--card);border:1px solid var(--stroke);border-radius:16px;padding:14px;",
      "backdrop-filter:blur(12px);box-shadow:0 24px 60px rgba(0,0,0,.45);display:none}",
      "#wt-panel.open{display:block}",
      "#wt-panel h3{margin:0 0 10px;font-size:14px;letter-spacing:.2px}",
      "#wt-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}",
      ".wt-sw{display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px;border-radius:10px;",
      "border:1px solid var(--stroke);background:var(--btn-bg);color:var(--text);font:inherit;font-size:12px;text-align:left}",
      ".wt-sw:hover{background:var(--btn-hover)}",
      ".wt-sw.active{border-color:var(--accent)}",
      ".wt-chip{width:26px;height:18px;border-radius:6px;flex:none;border:1px solid var(--stroke);overflow:hidden;display:block}",
      ".wt-chip i{display:block;height:100%;width:100%;background:linear-gradient(135deg,var(--a),var(--b))}",
      "#wt-custom{margin-top:14px;border-top:1px solid var(--stroke);padding-top:12px}",
      "#wt-custom .wt-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;font-size:12.5px}",
      "#wt-custom input[type=color]{width:44px;height:28px;padding:0;border:1px solid var(--stroke);border-radius:8px;background:none;cursor:pointer}",
      "#wt-wall{margin-top:14px;border-top:1px solid var(--stroke);padding-top:12px}",
      "#wt-wall label{display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer}",
      "#wt-wall .wt-credit{color:var(--muted);font-size:11.5px;margin-top:6px;line-height:1.45}",
      "#wt-wall .wt-credit a{color:var(--accent2);text-decoration:none}",
      "#wt-wall .wt-credit a:hover{text-decoration:underline}",
      "#wt-reset{margin-top:10px;width:100%;padding:8px;border-radius:10px;border:1px solid var(--stroke);",
      "background:var(--btn-bg);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer}",
      "#wt-reset:hover{background:var(--btn-hover)}",
      ".wt-hint{color:var(--muted);font-size:11.5px;margin:8px 0 0}"
    ].join("");

    var fab = el("button", null, "🎨");
    fab.id = "wt-fab";
    fab.type = "button";
    fab.title = "Theme";
    fab.setAttribute("aria-label", "Change theme");

    var panel = el("div");
    panel.id = "wt-panel";
    panel.appendChild(el("h3", null, "Theme"));
    panel.appendChild(el("p", null, "Saved on this device only.")).className = "wt-hint";

    var grid = el("div");
    grid.id = "wt-grid";
    THEMES.forEach(function (t) {
      var b = el("button", "wt-sw");
      b.type = "button";
      b.dataset.id = t.id;
      var chip = el("span", "wt-chip");
      chip.style.background = t.bg;
      var strip = el("i");
      strip.style.setProperty("--a", t.accent);
      strip.style.setProperty("--b", t.accent2);
      chip.appendChild(strip);
      b.appendChild(chip);
      b.appendChild(el("span", null, t.name));
      b.onclick = function () {
        state = { type: "preset", id: t.id };
        save(); apply(); markActive();
      };
      grid.appendChild(b);
    });
    panel.appendChild(grid);

    // Custom RGB section.
    var custom = el("div");
    custom.id = "wt-custom";
    var cur = currentTheme();
    function colorRow(label, value, onInput) {
      var row = el("div", "wt-row");
      row.appendChild(el("span", null, label));
      var input = document.createElement("input");
      input.type = "color";
      input.value = value;
      input.oninput = function () { onInput(input.value); };
      row.appendChild(input);
      return row;
    }
    function setCustom() {
      state = {
        type: "custom",
        accent: state.accent || "#6c8cff",
        accent2: state.accent2 || "#22d3ee",
        bg: state.bg || "#0a0e1a"
      };
      save(); apply(); markActive();
    }
    // Seed the pickers from the current theme so edits start from it.
    state.accent = cur.accent; state.accent2 = cur.accent2; state.bg = cur.bg;
    custom.appendChild(colorRow("Accent", cur.accent, function (v) { state.accent = v; setCustom(); }));
    custom.appendChild(colorRow("Accent 2", cur.accent2, function (v) { state.accent2 = v; setCustom(); }));
    custom.appendChild(colorRow("Background", cur.bg, function (v) { state.bg = v; setCustom(); }));
    var reset = el("button", null, "Reset to Midnight");
    reset.id = "wt-reset";
    reset.type = "button";
    reset.onclick = function () {
      state = { type: "preset", id: "midnight" };
      save(); apply(); markActive();
      buildColorInputs();
    };
    custom.appendChild(reset);
    custom.appendChild(el("p", "wt-hint", "Text and surfaces adapt to the background automatically."));
    panel.appendChild(custom);

    // Daily wallpaper, with today's title/credit.
    var wall = el("div");
    wall.id = "wt-wall";
    var wallLabel = el("label");
    var wallCb = document.createElement("input");
    wallCb.type = "checkbox";
    wallCb.checked = wallpaperEnabled();
    wallCb.onchange = function () {
      setWallpaperEnabled(wallCb.checked);
      applyWallpaper();
      if (wallCb.checked && !wallData) loadWallpaper(true);
    };
    wallLabel.appendChild(wallCb);
    wallLabel.appendChild(el("span", null, "Daily Bing wallpaper"));
    wall.appendChild(wallLabel);
    var wallCredit = el("div", "wt-credit");
    wallCredit.id = "wt-wall-credit";
    wall.appendChild(wallCredit);
    panel.appendChild(wall);

    function markActive() {
      var kids = grid.querySelectorAll(".wt-sw");
      for (var i = 0; i < kids.length; i++) {
        kids[i].classList.toggle("active", state.type === "preset" && kids[i].dataset.id === state.id);
      }
    }
    // Re-seed the color inputs when the theme changes via reset/other means.
    function buildColorInputs() {
      var inputs = custom.querySelectorAll("input[type=color]");
      var c = currentTheme();
      if (inputs[0]) inputs[0].value = c.accent;
      if (inputs[1]) inputs[1].value = c.accent2;
      if (inputs[2]) inputs[2].value = c.bg;
      state.accent = c.accent; state.accent2 = c.accent2; state.bg = c.bg;
    }
    panel._buildColorInputs = buildColorInputs;

    fab.onclick = function () {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) { markActive(); panel._buildColorInputs(); }
    };
    // Close when clicking outside the panel/fab.
    document.addEventListener("click", function (e) {
      if (!panel.classList.contains("open")) return;
      if (panel.contains(e.target) || fab.contains(e.target)) return;
      panel.classList.remove("open");
    });

    markActive();
    document.head.appendChild(style);
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    renderWallCredit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildUI);
  } else {
    buildUI();
  }

  // Expose a tiny API for debugging / tests.
  window.WallTheme = {
    themes: THEMES,
    get: function () { return state; },
    set: function (s) { state = s; save(); apply(); }
  };
})();
