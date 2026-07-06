// All personalization comes from env vars (or the gitignored
// .clawd-calendar.env). Defaults below are generic — see .env.example.

const { env } = require("./env");

const list = (v) => String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const bool = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const num = (v) => +v;

module.exports = {
  ownerName: env("CAL_OWNER_NAME", "the host"),
  ownerTz: env("CAL_OWNER_TZ", "America/Denver"),
  calendarId: env("CAL_CALENDAR_ID", "primary"),
  baseUrl: env("CAL_BASE_URL", "http://127.0.0.1:8788"),
  port: num(env("CAL_PORT", 8788)),

  window: {
    days: list(env("CAL_WINDOW_DAYS", "mon,tue,wed,thu,fri")),
    start: env("CAL_WINDOW_START", "08:00"),
    end: env("CAL_WINDOW_END", "17:00"),
  },
  vipWindow: {
    days: list(env("CAL_VIP_DAYS", "mon,tue,wed,thu,fri,sat,sun")),
    start: env("CAL_VIP_START", "08:00"),
    end: env("CAL_VIP_END", "21:00"),
  },

  slotMinutes: num(env("CAL_SLOT_MINUTES", 60)),
  slotStepMinutes: num(env("CAL_SLOT_STEP_MINUTES", 30)),
  bufferBeforeMinutes: num(env("CAL_BUFFER_BEFORE_MINUTES", 15)),
  bufferAfterMinutes: num(env("CAL_BUFFER_AFTER_MINUTES", 0)),
  minNoticeHours: num(env("CAL_MIN_NOTICE_HOURS", 2)),
  noSameDay: bool(env("CAL_NO_SAME_DAY", "false")),
  maxDaysOut: num(env("CAL_MAX_DAYS_OUT", 21)),
  dailyCap: num(env("CAL_DAILY_CAP", 1)),
  capCounts: env("CAL_CAP_COUNTS", "tool"), // "tool" | "any"

  eventTitle: env("CAL_EVENT_TITLE", "Call: {name}"),
  addMeetLink: bool(env("CAL_ADD_MEET", "true")),

  // booking-page info panel (all optional)
  pageTitle: env("CAL_PAGE_TITLE", ""),       // default: "Book a call with <owner>"
  pageDescription: env("CAL_PAGE_DESCRIPTION", ""),
  avatarUrl: env("CAL_AVATAR_URL", ""),
};
