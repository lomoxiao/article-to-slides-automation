import { runArticleToMangaJob } from "./articleToManga.js";
import { notifyMangaCompleted, notifyMangaFailed } from "./slackNotifier.js";
import type { MangaTreatment } from "../types/manga.js";

export type EnqueueMangaGenerationInput = {
  url: string;
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
  queueTail = queueTail.then(() => runMangaJob(input));
}

async function runMangaJob(input: EnqueueMangaGenerationInput): Promise<void> {
  try {
    const result = await runArticleToMangaJob({
      url: input.url,
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
