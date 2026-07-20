import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { fetchSourceContent } from "../../shared/sourceAggregator.js";
import { createMangaJob, updateMangaJob } from "./mangaJobStore.js";
import { generateMangaOutline, listCharacterSheetImages } from "./mangaOutlineGen.js";
import { upsertGoogleDoc } from "../../shared/driveUploader.js";
import { runNotebookLmSourceSync } from "../notebooklm/notebookLmPipeline.js";
import type { NotebookLmSyncStatus } from "../notebooklm/notebookLmSync.js";
import {
  clearArtifactDiagnostic,
  upsertArtifactDiagnostic,
  upsertMangaArtifact,
  type ArtifactStage,
  type ViewerArticleStatus
} from "../../shared/firebaseArticleStore.js";
import { recordSessionExpired } from "../../shared/sessionStatusStore.js";
import type { MangaJob, MangaTreatment } from "../../types/manga.js";

const DEFAULT_CHARACTER_SHEETS_DIR = path.join("manga-templates", "character-sheets");

export type RunArticleToMangaInput = {
  url: string;
  /** テキスト投入モード: 本文を直接使い、URL抽出をスキップする(urlはtext:canonical)。 */
  sourceText?: string;
  sourceTitle?: string;
  pages: number;
  genre?: string;
  artStyle: string;
  treatment: MangaTreatment;
  audience?: string;
  focus?: string;
  requestedBy?: string;
  /** キャラクターシート画像の入力ディレクトリ(未指定なら manga-templates/character-sheets)。 */
  characterSheetsDir?: string;
  /** 進捗ログの出力先(CLI は console.log、Slack 経路は無音/サーバログ)。未指定なら何もしない。 */
  logger?: (message: string) => void;
};

export type RunArticleToMangaResult = {
  job: MangaJob;
  title?: string;
  artStyleName: string;
  characterSheets: string[];
  step1OutputPath: string;
  step2OutputPath: string;
  uploadDir: string;
  driveStep1Url?: string;
  driveStep2Url?: string;
  /** Drive アップロードに失敗した場合のメッセージ(生成自体は成功)。 */
  driveError?: string;
  /** Phase3: NotebookLM 自動操作の結果(未実行なら undefined)。 */
  notebookLmStatus?: NotebookLmSyncStatus;
  /** NotebookLM 操作の説明・失敗理由。 */
  notebookLmDetail?: string;
};

/**
 * 記事 URL から漫画ネーム(Step1/Step2)を生成し、必要なら Drive に登録するまでの一連を実行する。
 * CLI(articleToMangaOutline.ts)と Slack 経路(enqueueMangaGeneration)の共通エントリ。
 * - 生成失敗はジョブに記録した上で throw(呼び出し側で通知/終了コードを決める)。
 * - Drive 失敗は生成物・ジョブ成功を壊さないよう隔離し、driveError として返す。
 */
