import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { updateMangaJob } from "../manga/mangaJobStore.js";
import { openNotebookLmSession, type DriverFailure, type NotebookLmFailureKind, type NotebookLmSession } from "./notebookLmDriver.js";
import { syncNotebookLm, type NotebookLmSyncStatus } from "./notebookLmSync.js";
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
import { notifyMangaDeckReady, notifyMangaDeckFailed, postSlackText } from "../../shared/slackNotifier.js";
import type { MangaJob } from "../../types/manga.js";

// Phase3(ソース同期+Step3トリガ)と Phase4(デックURL取得)の統合パイプライン。
// 主経路は notebookLmDriver(決定論 Playwright)。NOTEBOOKLM_NOTEBOOK_ID 未設定、または
// ui_mismatch 検出時は従来の claude --chrome 経路(notebookLmSync / mangaDeckUrlFetcher)へ
// フォールバックする。NotebookLM は固定ノートブック+固定 Drive ドキュメントのシングルトン
// 資源のため、.nblm.lock でプロセス間の直列性を保証する(daemon と manga:resume の排他)。

export const NBLM_SESSION_DOMAIN = "notebooklm.google.com";

const LOCK_DIR = path.join("jobs", "manga", ".nblm.lock");
const LOCK_STALE_MS = 60 * 60 * 1000;
// timeout/unreachable でのドライバ再起動リトライ上限(初回含めた試行数ではなく追加リトライ数)。
const DRIVER_RESTART_RETRIES = 2;
// 「現在、回答できません」時の再送バックオフ(分)。MANGA_NBLM_CHAT_RETRIES 回まで先頭から使う。
const CHAT_RETRY_BACKOFF_MIN = [2, 4, 8];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SourceSyncOutcome = {
  job: MangaJob;
  status: NotebookLmSyncStatus;
  detail: string;
  /** Playwright 経路の失敗分類(signed_out はビューアで action_required にする)。 */
  failureKind?: NotebookLmFailureKind;
};

/** テストから副作用(実ブラウザ・claude spawn・RTDB/Slack書込)を差し替えるための注入点。 */
export type SourceSyncDeps = {
  openSession: typeof openNotebookLmSession;
  legacySync: typeof syncNotebookLm;
  recordExpired: (domain: string) => Promise<void>;
  notifyFallback: (phase: string, detail: string, log: (message: string) => void) => Promise<void>;
};

/**
 * Phase3: ソース同期 + Step3 トリガ。articleToManga の step5 から呼ばれる。
 * 成功時は job に nblmPhase="deck_wait" と トリガ前 artifact スナップショットを永続化し、
 * Phase4(runNotebookLmDeckRetrieval)が別セッションで差分検出できるようにする。
 */
