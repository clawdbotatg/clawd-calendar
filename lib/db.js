// SQLite (node:sqlite, zero deps) — event types (routes), tokens
// (passwords/links) + bookings log. The local bookings log is the daily-cap
// fast path; Google Calendar stays the source of truth for busy time.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = process.env.CAL_DB || path.join(__dirname, "..", "data", "cal.db");

// Route keys that can never be event types ("a" = the built-in default type;
// the rest shadow real routes).
const RESERVED_KEYS = ["a", "admin", "api", "oauth", "healthz", "assets", "public", "data"];

let db;
function open() {
  if (db) return db;
  require("node:fs").mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tokens (
      token          TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      tier           TEXT NOT NULL DEFAULT 'standard',  -- standard | vip | override
      bypassDailyCap INTEGER,      -- NULL = tier default
      ignoreBusy     INTEGER,      -- NULL = tier default
      windowOverride TEXT,         -- JSON {days,start,end} or NULL
      durationMin    INTEGER,
      maxUses        INTEGER,      -- NULL = unlimited
      uses           INTEGER NOT NULL DEFAULT 0,
      disabled       INTEGER NOT NULL DEFAULT 0,
      createdAt      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token        TEXT NOT NULL,
      guestName    TEXT NOT NULL,
      guestEmail   TEXT NOT NULL,
      note         TEXT,
      startUtc     TEXT NOT NULL,
      endUtc       TEXT NOT NULL,
      ownerDayKey  TEXT NOT NULL,  -- YYYY-MM-DD in owner TZ, for the daily cap
      gcalEventId  TEXT,
      meetLink     TEXT,
      status       TEXT NOT NULL DEFAULT 'booked',
      createdAt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings(ownerDayKey, status);
    CREATE TABLE IF NOT EXISTS event_types (
      key             TEXT PRIMARY KEY,  -- URL route: /<key>/<password>
      label           TEXT NOT NULL,
      durationMin     INTEGER,           -- NULL = config default; same for the rest
      stepMinutes     INTEGER,
      window          TEXT,              -- JSON {days,start,end}
      dailyCap        INTEGER,           -- counted per-type, not shared
      minNoticeHours  REAL,
      maxDaysOut      INTEGER,
      eventTitle      TEXT,              -- calendar event summary, {name} substituted
      pageTitle       TEXT,
      pageSubtitle    TEXT,
      pageDescription TEXT,
      accentColor     TEXT,              -- #rrggbb page accent
      disabled        INTEGER NOT NULL DEFAULT 0,
      createdAt       TEXT NOT NULL
    );
  `);
  // Migrations for dbs created before event types existed. typeKey NULL =
  // the built-in default type (route /a/).
  ensureColumn("tokens", "typeKey", "TEXT");
  ensureColumn("bookings", "typeKey", "TEXT");
  return db;
}

function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

function getToken(token) {
  const row = open().prepare(`SELECT * FROM tokens WHERE token = ? AND disabled = 0`).get(token);
  if (!row) return null;
  if (row.maxUses != null && row.uses >= row.maxUses) return null;
  return {
    ...row,
    bypassDailyCap: row.bypassDailyCap == null ? null : !!row.bypassDailyCap,
    ignoreBusy: row.ignoreBusy == null ? null : !!row.ignoreBusy,
    windowOverride: row.windowOverride ? JSON.parse(row.windowOverride) : null,
  };
}

// ── event types ──────────────────────────────────────────────────────────

// Enabled types only — a disabled type kills its links at lookup time.
function getType(key) {
  if (!key) return null;
  const row = open().prepare(`SELECT * FROM event_types WHERE key = ? AND disabled = 0`).get(key);
  return row ? { ...row, window: row.window ? JSON.parse(row.window) : null } : null;
}

function createType(t) {
  open().prepare(`
    INSERT INTO event_types (key, label, durationMin, stepMinutes, window, dailyCap,
      minNoticeHours, maxDaysOut, eventTitle, pageTitle, pageSubtitle, pageDescription,
      accentColor, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.key, t.label, t.durationMin ?? null, t.stepMinutes ?? null,
    t.window ? JSON.stringify(t.window) : null, t.dailyCap ?? null,
    t.minNoticeHours ?? null, t.maxDaysOut ?? null, t.eventTitle ?? null,
    t.pageTitle ?? null, t.pageSubtitle ?? null, t.pageDescription ?? null,
    t.accentColor ?? null, new Date().toISOString());
}

function listTypes() {
  return open().prepare(`SELECT * FROM event_types ORDER BY createdAt`).all();
}

function setTypeDisabled(key, disabled) {
  return open().prepare(`UPDATE event_types SET disabled = ? WHERE key = ?`).run(disabled ? 1 : 0, key).changes > 0;
}

function createToken({ token, label, tier = "standard", typeKey = null, bypassDailyCap = null, ignoreBusy = null, windowOverride = null, durationMin = null, maxUses = null }) {
  open().prepare(`
    INSERT INTO tokens (token, label, tier, typeKey, bypassDailyCap, ignoreBusy, windowOverride, durationMin, maxUses, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, label, tier, typeKey,
    bypassDailyCap == null ? null : bypassDailyCap ? 1 : 0,
    ignoreBusy == null ? null : ignoreBusy ? 1 : 0,
    windowOverride ? JSON.stringify(windowOverride) : null,
    durationMin, maxUses, new Date().toISOString());
}

function listTokens() {
  return open().prepare(`SELECT * FROM tokens ORDER BY createdAt`).all();
}

function setTokenDisabled(token, disabled) {
  return open().prepare(`UPDATE tokens SET disabled = ? WHERE token = ?`).run(disabled ? 1 : 0, token).changes > 0;
}

// { ownerDayKey → count } of active tool-booked events, for the daily cap.
// Caps count per event type (typeKey NULL = the default type), so office
// hours filling up doesn't consume the one-call-per-day budget.
function bookedByDay(typeKey = null) {
  const rows = open().prepare(
    `SELECT ownerDayKey, COUNT(*) AS n FROM bookings WHERE status = 'booked' AND typeKey IS ? GROUP BY ownerDayKey`
  ).all(typeKey);
  const out = {};
  for (const r of rows) out[r.ownerDayKey] = r.n;
  return out;
}

function logBooking(b) {
  const res = open().prepare(`
    INSERT INTO bookings (token, typeKey, guestName, guestEmail, note, startUtc, endUtc, ownerDayKey, gcalEventId, meetLink, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.token, b.typeKey || null, b.guestName, b.guestEmail, b.note || null, b.startUtc, b.endUtc,
    b.ownerDayKey, b.gcalEventId || null, b.meetLink || null, new Date().toISOString());
  open().prepare(`UPDATE tokens SET uses = uses + 1 WHERE token = ?`).run(b.token);
  return res.lastInsertRowid;
}

function listBookings({ upcomingOnly = false } = {}) {
  const where = upcomingOnly ? `WHERE status='booked' AND startUtc >= ?` : ``;
  const stmt = open().prepare(`SELECT * FROM bookings ${where} ORDER BY startUtc`);
  return upcomingOnly ? stmt.all(new Date().toISOString()) : stmt.all();
}

module.exports = { open, getToken, createToken, listTokens, setTokenDisabled, getType, createType, listTypes, setTypeDisabled, bookedByDay, logBooking, listBookings, DB_PATH, RESERVED_KEYS };
