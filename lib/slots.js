// The rules engine — one pure function. All inputs injected so it's testable
// and reusable by any client (web UI, book-time re-check, future voice agent).

const { zonedToUtc, dayKey, weekday, parseHHMM } = require("./tz");

/**
 * getOpenSlots(opts) → [{ startUtc, endUtc }] (ISO strings, ascending)
 *
 * opts:
 *   config       app config (ownerTz, window, slotMinutes, slotStepMinutes,
 *                bufferBeforeMinutes, bufferAfterMinutes, minNoticeHours,
 *                noSameDay, maxDaysOut, dailyCap, capCounts, vipWindow)
 *   token        row from tokens table; tier + per-token overrides
 *   busy         [{ start, end }] ISO or epoch-ms busy blocks (owner's calendar)
 *   bookedByDay  { "YYYY-MM-DD" (owner TZ) → count } — tool-booked events per day
 *   now          epoch ms "current time" (injected for testability)
 *
 * Token tiers:
 *   standard — config window, busy subtracted, daily cap enforced
 *   vip      — wide window (config.vipWindow), busy subtracted, no daily cap
 *   override — wide window, busy IGNORED (owner will move things), no cap
 * Any token may also carry windowOverride / durationMin / bypassDailyCap /
 * ignoreBusy directly; tier just sets the defaults.
 */
function getOpenSlots({ config, token, busy, bookedByDay, now }) {
  const tz = config.ownerTz;
  const t = effectiveRules(config, token);

  const days = new Set(t.window.days.map((d) => d.toLowerCase().slice(0, 3)));
  const wStart = parseHHMM(t.window.start);
  const wEnd = parseHHMM(t.window.end);

  const durMs = t.durationMin * 60_000;
  const stepMs = (config.slotStepMinutes || t.durationMin) * 60_000;
  const bufBeforeMs = (config.bufferBeforeMinutes || 0) * 60_000;
  const bufAfterMs = (config.bufferAfterMinutes || 0) * 60_000;
  const noticeMs = (config.minNoticeHours || 0) * 3_600_000;

  const busyBlocks = t.ignoreBusy ? [] : (busy || [])
    .map((b) => ({ s: toMs(b.start), e: toMs(b.end) }))
    .filter((b) => b.e > b.s);

  const todayKey = dayKey(now, tz);
  const earliest = now + noticeMs;
  const slots = [];

  // Walk calendar days in the owner's TZ, from today out to maxDaysOut.
  // Anchor each day via noon-UTC stepping to dodge DST double/missing hours.
  const t0 = new Date(now);
  const anchor = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate(), 12);
  const seen = new Set();
  for (let i = -1; i <= config.maxDaysOut + 1; i++) {
    const probe = anchor + i * 86_400_000;
    const key = dayKey(probe, tz);
    if (seen.has(key)) continue;
    seen.add(key);
    if (key < todayKey) continue;
    if (config.noSameDay && key === todayKey) continue;

    if (!days.has(weekday(probe, tz))) continue;

    const cap = config.dailyCap ?? 1;
    if (!t.bypassDailyCap && cap > 0 && (bookedByDay[key] || 0) >= cap) continue;

    // capCounts:"any" — any busy block touching this day closes it entirely.
    if (config.capCounts === "any" && !t.bypassDailyCap &&
        busyBlocks.some((b) => dayKey(b.s, tz) === key || dayKey(b.e - 1, tz) === key)) continue;

    const [y, m, d] = key.split("-").map(Number);
    const dayStart = zonedToUtc(y, m, d, wStart.hh, wStart.mm, tz);
    const dayEnd = zonedToUtc(y, m, d, wEnd.hh, wEnd.mm, tz);
    // Don't offer days beyond maxDaysOut from now.
    if (dayStart > now + config.maxDaysOut * 86_400_000) continue;

    // Slot must START and END inside the window; starts step every stepMs.
    // The prep buffer is checked against BUSY EVENTS only, not the window
    // edge — an 8:00 slot with 7:45 prep is fine.
    for (let s = dayStart; s + durMs <= dayEnd; s += stepMs) {
      const e = s + durMs;
      if (s < earliest) continue;
      const clash = busyBlocks.some((b) => b.s < e + bufAfterMs && b.e > s - bufBeforeMs);
      if (clash) continue;
      slots.push({ startUtc: new Date(s).toISOString(), endUtc: new Date(e).toISOString() });
    }
  }
  return slots;
}

// Resolve tier presets + per-token overrides into effective rules.
function effectiveRules(config, token) {
  const tier = (token && token.tier) || "standard";
  const wide = config.vipWindow || {
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    start: "08:00", end: "21:00",
  };
  const base = {
    standard: { window: config.window, bypassDailyCap: false, ignoreBusy: false },
    vip:      { window: wide, bypassDailyCap: true, ignoreBusy: false },
    override: { window: wide, bypassDailyCap: true, ignoreBusy: true },
  }[tier] || { window: config.window, bypassDailyCap: false, ignoreBusy: false };

  return {
    window: (token && token.windowOverride) || base.window,
    durationMin: (token && token.durationMin) || config.slotMinutes,
    bypassDailyCap: token && token.bypassDailyCap != null ? !!token.bypassDailyCap : base.bypassDailyCap,
    ignoreBusy: token && token.ignoreBusy != null ? !!token.ignoreBusy : base.ignoreBusy,
  };
}

function toMs(v) {
  return typeof v === "number" ? v : Date.parse(v);
}

module.exports = { getOpenSlots, effectiveRules };