export async function runNotebookLmSourceSync(
  input: {
    job: MangaJob;
    logger?: (message: string) => void;
  },
  overrides: Partial<SourceSyncDeps> = {}
): Promise<SourceSyncOutcome> {
  const deps: SourceSyncDeps = {
    openSession: openNotebookLmSession,
    legacySync: syncNotebookLm,
    recordExpired: recordSessionExpired,
    notifyFallback: notifyUiFallback,
    ...overrides
  };
  const log = input.logger ?? (() => {});
  let job = input.job;

  const lock = await acquireNblmLock();
  if (!lock.ok) {
    return { job, status: "failed", detail: lock.detail };
  }

  try {
    if (!config.NOTEBOOKLM_NOTEBOOK_ID) {
      log("NotebookLM: NOTEBOOKLM_NOTEBOOK_ID 未設定のため claude --chrome 経路で実行します");
      return await runLegacySourceSync(job, log, "NOTEBOOKLM_NOTEBOOK_ID 未設定", deps);
    }

    let lastFailure: DriverFailure | undefined;
    for (let attempt = 0; attempt <= DRIVER_RESTART_RETRIES; attempt += 1) {
      if (attempt > 0) {
        log(`NotebookLM: ドライバを再起動して再試行します (${attempt}/${DRIVER_RESTART_RETRIES})`);
      }
      job = await updateMangaJob(job, { nblmEngine: "playwright", nblmAttempts: (job.nblmAttempts ?? 0) + 1 });

      const outcome = await runPlaywrightSourceSyncOnce(job, log, deps);
      if (outcome.ok) {
        job = await updateMangaJob(job, {
          nblmPhase: "deck_wait",
          nblmArtifactsBefore: outcome.artifactsBefore
        });
        return { job, status: "executed", detail: "NOTEBOOKLM_DONE (playwright)" };
      }

      lastFailure = outcome.failure;
      if (outcome.failure.kind === "signed_out") {
        await deps.recordExpired(NBLM_SESSION_DOMAIN).catch(() => {});
        job = await updateMangaJob(job, { nblmPhase: "failed" });
        return { job, status: "failed", detail: outcome.failure.detail, failureKind: "signed_out" };
      }
      if (outcome.failure.kind === "ui_mismatch") {
        break;
      }
      if (outcome.failure.kind !== "timeout" && outcome.failure.kind !== "unreachable") {
        // nblm_unavailable(リトライ済)・generation_failed はドライバ再起動では直らない。
        job = await updateMangaJob(job, { nblmPhase: "failed" });
        return { job, status: "failed", detail: outcome.failure.detail, failureKind: outcome.failure.kind };
      }
    }

    if (lastFailure?.kind === "ui_mismatch" && config.MANGA_NBLM_FALLBACK_CLAUDE_CHROME) {
      await deps.notifyFallback("Phase3(ソース同期)", lastFailure.detail, log);
      return await runLegacySourceSync(job, log, `ui_mismatch: ${lastFailure.detail}`, deps);
    }

    job = await updateMangaJob(job, { nblmPhase: "failed" });
    return {
      job,
      status: "failed",
      detail: lastFailure?.detail ?? "NotebookLM 操作に失敗しました",
      failureKind: lastFailure?.kind
    };
  } finally {
    await releaseNblmLock();
  }
}

type PlaywrightSyncOnceResult =
  | { ok: true; artifactsBefore: string[] }
  | { ok: false; failure: DriverFailure };

/** 1回のドライバセッションで open → sync → snapshot → trigger(チャットリトライ込み)を実行する。 */
async function runPlaywrightSourceSyncOnce(
  job: MangaJob,
  log: (message: string) => void,
  deps: SourceSyncDeps
): Promise<PlaywrightSyncOnceResult> {
  const opened = await deps.openSession({
    notebookId: config.NOTEBOOKLM_NOTEBOOK_ID as string,
    jobDir: job.jobDir,
    logger: log
  });
  if (!opened.ok) {
    return { ok: false, failure: opened.failure };
  }
  const session = opened.value;

  try {
    const synced = await session.syncSources();
    if (!synced.ok) return { ok: false, failure: synced.failure };

    const snapshot = await session.snapshotArtifacts();
    if (!snapshot.ok) return { ok: false, failure: snapshot.failure };
    const artifactsBefore = snapshot.value.items
      .map((item) => item.id)
      .filter((id): id is string => id !== null);

    const triggered = await triggerStep3WithRetries(session, log);
    if (!triggered.ok) return { ok: false, failure: triggered.failure };

    return { ok: true, artifactsBefore };
  } finally {
    await session.close();
  }
}

/** チャット送信。「現在、回答できません」はバックオフ(2/4/8分)+reload+再送で最大 N 回リトライする。 */
async function triggerStep3WithRetries(
  session: NotebookLmSession,
  log: (message: string) => void
): Promise<{ ok: true } | { ok: false; failure: DriverFailure }> {
  let lastFailure: DriverFailure | undefined;
  for (let attempt = 0; attempt <= config.MANGA_NBLM_CHAT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const backoffMin = CHAT_RETRY_BACKOFF_MIN[Math.min(attempt - 1, CHAT_RETRY_BACKOFF_MIN.length - 1)];
      log(`NotebookLM: 回答不能応答のため ${backoffMin} 分待機して再送します (${attempt}/${config.MANGA_NBLM_CHAT_RETRIES})`);
      await sleep(backoffMin * 60_000);
      const reloaded = await session.reload();
      if (!reloaded.ok) return reloaded;
    }
    const result = await session.triggerStep3();
    if (result.ok) return { ok: true };
    if (result.failure.kind !== "nblm_unavailable") return result;
    lastFailure = result.failure;
  }
  return { ok: false, failure: lastFailure as DriverFailure };
}

