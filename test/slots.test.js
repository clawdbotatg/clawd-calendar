const { test } = require("node:test");
const assert = require("node:assert");
const { getOpenSlots } = require("../lib/slots");
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

test("capCounts:any — any busy block closes the day for standard, not vip", () => {
  const cfg = { ...CONFIG, capCounts: "any" };
  const busy = [{ start: mtnIso(7, 12), end: mtnIso(7, 13) }];
  const std = getOpenSlots({ config: cfg, token: null, busy, bookedByDay: {}, now: NOW });
  assert.equal(startsOn(std, 7).length, 0, "dentist closes the day when capCounts=any");
  const vip = getOpenSlots({ config: cfg, token: { tier: "vip" }, busy, bookedByDay: {}, now: NOW });
  assert.ok(startsOn(vip, 7).length > 0);
});
