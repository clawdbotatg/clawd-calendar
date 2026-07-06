// Shared env loading: process.env wins, then the gitignored
// .clawd-calendar.env file in the repo root. All personalization AND
// secrets live there — fork the repo, copy .env.example, and go.

const fs = require("node:fs");
const path = require("node:path");

const ENV_FILE = process.env.CAL_ENV_FILE || path.join(__dirname, "..", ".clawd-calendar.env");

function loadEnvFile(p = ENV_FILE) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

const fileEnv = loadEnvFile();
const env = (key, fallback) => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === "" ? fallback : v;
};

module.exports = { env, loadEnvFile, ENV_FILE };
