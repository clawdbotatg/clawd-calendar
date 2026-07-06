#!/usr/bin/env node
// clawd-calendar — self-hosted scheduling. Zero npm deps (node:http,
// node:sqlite, fetch). One page, three password tiers, Google invites.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { getOpenSlots, effectiveRules } = require("./lib/slots");
const db = require("./lib/db");
const gcal = require("./lib/gcal");
const { dayKey } = require("./lib/tz");

const CONFIG = require("./lib/config");
// CAL_PORT, not PORT — a bare PORT is often inherited from the parent
// process's environment (e.g. the harness exports PORT=8787).
const PORT = CONFIG.port;
const PUBLIC_DIR = path.join(__dirname, "public");

db.open();

// ---------- helpers ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? String(xff).split(",")[0].trim() : req.socket.remoteAddress) || "?";
}

// Tiny fixed-window rate limiter: key → allow?
const rlBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; rlBuckets.set(key, b); }
  if (rlBuckets.size > 5000) for (const [k, v] of rlBuckets) if (now > v.reset) rlBuckets.delete(k);
  b.n++;
  return b.n <= max;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookupToken(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  const row = t && t.length <= 128 ? db.getToken(t) : null;
  if (!row) await sleep(300); // flat cost on bad guesses
  return row;
}

// Slot computation shared by GET /api/slots and the book-time re-check.
async function computeSlots(token, now = Date.now()) {
  const horizonMs = (CONFIG.maxDaysOut + 2) * 86_400_000;
  const rules = effectiveRules(CONFIG, token);
  const busy = rules.ignoreBusy ? [] : await gcal.freeBusy(
    CONFIG.calendarId,
    new Date(now).toISOString(),
    new Date(now + horizonMs).toISOString()
  );
  const slots = getOpenSlots({ config: CONFIG, token, busy, bookedByDay: db.bookedByDay(), now });
  return { slots, rules };
}

// ---------- routes ----------

async function handleSlots(req, res, url) {
  const token = await lookupToken(url.searchParams.get("token"));
  if (!token) return json(res, 404, { error: "unknown link" });
  const { slots, rules } = await computeSlots(token);
  json(res, 200, {
    ownerName: CONFIG.ownerName,
    ownerTz: CONFIG.ownerTz,
    tier: token.tier,
    label: token.label,
    durationMin: rules.durationMin,
    pickAnything: !!rules.ignoreBusy,
    maxDaysOut: CONFIG.maxDaysOut,
    slots,
  });
}

// Bookings are serialized through one promise chain — two guests racing for
// the same slot hit the re-check one at a time.
let bookingChain = Promise.resolve();

async function handleBook(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(`book:${ip}`, 10, 3_600_000)) return json(res, 429, { error: "too many attempts, try later" });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }

  const token = await lookupToken(body.token);
  if (!token) return json(res, 404, { error: "unknown link" });

  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);
  const note = String(body.note || "").trim().slice(0, 1000);
  const startUtc = String(body.startUtc || "");
  if (!name) return json(res, 400, { error: "name required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "valid email required" });
  if (isNaN(Date.parse(startUtc))) return json(res, 400, { error: "bad start time" });

  const result = await (bookingChain = bookingChain.catch(() => {}).then(async () => {
    // Book-time re-check: recompute fresh and require the exact slot.
    const { slots, rules } = await computeSlots(token);
    const slot = slots.find((s) => Date.parse(s.startUtc) === Date.parse(startUtc));
    if (!slot) return { code: 409, body: { error: "slot just taken — pick another" } };

    const summary = (CONFIG.eventTitle || "Call: {name}").replace("{name}", name);
    const description =
      `Booked via ${CONFIG.baseUrl} (link: ${token.label})` + (note ? `\n\nNote from ${name}:\n${note}` : "");
    const ev = await gcal.createEvent({
      calendarId: CONFIG.calendarId,
      summary, description,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      guestEmail: email, guestName: name,
      addMeet: !!CONFIG.addMeetLink,
    });
    db.logBooking({
      token: token.token, guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      ownerDayKey: dayKey(Date.parse(slot.startUtc), CONFIG.ownerTz),
      gcalEventId: ev.id, meetLink: ev.meetLink,
    });
    console.log(`[book] ${name} <${email}> ${slot.startUtc} via "${token.label}" (${token.tier})`);
    return { code: 200, body: { ok: true, startUtc: slot.startUtc, endUtc: slot.endUtc, meetLink: ev.meetLink } };
  }));
  json(res, result.code, result.body);
}

function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, fake: gcal.FAKE });
    if (url.pathname === "/api/slots" && req.method === "GET") {
      if (!rateLimit(`slots:${clientIp(req)}`, 120, 60_000)) return json(res, 429, { error: "slow down" });
      return await handleSlots(req, res, url);
    }
    if (url.pathname === "/api/book" && req.method === "POST") return await handleBook(req, res);
    // The single page serves both the password gate (/) and the picker (/a/<pw>).
    if (url.pathname === "/" || /^\/a\/[^/]+$/.test(url.pathname)) return serveStatic(res, "index.html");
    return serveStatic(res, url.pathname.slice(1));
  } catch (err) {
    console.error(`[err] ${req.method} ${url.pathname}:`, err.message);
    json(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`clawd-calendar listening on http://127.0.0.1:${PORT}${gcal.FAKE ? "  (FAKE gcal mode)" : ""}`);
});
