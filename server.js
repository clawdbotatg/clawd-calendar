#!/usr/bin/env node
// clawd-calendar — self-hosted scheduling. Zero npm deps (node:http,
// node:sqlite, fetch). One page, three password tiers, Google invites.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { getOpenSlots, effectiveRules, applyType, titledDayCounts, subtractBusy } = require("./lib/slots");
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
// `exclude` (a booking row) = a reschedule in progress: that guest's own
// event — and its prep block — must not block their new pick, so its busy
// interval is carved out and its day-cap contribution decremented.
async function computeSlots({ token, cfg }, { now = Date.now(), exclude = null } = {}) {
  const horizonMs = (cfg.maxDaysOut + 2) * 86_400_000;
  const rules = effectiveRules(cfg, token);
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + horizonMs).toISOString();
  let [busy, events] = await Promise.all([
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
  if (exclude)
    busy = subtractBusy(busy,
      Date.parse(exclude.startUtc) - (cfg.prepMinutes || 0) * 60_000,
      Date.parse(exclude.endUtc));
  const titled = titledDayCounts(events, cfg.eventTitle, cfg.ownerTz);
  const booked = db.bookedByDay(token.typeKey || null);
  let counts = titled ? mergeMaxCounts(booked, titled) : booked;
  if (exclude && counts[exclude.ownerDayKey] > 0)
    counts = { ...counts, [exclude.ownerDayKey]: counts[exclude.ownerDayKey] - 1 };
  const slots = getOpenSlots({ config: cfg, token, busy, bookedByDay: counts, now });
  return { slots, rules };
}

// ---------- routes ----------

// The picker's boot payload — shared by GET /api/slots and the reschedule
// page's GET /api/manage/<key> (same theming, same slot list shape).
function pagePayload({ token, type, cfg }, slots, rules) {
  return {
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
  };
}

async function handleSlots(req, res, url) {
  const access = await resolveAccess(url.searchParams.get("token"), pubKey(url.searchParams.get("type")));
  if (!access) return json(res, 404, { error: "unknown link" });
  const { slots, rules } = await computeSlots(access);
  json(res, 200, pagePayload(access, slots, rules));
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
    // Per-booking secret: /r/<key> is the guest's reschedule page. It rides
    // in the invite description, so the guest (and the owner) always have it.
    const manageKey = db.newManageKey();
    const rescheduleUrl = `${cfg.baseUrl.replace(/\/$/, "")}/r/${manageKey}`;
    const description =
      (cfg.eventDescription ? `${cfg.eventDescription}\n\n———\n` : "") +
      `Booked via ${cfg.baseUrl}${type ? ` (${type.label})` : ""} (link: ${token.label})` +
      (note ? `\n\nNote from ${name}:\n${note}` : "") +
      `\n\nNeed to reschedule or cancel? ${rescheduleUrl}`;
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
    let prepEventId = null;
    if (cfg.prepMinutes > 0) {
      try {
        const prep = await gcal.createOwnerEvent({
          calendarId: cfg.calendarId,
          summary: `Prepare: ${summary}`,
          description: `${cfg.prepMinutes}-min prep before "${summary}" with ${name} <${email}>.` +
            (note ? `\n\nNote from ${name}:\n${note}` : ""),
          startUtc: new Date(Date.parse(slot.startUtc) - cfg.prepMinutes * 60_000).toISOString(),
          endUtc: slot.startUtc,
        });
        prepEventId = prep.id;
      } catch (err) {
        console.error(`[book] prep event failed (booking kept): ${err.message}`);
      }
    }
    db.logBooking({
      token: token.token, typeKey: token.typeKey || null, guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      ownerDayKey: dayKey(Date.parse(slot.startUtc), cfg.ownerTz),
      gcalEventId: ev.id, meetLink: ev.meetLink,
      manageKey, prepGcalEventId: prepEventId,
    });
    console.log(`[book] ${name} <${email}> ${slot.startUtc} via "${token.label}" (${token.tier}${token.typeKey ? `, type ${token.typeKey}` : ""})`);
    notify.bookingNotify({
      guestName: name, guestEmail: email, note,
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      typeLabel: type ? type.label : null, tokenLabel: token.label, meetLink: ev.meetLink,
    });
    return { code: 200, body: { ok: true, startUtc: slot.startUtc, endUtc: slot.endUtc, meetLink: ev.meetLink, manageKey, rescheduleUrl } };
  }));
  json(res, result.code, result.body);
}

