const { test } = require("node:test");
const assert = require("node:assert");
const { getOpenSlots, applyType } = require("../lib/slots");
const { zonedToUtc, dayKey } = require("../lib/tz");

const TZ = "America/Denver";
const CONFIG = {
  ownerTz: TZ,
  window: { days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "17:00" },
  vipWindow: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "08:00", end: "21:00" },
  slotMinutes: 60,
  slotStepMinutes: 30,
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 0,
  minNoticeHours: 2,
  noSameDay: false,
  maxDaysOut: 21,
  dailyCap: 1,
  capCounts: "tool",
};

// Fixed "now": Monday 2026-07-06 06:00 Denver time.
const NOW = zonedToUtc(2026, 7, 6, 6, 0, TZ);
const mtnIso = (d, hh, mm = 0) => new Date(zonedToUtc(2026, 7, d, hh, mm, TZ)).toISOString();

function run(over = {}) {
  return getOpenSlots({ config: CONFIG, token: null, busy: [], bookedByDay: {}, now: NOW, ...over });
}
const startsOn = (slots, d) => slots.filter((s) => dayKey(Date.parse(s.startUtc), TZ) === `2026-07-${String(d).padStart(2, "0")}`).map((s) => s.startUtc);

test("weekday window, 30-min steps, 1h slots ending by 5pm", () => {
  const monday = startsOn(run(), 7); // Tuesday the 7th (full day, no notice cutoff)
  assert.equal(monday[0], mtnIso(7, 8, 0));                    // first start 8:00
  assert.equal(monday[monday.length - 1], mtnIso(7, 16, 0));   // last start 16:00 (ends 17:00)
  assert.equal(monday.length, 17);                             // 8:00..16:00 every 30m
});

test("no weekend slots for standard tier", () => {
  const slots = run();
  assert.equal(startsOn(slots, 11).length, 0); // Sat Jul 11
  assert.equal(startsOn(slots, 12).length, 0); // Sun Jul 12
});

test("min notice: same-day slots before now+2h are hidden", () => {
  const today = startsOn(run(), 6); // Monday the 6th, now = 6:00am
  assert.equal(today[0], mtnIso(6, 8, 0)); // 8:00 ≥ 6:00+2h — earliest allowed
});

test("Austin's example: busy 9–10 blocks 10:00 (needs 15-min prep), 10:30 ok", () => {
  const busy = [{ start: mtnIso(7, 9), end: mtnIso(7, 10) }];
  const tue = startsOn(run({ busy }), 7);
  assert.ok(!tue.includes(mtnIso(7, 10, 0)), "10:00 should be blocked");
  assert.ok(tue.includes(mtnIso(7, 10, 30)), "10:30 should be open");
  assert.ok(!tue.includes(mtnIso(7, 8, 30)), "8:30 overlaps the 9:00 meeting");
  assert.ok(tue.includes(mtnIso(7, 8, 0)), "8:00 ends exactly at 9:00 — ok (no after-buffer)");
});

test("8:00 bookable even though 7:45 prep is outside the window", () => {
  assert.ok(startsOn(run(), 7).includes(mtnIso(7, 8, 0)));
});

test("daily cap closes a booked day; VIP bypasses it", () => {
  const bookedByDay = { "2026-07-07": 1 };
  assert.equal(startsOn(run({ bookedByDay }), 7).length, 0);
  const vip = run({ bookedByDay, token: { tier: "vip" } });
  assert.ok(startsOn(vip, 7).length > 0, "vip sees the capped day");
});

test("vip gets weekends + evenings, still respects busy", () => {
  const busy = [{ start: mtnIso(11, 9), end: mtnIso(11, 10) }]; // Sat 9–10
  const vip = run({ busy, token: { tier: "vip" } });
  const sat = startsOn(vip, 11);
  assert.ok(sat.length > 0, "saturday open for vip");
  assert.ok(!sat.includes(mtnIso(11, 10, 0)), "prep buffer applies to vip too");
  assert.ok(sat.includes(mtnIso(11, 19, 0)), "evening slot (ends 20:00 ≤ 21:00)");
});

