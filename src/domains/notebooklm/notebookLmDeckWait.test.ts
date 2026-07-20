import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// config は import 時に process.env を parse するため、動的 import の前に設定する。
// ポーリング間隔を 1ms にして waitForNewArtifact の打ち切りロジックを高速に検証する。
process.env.NOTEBOOKLM_NOTEBOOK_ID = "0b7d8a1c-1111-4222-8333-444455556666";
process.env.MANGA_DECK_POLL_INTERVAL_MS = "1";

const { NotebookLmSession, NEW_ARTIFACT_APPEAR_RETRIES, artifactUrl } =
  await import("./notebookLmDriver.js");

const NOTEBOOK_ID = "0b7d8a1c-1111-4222-8333-444455556666";
const ARTIFACT_NEW = "aaaaaaaa-1111-4222-8333-444455556666";

type Snapshot = { studioFound: boolean; items: { id: string | null; text: string }[] };

/**
 * ブラウザ無しで waitForNewArtifact を駆動するテスト用セッション。
 * snapshots を順に返し、最後の要素は以降も返し続ける。
 */
async function makeSession(snapshots: Snapshot[]) {
  const jobDir = await mkdtemp(path.join(tmpdir(), "nblm-deckwait-test-"));
  // page はスクリーンショット失敗(=保存スキップ)だけできれば十分。
  const fakePage = { screenshot: async () => { throw new Error("no browser in test"); } };
  const session = new NotebookLmSession(
    null as never,
    fakePage as never,
    NOTEBOOK_ID,
    jobDir,
    () => {}
  );

  const calls = { snapshot: 0, reload: 0 };
  session.snapshotArtifacts = async () => {
    const value = snapshots[Math.min(calls.snapshot, snapshots.length - 1)];
    calls.snapshot += 1;
    return { ok: true as const, value };
  };
  session.reload = async () => {
    calls.reload += 1;
    return { ok: true as const, value: undefined };
  };
  (session as unknown as { isUnavailableVisible: () => Promise<boolean> }).isUnavailableVisible =
    async () => false;

  return { session, calls };
}

const empty: Snapshot = { studioFound: true, items: [] };
const generating: Snapshot = { studioFound: true, items: [{ id: ARTIFACT_NEW, text: "生成中..." }] };
const ready: Snapshot = { studioFound: true, items: [{ id: ARTIFACT_NEW, text: "漫画デック 12スライド" }] };

test("waitForNewArtifact fails after initial check + 3 re-checks with no new deck", async () => {
  const { session, calls } = await makeSession([empty]);
  const result = await session.waitForNewArtifact([]);

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "generation_failed");
  assert.match(result.failure.detail, /新規デックが出現しません/);
  // 初回 + NEW_ARTIFACT_APPEAR_RETRIES 回の確認で打ち切る(それ以上ポーリングしない)。
  assert.equal(calls.snapshot, 1 + NEW_ARTIFACT_APPEAR_RETRIES);
  assert.equal(calls.reload, NEW_ARTIFACT_APPEAR_RETRIES);
});

test("waitForNewArtifact keeps waiting once a generating deck appears, then succeeds", async () => {
  const { session } = await makeSession([empty, empty, generating, generating, ready]);
  const result = await session.waitForNewArtifact([]);

  assert.ok(result.ok);
  assert.equal(result.value, artifactUrl(NOTEBOOK_ID, ARTIFACT_NEW));
});
