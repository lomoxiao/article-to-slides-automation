import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ロックは cwd 相対 (jobs/manga/.nblm.lock) のため、一時ディレクトリへ chdir し
// 親ディレクトリを本番同様に用意してから実行する。
process.chdir(await mkdtemp(path.join(tmpdir(), "nblmlock-test-")));
await mkdir(path.join("jobs", "manga"), { recursive: true });

const { acquireNblmLock, releaseNblmLock } = await import("./nblmLock.js");
const LOCK_DIR = path.join("jobs", "manga", ".nblm.lock");

test("acquire succeeds, conflicts while held, and succeeds again after release", async () => {
  const first = await acquireNblmLock();
  assert.ok(first.ok);

  const second = await acquireNblmLock();
  assert.ok(!second.ok);
  assert.match(second.detail, /別の NotebookLM 操作が実行中/);

  await releaseNblmLock();
  const third = await acquireNblmLock();
  assert.ok(third.ok);
  await releaseNblmLock();
});

test("a stale lock (older than 1h) is reclaimed", async () => {
  const held = await acquireNblmLock();
  assert.ok(held.ok);

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(LOCK_DIR, old, old);

  const reclaimed = await acquireNblmLock();
  assert.ok(reclaimed.ok);
  await releaseNblmLock();
});

test("release is idempotent when no lock is held", async () => {
  await releaseNblmLock();
  await assert.doesNotReject(releaseNblmLock());
});
