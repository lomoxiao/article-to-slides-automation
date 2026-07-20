import { config } from "../../config.js";
import { updateMangaJob } from "../manga/mangaJobStore.js";
import { openNotebookLmSession, type DriverFailure } from "./notebookLmDriver.js";
import type { NotebookLmSyncStatus } from "./notebookLmSync.js";
import {
  fetchMangaDeckUrl,
  shouldRetryMangaDeckFetch,
  type MangaDeckFetchResult
} from "../manga/mangaDeckUrlFetcher.js";
import {
  clearArtifactDiagnostic,
  upsertArtifactDiagnostic,
  upsertMangaArtifact,
  type ArtifactStage
} from "../../shared/firebaseArticleStore.js";
import { recordSessionExpired } from "../../shared/sessionStatusStore.js";
import { notifyMangaDeckReady, notifyMangaDeckFailed } from "../../shared/slackNotifier.js";
import type { MangaJob } from "../../types/manga.js";
import {
  DRIVER_RESTART_RETRIES,
  NBLM_SESSION_DOMAIN,
  notifyUiFallback,
  sleep,
  triggerStep3WithRetries
} from "./nblmCommon.js";
import { acquireNblmLock, releaseNblmLock } from "./nblmLock.js";

// Phase4(デックURL取得)。主経路は notebookLmDriver(決定論 Playwright)の artifact 差分
// ポーリング。nblmEngine が claude-chrome のジョブや ui_mismatch 時は従来経路
// (mangaDeckUrlFetcher)へフォールバックする。Phase3 は notebookLmPipeline.ts。

export type DeckRetrievalInput = {
  job: MangaJob;
  /** Phase3 の結果。executed のときのみデック取得を行う。 */
  notebookLmStatus?: NotebookLmSyncStatus;
  channelId?: string;
  requestedBy?: string;
  logger?: (message: string) => void;
};

/**
 * Phase4: デック生成完了を待って共有URLを取得し、Firebase manga.url へ登録する。
 * 旧 mangaDeckRetrieval.fetchAndRegisterMangaDeck の後継。例外は投げず内部で隔離する。
 */