/** 従来の claude --chrome によるソース同期(フォールバック経路)。 */
async function runLegacySourceSync(
  job: MangaJob,
  log: (message: string) => void,
  reason: string,
  deps: SourceSyncDeps
): Promise<SourceSyncOutcome> {
  const sync = await deps.legacySync({ jobDir: job.jobDir, logger: log });
  const nextJob = await updateMangaJob(job, {
    nblmEngine: "claude-chrome",
    nblmPhase: sync.status === "executed" ? "deck_wait" : "failed",
    nblmArtifactsBefore: []
  });
  const detail = sync.status === "executed" ? sync.detail : `${sync.detail} (fallback理由: ${reason})`;
  return { job: nextJob, status: sync.status, detail };
}

type DeckRetrievalInput = {
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

  const lock = await acquireNblmLock();
  if (!lock.ok) {
    await handleDeckFailure(input, job, "retrieval_failed", "url_retrieval", lock.detail, log);
    return;
  }

  try {
    const usePlaywright = job.nblmEngine === "playwright" && Boolean(config.NOTEBOOKLM_NOTEBOOK_ID);
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
      notebookId: config.NOTEBOOKLM_NOTEBOOK_ID as string,
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
  if (failure.kind === "ui_mismatch" && config.MANGA_NBLM_FALLBACK_CLAUDE_CHROME) {
    await notifyUiFallback("Phase4(デックURL取得)", failure.detail, log);
    await runLegacyDeckRetrieval(input, job, log, { skipInitialWait: true });
    return;
  }

  const mapped = mapDriverFailureToDeck(failure);
  await handleDeckFailure(input, job, mapped.status, mapped.stage, failure.detail, log, mapped.code);
}

function mapDriverFailureToDeck(failure: DriverFailure): {
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
    log(`デックURL取得: 生成完了を待機します (${Math.round(config.MANGA_DECK_INITIAL_WAIT_MS / 1000)}秒) ...`);
    await sleep(config.MANGA_DECK_INITIAL_WAIT_MS);
  }

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

  const detail =
    result.status === "pending"
      ? `スライド生成が${config.MANGA_DECK_MAX_RETRIES}回の再確認後も完了しませんでした`
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

/** ui_mismatch フォールバック発動を Slack に通知し、恒常運用化(セレクタ放置)を防ぐ。 */
async function notifyUiFallback(phase: string, detail: string, log: (message: string) => void): Promise<void> {
  log(`NotebookLM: ${phase} で ui_mismatch。claude --chrome へフォールバックします`);
  await postSlackText({
    text:
      `⚠️ NotebookLM ${phase} でセレクタ不一致を検出し、claude --chrome へフォールバックしました。\n` +
      `NotebookLM の UI が変わった可能性があります。\`npm run notebooklm:probe\` で確認・修理してください。\n` +
      `詳細: ${detail}`
  }).catch((e) => log(`Slack 通知に失敗: ${e}`));
}

// --- プロセス間ロック(mkdirベース) ---

async function acquireNblmLock(): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(LOCK_DIR);
      return { ok: true };
    } catch {
      const stale = await isLockStale();
      if (stale) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      return {
        ok: false,
        detail:
          "別の NotebookLM 操作が実行中のためスキップしました(.nblm.lock)。" +
          "daemon のジョブ完了後に npm run manga:resume で再開してください"
      };
    }
  }
  return { ok: false, detail: "NotebookLM ロックの取得に失敗しました(.nblm.lock)" };
}

async function isLockStale(): Promise<boolean> {
  try {
    const info = await stat(LOCK_DIR);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch {
    // stat できない = 直前に解放された。取得を再試行してよい。
    return true;
  }
}

async function releaseNblmLock(): Promise<void> {
  await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
}