// ── reschedule (/r/<key> + /api/manage) ──────────────────────────────────
// The manage key minted at booking time is identity and passcode in one: it
// resolves to exactly one booking, and it only travels in the guest's invite
// (and the owner's admin page). Unknown keys cost a flat 300ms, like bad
// passwords.

// Booking row → the access bundle slots math needs. The original token may
// have been disabled since — the booking still stands, so fall back to a
// synthetic standard token on the same type.
function accessForBooking(b) {
  const token = db.getToken(b.token) ||
    { token: b.token, label: "reschedule", tier: "standard", typeKey: b.typeKey || null,
      bypassDailyCap: null, ignoreBusy: null, windowOverride: null, durationMin: null };
  const type = b.typeKey ? db.getType(b.typeKey) : null;
  return { token, type, cfg: applyType(CONFIG, type) };
}

async function lookupManaged(res, key) {
  const b = db.getBookingByKey(String(key || ""));
  if (!b) { await sleep(300); json(res, 404, { error: "unknown link" }); return null; }
  return b;
}

// The booking's "Prepare:" companion event, if we can identify it. Stored id
// first; legacy bookings (pre-reschedule) are found by summary + start time
// in a tight calendar window around the old prep slot.
async function findPrepEventId(cfg, booking) {
  if (booking.prepGcalEventId) return booking.prepGcalEventId;
  if (!(cfg.prepMinutes > 0)) return null;
  const prepStart = Date.parse(booking.startUtc) - cfg.prepMinutes * 60_000;
  const evs = await gcal.listEvents(cfg.calendarId,
    new Date(prepStart - 60_000).toISOString(), new Date(prepStart + 60_000).toISOString());
  const hit = (evs || []).find((e) =>
    String(e.summary || "").startsWith("Prepare:") && e.start && Date.parse(e.start) === prepStart);
  return hit ? hit.id : null;
}

const bookingPublic = (b) => ({
  guestName: b.guestName, startUtc: b.startUtc, endUtc: b.endUtc,
  status: b.status, typeKey: b.typeKey || "a", meetLink: b.meetLink || null,
});

async function handleManageGet(req, res, url, key) {
  if (!rateLimit(`manage:${clientIp(req)}`, 120, 60_000)) return json(res, 429, { error: "slow down" });
  let b = await lookupManaged(res, key);
  if (!b) return;
  const light = url.searchParams.get("slots") === "0";
  const notPast = Date.parse(b.startUtc) > Date.now();
  if (light || b.status !== "booked" || !notPast) {
    return json(res, 200, {
      booking: bookingPublic(b),
      reschedulable: b.status === "booked" && notPast,
    });
  }
  const access = accessForBooking(b);
  const { slots, rules } = await computeSlots(access, { exclude: b });
  // computeSlots reconciles against the calendar — the event may have just
  // been discovered deleted, cancelling this booking.
  b = db.getBookingByKey(key) || b;
  json(res, 200, {
    ...pagePayload(access, slots, rules),
    booking: bookingPublic(b),
    reschedulable: b.status === "booked",
  });
}

