import test from "node:test";
import assert from "node:assert/strict";
import { deleteHomeworkImageWithClient, uploadHomeworkImageWithClient, type HomeworkDriveClient } from "./homeworkDriveService.js";

function mockDrive(options: { permissionError?: Error; deleteError?: unknown } = {}) {
  const calls = { create: [] as Record<string, unknown>[], permission: [] as Record<string, unknown>[], delete: [] as Record<string, unknown>[] };
  const drive: HomeworkDriveClient = {
    files: {
      create: async (args) => { calls.create.push(args); return { data: { id: "drive-file-1" } }; },
      delete: async (args) => { calls.delete.push(args); if (options.deleteError) throw options.deleteError; return {}; }
    },
    permissions: {
      create: async (args) => { calls.permission.push(args); if (options.permissionError) throw options.permissionError; return {}; }
    }
  };
  return { drive, calls };
}

test("uploads a homework image with metadata and link-only public permission", async () => {
  const { drive, calls } = mockDrive();
  const result = await uploadHomeworkImageWithClient({
    jobId: "job-1", ownerUid: "uid-1", extension: "jpg", contentType: "image/jpeg",
    buffer: Buffer.from("image"), folderId: "folder-1"
  }, drive);
  const requestBody = calls.create[0].requestBody as Record<string, unknown>;
  assert.equal(requestBody.name, "job-1.jpg");
  assert.deepEqual(requestBody.parents, ["folder-1"]);
  assert.deepEqual(requestBody.appProperties, { workflow: "homework-manga", jobId: "job-1", ownerUid: "uid-1" });
  assert.deepEqual(calls.permission[0].requestBody, { type: "anyone", role: "reader", allowFileDiscovery: false });
  assert.deepEqual(result, {
    provider: "google_drive", fileId: "drive-file-1", contentType: "image/jpeg", size: 5,
    viewUrl: "https://drive.google.com/file/d/drive-file-1/view",
    downloadUrl: "https://drive.google.com/uc?export=view&id=drive-file-1"
  });
});

test("deletes the uploaded file when public permission creation fails", async () => {
  const { drive, calls } = mockDrive({ permissionError: new Error("permission denied") });
  await assert.rejects(() => uploadHomeworkImageWithClient({
    jobId: "job-1", ownerUid: "uid-1", extension: "png", contentType: "image/png",
    buffer: Buffer.from("image"), folderId: "folder-1"
  }, drive), /permission denied/);
  assert.deepEqual(calls.delete, [{ fileId: "drive-file-1", supportsAllDrives: true }]);
});

test("treats an already deleted Drive file as success", async () => {
  const { drive } = mockDrive({ deleteError: { code: 404 } });
  await deleteHomeworkImageWithClient("missing", drive);
});
