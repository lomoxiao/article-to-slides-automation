import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// config は import 時に process.env を parse するため、動的 import の前に設定する。
process.env.NOTEBOOKLM_NOTEBOOK_ID = "0b7d8a1c-1111-4222-8333-444455556666";

// NotebookLM ロック(jobs/manga/.nblm.lock)は cwd 相対のため、実データの jobs/ に
// 触れない(実行中ジョブのロックと衝突しない)よう一時ディレクトリへ chdir する。
// ロックの mkdir は非 recursive なので、親の jobs/manga/ を先に用意する。
process.chdir(await mkdtemp(path.join(tmpdir(), "nblm-pipeline-test-")));
await mkdir(path.join("jobs", "manga"), { recursive: true });

const { runNotebookLmSourceSync } = await import("./notebookLmPipeline.js");
type NotebookLmSession = import("./notebookLmDriver.js").NotebookLmSession;
type DriverFailure = import("./notebookLmDriver.js").DriverFailure;
type MangaJob = import("../types/manga.js").MangaJob;

const ARTIFACT_A = "aaaaaaaa-1111-4222-8333-444455556666";

async function makeJob(): Promise<MangaJob> {
  const jobDir = await mkdtemp(path.join(tmpdir(), "nblm-pipeline-test-"));
  return {
    id: "test-job",
    url: "https://example.com/article",
    pages: 5,
    artStyle: "F",
    treatment: "B",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobDir
  };
}

type FakeSessionPlan = {
  syncSources?: () => Promise<{ ok: true; value: undefined } | { ok: false; failure: DriverFailure }>;
  triggerStep3?: () => Promise<{ ok: true; value: undefined } | { ok: false; failure: DriverFailure }>;
};

function fakeSession(plan: FakeSessionPlan = {}): NotebookLmSession {
  const ok = async () => ({ ok: true as const, value: undefined });
  return {
    syncSources: plan.syncSources ?? ok,
    snapshotArtifacts: async () => ({
      ok: true as const,
      value: { studioFound: true, items: [{ id: ARTIFACT_A, text: "既存デック" }] }
    }),
    triggerStep3: plan.triggerStep3 ?? ok,
    reload: ok,
    close: async () => {}
  } as unknown as NotebookLmSession;
}

const failOpen = (kind: DriverFailure["kind"], detail: string) => async () => ({
  ok: false as const,
  failure: { kind, detail }
});

const noRecord = async () => {};
const noNotify = async () => {};

test("playwright success persists deck_wait phase and before-snapshot", async () => {
  const job = await makeJob();
  const outcome = await runNotebookLmSourceSync(
    { job },
    {
      openSession: async () => ({ ok: true, value: fakeSession() }),
      recordExpired: noRecord,
      notifyFallback: noNotify
    }
  );

  assert.equal(outcome.status, "executed");
  assert.equal(outcome.job.nblmPhase, "deck_wait");
  assert.equal(outcome.job.nblmEngine, "playwright");
  assert.deepEqual(outcome.job.nblmArtifactsBefore, [ARTIFACT_A]);
});

test("signed_out fails immediately without driver restarts and records expiry", async () => {
  const job = await makeJob();
  let opens = 0;
  let recorded = 0;
  const outcome = await runNotebookLmSourceSync(
    { job },
    {
      openSession: async () => {
        opens += 1;
        return { ok: false, failure: { kind: "signed_out", detail: "未ログイン" } };
      },
      recordExpired: async () => {
        recorded += 1;
      },
      notifyFallback: noNotify
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureKind, "signed_out");
  assert.equal(opens, 1);
  assert.equal(recorded, 1);
  assert.equal(outcome.job.nblmPhase, "failed");
});

test("ui_mismatch falls back to claude --chrome path with notification", async () => {
  const job = await makeJob();
  let notified = 0;
  const outcome = await runNotebookLmSourceSync(
    { job },
    {
      openSession: failOpen("ui_mismatch", "セレクタ不一致"),
      legacySync: async () => ({ status: "executed", detail: "NOTEBOOKLM_DONE" }),
      recordExpired: noRecord,
      notifyFallback: async () => {
        notified += 1;
      }
    }
  );

  assert.equal(outcome.status, "executed");
  assert.equal(outcome.job.nblmEngine, "claude-chrome");
  assert.equal(notified, 1);
});

test("unreachable retries driver restarts then succeeds", async () => {
  const job = await makeJob();
  let opens = 0;
  const outcome = await runNotebookLmSourceSync(
    { job },
    {
      openSession: async () => {
        opens += 1;
        if (opens < 3) {
          return { ok: false, failure: { kind: "unreachable", detail: "起動失敗" } };
        }
        return { ok: true, value: fakeSession() };
      },
      recordExpired: noRecord,
      notifyFallback: noNotify
    }
  );

  assert.equal(outcome.status, "executed");
  assert.equal(opens, 3);
  assert.equal(outcome.job.nblmAttempts, 3);
});

test("generation-level failures do not restart the driver", async () => {
  const job = await makeJob();
  let opens = 0;
  const outcome = await runNotebookLmSourceSync(
    { job },
    {
      openSession: async () => {
        opens += 1;
        return {
          ok: true,
          value: fakeSession({
            syncSources: async () => ({
              ok: false,
              failure: { kind: "generation_failed", detail: "生成失敗表示" }
            })
          })
        };
      },
      recordExpired: noRecord,
      notifyFallback: noNotify
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureKind, "generation_failed");
  assert.equal(opens, 1);
});
