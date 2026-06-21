import test from "node:test";
import assert from "node:assert/strict";
import { shouldPreserveManualArtifact } from "./firebaseArticleStore.js";

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
