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

  // --- seasonal presets -----------------------------------------------------
  // Applied on top of the reader's choice while a celebration is on (see
  // /season.js, computed by the server in Kuala Lumpur time). Picking a theme by
  // hand turns seasons off, so the wall never fights the reader.
  var SEASONAL = {
    "halloween":    { dark: true, bg: "#150a1e", bg2: "#241033", accent: "#ff7a18", accent2: "#a855f7" },
    "new-year":     { dark: true, bg: "#0b0a16", bg2: "#14122a", accent: "#ffd166", accent2: "#6c8cff" },
    "cny":          { dark: true, bg: "#1a0808", bg2: "#2a0f10", accent: "#ef4444", accent2: "#ffd166" },
    "thaipusam":    { dark: true, bg: "#1a1108", bg2: "#2b1c0c", accent: "#fbbf24", accent2: "#fb923c" },
    "raya":         { dark: true, bg: "#04160f", bg2: "#072a1a", accent: "#22c55e", accent2: "#fbbf24" },
    "haji":         { dark: true, bg: "#06140c", bg2: "#0a2416", accent: "#16a34a", accent2: "#eab308" },
    "wesak":        { dark: true, bg: "#171206", bg2: "#261d0a", accent: "#facc15", accent2: "#f97316" },
    "kaamatan":     { dark: true, bg: "#04120f", bg2: "#07211b", accent: "#34d399", accent2: "#fbbf24" },
    "gawai":        { dark: true, bg: "#140b04", bg2: "#24140a", accent: "#f59e0b", accent2: "#a3e635" },
    "muharram":     { dark: true, bg: "#08131a", bg2: "#0c2130", accent: "#38bdf8", accent2: "#a3e635" },
    "merdeka":      { dark: true, bg: "#0a1020", bg2: "#111a33", accent: "#fbbf24", accent2: "#ef4444" },
    "maulidur":     { dark: true, bg: "#07160f", bg2: "#0b2418", accent: "#34d399", accent2: "#fbbf24" },
    "malaysia-day": { dark: true, bg: "#0a1020", bg2: "#111a33", accent: "#ef4444", accent2: "#38bdf8" },
    "mid-autumn":   { dark: true, bg: "#14101f", bg2: "#211a33", accent: "#fbbf24", accent2: "#f472b6" },
    "deepavali":    { dark: true, bg: "#1a0f04", bg2: "#2b1a08", accent: "#f59e0b", accent2: "#f43f5e" },
    "christmas":    { dark: true, bg: "#07160f", bg2: "#0b2418", accent: "#ef4444", accent2: "#34d399" }
  };
  // What to say, and what to let drift down the screen, per celebration.
  var SEASON_COPY = {
    "halloween":    { line: "Something spooky is on the wall", fx: ["🎃", "🦇", "👻", "🍬", "🕸️"] },
    "new-year":     { line: "A fresh year on the wall", fx: ["🎉", "✨", "🥂"] },
    "cny":          { line: "Gong xi fa cai", fx: ["🧧", "🏮", "🍊", "✨"] },
    "thaipusam":    { line: "Happy Thaipusam", fx: ["🪔", "✨", "🌸"] },
    "raya":         { line: "Selamat Hari Raya Aidilfitri", fx: ["🌙", "⭐", "🕌"] },
    "haji":         { line: "Selamat Hari Raya Haji", fx: ["🌙", "⭐", "🕋"] },
    "wesak":        { line: "Happy Wesak", fx: ["🪷", "🕯️", "✨"] },
    "kaamatan":     { line: "Selamat Kaamatan", fx: ["🌾", "🍚", "✨"] },
    "gawai":        { line: "Gayu guru, gerai nyamai", fx: ["🏵️", "🌿", "✨"] },
    "muharram":     { line: "Selamat Tahun Baru Hijrah", fx: ["🌙", "⭐"] },
    "merdeka":      { line: "Merdeka! Merdeka! Merdeka!", fx: ["🇲🇾", "✨", "🎆"] },
    "maulidur":     { line: "Selamat Maulidur Rasul", fx: ["🕌", "🌙", "✨"] },
    "malaysia-day": { line: "Selamat Hari Malaysia", fx: ["🇲🇾", "✨", "🎆"] },
    "mid-autumn":   { line: "Happy Mid-Autumn Festival", fx: ["🥮", "🏮", "🌕"] },
    "deepavali":    { line: "Selamat Deepavali", fx: ["🪔", "✨", "🎆"] },
    "christmas":    { line: "Merry Christmas", fx: ["🎄", "❄️", "🎁"] }
  };
  var SEASON_KEY = "wall_season_off_v1";
  var season = (typeof window !== "undefined" && window.__SEASON) || null;

  function seasonEnabled() {
    try { return localStorage.getItem(SEASON_KEY) !== "1"; } catch (e) { return true; }
  }
  function setSeasonEnabled(on) {
    try { on ? localStorage.removeItem(SEASON_KEY) : localStorage.setItem(SEASON_KEY, "1"); } catch (e) {}
    apply();
    if (window.WallTheme && window.WallTheme.onSeasonChange) window.WallTheme.onSeasonChange();
  }
  function refreshSeason() {
    try {
      fetch("/api/season", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) return;
          var before = season && season.active ? season.active.id : null;
          var after = d.active ? d.active.id : null;
          season = d;
          if (before !== after) {
            apply();
            if (window.WallTheme && window.WallTheme.refreshPanel) window.WallTheme.refreshPanel();
          }
        })
        .catch(function () {});
    } catch (e) {}
  }
  // Hourly: cheap, and a season boundary is at most a day away.
  setTimeout(refreshSeason, 60 * 60 * 1000);

  function seasonTheme() {
    if (!season || !season.active || !seasonEnabled()) return null;
    var t = SEASONAL[season.active.theme];
    return t ? t : null;
  }

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
  function relLum(hex) { return luminance(hex) ; }
  function contrast(a, b) {
    var la = relLum(a), lb = relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mix(a, b, p) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    return toHex(ca.map(function (v, i) { return v + (cb[i] - v) * p; }));
  }
  // Push a colour towards the text colour until it clears the ratio on this bg.
  function readableOn(bg, color, want, towards) {
    var out = color;
    for (var i = 1; i <= 20; i++) {
      if (contrast(out, bg) >= want) return out;
      out = mix(color, towards, i / 20);
    }
    return towards;
  }

  function baseVars(dark, bg, accent, accent2) {
    if (dark) {
      return {
        "--card": "rgba(255,255,255,0.045)", "--stroke": "rgba(255,255,255,0.10)",
        "--text": "#e8ecf8", "--muted": "#8a93ad",
        "--good": "#34e39b", "--warn": "#feca57", "--bad": "#ff6b6b",
        "--input-bg": "rgba(0,0,0,.25)", "--btn-bg": "rgba(255,255,255,.06)",
        "--btn-hover": "rgba(255,255,255,.12)", "--toast-bg": "#111a30", "--hero-a": "#ffffff",
        "--scrim": "rgba(6,8,16,.62)", "--chip-text": "#ffffff"
      };
    }
    return {
      "--card": "rgba(0,0,0,0.035)", "--stroke": "rgba(0,0,0,0.12)",
      "--text": "#1b2233", "--muted": "#5a6478",
      "--good": "#0f9d63", "--warn": "#b7791f", "--bad": "#d64545",
      "--input-bg": "rgba(255,255,255,0.82)", "--btn-bg": "rgba(0,0,0,0.05)",
      "--btn-hover": "rgba(0,0,0,0.10)", "--toast-bg": "#ffffff", "--hero-a": "#0f172a",
      "--scrim": "rgba(6,8,16,.62)", "--chip-text": "#ffffff"
    };
  }

  function buildVars(t) {
    var v = baseVars(!!t.dark, t.bg, t.accent, t.accent2);
    v["--bg"] = t.bg;
    v["--bg2"] = t.bg2;
    v["--bg2-rgb"] = rgbTriple(t.bg2);
    v["--accent"] = t.accent;
    v["--accent2"] = t.accent2;
    v["--accent-rgb"] = rgbTriple(t.accent);
    v["--glow-a"] = rgbTriple(t.accent);
    v["--glow-b"] = rgbTriple(t.accent2);
    v["--glow-c"] = rgbTriple(t.accent2);
    v["--hero-b"] = t.accent2;
    v["--hero-c"] = t.accent;

    // Text colour chosen by measurement, not by a dark/light flag: a custom or
    // seasonal background can sit anywhere on the scale, and white-on-cream was
    // exactly the "I can't see the text" case.
    var lightText = "#f4f7ff", darkText = "#141a28";
    var useLight = contrast(lightText, t.bg) >= contrast(darkText, t.bg);
    var text = useLight ? lightText : darkText;
    var toward = useLight ? "#ffffff" : "#000000";
    v["--text"] = text;
    v["--text-strong"] = useLight ? "#ffffff" : "#0a0f18";
    v["--muted"] = readableOn(t.bg, mix(text, t.bg, 0.42), 4.6, toward);
    // Links and labels tinted with the accent, but never below 4.5:1.
    v["--accent-ink"] = readableOn(t.bg, t.accent2, 4.5, toward);
    v["--accent-ink-2"] = readableOn(t.bg, t.accent, 4.5, toward);
    v["--hero-a"] = useLight ? "#ffffff" : "#0f172a";
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
    var seasonal = seasonTheme();
    var t = seasonal || currentTheme();
    applyVars(buildVars(t));
    updateIconLinks(t);
    applyWallpaper();
    markSeason(!!seasonal);
  }

  // Season marker for CSS hooks + a seasonal emoji in the header logo.
  function markSeason(on) {
    if (!season || !season.active) {
      root.removeAttribute("data-season");
      root.removeAttribute("data-season-name");
      setLogo(LOGO_DEFAULT);
      renderKicker(false);
      renderFx(false);
      return;
    }
    if (on) {
      root.setAttribute("data-season", season.active.id);
      root.setAttribute("data-season-name", season.active.name);
      setLogo(season.active.emoji);
    } else {
      root.removeAttribute("data-season");
      root.removeAttribute("data-season-name");
      setLogo(LOGO_DEFAULT);
    }
    renderKicker(on);
    renderFx(on);
  }
  var LOGO_DEFAULT = "🧱";

  // The line above the hero title: seasonal when one is on, plain otherwise.
  function renderKicker(seasonal) {
    var kicker = document.getElementById("seasonKicker");
    if (!kicker) return;
    if (seasonal && season && season.active) {
      var copy = SEASON_COPY[season.active.id] || {};
      kicker.textContent = copy.line
        ? copy.line + " · " + season.active.name
        : season.active.name + " on the wall";
    } else if (season && season.next) {
      kicker.textContent = "A private wall · next up " + season.next.emoji + " " + season.next.name;
    } else {
      kicker.textContent = "A private wall · links & notes";
    }
  }

  // A slow drift of emoji above the feed. Skipped entirely when the reader asks
  // for reduced motion, and kept light on phones.
  function renderFx(seasonal) {
    var layer = document.getElementById("seasonfx");
    if (!seasonal || !season || !season.active) {
      if (layer) layer.remove();
      return;
    }
    if (!document.body) return; // called from apply() in <head>; buildUI re-runs it
    var reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    var narrow = window.innerWidth < 560;
    var set = (SEASON_COPY[season.active.id] || {}).fx || [season.active.emoji];
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "seasonfx";
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
    }
    layer.textContent = "";
    if (reduce) { layer.remove(); return; }
    var count = narrow ? 4 : 7;
    for (var i = 0; i < count; i++) {
      var sp = document.createElement("span");
      sp.textContent = set[i % set.length];
      sp.style.setProperty("--x", Math.round((i + 0.5) * (100 / count) + (Math.random() * 8 - 4)) + "vw");
      sp.style.setProperty("--sz", (narrow ? 14 : 18) + Math.round(Math.random() * 12) + "px");
      sp.style.setProperty("--dur", (16 + Math.random() * 14).toFixed(1) + "s");
      sp.style.setProperty("--d", (-Math.random() * 18).toFixed(1) + "s");
      sp.style.setProperty("--o", (0.3 + Math.random() * 0.3).toFixed(2));
      sp.style.setProperty("--dx", Math.round(Math.random() * 120 - 60) + "px");
      sp.style.setProperty("--rot", Math.round(Math.random() * 320 - 160) + "deg");
      layer.appendChild(sp);
    }
  }
  function setLogo(text) {
    var logo = document.querySelector(".logo");
    if (!logo) return;
    if (logo.textContent !== text) logo.textContent = text;
    logo.title = season && season.active && seasonEnabled() ? season.active.name : "The Wall";
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
      "@media (max-width:560px){#wt-fab{right:12px;bottom:12px;width:42px;height:42px;border-radius:12px;font-size:19px}",
      "#wt-panel{right:12px;bottom:62px;width:calc(100vw - 24px);max-height:64vh}}",
      "#wt-panel h3{margin:0 0 10px;font-size:14px;letter-spacing:.2px}",
      "#wt-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}",
      ".wt-sw{display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px;border-radius:10px;",
      "border:1px solid var(--stroke);background:var(--btn-bg);color:var(--text);font:inherit;font-size:12px;text-align:left}",
      ".wt-sw:hover{background:var(--btn-hover)}",
      ".wt-sw.active{border-color:var(--accent)}",
      ".wt-chip{width:26px;height:18px;border-radius:6px;flex:none;border:1px solid var(--stroke);overflow:hidden;display:block}",
      ".wt-chip i{display:block;height:100%;width:100%;background:linear-gradient(135deg,var(--a),var(--b))}",
      "#wt-season{margin-bottom:12px;padding:10px;border-radius:10px;border:1px dashed var(--stroke);",
      "background:rgba(108,140,255,.08)}",
      "#wt-season label{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;cursor:pointer}",
      "#wt-season .wt-credit{color:var(--muted);font-size:11.5px;margin-top:6px;line-height:1.45}",
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

    // Seasonal theme (Malaysian celebrations). On by default while one is live.
    var seasonBox = el("div");
    seasonBox.id = "wt-season";
    var seasonLabel = el("label");
    var seasonCb = document.createElement("input");
    seasonCb.type = "checkbox";
    seasonCb.checked = seasonEnabled();
    seasonLabel.appendChild(seasonCb);
    var seasonText = el("span");
    seasonLabel.appendChild(seasonText);
    seasonBox.appendChild(seasonLabel);
    var seasonHint = el("div", "wt-credit");
    seasonBox.appendChild(seasonHint);

    function shortDay(iso) {
      try {
        return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, {
          day: "numeric", month: "short", timeZone: "UTC"
        });
      } catch (e) { return iso; }
    }
    function renderSeason() {
      var on = !!(season && season.active);
      seasonBox.style.display = on ? "" : "none";
      if (!on) return;
      seasonText.textContent = season.active.emoji + " " + season.active.name + " theme";
      seasonHint.textContent =
        "Seasonal until " + shortDay(season.active.to) + ". Picking a theme below turns this off." +
        (season.next ? " Next up: " + season.next.emoji + " " + season.next.name + "." : "");
    }
    seasonCb.onchange = function () {
      setSeasonEnabled(seasonCb.checked);
      markActive();
    };
    window.WallTheme = window.WallTheme || {};
    window.WallTheme.refreshPanel = function () {
      seasonCb.checked = seasonEnabled();
      markActive();
    };
    panel.appendChild(seasonBox);

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
        save();
        setSeasonEnabled(false); // an explicit pick wins over the season
        seasonCb.checked = false;
        apply();
        markActive();
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
      save();
      setSeasonEnabled(false);
      seasonCb.checked = false;
      apply();
      markActive();
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
      save();
      setSeasonEnabled(false);
      seasonCb.checked = false;
      apply();
      markActive();
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
      var seasonal = !!seasonTheme();
      var kids = grid.querySelectorAll(".wt-sw");
      for (var i = 0; i < kids.length; i++) {
        kids[i].classList.toggle(
          "active",
          !seasonal && state.type === "preset" && kids[i].dataset.id === state.id
        );
      }
      renderSeason();
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
    markSeason(!!seasonTheme());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildUI);
  } else {
    buildUI();
  }

  // Expose a tiny API for debugging / tests.
  window.WallTheme = {
    themes: THEMES,
    season: season,
    get: function () { return state; },
    set: function (s) { state = s; save(); apply(); },
    seasonEnabled: seasonEnabled,
    setSeasonEnabled: setSeasonEnabled
  };
})();
