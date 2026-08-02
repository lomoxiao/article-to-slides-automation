import assert from "node:assert/strict";
import test from "node:test";
import type { drive_v3 } from "googleapis";
import { upsertDriveBinary, type DriveFilesClient } from "./driveBinaryUploader.js";

test("binary upsert creates only when fileId is absent", async () => {
  let createArgs: drive_v3.Params$Resource$Files$Create | undefined;
  const files = {
    create: async (args: drive_v3.Params$Resource$Files$Create) => {
      createArgs = args;
      return { data: { id: "created-id", webViewLink: "https://drive.google.com/file/d/created-id/view" } };
    },
    update: async () => { throw new Error("update must not be called"); }
  } as unknown as DriveFilesClient;
  const result = await upsertDriveBinary({
    parentFolderId: "folder",
    name: "video.mp4",
    mimeType: "video/mp4",
    filePath: "package.json",
    appProperties: { videoJobId: "job" }
  }, files);
  assert.deepEqual(result, {
    fileId: "created-id",
    webViewLink: "https://drive.google.com/file/d/created-id/view",
    created: true
  });
  assert.deepEqual(createArgs?.requestBody?.parents, ["folder"]);
  assert.equal(createArgs?.supportsAllDrives, true);
});

test("binary upsert uses files.update when saved fileId exists", async () => {
  let updateArgs: drive_v3.Params$Resource$Files$Update | undefined;
  const files = {
    create: async () => { throw new Error("create must not be called"); },
    update: async (args: drive_v3.Params$Resource$Files$Update) => {
      updateArgs = args;
      return { data: { id: "saved-id", webViewLink: "https://drive.google.com/file/d/saved-id/view" } };
    }
  } as unknown as DriveFilesClient;
  const result = await upsertDriveBinary({
    fileId: "saved-id",
    parentFolderId: "ignored-on-update",
    name: "video.mp4",
    mimeType: "video/mp4",
    filePath: "package.json"
  }, files);
  assert.equal(result.created, false);
  assert.equal(result.fileId, "saved-id");
  assert.equal(updateArgs?.fileId, "saved-id");
  assert.equal(updateArgs?.supportsAllDrives, true);
});
