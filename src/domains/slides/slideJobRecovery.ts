import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { getArtifactStatus, upsertSlideArtifact } from "../../shared/firebaseArticleStore.js";
import type { SlideJob } from "../../types/jobs.js";
import { readSlideJob, transitionSlideJob } from "./jobStore.js";

/** これより新しい処理中ジョブは、手動の jobs:process と重なっている可能性があるため触らない。 */
export const INTERRUPTED_JOB_MIN_AGE_MS = 30 * 60 * 1000;
const INTERRUPTED_MESSAGE = "再起動により中断されました。再生成してください";

export type SlideRecoveryDeps = {
  jobsRoot: string;
  now: () => number;
  readJob: (jobId: string) => Promise<{ job: SlideJob; dir: string }>;
  markFailed: (job: SlideJob, dir: string, error: string) => Promise<void>;
  removeDir: (dir: string) => Promise<void>;
  getSlidesStatus: (articleUrl: string) => Promise<string | undefined>;
  markActionRequired: (articleUrl: string) => Promise<void>;
  log: (message: string) => void;
};

function defaultDeps(): SlideRecoveryDeps {
  return {
    jobsRoot: "jobs",
    now: () => Date.now(),
    readJob: readSlideJob,
    markFailed: async (job, dir, error) => {
      await transitionSlideJob(job, dir, "failed", { error });
    },
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    getSlidesStatus: (articleUrl) => getArtifactStatus(articleUrl, "slides"),
    markActionRequired: async (articleUrl) => {
      await upsertSlideArtifact({
        originalUrl: articleUrl,
        slidesStatus: "action_required",
        stage: "slides_generation",
        statusMessage: INTERRUPTED_MESSAGE,
        slidesUrl: ""
      });
    },
    log: (message) => console.log(`[slide-recovery] ${message}`)
  };
}

export type SlideRecoveryResult = { total: number; failed: number; removedDuplicates: number; skippedRecent: number; errors: number };

/**
 * 常駐プロセスの起動時に、jobs/processing に残ったスライドジョブを片付ける。
 * 動画(markInterruptedVideoJobs)・依頼キュー(recoverOrphanedRequests)と同じ考え方で、自動では再実行しない。
 *
 * - すでに completed / failed に同じIDのフォルダがある場合は、移動に失敗して残った複製なので削除する。
 * - それ以外は failed に移す。Viewer 側は、現在「処理中」と表示されている記事だけを対応待ちに変える
 *   (すでに完了・手動登録済みの記事は触らない)。
 */
export async function markInterruptedSlideJobs(deps: SlideRecoveryDeps = defaultDeps()): Promise<SlideRecoveryResult> {
  const processingRoot = path.join(deps.jobsRoot, "processing");
  const result: SlideRecoveryResult = { total: 0, failed: 0, removedDuplicates: 0, skippedRecent: 0, errors: 0 };
  if (!existsSync(processingRoot)) return result;

  const entries = await readdir(processingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.total += 1;
    const jobId = entry.name;
    const processingDir = path.join(processingRoot, jobId);
    try {
      const alreadyMoved = ["completed", "failed"].some((status) => existsSync(path.join(deps.jobsRoot, status, jobId)));
      if (alreadyMoved) {
        await deps.removeDir(processingDir);
        result.removedDuplicates += 1;
        deps.log(`removed leftover copy: ${jobId}`);
        continue;
      }

      const { job, dir } = await deps.readJob(jobId);
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isFinite(updatedMs) && deps.now() - updatedMs < INTERRUPTED_JOB_MIN_AGE_MS) {
        result.skippedRecent += 1;
        continue;
      }

      await deps.markFailed(job, dir, INTERRUPTED_MESSAGE);
      result.failed += 1;
      deps.log(`marked interrupted: ${jobId}`);

      const articleUrl = job.urls?.[0] ?? job.url;
      if (articleUrl && (await deps.getSlidesStatus(articleUrl)) === "processing") {
        await deps.markActionRequired(articleUrl);
      }
    } catch (error) {
      result.errors += 1;
      deps.log(`failed to recover ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
