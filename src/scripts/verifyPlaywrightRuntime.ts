import { probePlaywrightChromium } from "../domains/slides/playwrightPreflight.js";

const result = await probePlaywrightChromium();
if (result.status === "unavailable") {
  console.error(`Playwright Chromium verification failed: ${result.detail}`);
  console.error("Run npm run playwright:setup from article-to-slides-automation.");
  process.exitCode = 1;
} else {
  console.log(`Playwright Chromium verification passed (${result.checkedAt}).`);
}
