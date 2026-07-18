// SQLite (node:sqlite, zero deps) — event types (routes), tokens
// (passwords/links) + bookings log. The local bookings log is the daily-cap
// fast path; Google Calendar stays the source of truth for busy time.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const crypto = require("node:crypto");

const DB_PATH = process.env.CAL_DB || path.join(__dirname, "..", "data", "cal.db");

// Route keys that can never be event types ("a" = the built-in default type;
// "r" = reschedule links; the rest shadow real routes).
const RESERVED_KEYS = ["a", "r", "admin", "api", "oauth", "healthz", "assets", "public", "data"];

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
      eventDescription TEXT,             -- custom text atop the invite description
      eventLocation   TEXT,              -- gcal event location field
      prepMinutes     INTEGER,           -- owner-only "Prepare" event this long, right before
      addMeet         INTEGER,           -- NULL = config default; 0/1 forces Meet link off/on
      pageTitle       TEXT,
      pageSubtitle    TEXT,
      pageDescription TEXT,
      accentColor     TEXT,              -- #rrggbb page accent
      avatarUrl       TEXT,              -- per-type avatar (overrides config)
      skin            TEXT,              -- named page skin (CSS theme in index.html)
      heroAscii       TEXT,              -- ASCII banner rendered above the picker
      disabled        INTEGER NOT NULL DEFAULT 0,
      createdAt       TEXT NOT NULL
    );
  `);
  // Migrations for dbs created before event types existed. typeKey NULL =
  // the built-in default type (route /a/).
  ensureColumn("tokens", "typeKey", "TEXT");
  ensureColumn("bookings", "typeKey", "TEXT");
  // Migrations for dbs created before custom-invite fields existed.
  ensureColumn("event_types", "eventDescription", "TEXT");
  ensureColumn("event_types", "eventLocation", "TEXT");
  ensureColumn("event_types", "prepMinutes", "INTEGER");
  ensureColumn("event_types", "addMeet", "INTEGER");
  // Migration for dbs created before public (no-password) links existed.
  ensureColumn("tokens", "isPublic", "INTEGER");
  // Migrations for dbs created before per-type page skins existed.
  ensureColumn("event_types", "avatarUrl", "TEXT");
  ensureColumn("event_types", "skin", "TEXT");
  ensureColumn("event_types", "heroAscii", "TEXT");
  // Migrations for dbs created before reschedule links existed. manageKey is
  // the per-booking secret behind /r/<key> — identity and passcode in one.
  ensureColumn("bookings", "manageKey", "TEXT");
  ensureColumn("bookings", "prepGcalEventId", "TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_manage ON bookings(manageKey)`);
  // Backfill keys onto live bookings from before the migration: their invite
  // emails lack the link, but the admin page can still hand one out.
  for (const r of db.prepare(`SELECT id FROM bookings WHERE status = 'booked' AND manageKey IS NULL`).all())
    db.prepare(`UPDATE bookings SET manageKey = ? WHERE id = ?`).run(newManageKey(), r.id);
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

// The route's "shields down" token: a bare visit to /<typeKey> (or / for the
// default type, typeKey null) with no password books through this. Newest
// enabled public token wins; disabling it re-arms the password gate.
function getPublicToken(typeKey = null) {
  const row = open().prepare(
    `SELECT token FROM tokens WHERE isPublic = 1 AND disabled = 0 AND typeKey IS ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`
  ).get(typeKey);
  return row ? getToken(row.token) : null;
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
      minNoticeHours, maxDaysOut, eventTitle, eventDescription, eventLocation,
      prepMinutes, addMeet, pageTitle, pageSubtitle, pageDescription,
      accentColor, avatarUrl, skin, heroAscii, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.key, t.label, t.durationMin ?? null, t.stepMinutes ?? null,
    t.window ? JSON.stringify(t.window) : null, t.dailyCap ?? null,
    t.minNoticeHours ?? null, t.maxDaysOut ?? null, t.eventTitle ?? null,
    t.eventDescription ?? null, t.eventLocation ?? null, t.prepMinutes ?? null,
    t.addMeet == null ? null : t.addMeet ? 1 : 0,
    t.pageTitle ?? null, t.pageSubtitle ?? null, t.pageDescription ?? null,
    t.accentColor ?? null, t.avatarUrl ?? null, t.skin ?? null, t.heroAscii ?? null,
    new Date().toISOString());
}

