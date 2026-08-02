import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import { probePlaywrightChromium, SlidesRuntimeUnavailableError } from "./playwrightPreflight.js";
import { generationRequestFailure } from "./generationRequestWatcher.js";

test("Playwright preflight validates a PNG and closes page and browser", async () => {
  let pageClosed = false;
  let browserClosed = false;
  const browser = {
    newPage: async () => ({
      setContent: async () => {},
      screenshot: async () => Buffer.from("89504e470d0a1a0a", "hex"),
      close: async () => { pageClosed = true; }
    }),
    close: async () => { browserClosed = true; }
  } as unknown as Browser;

  const result = await probePlaywrightChromium(async () => browser);

  assert.equal(result.status, "available");
  assert.equal(pageClosed, true);
  assert.equal(browserClosed, true);
});

test("Playwright preflight keeps private paths out of the public request message", async () => {
  const result = await probePlaywrightChromium(async () => {
    throw new Error("Executable doesn't exist at C:/private/browser.exe");
  });

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.match(result.detail, /C:\/private/);

  const failure = generationRequestFailure(new SlidesRuntimeUnavailableError("C:/private/browser.exe"));
  assert.deepEqual(failure, {
    status: "failed",
    errorCode: "PLAYWRIGHT_CHROMIUM_UNAVAILABLE",
    statusMessage: "Google\u30b9\u30e9\u30a4\u30c9\u751f\u6210\u74b0\u5883\u3092\u6e96\u5099\u3067\u304d\u3066\u3044\u307e\u305b\u3093\u3002\u7ba1\u7406\u8005\u3078\u304a\u554f\u3044\u5408\u308f\u305b\u304f\u3060\u3055\u3044\u3002",
    error: "Playwright Chromium unavailable"
  });
  assert.doesNotMatch(JSON.stringify(failure), /private\/browser/);
});
