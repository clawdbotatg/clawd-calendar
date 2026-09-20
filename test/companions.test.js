// Companion-block (prep/wrap) handling on reschedule/cancel, driven against
// server.js's helpers with the gcal module stubbed. server.js only listens
// when run directly, so require()ing it here is side-effect free apart from
// opening the (temp) db.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cal-comp-test-"));
process.env.CAL_DB = path.join(tmp, "test.db");
process.env.GCAL_FAKE = "1";
const db = require("../lib/db");
const gcal = require("../lib/gcal");
const { moveCompanion, deleteCompanion, findCompanionEventId } = require("../server");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cfg = { calendarId: "primary", prepMinutes: 15, wrapMinutes: 15, eventTitle: "SLOP.COMPUTER" };
const gone = (status) => { const e = new Error(`gcal PATCH ${status}`); e.status = status; return e; };

function booking(over = {}) {
  db.open();
  db.createToken({ token: `pw-${Math.random()}`, label: "t" });
  const row = {
    token: null, guestName: "Ada", guestEmail: "ada@example.com",
    startUtc: "2099-01-05T17:00:00.000Z", endUtc: "2099-01-05T18:00:00.000Z",
    ownerDayKey: "2099-01-05", gcalEventId: "ev1", ...over,
  };
  row.token = db.listTokens()[0].token;
  const id = db.logBooking(row);
  return db.listBookings().find((b) => b.id === id);
}
const slot = { startUtc: "2099-01-07T17:00:00.000Z", endUtc: "2099-01-07T18:00:00.000Z" };

for (const status of [404, 410]) {
  test(`moveCompanion: a stored wrap id whose event is gone (${status}) gets recreated + persisted`, async () => {
    const b = booking({ prepGcalEventId: "prep-old", wrapGcalEventId: "wrap-old" });
    const calls = [];
    const orig = { patch: gcal.patchEventTime, create: gcal.createOwnerEvent };
    gcal.patchEventTime = async (o) => { calls.push(["patch", o.eventId]); if (o.eventId === "wrap-old") throw gone(status); };
    gcal.createOwnerEvent = async (o) => { calls.push(["create", o.summary, o.startUtc, o.endUtc]); return { id: "wrap-new" }; };
    try {
      await moveCompanion("prep", cfg, b, slot);
      await moveCompanion("wrap", cfg, b, slot);
    } finally { Object.assign(gcal, { patchEventTime: orig.patch, createOwnerEvent: orig.create }); }
    assert.deepEqual(calls, [
      ["patch", "prep-old"],
      ["patch", "wrap-old"],
      ["create", "Wrap up: SLOP.COMPUTER", "2099-01-07T18:00:00.000Z", "2099-01-07T18:15:00.000Z"],
    ]);
    const fresh = db.getBookingByKey(b.manageKey);
    assert.equal(fresh.wrapGcalEventId, "wrap-new", "replacement id persisted");
    assert.equal(fresh.prepGcalEventId, "prep-old", "prep untouched");
  });
}

test("moveCompanion: other errors are swallowed (booking already moved), id unchanged", async () => {
  const b = booking({ wrapGcalEventId: "wrap-old" });
  const orig = gcal.patchEventTime;
  gcal.patchEventTime = async () => { throw gone(500); };
  try { await moveCompanion("wrap", cfg, b, slot); } finally { gcal.patchEventTime = orig; }
  assert.equal(db.getBookingByKey(b.manageKey).wrapGcalEventId, "wrap-old");
});

test("legacy lookup: a same-time 'Wrap up:' block for ANOTHER guest is never touched", async () => {
  const b = booking({ wrapGcalEventId: null });
  const orig = { list: gcal.listEvents, del: gcal.deleteEvent };
  const deleted = [];
  gcal.listEvents = async () => [
    { id: "theirs", summary: "Wrap up: SLOP.COMPUTER", description: "wrap-up with Bob <bob@example.com>.", start: b.endUtc },
  ];
  gcal.deleteEvent = async (o) => { deleted.push(o.eventId); };
  try {
    assert.equal(await findCompanionEventId("wrap", cfg, b), null);
    await deleteCompanion("wrap", cfg, b);
    gcal.listEvents = async () => [
      { id: "theirs", summary: "Wrap up: SLOP.COMPUTER", description: "wrap-up with Bob <bob@example.com>.", start: b.endUtc },
      { id: "ours", summary: "Wrap up: SLOP.COMPUTER", description: "wrap-up with Ada <ada@example.com>.", start: b.endUtc },
    ];
    assert.equal(await findCompanionEventId("wrap", cfg, b), "ours");
    await deleteCompanion("wrap", cfg, b);
  } finally { Object.assign(gcal, { listEvents: orig.list, deleteEvent: orig.del }); }
  assert.deepEqual(deleted, ["ours"]);
});
