// Owner notifications on new bookings. Telegram only for now; best-effort —
// a notify failure must never affect the booking the guest already has.

const CONFIG = require("./config");

// Fire-and-forget: callers don't await this.
async function bookingNotify({ guestName, guestEmail, note, startUtc, endUtc, typeLabel, tokenLabel, meetLink }) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const when = new Date(startUtc).toLocaleString("en-US", {
    timeZone: CONFIG.ownerTz,
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const mins = Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 60_000);
  const lines = [
    `🗓 ${typeLabel || "New booking"}: ${guestName}`,
    `${when} (${mins} min)`,
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
