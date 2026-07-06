#!/usr/bin/env node
// One-time Google OAuth bootstrap (run with the user present — opens a browser).
// Saves credentials to .clawd-calendar.env (gitignored) and, if you say yes,
// mirrors them to ~/.config/gcal-skill/credentials.json for the gcal CLI skill.
//
// Prereq (once, in Google Cloud console — https://console.cloud.google.com):
//   1. Create/select a project → enable "Google Calendar API"
//   2. OAuth consent screen → External → add yourself as test user → PUBLISH
//      the app ("In production"; stays unverified — that's fine for personal
//      use, and Testing-mode refresh tokens expire after 7 days)
//   3. Credentials → Create credentials → OAuth client ID → "Desktop app"
//      → copy the client id + secret, paste them here.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { execFile } = require("node:child_process");

const { ENV_FILE } = require("../lib/env");
const SKILL_CREDS = path.join(os.homedir(), ".config", "gcal-skill", "credentials.json");
const EXAMPLE_FILE = path.join(__dirname, "..", ".env.example");

// Upsert KEY=VALUE lines, preserving everything else in the env file.
// First run: seed from .env.example so forkers get the documented knobs.
function saveEnv(updates) {
  let text = "";
  if (fs.existsSync(ENV_FILE)) text = fs.readFileSync(ENV_FILE, "utf8");
  else if (fs.existsSync(EXAMPLE_FILE)) text = fs.readFileSync(EXAMPLE_FILE, "utf8");
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^#?\\s*${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : text + (text.endsWith("\n") || !text ? "" : "\n") + line + "\n";
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}
const REDIRECT_PORT = 8765;
const SCOPE = "https://www.googleapis.com/auth/calendar"; // events + freebusy (+ shared with gcal skill)

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let clientId = "", clientSecret = "";
  if (fs.existsSync(SKILL_CREDS)) {
    const j = JSON.parse(fs.readFileSync(SKILL_CREDS, "utf8"));
    if (j.client_id && j.client_secret) {
      const reuse = (await rl.question(`Reuse OAuth client from ${SKILL_CREDS}? [Y/n] `)).trim().toLowerCase();
      if (reuse !== "n") { clientId = j.client_id; clientSecret = j.client_secret; }
    }
  }
  if (!clientId) clientId = (await rl.question("OAuth client id: ")).trim();
  if (!clientSecret) clientSecret = (await rl.question("OAuth client secret: ")).trim();
  if (!clientId || !clientSecret) { console.error("client id + secret required"); process.exit(1); }

  const redirectUri = `http://localhost:${REDIRECT_PORT}/callback`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

  console.log("\nOpening Google consent in your browser…\nIf it doesn't open, visit:\n\n" + authUrl + "\n");
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [authUrl], () => {});

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") { res.writeHead(404); return res.end(); }
      const c = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(c ? "<h2>✅ Authorized — you can close this tab.</h2>" : "<h2>❌ No code — try again.</h2>");
      srv.close();
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") || "no code"));
    });
    srv.listen(REDIRECT_PORT, () => console.log(`Waiting for the redirect on localhost:${REDIRECT_PORT}…`));
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  const tok = await res.json();
  if (!tok.refresh_token) {
    console.error("No refresh_token in response:", JSON.stringify(tok, null, 2));
    process.exit(1);
  }

  saveEnv({
    GCAL_CLIENT_ID: clientId,
    GCAL_CLIENT_SECRET: clientSecret,
    GCAL_REFRESH_TOKEN: tok.refresh_token,
  });
  console.log(`\n✅ Saved ${ENV_FILE} (personalization knobs are in there too — edit away)`);

  const mirror = (await rl.question(`Also save to ${SKILL_CREDS} for the gcal CLI skill? [Y/n] `)).trim().toLowerCase();
  if (mirror !== "n") {
    fs.mkdirSync(path.dirname(SKILL_CREDS), { recursive: true });
    fs.writeFileSync(SKILL_CREDS,
      JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: tok.refresh_token }, null, 2) + "\n",
      { mode: 0o600 });
    console.log(`✅ Saved ${SKILL_CREDS}`);
  }
  rl.close();

  // Smoke: one freebusy call.
  process.env.GCAL_CLIENT_ID = clientId;
  process.env.GCAL_CLIENT_SECRET = clientSecret;
  process.env.GCAL_REFRESH_TOKEN = tok.refresh_token;
  const gcal = require("../lib/gcal");
  const busy = await gcal.freeBusy("primary", new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  console.log(`✅ Calendar reachable — ${busy.length} busy block(s) in the next 24h. You're set.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
