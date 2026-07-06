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

// Create the event with the guest as attendee. sendUpdates=all → Google
// sends the invite email; conferenceDataVersion=1 → Meet link.
// Tagged via extendedProperties so tool-booked events are identifiable.
async function createEvent({ calendarId, summary, description, startUtc, endUtc, guestEmail, guestName, addMeet }) {
  if (FAKE) {
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

module.exports = { freeBusy, createEvent, creds, FAKE };
