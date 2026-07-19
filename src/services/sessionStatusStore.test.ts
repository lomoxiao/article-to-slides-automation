import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCookieExpiry } from "./sessionStatusStore.js";

function writeState(cookies: Array<{ expires?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  const path = join(dir, "example.com.json");
  writeFileSync(path, JSON.stringify({ cookies, origins: [] }), "utf8");
  return path;
}

test("readCookieExpiry returns earliest positive expiry as ISO", () => {
  const later = 2_000_000_000; // 2033
  const earlier = 1_800_000_000; // 2027
  const path = writeState([{ expires: later }, { expires: earlier }, { expires: -1 }]);
  const result = readCookieExpiry(path);
  assert.equal(result, new Date(earlier * 1000).toISOString());
  rmSync(path, { force: true });
});

test("readCookieExpiry returns null when all cookies are session cookies", () => {
  const path = writeState([{ expires: -1 }, { expires: 0 }, {}]);
  assert.equal(readCookieExpiry(path), null);
  rmSync(path, { force: true });
});

test("readCookieExpiry returns null for missing or malformed file", () => {
  assert.equal(readCookieExpiry(join(tmpdir(), "does-not-exist-xyz.json")), null);
});
