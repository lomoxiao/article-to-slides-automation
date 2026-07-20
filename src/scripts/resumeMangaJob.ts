import { readMangaJob, updateMangaJob } from "../domains/manga/mangaJobStore.js";
import { runNotebookLmDeckRetrieval, runNotebookLmSourceSync } from "../domains/notebooklm/notebookLmPipeline.js";
import { fail, usage } from "./lib/cli.js";

// 失敗した漫画ジョブの NotebookLM フェーズ(Phase3/4)だけを再実行する。
// Usage: npm run manga:resume -- <jobId>
// - Step1/Step2 生成と Drive アップロードは再実行しない(driveStep1Url/driveStep2Url が前提)
// - nblmPhase=deck_wait まで進んでいたジョブはソース同期を飛ばしデック取得から再開する
// - daemon が NotebookLM 操作中の場合はロック(.nblm.lock)により実行を拒否する

const jobId = process.argv[2];
if (!jobId) {
  usage("Usage: npm run manga:resume -- <jobId>  (例: npm run manga:resume -- 20260719T095240Z-da39781f)");
}

let job = await readMangaJob(jobId);
if (!job) {
  fail(`ジョブが見つかりません: jobs/manga/${jobId}/job.json`);
}

if (job.mangaDeckStatus === "fetched" && job.mangaDeckUrl) {
  console.log(`このジョブは登録済みです (${job.mangaDeckUrl})。再実行は不要です。`);
  process.exit(0);
}

if (!job.driveStep1Url || !job.driveStep2Url) {
  fail(
    "Drive アップロードが完了していないため再開できません(step1/step2 の driveUrl がありません)。" +
      "最初から生成し直してください: npm run manga:outline"
  );
}

const log = (message: string) => console.log(`[manga-resume] ${message}`);
const skipSync = job.nblmPhase === "deck_wait" && job.notebookLmStatus === "executed";

if (skipSync) {
  log("Phase3(ソース同期+Step3)は完了済み。デックURL取得から再開します");
} else {
  log("Phase3(ソース同期+Step3)から再実行します");
  const sync = await runNotebookLmSourceSync({ job, logger: log });
  job = await updateMangaJob(sync.job, { notebookLmStatus: sync.status, notebookLmDetail: sync.detail });
  if (sync.status !== "executed") {
    fail(
      `Phase3 に失敗しました: ${sync.detail}` +
        (sync.failureKind === "signed_out"
          ? "\n→ npm run notebooklm:login でログインし直してから再度実行してください"
          : "")
    );
  }
  log("Phase3 完了。デック生成の完了待ちへ進みます");
}

await runNotebookLmDeckRetrieval({
  job,
  notebookLmStatus: "executed",
  requestedBy: job.requestedBy?.startsWith("viewer:") ? undefined : job.requestedBy,
  logger: log
});

const updated = await readMangaJob(jobId);
if (updated?.mangaDeckStatus === "fetched" && updated.mangaDeckUrl) {
  console.log(`\n完了: ${updated.mangaDeckUrl}`);
  process.exit(0);
}
fail(`\n未完了: mangaDeckStatus=${updated?.mangaDeckStatus ?? "不明"} (${updated?.mangaDeckDetail ?? ""})`);
