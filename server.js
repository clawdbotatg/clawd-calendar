#!/usr/bin/env node
// clawd-calendar — self-hosted scheduling. Zero npm deps (node:http,
// node:sqlite, fetch). One page, three password tiers, Google invites.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { getOpenSlots, effectiveRules, applyType, titledDayCounts } = require("./lib/slots");
const db = require("./lib/db");
const gcal = require("./lib/gcal");
const notify = require("./lib/notify");
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

// Public-route key from client input: only sane type keys pass ("a"/empty =
// the default type → null).
const pubKey = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v) && v !== "a" ? v : null;

async function lookupToken(raw, publicKey = null) {
  const t = typeof raw === "string" ? raw.trim() : "";
  // Bare visit with no password → the route's public token ("shields down"
  // mode): a token minted --public for that event type (publicKey null =
  // the default type, which also honors env CAL_PUBLIC_TOKEN). A WRONG
  // password never falls back.
  if (!t) {
    const pub = db.getPublicToken(publicKey) ||
      (!publicKey && CONFIG.publicToken ? db.getToken(CONFIG.publicToken) : null);
    if (!pub) await sleep(300);
    return pub;
  }
  const row = t.length <= 128 ? db.getToken(t) : null;
  if (!row) await sleep(300); // flat cost on bad guesses
  return row;
}

// Token → its event type → the config as that type sees it. A token minted
// for a type whose type row is gone/disabled is a dead link.
async function resolveAccess(raw, publicKey = null) {
  const token = await lookupToken(raw, publicKey);
  if (!token) return null;
  const type = token.typeKey ? db.getType(token.typeKey) : null;
  if (token.typeKey && !type) { await sleep(300); return null; }
  return { token, type, cfg: applyType(CONFIG, type) };
}

// The same event can appear in both counts (a tool booking = db row AND
// calendar event) — take the max per day, never the sum.
function mergeMaxCounts(a, b) {
  const out = { ...a };
  for (const k in b) out[k] = Math.max(out[k] || 0, b[k]);
  return out;
}

// Slot computation shared by GET /api/slots and the book-time re-check.
// The CALENDAR is the source of truth for "this day is spent":
//   1. a booking whose gcal event was DELETED gets cancelled locally, so
//      removing an episode from the calendar reopens its day;
//   2. any calendar event NAMED like this type's event (manually added
//      episodes included, "Prepare:" blocks excluded) counts toward the
//      type's daily cap.
async function computeSlots({ token, cfg }, now = Date.now()) {
  const horizonMs = (cfg.maxDaysOut + 2) * 86_400_000;
  const rules = effectiveRules(cfg, token);
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + horizonMs).toISOString();
  const [busy, events] = await Promise.all([
    rules.ignoreBusy ? [] : gcal.freeBusy(cfg.calendarId, timeMin, timeMax),
    gcal.listEvents(cfg.calendarId, timeMin, timeMax),
  ]);
  if (events) {
    const ids = new Set(events.map((e) => e.id));
    for (const b of db.listBookings({ upcomingOnly: true })) {
      // Only judge bookings inside the fetched window — beyond it, absence
      // from `events` means nothing.
      if (b.startUtc <= timeMax && b.gcalEventId && !ids.has(b.gcalEventId) && db.cancelBooking(b.id))
        console.log(`[reconcile] "${b.guestName}" ${b.startUtc} deleted from calendar — cancelled, day freed`);
    }
  }
  const titled = titledDayCounts(events, cfg.eventTitle, cfg.ownerTz);
  const booked = db.bookedByDay(token.typeKey || null);
  const slots = getOpenSlots({
    config: cfg, token, busy,
    bookedByDay: titled ? mergeMaxCounts(booked, titled) : booked,
    now,
  });
  return { slots, rules };
}

// ---------- routes ----------

