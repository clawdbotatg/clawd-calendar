#!/usr/bin/env node
// clawd-calendar — self-hosted scheduling. Zero npm deps (node:http,
// node:sqlite, fetch). One page, three password tiers, Google invites.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { getOpenSlots, effectiveRules, applyType } = require("./lib/slots");
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
  let t = typeof raw === "string" ? raw.trim() : "";
  // Bare visit with no password → the configured public token ("shields
  // down" mode). A WRONG password never falls back.
  if (!t && CONFIG.publicToken) t = CONFIG.publicToken;
  const row = t && t.length <= 128 ? db.getToken(t) : null;
  if (!row) await sleep(300); // flat cost on bad guesses
  return row;
}

// Token → its event type → the config as that type sees it. A token minted
// for a type whose type row is gone/disabled is a dead link.
async function resolveAccess(raw) {
  const token = await lookupToken(raw);
  if (!token) return null;
  const type = token.typeKey ? db.getType(token.typeKey) : null;
  if (token.typeKey && !type) { await sleep(300); return null; }
  return { token, type, cfg: applyType(CONFIG, type) };
}

// Slot computation shared by GET /api/slots and the book-time re-check.
async function computeSlots({ token, cfg }, now = Date.now()) {
  const horizonMs = (cfg.maxDaysOut + 2) * 86_400_000;
  const rules = effectiveRules(cfg, token);
  const busy = rules.ignoreBusy ? [] : await gcal.freeBusy(
    cfg.calendarId,
    new Date(now).toISOString(),
    new Date(now + horizonMs).toISOString()
  );
  const slots = getOpenSlots({ config: cfg, token, busy, bookedByDay: db.bookedByDay(token.typeKey || null), now });
  return { slots, rules };
}

// ---------- routes ----------