async function handleManageReschedule(req, res, key) {
  const ip = clientIp(req);
  if (!rateLimit(`book:${ip}`, 10, 3_600_000)) return json(res, 429, { error: "too many attempts, try later" });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
  const startUtc = String(body.startUtc || "");
  if (isNaN(Date.parse(startUtc))) return json(res, 400, { error: "bad start time" });

  const b = await lookupManaged(res, key);
  if (!b) return;

  const result = await (bookingChain = bookingChain.catch(() => {}).then(async () => {
    const fresh = db.getBookingByKey(key);
    if (!fresh || fresh.status !== "booked") return { code: 410, body: { error: "this booking was cancelled" } };
    if (Date.parse(fresh.startUtc) <= Date.now()) return { code: 410, body: { error: "this call already happened" } };
    const access = accessForBooking(fresh);
    const { cfg } = access;
    const { slots } = await computeSlots(access, { exclude: fresh });
    const slot = slots.find((s) => Date.parse(s.startUtc) === Date.parse(startUtc));
    if (!slot) return { code: 409, body: { error: "that time isn't available — pick another" } };
    if (Date.parse(slot.startUtc) === Date.parse(fresh.startUtc))
      return { code: 400, body: { error: "that's your current time" } };

    // Move the real event — Google emails the guest the update. A 404/410
    // means it was deleted out from under us: cancel locally.
    try {
      await gcal.patchEventTime({
        calendarId: cfg.calendarId, eventId: fresh.gcalEventId,
        startUtc: slot.startUtc, endUtc: slot.endUtc,
      });
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        db.cancelBooking(fresh.id);
        return { code: 410, body: { error: "this booking no longer exists on the calendar" } };
      }
      throw err;
    }

    // Move the owner's prep block too (best-effort, like at booking time).
    if (cfg.prepMinutes > 0) {
      const prepStart = new Date(Date.parse(slot.startUtc) - cfg.prepMinutes * 60_000).toISOString();
      try {
        let prepId = await findPrepEventId(cfg, fresh);
        if (prepId) {
          await gcal.patchEventTime({
            calendarId: cfg.calendarId, eventId: prepId,
            startUtc: prepStart, endUtc: slot.startUtc, sendUpdates: "none",
          });
        } else {
          const prep = await gcal.createOwnerEvent({
            calendarId: cfg.calendarId,
            summary: `Prepare: ${(cfg.eventTitle || "Call: {name}").replace("{name}", fresh.guestName)}`,
            description: `${cfg.prepMinutes}-min prep with ${fresh.guestName} <${fresh.guestEmail}>.`,
            startUtc: prepStart, endUtc: slot.startUtc,
          });
          prepId = prep.id;
        }
        if (prepId !== fresh.prepGcalEventId) db.setPrepEventId(fresh.id, prepId);
      } catch (err) {
        console.error(`[reschedule] prep move failed (booking moved anyway): ${err.message}`);
      }
    }

    db.rescheduleBooking(fresh.id, {
      startUtc: slot.startUtc, endUtc: slot.endUtc,
      ownerDayKey: dayKey(Date.parse(slot.startUtc), cfg.ownerTz),
    });
    const type = access.type;
    console.log(`[reschedule] ${fresh.guestName} <${fresh.guestEmail}> ${fresh.startUtc} → ${slot.startUtc}${fresh.typeKey ? ` (type ${fresh.typeKey})` : ""}`);
    notify.bookingNotify({
      guestName: fresh.guestName, guestEmail: fresh.guestEmail, note: null,
      startUtc: slot.startUtc, endUtc: slot.endUtc, oldStartUtc: fresh.startUtc,
      typeLabel: type ? type.label : null, tokenLabel: access.token.label, meetLink: fresh.meetLink,
    });
    return { code: 200, body: { ok: true, startUtc: slot.startUtc, endUtc: slot.endUtc, meetLink: fresh.meetLink } };
  }));
  json(res, result.code, result.body);
}

