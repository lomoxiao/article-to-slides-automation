import { config } from "../../config.js";
import { updateMangaJob } from "../manga/mangaJobStore.js";
import { openNotebookLmSession, type DriverFailure, type NotebookLmFailureKind } from "./notebookLmDriver.js";
import { syncNotebookLm, type NotebookLmSyncStatus } from "./notebookLmSync.js";
import { recordSessionExpired } from "../../shared/sessionStatusStore.js";
import type { MangaJob } from "../../types/manga.js";
import {
  DRIVER_RESTART_RETRIES,
  NBLM_SESSION_DOMAIN,
  notifyUiFallback,
  triggerStep3WithRetries
} from "./nblmCommon.js";
import { acquireNblmLock, releaseNblmLock } from "./nblmLock.js";

// Phase3(ソース同期+Step3トリガ)のパイプライン。
// 主経路は notebookLmDriver(決定論 Playwright)。NOTEBOOKLM_NOTEBOOK_ID 未設定、または
// ui_mismatch 検出時は従来の claude --chrome 経路(notebookLmSync)へフォールバックする。
// Phase4(デックURL取得)は notebookLmDeckRetrieval.ts、ロックは nblmLock.ts。

// 既存呼び出し元(スクリプト・manga ドメイン)向けの facade re-export。
export { NBLM_SESSION_DOMAIN } from "./nblmCommon.js";
export { runNotebookLmDeckRetrieval } from "./notebookLmDeckRetrieval.js";

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
    if (!config.notebookLm.notebookId) {
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

    if (lastFailure?.kind === "ui_mismatch" && config.manga.nblmFallbackClaudeChrome) {
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
    notebookId: config.notebookLm.notebookId as string,
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
