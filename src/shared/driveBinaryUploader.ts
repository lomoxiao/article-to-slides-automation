import { createReadStream } from "node:fs";
import { google, type drive_v3 } from "googleapis";
import { getGoogleAuthClient } from "./googleAuth.js";

export type DriveBinaryUpsertInput = {
  fileId?: string;
  parentFolderId: string;
  name: string;
  mimeType: string;
  filePath: string;
  appProperties?: Record<string, string>;
};

export type DriveBinaryUpsertResult = {
  fileId: string;
  webViewLink?: string;
  created: boolean;
};

export type DriveFilesClient = Pick<drive_v3.Resource$Files, "create" | "update">;

/** Binary upsert keyed only by a previously persisted Drive file ID. */
export async function upsertDriveBinary(
  input: DriveBinaryUpsertInput,
  filesOverride?: DriveFilesClient
): Promise<DriveBinaryUpsertResult> {
  const files = filesOverride ?? google.drive({ version: "v3", auth: await getGoogleAuthClient() }).files;
  if (input.fileId) {
    const result = await files.update({
      fileId: input.fileId,
      requestBody: { name: input.name, appProperties: input.appProperties },
      media: { mimeType: input.mimeType, body: createReadStream(input.filePath) },
      fields: "id,webViewLink",
      supportsAllDrives: true
    });
    return { fileId: result.data.id ?? input.fileId, webViewLink: result.data.webViewLink ?? undefined, created: false };
  }

  const result = await files.create({
    requestBody: {
      name: input.name,
      parents: [input.parentFolderId],
      appProperties: input.appProperties
    },
    media: { mimeType: input.mimeType, body: createReadStream(input.filePath) },
    fields: "id,webViewLink",
    supportsAllDrives: true
  });
  if (!result.data.id) throw new Error(`Drive binary creation did not return an id for ${input.name}`);
  return { fileId: result.data.id, webViewLink: result.data.webViewLink ?? undefined, created: true };
}