async function handleSlots(req, res, url) {
  const access = await resolveAccess(url.searchParams.get("token"));
  if (!access) return json(res, 404, { error: "unknown link" });
  const { token, type, cfg } = access;
  const { slots, rules } = await computeSlots(access);
  json(res, 200, {
    ownerName: cfg.ownerName,
    ownerTz: cfg.ownerTz,
    typeKey: token.typeKey || "a",
    typeLabel: type ? type.label : null,
    accentColor: cfg.accentColor || null,
    pageTitle: cfg.pageTitle,
    pageSubtitle: cfg.pageSubtitle,
    pageDescription: cfg.pageDescription,
    avatarUrl: cfg.avatarUrl,
    tier: token.tier,
    label: token.label,
    durationMin: rules.durationMin,
    stepMinutes: cfg.slotStepMinutes || rules.durationMin,
    pickAnything: !!rules.ignoreBusy,
    maxDaysOut: cfg.maxDaysOut,
    overlay: gcal.FAKE || !!gcal.webCreds(), // guest calendar-connect available?
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

  const access = await resolveAccess(body.token);
  if (!access) return json(res, 404, { error: "unknown link" });
  const { token, type, cfg } = access;

  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);
  const note = String(body.note || "").trim().slice(0, 1000);
  const startUtc = String(body.startUtc || "");
  if (!name) return json(res, 400, { error: "name required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "valid email required" });
  if (isNaN(Date.parse(startUtc))) return json(res, 400, { error: "bad start time" });

  const result = await (bookingChain = bookingChain.catch(() => {}).then(async () => {
    // Book-time re-check: recompute fresh and require the exact slot.
    const { slots, rules } = await computeSlots(access);
    const slot = slots.find((s) => Date.parse(s.startUtc) === Date.parse(startUtc));
    if (!slot) return { code: 409, body: { error: "slot just taken — pick another" } };

    const summary = (cfg.eventTitle || "Call: {name}").replace("{name}", name);
    const description =
      `Booked via ${cfg.baseUrl}${type ? ` (${type.label})` : ""} (link: ${token.label})` +
      (note ? `\n\nNote from ${name}:\n${note}` : "");
    const ev = await gcal.createEvent({
      calendarId: cfg.calendarId,
      summary, description,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      guestEmail: email, guestName: name,
      addMeet: !!cfg.addMeetLink,
    });
    db.logBooking({
      token: token.token, typeKey: token.typeKey || null, guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      ownerDayKey: dayKey(Date.parse(slot.startUtc), cfg.ownerTz),
      gcalEventId: ev.id, meetLink: ev.meetLink,
    });
    console.log(`[book] ${name} <${email}> ${slot.startUtc} via "${token.label}" (${token.tier}${token.typeKey ? `, type ${token.typeKey}` : ""})`);
    return { code: 200, body: { ok: true, startUtc: slot.startUtc, endUtc: slot.endUtc, meetLink: ev.meetLink } };
  }));
  json(res, result.code, result.body);
}

// ── guest calendar overlay (Phase 2) ─────────────────────────────────────
// Guest OAuth: freebusy scope only, token used once server-side, never
// stored. Busy blocks travel to the guest's own sessionStorage via the
// callback page — the server keeps nothing.

const guestRedirectUri = () => `${CONFIG.baseUrl.replace(/\/$/, "")}/oauth/callback`;

async function handleGuestStart(req, res, url) {
  const raw = url.searchParams.get("token");
  const token = await lookupToken(raw);
  if (!token) return json(res, 404, { error: "unknown link" });
  // Public (no-password) visitors round-trip a sentinel so the callback
  // sends them back to "/" instead of exposing the token in the URL.
  const state = raw ? token.token : "@public";
  const authUrl = gcal.FAKE
    ? `/oauth/callback?code=fake&state=${encodeURIComponent(state)}`
    : gcal.guestAuthUrl(guestRedirectUri(), state);
  if (!authUrl) return json(res, 501, { error: "calendar overlay not configured" });
  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleGuestCallback(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const isPublic = state === "@public";
  const token = await lookupToken(isPublic ? "" : state);
  if (!token) return json(res, 404, { error: "unknown link" });
  const back = isPublic ? "/" : `/${encodeURIComponent(token.typeKey || "a")}/${encodeURIComponent(token.token)}`;
  if (!code) { res.writeHead(302, { Location: back }); return res.end(); }

  // Degrade gracefully: a guest whose account has no Google Calendar (or a
  // freebusy hiccup) just lands back on the picker with a soft notice.
  let email = null, busy = null;
  try {
    const g = await gcal.guestExchange(code, guestRedirectUri());
    email = g.email;
    const horizonMs = (CONFIG.maxDaysOut + 2) * 86_400_000;
    busy = await gcal.guestFreeBusy(g.accessToken,
      new Date().toISOString(), new Date(Date.now() + horizonMs).toISOString());
  } catch (err) {
    console.error(`[guest-overlay] ${err.message}`);
  }

  // Hand the result to the guest's browser and bounce back to the picker.
  const store = busy
    ? `sessionStorage.setItem("cal_guest", ${JSON.stringify(JSON.stringify({ email, busy, at: Date.now() }).replace(/</g, "\\u003c"))});`
    : `sessionStorage.setItem("cal_guest_err", "1");`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><script>
${store}
location.replace(${JSON.stringify(back)});
</script>`);
}

// index.html is served with OG/title placeholders filled from config (or the
// route's event type), so unfurl cards and the tab title follow without a
// build step.
function serveIndex(res, type = null) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const cfg = applyType(CONFIG, type);
  const title = cfg.pageTitle || `Book a call with ${cfg.ownerName}`;
  const desc = cfg.pageDescription || `${cfg.slotMinutes}-minute ${type ? type.label.toLowerCase() : "call"} — pick a time that works for you.`;
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
    .replaceAll("__OG_TITLE__", esc(title))
    .replaceAll("__OG_DESC__", esc(desc))
    .replaceAll("__BASE_URL__", CONFIG.baseUrl.replace(/\/$/, ""));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// Static files resolve from the gitignored assets/ overlay first (personal
// images: avatar, favicons, og card — never committed), then public/.
const ASSETS_DIR = path.join(__dirname, "assets");
function serveStatic(res, file) {
  let p = null;
  for (const dir of [ASSETS_DIR, PUBLIC_DIR]) {
    const cand = path.join(dir, file);
    if (cand.startsWith(dir) && fs.existsSync(cand) && fs.statSync(cand).isFile()) { p = cand; break; }
  }
  if (!p) { res.writeHead(404); return res.end("not found"); }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
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
    if (url.pathname === "/oauth/guest/start") return await handleGuestStart(req, res, url);
    if (url.pathname === "/oauth/callback") return await handleGuestCallback(req, res, url);
    // The single page serves the password gate (/) and the picker at
    // /<typeKey>/<pw> — "a" is the built-in default type; other keys are
    // event_types rows (API/oauth routes are matched above, so they can't
    // collide). Unknown first segments fall through to static files.
    if (url.pathname === "/") return serveIndex(res);
    const page = url.pathname.match(/^\/([A-Za-z0-9_-]{1,32})\/[^/]+$/);
    if (page) {
      if (page[1] === "a") return serveIndex(res);
      const type = db.getType(page[1]);
      if (type) return serveIndex(res, type);
    }
    return serveStatic(res, url.pathname.slice(1));
  } catch (err) {
    console.error(`[err] ${req.method} ${url.pathname}:`, err.message);
    json(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`clawd-calendar listening on http://127.0.0.1:${PORT}${gcal.FAKE ? "  (FAKE gcal mode)" : ""}`);
});
