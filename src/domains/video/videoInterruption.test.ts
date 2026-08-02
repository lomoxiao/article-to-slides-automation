import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { markInterruptedVideoJobs } from "./videoGenerationQueue.js";
import { isManagedVideoJob } from "./videoJobStore.js";
import type { VideoJob } from "./types.js";

function job(id: string, requestedBy: string, executionMode?: "managed" | "cli"): VideoJob {
  return {
    id,
    url: `https://example.com/${id}`,
    requestedBy,
    executionMode,
    inputHash: id,
    status: "processing",
    stage: "video_rendering",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    jobDir: `jobs/video/${id}`
  };
}

test("managed/cli policy is explicit and backward compatible", () => {
  assert.equal(isManagedVideoJob(job("managed", "viewer:test", "managed")), true);
  assert.equal(isManagedVideoJob(job("cli", "cli", "cli")), false);
  assert.equal(isManagedVideoJob(job("legacy-managed", "viewer:test")), true);
  assert.equal(isManagedVideoJob(job("legacy-cli", "cli")), false);
});

test("startup reconciliation marks jobs interrupted without enqueueing or uploading", async () => {
  const updates: Array<Partial<VideoJob>> = [];
  const firebaseWrites: string[] = [];
  const result = await markInterruptedVideoJobs({
    listJobs: async () => [job("managed", "viewer:test", "managed"), job("cli", "cli", "cli")],
    updateJob: async (value, patch) => {
      updates.push(patch);
      return { ...value, ...patch };
    },
    writeState: async (value, status, _stage, _message, diagnostic) => {
      firebaseWrites.push(value.id);
      assert.equal(status, "action_required");
      assert.equal(diagnostic?.code, "WORKER_RESTARTED");
    }
  });

  assert.deepEqual(result, { total: 2, managed: 1, cli: 1, failed: 0 });
  assert.deepEqual(firebaseWrites, ["managed"]);
  assert.ok(updates.every((patch) => patch.status === "action_required" && patch.errorCode === "WORKER_RESTARTED"));
});

test("production startup contains no automatic video recovery", async () => {
  const [indexSource, queueSource, cliSource] = await Promise.all([
    readFile("src/index.ts", "utf8"),
    readFile("src/domains/video/videoGenerationQueue.ts", "utf8"),
    readFile("src/scripts/generateVideo.ts", "utf8")
  ]);
  assert.doesNotMatch(indexSource, /recoverVideoJobs|Recovered .*video job/);
  assert.doesNotMatch(queueSource, /recoverVideoJobs|enqueueExisting\(pending\)/);
  assert.match(cliSource, /executionMode: "cli"/);
  assert.match(cliSource, /status: "completed"/);
  assert.match(cliSource, /status: "failed"/);
});