export async function runNotebookLmDeckRetrieval(input: DeckRetrievalInput): Promise<void> {
  const log = input.logger ?? (() => {});
  const { job } = input;

  if (!config.manga.deckAutofetch) {
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

  const lock = await acquireNblmLock();
  if (!lock.ok) {
    await handleDeckFailure(input, job, "retrieval_failed", "url_retrieval", lock.detail, log);
    return;
  }

  try {
    const usePlaywright = job.nblmEngine === "playwright" && Boolean(config.notebookLm.notebookId);
    if (usePlaywright) {
      await runPlaywrightDeckRetrieval(input, job, log);
    } else {
      await runLegacyDeckRetrieval(input, job, log);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`デックURL取得: 例外で失敗 (${message})`);
    await handleDeckFailure(input, job, "failed", "url_retrieval", message, log);
  } finally {
    await releaseNblmLock();
  }
}

/** Playwright 経路: artifact 差分ポーリングで完成を検知し URL を登録する。 */
async function runPlaywrightDeckRetrieval(
  input: DeckRetrievalInput,
  job: MangaJob,
  log: (message: string) => void
): Promise<void> {
  const beforeIds = job.nblmArtifactsBefore ?? [];
  let retriggered = false;
  let lastFailure: DriverFailure | undefined;

  for (let attempt = 0; attempt <= DRIVER_RESTART_RETRIES; attempt += 1) {
    if (attempt > 0) {
      log(`デックURL取得: ドライバを再起動して再試行します (${attempt}/${DRIVER_RESTART_RETRIES})`);
    }
    const opened = await openNotebookLmSession({
      notebookId: config.notebookLm.notebookId as string,
      jobDir: job.jobDir,
      logger: log
    });
    if (!opened.ok) {
      lastFailure = opened.failure;
      if (opened.failure.kind === "signed_out") {
        await recordSessionExpired(NBLM_SESSION_DOMAIN).catch(() => {});
        break;
      }
      if (opened.failure.kind === "unreachable") continue;
      break;
    }
    const session = opened.value;

    try {
      const waited = await session.waitForNewArtifact(beforeIds);
      if (waited.ok) {
        await registerAndNotify(input, job, waited.value, log);
        return;
      }
      lastFailure = waited.failure;

      // トリガ後にチャット側が「回答できません」を出したケース: 1度だけ再トリガして待ち直す。
      if (waited.failure.kind === "nblm_unavailable" && !retriggered) {
        retriggered = true;
        log("デックURL取得: 回答不能応答を検出。Step3 を再トリガします");
        const reloaded = await session.reload();
        if (reloaded.ok) {
          const triggered = await triggerStep3WithRetries(session, log);
          if (triggered.ok) {
            const rewaited = await session.waitForNewArtifact(beforeIds);
            if (rewaited.ok) {
              await registerAndNotify(input, job, rewaited.value, log);
              return;
            }
            lastFailure = rewaited.failure;
          } else {
            lastFailure = triggered.failure;
          }
        }
      }

      if (lastFailure.kind !== "timeout" && lastFailure.kind !== "unreachable") {
        break;
      }
      if (lastFailure.kind === "timeout") {
        // デック生成待ちの総時間超過はドライバ再起動しても意味がない。
        break;
      }
    } finally {
      await session.close();
    }
  }

  const failure = lastFailure ?? { kind: "unreachable" as const, detail: "デックURL取得に失敗しました" };
  if (failure.kind === "ui_mismatch" && config.manga.nblmFallbackClaudeChrome) {
    await notifyUiFallback("Phase4(デックURL取得)", failure.detail, log);
    await runLegacyDeckRetrieval(input, job, log, { skipInitialWait: true });
    return;
  }

  const mapped = mapDriverFailureToDeck(failure);
  await handleDeckFailure(input, job, mapped.status, mapped.stage, failure.detail, log, mapped.code);
}

export function mapDriverFailureToDeck(failure: DriverFailure): {
  status: NonNullable<MangaJob["mangaDeckStatus"]>;
  stage: ArtifactStage;
  code: string;
} {
  switch (failure.kind) {
    case "generation_failed":
      return { status: "generation_failed", stage: "deck_generation", code: "MANGA_DECK_GENERATION_FAILED" };
    case "timeout":
      return { status: "pending", stage: "deck_generation", code: "MANGA_DECK_GENERATION_TIMEOUT" };
    case "nblm_unavailable":
      return { status: "generation_failed", stage: "deck_generation", code: "MANGA_DECK_GENERATION_FAILED" };
    case "signed_out":
      return { status: "retrieval_failed", stage: "url_retrieval", code: "NOTEBOOKLM_SESSION_EXPIRED" };
    default:
      return { status: "retrieval_failed", stage: "url_retrieval", code: "MANGA_DECK_URL_RETRIEVAL_FAILED" };
  }
}

/**
 * 従来経路: 固定待機(約10分)→ claude --chrome で1回確認 → pending/一時失敗は1分×最大3回リトライ。
 * Playwright からのフォールバック時は既に待機済みのため skipInitialWait を指定する。
 */
async function runLegacyDeckRetrieval(
  input: DeckRetrievalInput,
  job: MangaJob,
  log: (message: string) => void,
  options?: { skipInitialWait?: boolean }
): Promise<void> {
  if (!options?.skipInitialWait) {
    log(`デックURL取得: 生成完了を待機します (${Math.round(config.manga.deckInitialWaitMs / 1000)}秒) ...`);
    await sleep(config.manga.deckInitialWaitMs);
  }

  let result: MangaDeckFetchResult = await fetchMangaDeckUrl({ jobDir: job.jobDir, logger: log });

  let retries = 0;
  while (shouldRetryMangaDeckFetch(result) && retries < config.manga.deckMaxRetries) {
    retries += 1;
    const reason = result.status === "pending" ? "まだ生成中" : "一時的なURL取得失敗";
    log(
      `デックURL取得: ${reason}。${Math.round(config.manga.deckRetryWaitMs / 1000)}秒待機して再確認します ` +
        `(${retries}/${config.manga.deckMaxRetries})`
    );
    await sleep(config.manga.deckRetryWaitMs);
    result = await fetchMangaDeckUrl({ jobDir: job.jobDir, logger: log });
  }

  if (result.status === "fetched" && result.url) {
    await registerAndNotify(input, job, result.url, log);
    return;
  }

  const detail =
    result.status === "pending"
      ? `スライド生成が${config.manga.deckMaxRetries}回の再確認後も完了しませんでした`
      : result.detail;
  const stage: ArtifactStage = result.status === "retrieval_failed" ? "url_retrieval" : "deck_generation";
  const code =
    result.status === "pending"
      ? "MANGA_DECK_GENERATION_TIMEOUT"
      : result.status === "generation_failed"
        ? "MANGA_DECK_GENERATION_FAILED"
        : "MANGA_DECK_URL_RETRIEVAL_FAILED";
  await handleDeckFailure(input, job, result.status, stage, detail, log, code);
}

/** 取得済みURLを Firebase に登録し、成功 or Firebase 失敗を通知する(旧 mangaDeckRetrieval から移植)。 */
async function registerAndNotify(
  input: DeckRetrievalInput,
  job: MangaJob,
  deckUrl: string,
  log: (message: string) => void
): Promise<void> {
  try {
    await upsertMangaArtifact({
      articleUrl: job.url,
      deckUrl,
      status: "completed",
      title: job.title
    });
    await clearArtifactDiagnostic(job.url, "manga");
    await updateMangaJob(job, {
      mangaDeckStatus: "fetched",
      mangaDeckUrl: deckUrl,
      mangaDeckDetail: "",
      nblmPhase: "url_registered"
    });
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

/** 失敗をジョブ・ビューア(action_required)・Slack へ一括反映する。 */
async function handleDeckFailure(
  input: DeckRetrievalInput,
  job: MangaJob,
  status: NonNullable<MangaJob["mangaDeckStatus"]>,
  stage: ArtifactStage,
  detail: string,
  log: (message: string) => void,
  code = "MANGA_DECK_URL_RETRIEVAL_FAILED"
): Promise<void> {
  await updateMangaJob(job, { mangaDeckStatus: status, mangaDeckDetail: detail, nblmPhase: "deck_wait" }).catch(
    () => {}
  );
  const statusMessage =
    stage === "url_retrieval" ? "URLの自動取得に失敗しました。手動で登録してください" : "デック生成状況を確認してください";
  await writeRecoverableState(input, job, stage, statusMessage, { code, detail });
  log(`デックURL取得: 失敗 (${detail})`);
  await notifyMangaDeckFailed({
    channelId: input.channelId,
    requestedBy: input.requestedBy,
    jobId: job.id,
    error: `${detail}\n再開するには: npm run manga:resume -- ${job.id}`
  }).catch((e) => log(`Slack 通知に失敗: ${e}`));
}

async function writeRecoverableState(
  input: DeckRetrievalInput,
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