export async function runArticleToMangaJob(
  input: RunArticleToMangaInput
): Promise<RunArticleToMangaResult> {
  const log = input.logger ?? (() => {});

  // 1. 記事本文を取得(content-extractor 経由 / 既存 sourceAggregator を再利用)
  await writeMangaViewerState({
    articleUrl: input.url,
    status: "processing",
    stage: "preparing",
    statusMessage: "漫画生成の準備中です",
    log
  });
  let source;
  try {
    source = input.sourceText
      ? {
          url: input.url,
          title: input.sourceTitle || input.sourceText.trim().split("\n")[0].slice(0, 80) || "テキスト投入",
          text: input.sourceText.slice(0, 60_000)
        }
      : await fetchSourceContent(input.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isSessionExpired = error instanceof Error && error.name === "SessionExpiredError";
    if (isSessionExpired) {
      const domain = (error as { domain?: string }).domain;
      if (domain) await recordSessionExpired(domain).catch(() => {});
    }
    await writeMangaViewerState({
      articleUrl: input.url,
      status: isSessionExpired ? "action_required" : "failed",
      stage: "preparing",
      statusMessage: isSessionExpired ? message : "漫画生成の準備に失敗しました",
      diagnostic: { code: isSessionExpired ? "SESSION_EXPIRED" : "MANGA_PREPARATION_FAILED", detail: message },
      log
    });
    throw error;
  }

  // 2. ジョブ作成 + source.txt 保存
  const job = await createMangaJob({
    url: source.url,
    title: source.title,
    pages: input.pages,
    genre: input.genre,
    artStyle: input.artStyle,
    treatment: input.treatment,
    audience: input.audience,
    focus: input.focus,
    requestedBy: input.requestedBy
  });
  await writeFile(path.join(job.jobDir, "source.txt"), source.text, "utf8");
  log(`Job created: ${job.id}`);
  log(`Source saved: ${path.join(job.jobDir, "source.txt")} (title: ${source.title})`);

  // 2.5 キャラクターシート画像を収集(既定: manga-templates/character-sheets)
  const characterSheetsDir = input.characterSheetsDir ?? DEFAULT_CHARACTER_SHEETS_DIR;
  const characterSheetPaths = await listCharacterSheetImages(characterSheetsDir);
  if (characterSheetPaths.length > 0) {
    log(`Character sheets: ${characterSheetPaths.length} 件 (${characterSheetsDir})`);
    for (const p of characterSheetPaths) {
      if (!path.basename(p).includes("キャラクター")) {
        log(
          `  注意: ファイル名に「キャラクター」が含まれていません: ${path.basename(p)}（NotebookLM がキャラ参照画像と認識しない可能性）`
        );
      }
    }
  } else {
    log(`Character sheets: なし (${characterSheetsDir})`);
  }

  // 3. Step1 -> Step2 を Codex CLI で実行(失敗はジョブに記録して再 throw)
  log("Running Step1 (構成・キャラID・コマ割り) ...");
  let result;
  try {
    result = await generateMangaOutline(job, source.text, { characterSheetPaths });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateMangaJob(job, { error: message });
    await writeMangaViewerState({
      articleUrl: source.url,
      title: source.title,
      status: "failed",
      stage: "preparing",
      statusMessage: "漫画生成の準備に失敗しました",
      diagnostic: { code: "MANGA_OUTLINE_FAILED", detail: message, jobId: job.id },
      log
    });
    throw error;
  }

  let nextJob = await updateMangaJob(job, {
    codexHomeDir: result.codexHomeDir,
    step1OutputPath: result.step1OutputPath,
    step2OutputPath: result.step2OutputPath,
    uploadDir: result.uploadDir,
    characterSheets: result.characterSheets
  });

  // 4. Drive へ step1/step2 を Google ドキュメントとして upsert(設定時のみ)。
  //    Drive 失敗は生成物・ジョブ成功を壊さないよう隔離する。
  let driveStep1Url: string | undefined;
  let driveStep2Url: string | undefined;
  let driveError: string | undefined;
  await writeMangaViewerState({
    articleUrl: source.url,
    title: source.title,
    status: "processing",
    stage: "drive_registration",
    statusMessage: "Google Driveに生成素材を登録しています",
    log
  });
  if (config.MANGA_DRIVE_FOLDER_ID) {
    try {
      log("Uploading step1/step2 to Google Drive (Google ドキュメント) ...");
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
      nextJob = await updateMangaJob(nextJob, {
        driveFolderId: config.MANGA_DRIVE_FOLDER_ID,
        driveStep1Url,
        driveStep2Url
      });
      log(`  step1: ${doc1.created ? "created" : "updated"} ${driveStep1Url ?? doc1.id}`);
      log(`  step2: ${doc2.created ? "created" : "updated"} ${driveStep2Url ?? doc2.id}`);
    } catch (error) {
      driveError = error instanceof Error ? error.message : String(error);
      nextJob = await updateMangaJob(nextJob, { error: `Drive upload failed: ${driveError}` });
      await writeMangaViewerState({
        articleUrl: source.url,
        title: source.title,
        status: "failed",
        stage: "drive_registration",
        statusMessage: "Google Driveへの登録に失敗しました",
        diagnostic: { code: "DRIVE_REGISTRATION_FAILED", detail: driveError, jobId: job.id },
        log
      });
      log(`  注意: Drive アップロードに失敗しました(生成物はローカルに保存済み): ${driveError}`);
    }
  } else {
    driveError = "MANGA_DRIVE_FOLDER_ID 未設定";
    await writeMangaViewerState({
      articleUrl: source.url,
      title: source.title,
      status: "failed",
      stage: "drive_registration",
      statusMessage: "Google Driveへの登録を開始できませんでした",
      diagnostic: { code: "DRIVE_CONFIGURATION_MISSING", detail: driveError, jobId: job.id },
      log
    });
    log("Drive upload: スキップ (MANGA_DRIVE_FOLDER_ID 未設定)");
  }

  // 5. NotebookLM 自動操作(claude --chrome)。設定有効 & Drive 同期元が揃っている時のみ。
  //    NotebookLM は Drive を参照元にするため、step1/step2 両方の Drive 登録成功が前提。
  //    Drive 同様に失敗を隔離し、生成・ジョブ本体は壊さない。
  let notebookLmStatus: NotebookLmSyncStatus | undefined;
  let notebookLmDetail: string | undefined;
  if (config.MANGA_NOTEBOOKLM_AUTOSYNC) {
    if (driveStep1Url && driveStep2Url) {
      await writeMangaViewerState({
        articleUrl: source.url,
        title: source.title,
        status: "processing",
        stage: "source_registration",
        statusMessage: "NotebookLMにソースを登録しています",
        log
      });
      const engine = config.NOTEBOOKLM_NOTEBOOK_ID ? "playwright" : "claude --chrome";
      log(`NotebookLM 同期 + Step3 トリガを実行中 (${engine} / ノートブック「${config.MANGA_NOTEBOOKLM_NAME}」) ...`);
      const sync = await runNotebookLmSourceSync({ job: nextJob, logger: log });
      nextJob = sync.job;
      notebookLmStatus = sync.status;
      notebookLmDetail = sync.detail;
      if (sync.status === "executed") {
        await writeMangaViewerState({
          articleUrl: source.url,
          title: source.title,
          status: "processing",
          stage: "deck_generation",
          statusMessage: "NotebookLMでスライドデックを生成しています",
          log
        });
      } else if (sync.failureKind === "signed_out") {
        // ログイン失効は「再ログイン→resume」で確実に回収できる状態として区別する。
        await writeMangaViewerState({
          articleUrl: source.url,
          title: source.title,
          status: "action_required",
          stage: "source_registration",
          statusMessage: "NotebookLMのGoogleログインが失効しています。notebooklm:login 後に再開してください",
          diagnostic: { code: "NOTEBOOKLM_SESSION_EXPIRED", detail: sync.detail, jobId: job.id },
          log
        });
      } else {
        await writeMangaViewerState({
          articleUrl: source.url,
          title: source.title,
          status: "failed",
          stage: "source_registration",
          statusMessage: "NotebookLMへのソース登録に失敗しました",
          diagnostic: { code: "NOTEBOOKLM_SOURCE_REGISTRATION_FAILED", detail: sync.detail, jobId: job.id },
          log
        });
      }
    } else {
      notebookLmStatus = "skipped";
      notebookLmDetail = "Drive アップロード未完了のため NotebookLM 同期をスキップ";
      log(`NotebookLM: スキップ (${notebookLmDetail})`);
    }
    nextJob = await updateMangaJob(nextJob, { notebookLmStatus, notebookLmDetail });
  } else {
    if (driveStep1Url && driveStep2Url) {
      notebookLmStatus = "failed";
      notebookLmDetail = "MANGA_NOTEBOOKLM_AUTOSYNC 未設定";
      nextJob = await updateMangaJob(nextJob, { notebookLmStatus, notebookLmDetail });
      await writeMangaViewerState({
        articleUrl: source.url,
        title: source.title,
        status: "failed",
        stage: "source_registration",
        statusMessage: "NotebookLMへのソース登録を開始できませんでした",
        diagnostic: { code: "NOTEBOOKLM_AUTOSYNC_DISABLED", detail: notebookLmDetail, jobId: job.id },
        log
      });
    }
    log("NotebookLM 自動同期: スキップ (MANGA_NOTEBOOKLM_AUTOSYNC 未設定)");
  }

  return {
    job: nextJob,
    title: source.title,
    artStyleName: result.artStyleName,
    characterSheets: result.characterSheets,
    step1OutputPath: result.step1OutputPath,
    step2OutputPath: result.step2OutputPath,
    uploadDir: result.uploadDir,
    driveStep1Url,
    driveStep2Url,
    driveError,
    notebookLmStatus,
    notebookLmDetail
  };
}

type ViewerStateInput = {
  articleUrl: string;
  title?: string;
  status: ViewerArticleStatus;
  stage: ArtifactStage;
  statusMessage: string;
  diagnostic?: { code: string; detail: string; jobId?: string };
  log: (message: string) => void;
};

async function writeMangaViewerState(input: ViewerStateInput): Promise<void> {
  try {
    await upsertMangaArtifact({
      articleUrl: input.articleUrl,
      deckUrl: "",
      status: input.status,
      stage: input.stage,
      statusMessage: input.statusMessage,
      title: input.title
    });
    if (input.diagnostic) {
      await upsertArtifactDiagnostic({
        articleUrl: input.articleUrl,
        artifactType: "manga",
        status: input.status,
        stage: input.stage,
        ...input.diagnostic
      });
    } else {
      await clearArtifactDiagnostic(input.articleUrl, "manga");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.log(`Firebase manga status update failed: ${message}`);
  }
}
