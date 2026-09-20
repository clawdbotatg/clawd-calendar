// Public (no-password) links: bare / and /<type> resolve to the route's
// public token; disabling it re-arms the password gate.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cal-db-test-"));
process.env.CAL_DB = path.join(tmp, "test.db");
const db = require("../lib/db");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("getPublicToken resolves per route and respects disable", () => {
  db.open();
  db.createType({ key: "slop", label: "SLOP.COMPUTER" });
  db.createToken({ token: "pub-default", label: "walk-ins", isPublic: true, durationMin: 30 });
  db.createToken({ token: "pub-slop", label: "slop public", typeKey: "slop", isPublic: true });
  db.createToken({ token: "normal-pw", label: "friends" });

  // Each route gets its own public token; duration override rides along.
  assert.equal(db.getPublicToken(null).token, "pub-default");
  assert.equal(db.getPublicToken(null).durationMin, 30);
  assert.equal(db.getPublicToken("slop").token, "pub-slop");

  // Unknown route or no public token → null (gate stays up).
  assert.equal(db.getPublicToken("nope"), null);

  // A non-public token never leaks into public resolution.
  db.setTokenDisabled("pub-slop", true);
  assert.equal(db.getPublicToken("slop"), null);
  db.setTokenDisabled("pub-slop", false);
  assert.equal(db.getPublicToken("slop").token, "pub-slop");

  // Newest public token wins when there are several.
  db.createToken({ token: "pub-default-2", label: "walk-ins v2", isPublic: true });
  assert.equal(db.getPublicToken(null).token, "pub-default-2");
});

test("manage keys: minted on booking, looked up, rescheduled", () => {
  db.open();
  db.createToken({ token: "pw1", label: "test link" });
  const id = db.logBooking({
    token: "pw1", guestName: "Ada", guestEmail: "ada@example.com",
    startUtc: "2099-01-05T17:00:00.000Z", endUtc: "2099-01-05T18:00:00.000Z",
    ownerDayKey: "2099-01-05", gcalEventId: "ev1", prepGcalEventId: "prep1", wrapGcalEventId: "wrap1",
  });

  // A key was minted automatically and resolves back to the booking.
  const row = db.listBookings().find((b) => b.id === id);
  assert.ok(row.manageKey && row.manageKey.length >= 10);
  const b = db.getBookingByKey(row.manageKey);
  assert.equal(b.id, id);
  assert.equal(b.prepGcalEventId, "prep1");
  assert.equal(b.wrapGcalEventId, "wrap1");
  assert.equal(db.getBookingByKey("nope"), null);
  assert.equal(db.getBookingByKey(null), null);

  // Reschedule moves the times + day key, frees the old day for the cap.
  assert.ok(db.rescheduleBooking(id, {
    startUtc: "2099-01-07T17:00:00.000Z", endUtc: "2099-01-07T18:00:00.000Z",
    ownerDayKey: "2099-01-07",
  }));
  const moved = db.getBookingByKey(row.manageKey);
  assert.equal(moved.startUtc, "2099-01-07T17:00:00.000Z");
  assert.equal(moved.ownerDayKey, "2099-01-07");
  assert.deepEqual(db.bookedByDay(null), { "2099-01-07": 1 });

  // The key survives (same link keeps working); cancelled bookings don't move.
  db.setPrepEventId(id, "prep2");
  assert.equal(db.getBookingByKey(row.manageKey).prepGcalEventId, "prep2");
  db.setWrapEventId(id, "wrap2");
  assert.equal(db.getBookingByKey(row.manageKey).wrapGcalEventId, "wrap2");
  db.cancelBooking(id);
  assert.equal(db.rescheduleBooking(id, {
    startUtc: "2099-01-08T17:00:00.000Z", endUtc: "2099-01-08T18:00:00.000Z",
    ownerDayKey: "2099-01-08",
  }), false);
});

test("extraEmails round-trips through logBooking and setExtraEmails", () => {
  db.open();
  const id = db.logBooking({
    token: "normal-pw", guestName: "Grace", guestEmail: "grace@example.com",
    startUtc: "2099-02-01T17:00:00.000Z", endUtc: "2099-02-01T18:00:00.000Z",
    ownerDayKey: "2099-02-01", extraEmails: ["ada@example.com", "alan@example.com"],
  });
  const key = db.listBookings().find((b) => b.id === id).manageKey;
  assert.deepEqual(db.extraEmailsOf(db.getBookingByKey(key)), ["ada@example.com", "alan@example.com"]);

  // Update replaces the list; empty list stores NULL; parse is defensive.
  assert.ok(db.setExtraEmails(id, ["ada@example.com"]));
  assert.deepEqual(db.extraEmailsOf(db.getBookingByKey(key)), ["ada@example.com"]);
  assert.ok(db.setExtraEmails(id, []));
  assert.equal(db.getBookingByKey(key).extraEmails, null);
  assert.deepEqual(db.extraEmailsOf(db.getBookingByKey(key)), []);
  assert.deepEqual(db.extraEmailsOf({ extraEmails: "not-json{" }), []);

  // No guests at booking time → NULL, and cancelled bookings can't be edited.
  const id2 = db.logBooking({
    token: "normal-pw", guestName: "Solo", guestEmail: "solo@example.com",
    startUtc: "2099-02-02T17:00:00.000Z", endUtc: "2099-02-02T18:00:00.000Z",
    ownerDayKey: "2099-02-02",
  });
  const key2 = db.listBookings().find((b) => b.id === id2).manageKey;
  assert.equal(db.getBookingByKey(key2).extraEmails, null);
  db.cancelBooking(id2);
  assert.equal(db.setExtraEmails(id2, ["x@y.zz"]), false);
});
