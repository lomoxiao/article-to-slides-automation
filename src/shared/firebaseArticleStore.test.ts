import test from "node:test";
import assert from "node:assert/strict";
import { restoreDeletedPatch, shouldPreserveManualArtifact } from "./firebaseArticleStore.js";

test("preserves a completed manually locked artifact", () => {
  assert.equal(shouldPreserveManualArtifact({
    status: "completed",
    url: "https://example.com/manual",
    origin: "manual",
    locked: true
  }), true);
});

test("allows automation updates for unlocked or non-manual artifacts", () => {
  assert.equal(shouldPreserveManualArtifact({ status: "completed", origin: "manual", locked: false }), false);
  assert.equal(shouldPreserveManualArtifact({ status: "completed", origin: "automation", locked: true }), false);
  assert.equal(shouldPreserveManualArtifact({ status: "processing", origin: "manual", locked: true }), false);
  assert.equal(shouldPreserveManualArtifact(undefined), false);
});

test("削除済みの記事を登録し直すと、削除の印を外す更新になる", () => {
  assert.deepEqual(restoreDeletedPatch({ deletedAt: "2026-06-28T03:25:49.029Z" }), { deletedAt: null, deletedBy: null });
});

test("削除されていない記事・未登録の記事では何も変えない", () => {
  assert.deepEqual(restoreDeletedPatch({}), {});
  assert.deepEqual(restoreDeletedPatch({ deletedAt: "" }), {});
  assert.deepEqual(restoreDeletedPatch(undefined), {});
  assert.deepEqual(restoreDeletedPatch(null), {});
});
