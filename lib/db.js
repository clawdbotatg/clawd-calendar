// SQLite (node:sqlite, zero deps) — tokens (passwords/links) + bookings log.
// The local bookings log is the daily-cap fast path; Google Calendar stays
// the source of truth for busy time.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = process.env.CAL_DB || path.join(__dirname, "..", "data", "cal.db");

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
  `);
  return db;
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

function createToken({ token, label, tier = "standard", bypassDailyCap = null, ignoreBusy = null, windowOverride = null, durationMin = null, maxUses = null }) {
  open().prepare(`
    INSERT INTO tokens (token, label, tier, bypassDailyCap, ignoreBusy, windowOverride, durationMin, maxUses, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, label, tier,
    bypassDailyCap == null ? null : bypassDailyCap ? 1 : 0,
    ignoreBusy == null ? null : ignoreBusy ? 1 : 0,
    windowOverride ? JSON.stringify(windowOverride) : null,
    durationMin, maxUses, new Date().toISOString());
}

function listTokens() {
  return open().prepare(`SELECT * FROM tokens ORDER BY createdAt`).all();
}

// { ownerDayKey → count } of active tool-booked events, for the daily cap.
function bookedByDay() {
  const rows = open().prepare(
    `SELECT ownerDayKey, COUNT(*) AS n FROM bookings WHERE status = 'booked' GROUP BY ownerDayKey`
  ).all();
  const out = {};
  for (const r of rows) out[r.ownerDayKey] = r.n;
  return out;
}

function logBooking(b) {
  const res = open().prepare(`
    INSERT INTO bookings (token, guestName, guestEmail, note, startUtc, endUtc, ownerDayKey, gcalEventId, meetLink, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.token, b.guestName, b.guestEmail, b.note || null, b.startUtc, b.endUtc,
    b.ownerDayKey, b.gcalEventId || null, b.meetLink || null, new Date().toISOString());
  open().prepare(`UPDATE tokens SET uses = uses + 1 WHERE token = ?`).run(b.token);
  return res.lastInsertRowid;
}

function listBookings({ upcomingOnly = false } = {}) {
  const where = upcomingOnly ? `WHERE status='booked' AND startUtc >= ?` : ``;
  const stmt = open().prepare(`SELECT * FROM bookings ${where} ORDER BY startUtc`);
  return upcomingOnly ? stmt.all(new Date().toISOString()) : stmt.all();
}

module.exports = { open, getToken, createToken, listTokens, bookedByDay, logBooking, listBookings, DB_PATH };
