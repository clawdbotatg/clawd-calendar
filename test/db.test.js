// Public (no-password) links: bare / and /<type> resolve to the route's
// public token; disabling it re-arms the password gate.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cal-db-test-"));
process.env.CAL_DB = path.join(tmp, "test.db");
const db = require("../lib/db");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("getPublicToken resolves per route and respects disable", () => {
  db.open();
  db.createType({ key: "slop", label: "SLOP.COMPUTER" });
  db.createToken({ token: "pub-default", label: "walk-ins", isPublic: true, durationMin: 30 });
  db.createToken({ token: "pub-slop", label: "slop public", typeKey: "slop", isPublic: true });
  db.createToken({ token: "normal-pw", label: "friends" });

  // Each route gets its own public token; duration override rides along.
  assert.equal(db.getPublicToken(null).token, "pub-default");
  assert.equal(db.getPublicToken(null).durationMin, 30);
  assert.equal(db.getPublicToken("slop").token, "pub-slop");

  // Unknown route or no public token → null (gate stays up).
  assert.equal(db.getPublicToken("nope"), null);

  // A non-public token never leaks into public resolution.
  db.setTokenDisabled("pub-slop", true);
  assert.equal(db.getPublicToken("slop"), null);
  db.setTokenDisabled("pub-slop", false);
  assert.equal(db.getPublicToken("slop").token, "pub-slop");

  // Newest public token wins when there are several.
  db.createToken({ token: "pub-default-2", label: "walk-ins v2", isPublic: true });
  assert.equal(db.getPublicToken(null).token, "pub-default-2");
});