test("override tier ignores busy entirely", () => {
  const busy = [{ start: mtnIso(7, 8), end: mtnIso(7, 17) }]; // whole Tuesday busy
  const ov = run({ busy, token: { tier: "override" } });
  assert.ok(startsOn(ov, 7).includes(mtnIso(7, 10, 0)), "override sees slots through busy");
});

test("nothing offered beyond maxDaysOut", () => {
  const slots = run();
  const last = dayKey(Date.parse(slots[slots.length - 1].startUtc), TZ);
  assert.ok(last <= "2026-07-27", `last day ${last} within 21 days`);
});

test("token windowOverride + durationMin respected", () => {
  const tok = { tier: "standard", windowOverride: { days: ["sat"], start: "09:00", end: "12:00" }, durationMin: 90 };
  const slots = run({ token: tok });
  const sat = startsOn(slots, 11);
  assert.equal(sat[0], mtnIso(11, 9, 0));
  assert.equal(sat[sat.length - 1], mtnIso(11, 10, 30)); // 10:30+90m = 12:00
  for (const s of slots) assert.equal(dayKey(Date.parse(s.startUtc), TZ).length, 10);
  assert.equal(startsOn(slots, 7).length, 0, "weekdays excluded by override");
});

test("DST spring-forward day doesn't crash or duplicate (Mar 8 2026)", () => {
  const now = zonedToUtc(2026, 3, 2, 6, 0, TZ); // Mon Mar 2
  const slots = getOpenSlots({
    config: { ...CONFIG, window: { days: ["sun", "mon"], start: "08:00", end: "10:00" } },
    token: null, busy: [], bookedByDay: {}, now,
  });
  const mar8 = slots.filter((s) => dayKey(Date.parse(s.startUtc), TZ) === "2026-03-08");
  assert.ok(mar8.length > 0, "DST day has slots");
  const starts = new Set(mar8.map((s) => s.startUtc));
  assert.equal(starts.size, mar8.length, "no duplicate slots on DST day");
  // 8:00 MDT on Mar 8 = 14:00 UTC (MDT is UTC-6 after spring-forward)
  assert.equal(new Date(mar8[0].startUtc).toISOString(), "2026-03-08T14:00:00.000Z");
});

test("applyType overlays type rules onto config; unset fields inherit", () => {
  const type = {
    key: "office", label: "Office Hours", durationMin: 30, stepMinutes: 30,
    window: { days: ["fri"], start: "14:00", end: "16:00" }, dailyCap: 4,
    minNoticeHours: null, maxDaysOut: null, eventTitle: "Office hours: {name}",
    pageTitle: null, pageSubtitle: null, pageDescription: null, accentColor: "#f5a623",
  };
  const cfg = applyType({ ...CONFIG, ownerName: "Austin", pageSubtitle: "a@b.c", pageDescription: "call desc" }, type);
  assert.equal(cfg.slotMinutes, 30);
  assert.deepEqual(cfg.window.days, ["fri"]);
  assert.equal(cfg.dailyCap, 4);
  assert.equal(cfg.minNoticeHours, CONFIG.minNoticeHours, "unset inherits config");
  assert.equal(cfg.maxDaysOut, CONFIG.maxDaysOut);
  assert.equal(cfg.pageTitle, "Office Hours with Austin", "typed page titles itself");
  assert.equal(cfg.pageSubtitle, "a@b.c", "subtitle inherits");
  assert.equal(cfg.pageDescription, "", "default-type description does NOT leak into a type");
  assert.equal(cfg.accentColor, "#f5a623");
  assert.equal(applyType(CONFIG, null), CONFIG, "no type = untouched config");
});

