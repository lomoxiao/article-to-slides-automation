import assert from "node:assert/strict";
import test from "node:test";
import { resourceIntensiveSemaphore } from "./resourceSemaphore.js";

test("resource intensive manga/video tasks are process-wide exclusive", async () => {
  let active = 0;
  let maxActive = 0;
  const run = () => resourceIntensiveSemaphore.runExclusive(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(maxActive, 1);
});