function listTypes() {
  return open().prepare(`SELECT * FROM event_types ORDER BY createdAt`).all();
}

function setTypeDisabled(key, disabled) {
  return open().prepare(`UPDATE event_types SET disabled = ? WHERE key = ?`).run(disabled ? 1 : 0, key).changes > 0;
}

function createToken({ token, label, tier = "standard", typeKey = null, bypassDailyCap = null, ignoreBusy = null, windowOverride = null, durationMin = null, maxUses = null, isPublic = false }) {
  open().prepare(`
    INSERT INTO tokens (token, label, tier, typeKey, bypassDailyCap, ignoreBusy, windowOverride, durationMin, maxUses, isPublic, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, label, tier, typeKey,
    bypassDailyCap == null ? null : bypassDailyCap ? 1 : 0,
    ignoreBusy == null ? null : ignoreBusy ? 1 : 0,
    windowOverride ? JSON.stringify(windowOverride) : null,
    durationMin, maxUses, isPublic ? 1 : 0, new Date().toISOString());
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

// Calendar is the source of truth: a booking whose gcal event was deleted
// gets cancelled here too, freeing its day for the daily cap.
function cancelBooking(id) {
  return open().prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'booked'`).run(id).changes > 0;
}

function logBooking(b) {
  const res = open().prepare(`
    INSERT INTO bookings (token, typeKey, guestName, guestEmail, note, startUtc, endUtc, ownerDayKey, gcalEventId, meetLink, manageKey, prepGcalEventId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.token, b.typeKey || null, b.guestName, b.guestEmail, b.note || null, b.startUtc, b.endUtc,
    b.ownerDayKey, b.gcalEventId || null, b.meetLink || null, b.manageKey || newManageKey(),
    b.prepGcalEventId || null, new Date().toISOString());
  open().prepare(`UPDATE tokens SET uses = uses + 1 WHERE token = ?`).run(b.token);
  return res.lastInsertRowid;
}

// ── reschedule (manage keys) ─────────────────────────────────────────────

// 10 random bytes → 14 url-safe chars. Unguessable; lookups are flat-cost +
// rate-limited server-side, same as password guesses.
function newManageKey() {
  return crypto.randomBytes(10).toString("base64url");
}

function getBookingByKey(manageKey) {
  if (!manageKey || typeof manageKey !== "string" || manageKey.length > 64) return null;
  return open().prepare(`SELECT * FROM bookings WHERE manageKey = ?`).get(manageKey) || null;
}

// Move a live booking to a new time (same key, same guest, same event).
function rescheduleBooking(id, { startUtc, endUtc, ownerDayKey }) {
  return open().prepare(
    `UPDATE bookings SET startUtc = ?, endUtc = ?, ownerDayKey = ? WHERE id = ? AND status = 'booked'`
  ).run(startUtc, endUtc, ownerDayKey, id).changes > 0;
}

// The prep block gets a fresh gcal event when a legacy booking (no stored
// prep id) is rescheduled — remember it for the next move.
function setPrepEventId(id, prepGcalEventId) {
  open().prepare(`UPDATE bookings SET prepGcalEventId = ? WHERE id = ?`).run(prepGcalEventId, id);
}

function listBookings({ upcomingOnly = false } = {}) {
  const where = upcomingOnly ? `WHERE status='booked' AND startUtc >= ?` : ``;
  const stmt = open().prepare(`SELECT * FROM bookings ${where} ORDER BY startUtc`);
  return upcomingOnly ? stmt.all(new Date().toISOString()) : stmt.all();
}

module.exports = { open, getToken, getPublicToken, createToken, listTokens, setTokenDisabled, getType, createType, listTypes, setTypeDisabled, bookedByDay, cancelBooking, logBooking, listBookings, newManageKey, getBookingByKey, rescheduleBooking, setPrepEventId, DB_PATH, RESERVED_KEYS };