async function handleSlots(req, res, url) {
  const access = await resolveAccess(url.searchParams.get("token"), pubKey(url.searchParams.get("type")));
  if (!access) return json(res, 404, { error: "unknown link" });
  const { token, type, cfg } = access;
  const { slots, rules } = await computeSlots(access);
  json(res, 200, {
    ownerName: cfg.ownerName,
    ownerTz: cfg.ownerTz,
    typeKey: token.typeKey || "a",
    typeLabel: type ? type.label : null,
    accentColor: cfg.accentColor || null,
    skin: cfg.skin || null,
    heroAscii: cfg.heroAscii || null,
    pageTitle: cfg.pageTitle,
    pageSubtitle: cfg.pageSubtitle,
    pageDescription: cfg.pageDescription,
    avatarUrl: cfg.avatarUrl,
    tier: token.tier,
    label: token.label,
    durationMin: rules.durationMin,
    stepMinutes: cfg.slotStepMinutes || rules.durationMin,
    meet: !!cfg.addMeetLink,
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

  const access = await resolveAccess(body.token, pubKey(body.type));
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
      (cfg.eventDescription ? `${cfg.eventDescription}\n\n———\n` : "") +
      `Booked via ${cfg.baseUrl}${type ? ` (${type.label})` : ""} (link: ${token.label})` +
      (note ? `\n\nNote from ${name}:\n${note}` : "");
    const ev = await gcal.createEvent({
      calendarId: cfg.calendarId,
      summary, description,
      location: cfg.eventLocation || null,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      guestEmail: email, guestName: name,
      addMeet: !!cfg.addMeetLink,
    });
    // Owner-only prep block right before the event (e.g. 15 min before each
    // episode). Best-effort: a prep hiccup must not fail the booking the
    // guest already has an invite for.
    if (cfg.prepMinutes > 0) {
      try {
        await gcal.createOwnerEvent({
          calendarId: cfg.calendarId,
          summary: `Prepare: ${summary}`,
          description: `${cfg.prepMinutes}-min prep before "${summary}" with ${name} <${email}>.` +
            (note ? `\n\nNote from ${name}:\n${note}` : ""),
          startUtc: new Date(Date.parse(slot.startUtc) - cfg.prepMinutes * 60_000).toISOString(),
          endUtc: slot.startUtc,
        });
      } catch (err) {
        console.error(`[book] prep event failed (booking kept): ${err.message}`);
      }
    }
    db.logBooking({
      token: token.token, typeKey: token.typeKey || null, guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      ownerDayKey: dayKey(Date.parse(slot.startUtc), cfg.ownerTz),
      gcalEventId: ev.id, meetLink: ev.meetLink,
    });
    console.log(`[book] ${name} <${email}> ${slot.startUtc} via "${token.label}" (${token.tier}${token.typeKey ? `, type ${token.typeKey}` : ""})`);
    notify.bookingNotify({
      guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      typeLabel: type ? type.label : null, tokenLabel: token.label, meetLink: ev.meetLink,
    });
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
  const pk = pubKey(url.searchParams.get("type"));
  const token = await lookupToken(raw, pk);
  if (!token) return json(res, 404, { error: "unknown link" });
  // Public (no-password) visitors round-trip a sentinel so the callback
  // sends them back to "/" (or "/<type>") instead of exposing the token.
  const state = raw ? token.token : pk ? `@public:${pk}` : "@public";
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
  const pm = state.match(/^@public(?::([A-Za-z0-9_-]{1,32}))?$/);
  const isPublic = !!pm;
  const pk = pm ? pubKey(pm[1] || "") : null;
  const token = await lookupToken(isPublic ? "" : state, pk);
  if (!token) return json(res, 404, { error: "unknown link" });
  const back = isPublic ? (pk ? `/${pk}` : "/") : `/${encodeURIComponent(token.typeKey || "a")}/${encodeURIComponent(token.token)}`;
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

// ── admin (/admin/<password>) ────────────────────────────────────────────
// One password (CAL_ADMIN_PASSWORD; unset = admin off) gates a page + JSON
// API for the things scripts/types.js and scripts/mint.js do over ssh:
// event types, links, and a bookings view. The page carries the password in
// its path (same pattern as guest links); API calls send it in x-admin-pw.

function adminOk(supplied) {
  if (!CONFIG.adminPassword || !supplied) return false;
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(supplied), h(CONFIG.adminPassword));
}

// True = proceed; false = a 404/429 was already sent (flat-cost + rate-limited
// failures, like bad guest passwords).
async function requireAdmin(req, res, supplied) {
  if (adminOk(supplied)) return true;
  if (!rateLimit(`adminfail:${clientIp(req)}`, 20, 3_600_000)) { json(res, 429, { error: "slow down" }); return false; }
  await sleep(300);
  json(res, 404, { error: "not found" });
  return false;
}

async function handleAdminPage(req, res, pw) {
  if (!(await requireAdmin(req, res, pw))) return;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", // password lives in the URL
  });
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, "admin.html")));
}

