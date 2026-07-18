// Google Calendar over plain REST (built-in fetch, zero deps).
// Credentials resolution order:
//   1. env GCAL_CLIENT_ID / GCAL_CLIENT_SECRET / GCAL_REFRESH_TOKEN
//   2. .clawd-calendar.env in the repo root (gitignored KEY=VALUE file)
//   3. ~/.config/gcal-skill/credentials.json (shared with the gcal CLI skill)
// GCAL_FAKE=1 → canned busy blocks + fake event insert, for local dev/tests.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { env } = require("./env");

const SKILL_CREDS = path.join(os.homedir(), ".config", "gcal-skill", "credentials.json");

const FAKE = process.env.GCAL_FAKE === "1";

function creds() {
  let clientId = env("GCAL_CLIENT_ID");
  let clientSecret = env("GCAL_CLIENT_SECRET");
  let refreshToken = env("GCAL_REFRESH_TOKEN");
  if (!(clientId && clientSecret && refreshToken)) {
    try {
      const j = JSON.parse(fs.readFileSync(SKILL_CREDS, "utf8"));
      clientId = clientId || j.client_id;
      clientSecret = clientSecret || j.client_secret;
      refreshToken = refreshToken || j.refresh_token;
    } catch {}
  }
  if (!(clientId && clientSecret && refreshToken)) {
    throw new Error(
      "Google credentials missing. Run `node scripts/auth.js` once, or set " +
      "GCAL_CLIENT_ID/GCAL_CLIENT_SECRET/GCAL_REFRESH_TOKEN in .clawd-calendar.env"
    );
  }
  return { clientId, clientSecret, refreshToken };
}

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const c = creds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function api(method, url, body) {
  const tok = await accessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`gcal ${method} ${res.status}: ${await res.text()}`);
  return res.json();
}

// Busy blocks on the owner's calendar → [{ start, end }] (ISO).
async function freeBusy(calendarId, timeMinIso, timeMaxIso) {
  if (FAKE) return fakeBusy();
  const j = await api("POST", "https://www.googleapis.com/calendar/v3/freeBusy", {
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    items: [{ id: calendarId }],
  });
  const cal = j.calendars && j.calendars[calendarId];
  if (!cal) throw new Error(`freebusy: no data for calendar ${calendarId}`);
  if (cal.errors && cal.errors.length) throw new Error(`freebusy: ${JSON.stringify(cal.errors)}`);
  return cal.busy || [];
}