async function handleManageCancel(req, res, key) {
  const ip = clientIp(req);
  if (!rateLimit(`book:${ip}`, 10, 3_600_000)) return json(res, 429, { error: "too many attempts, try later" });

  const b0 = await lookupManaged(res, key);
  if (!b0) return;

  const result = await (bookingChain = bookingChain.catch(() => {}).then(async () => {
    const b = db.getBookingByKey(key);
    if (!b || b.status !== "booked") return { code: 410, body: { error: "this booking was already cancelled" } };
    if (Date.parse(b.startUtc) <= Date.now()) return { code: 410, body: { error: "this call already happened" } };
    const access = accessForBooking(b);
    const { cfg } = access;

    // Delete the real event first — Google emails the guest the
    // cancellation. Already-gone events count as success.
    if (b.gcalEventId)
      await gcal.deleteEvent({ calendarId: cfg.calendarId, eventId: b.gcalEventId });

    // The prep block goes quietly (owner-only, no attendees). Best-effort.
    try {
      const prepId = await findPrepEventId(cfg, b);
      if (prepId) await gcal.deleteEvent({ calendarId: cfg.calendarId, eventId: prepId, sendUpdates: "none" });
    } catch (err) {
      console.error(`[cancel] prep delete failed (booking cancelled anyway): ${err.message}`);
    }

    db.cancelBooking(b.id);
    const type = access.type;
    console.log(`[cancel] ${b.guestName} <${b.guestEmail}> ${b.startUtc} self-cancelled${b.typeKey ? ` (type ${b.typeKey})` : ""} — day freed`);
    notify.bookingNotify({
      guestName: b.guestName, guestEmail: b.guestEmail, note: null,
      startUtc: b.startUtc, endUtc: b.endUtc, cancelled: true,
      typeLabel: type ? type.label : null, tokenLabel: access.token.label, meetLink: null,
    });
    return { code: 200, body: { ok: true } };
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
  let email = null, name = null, busy = null, tok = null, exp = 0;
  try {
    const g = await gcal.guestExchange(code, guestRedirectUri());
    email = g.email;
    name = g.name;
    // The short-lived access token travels to the GUEST'S browser (never
    // stored here) so the page can re-poll their free/busy directly from
    // Google and keep the overlay live while they linger on the picker.
    tok = gcal.FAKE ? null : g.accessToken;
    exp = Date.now() + (g.expiresIn || 3600) * 1000;
    const horizonMs = (CONFIG.maxDaysOut + 2) * 86_400_000;
    busy = await gcal.guestFreeBusy(g.accessToken,
      new Date().toISOString(), new Date(Date.now() + horizonMs).toISOString());
  } catch (err) {
    console.error(`[guest-overlay] ${err.message}`);
  }

  // Hand the result to the guest's browser and bounce back to the picker.
  const store = busy
    ? `sessionStorage.setItem("cal_guest", ${JSON.stringify(JSON.stringify({ email, name, busy, at: Date.now(), tok, exp }).replace(/</g, "\\u003c"))});`
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
    const base = CONFIG.baseUrl.replace(/\/$/, "");
    const all = db.listBookings().map((b) =>
      b.manageKey ? { ...b, rescheduleUrl: `${base}/r/${b.manageKey}` } : b);
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
    const mg = url.pathname.match(/^\/api\/manage\/([A-Za-z0-9_-]{1,64})(\/reschedule|\/cancel)?$/);
    if (mg) {
      if (!mg[2] && req.method === "GET") return await handleManageGet(req, res, url, mg[1]);
      if (mg[2] === "/reschedule" && req.method === "POST") return await handleManageReschedule(req, res, mg[1]);
      if (mg[2] === "/cancel" && req.method === "POST") return await handleManageCancel(req, res, mg[1]);
      return json(res, 404, { error: "not found" });
    }
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
    // Reschedule page: /r/<manageKey> — same single page, wearing the
    // booking's event-type skin. Unknown keys still get the page; the API
    // call is what actually validates the key.
    const resched = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})$/);
    if (resched && req.method === "GET") {
      const b = db.getBookingByKey(resched[1]);
      return serveIndex(res, b && b.typeKey ? db.getType(b.typeKey) : null);
    }
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