test("applyType: custom-invite fields (description, location, prep, meet)", () => {
  const type = {
    key: "slop", label: "SLOP.COMPUTER", durationMin: 60, dailyCap: 1,
    eventDescription: "an onchain podcast", eventLocation: "https://slop.computer/",
    prepMinutes: 15, addMeet: 0,
  };
  const cfg = applyType({ ...CONFIG, ownerName: "x", addMeetLink: true }, type);
  assert.equal(cfg.eventDescription, "an onchain podcast");
  assert.equal(cfg.eventLocation, "https://slop.computer/");
  assert.equal(cfg.prepMinutes, 15);
  assert.equal(cfg.addMeetLink, false, "addMeet=0 forces Meet off");

  // prep block wider than the config buffer widens the busy check
  const wide = applyType({ ...CONFIG, bufferBeforeMinutes: 15, addMeetLink: true },
    { ...type, prepMinutes: 30, addMeet: null });
  assert.equal(wide.bufferBeforeMinutes, 30, "buffer grows to cover the prep block");
  assert.equal(wide.addMeetLink, true, "addMeet null inherits config");

  const plain = applyType({ ...CONFIG, addMeetLink: true }, { key: "q", label: "Q" });
  assert.equal(plain.eventDescription, null);
  assert.equal(plain.prepMinutes, 0);
  assert.equal(plain.bufferBeforeMinutes, CONFIG.bufferBeforeMinutes);
});

test("prep block keeps a slot clear of busy events right before it", () => {
  // Busy Tue 9–10. With a 30-min prep block, the 10:00 and 10:15… slots need
  // 30 clear minutes before — 10:00 (prep 9:30–10:00 vs busy till 10:00) dies,
  // 10:30 (prep 10:00–10:30) is fine.
  const cfg = applyType({ ...CONFIG, ownerName: "x" },
    { key: "slop", label: "S", prepMinutes: 30 });
  const busy = [{ start: mtnIso(7, 9), end: mtnIso(7, 10) }];
  const starts = startsOn(getOpenSlots({ config: cfg, token: null, busy, bookedByDay: {}, now: NOW }), 7);
  assert.ok(!starts.includes(mtnIso(7, 10, 0)), "10:00 blocked — prep would overlap the 9–10 event");
  assert.ok(starts.includes(mtnIso(7, 10, 30)), "10:30 ok — prep 10:00–10:30 is clear");
});

test("typed config drives slots: 30-min office hours only on Friday 2–4pm", () => {
  const type = { label: "Office Hours", durationMin: 30, stepMinutes: 30,
    window: { days: ["fri"], start: "14:00", end: "16:00" }, dailyCap: 4 };
  const cfg = applyType({ ...CONFIG, ownerName: "x" }, type);
  const slots = getOpenSlots({ config: cfg, token: null, busy: [], bookedByDay: {}, now: NOW });
  const fri = startsOn(slots, 10); // Fri Jul 10
  assert.equal(fri.length, 4, "14:00 14:30 15:00 15:30");
  assert.equal(fri[0], mtnIso(10, 14, 0));
  assert.equal(fri[fri.length - 1], mtnIso(10, 15, 30));
  assert.equal(startsOn(slots, 7).length, 0, "no Tuesday slots for this type");
  const capped = getOpenSlots({ config: cfg, token: null, busy: [], bookedByDay: { "2026-07-10": 4 }, now: NOW });
  assert.equal(startsOn(capped, 10).length, 0, "type's own cap closes the day");
});

test("capCounts:any — any busy block closes the day for standard, not vip", () => {
  const cfg = { ...CONFIG, capCounts: "any" };
  const busy = [{ start: mtnIso(7, 12), end: mtnIso(7, 13) }];
  const std = getOpenSlots({ config: cfg, token: null, busy, bookedByDay: {}, now: NOW });
  assert.equal(startsOn(std, 7).length, 0, "dentist closes the day when capCounts=any");
  const vip = getOpenSlots({ config: cfg, token: { tier: "vip" }, busy, bookedByDay: {}, now: NOW });
  assert.ok(startsOn(vip, 7).length > 0);
});