// Every event on the owner's calendar in a window → [{ id, summary, start,
// day }] (start = ISO dateTime; day = YYYY-MM-DD for all-day events). Feeds
// the calendar-is-source-of-truth daily cap: events named like an event type
// block their day, and local bookings whose event was deleted get cancelled.
// FAKE mode: GCAL_FAKE_EVENTS (JSON array) or null = "no event data" —
// callers skip calendar reconciliation entirely when null.
async function listEvents(calendarId, timeMinIso, timeMaxIso) {
  if (FAKE) {
    try { return JSON.parse(process.env.GCAL_FAKE_EVENTS || "null"); } catch { return null; }
  }
  const out = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({
      timeMin: timeMinIso, timeMax: timeMaxIso, singleEvents: "true", maxResults: "2500",
      fields: "items(id,summary,description,start),nextPageToken",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const j = await api("GET",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
    for (const ev of j.items || []) out.push({
      id: ev.id, summary: ev.summary || "", description: ev.description || "",
      start: (ev.start && ev.start.dateTime) || null,
      day: (ev.start && ev.start.date) || null,
    });
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Create the event with the guest as attendee. sendUpdates=all → Google
// sends the invite email; conferenceDataVersion=1 → Meet link.
// Tagged via extendedProperties so tool-booked events are identifiable.
async function createEvent({ calendarId, summary, description, location, startUtc, endUtc, guestEmail, guestName, addMeet }) {
  if (FAKE) {
    console.log(`[gcal:fake] createEvent ${JSON.stringify({ summary, location, startUtc, endUtc, guestEmail, addMeet, description })}`);
    return { id: `fake-${Date.now()}`, htmlLink: "https://calendar.google.com/fake", meetLink: "https://meet.google.com/fake-fake-fake" };
  }
  const qs = new URLSearchParams({ sendUpdates: "all", conferenceDataVersion: addMeet ? "1" : "0" });
  const body = {
    summary,
    description,
    start: { dateTime: startUtc },
    end: { dateTime: endUtc },
    attendees: [{ email: guestEmail, displayName: guestName }],
    extendedProperties: { private: { scheduler: "true" } },
    reminders: { useDefault: true },
  };
  if (location) body.location = location;
  if (addMeet) {
    body.conferenceData = {
      createRequest: { requestId: `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  const ev = await api("POST",
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`, body);
  const meetLink = ev.hangoutLink ||
    (ev.conferenceData && ev.conferenceData.entryPoints || []).map((e) => e.uri).find(Boolean) || null;
  return { id: ev.id, htmlLink: ev.htmlLink, meetLink };
}

// Owner-only companion event (e.g. a "Prepare" block before an episode):
// no attendees, no invite email, no Meet — just a block on the calendar.
async function createOwnerEvent({ calendarId, summary, description, startUtc, endUtc }) {
  if (FAKE) {
    console.log(`[gcal:fake] createOwnerEvent ${JSON.stringify({ summary, startUtc, endUtc, description })}`);
    return { id: `fake-prep-${Date.now()}` };
  }
  const ev = await api("POST",
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
      summary,
      description,
      start: { dateTime: startUtc },
      end: { dateTime: endUtc },
      extendedProperties: { private: { scheduler: "true" } },
      reminders: { useDefault: true },
    });
  return { id: ev.id };
}

// Move an existing event to a new time. sendUpdates=all → Google emails the
// guest an "event updated" notice; everything else on the event (description,
// Meet link, attendees) is untouched. Throws with .status = 404/410 when the
// event is gone, so callers can cancel the local booking.
async function patchEventTime({ calendarId, eventId, startUtc, endUtc, sendUpdates = "all" }) {
  if (FAKE) {
    console.log(`[gcal:fake] patchEventTime ${JSON.stringify({ eventId, startUtc, endUtc })}`);
    return { id: eventId };
  }
  const tok = await accessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ start: { dateTime: startUtc }, end: { dateTime: endUtc } }),
    });
  if (!res.ok) {
    const err = new Error(`gcal PATCH ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Remove an event. sendUpdates=all → Google emails the guest the
// cancellation. Already-gone events (404/410) are treated as success —
// the goal state is "not on the calendar".
async function deleteEvent({ calendarId, eventId, sendUpdates = "all" }) {
  if (FAKE) {
    console.log(`[gcal:fake] deleteEvent ${JSON.stringify({ eventId, sendUpdates })}`);
    return;
  }
  const tok = await accessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok && res.status !== 404 && res.status !== 410)
    throw new Error(`gcal DELETE ${res.status}: ${await res.text()}`);
}

// Fake-mode busy blocks: tomorrow 9–10am and 2–3pm in the owner TZ (approx,
// expressed in UTC) so the grid visibly has holes during local dev.
function fakeBusy() {
  const d = new Date(Date.now() + 86_400_000);
  const day = d.toISOString().slice(0, 10);
  return [
    { start: `${day}T15:00:00Z`, end: `${day}T16:00:00Z` },
    { start: `${day}T20:00:00Z`, end: `${day}T21:00:00Z` },
  ];
}

// ── guest calendar overlay (Phase 2) ─────────────────────────────────────
// A SEPARATE "Web application" OAuth client: the guest consents in the
// browser with the freebusy scope only, we use their access token ONCE to
// fetch busy blocks, and never persist it.

function webCreds() {
  const clientId = env("GCAL_WEB_CLIENT_ID");
  const clientSecret = env("GCAL_WEB_CLIENT_SECRET");
  if (!(clientId && clientSecret)) return null; // overlay feature disabled
  return { clientId, clientSecret };
}

// profile (non-sensitive) rides along so the booking form can prefill the
// guest's name, not just their email.
const GUEST_SCOPE = "openid email profile https://www.googleapis.com/auth/calendar.freebusy";

function guestAuthUrl(redirectUri, state) {
  const c = webCreds();
  if (!c) return null;
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GUEST_SCOPE,
    state,
    prompt: "select_account",
  });
}

// code → { email, name, accessToken, expiresIn } (short-lived; used once
// server-side, then handed to the GUEST'S browser so it can re-poll its own
// free/busy — the server never stores it)
async function guestExchange(code, redirectUri) {
  if (FAKE) return { email: "guest@example.com", name: "Guest Example", accessToken: "fake", expiresIn: 3600 };
  const c = webCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.clientId, client_secret: c.clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`guest exchange failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  let email = null, name = null;
  if (j.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64url").toString());
      email = payload.email || null;
      name = payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(" ") || null;
    } catch {}
  }
  return { email, name, accessToken: j.access_token, expiresIn: j.expires_in || 3600 };
}

// Guest's busy blocks on their primary calendar, via their own token.
async function guestFreeBusy(accessToken, timeMinIso, timeMaxIso) {
  if (FAKE) return fakeGuestBusy();
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: "primary" }] }),
  });
  if (!res.ok) throw new Error(`guest freebusy: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return (j.calendars && j.calendars.primary && j.calendars.primary.busy) || [];
}

// Fake guest: busy 10am–noon MT (16:00–18:00Z) for the next week, so the
// overlay visibly tints some slots red in local dev.
function fakeGuestBusy() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ start: `${day}T16:00:00Z`, end: `${day}T18:00:00Z` });
  }
  return out;
}

module.exports = { freeBusy, listEvents, createEvent, createOwnerEvent, patchEventTime, deleteEvent, creds, FAKE, webCreds, guestAuthUrl, guestExchange, guestFreeBusy };
