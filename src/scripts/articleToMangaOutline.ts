import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseMangaArgs } from "../utils/parseMangaArgs.js";
import { config } from "../config.js";
import { fetchSourceContent } from "../services/sourceAggregator.js";
import { createMangaJob, updateMangaJob } from "../services/mangaJobStore.js";
import { generateMangaOutline, listCharacterSheetImages } from "../services/mangaOutlineGen.js";
import { upsertGoogleDoc } from "../services/driveUploader.js";

const DEFAULT_CHARACTER_SHEETS_DIR = path.join("manga-templates", "character-sheets");

const parsed = parseMangaArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`引数エラー: ${parsed.errorMessage}`);
  console.error(
    'Usage: npm run manga:outline -- --url "https://..." --pages 8 [--genre 教育・解説] [--art-style A] [--treatment B]'
  );
  process.exit(1);
}

// 1. 記事本文を取得(content-extractor 経由 / 既存 sourceAggregator を再利用)
const source = await fetchSourceContent(parsed.url);

// 2. ジョブ作成 + source.txt 保存
const job = await createMangaJob({
  url: source.url,
  title: source.title,
  pages: parsed.pages,
  genre: parsed.genre,
  artStyle: parsed.artStyle,
  treatment: parsed.treatment,
  audience: parsed.audience,
  focus: parsed.focus
});
await writeFile(path.join(job.jobDir, "source.txt"), source.text, "utf8");
console.log(`Job created: ${job.id}`);
console.log(`Source saved: ${path.join(job.jobDir, "source.txt")} (title: ${source.title})`);

// 2.5 キャラクターシート画像を収集(既定: manga-templates/character-sheets)
const characterSheetsDir = parsed.characterSheetsDir ?? DEFAULT_CHARACTER_SHEETS_DIR;
const characterSheetPaths = await listCharacterSheetImages(characterSheetsDir);
if (characterSheetPaths.length > 0) {
  console.log(`Character sheets: ${characterSheetPaths.length} 件 (${characterSheetsDir})`);
  for (const p of characterSheetPaths) {
    if (!path.basename(p).includes("キャラクター")) {
      console.warn(
        `  注意: ファイル名に「キャラクター」が含まれていません: ${path.basename(p)}（NotebookLM がキャラ参照画像と認識しない可能性）`
      );
    }
  }
} else {
  console.log(`Character sheets: なし (${characterSheetsDir})`);
}

// 3. Step1 -> Step2 を Claude ヘッドレスで実行
console.log("Running Step1 (構成・キャラID・コマ割り) ...");
try {
  const result = await generateMangaOutline(job, source.text, { characterSheetPaths });
  await updateMangaJob(job, {
    step1SessionId: result.step1SessionId,
    step1OutputPath: result.step1OutputPath,
    step2OutputPath: result.step2OutputPath,
    uploadDir: result.uploadDir,
    characterSheets: result.characterSheets
  });

  // 4. Drive へ step1/step2 を Google ドキュメントとして upsert(設定時のみ)。
  //    Drive 失敗は生成物・ジョブ成功を壊さないよう隔離する。
  let driveStep1Url: string | undefined;
  let driveStep2Url: string | undefined;
  if (config.MANGA_DRIVE_FOLDER_ID) {
    try {
      console.log("Uploading step1/step2 to Google Drive (Google ドキュメント) ...");
      const doc1 = await upsertGoogleDoc({
        folderId: config.MANGA_DRIVE_FOLDER_ID,
        name: "step1-output.txt",
        filePath: result.step1OutputPath
      });
      const doc2 = await upsertGoogleDoc({
        folderId: config.MANGA_DRIVE_FOLDER_ID,
        name: "step2-output.txt",
        filePath: result.step2OutputPath
      });
      driveStep1Url = doc1.webViewLink;
      driveStep2Url = doc2.webViewLink;
      await updateMangaJob(job, {
        driveFolderId: config.MANGA_DRIVE_FOLDER_ID,
        driveStep1Url,
        driveStep2Url
      });
      console.log(`  step1: ${doc1.created ? "created" : "updated"} ${driveStep1Url ?? doc1.id}`);
      console.log(`  step2: ${doc2.created ? "created" : "updated"} ${driveStep2Url ?? doc2.id}`);
    } catch (driveError) {
      const message = driveError instanceof Error ? driveError.message : String(driveError);
      await updateMangaJob(job, { error: `Drive upload failed: ${message}` });
      console.warn(`  注意: Drive アップロードに失敗しました(生成物はローカルに保存済み): ${message}`);
    }
  } else {
    console.log("Drive upload: スキップ (MANGA_DRIVE_FOLDER_ID 未設定)");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        jobId: job.id,
        jobDir: job.jobDir,
        artStyle: result.artStyleName,
        characterSheets: result.characterSheets,
        step1OutputPath: result.step1OutputPath,
        step2OutputPath: result.step2OutputPath,
        uploadDir: result.uploadDir,
        driveStep1Url,
        driveStep2Url
      },
      null,
      2
    )
  );
  console.log("\n次の手順: upload/ のファイルを NotebookLM にアップロードして Step3(スライドブック生成)を実行してください。");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await updateMangaJob(job, { error: message });
  console.error(`生成に失敗しました: ${message}`);
  process.exit(1);
}
