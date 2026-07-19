import { runArticleToMangaJob } from "./articleToManga.js";
import { runNotebookLmDeckRetrieval } from "./notebookLmPipeline.js";
import { notifyMangaCompleted, notifyMangaFailed } from "./slackNotifier.js";
import { clearArtifactDiagnostic, upsertMangaArtifact } from "./firebaseArticleStore.js";
import type { MangaTreatment } from "../types/manga.js";

export type EnqueueMangaGenerationInput = {
  url: string;
  sourceText?: string;
  sourceTitle?: string;
  pages: number;
  genre?: string;
  artStyle: string;
  treatment: MangaTreatment;
  audience?: string;
  focus?: string;
  requestedBy?: string;
  sourceChannelId?: string;
};

// Manga generation is heavy and long-running, so run one job at a time.
// Promise チェーンで順次処理し、各ジョブの完了/失敗は Slack に個別通知する。
let queueTail: Promise<void> = Promise.resolve();

/**
 * 漫画生成を直列キューに積む(即時 return)。Slack の 3 秒 ack 制約を満たすため、
 * 生成本体は待たずに裏で実行し、完了/失敗時にチャンネルへ通知する。
 */
export function enqueueMangaGeneration(input: EnqueueMangaGenerationInput): void {
  const queuedState = writeQueuedViewerState(input);
  queueTail = queueTail.then(async () => {
    await queuedState;
    await runMangaJob(input);
  });
}

async function writeQueuedViewerState(input: EnqueueMangaGenerationInput): Promise<void> {
  try {
    await upsertMangaArtifact({
      articleUrl: input.url,
      deckUrl: "",
      status: "processing",
      stage: "preparing",
      statusMessage: "漫画生成の開始を待っています",
      title: input.sourceTitle || input.focus
    });
    await clearArtifactDiagnostic(input.url, "manga");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[manga-generate] queued status update failed: ${message}`);
  }
}

async function runMangaJob(input: EnqueueMangaGenerationInput): Promise<void> {
  try {
    const result = await runArticleToMangaJob({
      url: input.url,
      sourceText: input.sourceText,
      sourceTitle: input.sourceTitle,
      pages: input.pages,
      genre: input.genre,
      artStyle: input.artStyle,
      treatment: input.treatment,
      audience: input.audience,
      focus: input.focus,
      requestedBy: input.requestedBy,
      logger: (message) => console.log(`[manga-generate] ${message}`)
    });

    await notifyMangaCompleted({
      channelId: input.sourceChannelId,
      requestedBy: input.requestedBy,
      jobId: result.job.id,
      title: result.title,
      driveStep1Url: result.driveStep1Url,
      driveStep2Url: result.driveStep2Url,
      driveError: result.driveError,
      notebookLmStatus: result.notebookLmStatus,
      notebookLmDetail: result.notebookLmDetail
    });

    // 後続フェーズ: Step3 が起動していれば生成完了を待ってデックURLを取得し Firebase に登録する。
    // 長い待機(ポーリング/固定待機)を含むが、例外は内部で隔離され通知されるのでキューは止めない。
    await runNotebookLmDeckRetrieval({
      job: result.job,
      notebookLmStatus: result.notebookLmStatus,
      channelId: input.sourceChannelId,
      requestedBy: input.requestedBy,
      logger: (message) => console.log(`[manga-generate] ${message}`)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[manga-generate] generation failed: ${message}`);
    await notifyMangaFailed({
      channelId: input.sourceChannelId,
      requestedBy: input.requestedBy,
      error: message
    }).catch((notifyError) => {
      console.error(`[manga-generate] failed to post failure notification: ${notifyError}`);
    });
  }
}
