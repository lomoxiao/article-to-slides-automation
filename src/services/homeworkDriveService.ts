import { Readable } from "node:stream";
import { google } from "googleapis";
import { config } from "../config.js";
import type { HomeworkSourceImage } from "../types/homework.js";
import { getGoogleAuthClient } from "./googleAuth.js";

export type HomeworkDriveClient = {
  files: {
    create(args: Record<string, unknown>): Promise<{ data: { id?: string | null } }>;
    delete(args: Record<string, unknown>): Promise<unknown>;
  };
  permissions: { create(args: Record<string, unknown>): Promise<unknown> };
};

export type UploadHomeworkImageInput = {
  jobId: string;
  ownerUid: string;
  extension: string;
  contentType: string;
  buffer: Buffer;
  folderId: string;
};

export async function uploadHomeworkImage(input: Omit<UploadHomeworkImageInput, "folderId">): Promise<HomeworkSourceImage> {
  const folderId = config.HOMEWORK_DRIVE_FOLDER_ID?.trim();
  if (!folderId) throw new Error("HOMEWORK_DRIVE_FOLDER_ID is not set.");
  return uploadHomeworkImageWithClient({ ...input, folderId }, await createDriveClient());
}

export async function uploadHomeworkImageWithClient(input: UploadHomeworkImageInput, drive: HomeworkDriveClient): Promise<HomeworkSourceImage> {
  const created = await drive.files.create({
    requestBody: {
      name: `${input.jobId}.${input.extension}`,
      parents: [input.folderId],
      appProperties: { workflow: "homework-manga", jobId: input.jobId, ownerUid: input.ownerUid }
    },
    media: { mimeType: input.contentType, body: Readable.from(input.buffer) },
    fields: "id",
    supportsAllDrives: true
  });
  const fileId = created.data.id;
  if (!fileId) throw new Error("Google Drive did not return a file ID.");
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: "anyone", role: "reader", allowFileDiscovery: false },
      supportsAllDrives: true
    });
  } catch (error) {
    await drive.files.delete({ fileId, supportsAllDrives: true }).catch(() => {});
    throw error;
  }
  const id = encodeURIComponent(fileId);
  return {
    provider: "google_drive",
    fileId,
    contentType: input.contentType,
    size: input.buffer.length,
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=view&id=${id}`
  };
}

export async function deleteHomeworkImage(fileId: string): Promise<void> {
  await deleteHomeworkImageWithClient(fileId, await createDriveClient());
}

export async function deleteHomeworkImageWithClient(fileId: string, drive: HomeworkDriveClient): Promise<void> {
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function createDriveClient(): Promise<HomeworkDriveClient> {
  const auth = await getGoogleAuthClient();
  return google.drive({ version: "v3", auth }) as unknown as HomeworkDriveClient;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: number | string; response?: { status?: number } };
  return value.code === 404 || value.code === "404" || value.response?.status === 404;
}