const optNum = (v) => { const n = +v; return v == null || v === "" || !Number.isFinite(n) ? null : n; };
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function windowFromBody(body) {
  if (!body.days && !body.start && !body.end) return { window: null };
  const days = String(body.days || "mon,tue,wed,thu,fri").split(",")
    .map((s) => s.trim().toLowerCase()).filter((d) => DAY_NAMES.includes(d));
  const start = String(body.start || "08:00"), end = String(body.end || "17:00");
  if (!days.length) return { error: "no valid days (mon..sun)" };
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return { error: "start/end must be HH:MM" };
  return { window: { days, start, end } };
}

async function handleAdminApi(req, res, url) {
  if (!(await requireAdmin(req, res, req.headers["x-admin-pw"]))) return;
  const link = (t) => `${CONFIG.baseUrl}/${encodeURIComponent(t.typeKey || "a")}/${encodeURIComponent(t.token)}`;

  if (url.pathname === "/api/admin/overview" && req.method === "GET") {
    const now = new Date().toISOString();
    const all = db.listBookings();
    return json(res, 200, {
      ownerName: CONFIG.ownerName, ownerTz: CONFIG.ownerTz, baseUrl: CONFIG.baseUrl,
      defaults: {
        slotMinutes: CONFIG.slotMinutes, stepMinutes: CONFIG.slotStepMinutes,
        window: CONFIG.window, dailyCap: CONFIG.dailyCap,
        minNoticeHours: CONFIG.minNoticeHours, maxDaysOut: CONFIG.maxDaysOut,
      },
      types: db.listTypes().map((t) => ({ ...t, window: t.window ? JSON.parse(t.window) : null })),
      tokens: db.listTokens().map((t) => ({
        ...t, windowOverride: t.windowOverride ? JSON.parse(t.windowOverride) : null, link: link(t),
      })),
      bookings: {
        upcoming: all.filter((b) => b.status === "booked" && b.startUtc >= now),
        past: all.filter((b) => b.startUtc < now).slice(-30).reverse(),
      },
    });
  }

  if (req.method !== "POST") return json(res, 404, { error: "not found" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }

  if (url.pathname === "/api/admin/types") {
    const key = String(body.key || "").trim();
    const label = String(body.label || "").trim().slice(0, 80);
    if (!label) return json(res, 400, { error: "label required" });
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) return json(res, 400, { error: "bad key — lowercase letters/digits/-/_ only" });
    if (db.RESERVED_KEYS.includes(key)) return json(res, 400, { error: `key "${key}" is reserved` });
    if (db.listTypes().some((t) => t.key === key)) return json(res, 409, { error: `type "${key}" already exists` });
    const accent = body.accentColor ? String(body.accentColor).trim() : null;
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) return json(res, 400, { error: "accent must be #rrggbb" });
    const w = windowFromBody(body);
    if (w.error) return json(res, 400, { error: w.error });
    db.createType({
      key, label, window: w.window,
      durationMin: optNum(body.durationMin), stepMinutes: optNum(body.stepMinutes),
      dailyCap: optNum(body.dailyCap), minNoticeHours: optNum(body.minNoticeHours),
      maxDaysOut: optNum(body.maxDaysOut),
      eventTitle: body.eventTitle ? String(body.eventTitle).slice(0, 200) : null,
      eventDescription: body.eventDescription ? String(body.eventDescription).slice(0, 4000) : null,
      eventLocation: body.eventLocation ? String(body.eventLocation).slice(0, 500) : null,
      prepMinutes: optNum(body.prepMinutes),
      addMeet: body.addMeet == null || body.addMeet === "" ? null : !!+body.addMeet,
      pageTitle: body.pageTitle ? String(body.pageTitle).slice(0, 200) : null,
      pageSubtitle: body.pageSubtitle ? String(body.pageSubtitle).slice(0, 200) : null,
      pageDescription: body.pageDescription ? String(body.pageDescription).slice(0, 2000) : null,
      accentColor: accent,
      avatarUrl: body.avatarUrl ? String(body.avatarUrl).slice(0, 300) : null,
      skin: body.skin && /^[a-z0-9-]{1,24}$/.test(String(body.skin).trim()) ? String(body.skin).trim() : null,
      heroAscii: body.heroAscii ? String(body.heroAscii).slice(0, 8000) : null,
    });
    console.log(`[admin] created type "${key}"`);
    return json(res, 200, { ok: true, key });
  }

  if (url.pathname === "/api/admin/types/toggle") {
    const ok = db.setTypeDisabled(String(body.key || ""), !!body.disabled);
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such type" });
  }

  if (url.pathname === "/api/admin/mint") {
    const label = String(body.label || "").trim().slice(0, 120);
    if (!label) return json(res, 400, { error: "label required" });
    const tier = body.tier || "standard";
    if (!["standard", "vip", "override"].includes(tier)) return json(res, 400, { error: "bad tier" });
    let typeKey = body.typeKey || null;
    if (typeKey === "a") typeKey = null;
    if (typeKey && !db.listTypes().some((t) => t.key === typeKey)) return json(res, 400, { error: `no such event type "${typeKey}"` });
    const token = body.token ? String(body.token).trim() : crypto.randomBytes(6).toString("base64url");
    if (!/^\S{4,64}$/.test(token) || token.includes("/")) return json(res, 400, { error: "password: 4–64 chars, no spaces or /" });
    if (db.listTokens().some((t) => t.token === token)) return json(res, 409, { error: "that password already exists" });
    const w = windowFromBody(body);
    if (w.error) return json(res, 400, { error: w.error });
    db.createToken({
      token, label, tier, typeKey,
      durationMin: optNum(body.durationMin), maxUses: optNum(body.maxUses),
      windowOverride: w.window, isPublic: !!+(body.isPublic || 0),
    });
    console.log(`[admin] minted [${tier}] "${label}"${typeKey ? ` (type: ${typeKey})` : ""}${+(body.isPublic || 0) ? " (public)" : ""}`);
    return json(res, 200, { ok: true, token, link: link({ typeKey, token }) });
  }

  if (url.pathname === "/api/admin/tokens/toggle") {
    const ok = db.setTokenDisabled(String(body.token || ""), !!body.disabled);
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such link" });
  }

  return json(res, 404, { error: "not found" });
}

