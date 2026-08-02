import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("interrupted video jobs are finalized before new input is accepted", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const reconciliation = source.indexOf("await markInterruptedVideoJobs()");
  const slackInput = source.indexOf("await startSlackSocketModeClient()");
  const viewerInput = source.indexOf("startGenerationRequestWatcher()");

  assert.ok(reconciliation >= 0);
  assert.ok(reconciliation < slackInput);
  assert.ok(reconciliation < viewerInput);
});
