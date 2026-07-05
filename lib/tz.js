// DST-safe timezone helpers built on Intl — no dependencies.
// Everything internal is epoch ms (UTC); named timezones only enter/exit here.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// What wall-clock does this epoch ms show in tz? → {y,m,d,hh,mm,ss}
function wallClock(ms, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(ms)) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour % 24, mm: +parts.minute, ss: +parts.second,
  };
}

// Offset (ms) of tz at the given instant: wall-as-UTC minus actual UTC.
function tzOffset(ms, tz) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(ms / 1000) * 1000;
}

// Epoch ms for a wall-clock time in a named tz. Two-pass to converge across
// DST transitions (nonexistent times land on the post-transition offset).
function zonedToUtc(y, m, d, hh, mm, tz) {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  let ts = asUtc - tzOffset(asUtc, tz);
  const off2 = tzOffset(ts, tz);
  if (asUtc - off2 !== ts) ts = asUtc - off2;
  return ts;
}

// "YYYY-MM-DD" of an instant, as seen in tz. (Used for daily-cap day keys.)
function dayKey(ms, tz) {
  const w = wallClock(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

// Lowercase 3-letter weekday of an instant in tz: "mon".."sun"
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function weekday(ms, tz) {
  const w = wallClock(ms, tz);
  // Day-of-week from the civil date via a UTC Date on that date.
  return WEEKDAYS[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
}

// Parse "HH:MM" → {hh, mm}
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time "${s}", expected HH:MM`);
  return { hh: +m[1], mm: +m[2] };
}

module.exports = { wallClock, tzOffset, zonedToUtc, dayKey, weekday, parseHHMM };