// index.html is served with OG/title placeholders filled from config (or the
// route's event type), so unfurl cards and the tab title follow without a
// build step.
function serveIndex(res, type = null) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const cfg = applyType(CONFIG, type);
  const title = cfg.pageTitle || `Book a call with ${cfg.ownerName}`;
  // Duration in the unfurl card follows the route's public token override
  // (e.g. walk-ins on / get 30-min calls while password links stay 60).
  const pubTok = db.getPublicToken(type ? type.key : null);
  const desc = cfg.pageDescription || `${(pubTok && pubTok.durationMin) || cfg.slotMinutes}-minute ${type ? type.label.toLowerCase() : "call"} — pick a time that works for you.`;
  const base = CONFIG.baseUrl.replace(/\/$/, "");
  // Per-type unfurl card: og-<key>.png in the assets overlay (or public/)
  // wins; missing file falls back to the shared og.png.
  const ogFile = type && [ASSETS_DIR, PUBLIC_DIR].some((d) => fs.existsSync(path.join(d, `og-${type.key}.png`)))
    ? `og-${type.key}.png` : "og.png";
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
    .replaceAll("__OG_TITLE__", esc(title))
    .replaceAll("__OG_DESC__", esc(desc))
    .replaceAll("__OG_IMAGE__", `${base}/${ogFile}`)
    .replaceAll("__OG_URL__", type ? `${base}/${esc(type.key)}` : `${base}/`)
    .replaceAll("__THEME_COLOR__", cfg.accentColor ? esc(cfg.accentColor) : "#81d555")
    // Skin class stamped server-side so the themed background paints
    // before the API round-trip (skin names are validated slugs).
    .replaceAll("__BODY_CLASS__", type && type.skin ? `skin-${esc(type.skin)}` : "")
    .replaceAll("__BASE_URL__", CONFIG.baseUrl.replace(/\/$/, ""));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// Static files resolve from the gitignored assets/ overlay first (personal
// images: avatar, favicons, og card — never committed), then public/.
const ASSETS_DIR = path.join(__dirname, "assets");
function serveStatic(res, file) {
  if (file === "admin.html") { res.writeHead(404); return res.end("not found"); } // only via /admin/<pw>
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
    if (url.pathname.startsWith("/api/admin/")) return await handleAdminApi(req, res, url);
    if (url.pathname === "/oauth/guest/start") return await handleGuestStart(req, res, url);
    if (url.pathname === "/oauth/callback") return await handleGuestCallback(req, res, url);
    const adm = url.pathname.match(/^\/admin\/([^/]+)$/);
    if (adm && req.method === "GET") return await handleAdminPage(req, res, decodeURIComponent(adm[1]));
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
    // Bare type route (/<key>, no password) — the type's public page; the
    // client asks the API for its public token, gate if there isn't one.
    const bare = url.pathname.match(/^\/([A-Za-z0-9_-]{1,32})\/?$/);
    if (bare) {
      if (bare[1] === "a") return serveIndex(res);
      const type = db.getType(bare[1]);
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
