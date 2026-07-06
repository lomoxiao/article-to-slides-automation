import test from "node:test";
import assert from "node:assert/strict";
import { processHomeworkDeletion } from "./homeworkDeletionWorker.js";
import type { HomeworkJob } from "../types/homework.js";

const job: HomeworkJob = {
  id: "job-1", ownerUid: "uid-1", status: "delete_requested", stage: "delete_requested",
  slack: { channelId: "C1", messageTs: "1", fileId: "F1" },
  sourceImage: { provider: "google_drive", fileId: "drive-1", contentType: "image/jpeg", size: 10, viewUrl: "https://drive.google.com/view", downloadUrl: "https://drive.google.com/download" },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

test("deletes Drive image before removing the Firebase job", async () => {
  const events: string[] = [];
  await processHomeworkDeletion(job, {
    updateJob: async (_id, patch) => { events.push(`update:${patch.status}`); },
    deleteDriveFile: async (id) => { events.push(`drive:${id}`); },
    removeJob: async (id) => { events.push(`remove:${id}`); }
  });
  assert.deepEqual(events, ["update:deleting", "drive:drive-1", "remove:job-1"]);
});

test("marks the job delete_failed when Drive deletion fails", async () => {
  const statuses: unknown[] = [];
  await assert.rejects(() => processHomeworkDeletion(job, {
    updateJob: async (_id, patch) => { statuses.push(patch.status); },
    deleteDriveFile: async () => { throw new Error("Drive unavailable"); },
    removeJob: async () => { assert.fail("job must not be removed"); }
  }), /Drive unavailable/);
  assert.deepEqual(statuses, ["deleting", "delete_failed"]);
});
