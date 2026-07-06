import assert from "node:assert/strict";
import test from "node:test";
import { failInterruptedJob, INTERRUPTION_ERROR, INTERRUPTED_HOMEWORK_STATUSES } from "./homeworkJobLifecycle.js";
import type { HomeworkJob } from "../types/homework.js";

const base: HomeworkJob = { id: "homework-1", ownerUid: "uid", status: "analyzing", stage: "analyzing", createdAt: "old", updatedAt: "old" };

test("all processing statuses are terminalized instead of retried", () => {
  for (const status of INTERRUPTED_HOMEWORK_STATUSES) {
    const result = failInterruptedJob({ ...base, status, stage: status }, status, "now");
    assert.equal(result?.status, "failed"); assert.equal(result?.stage, "failed");
    assert.equal(result?.error, INTERRUPTION_ERROR); assert.equal(result?.updatedAt, "now");
  }
});

test("queued and terminal jobs are not changed by interruption finalization", () => {
  assert.equal(failInterruptedJob({ ...base, status: "queued", stage: "queued" }, "analyzing", "now"), undefined);
  assert.equal(failInterruptedJob({ ...base, status: "failed", stage: "failed" }, "analyzing", "now"), undefined);
  assert.equal(failInterruptedJob(null, "analyzing", "now"), null);
});
