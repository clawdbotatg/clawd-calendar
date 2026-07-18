// Owner notifications on new bookings. Telegram only for now; best-effort —
// a notify failure must never affect the booking the guest already has.

const CONFIG = require("./config");

const fmtWhen = (iso) => new Date(iso).toLocaleString("en-US", {
  timeZone: CONFIG.ownerTz,
  weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

// Fire-and-forget: callers don't await this. oldStartUtc set = a reschedule;
// cancelled set = a guest self-cancel.
async function bookingNotify({ guestName, guestEmail, note, startUtc, endUtc, typeLabel, tokenLabel, meetLink, oldStartUtc, cancelled }) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const when = fmtWhen(startUtc);
  const mins = Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 60_000);
  const verb = cancelled ? "❌ Cancelled" : oldStartUtc ? "♻️ Rescheduled" : "🗓";
  const lines = [
    `${verb} ${typeLabel || (cancelled || oldStartUtc ? "booking" : "New booking")}: ${guestName}`,
    oldStartUtc ? `${fmtWhen(oldStartUtc)} → ${when} (${mins} min)` : `${when} (${mins} min)${cancelled ? " — day freed" : ""}`,
    `${guestEmail} — via "${tokenLabel}"`,
  ];
  if (note) lines.push(`📝 ${note}`);
  if (meetLink) lines.push(meetLink);
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: lines.join("\n") }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[notify] telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error(`[notify] telegram failed: ${err.message}`);
  }
}

module.exports = { bookingNotify };
