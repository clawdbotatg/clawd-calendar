#!/usr/bin/env node
// Create/list event types — each type is a route (/<key>/<password>) with
// its own landing style and scheduling rules; tokens are minted INTO a type
// (scripts/mint.js --type <key>). Anything unset inherits the env config.
//
//   node scripts/types.js "Quick Chat" --key q --duration 20 --daily-cap 3 \
//        --accent "#f5a623" --desc "20 minutes, no agenda needed." \
//        --event-title "Quick chat: {name}"
//   node scripts/types.js "Office Hours" --key office --duration 30 \
//        --days fri --start 14:00 --end 16:00 --daily-cap 4
//   node scripts/types.js --list
//   node scripts/types.js --disable q     (kills all its links; --enable undoes)
//
// Daily caps count per type — filling office hours doesn't consume the
// default type's one-call-per-day budget.

const db = require("../lib/db");
const config = require("../lib/config");

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; }
function has(name) { return argv.includes(`--${name}`); }

// "a" is the built-in default type; the rest shadow real routes.
const RESERVED = ["a", "api", "oauth", "healthz", "assets", "public", "data"];

if (has("list")) {
  for (const t of db.listTypes()) {
    const bits = [
      t.durationMin ? `${t.durationMin}min` : null,
      t.window ? JSON.parse(t.window).days.join("/") : null,
      t.dailyCap != null ? `cap:${t.dailyCap}/day` : null,
    ].filter(Boolean).join(" · ");
    console.log(`${t.disabled ? "✗" : "✓"} [${t.key.padEnd(8)}] ${t.label.padEnd(20)} ${bits.padEnd(28)} ${config.baseUrl}/${t.key}/<password>`);
  }
  process.exit(0);
}

for (const action of ["disable", "enable"]) {
  if (has(action)) {
    const key = flag(action);
    if (!key) { console.error(`usage: node scripts/types.js --${action} <key>`); process.exit(1); }
    if (!db.setTypeDisabled(key, action === "disable")) { console.error(`no such type "${key}"`); process.exit(1); }
    console.log(`${action}d "${key}"`);
    process.exit(0);
  }
}

let label = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (argv[i] !== "--list") i++; continue; }
  label = argv[i]; break;
}
const key = flag("key");
if (!label || !key) {
  console.error('usage: node scripts/types.js "<label>" --key <route> [--duration <min>] [--step <min>] [--days mon,tue] [--start HH:MM] [--end HH:MM] [--daily-cap <n>] [--min-notice <hours>] [--max-days <n>] [--title <page title>] [--subtitle <line>] [--desc <text>] [--accent "#rrggbb"] [--event-title "Chat: {name}"]');
  process.exit(1);
}
if (!/^[a-z0-9_-]{1,32}$/.test(key)) { console.error(`bad key "${key}" — lowercase letters/digits/-/_ only`); process.exit(1); }
if (RESERVED.includes(key)) { console.error(`key "${key}" is reserved`); process.exit(1); }
if (db.listTypes().some((t) => t.key === key)) { console.error(`type "${key}" already exists`); process.exit(1); }
const accent = flag("accent");
if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) { console.error(`bad accent "${accent}" — use #rrggbb`); process.exit(1); }

const window = (flag("days") || flag("start") || flag("end")) ? {
  days: (flag("days") || "mon,tue,wed,thu,fri").split(","),
  start: flag("start") || "08:00",
  end: flag("end") || "17:00",
} : null;

db.createType({
  key, label, window,
  durationMin: flag("duration") ? +flag("duration") : null,
  stepMinutes: flag("step") ? +flag("step") : null,
  dailyCap: flag("daily-cap") ? +flag("daily-cap") : null,
  minNoticeHours: flag("min-notice") ? +flag("min-notice") : null,
  maxDaysOut: flag("max-days") ? +flag("max-days") : null,
  eventTitle: flag("event-title"),
  pageTitle: flag("title"),
  pageSubtitle: flag("subtitle"),
  pageDescription: flag("desc"),
  accentColor: accent,
});

console.log(`created event type [${key}] "${label}"`);
console.log(`  route: ${config.baseUrl}/${key}/<password>`);
console.log(`  mint a link: node scripts/mint.js "someone" --type ${key}`);
