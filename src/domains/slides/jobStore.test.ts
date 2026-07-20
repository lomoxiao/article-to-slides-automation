import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// jobsRoot は相対パス "jobs" のため、実データの jobs/ を汚さないよう
// テストプロセスの cwd を一時ディレクトリへ移してから実行する。
process.chdir(await mkdtemp(path.join(tmpdir(), "jobstore-test-")));

const { createPendingSlideJob, readSlideJob, transitionSlideJob, updateSlideJob } =
  await import("./jobStore.js");

test("createPendingSlideJob writes job.json under jobs/pending", async () => {
  const job = await createPendingSlideJob({ url: "https://example.com", requestedBy: "U123" });

  assert.match(job.id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.equal(job.status, "pending");
  assert.equal(job.pendingDir, path.join("jobs", "pending", job.id));
  assert.equal(job.completedDir, path.join("jobs", "completed", job.id));

  const raw = JSON.parse(await readFile(path.join(job.pendingDir, "job.json"), "utf8"));
  assert.equal(raw.url, "https://example.com");
  assert.equal(raw.requestedBy, "U123");
  assert.equal(raw.status, "pending");
});

test("readSlideJob finds a job by scanning status dirs", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/read" });
  const { job, dir } = await readSlideJob(created.id);

  assert.equal(job.id, created.id);
  assert.equal(dir, created.pendingDir);
});

test("readSlideJob throws for an unknown id", async () => {
  await assert.rejects(readSlideJob("no-such-job"), /Job not found: no-such-job/);
});

test("readSlideJob rejects path-traversal ids before touching the filesystem", async () => {
  for (const id of ["../evil", "..", "a/b", "a\\b", "with.dot", ""]) {
    await assert.rejects(readSlideJob(id), /Invalid job id/);
  }
});

test("readSlideJob throws an informative error for corrupt job.json", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/corrupt" });
  await writeFile(path.join(created.pendingDir, "job.json"), "{ not json", "utf8");
  await assert.rejects(readSlideJob(created.id), /Invalid job\.json at/);
});

test("readSlideJob preserves unknown extra fields (forward compatibility)", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/extra" });
  const jobPath = path.join(created.pendingDir, "job.json");
  const raw = JSON.parse(await readFile(jobPath, "utf8"));
  raw.futureField = "keep-me";
  await writeFile(jobPath, JSON.stringify(raw), "utf8");

  const { job } = await readSlideJob(created.id);
  assert.equal((job as Record<string, unknown>).futureField, "keep-me");
});

test("transitionSlideJob moves the job dir and updates status", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/move" });
  const { job, dir } = await transitionSlideJob(created, created.pendingDir, "processing");

  assert.equal(job.status, "processing");
  assert.equal(dir, path.join("jobs", "processing", created.id));
  assert.ok(existsSync(path.join(dir, "job.json")));
  assert.ok(!existsSync(created.pendingDir));
});

test("transitionSlideJob to completed sets completedAt", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/done" });
  const processing = await transitionSlideJob(created, created.pendingDir, "processing");
  const { job } = await transitionSlideJob(processing.job, processing.dir, "completed");

  assert.equal(job.status, "completed");
  assert.ok(job.completedAt);
});

test("updateSlideJob patches job.json in place", async () => {
  const created = await createPendingSlideJob({ url: "https://example.com/patch" });
  const updated = await updateSlideJob(created, created.pendingDir, { sourceTitle: "タイトル" });

  assert.equal(updated.sourceTitle, "タイトル");
  const raw = JSON.parse(await readFile(path.join(created.pendingDir, "job.json"), "utf8"));
  assert.equal(raw.sourceTitle, "タイトル");
  assert.equal(raw.status, "pending");
});
