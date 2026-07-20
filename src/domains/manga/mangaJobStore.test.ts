import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// jobsRoot は相対パス "jobs/manga" のため、実データを汚さないよう一時ディレクトリで実行する。
process.chdir(await mkdtemp(path.join(tmpdir(), "mangajobstore-test-")));

const { createMangaJob, readMangaJob, updateMangaJob } = await import("./mangaJobStore.js");

const baseInput = {
  url: "https://example.com/article",
  pages: 5,
  artStyle: "F",
  treatment: "B" as const
};

test("createMangaJob then readMangaJob roundtrips", async () => {
  const created = await createMangaJob(baseInput);
  const read = await readMangaJob(created.id);

  assert.ok(read);
  assert.equal(read.id, created.id);
  assert.equal(read.url, baseInput.url);
  assert.equal(read.treatment, "B");
});

test("readMangaJob returns undefined for unknown or unsafe ids", async () => {
  assert.equal(await readMangaJob("no-such-job"), undefined);
  for (const id of ["../evil", "..", "a/b", "a\\b", "with.dot", ""]) {
    assert.equal(await readMangaJob(id), undefined);
  }
});

test("readMangaJob throws an informative error for corrupt job.json", async () => {
  const created = await createMangaJob(baseInput);
  await writeFile(path.join(created.jobDir, "job.json"), "{ not json", "utf8");
  await assert.rejects(readMangaJob(created.id), /Invalid job\.json at/);
});

test("readMangaJob preserves unknown extra fields (forward compatibility)", async () => {
  const created = await createMangaJob(baseInput);
  const jobPath = path.join(created.jobDir, "job.json");
  const raw = JSON.parse(await readFile(jobPath, "utf8"));
  raw.futureField = "keep-me";
  await writeFile(jobPath, JSON.stringify(raw), "utf8");

  const read = await readMangaJob(created.id);
  assert.ok(read);
  assert.equal((read as Record<string, unknown>).futureField, "keep-me");
});

test("updateMangaJob persists the patch", async () => {
  const created = await createMangaJob(baseInput);
  await updateMangaJob(created, { title: "タイトル" });
  const read = await readMangaJob(created.id);
  assert.equal(read?.title, "タイトル");
});
