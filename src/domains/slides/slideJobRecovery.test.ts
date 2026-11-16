import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SlideJob } from "../../types/jobs.js";
import { INTERRUPTED_JOB_MIN_AGE_MS, markInterruptedSlideJobs, type SlideRecoveryDeps } from "./slideJobRecovery.js";

const NOW = Date.parse("2026-11-16T00:00:00Z");

function job(id: string, updatedAt: string, url = `https://example.com/${id}`): SlideJob {
  return {
    id,
    url,
    status: "processing",
    createdAt: updatedAt,
    updatedAt,
    pendingDir: `jobs/pending/${id}`,
    completedDir: `jobs/completed/${id}`
  };
}

async function setup(jobs: SlideJob[], statuses: Record<string, string | undefined> = {}, alreadyMoved: string[] = []) {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "slide-recovery-"));
  for (const item of jobs) await mkdir(path.join(jobsRoot, "processing", item.id), { recursive: true });
  for (const id of alreadyMoved) await mkdir(path.join(jobsRoot, "failed", id), { recursive: true });
  const calls = { failed: [] as string[], removed: [] as string[], actionRequired: [] as string[] };
  const deps: SlideRecoveryDeps = {
    jobsRoot,
    now: () => NOW,
    readJob: async (jobId) => {
      const found = jobs.find((item) => item.id === jobId);
      if (!found) throw new Error("job.json missing");
      return { job: found, dir: path.join(jobsRoot, "processing", jobId) };
    },
    markFailed: async (item) => {
      calls.failed.push(item.id);
    },
    removeDir: async (dir) => {
      calls.removed.push(path.basename(dir));
    },
    getSlidesStatus: async (articleUrl) => statuses[articleUrl],
    markActionRequired: async (articleUrl) => {
      calls.actionRequired.push(articleUrl);
    },
    log: () => {}
  };
  return { deps, calls };
}

test("30分以上前の処理中ジョブを失敗扱いにし、Viewerが処理中の記事だけを対応待ちにする", async () => {
  const old = new Date(NOW - INTERRUPTED_JOB_MIN_AGE_MS - 1000).toISOString();
  const { deps, calls } = await setup(
    [job("a", old), job("b", old), job("c", old)],
    { "https://example.com/a": "processing", "https://example.com/b": "completed" }
  );
  const result = await markInterruptedSlideJobs(deps);

  assert.deepEqual(result, { total: 3, failed: 3, removedDuplicates: 0, skippedRecent: 0, errors: 0 });
  assert.deepEqual(calls.failed.sort(), ["a", "b", "c"]);
  // b は完了済み、c は記事側に状態が無いので触らない
  assert.deepEqual(calls.actionRequired, ["https://example.com/a"]);
});

test("30分以内に更新されたジョブは、実行中の可能性があるので触らない", async () => {
  const recent = new Date(NOW - INTERRUPTED_JOB_MIN_AGE_MS + 60_000).toISOString();
  const { deps, calls } = await setup([job("recent", recent)], { "https://example.com/recent": "processing" });
  const result = await markInterruptedSlideJobs(deps);

  assert.equal(result.skippedRecent, 1);
  assert.deepEqual(calls.failed, []);
  assert.deepEqual(calls.actionRequired, []);
});

test("すでに failed 側に同じIDがある場合は、残った複製を削除するだけで状態は変えない", async () => {
  const old = new Date(NOW - 86_400_000).toISOString();
  const { deps, calls } = await setup([job("dup", old)], { "https://example.com/dup": "processing" }, ["dup"]);
  const result = await markInterruptedSlideJobs(deps);

  assert.equal(result.removedDuplicates, 1);
  assert.deepEqual(calls.removed, ["dup"]);
  assert.deepEqual(calls.failed, []);
  assert.deepEqual(calls.actionRequired, []);
});

test("job.json が読めないフォルダがあっても、他のジョブの回収は続ける", async () => {
  const old = new Date(NOW - 86_400_000).toISOString();
  const { deps, calls } = await setup([job("ok", old)]);
  await mkdir(path.join(deps.jobsRoot, "processing", "broken"), { recursive: true });
  const result = await markInterruptedSlideJobs(deps);

  assert.equal(result.errors, 1);
  assert.deepEqual(calls.failed, ["ok"]);
});

test("processing フォルダが無ければ何もしない", async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "slide-recovery-empty-"));
  const { deps } = await setup([]);
  const result = await markInterruptedSlideJobs({ ...deps, jobsRoot: path.join(jobsRoot, "none") });
  assert.equal(result.total, 0);
});
