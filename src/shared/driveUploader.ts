import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { getGoogleAuthClient } from "./googleAuth.js";

export type DriveUpsertResult = {
  id: string;
  name: string;
  webViewLink?: string;
  created: boolean;
};

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/**
 * Google ドキュメントへ変換するとタイトルから拡張子(例: .txt)が落ちる。
 * 作成名と検索名を同じ規則で正規化しておかないと upsert の同名照合が永久に外れ、
 * 実行のたびに重複 Doc が作られてしまう(= 冪等性が壊れる)。
 */
function toDocTitle(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

/**
 * テキストファイルを Google ドキュメントとして指定フォルダに upsert する。
 * - 同名の Doc が既にあれば files.update で本文だけ置換(ファイルID維持 → NotebookLM の再同期が成立)。
 * - 無ければ files.create で text/plain を Google ドキュメントに変換して作成。
 * - drive.file スコープのため、検索でヒットするのは本アプリが作成したファイルのみ。
 * - 照合は拡張子を落とした Doc タイトルで行う(Drive が変換時に拡張子を除くため)。
 */
export async function upsertGoogleDoc(input: {
  folderId: string;
  name: string;
  filePath: string;
}): Promise<DriveUpsertResult> {
  const auth = await getGoogleAuthClient();
  const drive = google.drive({ version: "v3", auth });

  const docTitle = toDocTitle(input.name);
  const existingId = await findExistingDocId(drive, input.folderId, docTitle);

  if (existingId) {
    const updated = await drive.files.update({
      fileId: existingId,
      media: { mimeType: "text/plain", body: createReadStream(input.filePath) },
      fields: "id, name, webViewLink",
      supportsAllDrives: true
    });
    return {
      id: updated.data.id ?? existingId,
      name: updated.data.name ?? docTitle,
      webViewLink: updated.data.webViewLink ?? undefined,
      created: false
    };
  }

  const created = await drive.files.create({
    requestBody: {
      name: docTitle,
      mimeType: GOOGLE_DOC_MIME,
      parents: [input.folderId]
    },
    media: { mimeType: "text/plain", body: createReadStream(input.filePath) },
    fields: "id, name, webViewLink",
    supportsAllDrives: true
  });

  if (!created.data.id) {
    throw new Error(`Drive file creation did not return an id for "${docTitle}"`);
  }

  return {
    id: created.data.id,
    name: created.data.name ?? docTitle,
    webViewLink: created.data.webViewLink ?? undefined,
    created: true
  };
}

async function findExistingDocId(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  name: string
): Promise<string | undefined> {
  const escapedName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escapedName}' and '${folderId}' in parents and mimeType = '${GOOGLE_DOC_MIME}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    spaces: "drive"
  });

  return res.data.files?.[0]?.id ?? undefined;
}
