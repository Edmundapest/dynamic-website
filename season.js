// Seasonal themes for Malaysian celebrations.
//
// One place decides "what time of year is it on this wall", so every device
// agrees: the server computes the active window in Kuala Lumpur time and the
// browser applies it before the page paints (/season.js is a blocking script in
// <head>, so there is no flash of the default theme).
//
// Dates are the gazetted Malaysian holidays for 2026-2027 (sourced from the
// published national holiday lists; Islamic and lunar dates are those announced
// for Malaysia and can shift by a day when the moon is sighted). Each window
// opens a few days early and lingers a day or two after, because a theme that
// only appears on the exact date is easy to miss.
//
// To add a year: append windows. Nothing else needs to change.
const SEASONS = [
  {
    id: "new-year",
    name: "New Year",
    emoji: "🎉",
    theme: "new-year",
    priority: 5,
    windows: ["2025-12-30..2026-01-02", "2026-12-30..2027-01-02", "2027-12-30..2028-01-02"],
  },
  {
    id: "thaipusam",
    name: "Thaipusam",
    emoji: "🪔",
    theme: "thaipusam",
    priority: 4,
    windows: ["2026-01-30..2026-02-03", "2027-01-20..2027-01-24"],
  },
  {
    id: "cny",
    name: "Chinese New Year",
    emoji: "🧧",
    theme: "cny",
    priority: 6,
    windows: ["2026-02-14..2026-02-21", "2027-02-04..2027-02-10"],
  },
  {
    id: "raya",
    name: "Hari Raya Aidilfitri",
    emoji: "🌙",
    theme: "raya",
    priority: 6,
    windows: ["2026-03-18..2026-03-25", "2027-03-07..2027-03-14"],
  },
  {
    id: "haji",
    name: "Hari Raya Haji",
    emoji: "🕌",
    theme: "haji",
    priority: 4,
    windows: ["2026-05-25..2026-05-29", "2027-05-15..2027-05-19"],
  },
  {
    id: "wesak",
    name: "Wesak Day",
    emoji: "🪷",
    theme: "wesak",
    priority: 5,
    windows: ["2026-05-29..2026-06-02", "2027-05-18..2027-05-22"],
  },
  {
    id: "kaamatan",
    name: "Kaamatan",
    emoji: "🌾",
    theme: "kaamatan",
    priority: 3,
    windows: ["2026-05-28..2026-06-02", "2027-05-28..2027-06-01"],
  },
  {
    id: "gawai",
    name: "Gawai Dayak",
    emoji: "🏵️",
    theme: "gawai",
    priority: 2,
    windows: ["2026-05-31..2026-06-04", "2027-05-31..2027-06-03"],
  },
  {
    id: "muharram",
    name: "Awal Muharram",
    emoji: "🌙",
    theme: "muharram",
    priority: 4,
    windows: ["2026-06-15..2026-06-18", "2027-06-04..2027-06-08"],
  },
  {
    id: "merdeka",
    name: "Merdeka",
    emoji: "🇲🇾",
    theme: "merdeka",
    priority: 6,
    windows: ["2026-08-28..2026-09-01", "2027-08-28..2027-09-01"],
  },
  {
    id: "maulidur-rasul",
    name: "Maulidur Rasul",
    emoji: "🕌",
    theme: "maulidur",
    priority: 4,
    windows: ["2026-08-23..2026-08-27", "2027-08-13..2027-08-17"],
  },
  {
    id: "malaysia-day",
    name: "Malaysia Day",
    emoji: "🇲🇾",
    theme: "malaysia-day",
    priority: 6,
    windows: ["2026-09-13..2026-09-17", "2027-09-13..2027-09-17"],
  },
  {
    id: "mid-autumn",
    name: "Mid-Autumn Festival",
    emoji: "🥮",
    theme: "mid-autumn",
    priority: 3,
    windows: ["2026-09-23..2026-09-27", "2027-09-13..2027-09-17"],
  },
  {
    id: "halloween",
    name: "Halloween",
    emoji: "🎃",
    theme: "halloween",
    priority: 4,
    windows: ["2026-10-24..2026-11-02", "2027-10-24..2027-11-02"],
  },
  {
    id: "deepavali",
    name: "Deepavali",
    emoji: "🪔",
    theme: "deepavali",
    priority: 6,
    windows: ["2026-11-06..2026-11-10", "2027-10-26..2027-10-30"],
  },
  {
    id: "christmas",
    name: "Christmas",
    emoji: "🎄",
    theme: "christmas",
    priority: 6,
    windows: ["2026-12-22..2026-12-27", "2027-12-22..2027-12-27"],
  },
];

// "Today" is the date in Kuala Lumpur, not on the server: Render runs in UTC, so
// a theme would otherwise flip at 8am Malaysian time.
function klToday(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function today() {
  // Test hook: SEASON_TODAY=2026-02-17 lets us check a date without waiting a year.
  const forced = process.env.SEASON_TODAY;
  if (forced && /^\d{4}-\d{2}-\d{2}$/.test(forced)) return forced;
  return klToday();
}

function windowsOf(season) {
  return season.windows
    .map((w) => {
      const [from, to] = String(w).split("..");
      return { from, to };
    })
    .filter((w) => w.from && w.to);
}

// The season whose window contains `date`. Overlaps resolve by priority, then by
// whichever ends soonest (so a one-day holiday beats a long festival window).
function active(date = today()) {
  const hits = [];
  for (const season of SEASONS) {
    for (const w of windowsOf(season)) {
      if (date >= w.from && date <= w.to) {
        hits.push({ season, from: w.from, to: w.to });
      }
    }
  }
  if (!hits.length) return null;
  hits.sort(
    (a, b) =>
      b.season.priority - a.season.priority ||
      a.to.localeCompare(b.to) ||
      a.season.name.localeCompare(b.season.name)
  );
  const { season, from, to } = hits[0];
  return {
    id: season.id,
    name: season.name,
    emoji: season.emoji,
    theme: season.theme,
    from,
    to,
    daysLeft: Math.max(0, Math.round((Date.parse(to) - Date.parse(date)) / 86_400_000)),
  };
}

// The next season to start after `date`, so the panel can say what's coming.
function next(date = today()) {
  let best = null;
  for (const season of SEASONS) {
    for (const w of windowsOf(season)) {
      if (w.from <= date) continue;
      if (!best || w.from < best.from) best = { season, from: w.from, to: w.to };
    }
  }
  if (!best) return null;
  return {
    id: best.season.id,
    name: best.season.name,
    emoji: best.season.emoji,
    theme: best.season.theme,
    from: best.from,
    to: best.to,
    startsIn: Math.max(0, Math.round((Date.parse(best.from) - Date.parse(date)) / 86_400_000)),
  };
}

function snapshot() {
  const date = today();
  return { date, active: active(date), next: next(date) };
}

function register(app) {
  // Public: the login page is themed too, and it must not need a session.
  app.get("/api/season", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ ok: true, ...snapshot() });
  });

  // Blocking script for <head>: sets the season before first paint.
  app.get("/season.js", (_req, res) => {
    const data = snapshot();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(`window.__SEASON=${JSON.stringify(data)};`);
  });
}

module.exports = { register, active, next, today, snapshot, SEASONS };
