import { config } from "../config.js";
import { updateMangaJob } from "./mangaJobStore.js";
import { fetchMangaDeckUrl, shouldRetryMangaDeckFetch, type MangaDeckFetchResult } from "./mangaDeckUrlFetcher.js";
import {
  clearArtifactDiagnostic,
  upsertArtifactDiagnostic,
  upsertMangaArtifact,
  type ArtifactStage
} from "./firebaseArticleStore.js";
import { notifyMangaDeckReady, notifyMangaDeckFailed } from "./slackNotifier.js";
import type { MangaJob } from "../types/manga.js";

type FetchAndRegisterMangaDeckInput = {
  job: MangaJob;
  /** NotebookLM Step3 トリガの結果。executed のときのみデック取得を行う。 */
  notebookLmStatus?: "executed" | "skipped" | "failed";
  channelId?: string;
  requestedBy?: string;
  logger?: (message: string) => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Step3 で生成されたスライドデックの共有URLを取得し、Firebase の manga.url へ登録する後続フェーズ。
 *
 * - Step3 が executed でない(=スライド生成が正常起動していない)場合は何もしない。
 * - 固定待機(約10分)後にデック状態を確認し、まだ生成中なら追加で1分待機×最大3回リトライする。
 * - 取得成功 → Firebase 登録 → Slack 成功通知。
 * - 生成未完了(リトライ上限) / 取得失敗 / Firebase 失敗 → Slack エラー通知。
 * - 例外は投げず内部で隔離する(Drive / NotebookLM 同期と同じ思想。漫画生成本体は壊さない)。
 */
export async function fetchAndRegisterMangaDeck(input: FetchAndRegisterMangaDeckInput): Promise<void> {
  const log = input.logger ?? (() => {});
  const { job } = input;

  if (!config.MANGA_DECK_AUTOFETCH) {
    log("デックURL取得: スキップ (MANGA_DECK_AUTOFETCH 未設定)");
    if (input.notebookLmStatus === "executed") {
      await writeRecoverableState(input, job, "url_retrieval", "URLを手動登録してください", {
        code: "MANGA_DECK_AUTOFETCH_DISABLED",
        detail: "MANGA_DECK_AUTOFETCH 未設定"
      });
    }
    return;
  }
  if (input.notebookLmStatus !== "executed") {
    log(`デックURL取得: スキップ (Step3 未起動 / notebookLmStatus=${input.notebookLmStatus ?? "未実行"})`);
    return;
  }

  try {
    log(`デックURL取得: 生成完了を待機します (${Math.round(config.MANGA_DECK_INITIAL_WAIT_MS / 1000)}秒) ...`);
    await sleep(config.MANGA_DECK_INITIAL_WAIT_MS);

    let result: MangaDeckFetchResult = await fetchMangaDeckUrl({ jobDir: job.jobDir, logger: log });

    let retries = 0;
    while (shouldRetryMangaDeckFetch(result) && retries < config.MANGA_DECK_MAX_RETRIES) {
      retries += 1;
      const reason = result.status === "pending" ? "まだ生成中" : "一時的なURL取得失敗";
      log(
        `デックURL取得: ${reason}。${Math.round(config.MANGA_DECK_RETRY_WAIT_MS / 1000)}秒待機して再確認します ` +
          `(${retries}/${config.MANGA_DECK_MAX_RETRIES})`
      );
      await sleep(config.MANGA_DECK_RETRY_WAIT_MS);
      result = await fetchMangaDeckUrl({ jobDir: job.jobDir, logger: log });
    }

    if (result.status === "fetched" && result.url) {
      await registerAndNotify(input, job, result.url, log);
      return;
    }

    // 生成待ち上限・生成失敗・URL取得失敗はいずれも手動で継続できる状態として公開する。
    const detail =
      result.status === "pending"
        ? `スライド生成が${config.MANGA_DECK_MAX_RETRIES}回の再確認後も完了しませんでした`
        : result.detail;
    await updateMangaJob(job, { mangaDeckStatus: result.status, mangaDeckDetail: detail });
    const stage: ArtifactStage = result.status === "retrieval_failed" ? "url_retrieval" : "deck_generation";
    const statusMessage =
      stage === "url_retrieval" ? "URLの自動取得に失敗しました。手動で登録してください" : "デック生成状況を確認してください";
    await writeRecoverableState(input, job, stage, statusMessage, {
      code:
        result.status === "pending"
          ? "MANGA_DECK_GENERATION_TIMEOUT"
          : result.status === "generation_failed"
            ? "MANGA_DECK_GENERATION_FAILED"
            : "MANGA_DECK_URL_RETRIEVAL_FAILED",
      detail
    });
    log(`デックURL取得: 失敗 (${detail})`);
    await notifyMangaDeckFailed({
      channelId: input.channelId,
      requestedBy: input.requestedBy,
      jobId: job.id,
      error: detail
    }).catch((e) => log(`Slack 通知に失敗: ${e}`));
  } catch (error) {
    // 想定外の例外も隔離して通知する(漫画生成本体は既に完了している)。
    const message = error instanceof Error ? error.message : String(error);
    await updateMangaJob(job, { mangaDeckStatus: "failed", mangaDeckDetail: message }).catch(() => {});
    await writeRecoverableState(input, job, "url_retrieval", "URLの自動取得に失敗しました。手動で登録してください", {
      code: "MANGA_DECK_RETRIEVAL_EXCEPTION",
      detail: message
    });
    log(`デックURL取得: 例外で失敗 (${message})`);
    await notifyMangaDeckFailed({
      channelId: input.channelId,
      requestedBy: input.requestedBy,
      jobId: job.id,
      error: message
    }).catch((e) => log(`Slack 通知に失敗: ${e}`));
  }
}

/** 取得済みURLを Firebase に登録し、成功 or Firebase 失敗を通知する。 */
async function registerAndNotify(
  input: FetchAndRegisterMangaDeckInput,
  job: MangaJob,
  deckUrl: string,
  log: (m: string) => void
): Promise<void> {
  try {
    await upsertMangaArtifact({
      articleUrl: job.url,
      deckUrl,
      status: "completed",
      title: job.title
    });
    await clearArtifactDiagnostic(job.url, "manga");
    await updateMangaJob(job, { mangaDeckStatus: "fetched", mangaDeckUrl: deckUrl, mangaDeckDetail: "" });
    log(`デックURL取得: 完了。Firebase に登録しました (${deckUrl})`);
    await notifyMangaDeckReady({
      channelId: input.channelId,
      requestedBy: input.requestedBy,
      jobId: job.id,
      title: job.title,
      deckUrl
    }).catch((e) => log(`Slack 通知に失敗: ${e}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // URL は取得できたが Firebase 書き込みに失敗。URL は失わないようジョブには記録する。
    await updateMangaJob(job, {
      mangaDeckStatus: "failed",
      mangaDeckUrl: deckUrl,
      mangaDeckDetail: `Firebase 登録に失敗: ${message}`
    }).catch(() => {});
    log(`デックURL取得: URL は取得したが Firebase 登録に失敗 (${message})`);
    await notifyMangaDeckFailed({
      channelId: input.channelId,
      requestedBy: input.requestedBy,
      jobId: job.id,
      error: `Firebase 登録に失敗(URL=${deckUrl}): ${message}`
    }).catch((e) => log(`Slack 通知に失敗: ${e}`));
  }
}

async function writeRecoverableState(
  input: FetchAndRegisterMangaDeckInput,
  job: MangaJob,
  stage: ArtifactStage,
  statusMessage: string,
  diagnostic: { code: string; detail: string }
): Promise<void> {
  try {
    await upsertMangaArtifact({
      articleUrl: job.url,
      deckUrl: "",
      status: "action_required",
      stage,
      statusMessage,
      title: job.title
    });
    await upsertArtifactDiagnostic({
      articleUrl: job.url,
      artifactType: "manga",
      status: "action_required",
      stage,
      code: diagnostic.code,
      detail: diagnostic.detail,
      jobId: job.id
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (input.logger ?? (() => {}))(`Firebase manga recoverable status update failed: ${message}`);
  }
}
