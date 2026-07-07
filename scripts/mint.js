#!/usr/bin/env node
// Mint a password/link. The password IS the token — guests either follow
// the /a/<password> link or type the password on the landing page.
//
//   node scripts/mint.js "friends" --tier standard --token hello-austin
//   node scripts/mint.js "Vitalik" --tier vip
//   node scripts/mint.js "surprise guest" --tier override --max-uses 1
//   node scripts/mint.js "podcast" --duration 90 --days sat,sun --start 09:00 --end 12:00
//   node scripts/mint.js "hallway" --type q          (link for an event type — see scripts/types.js)
//   node scripts/mint.js --list
//
// Tiers: standard (normal rules) · vip (any day I'm free, no daily cap)
//        · override (pick anything, busy ignored — I'll move stuff around)
// Tiers apply within any event type; --type picks WHICH kind of event the
// link books (route /<type>/<password>).

const crypto = require("node:crypto");
const db = require("../lib/db");

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; }
function has(name) { return argv.includes(`--${name}`); }

if (has("list")) {
  const config = require("../lib/config");
  for (const t of db.listTokens()) {
    const uses = t.maxUses != null ? `${t.uses}/${t.maxUses}` : `${t.uses}`;
    console.log(`${t.disabled ? "✗" : "✓"} [${t.tier.padEnd(8)}] ${t.label.padEnd(20)} uses:${uses.padEnd(6)} ${config.baseUrl}/${encodeURIComponent(t.typeKey || "a")}/${encodeURIComponent(t.token)}`);
  }
  process.exit(0);
}

let label = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (argv[i] !== "--list") i++; continue; } // skip flag + its value
  label = argv[i]; break;
}
if (!label) { console.error('usage: node scripts/mint.js "<label>" [--type <event type key>] [--tier standard|vip|override] [--token <password>] [--duration <min>] [--max-uses <n>] [--days mon,tue] [--start HH:MM] [--end HH:MM]'); process.exit(1); }

const tier = flag("tier") || "standard";
if (!["standard", "vip", "override"].includes(tier)) { console.error(`bad tier "${tier}"`); process.exit(1); }

let typeKey = flag("type");
if (typeKey === "a") typeKey = null; // "a" = the built-in default type
if (typeKey && !db.listTypes().some((t) => t.key === typeKey)) {
  console.error(`no such event type "${typeKey}" — create it first: node scripts/types.js "<label>" --key ${typeKey} …  (or --list)`);
  process.exit(1);
}

const token = flag("token") || crypto.randomBytes(6).toString("base64url");
const windowOverride = (flag("days") || flag("start") || flag("end")) ? {
  days: (flag("days") || "mon,tue,wed,thu,fri").split(","),
  start: flag("start") || "08:00",
  end: flag("end") || "17:00",
} : null;

db.createToken({
  token, label, tier, typeKey,
  durationMin: flag("duration") ? +flag("duration") : null,
  maxUses: flag("max-uses") ? +flag("max-uses") : null,
  windowOverride,
});

const config = require("../lib/config");
console.log(`minted [${tier}] "${label}"${typeKey ? ` (type: ${typeKey})` : ""}`);
console.log(`  password: ${token}`);
console.log(`  link:     ${config.baseUrl}/${encodeURIComponent(typeKey || "a")}/${encodeURIComponent(token)}`);
