import assert from "node:assert/strict";
import test from "node:test";
import { checkpointVersionForStep, isCheckpointVersionCompatible } from "./videoPipeline.js";

test("reuses legacy source checkpoints but invalidates legacy v1 video stages", () => {
  assert.equal(checkpointVersionForStep("source"), 1);
  assert.equal(checkpointVersionForStep("plan"), 2);
  assert.equal(isCheckpointVersionCompatible("source", undefined), true);
  assert.equal(isCheckpointVersionCompatible("plan", undefined), false);
  assert.equal(isCheckpointVersionCompatible("tts", 1), false);
  assert.equal(isCheckpointVersionCompatible("captions", 2), true);
  assert.equal(checkpointVersionForStep("storyboard"), 1);
  assert.equal(checkpointVersionForStep("render"), 3);
  assert.equal(isCheckpointVersionCompatible("render", 2), false);
  assert.equal(isCheckpointVersionCompatible("render", 3), true);
});