// ── calendar-is-source-of-truth daily cap ─────────────────────────────────

const { titledDayCounts } = require("../lib/slots");

test("titledDayCounts: events named like the type spend their day", () => {
  const events = [
    { id: "1", summary: "SLOP.COMPUTER", start: mtnIso(8, 16) },              // exact
    { id: "2", summary: "Prepare: SLOP.COMPUTER", start: mtnIso(8, 15, 45) }, // companion — excluded
    { id: "3", summary: "slop.computer w/ vitalik", start: mtnIso(9, 12) },   // case-insensitive contains
    { id: "4", summary: "Dentist", start: mtnIso(9, 9) },                     // unrelated
    { id: "5", summary: "SLOP.COMPUTER planning", day: "2026-07-10" },        // all-day
    { id: "6", summary: "Podcast ep 12",                                      // match in DESCRIPTION only
      description: "recording — slop.computer with a guest", start: mtnIso(13, 10) },
    { id: "7", summary: "Prepare: episode",                                   // prep excluded even via desc
      description: '15-min prep before "SLOP.COMPUTER"', start: mtnIso(13, 9, 45) },
  ];
  assert.deepEqual(titledDayCounts(events, "SLOP.COMPUTER", TZ),
    { "2026-07-08": 1, "2026-07-09": 1, "2026-07-10": 1, "2026-07-13": 1 });

  // No fixed name to match / no event data → null (caller keeps db counts).
  assert.equal(titledDayCounts(events, "Call: {name}", TZ), null);
  assert.equal(titledDayCounts(null, "SLOP.COMPUTER", TZ), null);
});

test("titled day counts close those days for the type's cap", () => {
  const counts = titledDayCounts(
    [{ id: "1", summary: "An extra SLOP.COMPUTER ep", start: mtnIso(8, 16) }],
    "SLOP.COMPUTER", TZ);
  const slots = run({ bookedByDay: counts });
  assert.equal(startsOn(slots, 8).length, 0, "manually-added episode closes Wed");
  assert.ok(startsOn(slots, 9).length > 0, "Thu unaffected");
});

const { subtractBusy } = require("../lib/slots");

test("subtractBusy carves the guest's own event out of the busy list", () => {
  const busy = [
    { start: mtnIso(7, 9), end: mtnIso(7, 10) },    // their booking (9–10)
    { start: mtnIso(7, 13), end: mtnIso(7, 14) },   // someone else's
  ];
  // Cut covers prep + event (8:45–10:00): their block vanishes, other stays.
  const out = subtractBusy(busy, mtnIso(7, 8, 45), mtnIso(7, 10));
  assert.deepEqual(out, [{ start: mtnIso(7, 13), end: mtnIso(7, 14) }]);

  // A merged freebusy block extending past the cut keeps its remainder —
  // e.g. back-to-back meeting 10–11 merged with the booking into 9–11.
  const merged = subtractBusy([{ start: mtnIso(7, 9), end: mtnIso(7, 11) }], mtnIso(7, 9), mtnIso(7, 10));
  assert.deepEqual(merged, [{ start: mtnIso(7, 10), end: mtnIso(7, 11) }]);

  // Cut inside a block splits it in two.
  const split = subtractBusy([{ start: mtnIso(7, 9), end: mtnIso(7, 12) }], mtnIso(7, 10), mtnIso(7, 11));
  assert.deepEqual(split, [
    { start: mtnIso(7, 9), end: mtnIso(7, 10) },
    { start: mtnIso(7, 11), end: mtnIso(7, 12) },
  ]);

  // With their own block gone, their old slot is offerable again.
  const slots = run({ busy: subtractBusy(busy, mtnIso(7, 8, 45), mtnIso(7, 10)), now: NOW });
  assert.ok(startsOn(slots, 7).includes(mtnIso(7, 9)));
});
